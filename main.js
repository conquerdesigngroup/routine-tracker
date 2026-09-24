const { app, BrowserWindow, shell, clipboard, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 7423;
let activePort = PREFERRED_PORT;

const OVERLAY_TEXT_STYLES = ['shadow', 'outline', 'none'];
let state = { routines: [], current: null, hidden: false, clearedBackup: null, message: { text: '', visible: false }, routineFont: 'Avega', messageFont: 'Avega', overlayTextStyle: 'shadow' };
let stateFile;

function loadPersistedState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    state = JSON.parse(raw);
    if (!state.routines) state.routines = [];
    if (!('clearedBackup' in state)) state.clearedBackup = null;
    if (!state.message || typeof state.message !== 'object') state.message = { text: '', visible: false };
    const legacy = typeof state.overlayFont === 'string' ? state.overlayFont : 'Avega';
    if (typeof state.routineFont !== 'string') state.routineFont = legacy;
    if (typeof state.messageFont !== 'string') state.messageFont = legacy;
    if (!OVERLAY_TEXT_STYLES.includes(state.overlayTextStyle)) state.overlayTextStyle = 'shadow';
    delete state.overlayFont;
  } catch (_) {}
}

function savePersistedState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_) {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2'
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const fullPath = path.normalize(path.join(__dirname, urlPath));
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/api/version' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: app.getVersion() }));
      return;
    }
    if (req.url === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url === '/api/state' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const next = JSON.parse(body);
          if (typeof next !== 'object' || !next) throw new Error('bad payload');
          const nextMsg = (next.message && typeof next.message === 'object') ? next.message : null;
          const legacyFont = typeof next.overlayFont === 'string' ? next.overlayFont : 'Avega';
          state = {
            routines: next.routines || [],
            current: next.current ?? null,
            hidden: !!next.hidden,
            clearedBackup: next.clearedBackup ?? null,
            message: nextMsg
              ? { text: typeof nextMsg.text === 'string' ? nextMsg.text : '', visible: !!nextMsg.visible }
              : { text: '', visible: false },
            routineFont: typeof next.routineFont === 'string' ? next.routineFont : legacyFont,
            messageFont: typeof next.messageFont === 'string' ? next.messageFont : legacyFont,
            overlayTextStyle: OVERLAY_TEXT_STYLES.includes(next.overlayTextStyle) ? next.overlayTextStyle : 'shadow'
          };
          savePersistedState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400);
          res.end(String(e.message || e));
        }
      });
      return;
    }
    serveStatic(req, res);
  });
}

function listenWithFallback(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        // fall back to random available port
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

async function startServer() {
  const server = createServer();
  activePort = await listenWithFallback(server, PREFERRED_PORT);
  return activePort;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 960,
    minWidth: 380,
    minHeight: 520,
    title: 'Routine Tracker',
    backgroundColor: '#0a0a0c',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(`http://127.0.0.1:${activePort}/?port=${activePort}`);

  // Open external links in the default browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'Routine Tracker',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Copy OBS Overlay URL',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => clipboard.writeText(`http://127.0.0.1:${activePort}/#overlay`)
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]);
  Menu.setApplicationMenu(menu);
}

// ==================== AUTO-UPDATE ====================
// Wires electron-updater to the GitHub Releases feed configured in
// package.json's `build.publish`. Reads latest-mac.yml from the release,
// downloads the .zip delta in the background, verifies the signature against
// the same Developer ID cert we sign the DMG with, then prompts the user to
// restart into the new version. No additional Apple setup beyond the
// existing signing/notarization is required.
function setupAutoUpdater() {
  if (!app.isPackaged) return;   // Skip in `electron .` dev runs.

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] error:', err && err.message || err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] update available:', info && info.version);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdater] on latest');
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Routine Tracker ${info.version} is ready to install.`,
      detail: 'The app will restart to finish the update.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // First check on startup, then a heartbeat every 4 hours in case the app
  // stays open across a release (opera-hours streaming rigs, etc.).
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  stateFile = path.join(app.getPath('userData'), 'state.json');
  loadPersistedState();
  await startServer();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
