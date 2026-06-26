const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;

// ---------------------------------------------------------------------------
// Load .env bundled as extraResource — only sets vars that aren't already set
// ---------------------------------------------------------------------------
function loadBundledEnv() {
  const envPaths = [
    path.join(process.resourcesPath, '.env'),  // packaged build
    path.join(__dirname, '.env')                // dev (electron .)
  ];

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: getIcon(),
    title: 'SoundBot',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // server.js is already required and cached by whenReady — safe to re-require
  const { PORT } = require('./server');
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Remove the default menu bar (File / Edit / etc.)
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    // Minimise to tray instead of quitting
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = getIcon();
  tray = new Tray(icon);
  tray.setToolTip('SoundBot');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir SoundBot',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Icon helper — uses assets/icon.png when available, falls back to a tiny
// 16x16 transparent PNG so the app never crashes on a missing icon.
// ---------------------------------------------------------------------------
function getIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  try {
    return nativeImage.createFromPath(iconPath);
  } catch {
    return nativeImage.createEmpty();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // Redirect config storage to the proper user-data folder so that a
  // packaged install doesn't try to write next to the .exe / .asar.
  process.env.SOUNDBOT_CONFIG_DIR = app.getPath('userData');

  // Load Discord credentials from bundled .env (extraResources)
  // The .env file is gitignored and embedded at build time — secrets never in source.
  loadBundledEnv();

  // Start the Express + Discord-bot server
  const { startServer } = require('./server');
  try {
    await startServer();
  } catch (err) {
    // Most likely the port is already in use — show a clear message and quit
    // instead of opening a blank window pointing at a dead server.
    dialog.showErrorBox('Não foi possível iniciar o SoundBot', err.message);
    app.isQuitting = true;
    app.quit();
    return;
  }

  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // No-op: keep the app alive in the tray
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', async (e) => {
  if (app._cleanupDone) return;
  e.preventDefault();

  try {
    const { stopServer } = require('./server');
    await stopServer();
  } catch {
    // ignore — server/bot may not have been initialised
  }

  app._cleanupDone = true;
  app.quit();
});
