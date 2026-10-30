const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('lightcast', {
  startStream: (urls, kbps) => ipcRenderer.invoke('stream:start', urls, kbps),
  sendChunk: (buf) => ipcRenderer.send('stream:chunk', buf),
  stopStream: () => ipcRenderer.invoke('stream:stop'),
  saveRecording: (buf) => ipcRenderer.invoke('record:save', buf),
  onStreamStatus: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('stream:status', h);
    return () => ipcRenderer.removeListener('stream:status', h);
  },
  saveProject: (text, existing) => ipcRenderer.invoke('project:save', text, existing),
  openProject: () => ipcRenderer.invoke('project:open'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  autosave: (text) => ipcRenderer.invoke('project:autosave', text),
  loadAutosave: () => ipcRenderer.invoke('project:autoload'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } },
});
