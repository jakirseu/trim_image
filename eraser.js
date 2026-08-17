/* TrimImage — Erase colour tab.
 * Two ways to make pixels transparent, both pure per-pixel work on the main thread:
 *   1. Colour eraser — sample a colour, erase every pixel within a tolerance
 *      ("intensity") of it, either across the whole image or only the connected
 *      region you clicked (scanline flood fill).
 *   2. Round brush — erase / restore by dragging, with size + hardness.
 * The image itself is never modified: we keep an 8-bit alpha multiplier per pixel,
 * so every operation is non-destructive and undoable. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- Elements ----
  const dropzone  = $('erDropzone');
  const fileInput = $('erFileInput');
  const pickBtn   = $('erPickBtn');
  const editor    = $('erEditor');
  const stage     = $('erStage');
  const canvas    = $('erCanvas');
  const ctx       = canvas.getContext('2d', { willReadFrequently: true });
  const cursorEl  = $('erCursor');
  const resetBtn  = $('erResetBtn');
  const undoBtn   = $('erUndoBtn');
  const redoBtn   = $('erRedoBtn');
  const dimsLabel = $('erDimsLabel');
  const hintEl    = $('erHint');
  const previewSeg= $('erPreviewBg');

  const toolSeg    = $('erTool');
  const colorPanel = $('erColorPanel');
  const brushPanel = $('erBrushPanel');
  const colorInput = $('erColorInput');
  const colorHex   = $('erColorHex');
  const applyBtn   = $('erApplyBtn');
  const tolIn      = $('erTol');
  const tolVal     = $('erTolVal');
  const softIn     = $('erSoft');
  const softVal    = $('erSoftVal');
  const scopeSeg   = $('erScope');
  const brushSeg   = $('erBrushMode');
  const sizeIn     = $('erSize');
  const sizeVal    = $('erSizeVal');
  const hardIn     = $('erHard');
  const hardVal    = $('erHardVal');

  const sizeInfo   = $('erSizeInfo');
  const erasedPct  = $('erErasedPct');
  const formatSel  = $('erFormat');
  const downloadBtn= $('erDownloadBtn');
  const copyBtn    = $('erCopyBtn');
  const restoreAll = $('erRestoreAllBtn');

  const MAX_DIST = Math.sqrt(255 * 255 * 3); // 441.67

  // ---- State ----
  let srcData = null;      // original ImageData (never mutated)
  let W = 0, H = 0, N = 0;
  let alpha = null;        // Uint8Array(N): 255 = untouched, 0 = fully erased
  let baseAlpha = null;    // state before the *pending* colour erase (for live re-tuning)
  let outImage = null;     // ImageData we blit to the canvas
  let opaqueCount = 0;     // source pixels that were visible to begin with
  let pending = null;      // { r, g, b, sx, sy } — colour erase being tuned
  let tool = 'color';      // 'color' | 'brush'
  let brushMode = 'erase'; // 'erase' | 'restore'
  let scope = 'global';    // 'global' | 'contiguous'
  let drawing = false, lastX = 0, lastY = 0, strokePointer = null;
  let undoStack = [], redoStack = [], maxUndo = 12;
  let lastFileName = 'image';
  let dirty = null;        // accumulated dirty rect for the current event
  let applyRaf = 0;

  const isActive = () => document.body.dataset.tab === 'erase';

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
    W = img.naturalWidth || img.width;
    H = img.naturalHeight || img.height;
    N = W * H;

    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    srcData = ctx.getImageData(0, 0, W, H);

    alpha = new Uint8Array(N).fill(255);
    baseAlpha = new Uint8Array(N).fill(255);
    outImage = ctx.createImageData(W, H);
    outImage.data.set(srcData.data);      // RGB never changes; we only rewrite alpha

    opaqueCount = 0;
    for (let i = 3; i < srcData.data.length; i += 4) if (srcData.data[i] > 0) opaqueCount++;

    pending = null;
    undoStack = []; redoStack = [];
    // Cap undo memory at roughly 60 MB of snapshots.
    maxUndo = Math.max(4, Math.min(20, Math.floor(60e6 / N)));
    updateUndoButtons();

    dimsLabel.textContent = `${W} × ${H}`;
    sizeInfo.textContent = `${W} × ${H}`;
    hintEl.textContent = 'Click a color on the image to erase it.';

    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    compositeAll();
    updateStats();
  }

  // ============================================================
  // Compositing (only the alpha channel is ever rewritten)
  // ============================================================
  function compositeRect(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(W, x1 | 0); y1 = Math.min(H, y1 | 0);
    if (x1 <= x0 || y1 <= y0) return;
    const s = srcData.data, o = outImage.data;
    for (let y = y0; y < y1; y++) {
      let i = (y * W + x0) * 4 + 3, idx = y * W + x0;
      for (let x = x0; x < x1; x++, i += 4, idx++) {
        const a = alpha[idx];
        o[i] = a === 255 ? s[i] : (s[i] * a / 255) | 0;
      }
    }
    ctx.putImageData(outImage, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
  const compositeAll = () => compositeRect(0, 0, W, H);

  function markDirty(x0, y0, x1, y1) {
    if (!dirty) dirty = { x0, y0, x1, y1 };
    else {
      if (x0 < dirty.x0) dirty.x0 = x0;
      if (y0 < dirty.y0) dirty.y0 = y0;
      if (x1 > dirty.x1) dirty.x1 = x1;
      if (y1 > dirty.y1) dirty.y1 = y1;
    }
  }
  function flushDirty() {
    if (!dirty) return;
    compositeRect(dirty.x0, dirty.y0, dirty.x1, dirty.y1);
    dirty = null;
  }

  // ============================================================
  // Colour erasing
  // ============================================================
  // Erase strength for a colour distance: 1 inside `inner`, ramping to 0 at `outer`.
  function thresholds() {
    const tol = +tolIn.value / 100 * MAX_DIST;
    const inner = tol * (1 - +softIn.value / 100);
    return { outer2: tol * tol, inner2: inner * inner, inner, outer: tol };
  }

  function applyPending() {
    if (!pending) return;
    alpha.set(baseAlpha);
    const { r, g, b, sx, sy } = pending;
    const t = thresholds();
    if (scope === 'contiguous' && sx >= 0) floodErase(r, g, b, sx, sy, t);
    else globalErase(r, g, b, t);
    compositeAll();
    updateStats();
  }
  function scheduleApply() {
    if (applyRaf) return;
    applyRaf = requestAnimationFrame(() => { applyRaf = 0; applyPending(); });
  }

  // Erase amount 0..1 for a pixel, or -1 when it is outside the range.
  function eraseAmount(d, i, r, g, b, t) {
    const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
    const d2 = dr * dr + dg * dg + db * db;
    if (d2 > t.outer2) return -1;
    if (d2 <= t.inner2) return 1;
    return (t.outer - Math.sqrt(d2)) / (t.outer - t.inner);
  }

  function globalErase(r, g, b, t) {
    const d = srcData.data;
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      if (d[i + 3] === 0) continue;
      const e = eraseAmount(d, i, r, g, b, t);
      if (e <= 0) continue;
      const a = (baseAlpha[p] * (1 - e)) | 0;
      if (a < alpha[p]) alpha[p] = a;
    }
  }

  // Scanline flood fill from the clicked pixel; only the connected region is erased.
  function floodErase(r, g, b, sx, sy, t) {
    const d = srcData.data;
    const visited = new Uint8Array(N);
    const match = (p) => {
      const i = p * 4;
      if (d[i + 3] === 0 || baseAlpha[p] === 0) return 0.0001; // pass through, no-op paint
      return eraseAmount(d, i, r, g, b, t);
    };
    const paint = (p, e) => {
      if (e <= 0) return;
      const a = (baseAlpha[p] * (1 - e)) | 0;
      if (a < alpha[p]) alpha[p] = a;
    };
    if (match(sy * W + sx) <= 0) return;

    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), seedX = stack.pop();
      let x = seedX;
      while (x >= 0 && !visited[y * W + x] && match(y * W + x) > 0) x--;
      x++;
      let spanUp = false, spanDown = false;
      for (; x < W; x++) {
        const p = y * W + x;
        if (visited[p]) break;
        const e = match(p);
        if (e <= 0) break;
        visited[p] = 1;
        paint(p, e);
        if (y > 0) {
          const up = y > 0 && !visited[p - W] && match(p - W) > 0;
          if (up && !spanUp) { stack.push(x, y - 1); spanUp = true; }
          else if (!up) spanUp = false;
        }
        if (y < H - 1) {
          const dn = !visited[p + W] && match(p + W) > 0;
          if (dn && !spanDown) { stack.push(x, y + 1); spanDown = true; }
          else if (!dn) spanDown = false;
        }
      }
    }
  }

  function startColorErase(r, g, b, sx, sy) {
    commitPending();
    pushUndo();
    pending = { r, g, b, sx, sy };
    setSwatch(rgbToHex(r, g, b));
    applyPending();
  }

  // ============================================================
  // Brush
  // ============================================================
  function stamp(cx, cy) {
    const r = +sizeIn.value / 2;
    const hard = +hardIn.value / 100;
    const inner = r * hard;
    const denom = (r - inner) || 1;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W, Math.ceil(cx + r) + 1);
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H, Math.ceil(cy + r) + 1);
    const erasing = brushMode === 'erase';
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > r2) continue;
        const dist = Math.sqrt(dist2);
        const e = dist <= inner ? 1 : (r - dist) / denom;
        const p = y * W + x;
        if (erasing) {
          const a = (255 * (1 - e)) | 0;
          if (a < alpha[p]) alpha[p] = a;
        } else {
          const a = (255 * e) | 0;
          if (a > alpha[p]) alpha[p] = a;
        }
      }
    }
    markDirty(x0, y0, x1, y1);
  }

  // Stamp along the segment so fast drags stay continuous.
  function strokeTo(x, y) {
    const r = +sizeIn.value / 2;
    const step = Math.max(1, r * 0.25);
    const dx = x - lastX, dy = y - lastY;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i++) stamp(lastX + dx * i / steps, lastY + dy * i / steps);
    lastX = x; lastY = y;
    flushDirty();
  }

  // ============================================================
  // Undo / redo
  // ============================================================
  function pushUndo() {
    undoStack.push(alpha.slice());
    if (undoStack.length > maxUndo) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(alpha.slice());
    alpha.set(undoStack.pop());
    baseAlpha.set(alpha);
    pending = null;
    compositeAll(); updateStats(); updateUndoButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(alpha.slice());
    alpha.set(redoStack.pop());
    baseAlpha.set(alpha);
    pending = null;
    compositeAll(); updateStats(); updateUndoButtons();
  }
  function updateUndoButtons() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }
  function commitPending() {
    if (!pending) return;
    baseAlpha.set(alpha);
    pending = null;
  }

  // ============================================================
  // Stats + export
  // ============================================================
  function updateStats() {
    if (!alpha) return;
    const d = srcData.data;
    let removed = 0;
    for (let p = 0, i = 3; p < N; p++, i += 4) {
      if (d[i] === 0) continue;
      removed += 255 - alpha[p];
    }
    const pct = opaqueCount ? (removed / (opaqueCount * 255)) * 100 : 0;
    erasedPct.textContent = pct < 0.05 && pct > 0 ? '<0.1%' : `${pct.toFixed(1)}%`;
  }

  function renderOutput() {
    if (!srcData) return null;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    out.getContext('2d').putImageData(outImage, 0, 0);
    return out;
  }

  function download() {
    const out = renderOutput();
    if (!out) return;
    const type = formatSel.value;
    const ext = type === 'image/webp' ? 'webp' : 'png';
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastFileName}-erased.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, type);
  }

  function copyToClipboard() {
    const out = renderOutput();
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
  // Pointer helpers
  // ============================================================
  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * W,
      y: (e.clientY - rect.top) / rect.height * H,
    };
  }
  const clampX = (x) => Math.min(W - 1, Math.max(0, x | 0));
  const clampY = (y) => Math.min(H - 1, Math.max(0, y | 0));

  function updateCursor(e) {
    if (tool !== 'brush' || !srcData) { cursorEl.classList.add('hidden'); return; }
    const rect = canvas.getBoundingClientRect();
    const sRect = stage.getBoundingClientRect();
    const scale = rect.width / W;
    const size = +sizeIn.value * scale;
    cursorEl.style.width = cursorEl.style.height = `${size}px`;
    cursorEl.style.left = `${e.clientX - sRect.left + stage.scrollLeft}px`;
    cursorEl.style.top  = `${e.clientY - sRect.top + stage.scrollTop}px`;
    cursorEl.classList.toggle('restore', brushMode === 'restore');
    cursorEl.classList.remove('hidden');
  }

  // ============================================================
  // UI helpers
  // ============================================================
  function setTool(name) {
    tool = name;
    [...toolSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    colorPanel.classList.toggle('hidden', name !== 'color');
    brushPanel.classList.toggle('hidden', name !== 'brush');
    canvas.classList.toggle('picking', name === 'color');
    canvas.classList.toggle('brushing', name === 'brush');
    if (name !== 'brush') cursorEl.classList.add('hidden');
    hintEl.textContent = name === 'color'
      ? 'Click a color on the image to erase it.'
      : 'Drag on the image to ' + (brushMode === 'erase' ? 'erase' : 'restore') + '.';
    commitPending();
  }
  function setSwatch(hex) {
    colorInput.value = hex;
    colorHex.textContent = hex.toUpperCase();
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function hexToRgb(hex) {
    const m = hex.replace('#', '');
    return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
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
    srcData = null; alpha = null; baseAlpha = null; outImage = null; pending = null;
    undoStack = []; redoStack = []; updateUndoButtons();
  });

  toolSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setTool(btn.dataset.tool);
  });
  scopeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    scope = btn.dataset.scope;
    [...scopeSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    if (pending && scope === 'contiguous' && pending.sx < 0) {
      hintEl.textContent = 'Click the image to choose where to erase from.';
    }
    scheduleApply();
  });
  brushSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    brushMode = btn.dataset.mode;
    [...brushSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    hintEl.textContent = 'Drag on the image to ' + (brushMode === 'erase' ? 'erase' : 'restore') + '.';
  });

  tolIn.addEventListener('input',  () => { tolVal.textContent = tolIn.value; scheduleApply(); });
  softIn.addEventListener('input', () => { softVal.textContent = softIn.value; scheduleApply(); });
  sizeIn.addEventListener('input', () => { sizeVal.textContent = sizeIn.value; });
  hardIn.addEventListener('input', () => { hardVal.textContent = hardIn.value; });

  colorInput.addEventListener('input', () => setSwatch(colorInput.value));
  applyBtn.addEventListener('click', () => {
    if (!srcData) return;
    const c = hexToRgb(colorInput.value);
    startColorErase(c.r, c.g, c.b, pending ? pending.sx : -1, pending ? pending.sy : -1);
  });

  restoreAll.addEventListener('click', () => {
    if (!alpha) return;
    pushUndo();
    alpha.fill(255); baseAlpha.fill(255); pending = null;
    compositeAll(); updateStats();
  });
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  previewSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...previewSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    stage.classList.remove('bg-white', 'bg-black');
    if (btn.dataset.bg !== 'checker') stage.classList.add(`bg-${btn.dataset.bg}`);
  });

  // --- Canvas interaction ---
  canvas.addEventListener('pointerdown', (e) => {
    if (!srcData) return;
    const { x, y } = toImage(e);
    if (tool === 'color') {
      const px = clampX(x), py = clampY(y);
      const i = (py * W + px) * 4;
      const d = srcData.data;
      // Browsers zero the RGB of fully transparent pixels, so sampling one would
      // erase black everywhere. Say so instead.
      if (d[i + 3] === 0) {
        hintEl.textContent = 'That pixel is already transparent — nothing to sample there.';
        return;
      }
      if (alpha[py * W + px] === 0) {
        hintEl.textContent = 'That area is already erased — undo first to sample its color.';
        return;
      }
      hintEl.textContent = 'Click a color on the image to erase it.';
      startColorErase(d[i], d[i + 1], d[i + 2], px, py);
      return;
    }
    // brush
    e.preventDefault();
    commitPending();
    pushUndo();
    drawing = true;
    strokePointer = e.pointerId;
    lastX = x; lastY = y;
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    stamp(x, y);
    flushDirty();
  });
  canvas.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (!drawing || e.pointerId !== strokePointer) return;
    const { x, y } = toImage(e);
    strokeTo(x, y);
  });
  const endStroke = () => {
    if (!drawing) return;
    drawing = false; strokePointer = null;
    flushDirty();
    baseAlpha.set(alpha);
    updateStats();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  window.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointerleave', () => { if (!drawing) cursorEl.classList.add('hidden'); });
  canvas.addEventListener('pointerenter', updateCursor);

  downloadBtn.addEventListener('click', download);
  copyBtn.addEventListener('click', copyToClipboard);

  window.addEventListener('keydown', (e) => {
    if (!isActive() || editor.classList.contains('hidden')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault(); download();
    } else if (!meta && (e.key === '[' || e.key === ']')) {
      const step = e.key === '[' ? -Math.max(2, +sizeIn.value * 0.2) : Math.max(2, +sizeIn.value * 0.2);
      sizeIn.value = Math.round(Math.min(+sizeIn.max, Math.max(+sizeIn.min, +sizeIn.value + step)));
      sizeVal.textContent = sizeIn.value;
      if (tool !== 'brush') setTool('brush');
    }
  });

  setTool('color');
})();
