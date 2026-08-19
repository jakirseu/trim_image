/* TrimImage — client-side image trimming (Photoshop-style "Trim").
 * Detects a uniform background and crops it away. No uploads; all in-browser. */

(() => {
  'use strict';

  // ---- Tabs (shared by all tools) ----
  const tabButtons = document.querySelectorAll('.tab[data-tab]');
  const tabPanels  = document.querySelectorAll('.tab-panel[data-panel]');
  function setTab(name) {
    document.body.dataset.tab = name;
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    tabPanels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    try {
      const hash = { bg: '#remove-background', erase: '#erase-color', crop: '#crop' }[name] || '';
      history.replaceState(null, '', hash || location.pathname + location.search);
    } catch { /* file:// may refuse; ignore */ }
  }
  tabButtons.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  const fromHash = { '#remove-background': 'bg', '#erase-color': 'erase', '#crop': 'crop' }[location.hash];
  if (fromHash) setTab(fromHash);
  const trimActive = () => document.body.dataset.tab === 'trim';


  // ---- Elements ----
  const $ = (id) => document.getElementById(id);
  const dropzone   = $('dropzone');
  const fileInput  = $('fileInput');
  const pickBtn    = $('pickBtn');
  const editor     = $('editor');
  const canvas     = $('canvas');
  const ctx        = canvas.getContext('2d', { willReadFrequently: true });
  const stage      = $('stage');
  const resetBtn   = $('resetBtn');

  const bgModeSeg     = $('bgMode');
  const customColorRow= $('customColorRow');
  const bgColorInput  = $('bgColor');
  const pickFromImage = $('pickFromImage');
  const pickHint      = $('pickHint');
  const tolerance     = $('tolerance');
  const tolVal        = $('tolVal');
  const padding       = $('padding');
  const padVal        = $('padVal');
  const formatSel     = $('format');

  const dimsLabel = $('dimsLabel');
  const origDims  = $('origDims');
  const newDims   = $('newDims');
  const savedPct  = $('savedPct');
  const warnEmpty = $('warnEmpty');

  const downloadBtn = $('downloadBtn');
  const copyBtn     = $('copyBtn');

  // ---- State ----
  let sourceImg = null;          // HTMLImageElement (or canvas) of the loaded image
  let srcData = null;            // ImageData of the full source
  let srcW = 0, srcH = 0;
  let bgMode = 'auto';           // 'auto' | 'transparent' | 'custom'
  let crop = null;               // { x, y, w, h }
  let eyedropperArmed = false;
  let lastFileName = 'trimmed';

  // ============================================================
  // Loading images
  // ============================================================
  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    lastFileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      onImageReady(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('Could not load that image.');
    };
    img.src = url;
  }

  function onImageReady(img) {
    srcW = img.naturalWidth || img.width;
    srcH = img.naturalHeight || img.height;

    // Render source into an offscreen canvas to read pixels.
    const off = document.createElement('canvas');
    off.width = srcW;
    off.height = srcH;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0);
    srcData = octx.getImageData(0, 0, srcW, srcH);
    sourceImg = off;

    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');

    origDims.textContent = `${srcW} × ${srcH}`;
    recompute();
  }

  // ============================================================
  // Background detection + trimming
  // ============================================================

  // Decide the reference background color (RGBA) based on mode.
  function getBackgroundRef() {
    const d = srcData.data;
    if (bgMode === 'transparent') {
      return { r: 0, g: 0, b: 0, a: 0, alphaOnly: true };
    }
    if (bgMode === 'custom') {
      const c = hexToRgb(bgColorInput.value);
      return { r: c.r, g: c.g, b: c.b, a: 255, alphaOnly: false };
    }
    // auto: average the four corner pixels
    const corners = [
      0,                                   // top-left
      (srcW - 1) * 4,                      // top-right
      (srcH - 1) * srcW * 4,               // bottom-left
      ((srcH - 1) * srcW + (srcW - 1)) * 4 // bottom-right
    ];
    let r = 0, g = 0, b = 0, a = 0;
    for (const i of corners) { r += d[i]; g += d[i+1]; b += d[i+2]; a += d[i+3]; }
    r = Math.round(r/4); g = Math.round(g/4); b = Math.round(b/4); a = Math.round(a/4);
    // If corners are fully transparent, treat as transparent trim.
    const alphaOnly = a === 0;
    return { r, g, b, a, alphaOnly };
  }

  // Is pixel at index i considered "background" (within tolerance)?
  function isBg(d, i, ref, tol) {
    const alpha = d[i+3];
    if (ref.alphaOnly) {
      // Trim by transparency: background = (almost) fully transparent.
      return alpha <= tol * 2.55; // tol 0-100 -> alpha 0-255
    }
    // If the pixel is transparent but we're matching a solid color,
    // count transparent as background too (common for PNG exports).
    if (alpha === 0) return true;
    const dr = d[i]   - ref.r;
    const dg = d[i+1] - ref.g;
    const db = d[i+2] - ref.b;
    // Perceptual-ish weighted distance, normalised to 0..~441 -> compare to tol.
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    const maxDist = 441.67; // sqrt(255^2 *3)
    return (dist / maxDist) * 100 <= tol;
  }

  // Find the tight bounding box of non-background content.
  function computeCrop() {
    const d = srcData.data;
    const ref = getBackgroundRef();
    const tol = +tolerance.value;

    let top = -1, bottom = -1, left = -1, right = -1;

    // top
    outerTop:
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        if (!isBg(d, (y*srcW + x)*4, ref, tol)) { top = y; break outerTop; }
      }
    }
    if (top === -1) return null; // entire image is background

    // bottom
    outerBottom:
    for (let y = srcH - 1; y >= top; y--) {
      for (let x = 0; x < srcW; x++) {
        if (!isBg(d, (y*srcW + x)*4, ref, tol)) { bottom = y; break outerBottom; }
      }
    }
    // left
    outerLeft:
    for (let x = 0; x < srcW; x++) {
      for (let y = top; y <= bottom; y++) {
        if (!isBg(d, (y*srcW + x)*4, ref, tol)) { left = x; break outerLeft; }
      }
    }
    // right
    outerRight:
    for (let x = srcW - 1; x >= left; x--) {
      for (let y = top; y <= bottom; y++) {
        if (!isBg(d, (y*srcW + x)*4, ref, tol)) { right = x; break outerRight; }
      }
    }

    const pad = +padding.value;
    const x = Math.max(0, left - pad);
    const y = Math.max(0, top - pad);
    const w = Math.min(srcW, right + 1 + pad) - x;
    const h = Math.min(srcH, bottom + 1 + pad) - y;
    return { x, y, w, h };
  }

  // ============================================================
  // Rendering preview (image + overlay of detected/kept region)
  // ============================================================
  function recompute() {
    if (!srcData) return;
    crop = computeCrop();

    // Draw full source on the canvas, then dim the area being trimmed away.
    canvas.width = srcW;
    canvas.height = srcH;
    ctx.clearRect(0, 0, srcW, srcH);
    ctx.drawImage(sourceImg, 0, 0);

    if (!crop) {
      // Nothing to keep.
      ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
      ctx.fillRect(0, 0, srcW, srcH);
      newDims.textContent = '—';
      savedPct.textContent = '—';
      dimsLabel.textContent = `${srcW} × ${srcH}`;
      warnEmpty.textContent = 'The whole image matches the background — nothing to keep. Lower the tolerance or change the background.';
      downloadBtn.disabled = true;
      copyBtn.disabled = true;
      downloadBtn.style.opacity = copyBtn.style.opacity = .5;
      return;
    }

    warnEmpty.textContent = '';
    downloadBtn.disabled = false;
    copyBtn.disabled = false;
    downloadBtn.style.opacity = copyBtn.style.opacity = 1;

    // Dim trimmed-away region (everything outside crop).
    ctx.save();
    ctx.fillStyle = 'rgba(15, 17, 21, 0.62)';
    // top band
    ctx.fillRect(0, 0, srcW, crop.y);
    // bottom band
    ctx.fillRect(0, crop.y + crop.h, srcW, srcH - (crop.y + crop.h));
    // left band
    ctx.fillRect(0, crop.y, crop.x, crop.h);
    // right band
    ctx.fillRect(crop.x + crop.w, crop.y, srcW - (crop.x + crop.w), crop.h);
    // keep-region outline
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = Math.max(1, Math.round(Math.min(srcW, srcH) / 400));
    ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.w - 1, crop.h - 1);
    ctx.restore();

    const origPx = srcW * srcH;
    const newPx = crop.w * crop.h;
    const removed = origPx ? Math.round((1 - newPx / origPx) * 100) : 0;
    newDims.textContent = `${crop.w} × ${crop.h}`;
    savedPct.textContent = `${removed}% area`;
    dimsLabel.textContent = `${srcW} × ${srcH}  →  ${crop.w} × ${crop.h}`;
  }

  // Produce the final trimmed canvas (no overlay).
  function renderOutput() {
    if (!crop) return null;
    const out = document.createElement('canvas');
    out.width = crop.w;
    out.height = crop.h;
    const octx = out.getContext('2d');
    octx.drawImage(sourceImg, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    return out;
  }

  // ============================================================
  // Export
  // ============================================================
  function download() {
    const out = renderOutput();
    if (!out) return;
    const type = formatSel.value;
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';

    // JPEG has no alpha — flatten onto background color.
    const finalCanvas = (type === 'image/jpeg') ? flatten(out) : out;
    finalCanvas.toBlob((blob) => {
      if (!blob) { alert('Export failed.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastFileName}-trimmed.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, type, 0.92);
  }

  async function copyToClipboard() {
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
      } catch {
        alert('Could not copy to clipboard.');
      }
    }, 'image/png');
  }

  function flatten(srcCanvas) {
    const f = document.createElement('canvas');
    f.width = srcCanvas.width;
    f.height = srcCanvas.height;
    const fctx = f.getContext('2d');
    const ref = getBackgroundRef();
    fctx.fillStyle = ref.alphaOnly ? '#ffffff' : `rgb(${ref.r},${ref.g},${ref.b})`;
    fctx.fillRect(0, 0, f.width, f.height);
    fctx.drawImage(srcCanvas, 0, 0);
    return f;
  }

  // ============================================================
  // Helpers
  // ============================================================
  function hexToRgb(hex) {
    const m = hex.replace('#', '');
    return {
      r: parseInt(m.substring(0, 2), 16),
      g: parseInt(m.substring(2, 4), 16),
      b: parseInt(m.substring(4, 6), 16),
    };
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
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

  // Paste from clipboard anywhere.
  window.addEventListener('paste', (e) => {
    if (!trimActive()) return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
    }
  });

  resetBtn.addEventListener('click', () => {
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    srcData = null; sourceImg = null; crop = null;
  });

  // Background mode segmented control
  bgModeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    bgMode = btn.dataset.mode;
    [...bgModeSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    customColorRow.classList.toggle('hidden', bgMode !== 'custom');
    recompute();
  });

  bgColorInput.addEventListener('input', recompute);

  // Eyedropper: pick background color from the image.
  pickFromImage.addEventListener('click', () => {
    eyedropperArmed = !eyedropperArmed;
    pickFromImage.classList.toggle('armed', eyedropperArmed);
    stage.classList.toggle('eyedropper', eyedropperArmed);
    pickHint.textContent = eyedropperArmed ? 'Click the image…' : '';
  });

  canvas.addEventListener('click', (e) => {
    if (!eyedropperArmed || !srcData) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * srcW);
    const y = Math.floor((e.clientY - rect.top) / rect.height * srcH);
    const i = (Math.min(srcH-1,Math.max(0,y)) * srcW + Math.min(srcW-1,Math.max(0,x))) * 4;
    const d = srcData.data;
    bgColorInput.value = rgbToHex(d[i], d[i+1], d[i+2]);
    eyedropperArmed = false;
    pickFromImage.classList.remove('armed');
    stage.classList.remove('eyedropper');
    pickHint.textContent = '';
    recompute();
  });

  // Sliders (live).
  tolerance.addEventListener('input', () => { tolVal.textContent = tolerance.value; recompute(); });
  padding.addEventListener('input', () => { padVal.textContent = padding.value; recompute(); });

  downloadBtn.addEventListener('click', download);
  copyBtn.addEventListener('click', copyToClipboard);

  // Keyboard shortcut: Enter to download when editor open.
  window.addEventListener('keydown', (e) => {
    if (trimActive() && !editor.classList.contains('hidden') && (e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault(); download();
    }
  });
})();
