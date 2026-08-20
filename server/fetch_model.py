#!/usr/bin/env python3
"""Download the IS-Net segmentation weights and assemble them into one .onnx file.

IMG.LY publishes the model split into 4 MB chunks alongside a resources.json
manifest; concatenating the chunks in order reproduces the original ONNX file.
The model itself is MIT-licensed (see ThirdPartyLicenses.json in
@imgly/background-removal) and upstream IS-Net/DIS code is Apache-2.0.
Only the weights are used here — none of IMG.LY's AGPL code is involved.

Usage:  python3 fetch_model.py [small|medium|large] [--out DIR]
"""
import argparse, json, sys, urllib.request
from pathlib import Path

BASE = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist"
TIERS = {"small": "isnet_quint8", "medium": "isnet_fp16", "large": "isnet"}


# The CDN sits behind Cloudflare, which rejects the default urllib user agent.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tier", nargs="?", default="small", choices=sorted(TIERS))
    ap.add_argument("--out", default=str(Path(__file__).parent / "models"))
    args = ap.parse_args()

    name = TIERS[args.tier]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{name}.onnx"
    if dest.exists():
        print(f"already present: {dest} ({dest.stat().st_size/1e6:.1f} MB)")
        return 0

    print(f"fetching manifest for {args.tier} ({name}) …")
    manifest = json.loads(get(f"{BASE}/resources.json"))
    entry = manifest.get(f"/models/{name}")
    if not entry:
        print(f"model {name} not in manifest", file=sys.stderr)
        return 1

    chunks = entry["chunks"]
    total = sum(c["offsets"][1] - c["offsets"][0] for c in chunks)
    print(f"{len(chunks)} chunks, {total/1e6:.1f} MB total")

    done = 0
    with open(dest, "wb") as fh:
        for i, chunk in enumerate(chunks, 1):
            data = get(f"{BASE}/{chunk['name']}")
            expected = chunk["offsets"][1] - chunk["offsets"][0]
            if len(data) != expected:
                print(f"chunk {i} size mismatch: {len(data)} != {expected}", file=sys.stderr)
                dest.unlink(missing_ok=True)
                return 1
            fh.write(data)
            done += len(data)
            print(f"  [{i}/{len(chunks)}] {done/1e6:6.1f} / {total/1e6:.1f} MB", end="\r", flush=True)

    print(f"\nwrote {dest} ({dest.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
