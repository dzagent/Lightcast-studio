import React, { useReducer, useRef, useState, useEffect } from 'react';
import { historyReducer, initialProject, uid } from './store.js';
import { W, H, createMedia, drawScene, audioBus } from './engine.js';
import { T } from './i18n.js';

const OUTPUTS = [
  { id: 'youtube', name: 'YouTube', base: 'rtmp://a.rtmp.youtube.com/live2/' },
  { id: 'twitch', name: 'Twitch', base: 'rtmp://live.twitch.tv/app/' },
  { id: 'facebook', name: 'Facebook', base: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  { id: 'custom', name: 'RTMP', base: '', full: true },
];
const MIME = 'video/webm;codecs=vp8,opus';
const fmt = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')).join(':');

function Slider({ label, value, min = 0, max = 100, onStart, onChange }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value}
        onPointerDown={onStart} onKeyDown={onStart}
        onChange={(e) => onChange(Number(e.target.value))} />
      <output>{Math.round(value)}</output>
    </label>
  );
}

export default function App() {
  const [h, dispatch] = useReducer(historyReducer, null, () => ({ past: [], present: initialProject(), future: [] }));
  const project = h.present;
  const [lang, setLang] = useState('ar');
  const t = (k) => T[lang][k] || k;
  const [programId, setProgramId] = useState(project.scenes[0].id);
  const [previewId, setPreviewId] = useState(project.scenes[0].id);
  const [overlays, setOverlays] = useState([]);
  const [ftb, setFtb] = useState(false);
  const [layerId, setLayerId] = useState(null);
  const [titleText, setTitleText] = useState('');
  const [recStart, setRecStart] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [onAir, setOnAir] = useState(false);
  const [showStream, setShowStream] = useState(false);
  const [keys, setKeys] = useState({});
  const [msg, setMsg] = useState('');

  const L = useRef({});
  L.current = { project, programId, previewId, overlays, ftb };
  const trans = useRef(null);
  const ftbLevel = useRef(0);
  const outRef = useRef(null);
  const prevRef = useRef(null);
  const recRef = useRef(null);
  const liveRef = useRef(null);
  const queue = useRef(Promise.resolve());
  const drag = useRef(null);
  const videoIn = useRef(null);
  const imageIn = useRef(null);
  const desktop = typeof window !== 'undefined' && !!window.lightcast;

  // ---- render loop: Program output + Preview monitor ----
  useEffect(() => {
    const out = outRef.current.getContext('2d');
    const prev = prevRef.current.getContext('2d');
    let raf;
    const frame = () => {
      const { project, programId, previewId, overlays, ftb } = L.current;
      const sc = (id) => project.scenes.find((s) => s.id === id);
      const now = performance.now();
      out.fillStyle = '#000'; out.fillRect(0, 0, W, H);
      const tr = trans.current;
      if (tr) {
        const p = Math.min(1, (now - tr.t0) / tr.dur);
        drawScene(out, sc(tr.from), 1);
        drawScene(out, sc(programId), p);
        if (p >= 1) trans.current = null;
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
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  // keep program/preview ids valid after undo/redo/delete
  useEffect(() => {
    const ids = project.scenes.map((s) => s.id);
    if (!ids.includes(programId)) setProgramId(ids[0]);
    if (!ids.includes(previewId)) setPreviewId(ids[0]);
    setOverlays((o) => o.filter((id) => ids.includes(id)));
  }, [project.scenes]);

  useEffect(() => {
    if (!recStart) return undefined;
    const i = setInterval(() => setElapsed(Math.floor((Date.now() - recStart) / 1000)), 500);
    return () => clearInterval(i);
  }, [recStart]);

  useEffect(() => {
    if (!desktop) return undefined;
    return window.lightcast.onStreamStatus((m) => {
      if (m.closed) {
        liveRef.current?.state !== 'inactive' && liveRef.current?.stop();
        liveRef.current = null; setOnAir(false);
        if (m.error) setMsg(m.error);
      } else if (m.log) setMsg(m.log);
    });
  }, [desktop]);

  // ---- project edits ----
  const edit = (fn) => dispatch({ type: 'edit', fn });
  const patch = (fn) => dispatch({ type: 'patch', fn });
  const checkpoint = () => dispatch({ type: 'checkpoint' });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const mapScene = (p, sid, f) => ({ ...p, scenes: p.scenes.map((s) => (s.id === sid ? f(s) : s)) });
  const previewScene = project.scenes.find((s) => s.id === previewId) || project.scenes[0];
  const layer = previewScene.layers.find((l) => l.id === layerId);
  const setLayer = (lid, ch, hist) =>
    (hist ? edit : patch)((p) => mapScene(p, previewId, (s) => ({ ...s, layers: s.layers.map((l) => (l.id === lid ? { ...l, ...ch } : l)) })));
  const setChroma = (ch, hist) => setLayer(layerId, { chroma: { ...layer.chroma, ...ch } }, hist);

  const addLayer = (sourceId, type) => {
    const l = { id: uid('lyr'), sourceId, x: 0, y: 0, w: 1, h: 1, visible: true, chroma: { on: false, color: '#00ff00', tol: 90, soft: 60 } };
    if (type === 'title') Object.assign(l, { x: 0.05, y: 0.76, w: 0.9, h: 0.18 });
    return l;
  };

  const addSource = async (type, opts = {}) => {
    try {
      audioBus().ctx.resume();
      const id = uid('src');
      await createMedia(id, type, opts);
      const l = addLayer(id, type);
      const name = opts.name || (type === 'title' ? opts.text : t(type));
      edit((p) => ({ ...mapScene(p, previewId, (s) => ({ ...s, layers: [...s.layers, l] })), sources: [...p.sources, { id, type, name }] }));
      setLayerId(l.id);
    } catch (e) { setMsg(`${t('err')}: ${e.message}`); }
  };
  const reuseSource = (src) => {
    const l = addLayer(src.id, src.type);
    edit((p) => mapScene(p, previewId, (s) => ({ ...s, layers: [...s.layers, l] })));
    setLayerId(l.id);
  };
  const delLayer = () => { edit((p) => mapScene(p, previewId, (s) => ({ ...s, layers: s.layers.filter((l) => l.id !== layerId) }))); setLayerId(null); };
  const moveLayer = (d) => edit((p) => mapScene(p, previewId, (s) => {
    const a = [...s.layers]; const i = a.findIndex((l) => l.id === layerId); const j = i + d;
    if (i < 0 || j < 0 || j >= a.length) return s;
    [a[i], a[j]] = [a[j], a[i]]; return { ...s, layers: a };
  }));
  const addScene = () => {
    const s = { id: uid('scn'), name: project.scenes.length + 1, layers: [] };
    edit((p) => ({ ...p, scenes: [...p.scenes, s] })); setPreviewId(s.id); setLayerId(null);
  };
  const delScene = (id) => {
    if (project.scenes.length < 2) return;
    edit((p) => ({ ...p, scenes: p.scenes.filter((s) => s.id !== id) }));
  };

  // ---- switching ----
  const swap = (dur) => {
    if (previewId === programId) return;
    trans.current = dur ? { from: programId, t0: performance.now(), dur } : null;
    setProgramId(previewId); setPreviewId(programId); setLayerId(null);
  };
  const cut = () => swap(0);
  const fade = () => swap(600);
  const toggleOverlay = (id) => setOverlays((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  // ---- preview drag ----
  const onDown = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const hit = [...previewScene.layers].reverse().find((l) => l.visible && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h);
    if (!hit) { setLayerId(null); return; }
    setLayerId(hit.id);
    drag.current = { id: hit.id, x, y, lx: hit.x, ly: hit.y, r, started: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const x = (e.clientX - d.r.left) / d.r.width, y = (e.clientY - d.r.top) / d.r.height;
    if (!d.started) { if (Math.abs(x - d.x) + Math.abs(y - d.y) < 0.004) return; checkpoint(); d.started = true; }
    setLayer(d.id, { x: d.lx + (x - d.x), y: d.ly + (y - d.y) }, false);
  };
  const onUp = () => { drag.current = null; };

  // ---- output: record & stream ----
  const outStream = () => new MediaStream([
    ...outRef.current.captureStream(30).getVideoTracks(),
    ...audioBus().dest.stream.getAudioTracks(),
  ]);
  const startRec = () => {
    if (!desktop) return setMsg(t('onlyApp'));
    audioBus().ctx.resume();
    const chunks = [];
    const mr = new MediaRecorder(outStream(), { mimeType: MIME, videoBitsPerSecond: 5e6 });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
      const r = await window.lightcast.saveRecording(buf);
      setMsg(r && r.ok ? `${t('saved')}: ${r.path}` : t('notSaved'));
    };
    mr.start(1000); recRef.current = mr; setRecStart(Date.now()); setElapsed(0);
  };
  const stopRec = () => { recRef.current?.stop(); recRef.current = null; setRecStart(null); };
  const toggleRec = () => (recRef.current ? stopRec() : startRec());

  const startLive = async () => {
    const urls = OUTPUTS.filter((o) => (keys[o.id] || '').trim()).map((o) => o.base + keys[o.id].trim());
    if (!urls.length) return setMsg(t('needKey'));
    audioBus().ctx.resume();
    const r = await window.lightcast.startStream(urls);
    if (!r.ok) return setMsg(r.error);
    const mr = new MediaRecorder(outStream(), { mimeType: MIME, videoBitsPerSecond: 3.5e6 });
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      queue.current = queue.current.then(() => e.data.arrayBuffer()).then((b) => window.lightcast.sendChunk(b));
    };
    mr.start(250); liveRef.current = mr; setOnAir(true); setShowStream(false);
  };
  const stopLive = () => { liveRef.current?.stop(); liveRef.current = null; window.lightcast.stopStream(); setOnAir(false); };

  // ---- keyboard ----
  const act = useRef({});
  act.current = { cut, fade, undo, redo, toggleRec };
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' && e.target.type !== 'range' || tag === 'textarea';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? act.current.redo() : act.current.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); act.current.redo(); }
      else if (e.key === 'F9') { e.preventDefault(); act.current.toggleRec(); }
      else if (!typing && !mod && e.key === ' ') { e.preventDefault(); act.current.cut(); }
      else if (!typing && !mod && e.key === 'Enter' && tag !== 'button') { act.current.fade(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pct = (v) => v * 100;
  const sel = layer && { left: `${pct(layer.x)}%`, top: `${pct(layer.y)}%`, width: `${pct(layer.w)}%`, height: `${pct(layer.h)}%` };

  return (
    <div className="app" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <header className="top">
        <div className="brand">LightCast <b>Studio</b></div>
        <div className="group">
          <button onClick={undo} disabled={!h.past.length} title="Ctrl+Z">↶ {t('undo')} <small>{h.past.length}</small></button>
          <button onClick={redo} disabled={!h.future.length} title="Ctrl+Shift+Z">↷ {t('redo')}</button>
        </div>
        <div className="group">
          <button className={recStart ? 'on rec' : ''} onClick={toggleRec} title="F9">
            <i className="dot" /> {recStart ? `${t('stopRec')} ${fmt(elapsed)}` : t('rec')}
          </button>
          <button className={onAir ? 'on air' : ''} onClick={() => (onAir ? stopLive() : desktop ? setShowStream(true) : setMsg(t('onlyApp')))}>
            {onAir ? t('stopLive') : t('live')}
          </button>
          <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'عربي'}</button>
        </div>
      </header>

      <main>
        <aside className="panel">
          <h2>{t('sources')}</h2>
          <div className="adders">
            <button onClick={() => addSource('camera')}>{t('camera')}</button>
            <button onClick={() => addSource('screen')}>{t('screen')}</button>
            <button onClick={() => videoIn.current.click()}>{t('video')}</button>
            <button onClick={() => imageIn.current.click()}>{t('image')}</button>
          </div>
          <input ref={videoIn} type="file" accept="video/*" hidden
            onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; f && addSource('video', { file: f, name: f.name }); }} />
          <input ref={imageIn} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; f && addSource('image', { file: f, name: f.name }); }} />
          <form className="titlebox" onSubmit={(e) => { e.preventDefault(); if (titleText.trim()) { addSource('title', { text: titleText.trim() }); setTitleText(''); } }}>
            <input value={titleText} onChange={(e) => setTitleText(e.target.value)} placeholder={t('titlePh')} />
            <button type="submit">{t('add')}</button>
          </form>
          <ul className="srclist">
            {project.sources.length === 0 && <li className="muted">{t('empty')}</li>}
            {project.sources.map((s) => (
              <li key={s.id}><button onClick={() => reuseSource(s)} title={s.name}><em>{t(s.type)}</em> {s.name}</button></li>
            ))}
          </ul>
        </aside>

        <section className="stage">
          <div className="monitors">
            <figure className="mon pvw">
              <figcaption>{t('preview')}</figcaption>
              <div className="screen" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                <canvas ref={prevRef} width={W} height={H} />
                {sel && <div className="sel" style={sel} />}
              </div>
            </figure>
            <figure className="mon pgm">
              <figcaption>{t('program')}</figcaption>
              <div className="screen"><canvas ref={outRef} width={W} height={H} /></div>
            </figure>
          </div>
          <div className="transport">
            <button className="big" onClick={cut}>{t('cut')}</button>
            <button className="big" onClick={fade}>{t('fade')}</button>
            <button className={`big ${ftb ? 'on' : ''}`} onClick={() => setFtb(!ftb)}>{t('ftb')}</button>
          </div>
          <div className="scenes">
            <h2>{t('scenes')}</h2>
            {project.scenes.map((s) => (
              <div key={s.id} className={`scene ${s.id === previewId ? 'pvw' : ''} ${s.id === programId ? 'pgm' : ''}`}>
                <button className="name" onClick={() => { setPreviewId(s.id); setLayerId(null); }}>{t('scene')} {s.name}</button>
                <button className={`ol ${overlays.includes(s.id) ? 'on' : ''}`} onClick={() => toggleOverlay(s.id)} title={t('overlay')}>{t('overlay')}</button>
                {project.scenes.length > 1 && <button className="x" onClick={() => delScene(s.id)} title={t('del')}>×</button>}
              </div>
            ))}
            <button className="addscene" onClick={addScene}>+ {t('newScene')}</button>
          </div>
          <p className="hint">{t('hint')}{msg && <span className="msg"> — {msg}</span>}</p>
        </section>

        <aside className="panel">
          <h2>{t('layer')}</h2>
          {!layer && <p className="muted">{t('noLayer')}</p>}
          {layer && (
            <div className="inspector">
              <label className="check"><input type="checkbox" checked={layer.visible} onChange={(e) => setLayer(layer.id, { visible: e.target.checked }, true)} /> {t('visible')}</label>
              {['x', 'y', 'w', 'h'].map((k) => (
                <Slider key={k} label={t(k)} value={pct(layer[k])} onStart={checkpoint}
                  onChange={(v) => setLayer(layer.id, { [k]: v / 100 }, false)} />
              ))}
              <div className="row">
                <button onClick={() => moveLayer(1)}>{t('up')}</button>
                <button onClick={() => moveLayer(-1)}>{t('down')}</button>
                <button className="danger" onClick={delLayer}>{t('del')}</button>
              </div>
              <label className="check"><input type="checkbox" checked={layer.chroma.on} onChange={(e) => setChroma({ on: e.target.checked }, true)} /> {t('chroma')}</label>
              {layer.chroma.on && (
                <>
                  <label className="check">{t('color')} <input type="color" value={layer.chroma.color} onChange={(e) => setChroma({ color: e.target.value }, true)} /></label>
                  <Slider label={t('tol')} value={layer.chroma.tol} max={255} onStart={checkpoint} onChange={(v) => setChroma({ tol: v }, false)} />
                  <Slider label={t('soft')} value={layer.chroma.soft} max={255} onStart={checkpoint} onChange={(v) => setChroma({ soft: v }, false)} />
                </>
              )}
            </div>
          )}
        </aside>
      </main>

      {showStream && (
        <div className="modal" onClick={() => setShowStream(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{t('streamTo')}</h2>
            {OUTPUTS.map((o) => (
              <label key={o.id} className="field">
                <span>{o.name}</span>
                <input dir="ltr" type="password" placeholder={o.full ? t('fullUrl') : t('key')}
                  value={keys[o.id] || ''} onChange={(e) => setKeys({ ...keys, [o.id]: e.target.value })} />
              </label>
            ))}
            <div className="row">
              <button className="primary" onClick={startLive}>{t('start')}</button>
              <button onClick={() => setShowStream(false)}>{t('cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
