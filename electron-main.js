const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
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
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // server.js is already required and cached by whenReady — safe to re-require
  const { PORT } = require('./server');
  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Remove the default menu bar (File / Edit / etc.)
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    // Minimise to tray instead of quitting. Not on Linux: many desktops (GNOME
    // without the AppIndicator extension) show no tray icon, so a hidden
    // window could never be brought back — closing quits there.
    if (!app.isQuitting && process.platform !== 'linux') {
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
  // assets/ is not inside app.asar — the packaged build ships it as an
  // extraResource (resources/assets), so look there first
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'assets', 'icon.png'),
    path.join(__dirname, 'assets', 'icon.png')
  ].filter(Boolean);
  for (const iconPath of candidates) {
    if (!fs.existsSync(iconPath)) continue;
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
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
  // Elsewhere the app stays alive in the tray. On Linux closing the window
  // means quit (see createWindow) — otherwise the server would keep running
  // invisibly and hold the port.
  if (process.platform === 'linux') {
    app.isQuitting = true;
    app.quit();
  }
});

// ---------------------------------------------------------------------------
// IPC — native folder picker for the "Pasta de áudios" modal
// ---------------------------------------------------------------------------
ipcMain.handle('pick-directory', async (event, defaultPath) => {
  // The preload also runs on pages the window navigates to (Discord OAuth);
  // only the app's own page may open dialogs.
  const { PORT } = require('./server');
  let origin = null;
  try { origin = new URL(event.senderFrame?.url).origin; } catch {}
  if (origin !== `http://localhost:${PORT}`) return null;

  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Escolher pasta de áudios',
    buttonLabel: 'Usar esta pasta',
    defaultPath: typeof defaultPath === 'string' && path.isAbsolute(defaultPath) ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  return canceled || !filePaths.length ? null : filePaths[0];
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
  // Quit can come from outside the tray menu (Cmd+Q, OS logout...). Without
  // this the window's 'close' handler would cancel it and leave the window up
  // with the server already stopped.
  app.isQuitting = true;

  try {
    const { stopServer } = require('./server');
    await stopServer();
  } catch {
    // ignore — server/bot may not have been initialised
  }

  app._cleanupDone = true;
  app.quit();
});
