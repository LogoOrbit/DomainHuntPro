'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { hunt } = require('./lookup');
const { huntPortfolio, QUICK_TLDS } = require('./portfolio');
const { SCAN_TLDS } = require('./lookup');
const { testKey } = require('./trademark');

let win;
let portfolioCancelled = false;

// --- Local settings (API keys etc.) ----------------------------------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (e) { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'DomainHunt Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: run a hunt --------------------------------------------------------
ipcMain.handle('hunt', async (evt, query) => {
  try {
    const out = await hunt(query, (done, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('hunt:progress', { done, total });
    });
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// --- IPC: settings ----------------------------------------------------------
ipcMain.handle('settings:get', async () => {
  const s = readSettings();
  return { ok: true, usptoApiKey: s.usptoApiKey || '' };
});
ipcMain.handle('settings:save', async (evt, patch) => {
  const s = readSettings();
  const next = { ...s, ...patch };
  const ok = writeSettings(next);
  return { ok };
});
ipcMain.handle('settings:testUspto', async (evt, key) => {
  const apiKey = key || readSettings().usptoApiKey;
  if (!apiKey) return { ok: false, error: 'No API key set' };
  return await testKey(apiKey);
});

// --- IPC: bulk portfolio lead scan ------------------------------------------
ipcMain.handle('portfolio:run', async (evt, { domains, scope }) => {
  portfolioCancelled = false;
  try {
    const tlds = scope === 'full' ? SCAN_TLDS : QUICK_TLDS;
    const usptoApiKey = readSettings().usptoApiKey || '';
    const out = await huntPortfolio(domains, {
      tlds,
      usptoApiKey,
      onProgress: (done, total) => {
        if (win && !win.isDestroyed()) win.webContents.send('portfolio:progress', { done, total });
      },
      isCancelled: () => portfolioCancelled
    });
    return { ok: true, ...out, cancelled: portfolioCancelled };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('portfolio:cancel', async () => {
  portfolioCancelled = true;
  return { ok: true };
});

// --- IPC: export results ----------------------------------------------------
ipcMain.handle('export', async (evt, { rows, format, kind }) => {
  const filters = format === 'json'
    ? [{ name: 'JSON', extensions: ['json'] }]
    : [{ name: 'CSV', extensions: ['csv'] }];
  const defaultName = kind === 'leads' ? 'domainhunt-leads' : 'domainhunt-export';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export results',
    defaultPath: `${defaultName}.${format}`,
    filters
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  let content;
  if (format === 'json') {
    content = JSON.stringify(rows, null, 2);
  } else {
    const cols = kind === 'leads'
      ? ['org', 'sources', 'emails', 'outreach', 'score', 'yourDomains', 'trademarks', 'lookalikeDomains', 'registrar']
      : ['domain', 'status', 'registered', 'owner', 'emails', 'outreach', 'registrar', 'created', 'expires', 'note'];
    const esc = (v) => {
      if (v == null) v = '';
      if (Array.isArray(v)) v = v.join('; ');
      v = String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    content = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(',')))
      .join('\n');
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
});

// --- IPC: import a file (returns list of queries to run) --------------------
ipcMain.handle('import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import domains',
    properties: ['openFile'],
    filters: [{ name: 'Domains', extensions: ['csv', 'txt', 'json'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  const raw = fs.readFileSync(filePaths[0], 'utf8');
  let items = [];
  const ext = path.extname(filePaths[0]).toLowerCase();
  try {
    if (ext === '.json') {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.domains || []);
      items = arr.map((x) => (typeof x === 'string' ? x : (x.domain || x.query || ''))).filter(Boolean);
    } else {
      // CSV/TXT: take the first token of each line, skip a header row if present.
      items = raw.split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter(Boolean);
      if (items.length && /^(domain|query|name)$/i.test(items[0])) items.shift();
    }
  } catch (e) {
    return { ok: false, error: 'Could not parse file: ' + e.message };
  }
  items = [...new Set(items)];
  return { ok: true, items, filePath: filePaths[0] };
});
