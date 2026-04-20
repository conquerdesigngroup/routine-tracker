const { app, BrowserWindow, shell, clipboard, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 7423;
let activePort = PREFERRED_PORT;

let state = { routines: [], current: null };
let stateFile;

function loadPersistedState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    state = JSON.parse(raw);
    if (!state.routines) state.routines = [];
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
          state = { routines: next.routines || [], current: next.current ?? null };
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
    minWidth: 900,
    minHeight: 700,
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

app.whenReady().then(async () => {
  stateFile = path.join(app.getPath('userData'), 'state.json');
  loadPersistedState();
  await startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
