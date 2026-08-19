# ✂️ TrimImage

Four image tools that run **entirely in your browser** — trim empty space, crop to any aspect ratio,
remove a portrait's background with AI, or erase a colour into transparency. No uploads, no accounts,
no server.

**Live at [imagetrimmer.com](https://imagetrimmer.com)**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-orange.svg)](LICENSE)
![No build step](https://img.shields.io/badge/build-none-brightgreen)
![Runs client-side](https://img.shields.io/badge/processing-100%25%20client--side-blue)

---

## Tools

### ✂️ Trim image
Crops away the uniform border around an image — the equivalent of Photoshop's *Image → Trim*.

![Trim image](docs/screenshot-trim.png)

- **Auto** background detection (samples the four corners), or trim by **transparency** or a **specific colour**
- **Eyedropper** to pick the background colour straight off the image
- **Tolerance** slider for noisy or JPEG-compressed edges
- **Padding** to keep a margin around the result
- Live preview of the crop, with original/trimmed/removed stats
- Export as PNG, JPG or WEBP, or copy to clipboard

### ⛶ Crop
Draw a selection and cut it out — pixel exact.

- Drag to draw, drag inside to move, **8 handles** to resize — everything clamped to the image
- **Aspect ratio presets** — Free, Original, 1:1, 4:3, 3:2, 16:9, 3:4, 2:3, 9:16 — held through every resize
- **Numeric W/H/X/Y inputs** for exact values, plus *Select all* and *Center 80%*
- **Rotate** 90° either way and **flip** horizontally or vertically
- Rule-of-thirds guides, arrow-key nudging (Shift for 10 px), Esc to reset
- Export as PNG, JPG or WEBP, or copy to clipboard

### 🪄 Remove background
AI portrait cutout, running locally on your device. Keep the result transparent or drop in a solid colour.

![Remove background](docs/screenshot-remove-bg.png)

- Segmentation with the **IS-Net** model via ONNX Runtime — **WebGPU** when available, WebAssembly otherwise, with automatic fallback
- **Transparent** or **solid colour** background, with 10 presets (incl. passport blue) plus a custom colour picker
- **Shrink edge** to remove leftover fringe from the old background, **feather edge** to blend into the new one
- Three quality tiers (44 / 88 / 176 MB models) — the model downloads once and is cached by your browser
- **Hold to compare** against the original
- Export as PNG, JPG or WEBP, or copy to clipboard

> The photo never leaves your device — only the model travels, and it travels *to* you.

### 🧽 Erase colour
Click a colour to make it transparent, or wipe pixels away by hand with a round eraser.

![Erase colour](docs/screenshot-erase.png)

- **Click to sample** any colour and erase it instantly
- **Intensity** controls how wide a range of similar colours counts as "the same colour" — re-tunable live, without stacking mistakes
- **Edge softness** fades near-matching pixels instead of cutting hard, which keeps anti-aliased logos clean
- **Whole image** or **connected only** (flood fill) — erase one region and keep the same colour elsewhere
- **Round brush** with size and hardness, plus a **restore** mode to paint erased pixels back in
- Full **undo/redo** (⌘/Ctrl+Z, ⌘/Ctrl+⇧+Z), checker/white/black preview backgrounds
- Export as PNG or WEBP, or copy to clipboard

---

## Privacy

Every tool processes pixels locally with the HTML canvas API. Nothing is uploaded, stored or tracked.
The only network request any tool makes is the one-time download of the segmentation model used by
**Remove background** — and that request only ever carries the model *to* your browser.

---

## How it works

**Trim** reads the image into an offscreen canvas, picks a reference background colour (corner average,
alpha, or a chosen colour), then scans inward from each edge for the first row/column containing a pixel
whose weighted RGB distance from that reference exceeds the tolerance. The result is a tight content
bounding box, expanded by the padding value.

**Remove background** hands the decoded pixels straight to the model as a raw RGBA buffer (no PNG
round-trip). The network runs at 1024×1024 internally; the resulting alpha mask is bilinearly upscaled
back to full resolution, then refined:

- *Shrink* is a separable running-minimum erosion (van Herk / Gil-Werman), **O(1) per pixel** regardless of radius
- *Feather* is two passes of a separable box blur, approximating a gaussian

**Erase colour** keeps an 8-bit alpha multiplier per pixel, so every operation is non-destructive and
undoable — the source image is never modified. Colour erasing compares squared RGB distance against
inner/outer thresholds derived from intensity and softness, with an early-out on the common case.
"Connected only" is a scanline flood fill. Brush strokes are interpolated along the drag path and
composited through a dirty-rect so only the touched region is repainted.

### Measured performance

On a 12 MP (4000×3000) image:

| Operation | Time |
|---|---|
| Colour erase, whole image | ~140 ms |
| Flood fill (connected only) | ~125 ms |
| Brush stroke | ~1 ms per pointer move |
| Mask erode / feather | ~120 ms |

Background removal depends on hardware and quality tier — roughly 7–8 s for the *Fast* model on WebGPU,
plus the one-time model download.

---

## Run locally

No build step, no dependencies to install — it's static files. Serve the folder over HTTP (needed so the
browser will load the ES modules and the model):

```bash
git clone https://github.com/jakirseu/trim_image.git
cd trim_image
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly via `file://` mostly works, but the **Remove background** tab needs HTTP.

## Deploying

Any static host works — copy the files as they are. Two optional improvements:

1. **Faster CPU inference.** Serve with these headers so ONNX Runtime can use multiple threads
   (without them it silently falls back to single-threaded):

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

2. **Self-host the model.** By default the weights and WASM come from IMG.LY's CDN, who
   [recommend self-hosting for production](https://github.com/imgly/background-removal-js#custom-asset-serving).
   Download `https://staticimgly.com/@imgly/background-removal-data/1.7.0/package.tgz`, serve the
   contents of `package/dist`, and set `publicPath` in the config in [`bgremove.js`](bgremove.js).

## Project structure

| File | Purpose |
|---|---|
| [`index.html`](index.html) | App shell, tab bar, and the three tool panels |
| [`app.js`](app.js) | Tab switching + the Trim tool |
| [`crop.js`](crop.js) | Crop selection, aspect ratios, rotate/flip |
| [`bgremove.js`](bgremove.js) | AI background removal (model loading, mask refinement, compositing) |
| [`eraser.js`](eraser.js) | Colour eraser, flood fill, brush, undo/redo |
| [`styles.css`](styles.css) | All styling |
| [`credits.html`](credits.html) | Credits & licenses page |

## Browser support

Needs a modern browser with Canvas 2D and ES module support. WebGPU is used for background removal
when the browser exposes it, and falls back to WebAssembly automatically. Clipboard copy requires
`ClipboardItem` support.

---

## Credits

Full attribution lives on the [credits page](credits.html). The **Trim**, **Crop** and **Erase colour**
tools use no third-party code; **Remove background** builds on:

| Component | Author | License |
|---|---|---|
| [@imgly/background-removal](https://github.com/imgly/background-removal-js) v1.7.0 | IMG.LY GmbH | AGPL-3.0 |
| [IS-Net (DIS)](https://github.com/xuebinqin/DIS) segmentation model | Xuebin Qin et al. | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) v1.21.0 | Microsoft | MIT |
| [ndarray](https://github.com/scijs/ndarray) · [lodash-es](https://lodash.com/) · [zod](https://github.com/colinhacks/zod) | respective authors | MIT |

The segmentation model comes from *Highly Accurate Dichotomous Image Segmentation* (Qin et al., ECCV 2022).

## License

Licensed under the **[GNU AGPL v3](LICENSE)**.

TrimImage depends on `@imgly/background-removal`, which is AGPL-3.0, so the combined work is AGPL-3.0
as well. In practice that means anyone running this over a network must offer their users the complete
corresponding source — which is what this repository is for.

If you want to build on this without that obligation, IMG.LY sells commercial licenses for the
background-removal library (<support@img.ly>); the model itself and ONNX Runtime are permissively licensed.
