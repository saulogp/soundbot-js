const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const bot = require('./discord-bot');
const ytdlp = require('./ytdlp');

const app = express();
const PORT = 3000;

// Config file to persist settings — when running inside Electron the main
// process sets SOUNDBOT_CONFIG_DIR to app.getPath('userData').
const CONFIG_DIR = process.env.SOUNDBOT_CONFIG_DIR || __dirname;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // Environment variables override saved config (useful for pre-configured builds)
    if (process.env.SOUNDBOT_CLIENT_ID) config.discord.clientId = process.env.SOUNDBOT_CLIENT_ID;
    if (process.env.SOUNDBOT_CLIENT_SECRET) config.discord.clientSecret = process.env.SOUNDBOT_CLIENT_SECRET;
    if (process.env.SOUNDBOT_BOT_TOKEN) config.discord.token = process.env.SOUNDBOT_BOT_TOKEN;
    return config;
  } catch {
    const defaults = {
      audioDir: path.join(CONFIG_DIR, 'audios'),
      categories: ['Geral'],
      discord: {
        token: process.env.SOUNDBOT_BOT_TOKEN || '',
        clientId: process.env.SOUNDBOT_CLIENT_ID || '',
        clientSecret: process.env.SOUNDBOT_CLIENT_SECRET || '',
        redirectUri: 'http://localhost:3000/auth/discord/callback',
        defaultGuildId: '',
        defaultChannelId: ''
      }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Multer setup — save to temp dir first, then move to category folder.
// When running inside Electron the asar is read-only, so use CONFIG_DIR
// (which Electron sets to app.getPath('userData')) for writable storage.
const TEMP_DIR = path.join(CONFIG_DIR, '.tmp-uploads');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TEMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
      const safeName = base.replace(/[^a-zA-Z0-9_\-\s]/g, '') || 'audio';
      cb(null, `${safeName}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// Multer for thumbnail uploads (images)
const thumbUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TEMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, path.extname(file.originalname));
      const safeName = base.replace(/[^a-zA-Z0-9_\-\s]/g, '') || 'thumb';
      cb(null, `${safeName}_${Date.now()}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

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
  fs.writeFileSync(getMetadataPath(audioDir, category), JSON.stringify(meta, null, 2));
}

// Parse a timecode string (SS, MM:SS or HH:MM:SS) into seconds. Returns null if invalid.
function parseTimecode(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!/^\d{1,2}(:\d{2}){0,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(':').map(Number);
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
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ===== Discord OAuth2 Auth =====

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Autenticação necessária' });
  next();
}

app.get('/auth/discord', (_req, res) => {
  const config = loadConfig();
  const { clientId, redirectUri } = config.discord || {};
  if (!clientId) return res.status(500).json({ error: 'clientId não configurado' });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri || 'http://localhost:3000/auth/discord/callback',
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/');

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
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/');

    const accessToken = tokenData.access_token;

    // Fetch user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const user = await userRes.json();

    // Fetch user guilds
    const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const guilds = await guildsRes.json();

    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.guilds = Array.isArray(guilds) ? guilds.map(g => ({ id: g.id, name: g.name })) : [];

    res.redirect('/');
  } catch (err) {
    console.error('Erro no OAuth2 callback:', err.message);
    res.redirect('/');
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: req.session.user, guilds: req.session.guilds || [] });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve audio files from the configured directory
app.use('/audio-files', (req, res, next) => {
  const config = loadConfig();
  express.static(config.audioDir)(req, res, next);
});

// GET /api/config — never expose secrets to the frontend
app.get('/api/config', (_req, res) => {
  const config = loadConfig();
  const { token, clientSecret, ...safeDiscord } = config.discord || {};
  res.json({ ...config, discord: safeDiscord });
});

// PUT /api/config/directory
app.put('/api/config/directory', (req, res) => {
  const { directory } = req.body;
  if (!directory) return res.status(400).json({ error: 'Diretório não informado' });

  // Only allow absolute paths — reject relative traversal
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory)) return res.status(400).json({ error: 'Informe um caminho absoluto' });
  fs.mkdirSync(resolved, { recursive: true });

  const config = loadConfig();
  config.audioDir = resolved;
  saveConfig(config);
  res.json({ audioDir: resolved });
});

// GET /api/categories
app.get('/api/categories', (_req, res) => {
  const config = loadConfig();
  const audioDir = config.audioDir;

  try {
    fs.mkdirSync(audioDir, { recursive: true });
    const entries = fs.readdirSync(audioDir, { withFileTypes: true });
    const categories = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();

    // "Geral" is a virtual tab that shows all audios — always first
    res.json(['Geral', ...categories.filter(c => c !== 'Geral')]);
  } catch {
    res.json(['Geral']);
  }
});

// POST /api/categories
app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome da categoria é obrigatório' });

  const config = loadConfig();
  const dir = safePath(config.audioDir, name.trim());
  if (!dir) return res.status(400).json({ error: 'Nome de categoria inválido' });
  fs.mkdirSync(dir, { recursive: true });
  res.json({ created: name.trim() });
});

// GET /api/audios?category=X  ("Geral" returns all audios from all categories)
app.get('/api/audios', (req, res) => {
  const config = loadConfig();
  const category = req.query.category || 'Geral';
  const audioDir = config.audioDir;
  const allowedExt = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];

  try {
    fs.mkdirSync(audioDir, { recursive: true });

    // Helper to extract YouTube entries from metadata
    function getYouTubeEntries(meta, catName) {
      return Object.entries(meta)
        .filter(([, v]) => v.type === 'youtube')
        .map(([key, v]) => ({
          name: v.display || 'YouTube',
          display: v.display || null,
          filename: key,
          category: catName,
          url: null,
          youtubeUrl: v.youtubeUrl,
          type: 'youtube',
          thumbnail: v.thumbnail ? `/audio-files/${encodeURIComponent(catName)}/${encodeURIComponent(v.thumbnail)}` : null
        }));
    }

    if (category === 'Geral') {
      const entries = fs.readdirSync(audioDir, { withFileTypes: true });
      const allFiles = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = loadMetadata(audioDir, entry.name);
        const catDir = path.join(audioDir, entry.name);
        const files = fs.readdirSync(catDir)
          .filter(f => allowedExt.includes(path.extname(f).toLowerCase()))
          .map(f => {
            const m = meta[f] || {};
            return {
              name: path.basename(f, path.extname(f)),
              display: m.display || null,
              filename: f,
              category: entry.name,
              url: `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(f)}`,
              thumbnail: m.thumbnail ? `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(m.thumbnail)}` : null
            };
          });
        allFiles.push(...files, ...getYouTubeEntries(meta, entry.name));
      }
      res.json(allFiles);
    } else {
      const dir = path.join(audioDir, category);
      fs.mkdirSync(dir, { recursive: true });
      const meta = loadMetadata(audioDir, category);
      const files = fs.readdirSync(dir)
        .filter(f => allowedExt.includes(path.extname(f).toLowerCase()))
        .map(f => {
          const m = meta[f] || {};
          return {
            name: path.basename(f, path.extname(f)),
            display: m.display || null,
            filename: f,
            category,
            url: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(f)}`,
            thumbnail: m.thumbnail ? `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(m.thumbnail)}` : null
          };
        });
      res.json([...files, ...getYouTubeEntries(meta, category)]);
    }
  } catch {
    res.json([]);
  }
});

// GET /api/audios/search?q=term — fuzzy search across all categories
app.get('/api/audios/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query) return res.json([]);

  const config = loadConfig();
  const audioDir = config.audioDir;
  const allowedExt = ['.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'];

  try {
    fs.mkdirSync(audioDir, { recursive: true });
    const entries = fs.readdirSync(audioDir, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = loadMetadata(audioDir, entry.name);
      const catDir = path.join(audioDir, entry.name);
      const files = fs.readdirSync(catDir)
        .filter(f => allowedExt.includes(path.extname(f).toLowerCase()));

      for (const f of files) {
        const m = meta[f] || {};
        const name = path.basename(f, path.extname(f));
        const display = m.display || '';
        const searchTarget = `${name} ${display}`.toLowerCase();

        const words = query.split(/\s+/);
        if (words.every(w => searchTarget.includes(w))) {
          results.push({
            name,
            display: m.display || null,
            filename: f,
            category: entry.name,
            url: `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(f)}`,
            thumbnail: m.thumbnail ? `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(m.thumbnail)}` : null
          });
        }
      }

      // Search YouTube entries in metadata
      for (const [key, v] of Object.entries(meta)) {
        if (v.type !== 'youtube') continue;
        const display = v.display || 'YouTube';
        const searchTarget = display.toLowerCase();
        const words = query.split(/\s+/);
        if (words.every(w => searchTarget.includes(w))) {
          results.push({
            name: display,
            display: v.display || null,
            filename: key,
            category: entry.name,
            url: null,
            youtubeUrl: v.youtubeUrl,
            type: 'youtube',
            thumbnail: v.thumbnail ? `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(v.thumbnail)}` : null
          });
        }
      }
    }

    res.json(results);
  } catch {
    res.json([]);
  }
});

// POST /api/audios — upload, then move from temp to correct category folder
app.post('/api/audios', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo de áudio inválido' });

  const config = loadConfig();
  const category = req.body.category || 'Geral';
  const destDir = safePath(config.audioDir, category);
  if (!destDir) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Categoria inválida' }); }
  fs.mkdirSync(destDir, { recursive: true });

  const srcPath = req.file.path;
  const destPath = safePath(destDir, req.file.filename);
  if (!destPath) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Nome de arquivo inválido' }); }
  fs.renameSync(srcPath, destPath);

  res.json({
    name: path.basename(req.file.filename, path.extname(req.file.filename)),
    filename: req.file.filename,
    category,
    url: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(req.file.filename)}`
  });
});

// POST /api/audios/youtube — download the audio (optionally trimmed to a section)
// as a real mp3 file in the category folder, so it behaves like any local audio.
app.post('/api/audios/youtube', async (req, res) => {
  const { category, url, name, start, end } = req.body;
  if (!category || !url) return res.status(400).json({ error: 'category e url são obrigatórios' });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
  if (!ytRegex.test(url)) return res.status(400).json({ error: 'URL do YouTube inválida' });

  // Download é opcional. Quando desligado, salvamos apenas o link (metadata-only,
  // chave yt_) e o áudio é transmitido sob demanda no play. Padrão: baixar.
  const download = req.body.download !== false;

  if (!download) {
    const config = loadConfig();
    const catDir = safePath(config.audioDir, category);
    if (!catDir) return res.status(400).json({ error: 'Categoria inválida' });
    fs.mkdirSync(catDir, { recursive: true });

    const meta = loadMetadata(config.audioDir, category);
    const key = `yt_${Date.now()}`;
    const display = (name && name.trim()) || null;
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

  // Validate the optional section (start/end). Both or neither.
  let section = null;
  const hasStart = start != null && String(start).trim() !== '';
  const hasEnd = end != null && String(end).trim() !== '';
  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) return res.status(400).json({ error: 'Informe início e fim do trecho' });
    const s = parseTimecode(start);
    const e = parseTimecode(end);
    if (s == null || e == null) return res.status(400).json({ error: 'Trecho inválido (use mm:ss)' });
    if (e <= s) return res.status(400).json({ error: 'O fim do trecho deve ser maior que o início' });
    section = `*${String(start).trim()}-${String(end).trim()}`;
  }

  const config = loadConfig();
  const destDir = safePath(config.audioDir, category);
  if (!destDir) return res.status(400).json({ error: 'Categoria inválida' });
  fs.mkdirSync(destDir, { recursive: true });

  let ytDlpBin;
  try {
    ytDlpBin = await ytdlp.ensure();
  } catch (err) {
    console.error('Erro ao preparar yt-dlp:', err.message);
    return res.status(500).json({ error: 'yt-dlp indisponível (falha ao baixar)' });
  }

  const ffDir = ffmpegDir();
  const base = (name && name.trim().replace(/[^a-zA-Z0-9_\-\s]/g, '').trim()) || `youtube_${Date.now()}`;
  const tmpOut = path.join(TEMP_DIR, `${base}.%(ext)s`);
  const tmpFile = path.join(TEMP_DIR, `${base}.mp3`);

  const args = [
    '-x', '--audio-format', 'mp3',
    '--no-playlist', '--no-warnings',
    '-o', tmpOut
  ];
  if (ffDir) args.push('--ffmpeg-location', ffDir);
  if (section) args.push('--download-sections', section, '--force-keyframes-at-cuts');
  args.push(url);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ytDlpBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
      });
    });
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    console.error('Erro no download do YouTube:', err.message);
    return res.status(500).json({ error: 'Falha ao baixar o áudio do YouTube' });
  }

  if (!fs.existsSync(tmpFile)) {
    return res.status(500).json({ error: 'Falha ao baixar o áudio do YouTube' });
  }

  // Move to category folder with a unique filename
  let filename = `${base}.mp3`;
  let destPath = safePath(destDir, filename);
  if (!destPath) { try { fs.unlinkSync(tmpFile); } catch {} return res.status(400).json({ error: 'Nome de arquivo inválido' }); }
  if (fs.existsSync(destPath)) {
    filename = `${base}_${Date.now()}.mp3`;
    destPath = path.join(destDir, filename);
  }
  fs.renameSync(tmpFile, destPath);

  // Persist display name if provided
  if (name && name.trim()) {
    const meta = loadMetadata(config.audioDir, category);
    meta[filename] = { ...(meta[filename] || {}), display: name.trim() };
    saveMetadata(config.audioDir, category, meta);
  }

  res.json({
    name: path.basename(filename, '.mp3'),
    filename,
    category,
    url: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`
  });
});

// PUT /api/audios/thumbnail — upload thumbnail for an audio
app.put('/api/audios/thumbnail', thumbUpload.single('thumbnail'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem inválida' });

  const config = loadConfig();
  const category = req.body.category;
  const filename = req.body.filename;
  if (!category || !filename) return res.status(400).json({ error: 'Categoria e arquivo são obrigatórios' });

  const destDir = safePath(config.audioDir, category);
  if (!destDir) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Categoria inválida' }); }
  if (!safePath(destDir, filename)) { try { fs.unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: 'Nome de arquivo inválido' }); }
  fs.mkdirSync(destDir, { recursive: true });

  // Remove old thumbnail if exists
  const meta = loadMetadata(config.audioDir, category);
  const entry = meta[filename] || {};
  if (entry.thumbnail) {
    const oldPath = path.join(destDir, entry.thumbnail);
    try { fs.unlinkSync(oldPath); } catch {}
  }

  // Move new thumbnail to category folder
  const thumbName = `_thumb_${path.basename(filename, path.extname(filename))}${path.extname(req.file.filename)}`;
  const destPath = path.join(destDir, thumbName);
  fs.renameSync(req.file.path, destPath);

  // Save metadata
  meta[filename] = { ...entry, thumbnail: thumbName };
  saveMetadata(config.audioDir, category, meta);

  res.json({
    thumbnail: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(thumbName)}`
  });
});

// PUT /api/audios/display — update display name for an audio
app.put('/api/audios/display', (req, res) => {
  const { category, filename, display } = req.body;
  if (!category || !filename) return res.status(400).json({ error: 'Categoria e arquivo são obrigatórios' });

  const config = loadConfig();
  if (!safePath(config.audioDir, category)) return res.status(400).json({ error: 'Categoria inválida' });
  if (!safePath(config.audioDir, category, filename)) return res.status(400).json({ error: 'Nome de arquivo inválido' });
  const meta = loadMetadata(config.audioDir, category);
  const entry = meta[filename] || {};

  if (display && display.trim()) {
    entry.display = display.trim();
  } else {
    delete entry.display;
  }

  meta[filename] = entry;
  saveMetadata(config.audioDir, category, meta);

  res.json({ display: entry.display || null });
});

// PUT /api/audios/move — move audio from one category to another
app.put('/api/audios/move', (req, res) => {
  const { category, filename, targetCategory } = req.body;
  if (!category || !filename || !targetCategory) return res.status(400).json({ error: 'Dados insuficientes' });
  if (category === targetCategory) return res.json({ moved: false });

  const config = loadConfig();
  const srcDir = safePath(config.audioDir, category);
  const destDir = safePath(config.audioDir, targetCategory);
  if (!srcDir || !destDir) return res.status(400).json({ error: 'Categoria inválida' });
  fs.mkdirSync(destDir, { recursive: true });

  // YouTube entries are metadata-only
  if (filename.startsWith('yt_')) {
    const srcMeta = loadMetadata(config.audioDir, category);
    const entry = srcMeta[filename];
    if (!entry) return res.status(404).json({ error: 'Entrada não encontrada' });

    // Move thumbnail file if exists
    if (entry.thumbnail) {
      const srcThumb = safePath(srcDir, entry.thumbnail);
      const destThumb = safePath(destDir, entry.thumbnail);
      if (srcThumb && destThumb && fs.existsSync(srcThumb)) {
        fs.renameSync(srcThumb, destThumb);
      }
    }

    delete srcMeta[filename];
    saveMetadata(config.audioDir, category, srcMeta);

    const destMeta = loadMetadata(config.audioDir, targetCategory);
    destMeta[filename] = entry;
    saveMetadata(config.audioDir, targetCategory, destMeta);

    return res.json({ moved: true, category: targetCategory });
  }

  const srcFile = safePath(srcDir, filename);
  const destFile = safePath(destDir, filename);
  if (!srcFile || !destFile) return res.status(400).json({ error: 'Nome de arquivo inválido' });
  if (!fs.existsSync(srcFile)) return res.status(404).json({ error: 'Arquivo não encontrado' });

  // Move audio file
  fs.renameSync(srcFile, destFile);

  // Move metadata (thumbnail + display)
  const srcMeta = loadMetadata(config.audioDir, category);
  const entry = srcMeta[filename] || {};

  // Move thumbnail file if exists
  if (entry.thumbnail) {
    const srcThumb = path.join(srcDir, entry.thumbnail);
    const destThumb = path.join(destDir, entry.thumbnail);
    try { fs.renameSync(srcThumb, destThumb); } catch {}
  }

  // Update metadata in both categories
  delete srcMeta[filename];
  saveMetadata(config.audioDir, category, srcMeta);

  if (Object.keys(entry).length > 0) {
    const destMeta = loadMetadata(config.audioDir, targetCategory);
    destMeta[filename] = entry;
    saveMetadata(config.audioDir, targetCategory, destMeta);
  }

  res.json({ moved: true, category: targetCategory });
});

// DELETE /api/audios
app.delete('/api/audios', (req, res) => {
  const { category, filename } = req.body;
  if (!category || !filename) return res.status(400).json({ error: 'Dados insuficientes' });

  const config = loadConfig();

  // YouTube entries are metadata-only (key starts with yt_)
  if (filename.startsWith('yt_')) {
    const meta = loadMetadata(config.audioDir, category);
    const entry = meta[filename];
    if (!entry) return res.status(404).json({ error: 'Entrada não encontrada' });
    // Remove thumbnail file if exists
    if (entry.thumbnail) {
      const thumbPath = safePath(config.audioDir, category, entry.thumbnail);
      if (thumbPath) try { fs.unlinkSync(thumbPath); } catch {}
    }
    delete meta[filename];
    saveMetadata(config.audioDir, category, meta);
    return res.json({ deleted: true });
  }

  const filePath = safePath(config.audioDir, category, filename);
  if (!filePath) return res.status(400).json({ error: 'Caminho inválido' });

  try {
    fs.unlinkSync(filePath);
    res.json({ deleted: true });
  } catch {
    res.status(404).json({ error: 'Arquivo não encontrado' });
  }
});

// ===== Discord Bot API =====

// GET /api/discord/status
app.get('/api/discord/status', requireAuth, (req, res) => {
  const userGuildIds = new Set((req.session.guilds || []).map(g => g.id));
  res.json(bot.getStatusForUser(userGuildIds, req.session.user.id));
});

// PUT /api/discord/token
app.put('/api/discord/token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token não informado' });

  const config = loadConfig();
  config.discord = config.discord || {};
  config.discord.token = token;
  saveConfig(config);

  try {
    await bot.init(token);
    res.json({ success: true, status: bot.getStatus() });
  } catch (err) {
    res.status(500).json({ error: `Falha ao conectar: ${err.message}` });
  }
});

// POST /api/discord/join
app.post('/api/discord/join', requireAuth, (req, res) => {
  const { guildId, channelId } = req.body;
  if (!guildId || !channelId) return res.status(400).json({ error: 'guildId e channelId são obrigatórios' });

  const userGuildIds = new Set((req.session.guilds || []).map(g => g.id));
  if (!userGuildIds.has(guildId)) return res.status(403).json({ error: 'Você não pertence a este servidor' });

  try {
    const result = bot.joinChannel(guildId, channelId);
    // Save as defaults
    const config = loadConfig();
    config.discord = config.discord || {};
    config.discord.defaultGuildId = guildId;
    config.discord.defaultChannelId = channelId;
    saveConfig(config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/leave
app.post('/api/discord/leave', requireAuth, (req, res) => {
  const { guildId } = req.body;
  if (!guildId) return res.status(400).json({ error: 'guildId é obrigatório' });

  try {
    res.json(bot.leaveChannel(guildId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/play
app.post('/api/discord/play', requireAuth, (req, res) => {
  const { category, filename } = req.body;
  if (!category || !filename) return res.status(400).json({ error: 'category e filename são obrigatórios' });

  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado e sem padrão configurado' });

  const filePath = safePath(config.audioDir, category, filename);
  if (!filePath) return res.status(400).json({ error: 'Caminho inválido' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });

  try {
    res.json(bot.playAudio(guildId, filePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/play-youtube
app.post('/api/discord/play-youtube', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
  if (!ytRegex.test(url)) return res.status(400).json({ error: 'URL do YouTube inválida' });

  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado e sem padrão configurado' });

  try {
    await ytdlp.ensure();
    res.json(bot.playYouTube(guildId, url));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Expand a YouTube playlist into a flat list of { url, title } using yt-dlp.
// Uses --flat-playlist so it only reads metadata (fast, no per-video probe).
function expandPlaylist(ytDlpBin, url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, ['--flat-playlist', '-J', '--no-warnings', url], {
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
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  const ytSingleRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
  const ytDomainRegex = /^(https?:\/\/)?(www\.|music\.)?youtube\.com\//;
  const isPlaylist = ytDomainRegex.test(url) && /[?&]list=[A-Za-z0-9_-]+/.test(url);
  if (!ytSingleRegex.test(url) && !isPlaylist) {
    return res.status(400).json({ error: 'URL do YouTube inválida' });
  }

  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado e sem padrão configurado' });

  let ytDlpBin;
  try {
    ytDlpBin = await ytdlp.ensure();
  } catch (err) {
    console.error('Erro ao preparar yt-dlp:', err.message);
    return res.status(500).json({ error: 'yt-dlp indisponível (falha ao baixar)' });
  }

  let items;
  try {
    items = await expandPlaylist(ytDlpBin, url);
  } catch (err) {
    console.error('Erro ao expandir link do YouTube:', err.message);
    return res.status(500).json({ error: 'Falha ao carregar o link do YouTube' });
  }

  if (!items.length) return res.status(400).json({ error: 'Nenhum vídeo encontrado no link' });
  if (items.length > 500) items = items.slice(0, 500);

  try {
    res.json(bot.playPlaylist(guildId, items, { loop, shuffle }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/playlist/next | prev — skip within the background playlist
function playlistSkipHandler(fn) {
  return (req, res) => {
    const config = loadConfig();
    const guildId = req.body.guildId || config.discord?.defaultGuildId;
    if (!guildId) return res.status(400).json({ error: 'guildId não informado' });
    try {
      res.json(fn(guildId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
app.post('/api/discord/playlist/next', requireAuth, playlistSkipHandler(g => bot.nextTrack(g)));
app.post('/api/discord/playlist/prev', requireAuth, playlistSkipHandler(g => bot.prevTrack(g)));

// GET /api/youtube/stream?url=...
app.get('/api/youtube/stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
  if (!ytRegex.test(url)) return res.status(400).json({ error: 'URL do YouTube inválida' });

  let ytDlpBin;
  try {
    ytDlpBin = await ytdlp.ensure();
  } catch (err) {
    console.error('Erro ao preparar yt-dlp:', err.message);
    return res.status(500).json({ error: 'yt-dlp indisponível (falha ao baixar)' });
  }

  const ytProc = spawn(ytDlpBin, [
    '-f', 'bestaudio',
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');

  ytProc.stdout.pipe(res);

  ytProc.on('error', (err) => {
    console.error('yt-dlp stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao iniciar yt-dlp' });
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
  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado' });

  try {
    res.json(bot.stopAudio(guildId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let httpServer = null;

async function startServer() {
  return new Promise((resolve, reject) => {
    httpServer = app.listen(PORT, async () => {
      console.log(`🎵 SoundBot rodando em http://localhost:${PORT}`);

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
