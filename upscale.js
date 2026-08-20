/* TrimImage — Upscale tab.
 * AI super-resolution with UpscalerJS (MIT) running an ESRGAN/RDN model (MIT)
 * on TensorFlow.js (Apache-2.0). The model is ~3 MB per scale factor and is
 * fetched from jsDelivr on first use, then cached by the browser.
 * Work happens patch by patch with `awaitNextFrame`, so the progress bar keeps
 * painting and the run stays cancellable. Nothing is uploaded. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const UPSCALER_URL = 'https://cdn.jsdelivr.net/npm/upscaler@1.0.0/+esm';
  const MODEL_URL = (s) => `https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/${s}x/+esm`;
  const MAX_OUT_PIXELS = 40e6;   // refuse absurd outputs (memory)
  const SLOW_SRC_PIXELS = 1.2e6; // warn beyond this

  // ---- Elements ----
  const dropzone   = $('upDropzone');
  const fileInput  = $('upFileInput');
  const pickBtn    = $('upPickBtn');
  const editor     = $('upEditor');
  const canvas     = $('upCanvas');
  const ctx        = canvas.getContext('2d');
  const resetBtn   = $('upResetBtn');
  const compareBtn = $('upCompareBtn');
  const dimsLabel  = $('upDimsLabel');
  const statusEl   = $('upStatus');

  const progressEl   = $('upProgress');
  const progressText = $('upProgressText');
  const progressBar  = $('upProgressBar');
  const progressFill = $('upProgressFill');
  const progressSub  = $('upProgressSub');
  const cancelBtn    = $('upCancelBtn');

  const scaleSeg  = $('upScale');
  const srcDims   = $('upSrcDims');
  const outDims   = $('upOutDims');
  const pixelsEl  = $('upPixels');
  const warnEl    = $('upWarn');
  const runBtn    = $('upRunBtn');
  const formatSel = $('upFormat');
  const downloadBtn = $('upDownloadBtn');
  const copyBtn     = $('upCopyBtn');
  const errorEl     = $('upError');

  // ---- State ----
  let srcCanvas = null, srcW = 0, srcH = 0;
  let outCanvas = null;          // AI result
  let refCanvas = null;          // plain bicubic resize, for comparison
  let scale = 2;
  let busy = false, comparing = false;
  let controller = null;         // AbortController for the current run
  let lastFileName = 'image';
  const upscalers = new Map();   // scale -> Upscaler instance (model stays loaded)
  let UpscalerCtor = null;

  const isActive = () => document.body.dataset.tab === 'upscale';

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
    srcW = img.naturalWidth || img.width;
    srcH = img.naturalHeight || img.height;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW; srcCanvas.height = srcH;
    srcCanvas.getContext('2d').drawImage(img, 0, 0);

    outCanvas = null; refCanvas = null;
    canvas.width = srcW; canvas.height = srcH;
    ctx.drawImage(srcCanvas, 0, 0);

    dimsLabel.textContent = `${srcW} × ${srcH}`;
    hideError();
    statusEl.textContent = 'Pick a scale, then press “Upscale image”.';
    compareBtn.disabled = true;
    downloadBtn.disabled = true;
    copyBtn.disabled = true;
    updateSizes();

    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
  }

  function updateSizes() {
    if (!srcCanvas) return;
    const ow = srcW * scale, oh = srcH * scale;
    const outPx = ow * oh;
    srcDims.textContent = `${srcW} × ${srcH}`;
    outDims.textContent = `${ow} × ${oh}`;
    pixelsEl.textContent = `${(outPx / 1e6).toFixed(1)} MP`;

    if (outPx > MAX_OUT_PIXELS) {
      warnEl.innerHTML = `<b>Too large.</b> ${(outPx / 1e6).toFixed(0)} MP would likely run out of memory — use a smaller scale, or crop the image first.`;
      warnEl.className = 'error';
      runBtn.disabled = true;
    } else if (srcW * srcH > SLOW_SRC_PIXELS) {
      warnEl.textContent = `This is a large source image — upscaling may take a few minutes. Small images (under ~1000 px) work best.`;
      warnEl.className = 'muted';
      runBtn.disabled = busy;
    } else {
      warnEl.textContent = '';
      warnEl.className = 'muted';
      runBtn.disabled = busy;
    }
  }

  // ============================================================
  // Upscaling
  // ============================================================
  async function getUpscaler(s) {
    if (upscalers.has(s)) return upscalers.get(s);
    showProgress('Loading AI engine…', null, 'Fetching TensorFlow.js and the model');
    if (!UpscalerCtor) {
      const mod = await import(UPSCALER_URL);
      UpscalerCtor = mod.default || mod.Upscaler;
    }
    const model = (await import(MODEL_URL(s))).default;
    const inst = new UpscalerCtor({ model });
    upscalers.set(s, inst);
    return inst;
  }

  async function run() {
    if (!srcCanvas || busy) return;
    busy = true;
    setBusyUI(true);
    hideError();
    controller = new AbortController();
    const t0 = performance.now();

    try {
      const up = await getUpscaler(scale);
      showProgress('Upscaling…', 0, `${srcW} × ${srcH} → ${srcW * scale} × ${srcH * scale}`);

      const dataUrl = await up.upscale(srcCanvas, {
        output: 'base64',
        patchSize: 128,
        padding: 6,
        awaitNextFrame: true,          // yield between patches so the UI stays alive
        signal: controller.signal,
        progress: (rate) => {
          showProgress('Upscaling…', rate,
            `${Math.round(rate * 100)}% · ${srcW * scale} × ${srcH * scale}`);
        },
      });

      const img = await loadImage(dataUrl);
      outCanvas = document.createElement('canvas');
      outCanvas.width = img.naturalWidth; outCanvas.height = img.naturalHeight;
      outCanvas.getContext('2d').drawImage(img, 0, 0);

      // plain high-quality resize at the same size, for the compare button
      refCanvas = document.createElement('canvas');
      refCanvas.width = outCanvas.width; refCanvas.height = outCanvas.height;
      const rc = refCanvas.getContext('2d');
      rc.imageSmoothingEnabled = true;
      rc.imageSmoothingQuality = 'high';
      rc.drawImage(srcCanvas, 0, 0, refCanvas.width, refCanvas.height);

      canvas.width = outCanvas.width; canvas.height = outCanvas.height;
      ctx.drawImage(outCanvas, 0, 0);
      dimsLabel.textContent = `${outCanvas.width} × ${outCanvas.height}`;

      hideProgress();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      statusEl.textContent = `Upscaled ${scale}× in ${secs} s — hold “compare” to see it against a plain resize.`;
      compareBtn.disabled = false;
      downloadBtn.disabled = false;
      copyBtn.disabled = false;
    } catch (e) {
      hideProgress();
      const msg = String(e && e.message || e);
      if (/abort/i.test(msg)) {
        statusEl.textContent = 'Cancelled.';
      } else {
        console.error(e);
        showError(/fetch|network|import|Failed to fetch/i.test(msg)
          ? 'Could not download the AI model. Check your connection and try again.'
          : /memory|allocat/i.test(msg)
            ? 'Ran out of memory — try a smaller scale or a smaller image.'
            : 'Upscaling failed: ' + msg);
      }
    } finally {
      busy = false; controller = null;
      setBusyUI(false);
      updateSizes();
    }
  }

  const loadImage = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

  // ============================================================
  // Export
  // ============================================================
  function renderOutput(type) {
    if (!outCanvas) return null;
    if (type !== 'image/jpeg') return outCanvas;
    const flat = document.createElement('canvas');
    flat.width = outCanvas.width; flat.height = outCanvas.height;
    const c = flat.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, flat.width, flat.height);
    c.drawImage(outCanvas, 0, 0);
    return flat;
  }

  function download() {
    const type = formatSel.value;
    const out = renderOutput(type);
    if (!out) return;
    const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
    out.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${lastFileName}-${scale}x.${ext}`;
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
  const hideProgress = () => progressEl.classList.add('hidden');
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    statusEl.textContent = '';
  }
  const hideError = () => errorEl.classList.add('hidden');
  function setBusyUI(on) {
    runBtn.disabled = on;
    runBtn.textContent = on ? 'Working…' : '✨ Upscale image';
    [...scaleSeg.children].forEach((b) => (b.disabled = on));
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

  scaleSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || busy) return;
    scale = +btn.dataset.s;
    [...scaleSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    updateSizes();
  });

  runBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', () => { if (controller) controller.abort(); });

  resetBtn.addEventListener('click', () => {
    if (controller) controller.abort();
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    srcCanvas = null; outCanvas = null; refCanvas = null;
    hideProgress(); hideError();
  });

  const startCompare = (e) => {
    if (!refCanvas || !outCanvas) return;
    e.preventDefault();
    comparing = true;
    compareBtn.classList.add('armed');
    ctx.drawImage(refCanvas, 0, 0);
  };
  const stopCompare = () => {
    if (!comparing) return;
    comparing = false;
    compareBtn.classList.remove('armed');
    ctx.drawImage(outCanvas, 0, 0);
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
    if (!isActive() || editor.classList.contains('hidden') || !outCanvas) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); }
  });
})();
