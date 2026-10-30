import React, { useReducer, useRef, useState, useEffect } from 'react';
import { historyReducer, initialProject, uid } from './store.js';
import { W, H, createMedia, clearMedia, drawScene, drawTransition, audioBus, audio, level, setSourceGain, setMonitor } from './engine.js';
import { T } from './i18n.js';

const OUTPUTS = [
  { id: 'youtube', name: 'YouTube', base: 'rtmp://a.rtmp.youtube.com/live2/' },
  { id: 'twitch', name: 'Twitch', base: 'rtmp://live.twitch.tv/app/' },
  { id: 'facebook', name: 'Facebook', base: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  { id: 'custom', name: 'RTMP', base: '', full: true },
];
const ACCENTS = { amber: '#f2b134', teal: '#2dd4bf', violet: '#a78bfa', rose: '#fb7185' };
const MIME_BY_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const DEFAULTS = { accent: 'amber', fps: 30, streamKbps: 3000, recKbps: 5000, lang: 'ar' };
const FX = { fade: '◐', wipe: '▶', slide: '⇥', dip: '■' };
const MIME = 'video/webm;codecs=vp8,opus';
const fmt = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
const loadSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('lc.settings') || '{}') }; } catch { return DEFAULTS; } };

function HMeter({ an }) {
  const cover = useRef(null);
  useEffect(() => {
    let raf;
    const loop = () => { if (cover.current) cover.current.style.width = `${(1 - level(an)) * 100}%`; raf = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [an]);
  return <div className="hmeter"><div ref={cover} /></div>;
}

function AudioRow({ name, an, value, muted, master, onStart, onChange, onMute, extra, muteLabel }) {
  const db = value === 0 ? '−∞' : (20 * Math.log10(value / 100)).toFixed(1);
  return (
    <div className={`arow ${master ? 'master' : ''} ${muted ? 'off' : ''}`}>
      <span className="aname" title={name}>{name}</span>
      <HMeter an={an} />
      <div className="aslide">
        <input type="range" min={0} max={150} value={value} onPointerDown={onStart} onKeyDown={onStart}
          onChange={(e) => onChange(Number(e.target.value))} />
        <output>{db} dB</output>
      </div>
      {onMute && <button className={`mute ${muted ? 'on' : ''}`} onClick={onMute} title={muteLabel}>M</button>}
      {extra}
    </div>
  );
}

function Slider({ label, value, min = 0, max = 100, onStart, onChange }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} onPointerDown={onStart} onKeyDown={onStart}
        onChange={(e) => onChange(Number(e.target.value))} />
      <output>{Math.round(value)}</output>
    </label>
  );
}

export default function App() {
  const [h, dispatch] = useReducer(historyReducer, null, () => ({ past: [], present: initialProject(), future: [] }));
  const project = h.present;
  const [settings, setSettingsState] = useState(loadSettings);
  const lang = settings.lang;
  const t = (k) => T[lang][k] || T.en[k] || k;
  const setSettings = (ch) => setSettingsState((s) => {
    const n = { ...s, ...ch };
    try { localStorage.setItem('lc.settings', JSON.stringify(n)); } catch {}
    return n;
  });
  const [programId, setProgramId] = useState(project.scenes[0].id);
  const [previewId, setPreviewId] = useState(project.scenes[0].id);
  const [overlays, setOverlays] = useState([]);
  const [ftb, setFtb] = useState(false);
  const [layerId, setLayerId] = useState(null);
  const [titleText, setTitleText] = useState('');
  const [transType, setTransType] = useState('fade');
  const [transDur, setTransDur] = useState(600);
  const [tbar, setTbar] = useState(0);
  const [masterVol, setMasterVol] = useState(100);
  const [monitor, setMon] = useState(false);
  const [recStart, setRecStart] = useState(null);
  const [liveStart, setLiveStart] = useState(null);
  const [now, setNow] = useState(0);
  const [onAir, setOnAir] = useState(false);
  const [keys, setKeys] = useState({});
  const [msg, setMsg] = useState('');
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [srcTab, setSrcTab] = useState('layers');
  const [renaming, setRenaming] = useState(null);
  const [fps, setFps] = useState(0);
  const [savedProj, setSavedProj] = useState(project);
  const fileRef = useRef(null);
  const dirty = project !== savedProj;
  const desktop = typeof window !== 'undefined' && !!window.lightcast;

  const snapshot = () => JSON.stringify({ app: 'LightCast', version: 3, project, programId, previewId, overlays, transType, transDur }, null, 1);
  const L = useRef({});
  L.current = { project, programId, previewId, overlays, ftb, dirty, snapshot };
  const trans = useRef(null);
  const ftbLevel = useRef(0);
  const outRef = useRef(null);
  const prevRef = useRef(null);
  const screenRef = useRef(null);
  const recRef = useRef(null);
  const liveRef = useRef(null);
  const queue = useRef(Promise.resolve());
  const drag = useRef(null);
  const tiles = useRef(new Map());
  const frameN = useRef(0);
  const videoIn = useRef(null);
  const imageIn = useRef(null);
  const toastTimer = useRef(null);
  const toast = (text) => { setMsg(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setMsg(''), 6000); };

  // ---- render loop: Program output, Preview monitor, scene tiles ----
  useEffect(() => {
    const out = outRef.current.getContext('2d');
    const prev = prevRef.current.getContext('2d');
    let raf; let count = 0; let last = performance.now();
    const frame = () => {
      const { project, programId, previewId, overlays, ftb } = L.current;
      const sc = (id) => project.scenes.find((s) => s.id === id);
      const t0 = performance.now();
      out.fillStyle = '#000'; out.fillRect(0, 0, W, H);
      const tr = trans.current;
      if (tr) {
        const raw = tr.manual ? tr.p : Math.min(1, (t0 - tr.t0) / tr.dur);
        drawTransition(out, sc(tr.from), sc(tr.to), tr.type, raw);
        if (!tr.manual && raw >= 1) trans.current = null;
      } else drawScene(out, sc(programId), 1);
      overlays.forEach((id) => drawScene(out, sc(id), 1));
      const target = ftb ? 1 : 0;
      ftbLevel.current += (target - ftbLevel.current) * 0.15;
      if (Math.abs(target - ftbLevel.current) < 0.01) ftbLevel.current = target;
      if (ftbLevel.current > 0) {
        out.globalAlpha = ftbLevel.current; out.fillStyle = '#000'; out.fillRect(0, 0, W, H); out.globalAlpha = 1;
      }
      prev.fillStyle = '#000'; prev.fillRect(0, 0, W, H);
      drawScene(prev, sc(previewId), 1);
      frameN.current += 1;
      if (frameN.current % 3 === 0) {
        tiles.current.forEach((tc, id) => {
          tc.save(); tc.fillStyle = '#000'; tc.fillRect(0, 0, 320, 180);
          tc.scale(320 / W, 180 / H); drawScene(tc, sc(id), 1); tc.restore();
        });
      }
      count += 1;
      if (t0 - last >= 1000) { setFps(Math.round((count * 1000) / (t0 - last))); count = 0; last = t0; }
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  // keep ids valid after undo/redo/delete
  useEffect(() => {
    const ids = project.scenes.map((s) => s.id);
    if (!ids.includes(programId)) setProgramId(ids[0]);
    if (!ids.includes(previewId)) setPreviewId(ids[0]);
    setOverlays((o) => o.filter((id) => ids.includes(id)));
  }, [project.scenes]);

  useEffect(() => {
    if (!recStart && !liveStart) return undefined;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [recStart, liveStart]);

  useEffect(() => {
    if (!desktop) return undefined;
    return window.lightcast.onStreamStatus((m) => {
      if (m.closed) {
        if (liveRef.current && liveRef.current.state !== 'inactive') liveRef.current.stop();
        liveRef.current = null; setOnAir(false); setLiveStart(null);
        if (m.error) toast(m.error);
      } else if (m.log) toast(m.log);
    });
  }, [desktop]);

  // audio sync
  useEffect(() => {
    project.sources.forEach((s) => { if (s.hasAudio) setSourceGain(s.id, s.muted ? 0 : s.gain / 100); });
  }, [project.sources]);
  useEffect(() => { audioBus().master.gain.value = masterVol / 100; }, [masterVol]);
  useEffect(() => { setMonitor(monitor); }, [monitor]);

  // window title + autosave
  const previewScene = project.scenes.find((s) => s.id === previewId) || project.scenes[0];
  const projName = fileRef.current ? fileRef.current.split(/[\\/]/).pop().replace(/\.lcs$/, '') : t('untitled');
  useEffect(() => { document.title = `${projName}${dirty ? ' •' : ''} — LightCast Studio`; });
  useEffect(() => {
    if (!desktop) return undefined;
    const i = setInterval(() => { if (L.current.dirty) window.lightcast.autosave(L.current.snapshot()); }, 30000);
    return () => clearInterval(i);
  }, [desktop]);

  // ---- project edits ----
  const edit = (fn) => dispatch({ type: 'edit', fn });
  const patch = (fn) => dispatch({ type: 'patch', fn });
  const checkpoint = () => dispatch({ type: 'checkpoint' });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const mapScene = (p, sid, f) => ({ ...p, scenes: p.scenes.map((s) => (s.id === sid ? f(s) : s)) });
  const layer = previewScene.layers.find((l) => l.id === layerId);
  const setLayer = (lid, ch, hist) =>
    (hist ? edit : patch)((p) => mapScene(p, previewScene.id, (s) => ({ ...s, layers: s.layers.map((l) => (l.id === lid ? { ...l, ...ch } : l)) })));
  const setChroma = (ch, hist) => setLayer(layerId, { chroma: { ...layer.chroma, ...ch } }, hist);
  const setSrc = (id, ch, hist) => (hist ? edit : patch)((p) => ({ ...p, sources: p.sources.map((s) => (s.id === id ? { ...s, ...ch } : s)) }));
  const sceneLabel = (s) => (typeof s.name === 'number' ? `${t('scene')} ${s.name}` : s.name);

  const makeLayer = (sourceId, type) => {
    const l = { id: uid('lyr'), sourceId, x: 0, y: 0, w: 1, h: 1, visible: true, chroma: { on: false, color: '#00ff00', tol: 90, soft: 60 } };
    if (type === 'title') Object.assign(l, { x: 0.05, y: 0.76, w: 0.9, h: 0.18 });
    return l;
  };
  const addSource = async (type, opts = {}) => {
    try {
      audioBus().ctx.resume();
      const id = uid('src');
      const { hasAudio } = await createMedia(id, type, opts);
      const l = makeLayer(id, type);
      const name = opts.name || (type === 'title' ? opts.text : t(type));
      const src = { id, type, name, hasAudio, gain: 100, muted: false };
      if (opts.text) src.text = opts.text;
      if (opts.path) src.path = opts.path;
      edit((p) => ({ ...mapScene(p, previewScene.id, (s) => ({ ...s, layers: [...s.layers, l] })), sources: [...p.sources, src] }));
      setLayerId(l.id);
    } catch (e) { toast(`${t('err')}: ${e.message}`); }
  };
  const pickFile = (type) => (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) addSource(type, { file: f, name: f.name, path: desktop ? window.lightcast.pathForFile(f) : null });
  };
  const reuseSource = (src) => {
    const l = makeLayer(src.id, src.type);
    edit((p) => mapScene(p, previewScene.id, (s) => ({ ...s, layers: [...s.layers, l] })));
    setLayerId(l.id); setSrcTab('layers');
  };
  const delLayer = () => { edit((p) => mapScene(p, previewScene.id, (s) => ({ ...s, layers: s.layers.filter((l) => l.id !== layerId) }))); setLayerId(null); };
  const moveLayer = (d) => edit((p) => mapScene(p, previewScene.id, (s) => {
    const a = [...s.layers]; const i = a.findIndex((l) => l.id === layerId); const j = i + d;
    if (i < 0 || j < 0 || j >= a.length) return s;
    [a[i], a[j]] = [a[j], a[i]]; return { ...s, layers: a };
  }));
  const addScene = () => {
    const n = Math.max(0, ...project.scenes.map((s) => (typeof s.name === 'number' ? s.name : 0))) + 1;
    const s = { id: uid('scn'), name: n, layers: [] };
    edit((p) => ({ ...p, scenes: [...p.scenes, s] })); setPreviewId(s.id); setLayerId(null);
  };
  const delScene = (id) => { if (project.scenes.length > 1) edit((p) => ({ ...p, scenes: p.scenes.filter((s) => s.id !== id) })); };
  const commitRename = () => {
    if (renaming && renaming.value.trim()) edit((p) => mapScene(p, renaming.id, (s) => ({ ...s, name: renaming.value.trim() })));
    setRenaming(null);
  };

  // ---- switching ----
  const swap = (dur) => {
    if (previewId === programId) return;
    trans.current = dur ? { from: programId, to: previewId, type: transType, t0: performance.now(), dur } : null;
    setProgramId(previewId); setPreviewId(programId); setLayerId(null); setTbar(0);
  };
  const cut = () => swap(0);
  const auto = () => swap(transDur);
  const onTbar = (v) => {
    if (previewId === programId) return;
    if (v >= 100) { swap(0); return; }
    setTbar(v);
    trans.current = v <= 0 ? null : { from: programId, to: previewId, type: transType, manual: true, p: v / 100 };
  };
  const quickProgram = (id) => {
    if (id === programId) return;
    trans.current = null; setPreviewId(programId); setProgramId(id); setLayerId(null); setTbar(0);
  };
  const pick = (i) => { const s = project.scenes[i]; if (s) { setPreviewId(s.id); setLayerId(null); } };
  const toggleOverlay = (id) => setOverlays((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const tileRef = (id) => (el) => { if (el) tiles.current.set(id, el.getContext('2d')); else tiles.current.delete(id); };

  // ---- preview: move / resize ----
  const onDown = (e) => {
    const r = screenRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const hit = [...previewScene.layers].reverse().find((l) => l.visible && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h);
    if (!hit) { setLayerId(null); return; }
    setLayerId(hit.id);
    drag.current = { mode: 'move', id: hit.id, x, y, lx: hit.x, ly: hit.y, r, started: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleDown = (e) => {
    e.stopPropagation();
    const r = screenRef.current.getBoundingClientRect();
    drag.current = { mode: 'resize', id: layer.id, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, lw: layer.w, lh: layer.h, r, started: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const x = (e.clientX - d.r.left) / d.r.width, y = (e.clientY - d.r.top) / d.r.height;
    if (!d.started) { if (Math.abs(x - d.x) + Math.abs(y - d.y) < 0.004) return; checkpoint(); d.started = true; }
    if (d.mode === 'resize') setLayer(d.id, { w: Math.max(0.05, d.lw + (x - d.x)), h: Math.max(0.05, d.lh + (y - d.y)) }, false);
    else setLayer(d.id, { x: d.lx + (x - d.x), y: d.ly + (y - d.y) }, false);
  };
  const onUp = () => { drag.current = null; };

  // ---- projects ----
  const needApp = () => { toast(t('onlyApp')); };
  const loadProject = async (text, path) => {
    let d;
    try { d = JSON.parse(text); if (d.app !== 'LightCast' || !d.project || !d.project.scenes) throw new Error('bad'); } catch { toast(t('badFile')); return; }
    toast(t('loading'));
    clearMedia(); trans.current = null;
    const missing = []; const sources = [];
    for (const s of d.project.sources || []) {
      try {
        let r;
        if (s.type === 'video' || s.type === 'image') {
          if (!s.path || !desktop) throw new Error('nopath');
          const bytes = await window.lightcast.readFile(s.path);
          const ext = s.path.split('.').pop().toLowerCase();
          r = await createMedia(s.id, s.type, { file: new Blob([bytes], { type: MIME_BY_EXT[ext] || '' }) });
        } else if (s.type === 'title') r = await createMedia(s.id, 'title', { text: s.text || s.name });
        else r = await createMedia(s.id, s.type);
        sources.push({ ...s, hasAudio: r.hasAudio });
      } catch { missing.push(s.name); sources.push({ ...s, hasAudio: false }); }
    }
    const proj = { scenes: d.project.scenes, sources };
    const ids = proj.scenes.map((s) => s.id);
    dispatch({ type: 'load', present: proj });
    setSavedProj(proj);
    setProgramId(ids.includes(d.programId) ? d.programId : ids[0]);
    setPreviewId(ids.includes(d.previewId) ? d.previewId : ids[0]);
    setOverlays((d.overlays || []).filter((id) => ids.includes(id)));
    if (d.transType) setTransType(d.transType);
    if (d.transDur) setTransDur(d.transDur);
    setLayerId(null); setTbar(0); fileRef.current = path;
    toast(missing.length ? `${t('loaded')} — ${t('missing')}: ${missing.join('، ')}` : t('loaded'));
  };
  const newProject = () => {
    if (dirty && !window.confirm(t('discard'))) return;
    clearMedia(); trans.current = null;
    const proj = initialProject();
    dispatch({ type: 'load', present: proj }); setSavedProj(proj);
    setProgramId(proj.scenes[0].id); setPreviewId(proj.scenes[0].id);
    setOverlays([]); setLayerId(null); setTbar(0); fileRef.current = null;
  };
  const openProject = async () => {
    if (!desktop) return needApp();
    if (dirty && !window.confirm(t('discard'))) return;
    const r = await window.lightcast.openProject();
    if (r) await loadProject(r.text, r.path);
  };
  const saveProject = async (asNew) => {
    if (!desktop) return needApp();
    const r = await window.lightcast.saveProject(snapshot(), asNew ? null : fileRef.current);
    if (r && r.ok) { fileRef.current = r.path; setSavedProj(project); toast(`${t('saved')}: ${r.path}`); }
  };
  const recoverProject = async () => {
    if (!desktop) return needApp();
    const text = await window.lightcast.loadAutosave();
    if (!text) return toast(t('noAutosave'));
    await loadProject(text, null);
  };

  // ---- output: record, stream, screenshot ----
  const outStream = () => new MediaStream([
    ...outRef.current.captureStream(settings.fps).getVideoTracks(),
    ...audioBus().dest.stream.getAudioTracks(),
  ]);
  const startRec = () => {
    if (!desktop) return needApp();
    audioBus().ctx.resume();
    const chunks = [];
    const mr = new MediaRecorder(outStream(), { mimeType: MIME, videoBitsPerSecond: settings.recKbps * 1000 });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
      const r = await window.lightcast.saveRecording(buf);
      toast(r && r.ok ? `${t('saved')}: ${r.path}` : t('notSaved'));
    };
    mr.start(1000); recRef.current = mr; setRecStart(Date.now()); setNow(Date.now());
  };
  const stopRec = () => { if (recRef.current) recRef.current.stop(); recRef.current = null; setRecStart(null); };
  const toggleRec = () => (recRef.current ? stopRec() : startRec());
  const startLive = async () => {
    const urls = OUTPUTS.filter((o) => (keys[o.id] || '').trim()).map((o) => o.base + keys[o.id].trim());
    if (!urls.length) return toast(t('needKey'));
    audioBus().ctx.resume();
    const r = await window.lightcast.startStream(urls, settings.streamKbps);
    if (!r.ok) return toast(r.error);
    const mr = new MediaRecorder(outStream(), { mimeType: MIME, videoBitsPerSecond: Math.round(settings.streamKbps * 1300) });
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      queue.current = queue.current.then(() => e.data.arrayBuffer()).then((b) => window.lightcast.sendChunk(b));
    };
    mr.start(250); liveRef.current = mr; setOnAir(true); setLiveStart(Date.now()); setNow(Date.now()); setDialog(null);
  };
  const stopLive = () => { if (liveRef.current) liveRef.current.stop(); liveRef.current = null; window.lightcast.stopStream(); setOnAir(false); setLiveStart(null); };
  const toggleLive = () => { if (!desktop) return needApp(); if (onAir) stopLive(); else setDialog('stream'); };
  const shot = () => {
    outRef.current.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `LightCast-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.png`;
      a.click();
    });
  };

  // ---- keyboard ----
  const act = useRef({});
  act.current = { cut, auto, undo, redo, toggleRec, newProject, openProject, saveProject, pick };
  useEffect(() => {
    const onKey = (e) => {
      const A = act.current;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = (tag === 'input' && !['range', 'checkbox'].includes(e.target.type)) || tag === 'textarea' || tag === 'select';
      const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
      if (mod && k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) A.redo(); else A.undo(); }
      else if (mod && k === 'y' && !typing) { e.preventDefault(); A.redo(); }
      else if (mod && k === 's') { e.preventDefault(); A.saveProject(e.shiftKey); }
      else if (mod && k === 'o') { e.preventDefault(); A.openProject(); }
      else if (mod && k === 'n') { e.preventDefault(); A.newProject(); }
      else if (e.key === 'F9') { e.preventDefault(); A.toggleRec(); }
      else if (!typing && !mod && e.key === ' ') { e.preventDefault(); A.cut(); }
      else if (!typing && !mod && e.key === 'Enter' && tag !== 'button') A.auto();
      else if (!typing && !mod && /^[1-9]$/.test(e.key)) A.pick(Number(e.key) - 1);
      else if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pct = (v) => v * 100;
  const sel = layer && { left: `${pct(layer.x)}%`, top: `${pct(layer.y)}%`, width: `${pct(layer.w)}%`, height: `${pct(layer.h)}%` };
  const recSecs = recStart ? Math.floor((now - recStart) / 1000) : 0;
  const liveSecs = liveStart ? Math.floor((now - liveStart) / 1000) : 0;
  const menus = [
    { id: 'file', label: t('mFile'), items: [
      { label: t('new'), hint: 'Ctrl+N', run: newProject },
      { label: t('open'), hint: 'Ctrl+O', run: openProject },
      { sep: true },
      { label: t('save'), hint: 'Ctrl+S', run: () => saveProject(false) },
      { label: t('saveAs'), hint: 'Ctrl+Shift+S', run: () => saveProject(true) },
      { sep: true },
      { label: t('recover'), run: recoverProject },
      { label: t('shot'), run: shot },
    ] },
    { id: 'edit', label: t('mEdit'), items: [
      { label: t('undo'), hint: 'Ctrl+Z', run: undo, disabled: !h.past.length },
      { label: t('redo'), hint: 'Ctrl+Shift+Z', run: redo, disabled: !h.future.length },
      { sep: true },
      { label: t('addScene'), run: addScene },
      { label: t('delScene'), run: () => delScene(previewId), disabled: project.scenes.length < 2 },
    ] },
    { id: 'view', label: t('mView'), items: [
      { label: t('language'), run: () => setSettings({ lang: lang === 'ar' ? 'en' : 'ar' }) },
      ...Object.keys(ACCENTS).map((k) => ({ label: `${settings.accent === k ? '● ' : '○ '}${t('accent')}: ${k}`, run: () => setSettings({ accent: k }) })),
      { sep: true },
      { label: t('settings'), run: () => setDialog('settings') },
    ] },
    { id: 'help', label: t('mHelp'), items: [
      { label: t('shortcuts'), run: () => setDialog('keys') },
      { label: t('about'), run: () => setDialog('about') },
    ] },
  ];

  const sceneIndex = (id) => project.scenes.findIndex((s) => s.id === id) + 1;

  return (
    <div className={`app ${onAir ? 'is-live' : ''}`} dir="ltr" lang={lang} style={{ '--accent': ACCENTS[settings.accent] || ACCENTS.amber }}>
      {/* ---------- menu bar ---------- */}
      <header className="menubar">
        <div className="brand"><i className="mark" /><span>LightCast <b>Studio</b></span></div>
        <nav className="menus">
          {menus.map((m) => (
            <div className="menu" key={m.id}>
              <button className={menu === m.id ? 'on' : ''} onClick={() => setMenu(menu === m.id ? null : m.id)}
                onMouseEnter={() => menu && setMenu(m.id)}>{m.label}</button>
              {menu === m.id && (
                <ul className="drop">
                  {m.items.map((it, i) => (it.sep ? <li key={i} className="sep" /> : (
                    <li key={i}><button disabled={it.disabled} onClick={() => { setMenu(null); it.run(); }}>
                      <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}</button></li>
                  )))}
                </ul>
              )}
            </div>
          ))}
        </nav>
        <div className="projname" title={fileRef.current || ''}>{projName}{dirty && <em title={t('unsaved')}> ●</em>}</div>
        <div className="head-actions">
          <button onClick={undo} disabled={!h.past.length} title="Ctrl+Z">↶ {t('undo')} <small>{h.past.length}</small></button>
          <button onClick={redo} disabled={!h.future.length} title="Ctrl+Shift+Z">↷ {t('redo')}</button>
        </div>
      </header>
      {menu && <div className="backdrop" onClick={() => setMenu(null)} />}

      {/* ---------- monitors ---------- */}
      <main className="stage">
        <div className="monitors">
          <figure className="mon pvw">
            <figcaption><span className="tag">{t('preview')}</span><small>{sceneLabel(previewScene)}</small></figcaption>
            <div className="screen" ref={screenRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
              <canvas ref={prevRef} width={W} height={H} />
              {sel && <div className="sel" style={sel}><div className="handle" onPointerDown={onHandleDown} onPointerMove={onMove} onPointerUp={onUp} /></div>}
            </div>
          </figure>

          <div className="mid">
            <button className="take cut" onClick={cut}>{t('cut')}<kbd>Space</kbd></button>
            <button className="take auto" onClick={auto}>{t('auto')}<kbd>Enter</kbd></button>
            <div className="fx">
              {Object.keys(FX).map((k) => (
                <button key={k} className={transType === k ? 'on' : ''} onClick={() => setTransType(k)} title={t(`tr_${k}`)}>{FX[k]}</button>
              ))}
            </div>
            <small className="fxname">{t(`tr_${transType}`)}</small>
            <select value={transDur} onChange={(e) => setTransDur(Number(e.target.value))}>
              {[300, 600, 1000, 1500].map((d) => <option key={d} value={d}>{d / 1000}s</option>)}
            </select>
            <div className="tbarv"><input type="range" min={0} max={100} value={tbar} onChange={(e) => onTbar(Number(e.target.value))} /></div>
            <button className={`take ftb ${ftb ? 'on' : ''}`} onClick={() => setFtb(!ftb)}>{t('ftb')}</button>
          </div>

          <figure className="mon pgm">
            <figcaption><span className="tag">{t('program')}</span><small>{sceneLabel(project.scenes.find((s) => s.id === programId) || project.scenes[0])}</small>
              {onAir && <span className="airbadge">● {t('onAir')} {fmt(liveSecs)}</span>}</figcaption>
            <div className="screen">
              <canvas ref={outRef} width={W} height={H} />
              {project.sources.length === 0 && (
                <div className="welcome"><i className="mark big" /><b>LightCast Studio</b><span>{t('welcome')}</span></div>
              )}
            </div>
          </figure>
        </div>

        {/* ---------- scene strip (multiview) ---------- */}
        <div className="inputs">
          <div className="inputs-head"><h3>{t('scenes')}</h3><small>{t('multiview')}</small></div>
          <div className="tiles">
            {project.scenes.map((s) => (
              <div key={s.id} className={`tile ${s.id === previewId ? 'pvw' : ''} ${s.id === programId ? 'pgm' : ''}`}>
                <div className="thumb">
                  <canvas ref={tileRef(s.id)} width={320} height={180}
                    onClick={() => { setPreviewId(s.id); setLayerId(null); }} onDoubleClick={() => quickProgram(s.id)} />
                  <span className="num">{sceneIndex(s.id)}</span>
                </div>
                <div className="trow">
                  {renaming && renaming.id === s.id ? (
                    <input autoFocus value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onBlur={commitRename} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : (
                    <span className="nm" title={t('rename')} onDoubleClick={() => setRenaming({ id: s.id, value: typeof s.name === 'number' ? `${t('scene')} ${s.name}` : s.name })}>{sceneLabel(s)}</span>
                  )}
                  <button onClick={() => quickProgram(s.id)} title={t('take')}>▶</button>
                  <button className={overlays.includes(s.id) ? 'on' : ''} onClick={() => toggleOverlay(s.id)} title={t('overlay')}>OL</button>
                  {project.scenes.length > 1 && <button onClick={() => delScene(s.id)} title={t('del')}>×</button>}
                </div>
              </div>
            ))}
            <button className="addscene" onClick={addScene}><span>+</span>{t('newScene')}</button>
          </div>
        </div>

        {/* ---------- docks (OBS style) ---------- */}
        <div className="docks">
          <section className="dock">
            <header><h3>{t('sources')}</h3>
              <div className="tabs">
                <button className={srcTab === 'layers' ? 'on' : ''} onClick={() => setSrcTab('layers')}>{t('layers')}</button>
                <button className={srcTab === 'library' ? 'on' : ''} onClick={() => setSrcTab('library')}>{t('library')}</button>
              </div>
            </header>
            <div className="dbody">
              {srcTab === 'layers' ? (
                previewScene.layers.length === 0 ? <p className="muted">{t('noLayers')}</p> : (
                  <ul className="list">
                    {[...previewScene.layers].reverse().map((l) => {
                      const src = project.sources.find((s) => s.id === l.sourceId);
                      return (
                        <li key={l.id} className={l.id === layerId ? 'sel' : ''} onClick={() => setLayerId(l.id)}>
                          <button className="eye" onClick={(e) => { e.stopPropagation(); setLayer(l.id, { visible: !l.visible }, true); }}>{l.visible ? '◉' : '○'}</button>
                          <span className="nm">{src ? src.name : '?'}</span><em>{src ? t(src.type) : ''}</em>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : (
                project.sources.length === 0 ? <p className="muted">{t('noLibrary')}</p> : (
                  <ul className="list">
                    {project.sources.map((s) => (
                      <li key={s.id} onClick={() => reuseSource(s)}><span className="nm">{s.name}</span><em>{t(s.type)}</em></li>
                    ))}
                  </ul>
                )
              )}
            </div>
            <footer className="adders">
              <button onClick={() => addSource('camera')}>{t('camera')}</button>
              <button onClick={() => addSource('screen')}>{t('screen')}</button>
              <button onClick={() => videoIn.current.click()}>{t('video')}</button>
              <button onClick={() => imageIn.current.click()}>{t('image')}</button>
              <form onSubmit={(e) => { e.preventDefault(); if (titleText.trim()) { addSource('title', { text: titleText.trim() }); setTitleText(''); } }}>
                <input value={titleText} onChange={(e) => setTitleText(e.target.value)} placeholder={t('titlePh')} />
                <button type="submit">{t('add')}</button>
              </form>
            </footer>
            <input ref={videoIn} type="file" accept="video/*" hidden onChange={pickFile('video')} />
            <input ref={imageIn} type="file" accept="image/*" hidden onChange={pickFile('image')} />
          </section>

          <section className="dock">
            <header><h3>{t('props')}</h3></header>
            <div className="dbody">
              {!layer ? <p className="muted">{t('noLayer')}</p> : (
                <div className="props">
                  <div className="two">
                    {['x', 'y', 'w', 'h'].map((k) => (
                      <Slider key={k} label={t(k)} value={pct(layer[k])} onStart={checkpoint} onChange={(v) => setLayer(layer.id, { [k]: v / 100 }, false)} />
                    ))}
                  </div>
                  <div className="row">
                    <button onClick={() => moveLayer(1)}>{t('up')}</button>
                    <button onClick={() => moveLayer(-1)}>{t('down')}</button>
                    <button className="danger" onClick={delLayer}>{t('del')}</button>
                  </div>
                  <label className="check"><input type="checkbox" checked={layer.chroma.on} onChange={(e) => setChroma({ on: e.target.checked }, true)} /> {t('chroma')}</label>
                  {layer.chroma.on && (
                    <div className="two">
                      <label className="check">{t('color')} <input type="color" value={layer.chroma.color} onChange={(e) => setChroma({ color: e.target.value }, true)} /></label>
                      <span />
                      <Slider label={t('tol')} value={layer.chroma.tol} max={255} onStart={checkpoint} onChange={(v) => setChroma({ tol: v }, false)} />
                      <Slider label={t('soft')} value={layer.chroma.soft} max={255} onStart={checkpoint} onChange={(v) => setChroma({ soft: v }, false)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="dock wide">
            <header><h3>{t('audio')}</h3></header>
            <div className="dbody">
              {project.sources.filter((s) => s.hasAudio).length === 0 && <p className="muted">{t('noAudio')}</p>}
              {project.sources.filter((s) => s.hasAudio).map((s) => (
                <AudioRow key={s.id} name={s.name} an={audio.get(s.id) && audio.get(s.id).an} value={s.gain} muted={s.muted} muteLabel={t('mute')}
                  onStart={checkpoint} onChange={(v) => setSrc(s.id, { gain: v }, false)} onMute={() => setSrc(s.id, { muted: !s.muted }, true)} />
              ))}
              <AudioRow master name={t('master')} an={audioBus().an} value={masterVol} onStart={() => {}} onChange={setMasterVol}
                extra={<button className={`mute ${monitor ? 'on' : ''}`} onClick={() => setMon(!monitor)} title={t('monitor')}>🎧</button>} />
            </div>
          </section>

          <section className="dock narrow">
            <header><h3>{t('controls')}</h3></header>
            <div className="dbody ctls">
              <button className={`ctl ${onAir ? 'air' : ''}`} onClick={toggleLive}>{onAir ? `■ ${t('stopLive')}` : `● ${t('startLive')}`}</button>
              <button className={`ctl ${recStart ? 'rec' : ''}`} onClick={toggleRec}>{recStart ? `■ ${t('stopRec')} ${fmt(recSecs)}` : `● ${t('startRec')}`}</button>
              <button className="ctl" onClick={shot}>{t('shot')}</button>
              <button className="ctl" onClick={() => setDialog('settings')}>{t('settings')}</button>
            </div>
          </section>
        </div>
      </main>

      {/* ---------- status bar ---------- */}
      <footer className="statusbar">
        <span className={`pill ${onAir ? 'air' : ''}`}>● {onAir ? `${t('onAir')} ${fmt(liveSecs)}` : 'OFF'}</span>
        <span className={`pill ${recStart ? 'rec' : ''}`}>● {recStart ? `${t('rec')} ${fmt(recSecs)}` : 'REC'}</span>
        <span>{fps} FPS</span><span>{W}×{H}</span>
        <span>{settings.streamKbps} kbps</span>
        <span className="msg">{msg}</span>
        <span className="hintline">Space = {t('cut')} · Enter = {t('auto')} · Ctrl+S</span>
      </footer>

      {/* ---------- dialogs ---------- */}
      {dialog && (
        <div className="modal" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            {dialog === 'stream' && (<>
              <h2>{t('streamTo')}</h2>
              {OUTPUTS.map((o) => (
                <label key={o.id} className="field"><span>{o.name}</span>
                  <input dir="ltr" type="password" placeholder={o.full ? t('fullUrl') : t('key')}
                    value={keys[o.id] || ''} onChange={(e) => setKeys({ ...keys, [o.id]: e.target.value })} /></label>
              ))}
              <div className="row"><button className="primary" onClick={startLive}>{t('start')}</button><button onClick={() => setDialog(null)}>{t('cancel')}</button></div>
            </>)}
            {dialog === 'settings' && (<>
              <h2>{t('settings')}</h2>
              <div className="field"><span>{t('accent')}</span>
                <div className="swatches">{Object.keys(ACCENTS).map((k) => (
                  <button key={k} className={settings.accent === k ? 'on' : ''} style={{ background: ACCENTS[k] }} onClick={() => setSettings({ accent: k })} title={k} />
                ))}</div></div>
              <label className="field"><span>{t('fpsLabel')}</span>
                <select value={settings.fps} onChange={(e) => setSettings({ fps: Number(e.target.value) })}>{[24, 30, 60].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <label className="field"><span>{t('kbpsStream')}</span>
                <select value={settings.streamKbps} onChange={(e) => setSettings({ streamKbps: Number(e.target.value) })}>{[1500, 2500, 3000, 4500, 6000].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <label className="field"><span>{t('kbpsRec')}</span>
                <select value={settings.recKbps} onChange={(e) => setSettings({ recKbps: Number(e.target.value) })}>{[3000, 5000, 8000, 12000].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <div className="row"><button className="primary" onClick={() => setDialog(null)}>{t('close')}</button></div>
            </>)}
            {dialog === 'keys' && (<>
              <h2>{t('shortcuts')}</h2>
              <table className="keys"><tbody>
                <tr><td><kbd>Space</kbd></td><td>{t('k1')}</td></tr>
                <tr><td><kbd>Enter</kbd></td><td>{t('k2')}</td></tr>
                <tr><td><kbd>Ctrl/⌘ Z</kbd> · <kbd>⇧</kbd></td><td>{t('k3')}</td></tr>
                <tr><td><kbd>F9</kbd></td><td>{t('k4')}</td></tr>
                <tr><td><kbd>1 – 9</kbd></td><td>{t('k5')}</td></tr>
                <tr><td><kbd>Ctrl/⌘ N · O · S</kbd></td><td>{t('k6')}</td></tr>
              </tbody></table>
              <div className="row"><button className="primary" onClick={() => setDialog(null)}>{t('close')}</button></div>
            </>)}
            {dialog === 'about' && (<>
              <div className="aboutlogo"><i className="mark big" /><b>LightCast Studio</b></div>
              <p>{t('aboutText')}</p>
              <div className="row"><button className="primary" onClick={() => setDialog(null)}>{t('close')}</button></div>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}
