const { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let ffmpegPath = require('ffmpeg-static');
if (app.isPackaged) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');

let win = null;
let streamProc = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#161c28',
    title: 'LightCast Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(['media', 'display-capture'].includes(perm)));
  // Screen capture: use the primary screen without a picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: sources[0] });
  });
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch {}
    try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (streamProc) streamProc.kill();
  if (process.platform !== 'darwin') app.quit();
});

const notify = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('stream:status', msg); };

// ---- Live streaming: browser MediaRecorder chunks -> ffmpeg -> RTMP/RTMPS ----
ipcMain.handle('stream:start', (_e, urls) => {
  if (streamProc) return { ok: false, error: 'Stream already running' };
  const args = [
    '-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
  ];
  if (urls.length === 1) args.push('-f', 'flv', urls[0]);
  else args.push('-map', '0:v', '-map', '0:a', '-f', 'tee', urls.map((u) => `[f=flv:onfail=ignore]${u}`).join('|'));

  streamProc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  streamProc.stdin.on('error', () => {});
  streamProc.stderr.on('data', (d) => notify({ log: d.toString().slice(0, 300) }));
  streamProc.on('error', (err) => { notify({ closed: true, error: err.message }); streamProc = null; });
  streamProc.on('close', (code) => { notify({ closed: true, code }); streamProc = null; });
  return { ok: true };
});

ipcMain.on('stream:chunk', (_e, buf) => {
  if (streamProc && streamProc.stdin.writable) streamProc.stdin.write(Buffer.from(buf));
});

ipcMain.handle('stream:stop', () => {
  if (streamProc) { try { streamProc.stdin.end(); } catch {} setTimeout(() => streamProc && streamProc.kill(), 2000); }
  return { ok: true };
});

// ---- Recording: save WebM then convert to MP4 ----
ipcMain.handle('record:save', async (_e, buf) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos'), `LightCast-${stamp}.mp4`),
    filters: [{ name: 'MP4', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  const tmp = path.join(os.tmpdir(), `lightcast-${Date.now()}.webm`);
  fs.writeFileSync(tmp, Buffer.from(buf));
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-y', '-i', tmp, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', res.filePath]);
    p.on('error', () => resolve({ ok: false }));
    p.on('close', (code) => { fs.unlink(tmp, () => {}); resolve({ ok: code === 0, path: res.filePath }); });
  });
});
