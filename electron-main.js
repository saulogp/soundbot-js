const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

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

  // Start the Express + Discord-bot server
  const { startServer } = require('./server');
  await startServer();

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

app.on('before-quit', async () => {
  // Gracefully shut down the Discord bot
  try {
    const bot = require('./discord-bot');
    await bot.destroy();
  } catch {
    // ignore — bot may not have been initialised
  }
});
