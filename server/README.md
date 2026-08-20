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

Everything lives in `/var/www/imagetrimmer/server`, using the system Python — no
virtualenv. Full walkthrough in [DEPLOY.md](../DEPLOY.md); the short version:

```bash
sudo apt install -y python3-pip
sudo pip3 install --break-system-packages -r /var/www/imagetrimmer/server/requirements.txt

cd /var/www/imagetrimmer
python3 server/fetch_model.py medium         # 88 MB, fetched once

sudo cp server/trimimage.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now trimimage
curl -s localhost:8000/api/health
```

`--break-system-packages` is required on Ubuntu 23.04+, which marks the system Python
as externally managed.

Then add the `/api/` proxy block to nginx — see `nginx.conf.example`, and keep
`client_max_body_size` in step with `TRIMIMAGE_MAX_UPLOAD_MB` or uploads fail with 413.

## Model tiers

| Tier | File | Size | Notes |
|---|---|---|---|
| `small` | `isnet_quint8.onnx` | 44 MB | quantised for browser download size; noisier edges on CPU |
| `medium` | `isnet_fp16.onnx` | 88 MB | **the default** — same speed as `small`, less memory, cleaner edges |
| `large` | `isnet.onnx` | 176 MB | full precision, slower for a small gain |

Switch with `TRIMIMAGE_MODEL=...` in the unit file after fetching the tier you want.
If that file is absent the service uses whichever tier is present and logs a warning.

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
