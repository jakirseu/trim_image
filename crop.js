/* TrimImage — Crop tab.
 * An interactive selection over the image: drag to draw, drag inside to move,
 * drag any of the 8 handles to resize, optionally locked to an aspect ratio.
 * The selection lives in image pixel coordinates and is projected onto the
 * canvas as percentages, so it stays correct at any display scale.
 * Rotate/flip rewrite the working source; the original is kept for "New image". */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- Elements ----
  const dropzone  = $('crDropzone');
  const fileInput = $('crFileInput');
  const pickBtn   = $('crPickBtn');
  const editor    = $('crEditor');
  const wrap      = $('crWrap');
  const canvas    = $('crCanvas');
  const ctx       = canvas.getContext('2d');
  const selEl     = $('crSel');
  const resetBtn  = $('crResetBtn');
  const dimsLabel = $('crDimsLabel');
  const hintEl    = $('crHint');

  const ratioGrid = $('crRatios');
  const quickSeg  = $('crQuick');
  const inW = $('crW'), inH = $('crH'), inX = $('crX'), inY = $('crY');
  const srcDims = $('crSrcDims'), outDims = $('crOutDims'), keptEl = $('crKept');
  const formatSel = $('crFormat');
  const downloadBtn = $('crDownloadBtn'), copyBtn = $('crCopyBtn');
  const rotL = $('crRotL'), rotR = $('crRotR'), flipH = $('crFlipH'), flipV = $('crFlipV');

  const MIN = 8;                     // smallest selection, in image pixels

  // ---- State ----
  let origCanvas = null;             // pristine decode, for "New image"
  let src = null;                    // working source canvas (after rotate/flip)
  let W = 0, H = 0;
  let sel = { x: 0, y: 0, w: 0, h: 0 };
  let ratio = null;                  // null = free
  let drag = null;                   // { mode, handle, startSel, startX, startY }
  let lastFileName = 'image';

  const isActive = () => document.body.dataset.tab === 'crop';
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ============================================================
  // Loading
  // ============================================================
  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    lastFileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); onImageReady(img); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Could not load that image.'); };
    img.src = url;
  }

  function onImageReady(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    origCanvas = document.createElement('canvas');
    origCanvas.width = w; origCanvas.height = h;
    origCanvas.getContext('2d').drawImage(img, 0, 0);
    setSource(origCanvas);
    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    selectAll();
  }

  // Adopt a canvas as the working source and repaint.
  function setSource(c) {
    src = c; W = c.width; H = c.height;
    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(c, 0, 0);
    dimsLabel.textContent = `${W} × ${H}`;
    srcDims.textContent = `${W} × ${H}`;
  }

  // ============================================================
  // Selection
  // ============================================================
  function setSel(next, keepRatio) {
    let { x, y, w, h } = next;
    w = Math.max(MIN, Math.min(w, W));
    h = Math.max(MIN, Math.min(h, H));
    if (keepRatio && ratio) {
      // shrink to fit the image while holding the ratio
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
      if (w > W) { w = W; h = w / ratio; }
      if (h > H) { h = H; w = h * ratio; }
    }
    x = clamp(x, 0, W - w);
    y = clamp(y, 0, H - h);
    sel = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    render();
  }

  function selectAll() {
    if (!src) return;
    if (ratio) {
      let w = W, h = W / ratio;
      if (h > H) { h = H; w = H * ratio; }
      setSel({ x: (W - w) / 2, y: (H - h) / 2, w, h });
    } else {
      setSel({ x: 0, y: 0, w: W, h: H });
    }
  }

  function centerBox(frac) {
    if (!src) return;
    let w = W * frac, h = H * frac;
    if (ratio) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
    setSel({ x: (W - w) / 2, y: (H - h) / 2, w, h });
  }

  function render() {
    if (!src) return;
    selEl.style.left   = `${(sel.x / W) * 100}%`;
    selEl.style.top    = `${(sel.y / H) * 100}%`;
    selEl.style.width  = `${(sel.w / W) * 100}%`;
    selEl.style.height = `${(sel.h / H) * 100}%`;
    if (document.activeElement !== inW) inW.value = sel.w;
    if (document.activeElement !== inH) inH.value = sel.h;
    if (document.activeElement !== inX) inX.value = sel.x;
    if (document.activeElement !== inY) inY.value = sel.y;
    outDims.textContent = `${sel.w} × ${sel.h}`;
    const pct = (sel.w * sel.h) / (W * H) * 100;
    keptEl.textContent = `${pct.toFixed(0)}% area`;
  }

  // ============================================================
  // Pointer interaction
  // ============================================================
  function toImage(e) {
    const r = wrap.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * W,
      y: (e.clientY - r.top) / r.height * H,
    };
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (!src) return;
    const handle = e.target.dataset ? e.target.dataset.h : null;
    const p = toImage(e);
    e.preventDefault();
    wrap.setPointerCapture?.(e.pointerId);

    if (handle) {
      drag = { mode: 'resize', handle, start: { ...sel }, px: p.x, py: p.y };
    } else if (e.target === selEl || selEl.contains(e.target)) {
      drag = { mode: 'move', start: { ...sel }, px: p.x, py: p.y };
    } else {
      // draw a fresh selection from this point
      drag = { mode: 'draw', start: { x: p.x, y: p.y, w: 0, h: 0 }, px: p.x, py: p.y };
      setSel({ x: p.x, y: p.y, w: MIN, h: MIN });
    }
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImage(e);
    const dx = p.x - drag.px, dy = p.y - drag.py;

    if (drag.mode === 'move') {
      setSel({ x: drag.start.x + dx, y: drag.start.y + dy, w: drag.start.w, h: drag.start.h });
      return;
    }
    if (drag.mode === 'draw') {
      let x0 = Math.min(drag.start.x, p.x), x1 = Math.max(drag.start.x, p.x);
      let y0 = Math.min(drag.start.y, p.y), y1 = Math.max(drag.start.y, p.y);
      let w = x1 - x0, h = y1 - y0;
      if (ratio) {
        h = w / ratio;
        if (p.y < drag.start.y) y0 = drag.start.y - h;
      }
      setSel({ x: x0, y: y0, w: Math.max(MIN, w), h: Math.max(MIN, h) }, false);
      return;
    }

    // resize
    const s = drag.start;
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    const hnd = drag.handle;
    if (hnd.includes('w')) x0 = clamp(s.x + dx, 0, x1 - MIN);
    if (hnd.includes('e')) x1 = clamp(s.x + s.w + dx, x0 + MIN, W);
    if (hnd.includes('n')) y0 = clamp(s.y + dy, 0, y1 - MIN);
    if (hnd.includes('s')) y1 = clamp(s.y + s.h + dy, y0 + MIN, H);

    if (ratio) {
      let w = x1 - x0, h = y1 - y0;
      if (hnd === 'n' || hnd === 's') {
        w = h * ratio;
        const cx = s.x + s.w / 2;
        x0 = cx - w / 2; x1 = cx + w / 2;
      } else if (hnd === 'e' || hnd === 'w') {
        h = w / ratio;
        const cy = s.y + s.h / 2;
        y0 = cy - h / 2; y1 = cy + h / 2;
      } else {
        h = w / ratio;
        if (hnd.includes('n')) y0 = y1 - h; else y1 = y0 + h;
      }
      // if the ratio pushed us outside the image, pull back along both axes
      if (x0 < 0) { const k = -x0; x0 = 0; x1 = Math.min(W, x1); }
      if (y0 < 0) { const k = -y0; y0 = 0; y1 = Math.min(H, y1); }
      if (x1 > W) x1 = W;
      if (y1 > H) y1 = H;
      let w2 = x1 - x0, h2 = y1 - y0;
      if (w2 / h2 > ratio) { w2 = h2 * ratio; if (hnd.includes('w')) x0 = x1 - w2; else x1 = x0 + w2; }
      else { h2 = w2 / ratio; if (hnd.includes('n')) y0 = y1 - h2; else y1 = y0 + h2; }
    }
    setSel({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  });

  const endDrag = () => { drag = null; };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  window.addEventListener('pointerup', endDrag);

  // ============================================================
  // Controls
  // ============================================================
  ratioGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...ratioGrid.children].forEach((b) => b.classList.toggle('active', b === btn));
    const r = btn.dataset.r;
    if (r === 'free') ratio = null;
    else if (r === 'orig') ratio = W / H;
    else { const [a, b] = r.split(':').map(Number); ratio = a / b; }
    if (!src) return;
    if (ratio) {
      // keep the current centre, fit the new ratio inside the image
      const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
      let w = sel.w, h = w / ratio;
      if (h > H) { h = H; w = h * ratio; }
      if (w > W) { w = W; h = w / ratio; }
      setSel({ x: cx - w / 2, y: cy - h / 2, w, h }, true);
    } else render();
  });

  quickSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.q === 'all') selectAll(); else centerBox(0.8);
  });

  const numHandler = () => {
    if (!src) return;
    const w = +inW.value || MIN, h = +inH.value || MIN;
    const x = +inX.value || 0, y = +inY.value || 0;
    setSel({ x, y, w, h }, !!ratio);
  };
  [inW, inH, inX, inY].forEach((el) => el.addEventListener('change', numHandler));

  // --- rotate / flip rewrite the working source ---
  function transformSource(fn, swap) {
    if (!src) return;
    const out = document.createElement('canvas');
    out.width  = swap ? H : W;
    out.height = swap ? W : H;
    const c = out.getContext('2d');
    fn(c, out);
    c.drawImage(src, 0, 0);
    setSource(out);
    selectAll();
  }
  rotR.addEventListener('click', () => transformSource((c, o) => { c.translate(o.width, 0); c.rotate(Math.PI / 2); }, true));
  rotL.addEventListener('click', () => transformSource((c, o) => { c.translate(0, o.height); c.rotate(-Math.PI / 2); }, true));
  flipH.addEventListener('click', () => transformSource((c, o) => { c.translate(o.width, 0); c.scale(-1, 1); }, false));
  flipV.addEventListener('click', () => transformSource((c, o) => { c.translate(0, o.height); c.scale(1, -1); }, false));

  // ============================================================
  // Export
  // ============================================================
  function renderOutput(type) {
    if (!src) return null;
    const out = document.createElement('canvas');
    out.width = sel.w; out.height = sel.h;
    const c = out.getContext('2d');
    if (type === 'image/jpeg') { c.fillStyle = '#ffffff'; c.fillRect(0, 0, sel.w, sel.h); }
    c.drawImage(src, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    return out;
  }

  function download() {
    const type = formatSel.value;
    const out = renderOutput(type);
    if (!out) return;
    const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastFileName}-cropped.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, type, 0.92);
  }

  function copyToClipboard() {
    const out = renderOutput('image/png');
    if (!out || !navigator.clipboard || !window.ClipboardItem) {
      alert('Clipboard copy not supported in this browser.');
      return;
    }
    out.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy to clipboard'), 1500);
      } catch { alert('Could not copy to clipboard.'); }
    }, 'image/png');
  }

  // ============================================================
  // Events
  // ============================================================
  pickBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  window.addEventListener('paste', (e) => {
    if (!isActive()) return;
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
    }
  });

  resetBtn.addEventListener('click', () => {
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    src = null; origCanvas = null;
  });

  downloadBtn.addEventListener('click', download);
  copyBtn.addEventListener('click', copyToClipboard);

  window.addEventListener('keydown', (e) => {
    if (!isActive() || editor.classList.contains('hidden') || !src) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); download(); return; }
    if (e.key === 'Escape') { e.preventDefault(); selectAll(); return; }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      setSel({ x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h });
    }
  });
})();
