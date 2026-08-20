# Deploying TrimImage

Everything lives in one folder on the server: **`/var/www/imagetrimmer`**.

| Part | Required | What it is |
|---|---|---|
| Static site | yes | `index.html`, the `.js` files, `styles.css`, `credits.html`, `og-image.png` |
| Background-removal API | optional | `server/` — lets phones skip a 44 MB model download |

The site works without the API. It checks `/api/health` once on load; if nothing
answers, it hides the server option and runs background removal in the browser.

Assumes Ubuntu with nginx, domain on Cloudflare. Cloud images log you in as a
non-root user (`ubuntu`), so the privileged commands below use `sudo` — if you are
root already, drop it.

---

## 1. Static site

Deploy from your machine:

```bash
rsync -av --delete ./ root@YOUR_SERVER:/var/www/imagetrimmer/
```

Or pull on the server:

```bash
cd /var/www/imagetrimmer && git pull
```

Verify: `curl -sI https://www.imagetrimmer.com/ | head -3`

---

## 2. Background-removal API

### 2.1 Install the dependencies

Ubuntu 23.04+ marks the system Python as externally managed, so pip needs
`--break-system-packages` — without it you get `error: externally-managed-environment`.

```bash
sudo apt update && sudo apt install -y python3-pip
sudo pip3 install --break-system-packages -r /var/www/imagetrimmer/server/requirements.txt
```

Both need `sudo`: the first writes to the dpkg lock, the second installs into the
system `dist-packages`. Without it you get `are you root?` from apt, and then
`No module named uvicorn` later on, because nothing was installed.

About 200 MB installed, mostly `onnxruntime`. Check space first with `df -h`.

### 2.2 Fetch the model

```bash
cd /var/www/imagetrimmer
python3 server/fetch_model.py medium
ls -lh server/models/
```

Downloads 88 MB once and assembles it into `server/models/isnet_fp16.onnx`.
It's git-ignored, so deploys never touch it.

`medium` is the right default on a server: measured against `small`, it runs at the
same speed (4.5 s vs 4.6 s on two threads), uses *less* memory (1.2 GB vs 1.4 GB peak)
and produces visibly cleaner edges — `small` is quantised for browser download size,
which stops mattering once the model lives on your machine. Use `small` only if disk
is tight.

### 2.3 Check it runs

```bash
cd /var/www/imagetrimmer/server
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 &
sleep 5
curl -s localhost:8000/api/health          # -> {"status":"ok",...}
kill %1
```

If it says `model-missing`, step 2.2 didn't land in `server/models/`.

### 2.4 Run it as a service

```bash
sudo cp /var/www/imagetrimmer/server/trimimage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trimimage
sudo systemctl status trimimage --no-pager
```

The unit file matches these paths already — nothing to edit unless your VPS has more
than 2 cores, in which case raise `TRIMIMAGE_MAX_CONCURRENCY` and `TRIMIMAGE_THREADS`
to match, then `sudo systemctl daemon-reload && sudo systemctl restart trimimage`.

### 2.5 Point nginx at it

Add these two blocks **inside** the existing `server { listen 443 ssl; ... }` block for
the site, above `location / { ... }`:

```nginx
    # the model is 44 MB and only uvicorn reads it — don't serve it to the world
    location ^~ /server/models/ { return 404; }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        client_max_body_size 12m;      # must match TRIMIMAGE_MAX_UPLOAD_MB
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        proxy_request_buffering off;   # start work while the upload streams in

        add_header Cache-Control "no-store" always;
    }
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`client_max_body_size` matters: without it nginx caps uploads at 1 MB and every photo
fails with **413** before reaching the API.

### 2.6 Verify

```bash
curl -s https://www.imagetrimmer.com/api/health
curl -s -o /tmp/out.png -w "%{http_code} %{size_download}\n" \
  -F "image=@photo.jpg" https://www.imagetrimmer.com/api/remove-background
```

Then open the site — **Remove background** should show a "Where to process" control
with *On our server* selected, and produce a cutout with no model download.

---

## Updating later

```bash
cd /var/www/imagetrimmer && git pull
sudo systemctl restart trimimage   # only if anything under server/ changed
```

Static-only changes need no restart.

## Operating it

```bash
sudo journalctl -u trimimage -f     # follow the logs
sudo systemctl restart trimimage
curl -s localhost:8000/api/health
```

**Capacity.** Inference is CPU-bound: ~3.4 s for a 900×1200 photo on a fast core, so
expect 5–15 s on a small VPS. With `TRIMIMAGE_MAX_CONCURRENCY=2` a third request waits,
then gets a 503 rather than thrashing the box.

**Bigger model** (better edges, slower):

```bash
cd /var/www/imagetrimmer && python3 server/fetch_model.py medium
# then in /etc/systemd/system/trimimage.service:
#   Environment="TRIMIMAGE_MODEL=isnet_fp16.onnx"
sudo systemctl daemon-reload && sudo systemctl restart trimimage
```

**Cloudflare:** keep SSL/TLS mode on **Full (strict)**.

## Optional: faster in-browser mode

For visitors who choose *In my browser*, these headers let ONNX Runtime use threads
(~2.5× faster on CPU). Add to the same `server { listen 443 ... }` block:

```nginx
    add_header Cross-Origin-Opener-Policy   "same-origin"  always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

The Buy-me-a-coffee button and the CDN model loads were both tested under these and
keep working. If you later add a third-party embed, test it under these headers —
COEP blocks cross-origin resources that don't opt in.

## Rollback

```bash
sudo systemctl stop trimimage && sudo systemctl disable trimimage
```

The site detects `/api/health` failing and reverts to in-browser processing on its own.
