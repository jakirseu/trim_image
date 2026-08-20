/* TrimImage — Convert tab.
 * Re-encodes images into another format, several at a time. Everything happens
 * through the canvas, so nothing is uploaded — and as a side effect every scrap
 * of EXIF metadata (including GPS coordinates) is dropped from the output. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropzone   = $('cvDropzone');
  const fileInput  = $('cvFileInput');
  const pickBtn    = $('cvPickBtn');
  const editor     = $('cvEditor');
  const listEl     = $('cvList');
  const resetBtn   = $('cvResetBtn');
  const summaryEl  = $('cvSummary');
  const formatSeg  = $('cvFormat');
  const qualityRow = $('cvQualityRow');
  const qualityIn  = $('cvQuality');
  const qualityVal = $('cvQualityVal');
  const matteRow   = $('cvMatteRow');
  const matteIn    = $('cvMatte');
  const downloadAll= $('cvDownloadAll');
  const addMoreBtn = $('cvAddMore');

  let items = [];          // { file, name, bitmap, w, h, hasAlpha, blob, busy }
  let format = 'image/jpeg';
  let rerunTimer = 0;

  const isActive = () => document.body.dataset.tab === 'convert';
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif' };
  const LOSSY = new Set(['image/jpeg', 'image/webp', 'image/avif']);
  const kb = (n) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(2)} MB`;

  // Only advertise formats this browser can actually produce.
  async function supportedFormats() {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    c.getContext('2d').fillRect(0, 0, 8, 8);
    const ok = [];
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) {
      const b = await new Promise((r) => c.toBlob(r, t, 0.8));
      if (b && b.type === t) ok.push(t);
    }
    return ok;
  }

  async function initFormats() {
    const ok = await supportedFormats();
    [...formatSeg.children].forEach((b) => {
      if (!ok.includes(b.dataset.f)) b.remove();
    });
    if (!formatSeg.querySelector('.active') && formatSeg.firstElementChild) {
      formatSeg.firstElementChild.classList.add('active');
      format = formatSeg.firstElementChild.dataset.f;
    }
    applyFormatUI();
  }

  function applyFormatUI() {
    qualityRow.classList.toggle('hidden', !LOSSY.has(format));
    // JPEG has no alpha channel, so transparent pixels need something behind them.
    const needsMatte = format === 'image/jpeg' && items.some((i) => i.hasAlpha);
    matteRow.classList.toggle('hidden', !needsMatte);
  }

  // ============================================================
  // Loading
  // ============================================================
  async function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');

    for (const file of list) {
      const item = {
        file,
        name: (file.name || 'image').replace(/\.[^.]+$/, '') || 'image',
        srcType: file.type, srcSize: file.size,
        bitmap: null, blob: null, busy: true, error: null,
      };
      items.push(item);
      render();
      try {
        item.bitmap = await createImageBitmap(file);
        item.w = item.bitmap.width; item.h = item.bitmap.height;
        item.hasAlpha = /png|webp|gif|avif/i.test(file.type);
      } catch {
        item.error = 'Could not read this file';
        item.busy = false;
      }
      render();
    }
    applyFormatUI();
    convertAll();
  }

  // ============================================================
  // Conversion
  // ============================================================
  function draw(item) {
    const c = document.createElement('canvas');
    c.width = item.w; c.height = item.h;
    const x = c.getContext('2d');
    if (format === 'image/jpeg') {                 // flatten onto the matte colour
      x.fillStyle = matteIn.value;
      x.fillRect(0, 0, c.width, c.height);
    }
    x.drawImage(item.bitmap, 0, 0);
    return c;
  }

  async function convertOne(item) {
    if (!item.bitmap) return;
    item.busy = true; render();
    const q = +qualityIn.value / 100;
    const canvas = draw(item);
    item.blob = await new Promise((r) => canvas.toBlob(r, format, q));
    item.busy = false;
    render();
  }

  async function convertAll() {
    for (const item of items) await convertOne(item);
    renderSummary();
  }

  function scheduleConvert() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(convertAll, 200);
  }

  // ============================================================
  // Rendering
  // ============================================================
  function render() {
    listEl.innerHTML = '';
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const delta = item.blob
        ? ((item.blob.size - item.srcSize) / item.srcSize) * 100
        : null;
      const deltaTxt = delta === null ? ''
        : `<span class="delta ${delta <= 0 ? 'down' : 'up'}">${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(0)}%</span>`;
      row.innerHTML = `
        <div class="file-main">
          <div class="file-name" title="${item.name}">${item.name}.${EXT[format] || 'img'}</div>
          <div class="file-meta">
            ${item.w ? `${item.w} × ${item.h} · ` : ''}${kb(item.srcSize)}
            ${item.blob ? `→ <b>${kb(item.blob.size)}</b> ${deltaTxt}` : ''}
            ${item.error ? `<span class="err-text">${item.error}</span>` : ''}
          </div>
        </div>
        <div class="file-actions"></div>`;
      const actions = row.querySelector('.file-actions');
      if (item.busy) {
        const s = document.createElement('span');
        s.className = 'mini-spinner';
        actions.appendChild(s);
      } else if (item.blob) {
        const b = document.createElement('button');
        b.className = 'btn btn-ghost btn-sm';
        b.textContent = '⬇';
        b.title = 'Download';
        b.addEventListener('click', () => saveItem(item));
        actions.appendChild(b);
      }
      const rm = document.createElement('button');
      rm.className = 'btn btn-ghost btn-sm';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.addEventListener('click', () => { items.splice(i, 1); render(); renderSummary(); applyFormatUI(); });
      actions.appendChild(rm);
      listEl.appendChild(row);
    });
    downloadAll.disabled = !items.some((i) => i.blob);
  }

  function renderSummary() {
    const done = items.filter((i) => i.blob);
    if (!done.length) { summaryEl.textContent = ''; return; }
    const before = done.reduce((a, i) => a + i.srcSize, 0);
    const after = done.reduce((a, i) => a + i.blob.size, 0);
    const pct = ((after - before) / before) * 100;
    summaryEl.textContent =
      `${done.length} image${done.length > 1 ? 's' : ''} · ${kb(before)} → ${kb(after)} `
      + `(${pct <= 0 ? '−' : '+'}${Math.abs(pct).toFixed(0)}%)`;
  }

  function saveItem(item) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(item.blob);
    a.download = `${item.name}.${EXT[format] || 'img'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Browsers rate-limit rapid-fire downloads, so space them out a little.
  async function saveAll() {
    for (const item of items.filter((i) => i.blob)) {
      saveItem(item);
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  // ============================================================
  // Events
  // ============================================================
  const openPicker = () => fileInput.click();
  pickBtn.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  addMoreBtn.addEventListener('click', openPicker);
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
  fileInput.addEventListener('change', (e) => { addFiles(e.target.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  editor.addEventListener('dragover', (e) => e.preventDefault());
  editor.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  window.addEventListener('paste', (e) => {
    if (!isActive()) return;
    const imgs = [...(e.clipboardData?.items || [])]
      .filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (imgs.length) addFiles(imgs);
  });

  formatSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    format = btn.dataset.f;
    [...formatSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
    applyFormatUI();
    render();
    scheduleConvert();
  });
  qualityIn.addEventListener('input', () => { qualityVal.textContent = qualityIn.value; scheduleConvert(); });
  matteIn.addEventListener('input', scheduleConvert);
  downloadAll.addEventListener('click', saveAll);
  resetBtn.addEventListener('click', () => {
    items = [];
    editor.classList.add('hidden');
    dropzone.classList.remove('hidden');
    render(); renderSummary();
  });

  initFormats();
})();
