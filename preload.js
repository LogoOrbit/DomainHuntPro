'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  hunt: (query, options) => ipcRenderer.invoke('hunt', query, options),
  exportResults: (rows, format) => ipcRenderer.invoke('export', { rows, format }),
  importFile: () => ipcRenderer.invoke('import'),
  onProgress: (cb) => ipcRenderer.on('hunt:progress', (_e, data) => cb(data))
});
