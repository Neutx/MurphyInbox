// MurphyInbox desktop: the web app at APP_URL in its own window. Closing the window keeps it
// running in the tray (menu bar on macOS) so new-mail notifications keep arriving; links to other
// sites open in the default browser. No local server, no bundled copy of the app: updates to the
// web app reach the desktop app on the next load.
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_URL = process.env.MURPHY_APP_URL || 'https://mail.murphylabs.org';
const APP_ORIGIN = new URL(APP_URL).origin;
const isMac = process.platform === 'darwin';

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show());
}

app.setAppUserModelId('org.murphylabs.inbox'); // Windows: toasts are attributed to MurphyInbox

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}
function saveBounds() {
  if (!win || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() }));
  } catch {
    // not worth failing over
  }
}

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width || 1280,
    height: b.height || 820,
    minWidth: 380,
    minHeight: 520,
    title: 'MurphyInbox',
    backgroundColor: '#f2f2f7',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'tray.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Keeps the mail check on time while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // Only MurphyInbox itself loads inside the window; everything else goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:') || url.startsWith('mailto:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);

  win.loadURL(APP_URL);
}

function loginItemOn() {
  return app.getLoginItemSettings().openAtLogin;
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open MurphyInbox', click: show },
    { type: 'separator' },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: loginItemOn(),
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: 'Reload', click: () => win?.webContents.reload() },
    { type: 'separator' },
    {
      label: 'Quit MurphyInbox',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', isMac ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(isMac ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('MurphyInbox');
  tray.setContextMenu(trayMenu());
  if (!isMac) tray.on('click', show);
}

function appMenu() {
  if (!isMac) return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]),
  );
}

ipcMain.on('murphy:focus', () => show());
ipcMain.on('murphy:badge', (_e, count) => {
  if (isMac) app.dock?.setBadge(count > 0 ? String(count) : '');
  else if (process.platform === 'win32') app.setBadgeCount?.(count);
  tray?.setToolTip(count > 0 ? `MurphyInbox: ${count} unread` : 'MurphyInbox');
});

app.whenReady().then(() => {
  // Notifications are the only permission the app asks for; camera, location etc. stay off.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(permission === 'notifications' && new URL(wc.getURL()).origin === APP_ORIGIN);
  });
  appMenu();
  createWindow();
  createTray();
});

app.on('activate', show); // macOS: clicking the Dock icon
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // Stays in the tray; Quit is in the tray menu (and Cmd+Q on macOS).
});
