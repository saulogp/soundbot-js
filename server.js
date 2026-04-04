const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bot = require('./discord-bot');

const app = express();
const PORT = 3000;

// Config file to persist settings — when running inside Electron the main
// process sets SOUNDBOT_CONFIG_DIR to app.getPath('userData').
const CONFIG_DIR = process.env.SOUNDBOT_CONFIG_DIR || __dirname;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    const defaults = {
      audioDir: path.join(__dirname, 'audios'),
      categories: ['Geral'],
      discord: { token: '', defaultGuildId: '', defaultChannelId: '' }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Multer setup — save to temp dir first, then move to category folder
const TEMP_DIR = path.join(__dirname, '.tmp-uploads');
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

// Metadata helpers — stores thumbnail mappings per category
function getMetadataPath(audioDir, category) {
  return path.join(audioDir, category, '.metadata.json');
}

function loadMetadata(audioDir, category) {
  try {
    return JSON.parse(fs.readFileSync(getMetadataPath(audioDir, category), 'utf-8'));
  } catch {
    return {};
  }
}

function saveMetadata(audioDir, category, meta) {
  fs.writeFileSync(getMetadataPath(audioDir, category), JSON.stringify(meta, null, 2));
}

app.use(express.json());
app.use(express.static('public'));

// Serve audio files from the configured directory
app.use('/audio-files', (req, res, next) => {
  const config = loadConfig();
  express.static(config.audioDir)(req, res, next);
});

// GET /api/config
app.get('/api/config', (_req, res) => {
  res.json(loadConfig());
});

// PUT /api/config/directory
app.put('/api/config/directory', (req, res) => {
  const { directory } = req.body;
  if (!directory) return res.status(400).json({ error: 'Diretório não informado' });

  // Resolve relative paths
  const resolved = path.resolve(directory);
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
  const dir = path.join(config.audioDir, name.trim());
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

    if (category === 'Geral') {
      const entries = fs.readdirSync(audioDir, { withFileTypes: true });
      const allFiles = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = loadMetadata(audioDir, entry.name);
        const catDir = path.join(audioDir, entry.name);
        const files = fs.readdirSync(catDir)
          .filter(f => allowedExt.includes(path.extname(f).toLowerCase()))
          .map(f => ({
            name: path.basename(f, path.extname(f)),
            filename: f,
            category: entry.name,
            url: `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(f)}`,
            thumbnail: meta[f] ? `/audio-files/${encodeURIComponent(entry.name)}/${encodeURIComponent(meta[f])}` : null
          }));
        allFiles.push(...files);
      }
      res.json(allFiles);
    } else {
      const dir = path.join(audioDir, category);
      fs.mkdirSync(dir, { recursive: true });
      const meta = loadMetadata(audioDir, category);
      const files = fs.readdirSync(dir)
        .filter(f => allowedExt.includes(path.extname(f).toLowerCase()))
        .map(f => ({
          name: path.basename(f, path.extname(f)),
          filename: f,
          category,
          url: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(f)}`,
          thumbnail: meta[f] ? `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(meta[f])}` : null
        }));
      res.json(files);
    }
  } catch {
    res.json([]);
  }
});

// POST /api/audios — upload, then move from temp to correct category folder
app.post('/api/audios', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo de áudio inválido' });

  const config = loadConfig();
  const category = req.body.category || 'Geral';
  const destDir = path.join(config.audioDir, category);
  fs.mkdirSync(destDir, { recursive: true });

  const srcPath = req.file.path;
  const destPath = path.join(destDir, req.file.filename);
  fs.renameSync(srcPath, destPath);

  res.json({
    name: path.basename(req.file.filename, path.extname(req.file.filename)),
    filename: req.file.filename,
    category,
    url: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(req.file.filename)}`
  });
});

// PUT /api/audios/thumbnail — upload thumbnail for an audio
app.put('/api/audios/thumbnail', thumbUpload.single('thumbnail'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem inválida' });

  const config = loadConfig();
  const category = req.body.category;
  const filename = req.body.filename;
  if (!category || !filename) return res.status(400).json({ error: 'Categoria e arquivo são obrigatórios' });

  const destDir = path.join(config.audioDir, category);
  fs.mkdirSync(destDir, { recursive: true });

  // Remove old thumbnail if exists
  const meta = loadMetadata(config.audioDir, category);
  if (meta[filename]) {
    const oldPath = path.join(destDir, meta[filename]);
    try { fs.unlinkSync(oldPath); } catch {}
  }

  // Move new thumbnail to category folder
  const thumbName = `_thumb_${path.basename(filename, path.extname(filename))}${path.extname(req.file.filename)}`;
  const destPath = path.join(destDir, thumbName);
  fs.renameSync(req.file.path, destPath);

  // Save metadata
  meta[filename] = thumbName;
  saveMetadata(config.audioDir, category, meta);

  res.json({
    thumbnail: `/audio-files/${encodeURIComponent(category)}/${encodeURIComponent(thumbName)}`
  });
});

// DELETE /api/audios
app.delete('/api/audios', (req, res) => {
  const { category, filename } = req.body;
  if (!category || !filename) return res.status(400).json({ error: 'Dados insuficientes' });

  const config = loadConfig();
  const filePath = path.join(config.audioDir, category, filename);

  try {
    fs.unlinkSync(filePath);
    res.json({ deleted: true });
  } catch {
    res.status(404).json({ error: 'Arquivo não encontrado' });
  }
});

// ===== Discord Bot API =====

// GET /api/discord/status
app.get('/api/discord/status', (_req, res) => {
  res.json(bot.getStatus());
});

// PUT /api/discord/token
app.put('/api/discord/token', async (req, res) => {
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
app.post('/api/discord/join', (req, res) => {
  const { guildId, channelId } = req.body;
  if (!guildId || !channelId) return res.status(400).json({ error: 'guildId e channelId são obrigatórios' });

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
app.post('/api/discord/leave', (req, res) => {
  const { guildId } = req.body;
  if (!guildId) return res.status(400).json({ error: 'guildId é obrigatório' });

  try {
    res.json(bot.leaveChannel(guildId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/play
app.post('/api/discord/play', (req, res) => {
  const { category, filename } = req.body;
  if (!category || !filename) return res.status(400).json({ error: 'category e filename são obrigatórios' });

  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado e sem padrão configurado' });

  const filePath = path.join(config.audioDir, category, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });

  try {
    res.json(bot.playAudio(guildId, filePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/discord/stop
app.post('/api/discord/stop', (req, res) => {
  const config = loadConfig();
  const guildId = req.body.guildId || config.discord?.defaultGuildId;
  if (!guildId) return res.status(400).json({ error: 'guildId não informado' });

  try {
    res.json(bot.stopAudio(guildId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(PORT, async () => {
      console.log(`🎵 SoundBot rodando em http://localhost:${PORT}`);

      // Auto-init Discord bot if token exists
      const config = loadConfig();
      if (config.discord?.token) {
        try {
          await bot.init(config.discord.token);
        } catch (err) {
          console.error('Erro ao conectar bot Discord:', err.message);
        }
      }

      resolve(server);
    });
  });
}

// Se executado diretamente (node server.js), inicia o servidor.
// Se importado pelo Electron, apenas exporta a função.
if (require.main === module) {
  startServer();
}

module.exports = { startServer, PORT };
