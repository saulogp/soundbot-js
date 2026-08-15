const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  StreamType
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const ytdlp = require('./ytdlp');

let client = null;
const connections = new Map(); // guildId -> VoiceConnection
const players = new Map();     // guildId -> AudioPlayer
const ytProcesses = new Map(); // guildId -> ChildProcess
const queues = new Map();      // guildId -> { items:[{url,title}], index, loop, shuffle }

// Fisher-Yates shuffle (returns a new array)
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function init(token) {
  if (client) {
    await destroy();
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      console.log(`Discord bot conectado como ${client.user.tag}`);
      resolve();
    });
    client.once('error', reject);
    client.login(token).catch(reject);
  });
}

function getStatus() {
  if (!client || !client.isReady()) {
    return { online: false, username: null, guilds: [] };
  }

  const guilds = client.guilds.cache.map(guild => {
    const voiceChannels = guild.channels.cache
      .filter(ch => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
      .map(ch => ({ id: ch.id, name: ch.name }));

    const conn = connections.get(guild.id);
    const player = players.get(guild.id);
    const q = queues.get(guild.id);

    return {
      id: guild.id,
      name: guild.name,
      voiceChannels,
      connected: !!conn,
      channelId: conn ? conn.joinConfig.channelId : null,
      playing: player ? player.state.status === AudioPlayerStatus.Playing : false,
      playlist: q ? {
        active: true,
        index: q.index,
        total: q.items.length,
        title: q.items[q.index] ? q.items[q.index].title : null,
        loop: q.loop,
        shuffle: q.shuffle
      } : null
    };
  });

  return {
    online: true,
    username: client.user.tag,
    guilds
  };
}

function getUserVoiceChannel(guildId, userId) {
  if (!client || !client.isReady()) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const voiceState = guild.voiceStates.cache.get(userId);
  return voiceState?.channelId || null;
}

function getStatusForUser(userGuildIds, userId) {
  const status = getStatus();
  if (!status.online) return status;

  status.guilds = status.guilds
    .filter(g => userGuildIds.has(g.id))
    .map(g => {
      const userChannelId = getUserVoiceChannel(g.id, userId);
      return {
        ...g,
        voiceChannels: g.voiceChannels.map(ch => ({
          ...ch,
          userPresent: ch.id === userChannelId
        })),
        userChannelId
      };
    });

  return status;
}

function joinChannel(guildId, channelId) {
  if (!client || !client.isReady()) {
    throw new Error('Bot não está conectado');
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Servidor não encontrado');

  const channel = guild.channels.cache.get(channelId);
  if (!channel) throw new Error('Canal não encontrado');

  // Leave existing connection in this guild
  if (connections.has(guildId)) {
    connections.get(guildId).destroy();
    connections.delete(guildId);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false
  });

  // Handle disconnection
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      connection.destroy();
      connections.delete(guildId);
      players.delete(guildId);
    }
  });

  connections.set(guildId, connection);
  return { joined: true, channelName: channel.name };
}

function leaveChannel(guildId) {
  queues.delete(guildId);
  killYtProcess(guildId);
  const conn = connections.get(guildId);
  if (conn) {
    conn.destroy();
    connections.delete(guildId);
    players.delete(guildId);
  }
  return { left: true };
}

// Reuse (or lazily create) the guild's AudioPlayer. The idle listener drives
// the playlist queue: when a track ends naturally the player goes Idle and we
// advance to the next item. Single plays clear the queue first, so Idle is a
// no-op for them.
function getOrCreatePlayer(guildId, conn) {
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    player.on('error', err => {
      console.error(`Erro no AudioPlayer [${guildId}]:`, err.message);
      // In playlist mode the player goes Idle right after this, and the Idle
      // handler advances to the next track — a single advance path avoids the
      // double-skip that firing here would cause. Only clean up for single plays.
      if (!queues.has(guildId)) killYtProcess(guildId);
    });
    player.on(AudioPlayerStatus.Idle, () => {
      if (queues.has(guildId)) advanceQueue(guildId);
    });
    players.set(guildId, player);
    conn.subscribe(player);
  }
  return player;
}

function playAudio(guildId, filePath) {
  const conn = connections.get(guildId);
  if (!conn) throw new Error('Bot não está em um canal de voz neste servidor');

  // A single audio interrupts any running playlist/stream
  queues.delete(guildId);
  killYtProcess(guildId);

  const player = getOrCreatePlayer(guildId, conn);
  const resource = createAudioResource(filePath);
  player.play(resource);

  return { playing: true };
}

function playYouTube(guildId, url) {
  const conn = connections.get(guildId);
  if (!conn) throw new Error('Bot não está em um canal de voz neste servidor');

  // A single YouTube play interrupts any running playlist
  queues.delete(guildId);
  return playYouTubeUrl(guildId, url);
}

// Streams a single YouTube URL through the guild player. Does NOT touch the
// queue, so it is safe to call both for single plays and for each queue item.
function playYouTubeUrl(guildId, url) {
  const conn = connections.get(guildId);
  if (!conn) throw new Error('Bot não está em um canal de voz neste servidor');

  // Kill any existing yt-dlp process for this guild
  killYtProcess(guildId);

  const ytProc = spawn(ytdlp.getPath(), [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ytProcesses.set(guildId, ytProc);

  ytProc.on('error', (err) => {
    console.error(`Erro ao iniciar yt-dlp [${guildId}]:`, err.message);
    ytProcesses.delete(guildId);
  });

  ytProc.stderr.on('data', (data) => {
    console.error(`yt-dlp stderr [${guildId}]:`, data.toString());
  });

  ytProc.on('close', () => {
    ytProcesses.delete(guildId);
  });

  const player = getOrCreatePlayer(guildId, conn);
  const resource = createAudioResource(ytProc.stdout, {
    inputType: StreamType.Arbitrary
  });
  player.play(resource);

  return { playing: true };
}

// Starts a background YouTube playlist for the guild. `items` is a list of
// { url, title }. Plays them in order (or shuffled), auto-advancing on each
// track end. With loop the queue restarts after the last track.
function playPlaylist(guildId, items, { loop = false, shuffle = false } = {}) {
  const conn = connections.get(guildId);
  if (!conn) throw new Error('Bot não está em um canal de voz neste servidor');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Playlist vazia');

  const ordered = shuffle ? shuffleArray(items) : [...items];
  queues.set(guildId, { items: ordered, index: 0, loop: !!loop, shuffle: !!shuffle });

  playQueueCurrent(guildId);

  return {
    playing: true,
    total: ordered.length,
    title: ordered[0] ? ordered[0].title : null
  };
}

function playQueueCurrent(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  const item = q.items[q.index];
  if (!item) return;
  try {
    playYouTubeUrl(guildId, item.url);
  } catch (err) {
    console.error(`Erro ao tocar item da playlist [${guildId}]:`, err.message);
  }
}

function advanceQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  q.index += 1;
  if (q.index >= q.items.length) {
    if (q.loop) {
      q.index = 0;
    } else {
      queues.delete(guildId);
      killYtProcess(guildId);
      return;
    }
  }
  playQueueCurrent(guildId);
}

function queueStatus(guildId) {
  const q = queues.get(guildId);
  if (!q) return { skipped: true, ended: true };
  return {
    skipped: true,
    index: q.index,
    total: q.items.length,
    title: q.items[q.index] ? q.items[q.index].title : null
  };
}

// Manual skip to the next track (respects loop; stops at the end otherwise).
// Switching the resource on a playing player doesn't fire Idle, so calling
// advanceQueue here doesn't double-advance.
function nextTrack(guildId) {
  if (!queues.has(guildId)) return { skipped: false };
  advanceQueue(guildId);
  return queueStatus(guildId);
}

// Manual jump to the previous track (wraps with loop, otherwise clamps/replays).
function prevTrack(guildId) {
  const q = queues.get(guildId);
  if (!q) return { skipped: false };
  q.index -= 1;
  if (q.index < 0) q.index = q.loop ? q.items.length - 1 : 0;
  playQueueCurrent(guildId);
  return queueStatus(guildId);
}

function killYtProcess(guildId) {
  const proc = ytProcesses.get(guildId);
  if (proc && !proc.killed) {
    proc.kill();
    ytProcesses.delete(guildId);
  }
}

function stopAudio(guildId) {
  // Clear the queue first so the resulting Idle event doesn't advance it
  queues.delete(guildId);
  const player = players.get(guildId);
  if (player) {
    player.stop();
  }
  killYtProcess(guildId);
  return { stopped: true };
}

async function destroy() {
  queues.clear();
  for (const guildId of ytProcesses.keys()) {
    killYtProcess(guildId);
  }
  for (const [guildId, conn] of connections) {
    conn.destroy();
  }
  connections.clear();
  players.clear();

  if (client) {
    await client.destroy();
    client = null;
  }
}

function isReady() {
  return client && client.isReady();
}

module.exports = { init, getStatus, getStatusForUser, joinChannel, leaveChannel, playAudio, playYouTube, playPlaylist, nextTrack, prevTrack, stopAudio, destroy, isReady };
