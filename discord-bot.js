const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState
} = require('@discordjs/voice');

let client = null;
const connections = new Map(); // guildId -> VoiceConnection
const players = new Map();     // guildId -> AudioPlayer

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

    return {
      id: guild.id,
      name: guild.name,
      voiceChannels,
      connected: !!conn,
      channelId: conn ? conn.joinConfig.channelId : null,
      playing: player ? player.state.status === AudioPlayerStatus.Playing : false
    };
  });

  return {
    online: true,
    username: client.user.tag,
    guilds
  };
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
  const conn = connections.get(guildId);
  if (conn) {
    conn.destroy();
    connections.delete(guildId);
    players.delete(guildId);
  }
  return { left: true };
}

function playAudio(guildId, filePath) {
  const conn = connections.get(guildId);
  if (!conn) throw new Error('Bot não está em um canal de voz neste servidor');

  // Reuse or create player
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    player.on('error', err => {
      console.error(`Erro no AudioPlayer [${guildId}]:`, err.message);
    });
    players.set(guildId, player);
    conn.subscribe(player);
  }

  const resource = createAudioResource(filePath);
  player.play(resource);

  return { playing: true };
}

function stopAudio(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.stop();
  }
  return { stopped: true };
}

async function destroy() {
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

module.exports = { init, getStatus, joinChannel, leaveChannel, playAudio, stopAudio, destroy, isReady };
