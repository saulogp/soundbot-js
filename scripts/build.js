// ---------------------------------------------------------------------------
// Build wrapper — `node scripts/build.js <win|linux> [electron-builder targets]`
//
// electron-builder copies node_modules as-is, and ffmpeg-static only holds the
// binary for the OS that ran `npm install`. Building for another OS would ship
// the wrong ffmpeg (no audio at all). So: fetch the target OS's ffmpeg, build,
// then restore the host's ffmpeg so `npm start` / `npm run electron` keep working.
// ---------------------------------------------------------------------------
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLATFORMS = { win: 'win32', linux: 'linux' };
const [target, ...extraArgs] = process.argv.slice(2);
if (!PLATFORMS[target]) {
  console.error('Uso: node scripts/build.js <win|linux> [targets do electron-builder]');
  process.exit(1);
}

const ffmpegPkgDir = path.dirname(require.resolve('ffmpeg-static/package.json'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32' // npm.cmd/npx.cmd need a shell on Windows
  });
  return res.status === 0;
}

// Leaves only the given platform's ffmpeg in node_modules (no ~80 MB leftover
// of the other OS inside the package).
function installFfmpeg(platform) {
  for (const bin of ['ffmpeg', 'ffmpeg.exe']) {
    for (const suffix of ['', '.README', '.LICENSE']) {
      fs.rmSync(path.join(ffmpegPkgDir, bin + suffix), { force: true });
    }
  }
  console.log(`\n> ffmpeg-static para ${platform}-x64`);
  return run(npm, ['rebuild', 'ffmpeg-static'], {
    npm_config_platform: platform,
    npm_config_arch: 'x64'
  });
}

const targetPlatform = PLATFORMS[target];
const crossBuild = targetPlatform !== process.platform;
let ok = true;

if (crossBuild) ok = installFfmpeg(targetPlatform);

if (ok) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  ok = run(npx, ['electron-builder', `--${target}`, ...extraArgs]);
}

if (crossBuild && !installFfmpeg(process.platform)) {
  console.error('\nFalha ao restaurar o ffmpeg do sistema — rode: npm rebuild ffmpeg-static');
  ok = false;
}

process.exit(ok ? 0 : 1);
