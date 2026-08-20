/* TrimImage — Compress tab.
 * Re-encodes one image at a lower quality and/or smaller size, showing the real
 * resulting file size as you drag the slider (the size is measured by actually
 * encoding, not estimated). "Fit to target" binary-searches quality to land under
 * a size you choose. All local; re-encoding also strips EXIF, GPS included. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropzone   = $('cpDropzone');
  const fileInput  = $('cpFileInput');
  const pickBtn    = $('cpPickBtn');
  const editor     = $('cpEditor');
  const canvas     = $('cpCanvas');
  const ctx        = canvas.getContext('2d');
  const resetBtn   = $('cpResetBtn');
  const compareBtn = $('cpCompareBtn');
  const dimsLabel  = $('cpDimsLabel');
  const statusEl   = $('cpStatus');

  const formatSeg  = $('cpFormat');
  const qualityRow = $('cpQualityRow');
  const qualityIn  = $('cpQuality');
  const qualityVal = $('cpQualityVal');
  const scaleIn    = $('cpScale');
  const scaleVal   = $('cpScaleVal');
  const targetIn   = $('cpTarget');
  const fitBtn     = $('cpFitBtn');
  const origSize   = $('cpOrigSize');
  const newSize    = $('cpNewSize');
  const savedEl    = $('cpSaved');
  const outDims    = $('cpOutDims');
  const downloadBtn= $('cpDownloadBtn');
  const copyBtn    = $('cpCopyBtn');
  const noteEl     = $('cpNote');

  let bitmap = null, srcW = 0, srcH = 0, srcSize = 0, srcType = '';
  let lastFileName = 'image';
  let format = 'keep';
  let outBlob = null;
  let busy = false, comparing = false;
  let timer = 0;

  const isActive = () => document.body.dataset.tab === 'compress';
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif' };
  const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
  const kb = (n) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(2)} MB`;
  const outType = () => (format === 'keep' ? (EXT[srcType] ? srcType : 'image/jpeg') : format);

  async function supportedFormats() {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    c.getContext('2d').fillRect(0, 0, 8, 8);
    const ok = [];
    for (const t of ['image/jpeg', 'image/webp', 'image/avif', 'image/png']) {
      const b = await new Promise((r) => c.toBlob(r, t, 0.8));
      if (b && b.type === t) ok.push(t);
    }
    return ok;
  }

  async function initFormats() {
    const ok = await supportedFormats();
    [...formatSeg.children].forEach((b) => {
      if (b.dataset.f !== 'keep' && !ok.includes(b.dataset.f)) b.remove();
    });
  }

  // ============================================================
  // Loading
  // ============================================================
  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    lastFileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    srcSize = file.size; srcType = file.type;
    try {
      bitmap = await createImageBitmap(file);
    } catch { alert('Could not read that image.'); return; }
    srcW = bitmap.width; srcH = bitmap.height;

    dimsLabel.textContent = `${srcW} × ${srcH}`;
    origSize.textContent = kb(srcSize);
    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    scaleIn.value = 100; scaleVal.textContent = '100';
    encode();
  }

  // ============================================================
  // Encoding
  // ============================================================
  function targetCanvas() {
    const s = +scaleIn.value / 100;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(srcW * s));
    c.height = Math.max(1, Math.round(srcH * s));
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    if (outType() === 'image/jpeg') { x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); }
    x.drawImage(bitmap, 0, 0, c.width, c.height);
    return c;
  }

  const encodeAt = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

  async function encode() {
    if (!bitmap || busy) return;
    busy = true;
    statusEl.textContent = 'Compressing…';
    const type = outType();
    const lossy = LOSSY.has(type);
    qualityRow.classList.toggle('dimmed', !lossy);
    noteEl.textContent = lossy ? '' : 'PNG is lossless — quality has no effect. Use the size slider, or switch to WEBP for a smaller lossless file.';

    const c = targetCanvas();
    outBlob = await encodeAt(c, type, +qualityIn.value / 100);
    paint(c);
    show(c);
    busy = false;
    statusEl.textContent = '';
  }

  async function paint(c) {
    // Draw the actual decoded output so compression artefacts are visible.
    if (comparing) return;
    try {
      const bmp = await createImageBitmap(outBlob);
      canvas.width = bmp.width; canvas.height = bmp.height;
      ctx.drawImage(bmp, 0, 0);
    } catch {
      canvas.width = c.width; canvas.height = c.height;
      ctx.drawImage(c, 0, 0);
    }
  }

  function show(c) {
    newSize.textContent = kb(outBlob.size);
    outDims.textContent = `${c.width} × ${c.height}`;
    const pct = ((outBlob.size - srcSize) / srcSize) * 100;
    savedEl.textContent = `${pct <= 0 ? '−' : '+'}${Math.abs(pct).toFixed(0)}%`;
    savedEl.className = pct <= 0 ? 'good' : 'bad';
    downloadBtn.disabled = false;
    copyBtn.disabled = false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(encode, 220);
  }

  // Binary-search quality until the file lands under the requested size.
  async function fitToTarget() {
    const targetKB = +targetIn.value;
    if (!bitmap || !targetKB) return;
    const type = outType();
    if (!LOSSY.has(type)) { noteEl.textContent = 'Pick JPEG or WEBP to compress to a target size.'; return; }
    busy = true;
    fitBtn.disabled = true;
    const target = targetKB * 1024;
    const c = targetCanvas();
    let lo = 0.05, hi = 0.98, best = null, bestQ = 0.05;
    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      statusEl.textContent = `Fitting to ${targetKB} KB… (${i + 1}/8)`;
      const b = await encodeAt(c, type, q);
      if (b.size <= target) { best = b; bestQ = q; lo = q; } else { hi = q; }
      await new Promise((r) => requestAnimationFrame(r));
    }
    busy = false;
    fitBtn.disabled = false;
    if (!best) {
      statusEl.textContent = '';
      noteEl.textContent = `Even at the lowest quality this image won't fit in ${targetKB} KB — reduce the size as well.`;
      return;
    }
    noteEl.textContent = '';
    qualityIn.value = Math.round(bestQ * 100);
    qualityVal.textContent = qualityIn.value;
    outBlob = best;
    await paint(c);
    show(c);
    statusEl.textContent = `Landed at ${kb(best.size)} with quality ${qualityIn.value}.`;
  }

  // ============================================================
  // Export
  // ============================================================
  function download() {
    if (!outBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(outBlob);
    a.download = `${lastFileName}-compressed.${EXT[outType()] || 'img'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyToClipboard() {
    if (!outBlob || !navigator.clipboard || !window.ClipboardItem) {
      alert('Clipboard copy not supported in this browser.');
      return;
    }
    try {
      // Clipboard only reliably takes PNG, so re-encode for the copy.
      const png = await encodeAt(targetCanvas(), 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      copyBtn.textContent = '✓ Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy to clipboard'), 1500);
    } catch { alert('Could not copy to clipboard.'); }
  }

  // ============================================================
  // Events
  // ============================================================
  pickBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  window.addEventListener('paste', (e) => {
    if (!isActive()) return;
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
    }
  });

  formatSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    format = btn.dataset.f;
    [...formatSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    schedule();
  });
  qualityIn.addEventListener('input', () => { qualityVal.textContent = qualityIn.value; schedule(); });
  scaleIn.addEventListener('input', () => { scaleVal.textContent = scaleIn.value; schedule(); });
  fitBtn.addEventListener('click', fitToTarget);
  targetIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') fitToTarget(); });

  resetBtn.addEventListener('click', () => {
    bitmap = null; outBlob = null;
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
  });

  const startCompare = (e) => {
    if (!bitmap) return;
    e.preventDefault();
    comparing = true;
    compareBtn.classList.add('armed');
    canvas.width = srcW; canvas.height = srcH;
    ctx.drawImage(bitmap, 0, 0);
  };
  const stopCompare = () => {
    if (!comparing) return;
    comparing = false;
    compareBtn.classList.remove('armed');
    encode();
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
    if (!isActive() || editor.classList.contains('hidden') || !outBlob) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); }
  });

  initFormats();
})();
