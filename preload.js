'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  hunt: (query) => ipcRenderer.invoke('hunt', query),
  exportResults: (rows, format, kind) => ipcRenderer.invoke('export', { rows, format, kind }),
  importFile: () => ipcRenderer.invoke('import'),
  onProgress: (cb) => ipcRenderer.on('hunt:progress', (_e, data) => cb(data)),
  runPortfolio: (domains, scope) => ipcRenderer.invoke('portfolio:run', { domains, scope }),
  cancelPortfolio: () => ipcRenderer.invoke('portfolio:cancel'),
  onPortfolioProgress: (cb) => ipcRenderer.on('portfolio:progress', (_e, data) => cb(data)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testUsptoKey: (key) => ipcRenderer.invoke('settings:testUspto', key)
});
