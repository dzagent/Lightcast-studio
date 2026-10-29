const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lightcast', {
  startStream: (urls) => ipcRenderer.invoke('stream:start', urls),
  sendChunk: (buf) => ipcRenderer.send('stream:chunk', buf),
  stopStream: () => ipcRenderer.invoke('stream:stop'),
  saveRecording: (buf) => ipcRenderer.invoke('record:save', buf),
  onStreamStatus: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('stream:status', h);
    return () => ipcRenderer.removeListener('stream:status', h);
  },
});
