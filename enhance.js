/* TrimImage — Enhance tab.
 * Tone and colour adjustments plus a histogram-driven auto-fix, all in plain
 * canvas maths. Per-channel work (exposure, highlights/shadows, contrast,
 * brightness, temperature) is baked into three 256-entry lookup tables, so the
 * hot loop is three array reads per pixel; only saturation/vibrance, vignette
 * and sharpening need real per-pixel work.
 * Sliders drive a downscaled proxy for live feedback; export re-runs the exact
 * same pipeline at full resolution. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- Elements ----
  const dropzone   = $('enDropzone');
  const fileInput  = $('enFileInput');
  const pickBtn    = $('enPickBtn');
  const editor     = $('enEditor');
  const canvas     = $('enCanvas');
  const ctx        = canvas.getContext('2d');
  const resetBtn   = $('enResetBtn');
  const compareBtn = $('enCompareBtn');
  const dimsLabel  = $('enDimsLabel');
  const statusEl   = $('enStatus');
  const histCanvas = $('enHist');
  const histCtx    = histCanvas.getContext('2d');

  const autoBtn     = $('enAutoBtn');
  const resetAdjBtn = $('enResetAdjBtn');
  const formatSel   = $('enFormat');
  const downloadBtn = $('enDownloadBtn');
  const copyBtn     = $('enCopyBtn');

  const SLIDERS = ['enExposure','enBrightness','enContrast','enHighlights','enShadows',
                   'enSaturation','enVibrance','enTemperature','enTint','enSharpen','enVignette'];
  const els = {};
  SLIDERS.forEach((id) => { els[id] = $(id); });

  const PREVIEW_MAX = 1400;   // long edge of the live-preview proxy

  // ---- State ----
  let fullData = null;        // ImageData at full resolution
  let fullW = 0, fullH = 0;
  let prevData = null;        // ImageData of the downscaled proxy
  let prevW = 0, prevH = 0;
  let outBuf = null;          // reusable output buffer for the preview
  let scratch = null;         // reusable buffer for the sharpen pass
  let lastFileName = 'image';
  let raf = 0;
  let comparing = false;

  const isActive = () => document.body.dataset.tab === 'enhance';
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function params() {
    return {
      exposure:    +els.enExposure.value,
      brightness:  +els.enBrightness.value,
      contrast:    +els.enContrast.value,
      highlights:  +els.enHighlights.value,
      shadows:     +els.enShadows.value,
      saturation:  +els.enSaturation.value,
      vibrance:    +els.enVibrance.value,
      temperature: +els.enTemperature.value,
      tint:        +els.enTint.value,
      sharpen:     +els.enSharpen.value,
      vignette:    +els.enVignette.value,
    };
  }
  const isNeutral = (p) => SLIDERS.every((id) => +els[id].value === 0);

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
    fullW = img.naturalWidth || img.width;
    fullH = img.naturalHeight || img.height;

    const full = document.createElement('canvas');
    full.width = fullW; full.height = fullH;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(img, 0, 0);
    fullData = fctx.getImageData(0, 0, fullW, fullH);

    // Downscaled proxy for interactive preview.
    const scale = Math.min(1, PREVIEW_MAX / Math.max(fullW, fullH));
    prevW = Math.max(1, Math.round(fullW * scale));
    prevH = Math.max(1, Math.round(fullH * scale));
    const pv = document.createElement('canvas');
    pv.width = prevW; pv.height = prevH;
    const pctx = pv.getContext('2d', { willReadFrequently: true });
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(img, 0, 0, prevW, prevH);
    prevData = pctx.getImageData(0, 0, prevW, prevH);

    outBuf = new Uint8ClampedArray(prevData.data.length);
    scratch = new Uint8ClampedArray(prevData.data.length);

    canvas.width = prevW; canvas.height = prevH;
    dimsLabel.textContent = `${fullW} × ${fullH}`;
    statusEl.textContent = scale < 1
      ? `Preview at ${prevW} × ${prevH} — downloads render at full ${fullW} × ${fullH}`
      : '';

    resetSliders(false);
    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    renderPreview();
  }

  // ============================================================
  // The pipeline
  // ============================================================
  // Per-channel curve: exposure → highlights/shadows → contrast → brightness → temperature.
  function buildLUTs(p) {
    const lutR = new Uint8ClampedArray(256);
    const lutG = new Uint8ClampedArray(256);
    const lutB = new Uint8ClampedArray(256);
    const expo = Math.pow(2, p.exposure / 50);        // ±2 stops
    const k = 1 + p.contrast / 100;                   // contrast gain about mid-grey
    const bright = p.brightness * 1.28;
    const tR = p.temperature * 0.4 - p.tint * 0.2;
    const tG = p.tint * 0.4;
    const tB = -p.temperature * 0.4 - p.tint * 0.2;
    for (let v = 0; v < 256; v++) {
      const x = v / 255;
      let o = v * expo;
      o += p.highlights * 0.6 * x * x;                // acts mostly on the bright end
      o += p.shadows * 0.6 * (1 - x) * (1 - x);       // acts mostly on the dark end
      o = (o - 128) * k + 128;
      o += bright;
      lutR[v] = o + tR;
      lutG[v] = o + tG;
      lutB[v] = o + tB;
    }
    return { lutR, lutG, lutB };
  }

  // Full pipeline. Reads `src` (Uint8ClampedArray), writes into `dst`.
  function applyPipeline(src, dst, w, h, p, scratchBuf) {
    const { lutR, lutG, lutB } = buildLUTs(p);
    const sat = p.saturation / 100;
    const vib = p.vibrance / 100;
    const doSat = sat !== 0 || vib !== 0;
    const vig = p.vignette / 100;
    const cx = w / 2, cy = h / 2;
    const maxD = Math.hypot(cx, cy);

    for (let y = 0, i = 0; y < h; y++) {
      // vignette factor depends only on distance from centre
      const dy = (y + 0.5 - cy);
      for (let x = 0; x < w; x++, i += 4) {
        let r = lutR[src[i]], g = lutG[src[i + 1]], b = lutB[src[i + 2]];

        if (doSat) {
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (sat !== 0) {
            const f = 1 + sat;
            r = luma + (r - luma) * f;
            g = luma + (g - luma) * f;
            b = luma + (b - luma) * f;
          }
          if (vib !== 0) {
            // weight by how unsaturated the pixel already is
            const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            const cur = mx > 0 ? (mx - mn) / mx : 0;
            const f = 1 + vib * (1 - cur);
            r = luma + (r - luma) * f;
            g = luma + (g - luma) * f;
            b = luma + (b - luma) * f;
          }
        }

        if (vig > 0) {
          const dx = (x + 0.5 - cx);
          const d = Math.sqrt(dx * dx + dy * dy) / maxD;
          const t = d < 0.55 ? 0 : (d - 0.55) / 0.45;
          const f = 1 - vig * t * t;
          r *= f; g *= f; b *= f;
        }

        dst[i]     = r;
        dst[i + 1] = g;
        dst[i + 2] = b;
        dst[i + 3] = src[i + 3];
      }
    }

    if (p.sharpen > 0) unsharp(dst, scratchBuf, w, h, p.sharpen / 100);
  }

  // Unsharp mask: 3×3 box blur, then push pixels away from the blurred version.
  function unsharp(buf, tmp, w, h, amount) {
    tmp.set(buf);
    const amt = amount * 1.2;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const j = i + c;
          const sum =
            tmp[j - w * 4 - 4] + tmp[j - w * 4] + tmp[j - w * 4 + 4] +
            tmp[j - 4]         + tmp[j]         + tmp[j + 4] +
            tmp[j + w * 4 - 4] + tmp[j + w * 4] + tmp[j + w * 4 + 4];
          const blur = sum / 9;
          buf[j] = tmp[j] + (tmp[j] - blur) * amt;
        }
      }
    }
  }

  // ============================================================
  // Preview + histogram
  // ============================================================
  function renderPreview() {
    if (!prevData || comparing) return;
    const p = params();
    const t0 = performance.now();
    if (isNeutral(p)) {
      ctx.putImageData(prevData, 0, 0);
      drawHistogram(prevData.data);
    } else {
      applyPipeline(prevData.data, outBuf, prevW, prevH, p, scratch);
      ctx.putImageData(new ImageData(outBuf, prevW, prevH), 0, 0);
      drawHistogram(outBuf);
    }
    const ms = performance.now() - t0;
    if (statusEl.dataset.timing !== 'off') statusEl.title = `preview rendered in ${ms.toFixed(0)} ms`;
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderPreview(); });
  }

  function drawHistogram(data) {
    const bins = new Uint32Array(256);
    // sample for speed on large previews
    const step = data.length > 4 * 400000 ? 8 : 4;
    for (let i = 0; i < data.length; i += step) {
      if (data[i + 3] === 0) continue;
      bins[(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) | 0]++;
    }
    let max = 0;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
    const W = histCanvas.width, H = histCanvas.height;
    histCtx.clearRect(0, 0, W, H);
    if (!max) return;
    histCtx.fillStyle = 'rgba(91,140,255,.45)';
    histCtx.strokeStyle = 'rgba(160,190,255,.9)';
    histCtx.lineWidth = 1;
    histCtx.beginPath();
    histCtx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const y = H - Math.pow(bins[i] / max, 0.42) * (H - 2);
      histCtx.lineTo(i, y);
    }
    histCtx.lineTo(255, H);
    histCtx.closePath();
    histCtx.fill();
    histCtx.stroke();
  }

  // ============================================================
  // Auto-enhance — derive slider positions from the histogram
  // ============================================================
  function autoEnhance() {
    if (!prevData) return;
    const d = prevData.data;
    const bins = new Uint32Array(256);
    let n = 0, sumR = 0, sumG = 0, sumB = 0, sumSat = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      bins[(0.2126 * r + 0.7152 * g + 0.0722 * b) | 0]++;
      sumR += r; sumG += g; sumB += b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sumSat += mx > 0 ? (mx - mn) / mx : 0;
      n++;
    }
    if (!n) return;

    // 1% / 99% percentiles → the black and white points worth stretching to
    const lowCut = n * 0.01, highCut = n * 0.99;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= lowCut) { lo = i; break; } }
    acc = 0;
    for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= highCut) { hi = i; break; } }
    if (hi - lo < 8) { hi = Math.min(255, lo + 8); }

    // out = v*gain + offset, expressed through our contrast/brightness sliders
    const gain = clamp(255 / (hi - lo), 1, 2.2);
    const offset = -lo * gain;
    const contrast = clamp(Math.round((gain - 1) * 100), -100, 100);
    const k = 1 + contrast / 100;
    const brightness = clamp(Math.round((offset - 128 + 128 * k) / 1.28), -100, 100);

    // Grey-world white balance across all three channels. Correcting only the
    // red/blue axis balances R and B but leaves green behind, which just trades
    // a blue cast for a magenta one — so we solve for temperature *and* tint.
    // The offsets are applied after the contrast stretch, which has already
    // multiplied the cast by k, so they scale by k too.
    const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
    const target = (meanR + meanG + meanB) / 3;
    const oR = (target - meanR) * k, oG = (target - meanG) * k;
    // tR = 0.4t - 0.2n, tG = 0.4n  =>  n = 2.5*oG, t = 2.5*oR + 1.25*oG
    const tint = clamp(Math.round(2.5 * oG), -100, 100);
    const temperature = clamp(Math.round(2.5 * oR + 1.25 * oG), -100, 100);

    // lift muted images, and open up shadows when the image is dark
    const meanSat = sumSat / n;
    const vibrance = meanSat < 0.28 ? Math.round((0.28 - meanSat) * 90) : 0;
    const meanLuma = (sumR + sumG + sumB) / (3 * n);
    const shadows = meanLuma < 96 ? Math.round(clamp((96 - meanLuma) * 0.5, 0, 35)) : 0;

    setSliders({ contrast, brightness, temperature, tint, vibrance, shadows, sharpen: 12 });
    statusEl.textContent = `Auto: levels ${lo}–${hi} → 0–255 · white balance ${temperature > 0 ? '+' : ''}${temperature}/${tint > 0 ? '+' : ''}${tint}`;
    renderPreview();
  }

  function setSliders(vals) {
    const map = {
      exposure: 'enExposure', brightness: 'enBrightness', contrast: 'enContrast',
      highlights: 'enHighlights', shadows: 'enShadows', saturation: 'enSaturation',
      vibrance: 'enVibrance', temperature: 'enTemperature', tint: 'enTint',
      sharpen: 'enSharpen', vignette: 'enVignette',
    };
    SLIDERS.forEach((id) => { els[id].value = 0; });
    for (const [key, v] of Object.entries(vals)) {
      const id = map[key];
      if (id) els[id].value = v;
    }
    SLIDERS.forEach((id) => { $(id + 'Val').textContent = els[id].value; });
  }

  function resetSliders(render = true) {
    setSliders({});
    statusEl.textContent = fullW && prevW < fullW
      ? `Preview at ${prevW} × ${prevH} — downloads render at full ${fullW} × ${fullH}`
      : '';
    if (render) renderPreview();
  }

  // ============================================================
  // Export — same pipeline, full resolution
  // ============================================================
  function renderFull(type) {
    const p = params();
    const out = document.createElement('canvas');
    out.width = fullW; out.height = fullH;
    const octx = out.getContext('2d');
    if (isNeutral(p)) {
      octx.putImageData(fullData, 0, 0);
    } else {
      const dst = new Uint8ClampedArray(fullData.data.length);
      const tmp = new Uint8ClampedArray(fullData.data.length);
      applyPipeline(fullData.data, dst, fullW, fullH, p, tmp);
      octx.putImageData(new ImageData(dst, fullW, fullH), 0, 0);
    }
    if (type === 'image/jpeg') {
      // flatten onto white so transparency doesn't turn black
      const flat = document.createElement('canvas');
      flat.width = fullW; flat.height = fullH;
      const fx = flat.getContext('2d');
      fx.fillStyle = '#ffffff'; fx.fillRect(0, 0, fullW, fullH);
      fx.drawImage(out, 0, 0);
      return flat;
    }
    return out;
  }

  function withBusy(btn, label, fn) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    // let the button repaint before we block the thread
    requestAnimationFrame(() => setTimeout(() => {
      try { fn(); } finally { btn.textContent = original; btn.disabled = false; }
    }, 20));
  }

  function download() {
    if (!fullData) return;
    withBusy(downloadBtn, 'Processing…', () => {
      const type = formatSel.value;
      const out = renderFull(type);
      const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
      out.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${lastFileName}-enhanced.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, type, 0.92);
    });
  }

  function copyToClipboard() {
    if (!fullData || !navigator.clipboard || !window.ClipboardItem) {
      alert('Clipboard copy not supported in this browser.');
      return;
    }
    withBusy(copyBtn, 'Processing…', () => {
      renderFull('image/png').toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copyBtn.textContent = '✓ Copied!';
          setTimeout(() => (copyBtn.textContent = 'Copy to clipboard'), 1500);
        } catch { alert('Could not copy to clipboard.'); }
      }, 'image/png');
    });
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

  SLIDERS.forEach((id) => {
    els[id].addEventListener('input', () => {
      $(id + 'Val').textContent = els[id].value;
      schedule();
    });
  });

  autoBtn.addEventListener('click', autoEnhance);
  resetAdjBtn.addEventListener('click', () => resetSliders());

  resetBtn.addEventListener('click', () => {
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    fullData = null; prevData = null;
  });

  const startCompare = (e) => {
    if (!prevData) return;
    e.preventDefault();
    comparing = true;
    compareBtn.classList.add('armed');
    ctx.putImageData(prevData, 0, 0);
  };
  const stopCompare = () => {
    if (!comparing) return;
    comparing = false;
    compareBtn.classList.remove('armed');
    renderPreview();
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
    if (!isActive() || editor.classList.contains('hidden') || !fullData) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); }
  });
})();
