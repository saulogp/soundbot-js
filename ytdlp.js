// ---------------------------------------------------------------------------
// yt-dlp manager — resolves the yt-dlp binary path and downloads it on first
// use so the distributed app works on machines that don't have yt-dlp on PATH.
//
// The binary is stored under SOUNDBOT_CONFIG_DIR/bin (Electron sets this to
// app.getPath('userData'), a writable per-user folder). If a yt-dlp is already
// available on the system PATH it is used as-is and nothing is downloaded.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const DOWNLOAD_URL = IS_WIN
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function configDir() {
  return process.env.SOUNDBOT_CONFIG_DIR || __dirname;
}

function localBinPath() {
  return path.join(configDir(), 'bin', BIN_NAME);
}

// Cached resolved path + in-flight ensure promise
let resolvedPath = null;
let ensurePromise = null;

// Returns true if a bare `yt-dlp` is callable from the system PATH.
function ytDlpOnPath() {
  try {
    const r = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos ao baixar yt-dlp'));

    https.get(url, (res) => {
      // Follow GitHub release redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download yt-dlp falhou: HTTP ${res.statusCode}`));
      }

      const tmp = `${dest}.download`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try {
          fs.renameSync(tmp, dest);
          if (!IS_WIN) fs.chmodSync(dest, 0o755);
          resolve(dest);
        } catch (err) {
          reject(err);
        }
      }));
      file.on('error', (err) => {
        fs.rm(tmp, { force: true }, () => reject(err));
      });
    }).on('error', reject);
  });
}

// Ensures a usable yt-dlp exists and returns its path/command.
// Resolution order: cached → system PATH → already-downloaded local binary →
// download into the config dir. Idempotent and safe to call concurrently.
async function ensure() {
  if (resolvedPath) return resolvedPath;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const local = localBinPath();

    if (fs.existsSync(local)) {
      resolvedPath = local;
      return resolvedPath;
    }
    if (ytDlpOnPath()) {
      resolvedPath = 'yt-dlp';
      return resolvedPath;
    }

    fs.mkdirSync(path.dirname(local), { recursive: true });
    console.log('Baixando yt-dlp (primeira execução)...');
    await download(DOWNLOAD_URL, local);
    console.log('yt-dlp pronto:', local);
    resolvedPath = local;
    return resolvedPath;
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

// Synchronous best-effort path for spawn sites. Returns the cached resolved
// path if ensure() already ran, otherwise the expected local binary (or the
// bare command as a last resort). Callers should `await ensure()` first.
function getPath() {
  if (resolvedPath) return resolvedPath;
  const local = localBinPath();
  if (fs.existsSync(local)) return local;
  return 'yt-dlp';
}

module.exports = { ensure, getPath };
