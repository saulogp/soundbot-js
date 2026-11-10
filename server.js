const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const bot = require('./discord-bot');
const ytdlp = require('./ytdlp');

const app = express();
const PORT = 3000;
// Bind to loopback by default so other devices on the network can't reach the
// API. Set SOUNDBOT_HOST=0.0.0.0 to expose it on the LAN on purpose.
const HOST = process.env.SOUNDBOT_HOST || '127.0.0.1';

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
const YT_VIDEO_RE = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
const YT_DOMAIN_RE = /^(https?:\/\/)?(www\.|music\.)?youtube\.com\//;

// Config file to persist settings — when running inside Electron the main
// process sets SOUNDBOT_CONFIG_DIR to app.getPath('userData').
const CONFIG_DIR = process.env.SOUNDBOT_CONFIG_DIR || __dirname;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function defaultConfig() {
  return {
    audioDir: path.join(CONFIG_DIR, 'audios'),
    categories: ['Geral'],
    // Discord user IDs allowed to log in and manage the app. Empty = anyone.
    allowedUserIds: [],
    discord: {
      token: '',
      clientId: '',
      clientSecret: '',
      redirectUri: 'http://localhost:3000/auth/discord/callback',
      defaultGuildId: '',
      defaultChannelId: ''
    }
  };
}

// Write JSON via temp file + rename so a crash mid-write never leaves a
// truncated file behind.
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function loadConfig() {
  const defaults = defaultConfig();
  let saved = null;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      // Keep the unreadable file for manual recovery instead of silently
      // overwriting the user's token and settings with defaults.
      const backup = `${CONFIG_PATH}.corrupt-${Date.now()}`;
      console.error(`config.json inválido (${err.message}). Cópia salva em ${backup}`);
      try { fs.renameSync(CONFIG_PATH, backup); } catch {}
    }
  }

  const config = {
    ...defaults,
    ...(saved || {}),
    discord: { ...defaults.discord, ...((saved && saved.discord) || {}) }
  };
  if (!saved) writeJsonAtomic(CONFIG_PATH, config);

  // Environment variables override saved config (useful for pre-configured builds)
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    if (process.env[envName]) config.discord[key] = process.env[envName];
  }
  return config;
}

// discord.<key> → env var that overrides it at load time
const ENV_OVERRIDES = {
  clientId: 'SOUNDBOT_CLIENT_ID',
  clientSecret: 'SOUNDBOT_CLIENT_SECRET',
  token: 'SOUNDBOT_BOT_TOKEN'
};

// Env-provided values must never be persisted: for every overridden key keep
// whatever was already on disk instead of the value loadConfig() injected.
function saveConfig(config) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).discord || {}; } catch {}

  const discord = { ...config.discord };
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    if (process.env[envName]) discord[key] = onDisk[key] || '';
  }
  writeJsonAtomic(CONFIG_PATH, { ...config, discord });
}

// Multer setup — save to temp dir first, then move to category folder.
// When running inside Electron the asar is read-only, so use CONFIG_DIR
// (which Electron sets to app.getPath('userData')) for writable storage.
const TEMP_DIR = path.join(CONFIG_DIR, '.tmp-uploads');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Temp files get a random name so concurrent uploads never collide; the final
// name is derived from the original filename when the file is moved.
function makeUploader(allowedExts, maxBytes) {
  return multer({
    defParamCharset: 'utf8', // keep accents in filenames (multer defaults to latin1)
    limits: { fileSize: maxBytes },
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, TEMP_DIR),
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
    }),
    fileFilter: (_req, file, cb) => {
      cb(null, allowedExts.includes(path.extname(file.originalname).toLowerCase()));
    }
  });
}

const MB = 1024 * 1024;
const upload = makeUploader(AUDIO_EXTS, 50 * MB);
const thumbUpload = makeUploader(IMAGE_EXTS, 5 * MB);

// Keep letters (including accented ones), digits, spaces, _ and -.
function sanitizeBaseName(name, fallback) {
  const clean = String(name || '').normalize('NFC').replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim();
  return clean || fallback;
}

// Returns a filename in `dir` that does not exist yet: "base.ext", then "base (2).ext"...
function uniqueFilename(dir, base, ext) {
  let candidate = `${base}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

// fs.renameSync fails with EXDEV when source and destination are on different
// drives (e.g. app data on C: and audio folder on D:). Fall back to copy + delete.
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function removeQuietly(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}

// Remove temp files starting with `prefix` (all of them when prefix is empty)
function removeTempFiles(prefix = '') {
  let entries = [];
  try { entries = fs.readdirSync(TEMP_DIR); } catch {}
  for (const f of entries) {
    if (f.startsWith(prefix)) removeQuietly(path.join(TEMP_DIR, f));
  }
}

// Metadata helpers — stores thumbnail and display-name mappings per category
function getMetadataPath(audioDir, category) {
  return path.join(audioDir, category, '.metadata.json');
}

function loadMetadata(audioDir, category) {
  try {
    const raw = JSON.parse(fs.readFileSync(getMetadataPath(audioDir, category), 'utf-8'));
    // Normalize old format (string values) to new object format
    for (const key of Object.keys(raw)) {
      if (typeof raw[key] === 'string') {
        raw[key] = { thumbnail: raw[key] };
      }
    }
    return raw;
  } catch {
    return {};
  }
}

function saveMetadata(audioDir, category, meta) {
  writeJsonAtomic(getMetadataPath(audioDir, category), meta);
}

function fileUrl(category, file) {
  return `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(file)}`;
}

// Data access for one category folder: local audio files + YouTube link entries
// stored in .metadata.json. Every listing route goes through here so the entry
// shape stays the same everywhere.
function listCategoryAudios(audioDir, category) {
  const dir = safePath(audioDir, category);
  if (!dir || !fs.existsSync(dir)) return [];

  const meta = loadMetadata(audioDir, category);
  const files = fs.readdirSync(dir)
    .filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
    .map(f => {
      const m = meta[f] || {};
      return {
        name: path.basename(f, path.extname(f)),
        display: m.display || null,
        filename: f,
        category,
        url: fileUrl(category, f),
        thumbnail: m.thumbnail ? fileUrl(category, m.thumbnail) : null
      };
    });

  const links = Object.entries(meta)
    .filter(([, v]) => v.type === 'youtube')
    .map(([key, v]) => ({
      name: v.display || 'YouTube',
      display: v.display || null,
      filename: key,
      category,
      url: null,
      youtubeUrl: v.youtubeUrl,
      type: 'youtube',
      thumbnail: v.thumbnail ? fileUrl(category, v.thumbnail) : null
    }));

  return [...files, ...links];
}

function listCategoryNames(audioDir) {
  if (!fs.existsSync(audioDir)) return [];
  return fs.readdirSync(audioDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();
}

function listAllAudios(audioDir) {
  return listCategoryNames(audioDir).flatMap(cat => listCategoryAudios(audioDir, cat));
}

// Parse a timecode string (SS, MM:SS or HH:MM:SS) into seconds. Returns null if invalid.
function parseTimecode(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!/^\d{1,2}(:\d{2}){0,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(':').map(Number);
  // Minutes/seconds after the first field must be < 60 ("1:75" is invalid)
  if (parts.slice(1).some(n => n >= 60)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Resolve the directory containing the ffmpeg binary provided by ffmpeg-static.
// In a packaged Electron app the path points inside app.asar, but the binary is
// unpacked (asarUnpack in package.json) so we redirect to app.asar.unpacked.
function ffmpegDir() {
  if (!ffmpegStatic) return null;
  const binPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  return path.dirname(binPath);
}

// Validate that a resolved path stays inside the base directory (prevents path traversal)
function safePath(base, ...segments) {
  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base) + path.sep;
  if (resolved !== path.resolve(base) && !resolved.startsWith(normalizedBase)) {
    return null;
  }
  return resolved;
}

app.use(express.json());
// Express 5 leaves req.body undefined when no parser matched (e.g. a request
// without a JSON Content-Type); default it so destructuring answers 400, not 500.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ===== Discord OAuth2 Auth =====

// Error carrying an HTTP status; the central error handler turns it into
// { error } JSON. `expose` marks the message as safe to show the client.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function isAllowedUser(config, userId) {
  const allowed = Array.isArray(config.allowedUserIds) ? config.allowedUserIds : [];
  return allowed.length === 0 || allowed.includes(userId);
}

// Checked on every request (not only at login) so removing someone from
// allowedUserIds takes effect without waiting for their session to expire.
function requireAuth(req, _res, next) {
  if (!req.session?.user) throw new ApiError(401, 'Autenticação necessária');
  if (!isAllowedUser(loadConfig(), req.session.user.id)) throw new ApiError(403, 'Usuário sem permissão');
  next();
}

// A category is one folder directly under audioDir: no separators, not hidden,
// not "." / "..". Returns its absolute path or throws 400.
function resolveCategoryDir(audioDir, category) {
  if (typeof category !== 'string' || !category.trim() || category.startsWith('.') || /[\\/]/.test(category)) {
    throw new ApiError(400, 'Categoria inválida');
  }
  const dir = safePath(audioDir, category);
  if (!dir || path.dirname(dir) !== path.resolve(audioDir)) throw new ApiError(400, 'Categoria inválida');
  return dir;
}

// "Geral" is the virtual all-audios tab. A real folder with that name is hidden
// from the tabs and the selects, so nothing may be created/moved into it.
// Case-insensitive: on Windows "geral" is the same folder. Existing entries in
// a legacy "Geral" folder still resolve normally (so they can be moved out).
const VIRTUAL_CATEGORY = 'Geral';

function resolveTargetCategoryDir(audioDir, category) {
  if (typeof category === 'string' && category.trim().toLowerCase() === VIRTUAL_CATEGORY.toLowerCase()) {
    throw new ApiError(400, `"${VIRTUAL_CATEGORY}" é reservada (mostra todos os áudios). Escolha outra categoria.`);
  }
  if (!category) throw new ApiError(400, 'Escolha uma categoria');
  return resolveCategoryDir(audioDir, category);
}

// An entry name is a plain file name inside its category folder (no
// separators, not hidden). Throws 400 otherwise.
function assertEntryName(filename) {
  if (typeof filename !== 'string' || !filename || filename.startsWith('.') || /[\\/]/.test(filename)) {
    throw new ApiError(400, 'Nome de arquivo inválido');
  }
  return filename;
}

// Local audio file (by extension). YouTube links are identified by their
// metadata type instead — an uploaded "yt_x.mp3" is still a real file.
function isAudioFilename(filename) {
  return AUDIO_EXTS.includes(path.extname(filename).toLowerCase());
}

function isYoutubeEntry(entry) {
  return entry?.type === 'youtube';
}

async function requireYtDlp() {
  try {
    return await ytdlp.ensure();
  } catch (err) {
    console.error('Erro ao preparar yt-dlp:', err.message);
    throw new ApiError(500, 'yt-dlp indisponível (falha ao baixar)');
  }
}

function userGuildIds(req) {
  return new Set((req.session.guilds || []).map(g => g.id));
}

// Resolve the target guild (body value or the saved default) and make sure
// the logged-in user is a member of it.
function resolveGuildId(req) {
  const config = loadConfig();
  const guildId = req.body?.guildId || config.discord?.defaultGuildId;
  if (!guildId) throw new ApiError(400, 'Nenhum servidor selecionado. Entre em um canal de voz primeiro.');
  if (!userGuildIds(req).has(guildId)) throw new ApiError(403, 'Você não pertence a este servidor');
  return guildId;
}

app.get('/auth/discord', (req, res) => {
  const config = loadConfig();
  const { clientId, redirectUri } = config.discord || {};
  if (!clientId) throw new ApiError(500, 'clientId não configurado');

  // The session cookie is bound to the host the callback lands on. If the app
  // was opened on another host (127.0.0.1, LAN IP...), restart the flow on the
  // callback's host — otherwise login "succeeds" but the app never sees it.
  try {
    const callback = new URL(redirectUri || 'http://localhost:3000/auth/discord/callback');
    if (req.headers.host !== callback.host) {
      return res.redirect(`${callback.origin}/auth/discord`);
    }
  } catch {
    throw new ApiError(500, 'redirectUri inválida na configuração');
  }

  // `state` ties the callback to this browser session (prevents login CSRF)
  req.session.oauthState = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri || 'http://localhost:3000/auth/discord/callback',
    response_type: 'code',
    scope: 'identify guilds',
    state: req.session.oauthState
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// GET /users/@me/guilds, retrying when Discord rate-limits (429) as long as
// the requested wait is short enough for a login redirect.
const GUILDS_MAX_ATTEMPTS = 3;
const GUILDS_MAX_WAIT_S = 5;

async function fetchUserGuilds(accessToken) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data)) return data;

    const retryAfter = Number(data?.retry_after ?? res.headers.get('retry-after'));
    const canRetry = res.status === 429 && attempt < GUILDS_MAX_ATTEMPTS &&
      Number.isFinite(retryAfter) && retryAfter <= GUILDS_MAX_WAIT_S;
    if (!canRetry) {
      throw new Error(`/users/@me/guilds respondeu HTTP ${res.status}${res.status === 429 ? ' (limite de requisições do Discord, tente de novo em instantes)' : ''}`);
    }
    await new Promise(r => setTimeout(r, Math.max(retryAfter, 0.1) * 1000));
  }
}

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  // Every failure is logged and sent back as ?erro=login-falhou so the user
  // sees why login didn't stick instead of silently landing on "/" logged out.
  const fail = (reason) => {
    console.error(`Login Discord falhou: ${reason}`);
    res.redirect('/?erro=login-falhou');
  };

  if (req.query.error) return fail(`Discord retornou "${req.query.error}"`);
  if (!code) return fail('callback sem code');
  if (!expectedState || req.query.state !== expectedState) {
    return fail('state ausente/diferente — o cookie de sessão não voltou (host diferente da redirectUri?)');
  }

  const config = loadConfig();
  const { clientId, clientSecret, redirectUri } = config.discord || {};

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri || 'http://localhost:3000/auth/discord/callback'
      })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) {
      return fail(`troca do code falhou (HTTP ${tokenRes.status}: ${tokenData.error_description || tokenData.error || 'sem detalhes'}) — confira clientSecret e redirectUri`);
    }

    const accessToken = tokenData.access_token;

    // Fetch user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!userRes.ok) return fail(`/users/@me respondeu HTTP ${userRes.status}`);
    const user = await userRes.json();
    if (!isAllowedUser(config, user.id)) {
      console.warn(`Login negado para ${user.username} (${user.id}) — fora de allowedUserIds`);
      return res.redirect('/?erro=sem-permissao');
    }

    // Fetch user guilds. Failing here instead of saving an empty list: with no
    // guilds every Discord action would answer 403 with no hint why.
    let guilds;
    try {
      guilds = await fetchUserGuilds(accessToken);
    } catch (err) {
      return fail(err.message);
    }

    // New session id on login (prevents session fixation)
    req.session.regenerate(err => {
      if (err) return fail(`regenerate da sessão: ${err.message}`);
      req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
      req.session.guilds = guilds.map(g => ({ id: g.id, name: g.name }));
      res.redirect('/');
    });
  } catch (err) {
    fail(err.message);
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user) throw new ApiError(401, 'Não autenticado');
  res.json({ user: req.session.user, guilds: req.session.guilds || [] });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve audio files from the configured directory. User-uploaded SVG
// thumbnails could carry scripts, so these responses are sandboxed.
let audioStatic = { dir: null, handler: null };
app.use('/audio-files', (req, res, next) => {
  const { audioDir } = loadConfig();
  if (audioStatic.dir !== audioDir) {
    audioStatic = { dir: audioDir, handler: express.static(audioDir, { dotfiles: 'deny' }) };
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  audioStatic.handler(req, res, next);
});

// GET /api/config — never expose secrets to the frontend
app.get('/api/config', (_req, res) => {
  const config = loadConfig();
  const { token, clientSecret, ...safeDiscord } = config.discord || {};
  res.json({ ...config, discord: safeDiscord });
});

// PUT /api/config/directory
app.put('/api/config/directory', requireAuth, (req, res) => {
  const { directory } = req.body;
  if (!directory || typeof directory !== 'string') throw new ApiError(400, 'Diretório não informado');

  // Only allow absolute paths — reject relative traversal
  if (!path.isAbsolute(directory)) throw new ApiError(400, 'Informe um caminho absoluto');
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true });

  const config = loadConfig();
  config.audioDir = resolved;
  saveConfig(config);
  res.json({ audioDir: resolved });
});

// GET /api/fs/directories?path= — folder browser for the "Pasta de áudios" modal
// in browser mode (a web page can't get a folder's absolute path from the OS
// picker). Lists only subfolder names, never files. Intentionally not confined
// to audioDir: picking any folder is the point, and PUT /api/config/directory
// already accepts any absolute path from the same authenticated users.
app.get('/api/fs/directories', requireAuth, (req, res) => {
  const requested = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  let dir;
  if (requested) {
    if (!path.isAbsolute(requested)) throw new ApiError(400, 'Informe um caminho absoluto');
    dir = path.resolve(requested);
  } else {
    // Start where the library is, or at home when it doesn't exist yet
    const { audioDir } = loadConfig();
    dir = audioDir && fs.existsSync(audioDir) ? path.resolve(audioDir) : os.homedir();
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new ApiError(404, 'Pasta não encontrada');
    if (err.code === 'ENOTDIR') throw new ApiError(400, 'O caminho não é uma pasta');
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new ApiError(403, 'Sem permissão para abrir esta pasta');
    throw err;
  }

  const directories = entries
    .filter(e => !e.name.startsWith('.'))
    .filter(e => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    })
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true }))
    .map(name => ({ name, path: path.join(dir, name) }));

  const parent = path.dirname(dir);
  res.json({
    path: dir,
    parent: parent !== dir ? parent : null,
    home: os.homedir(),
    // Windows has one root per drive; elsewhere there is only "/"
    roots: process.platform === 'win32'
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`).filter(r => fs.existsSync(r))
      : ['/'],
    directories
  });
});

// GET /api/categories — "Geral" is a virtual tab that shows all audios, always first
app.get('/api/categories', (_req, res) => {
  const { audioDir } = loadConfig();
  const categories = listCategoryNames(audioDir).filter(c => c !== 'Geral');
  res.json(['Geral', ...categories]);
});

// POST /api/categories
app.post('/api/categories', requireAuth, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) throw new ApiError(400, 'Nome da categoria é obrigatório');

  const config = loadConfig();
  fs.mkdirSync(resolveTargetCategoryDir(config.audioDir, name), { recursive: true });
  res.json({ created: name });
});

// GET /api/audios?category=X  ("Geral" returns all audios from all categories)
app.get('/api/audios', (req, res) => {
  const { audioDir } = loadConfig();
  const category = req.query.category || 'Geral';

  if (category === 'Geral') return res.json(listAllAudios(audioDir));
  resolveCategoryDir(audioDir, category);
  res.json(listCategoryAudios(audioDir, category));
});

// GET /api/audios/search?q=term — every word must appear in the name or display name
app.get('/api/audios/search', (req, res) => {
  const words = String(req.query.q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return res.json([]);

  const { audioDir } = loadConfig();
  const results = listAllAudios(audioDir).filter(a => {
    const target = (a.type === 'youtube' ? a.name : `${a.name} ${a.display || ''}`).toLowerCase();
    return words.every(w => target.includes(w));
  });
  res.json(results);
});

// POST /api/audios — upload, then move from temp to the category folder
app.post('/api/audios', requireAuth, upload.single('audio'), (req, res) => {
  if (!req.file) throw new ApiError(400, 'Arquivo de áudio inválido. Use MP3, WAV, OGG, M4A, WEBM ou FLAC.');

  const config = loadConfig();
  const category = req.body.category;
  let destDir;
  try {
    destDir = resolveTargetCategoryDir(config.audioDir, category);
  } catch (err) {
    removeQuietly(req.file.path);
    throw err;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const base = sanitizeBaseName(path.basename(req.file.originalname, path.extname(req.file.originalname)), 'audio');
  const filename = uniqueFilename(destDir, base, ext);
  moveFile(req.file.path, path.join(destDir, filename));

  res.json({
    name: path.basename(filename, ext),
    filename,
    category,
    url: fileUrl(category, filename)
  });
});

// Validate the optional section (start/end) of a YouTube download. Both or
// neither. Returns the yt-dlp --download-sections value, or null.
function parseSection(start, end) {
  const hasStart = start != null && String(start).trim() !== '';
  const hasEnd = end != null && String(end).trim() !== '';
  if (!hasStart && !hasEnd) return null;
  if (!hasStart || !hasEnd) throw new ApiError(400, 'Informe início e fim do trecho');
  const s = parseTimecode(start);
  const e = parseTimecode(end);
  if (s == null || e == null) throw new ApiError(400, 'Trecho inválido (use mm:ss)');
  if (e <= s) throw new ApiError(400, 'O fim do trecho deve ser maior que o início');
  return `*${String(start).trim()}-${String(end).trim()}`;
}

const YT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Run yt-dlp to completion. Killed when `res` closes before we answered
// (client gave up) or after the timeout, so it never outlives the request.
function runYtDlp(bin, args, res) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let abortReason = null;

    const abort = reason => {
      if (abortReason || proc.exitCode !== null) return;
      abortReason = reason;
      proc.kill();
    };
    const timer = setTimeout(() => abort('timeout'), YT_DOWNLOAD_TIMEOUT_MS);
    const onClose = () => { if (!res.writableFinished) abort('cancelled'); };
    res.on('close', onClose);

    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); res.off('close', onClose); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      res.off('close', onClose);
      if (abortReason) return reject(Object.assign(new Error(`yt-dlp interrompido (${abortReason})`), { abortReason }));
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
    });
  });
}

// POST /api/audios/youtube — download the audio (optionally trimmed to a section)
// as a real mp3 file in the category folder, so it behaves like any local audio.
app.post('/api/audios/youtube', requireAuth, async (req, res) => {
  const { category, url, name, start, end } = req.body;
  if (!category || !url) throw new ApiError(400, 'category e url são obrigatórios');
  if (typeof url !== 'string' || !YT_VIDEO_RE.test(url)) throw new ApiError(400, 'URL do YouTube inválida');

  const config = loadConfig();
  const destDir = resolveTargetCategoryDir(config.audioDir, category);
  const display = (typeof name === 'string' && name.trim()) || null;

  // Download é opcional. Quando desligado, salvamos apenas o link (metadata-only,
  // chave yt_) e o áudio é transmitido sob demanda no play. Padrão: baixar.
  if (req.body.download === false) {
    fs.mkdirSync(destDir, { recursive: true });
    const meta = loadMetadata(config.audioDir, category);
    const key = `yt_${crypto.randomUUID()}`;
    meta[key] = { type: 'youtube', youtubeUrl: url, display };
    saveMetadata(config.audioDir, category, meta);

    return res.json({
      name: display || 'YouTube',
      display,
      filename: key,
      category,
      url: null,
      youtubeUrl: url,
      type: 'youtube'
    });
  }

  const section = parseSection(start, end);
  fs.mkdirSync(destDir, { recursive: true });
  const ytDlpBin = await requireYtDlp();

  const ffDir = ffmpegDir();
  const base = sanitizeBaseName(display, `youtube_${Date.now()}`);
  const tmpId = crypto.randomUUID();
  const tmpFile = path.join(TEMP_DIR, `${tmpId}.mp3`);

  const args = [
    '-x', '--audio-format', 'mp3',
    '--no-playlist', '--no-warnings',
    '-o', path.join(TEMP_DIR, `${tmpId}.%(ext)s`)
  ];
  if (ffDir) args.push('--ffmpeg-location', ffDir);
  if (section) args.push('--download-sections', section, '--force-keyframes-at-cuts');
  args.push('--', url);

  try {
    await runYtDlp(ytDlpBin, args, res);
  } catch (err) {
    // yt-dlp may leave .webm/.part leftovers besides the .mp3 — drop them all
    removeTempFiles(tmpId);
    if (err.abortReason === 'cancelled') return; // client is gone, nobody to answer
    console.error('Erro no download do YouTube:', err.message);
    if (err.abortReason === 'timeout') throw new ApiError(504, 'O download do YouTube demorou demais');
    throw new ApiError(500, 'Falha ao baixar o áudio do YouTube');
  }

  if (!fs.existsSync(tmpFile)) {
    removeTempFiles(tmpId);
    throw new ApiError(500, 'Falha ao baixar o áudio do YouTube');
  }

  // Move to category folder with a unique filename
  const filename = uniqueFilename(destDir, base, '.mp3');
  moveFile(tmpFile, path.join(destDir, filename));

  if (display) {
    const meta = loadMetadata(config.audioDir, category);
    meta[filename] = { ...(meta[filename] || {}), display };
    saveMetadata(config.audioDir, category, meta);
  }

  res.json({
    name: path.basename(filename, '.mp3'),
    filename,
    category,
    url: fileUrl(category, filename)
  });
});

// Resolve and validate an existing library entry (local file or YouTube link)
// from { category, filename }. Throws 400/404.
function resolveEntry(audioDir, category, filename) {
  if (!category || !filename) throw new ApiError(400, 'Categoria e arquivo são obrigatórios');
  const dir = resolveCategoryDir(audioDir, category);
  assertEntryName(filename);

  const meta = loadMetadata(audioDir, category);
  const entry = meta[filename];
  if (isYoutubeEntry(entry)) return { dir, meta, entry, isLink: true, filePath: null };

  if (!isAudioFilename(filename)) throw new ApiError(400, 'Nome de arquivo inválido');
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) throw new ApiError(404, 'Arquivo não encontrado');
  return { dir, meta, entry, isLink: false, filePath };
}

// PUT /api/audios/thumbnail — upload thumbnail for an audio
app.put('/api/audios/thumbnail', requireAuth, thumbUpload.single('thumbnail'), (req, res) => {
  if (!req.file) throw new ApiError(400, 'Imagem inválida');

  const config = loadConfig();
  const { category, filename } = req.body;
  let target;
  try {
    target = resolveEntry(config.audioDir, category, filename);
  } catch (err) {
    removeQuietly(req.file.path);
    throw err;
  }
  const { dir, meta } = target;
  const entry = target.entry || {};

  // Remove old thumbnail if exists
  if (entry.thumbnail) removeQuietly(safePath(dir, entry.thumbnail));

  // Random name: deriving it from the audio's base name made "song.mp3" and
  // "song.wav" share (and overwrite/delete) the same thumbnail file.
  const thumbName = `_thumb_${crypto.randomUUID()}${path.extname(req.file.filename)}`;
  moveFile(req.file.path, path.join(dir, thumbName));

  meta[filename] = { ...entry, thumbnail: thumbName };
  saveMetadata(config.audioDir, category, meta);

  res.json({ thumbnail: fileUrl(category, thumbName) });
});

// PUT /api/audios/display — update display name for an audio
app.put('/api/audios/display', requireAuth, (req, res) => {
  const { category, filename, display } = req.body;
  const config = loadConfig();
  const { meta } = resolveEntry(config.audioDir, category, filename);
  const entry = meta[filename] || {};

  if (typeof display === 'string' && display.trim()) {
    entry.display = display.trim();
  } else {
    delete entry.display;
  }

  meta[filename] = entry;
  saveMetadata(config.audioDir, category, meta);

  res.json({ display: entry.display || null });
});

// PUT /api/audios/move — move audio from one category to another
app.put('/api/audios/move', requireAuth, (req, res) => {
  const { category, filename, targetCategory } = req.body;
  if (!targetCategory) throw new ApiError(400, 'Dados insuficientes');

  const config = loadConfig();
  const src = resolveEntry(config.audioDir, category, filename);
  const destDir = resolveTargetCategoryDir(config.audioDir, targetCategory);
  if (category === targetCategory) return res.json({ moved: false });
  fs.mkdirSync(destDir, { recursive: true });

  const destMeta = loadMetadata(config.audioDir, targetCategory);
  if (src.isLink) {
    if (destMeta[filename]) throw new ApiError(409, `Já existe esta entrada em ${targetCategory}`);
  } else {
    const destFile = path.join(destDir, filename);
    if (fs.existsSync(destFile)) throw new ApiError(409, `Já existe um áudio com este nome em ${targetCategory}`);
    moveFile(src.filePath, destFile);
  }

  // Carry the metadata (thumbnail, display, link data) along
  const entry = src.entry || {};
  if (entry.thumbnail) {
    const srcThumb = safePath(src.dir, entry.thumbnail);
    const destThumb = safePath(destDir, entry.thumbnail);
    if (srcThumb && destThumb && fs.existsSync(srcThumb)) {
      try { moveFile(srcThumb, destThumb); } catch (err) { console.error('Falha ao mover thumbnail:', err.message); }
    }
  }

  delete src.meta[filename];
  saveMetadata(config.audioDir, category, src.meta);
  if (Object.keys(entry).length > 0) {
    destMeta[filename] = entry;
    saveMetadata(config.audioDir, targetCategory, destMeta);
  }

  res.json({ moved: true, category: targetCategory });
});

// DELETE /api/audios — removes the file (or YouTube link), its thumbnail and metadata
app.delete('/api/audios', requireAuth, (req, res) => {
  const { category, filename } = req.body;
  const config = loadConfig();
  const { dir, meta, entry, filePath } = resolveEntry(config.audioDir, category, filename);

  if (filePath) fs.unlinkSync(filePath);
  if (entry) {
    if (entry.thumbnail) removeQuietly(safePath(dir, entry.thumbnail));
    delete meta[filename];
    saveMetadata(config.audioDir, category, meta);
  }
  res.json({ deleted: true });
});

// ===== Discord Bot API =====
// Bot errors carry status/expose, so routes just let them reach the central
// error handler (Express 5 forwards sync throws and rejected promises).

// GET /api/discord/status
app.get('/api/discord/status', requireAuth, (req, res) => {
  res.json(bot.getStatusForUser(userGuildIds(req), req.session.user.id));
});

// PUT /api/discord/token
app.put('/api/discord/token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') throw new ApiError(400, 'Token não informado');

  // Validate by logging in first — only persist a token that actually works
  try {
    await bot.init(token);
  } catch (err) {
    throw new ApiError(400, `Falha ao conectar: ${err.message}`);
  }

  const config = loadConfig();
  config.discord = config.discord || {};
  config.discord.token = token;
  saveConfig(config);
  res.json({ success: true, status: bot.getStatus() });
});

// POST /api/discord/join
app.post('/api/discord/join', requireAuth, (req, res) => {
  const { guildId, channelId } = req.body;
  if (!guildId || !channelId) throw new ApiError(400, 'guildId e channelId são obrigatórios');
  if (!userGuildIds(req).has(guildId)) throw new ApiError(403, 'Você não pertence a este servidor');

  const result = bot.joinChannel(guildId, channelId);
  // Save as defaults
  const config = loadConfig();
  config.discord = config.discord || {};
  config.discord.defaultGuildId = guildId;
  config.discord.defaultChannelId = channelId;
  saveConfig(config);
  res.json(result);
});

// POST /api/discord/leave
app.post('/api/discord/leave', requireAuth, (req, res) => {
  res.json(bot.leaveChannel(resolveGuildId(req)));
});

// POST /api/discord/play
app.post('/api/discord/play', requireAuth, (req, res) => {
  const { category, filename } = req.body;
  const guildId = resolveGuildId(req);
  const { filePath } = resolveEntry(loadConfig().audioDir, category, filename);
  if (!filePath) throw new ApiError(400, 'Use play-youtube para links do YouTube');
  res.json(bot.playAudio(guildId, filePath));
});

// POST /api/discord/play-youtube
app.post('/api/discord/play-youtube', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) throw new ApiError(400, 'URL é obrigatória');
  if (typeof url !== 'string' || !YT_VIDEO_RE.test(url)) throw new ApiError(400, 'URL do YouTube inválida');

  const guildId = resolveGuildId(req);
  await requireYtDlp();
  res.json(bot.playYouTube(guildId, url));
});

// Expand a YouTube playlist into a flat list of { url, title } using yt-dlp.
// Uses --flat-playlist so it only reads metadata (fast, no per-video probe).
function expandPlaylist(ytDlpBin, url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, ['--flat-playlist', '-J', '--no-warnings', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
      try {
        const data = JSON.parse(stdout);
        const entries = Array.isArray(data.entries) ? data.entries : [data];
        const items = entries
          .filter(e => e && e.id)
          .map(e => ({ url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || 'YouTube' }));
        resolve(items);
      } catch {
        reject(new Error('Falha ao interpretar a playlist'));
      }
    });
  });
}

// POST /api/discord/play-playlist — plays a YouTube song OR playlist as
// background music. A single-video URL becomes a one-item queue (loop repeats).
app.post('/api/discord/play-playlist', requireAuth, async (req, res) => {
  const { url } = req.body;
  const loop = req.body.loop === true;
  const shuffle = req.body.shuffle === true;
  if (!url || typeof url !== 'string') throw new ApiError(400, 'URL é obrigatória');

  const isPlaylist = YT_DOMAIN_RE.test(url) && /[?&]list=[A-Za-z0-9_-]+/.test(url);
  if (!YT_VIDEO_RE.test(url) && !isPlaylist) throw new ApiError(400, 'URL do YouTube inválida');

  const guildId = resolveGuildId(req);
  const ytDlpBin = await requireYtDlp();

  let items;
  try {
    items = await expandPlaylist(ytDlpBin, url);
  } catch (err) {
    console.error('Erro ao expandir link do YouTube:', err.message);
    throw new ApiError(500, 'Falha ao carregar o link do YouTube');
  }

  if (!items.length) throw new ApiError(400, 'Nenhum vídeo encontrado no link');
  if (items.length > 500) items = items.slice(0, 500);

  res.json(bot.playPlaylist(guildId, items, { loop, shuffle }));
});

// POST /api/discord/playlist/next | prev — skip within the background playlist
app.post('/api/discord/playlist/next', requireAuth, (req, res) => res.json(bot.nextTrack(resolveGuildId(req))));
app.post('/api/discord/playlist/prev', requireAuth, (req, res) => res.json(bot.prevTrack(resolveGuildId(req))));

// GET /api/youtube/stream?url=...
app.get('/api/youtube/stream', requireAuth, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') throw new ApiError(400, 'URL é obrigatória');
  if (!YT_VIDEO_RE.test(url)) throw new ApiError(400, 'URL do YouTube inválida');

  const ytDlpBin = await requireYtDlp();

  const ytProc = spawn(ytDlpBin, [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Only commit to a 200 once yt-dlp produced audio. Piping right away
  // answered 200 with an empty body when the video failed, so the browser
  // player just stayed silent.
  ytProc.stdout.once('data', (first) => {
    if (res.headersSent || res.destroyed) return;
    res.setHeader('Content-Type', 'audio/webm');
    res.write(first);
    ytProc.stdout.pipe(res);
  });

  ytProc.on('error', (err) => {
    console.error('yt-dlp stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao iniciar yt-dlp' });
  });

  ytProc.on('close', (code) => {
    if (!res.headersSent && !res.destroyed) {
      res.status(502).json({ error: `Não foi possível obter o áudio do YouTube (yt-dlp saiu com código ${code})` });
    }
  });

  ytProc.stderr.on('data', (data) => {
    console.error('yt-dlp stderr:', data.toString());
  });

  res.on('close', () => {
    if (!ytProc.killed) ytProc.kill();
  });
});

// POST /api/discord/stop
app.post('/api/discord/stop', requireAuth, (req, res) => {
  res.json(bot.stopAudio(resolveGuildId(req)));
});

// Unknown API routes answer JSON instead of the default HTML page
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Central error handler: Express 5 forwards sync throws and rejected promises
// here. Always answer { error } JSON, never an HTML stack trace.
app.use((err, req, res, next) => {
  // Mid-stream failure: let Express close the connection
  if (res.headersSent) {
    console.error(`Erro em ${req.method} ${req.originalUrl}:`, err);
    return next(err);
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo muito grande' });
    return res.status(400).json({ error: `Falha no upload: ${err.message}` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  // ApiError and discord-bot errors: status + a message meant for the user
  if (err.expose && Number.isInteger(err.status)) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`Erro em ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

let httpServer = null;

async function startServer() {
  // Leftovers from aborted uploads/downloads of a previous run
  removeTempFiles();

  return new Promise((resolve, reject) => {
    httpServer = app.listen(PORT, HOST, async () => {
      console.log(`🎵 SoundBot rodando em http://localhost:${PORT} (escutando em ${HOST})`);

      // Pre-fetch yt-dlp in the background so the first YouTube action is fast.
      // Errors are non-fatal — routes retry the download on demand.
      ytdlp.ensure().catch(err => console.error('yt-dlp não pôde ser preparado:', err.message));

      // Auto-init Discord bot if token exists
      const config = loadConfig();
      if (config.discord?.token) {
        try {
          await bot.init(config.discord.token);
        } catch (err) {
          console.error('Erro ao conectar bot Discord:', err.message);
        }
      }

      resolve(httpServer);
    });

    // Port conflict (and other listen errors) — reject so the Electron main
    // process can surface a clear message instead of a blank window.
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        err.message = `A porta ${PORT} já está em uso. Feche o programa que a está ocupando e abra o SoundBot novamente.`;
      }
      reject(err);
    });
  });
}

async function stopServer() {
  await bot.destroy();
  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve));
    httpServer = null;
  }
}

// Se executado diretamente (node server.js), inicia o servidor.
// Se importado pelo Electron, apenas exporta a função.
if (require.main === module) {
  startServer();
}

module.exports = { startServer, stopServer, PORT };
