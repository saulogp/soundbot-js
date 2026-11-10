// ---------------------------------------------------------------------------
// Preload — exposes the few desktop-only features the web UI can use.
// The page checks `window.soundbotDesktop` to know it runs inside Electron;
// in a plain browser it doesn't exist and the UI falls back to text input.
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundbotDesktop', {
  // Opens the native folder picker. Resolves the absolute path, or null if canceled.
  pickDirectory: (defaultPath) => ipcRenderer.invoke('pick-directory', defaultPath)
});
