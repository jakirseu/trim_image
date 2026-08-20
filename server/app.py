"""TrimImage background-removal service.

Runs IS-Net segmentation on the server so phones don't have to download a
44-176 MB model over mobile data. The pipeline mirrors the in-browser one
exactly (bilinear resize to 1024x1024, mean 128 / std 256 normalisation,
BCHW float32, "input" -> "output"), so both paths produce the same cutout.

Only permissively licensed pieces are used: onnxruntime (MIT) and the IS-Net
weights (MIT / upstream Apache-2.0). No AGPL code runs here.

    uvicorn app:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import asyncio, io, os, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

# ---------------------------------------------------------------- settings
MODEL_DIR   = Path(os.getenv("TRIMIMAGE_MODEL_DIR", Path(__file__).parent / "models"))
MODEL_FILE  = os.getenv("TRIMIMAGE_MODEL", "isnet_fp16.onnx")
MAX_UPLOAD  = int(os.getenv("TRIMIMAGE_MAX_UPLOAD_MB", "12")) * 1024 * 1024
MAX_EDGE    = int(os.getenv("TRIMIMAGE_MAX_EDGE", "4000"))   # cap the returned image
MAX_JOBS    = int(os.getenv("TRIMIMAGE_MAX_CONCURRENCY", "2"))
JOB_TIMEOUT = float(os.getenv("TRIMIMAGE_TIMEOUT", "120"))
ORIGINS     = [o for o in os.getenv("TRIMIMAGE_ORIGINS", "").split(",") if o]

RESOLUTION = 1024          # the network's fixed input size
MEAN, STD = 128.0, 256.0   # must match the browser pipeline

Image.MAX_IMAGE_PIXELS = 80_000_000   # refuse decompression bombs

app = FastAPI(title="TrimImage background removal", version="1.0")
if ORIGINS:
    app.add_middleware(
        CORSMiddleware, allow_origins=ORIGINS,
        allow_methods=["POST", "GET"], allow_headers=["*"],
    )

_session: ort.InferenceSession | None = None
_pool = ThreadPoolExecutor(max_workers=MAX_JOBS)
_slots = asyncio.Semaphore(MAX_JOBS)


def session() -> ort.InferenceSession:
    """Load the model once, lazily, and keep it warm."""
    global _session
    if _session is None:
        path = MODEL_DIR / MODEL_FILE
        if not path.exists():
            # Fall back to whatever tier is actually present rather than 500ing.
            spare = sorted(MODEL_DIR.glob("*.onnx")) if MODEL_DIR.exists() else []
            if not spare:
                raise RuntimeError(f"model missing: {path} — run fetch_model.py first")
            path = spare[0]
            print(f"warning: {MODEL_FILE} not found, using {path.name}", flush=True)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.getenv("TRIMIMAGE_THREADS", "0")) or os.cpu_count() or 2
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
    return _session


# ---------------------------------------------------------------- inference
def infer_alpha(rgb: np.ndarray) -> np.ndarray:
    """RGB uint8 (H, W, 3) -> alpha uint8 (H, W), matching the browser pipeline."""
    h, w = rgb.shape[:2]
    small = np.asarray(
        Image.fromarray(rgb).resize((RESOLUTION, RESOLUTION), Image.BILINEAR),
        dtype=np.float32,
    )
    tensor = ((small - MEAN) / STD).transpose(2, 0, 1)[None]          # 1,3,H,W
    mask = session().run(["output"], {"input": tensor.astype(np.float32)})[0]
    mask = np.clip(mask[0, 0] * 255.0, 0, 255).astype(np.uint8)        # 1024x1024
    return np.asarray(Image.fromarray(mask).resize((w, h), Image.BILINEAR), dtype=np.uint8)


def cutout_png(data: bytes, mask_only: bool = False) -> tuple[bytes, dict]:
    t0 = time.time()
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:                       # noqa: BLE001
        raise HTTPException(415, f"Unsupported or corrupt image: {exc}") from exc

    img = img.convert("RGBA")
    if max(img.size) > MAX_EDGE:                   # keep memory sane
        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

    rgba = np.asarray(img, dtype=np.uint8)
    alpha = infer_alpha(rgba[:, :, :3])

    buf = io.BytesIO()
    if mask_only:
        # Grayscale alpha only. The client already holds the full-resolution image,
        # so shipping colour back is wasted bytes.
        Image.fromarray(alpha, "L").save(buf, format="PNG", optimize=False, compress_level=6)
    else:
        out = rgba.copy()
        out[:, :, 3] = np.minimum(rgba[:, :, 3], alpha)   # respect existing transparency
        Image.fromarray(out, "RGBA").save(buf, format="PNG", optimize=False, compress_level=6)
    return buf.getvalue(), {"w": img.size[0], "h": img.size[1], "ms": int((time.time() - t0) * 1000)}


# ---------------------------------------------------------------- routes
@app.get("/api/health")
async def health():
    present = sorted(p.name for p in MODEL_DIR.glob("*.onnx")) if MODEL_DIR.exists() else []
    return {
        "status": "ok" if present else "model-missing",
        "model": MODEL_FILE if MODEL_FILE in present else (present[0] if present else None),
        "available": present,
        "loaded": _session is not None,
        "maxUploadMB": MAX_UPLOAD // (1024 * 1024),
        "maxEdge": MAX_EDGE,
        "concurrency": MAX_JOBS,
    }


@app.post("/api/remove-background")
async def remove_background(image: UploadFile = File(...), output: str = Form("rgba")):
    data = await image.read()
    if not data:
        raise HTTPException(400, "Empty upload")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"Image larger than {MAX_UPLOAD // (1024*1024)} MB")

    try:
        await asyncio.wait_for(_slots.acquire(), timeout=30)
    except asyncio.TimeoutError:
        raise HTTPException(503, "Server busy — try again in a moment") from None
    try:
        loop = asyncio.get_running_loop()
        mask_only = output == "mask"
        png, meta = await asyncio.wait_for(
            loop.run_in_executor(_pool, cutout_png, data, mask_only), timeout=JOB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(504, "Processing timed out") from None
    finally:
        _slots.release()

    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",          # never cache someone's photo
            "X-Process-Ms": str(meta["ms"]),
            "X-Image-Size": f"{meta['w']}x{meta['h']}",
            "X-Output": "mask" if output == "mask" else "rgba",
            "Access-Control-Expose-Headers": "X-Output, X-Process-Ms, X-Image-Size",
        },
    )
