# TrimImage background-removal API

Runs IS-Net segmentation on the server so phones don't download a 44–176 MB model
over mobile data. The browser sends an image, gets back a PNG with an alpha channel,
and the existing edge refinement (shrink / feather / background colour) still runs
client-side on that mask.

The front end keeps both paths: **On our server** (default when this API answers)
and **In my browser** (fully local, nothing uploaded). If the API is unreachable the
UI silently falls back to the in-browser path — deploying this is optional.

## What it is

- `app.py` — FastAPI service, one endpoint plus a health check
- `fetch_model.py` — downloads the weights once at deploy time and assembles them
- `requirements.txt`, `trimimage.service`, `nginx.conf.example`

Licensing: only `onnxruntime` (MIT) and the IS-Net weights (MIT; upstream DIS code
Apache-2.0). **No AGPL code runs on the server** — the AGPL library is only used by
the optional in-browser path.

## Install

```bash
sudo mkdir -p /opt/trimimage && cd /opt/trimimage
sudo git clone https://github.com/jakirseu/trim_image.git repo
sudo cp -r repo/server ./server

python3 -m venv venv
./venv/bin/pip install -r server/requirements.txt

# fetch the weights (44 MB "small" is the recommended default)
./venv/bin/python server/fetch_model.py small

sudo chown -R www-data:www-data /opt/trimimage
sudo cp server/trimimage.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now trimimage
curl -s localhost:8000/api/health
```

Then point nginx at it — see `nginx.conf.example` for the `/api/` proxy block,
the upload size limit and the timeouts.

## Model tiers

| Tier | File | Size | Notes |
|---|---|---|---|
| `small` | `isnet_quint8.onnx` | 44 MB | quantised — fastest, the sensible default |
| `medium` | `isnet_fp16.onnx` | 88 MB | half precision |
| `large` | `isnet.onnx` | 176 MB | full precision, slowest |

Switch with `TRIMIMAGE_MODEL=isnet_fp16.onnx` in the unit file after fetching it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TRIMIMAGE_MODEL` | `isnet_quint8.onnx` | which weights to load |
| `TRIMIMAGE_MODEL_DIR` | `./models` | where they live |
| `TRIMIMAGE_MAX_UPLOAD_MB` | `12` | rejects larger uploads with 413 |
| `TRIMIMAGE_MAX_EDGE` | `4000` | downscales huge images before inference |
| `TRIMIMAGE_MAX_CONCURRENCY` | `2` | simultaneous inferences; excess requests wait, then 503 |
| `TRIMIMAGE_THREADS` | all cores | ONNX Runtime intra-op threads |
| `TRIMIMAGE_TIMEOUT` | `120` | seconds before a job is abandoned (504) |
| `TRIMIMAGE_ORIGINS` | same-origin only | comma-separated CORS origins, if you serve the API from another host |

## Capacity

Inference is CPU-bound and takes roughly **3 s per image per core-pair** — measured
at 3.4 s for a 900×1200 photo on an Apple M-series core. On a 2-vCPU VPS expect
5–15 s per image with `MAX_CONCURRENCY=2`; beyond that, requests queue and then
return 503 rather than thrashing the box. Size the VPS to your traffic, or leave
the in-browser path as the default for desktop users.

## Endpoints

```
GET  /api/health              -> {"status":"ok","model":...,"concurrency":2}
POST /api/remove-background   multipart field "image" -> image/png (RGBA)
```

Responses carry `X-Process-Ms` and `X-Image-Size`, and `Cache-Control: no-store`
so no intermediary retains a user's photo. Uploads are held in memory for the
duration of the request only — nothing is written to disk.
