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
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
// Standalone builds don't need Python installed; the plain `yt-dlp` asset is a
// zipapp that requires python3 (fallback for other OS/arch combos)
const LINUX_ASSETS = { x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64' };
const DOWNLOAD_URL = RELEASE_URL + (IS_WIN
  ? 'yt-dlp.exe'
  : (process.platform === 'linux' && LINUX_ASSETS[process.arch]) || 'yt-dlp');

function configDir() {
  return process.env.SOUNDBOT_CONFIG_DIR || __dirname;
}

function localBinPath() {
  return path.join(configDir(), 'bin', BIN_NAME);
}

// Cached resolved path + in-flight ensure promise
let resolvedPath = null;
let ensurePromise = null;

// Abort the download when the connection stalls for this long
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;
// A working binary answers --version well within this
const VERSION_CHECK_TIMEOUT_MS = 30 * 1000;

// Resolves true if `cmd --version` exits with 0 (binary exists and runs).
// Async so a slow first start (PyInstaller .exe) doesn't block the server.
function runsOk(cmd) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => proc.kill(), VERSION_CHECK_TIMEOUT_MS);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos ao baixar yt-dlp'));

    // Set once the body starts streaming; routes request errors to the cleanup
    let failBody = null;

    const req = https.get(url, (res) => {
      // Follow GitHub release redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download yt-dlp falhou: HTTP ${res.statusCode}`));
      }

      const tmp = `${dest}.download`;
      const expected = Number(res.headers['content-length']) || null;
      const file = fs.createWriteStream(tmp);
      let received = 0;
      let done = false;

      // pipe() doesn't forward source errors: without this a dropped
      // connection never settles the promise and every YouTube action hangs.
      const fail = (err) => {
        if (done) return;
        done = true;
        res.destroy();
        file.destroy();
        fs.rm(tmp, { force: true }, () => reject(err));
      };
      failBody = fail;

      res.on('data', chunk => { received += chunk.length; });
      res.on('error', fail);
      res.on('close', () => {
        if (!res.complete) fail(new Error('Download do yt-dlp interrompido'));
      });
      file.on('error', fail);
      file.on('finish', () => file.close(() => {
        if (done) return;
        // A truncated binary would otherwise be cached and reused forever
        if (received === 0 || (expected !== null && received !== expected)) {
          return fail(new Error(`Download do yt-dlp incompleto (${received}/${expected ?? '?'} bytes)`));
        }
        try {
          fs.renameSync(tmp, dest);
          if (!IS_WIN) fs.chmodSync(dest, 0o755);
          done = true;
          resolve(dest);
        } catch (err) {
          fail(err);
        }
      }));
      res.pipe(file);
    });

    req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error('Tempo esgotado ao baixar yt-dlp'));
    });
    req.on('error', (err) => (failBody ? failBody(err) : reject(err)));
  });
}

// Ensures a usable yt-dlp exists and returns its path/command.
// Resolution order: cached → already-downloaded local binary → system PATH →
// download into the config dir. Idempotent and safe to call concurrently.
async function ensure() {
  if (resolvedPath) return resolvedPath;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const local = localBinPath();

    if (fs.existsSync(local)) {
      if (await runsOk(local)) {
        resolvedPath = local;
        return resolvedPath;
      }
      // Corrupted (e.g. truncated by an older download) — fetch it again
      console.warn('yt-dlp local não executa, baixando novamente...');
      fs.rmSync(local, { force: true });
    }
    if (await runsOk('yt-dlp')) {
      resolvedPath = 'yt-dlp';
      return resolvedPath;
    }

    fs.mkdirSync(path.dirname(local), { recursive: true });
    console.log('Baixando yt-dlp (primeira execução)...');
    await download(DOWNLOAD_URL, local);
    if (!(await runsOk(local))) {
      fs.rmSync(local, { force: true });
      throw new Error('yt-dlp baixado não executa');
    }
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
