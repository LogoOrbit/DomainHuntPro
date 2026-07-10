'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { hunt } = require('./lookup');

let win;

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

// --- IPC: export results ----------------------------------------------------
ipcMain.handle('export', async (evt, { rows, format }) => {
  const filters = format === 'json'
    ? [{ name: 'JSON', extensions: ['json'] }]
    : [{ name: 'CSV', extensions: ['csv'] }];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export results',
    defaultPath: `domainhunt-export.${format}`,
    filters
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  let content;
  if (format === 'json') {
    content = JSON.stringify(rows, null, 2);
  } else {
    const cols = ['company', 'contact', 'contactConfidence', 'allContacts', 'score', 'tier',
      'theirDomain', 'yourDomain', 'website', 'whyScore', 'recommendation',
      'coldEmail', 'linkedinMessage', 'followUp1', 'followUp2', 'registrar', 'created'];
    const esc = (v) => {
      if (v == null) v = '';
      if (Array.isArray(v)) v = v.join('; ');
      v = String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const flat = rows.map((r) => ({
      company: r.owner,
      contact: r.bestContact ? r.bestContact.email : '',
      contactConfidence: r.bestContact ? r.bestContact.confidence : '',
      allContacts: (r.contacts || []).map((c) => `${c.email} (${c.confidence})`),
      score: r.score,
      tier: r.tier,
      theirDomain: r.domain,
      yourDomain: r.ownedDomain,
      website: r.website,
      whyScore: (r.scoreDetail && r.scoreDetail.reasons) || [],
      recommendation: r.recommendation,
      coldEmail: r.outreach && r.outreach.coldEmail,
      linkedinMessage: r.outreach && r.outreach.linkedin,
      followUp1: r.outreach && r.outreach.followUp1,
      followUp2: r.outreach && r.outreach.followUp2,
      registrar: r.registrar,
      created: r.created
    }));
    content = [cols.join(',')]
      .concat(flat.map((r) => cols.map((c) => esc(r[c])).join(',')))
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
