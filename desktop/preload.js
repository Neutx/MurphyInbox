// The only bridge between the web app and the desktop shell. The web app checks for
// window.murphyDesktop to switch to in-app notifications (Web Push needs a browser push service,
// which Electron doesn't have).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('murphyDesktop', {
  platform: process.platform,
  focus: () => ipcRenderer.send('murphy:focus'),
  setBadge: (count) => ipcRenderer.send('murphy:badge', Number(count) || 0),
});
