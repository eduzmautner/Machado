// Bridge between the sandboxed renderer and the main process.
// The renderer sees exactly this `window.native` surface and nothing else.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (path, content) => ipcRenderer.invoke('file:save', path, content),
  pickSaveFile: (suggestedName, preferHtml) =>
    ipcRenderer.invoke('file:pickSave', suggestedName, preferHtml),
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (data) => ipcRenderer.send('session:save', data),
  syncState: (state) => ipcRenderer.send('state:sync', state),
  onCommand: (cb) => ipcRenderer.on('command', (_e, name, arg) => cb(name, arg)),
});
