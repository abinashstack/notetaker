const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  startSession: () => ipcRenderer.invoke('session:start'),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  getSession: () => ipcRenderer.invoke('session:get'),
  saveDraft: () => ipcRenderer.invoke('draft:save'),
  continueDraft: () => ipcRenderer.invoke('draft:continue'),
  discardDraft: () => ipcRenderer.invoke('draft:discard'),
  popout: (id) => ipcRenderer.invoke('notes:popout', id),
  exportNotes: () => ipcRenderer.invoke('notes:export'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  onSessionState: (cb) => ipcRenderer.on('session:state', (_e, s) => cb(s)),
});
