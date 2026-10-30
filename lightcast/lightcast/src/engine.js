export const W = 1280;
export const H = 720;
export const media = new Map(); // sourceId -> { el, stream? }

let bus;
export const audio = new Map(); // sourceId -> { gain, an }
export function audioBus() {
  if (!bus) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    const dest = ctx.createMediaStreamDestination();
    master.connect(an); master.connect(dest);
    bus = { ctx, dest, master, an, monitoring: false };
  }
  return bus;
}
function route(id, node) {
  const a = audioBus();
  const gain = a.ctx.createGain();
  const an = a.ctx.createAnalyser(); an.fftSize = 1024;
  node.connect(gain); gain.connect(an); gain.connect(a.master);
  audio.set(id, { gain, an });
}
export function setSourceGain(id, v) { const n = audio.get(id); if (n) n.gain.gain.value = v; }
export function setMonitor(on) {
  const a = audioBus();
  if (on && !a.monitoring) a.master.connect(a.ctx.destination);
  if (!on && a.monitoring) a.master.disconnect(a.ctx.destination);
  a.monitoring = on;
}
// 0..1 meter value from an analyser (-60 dB .. 0 dB)
export function level(an) {
  if (!an) return 0;
  if (!an._buf) an._buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(an._buf);
  let sum = 0;
  for (let i = 0; i < an._buf.length; i++) sum += an._buf[i] * an._buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / an._buf.length) || 1e-6);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export function clearMedia() {
  media.forEach((m) => {
    if (m.stream) m.stream.getTracks().forEach((t) => t.stop());
    try { if (m.el.pause) m.el.pause(); } catch {}
  });
  media.clear();
  audio.forEach((n) => { try { n.gain.disconnect(); n.an.disconnect(); } catch {} });
  audio.clear();
}

export function makeTitle(text) {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 220;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(18,24,38,0.88)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#f2b134';
  g.fillRect(0, 0, 14, c.height);
  g.fillStyle = '#ffffff';
  g.font = '600 84px "Segoe UI", Tahoma, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2, c.width - 120);
  return c;
}

export async function createMedia(id, type, opts = {}) {
  let hasAudio = false;
  if (type === 'camera' || type === 'screen') {
    let stream;
    if (type === 'camera') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      }
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    const el = document.createElement('video');
    el.srcObject = stream; el.muted = true; el.playsInline = true;
    await el.play();
    if (stream.getAudioTracks().length) {
      route(id, audioBus().ctx.createMediaStreamSource(stream));
      hasAudio = true;
    }
    media.set(id, { el, stream });
  } else if (type === 'video') {
    const el = document.createElement('video');
    el.src = URL.createObjectURL(opts.file); el.loop = true; el.playsInline = true;
    await el.play();
    route(id, audioBus().ctx.createMediaElementSource(el)); // silent locally unless monitoring
    hasAudio = true;
    media.set(id, { el });
  } else if (type === 'image') {
    const el = new Image();
    el.src = URL.createObjectURL(opts.file);
    await el.decode();
    media.set(id, { el });
  } else if (type === 'title') {
    media.set(id, { el: makeTitle(opts.text) });
  }
  return { hasAudio };
}

const dims = (el) => [el.videoWidth || el.naturalWidth || el.width, el.videoHeight || el.naturalHeight || el.height];
const contain = (sw, sh, x, y, w, h) => {
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  return [x + (w - dw) / 2, y + (h - dh) / 2, dw, dh];
};
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d', { willReadFrequently: true });

export function drawScene(ctx, scene, alpha = 1) {
  if (!scene || alpha <= 0) return;
  for (const l of scene.layers) {
    if (!l.visible) continue;
    const m = media.get(l.sourceId);
    if (!m) continue;
    const [sw, sh] = dims(m.el);
    if (!sw || !sh) continue;
    const [dx, dy, dw, dh] = contain(sw, sh, l.x * W, l.y * H, l.w * W, l.h * H);
    ctx.globalAlpha = alpha;
    if (l.chroma && l.chroma.on) {
      const k = Math.min(1, 640 / dw);
      const cw = Math.max(2, Math.round(dw * k)), ch = Math.max(2, Math.round(dh * k));
      scratch.width = cw; scratch.height = ch;
      sctx.drawImage(m.el, 0, 0, cw, ch);
      const img = sctx.getImageData(0, 0, cw, ch);
      const d = img.data;
      const [kr, kg, kb] = hexRgb(l.chroma.color);
      const tol = l.chroma.tol, soft = Math.max(1, l.chroma.soft);
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        const a = dist <= tol ? 0 : dist >= tol + soft ? 1 : (dist - tol) / soft;
        d[i + 3] = d[i + 3] * a;
      }
      sctx.putImageData(img, 0, 0);
      ctx.drawImage(scratch, dx, dy, dw, dh);
    } else {
      ctx.drawImage(m.el, dx, dy, dw, dh);
    }
  }
  ctx.globalAlpha = 1;
}

const ease = (p) => p * p * (3 - 2 * p);
export function drawTransition(ctx, from, to, type, raw) {
  const p = ease(raw);
  if (type === 'wipe') {
    drawScene(ctx, from, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip(); drawScene(ctx, to, 1); ctx.restore();
  } else if (type === 'slide') {
    ctx.save(); ctx.translate(-W * p, 0); drawScene(ctx, from, 1); ctx.restore();
    ctx.save(); ctx.translate(W * (1 - p), 0); drawScene(ctx, to, 1); ctx.restore();
  } else if (type === 'dip') {
    drawScene(ctx, p < 0.5 ? from : to, 1);
    ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  } else {
    drawScene(ctx, from, 1); drawScene(ctx, to, p);
  }
}
