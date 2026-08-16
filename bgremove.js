/* TrimImage — Background removal tab.
 * AI portrait segmentation via @imgly/background-removal (ISNet model running on
 * ONNX Runtime — WebGPU when available, WASM otherwise). Everything runs in the
 * browser; the only network traffic is the one-time model/runtime download from a CDN. */

(() => {
  'use strict';

  const LIB_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

  // ---- Elements ----
  const $ = (id) => document.getElementById(id);
  const dropzone   = $('bgDropzone');
  const fileInput  = $('bgFileInput');
  const pickBtn    = $('bgPickBtn');
  const editor     = $('bgEditor');
  const canvas     = $('bgCanvas');
  const ctx        = canvas.getContext('2d');
  const resetBtn   = $('bgResetBtn');
  const compareBtn = $('bgCompareBtn');
  const dimsLabel  = $('bgDimsLabel');
  const statusEl   = $('bgStatus');

  const progressEl   = $('bgProgress');
  const progressText = $('bgProgressText');
  const progressBar  = $('bgProgressBar');
  const progressFill = $('bgProgressFill');
  const progressSub  = $('bgProgressSub');

  const outModeSeg = $('bgOutMode');
  const colorRow   = $('bgColorRow');
  const swatches   = $('bgSwatches');
  const fillInput  = $('bgFillColor');
  const fillHex    = $('bgFillHex');
  const shrinkIn   = $('bgShrink');
  const shrinkVal  = $('bgShrinkVal');
  const featherIn  = $('bgFeather');
  const featherVal = $('bgFeatherVal');
  const modelSel   = $('bgModel');
  const formatSel  = $('bgFormat');

  const downloadBtn = $('bgDownloadBtn');
  const copyBtn     = $('bgCopyBtn');
  const errorEl     = $('bgError');
  const retryRow    = $('bgRetryRow');
  const retryBtn    = $('bgRetryBtn');

  // ---- State ----
  let srcData = null;      // ImageData of the loaded photo
  let srcCanvas = null;    // canvas holding the original (for "compare")
  let srcW = 0, srcH = 0;
  let mask = null;         // Uint8Array (W*H): raw alpha from the model
  let cutout = null;       // canvas: original RGB + refined alpha
  let outMode = 'transparent'; // 'transparent' | 'color'
  let fillColor = '#ffffff';
  let jobId = 0;           // increments per run; stale results are dropped
  let busy = false;
  let forceCpu = false;    // set after a WebGPU failure
  let attempt = 0;         // bumps the lib's memoize key so a failed download can be retried
  let lastFileName = 'portrait';
  let libPromise = null;
  let rebuildTimer = 0;
  let comparing = false;
  let gpuOk = null;        // cached WebGPU adapter check
  let inferT0 = 0;         // when inference (not download) started

  const isActive = () => document.body.dataset.tab === 'bg';

  // ============================================================
  // Loading images
  // ============================================================
  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    lastFileName = (file.name || 'portrait').replace(/\.[^.]+$/, '') || 'portrait';
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); onImageReady(img); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('Could not load that image.'); };
    img.src = url;
  }

  function onImageReady(img) {
    srcW = img.naturalWidth || img.width;
    srcH = img.naturalHeight || img.height;

    srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW; srcCanvas.height = srcH;
    const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    srcData = sctx.getImageData(0, 0, srcW, srcH);

    mask = null; cutout = null;
    canvas.width = srcW; canvas.height = srcH;
    ctx.drawImage(srcCanvas, 0, 0);       // show original while we work
    dimsLabel.textContent = `${srcW} × ${srcH}`;
    statusEl.textContent = '';

    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    runRemoval();
  }

  // ============================================================
  // AI background removal
  // ============================================================
  function loadLib() {
    if (!libPromise) {
      libPromise = import(LIB_URL).catch((e) => { libPromise = null; throw e; });
    }
    return libPromise;
  }

  async function gpuAvailable() {
    if (gpuOk === null) {
      try { gpuOk = !!(navigator.gpu && await navigator.gpu.requestAdapter()); }
      catch { gpuOk = false; }
    }
    return gpuOk;
  }

  function makeConfig(model, device, id) {
    return {
      model,
      device,
      output: { format: 'image/x-rgba8' },  // raw RGBA bytes: no PNG round-trip
      progress: (key, cur, tot) => onProgress(id, key, cur, tot),
      _attempt: attempt,                    // ignored by the lib, but part of its cache key
    };
  }

  async function runRemoval() {
    if (!srcData) return;
    const id = ++jobId;
    busy = true;
    setBusyUI(true);
    hideError();
    showProgress('Loading AI engine…', null, 'Fetching the background-removal library');
    let device = (!forceCpu && await gpuAvailable()) ? 'gpu' : 'cpu';
    if (id !== jobId) return;

    try {
      const lib = await loadLib();
      if (id !== jobId) return;

      const model = modelSel.value;
      // Hand the exact pixels we already decoded to the model (keeps dimensions identical).
      const blob = new Blob([srcData.data], { type: `image/x-rgba8;width=${srcW};height=${srcH}` });

      let out;
      try {
        out = await runWithDevice(lib, blob, model, device, id);
      } catch (e) {
        if (device !== 'gpu' || id !== jobId) throw e;
        console.warn('WebGPU path failed, retrying on CPU:', e);
        forceCpu = true; device = 'cpu';
        out = await runWithDevice(lib, blob, model, device, id);
      }
      if (id !== jobId) return;

      const rgba = new Uint8Array(await out.arrayBuffer());
      const n = srcW * srcH;
      if (rgba.length !== n * 4) throw new Error('Unexpected model output size.');
      const m = new Uint8Array(n);
      for (let i = 0, p = 3; i < n; i++, p += 4) m[i] = rgba[p];
      mask = m;

      hideProgress();
      const secs = ((performance.now() - inferT0) / 1000).toFixed(1);
      statusEl.textContent = `Background removed in ${secs} s (${device === 'gpu' ? 'WebGPU' : 'CPU'}). Pick a color or refine the edge →`;
      rebuildCutout();
    } catch (e) {
      if (id !== jobId) return;
      console.error(e);
      hideProgress();
      showError(friendlyError(e));
    } finally {
      if (id === jobId) { busy = false; setBusyUI(false); }
    }
  }

  async function runWithDevice(lib, blob, model, device, id) {
    const cfg = makeConfig(model, device, id);
    // 1) download runtime + model, create the session (progress reports bytes)
    await lib.preload(cfg);
    if (id !== jobId) throw new Error('cancelled');
    // 2) inference blocks the main thread — let the browser paint the overlay first
    showProgress('Removing background…', null,
      `Running the ${modelLabel(model)} model on ${device === 'gpu' ? 'your GPU' : 'the CPU'} — this can take a few seconds`);
    await nextPaint();
    // 3) go
    inferT0 = performance.now();
    return lib.removeBackground(blob, cfg);
  }

  function onProgress(id, key, cur, tot) {
    if (id !== jobId) return;
    if (key.startsWith('fetch:')) {
      const isModel = key.includes('/models/');
      const pct = tot ? cur / tot : 0;
      showProgress(
        isModel ? 'Downloading AI model' : 'Loading AI runtime',
        pct,
        `${mb(cur)} / ${mb(tot)} MB · one-time download, cached by your browser`
      );
    } else if (key.startsWith('compute:')) {
      const labels = {
        decode: 'Preparing image…',
        inference: 'Finding the subject…',
        mask: 'Building the mask…',
        encode: 'Finishing…',
      };
      const step = key.split(':')[1];
      showProgress(labels[step] || 'Removing background…', null, '');
    }
  }

  const modelLabel = (m) => ({ small: 'Fast', medium: 'Balanced', large: 'Best' }[m] || m);
  const mb = (b) => (b / 1e6).toFixed(1);
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

  function friendlyError(e) {
    const msg = String(e && e.message || e);
    if (/fetch|network|import|load|NetworkError|Failed to fetch|resolve module/i.test(msg)) {
      return 'Could not download the AI model. Check your internet connection and try again.';
    }
    if (/memory|allocation|out of/i.test(msg)) {
      return 'Ran out of memory. Try a smaller image or the "Fast" quality setting.';
    }
    return 'Background removal failed: ' + msg;
  }

  // ============================================================
  // Mask refinement (shrink = erode, feather = box blur ×2)
  // ============================================================
  function refineMask(src, w, h, shrink, feather) {
    let m = src;
    if (shrink > 0)  m = erode(m, w, h, shrink);
    if (feather > 0) m = blur(m, w, h, feather);
    return m;
  }

  // Separable running-min (van Herk / Gil-Werman) — O(1) per pixel regardless of radius.
  // Out-of-bounds is treated as opaque so subjects touching the border are not eaten away.
  function erode(src, w, h, r) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    const N = Math.max(w, h) + 2 * r;
    const pad = new Uint8Array(N), g = new Uint8Array(N), s = new Uint8Array(N);
    for (let y = 0; y < h; y++) minLine(src, y * w, 1, w, tmp, y * w, 1, r, pad, g, s);
    for (let x = 0; x < w; x++) minLine(tmp, x, w, h, out, x, w, r, pad, g, s);
    return out;
  }
  function minLine(src, off, stride, n, dst, doff, dstride, r, pad, g, s) {
    const k = 2 * r + 1, N = n + 2 * r;
    pad.fill(255, 0, r);
    pad.fill(255, n + r, N);
    for (let i = 0; i < n; i++) pad[r + i] = src[off + i * stride];
    for (let i = 0; i < N; i++) {
      const v = pad[i];
      g[i] = (i % k === 0) ? v : (g[i - 1] < v ? g[i - 1] : v);
    }
    for (let i = N - 1; i >= 0; i--) {
      const v = pad[i];
      s[i] = (i % k === k - 1 || i === N - 1) ? v : (s[i + 1] < v ? s[i + 1] : v);
    }
    for (let i = 0; i < n; i++) {
      const a = s[i], b = g[i + 2 * r];
      dst[doff + i * dstride] = a < b ? a : b;
    }
  }

  // Two passes of a separable box blur (≈ gaussian). Edges clamp.
  function blur(src, w, h, r) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) boxLine(src, y * w, 1, w, tmp, y * w, 1, r);
    for (let x = 0; x < w; x++) boxLine(tmp, x, w, h, out, x, w, r);
    for (let y = 0; y < h; y++) boxLine(out, y * w, 1, w, tmp, y * w, 1, r);
    for (let x = 0; x < w; x++) boxLine(tmp, x, w, h, out, x, w, r);
    return out;
  }
  function boxLine(src, off, stride, n, dst, doff, dstride, r) {
    const k = 2 * r + 1, half = r;
    let sum = 0;
    for (let j = -r; j <= r; j++) {
      const idx = j < 0 ? 0 : (j > n - 1 ? n - 1 : j);
      sum += src[off + idx * stride];
    }
    for (let i = 0; i < n; i++) {
      dst[doff + i * dstride] = ((sum + half) / k) | 0;
      const add = i + r + 1 > n - 1 ? n - 1 : i + r + 1;
      const rem = i - r < 0 ? 0 : i - r;
      sum += src[off + add * stride] - src[off + rem * stride];
    }
  }

  // ============================================================
  // Compositing
  // ============================================================
  function rebuildCutout() {
    if (!mask || !srcData) return;
    const alpha = refineMask(mask, srcW, srcH, +shrinkIn.value, +featherIn.value);
    if (!cutout) {
      cutout = document.createElement('canvas');
      cutout.width = srcW; cutout.height = srcH;
    }
    const cctx = cutout.getContext('2d');
    const img = cctx.createImageData(srcW, srcH);
    const d = img.data;
    d.set(srcData.data);
    for (let i = 0, p = 3, n = srcW * srcH; i < n; i++, p += 4) {
      const a = alpha[i];
      if (a < d[p]) d[p] = a;   // respect existing transparency in the source
    }
    cctx.putImageData(img, 0, 0);
    compose();
  }

  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuildCutout, 80);
  }

  function compose() {
    if (!cutout || comparing) return;
    canvas.width = srcW; canvas.height = srcH;
    ctx.clearRect(0, 0, srcW, srcH);
    if (outMode === 'color') {
      ctx.fillStyle = fillColor;
      ctx.fillRect(0, 0, srcW, srcH);
    }
    ctx.drawImage(cutout, 0, 0);
  }

  // Build the final output canvas for a given MIME type (JPEG has no alpha → white).
  function renderOutput(type) {
    if (!cutout) return null;
    const out = document.createElement('canvas');
    out.width = srcW; out.height = srcH;
    const octx = out.getContext('2d');
    if (outMode === 'color') {
      octx.fillStyle = fillColor;
      octx.fillRect(0, 0, srcW, srcH);
    } else if (type === 'image/jpeg') {
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, srcW, srcH);
    }
    octx.drawImage(cutout, 0, 0);
    return out;
  }

  // ============================================================
  // Export
  // ============================================================
  function download() {
    const type = formatSel.value;
    const out = renderOutput(type);
    if (!out) return;
    const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
    const suffix = outMode === 'color' ? `-bg-${fillColor.replace('#', '')}` : '-nobg';
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastFileName}${suffix}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, type, 0.92);
  }

  async function copyToClipboard() {
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
      } catch {
        alert('Could not copy to clipboard.');
      }
    }, 'image/png');
  }

  // ============================================================
  // UI helpers
  // ============================================================
  function showProgress(text, pct, sub) {
    progressEl.classList.remove('hidden');
    progressText.textContent = text;
    progressSub.textContent = sub || '';
    if (pct == null) {
      progressBar.classList.add('indeterminate');
      progressFill.style.width = '';
    } else {
      progressBar.classList.remove('indeterminate');
      progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`;
    }
  }
  function hideProgress() { progressEl.classList.add('hidden'); }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    retryRow.classList.remove('hidden');
    statusEl.textContent = '';
  }
  function hideError() {
    errorEl.classList.add('hidden');
    retryRow.classList.add('hidden');
  }
  function setBusyUI(on) {
    downloadBtn.disabled = on || !mask;
    copyBtn.disabled = on || !mask;
    modelSel.disabled = on;
    // Keep the "New image" button enabled so the user can always bail out.
  }

  function setOutMode(mode) {
    outMode = mode;
    [...outModeSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    colorRow.classList.toggle('dimmed', mode !== 'color');
    compose();
  }
  function setFillColor(hex, fromSwatch) {
    fillColor = hex.toLowerCase();
    fillInput.value = fillColor;
    fillHex.textContent = fillColor.toUpperCase();
    [...swatches.children].forEach((b) => b.classList.toggle('active', b.dataset.color === fillColor));
    if (outMode !== 'color') setOutMode('color'); else compose();
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
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
    }
  });

  resetBtn.addEventListener('click', () => {
    jobId++;                 // cancel any in-flight job
    busy = false;
    hideProgress(); hideError();
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    srcData = null; srcCanvas = null; mask = null; cutout = null;
    setBusyUI(false);
  });

  outModeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setOutMode(btn.dataset.mode);
  });
  swatches.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-color]');
    if (btn) setFillColor(btn.dataset.color, true);
  });
  fillInput.addEventListener('input', () => setFillColor(fillInput.value));

  shrinkIn.addEventListener('input',  () => { shrinkVal.textContent = shrinkIn.value; scheduleRebuild(); });
  featherIn.addEventListener('input', () => { featherVal.textContent = featherIn.value; scheduleRebuild(); });
  modelSel.addEventListener('change', () => { if (srcData) runRemoval(); });
  retryBtn.addEventListener('click', () => { attempt++; forceCpu = false; runRemoval(); });

  // Hold to compare with the original.
  const startCompare = (e) => {
    if (!srcCanvas || !cutout) return;
    e.preventDefault();
    comparing = true;
    compareBtn.classList.add('armed');
    ctx.clearRect(0, 0, srcW, srcH);
    ctx.drawImage(srcCanvas, 0, 0);
  };
  const stopCompare = () => {
    if (!comparing) return;
    comparing = false;
    compareBtn.classList.remove('armed');
    compose();
  };
  compareBtn.addEventListener('pointerdown', startCompare);
  compareBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') startCompare(e); });
  compareBtn.addEventListener('keyup', stopCompare);
  window.addEventListener('pointerup', stopCompare);
  window.addEventListener('pointercancel', stopCompare);
  window.addEventListener('blur', stopCompare);

  downloadBtn.addEventListener('click', download);
  copyBtn.addEventListener('click', copyToClipboard);

  window.addEventListener('keydown', (e) => {
    if (isActive() && !editor.classList.contains('hidden') && mask && (e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault(); download();
    }
  });

  // Initial UI state
  setOutMode('transparent');
})();
