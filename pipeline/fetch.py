"""Download + decrypt Octo asset bundles (with dependency closure).

Usage: python pipeline/fetch.py mdl_chr_amao-casl-0000_body env_3d_adv_classroom-00-00-noon ...
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from masked_bundle import decrypt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
UA = "Dalvik/2.1.0 (Linux; U; Android 11; GM1910 Build/RKQ1.201022.002)"


def manifest_candidates() -> list[Path]:
    out: list[Path] = []
    env_path = os.environ.get("GAKUMAS_OCTO_MANIFEST")
    if env_path:
        out.append(Path(env_path))
    out.append(CACHE / "OctoManifest.json")
    out.append(Path(r"C:\workspace\GakumasAuto\tmp\gkm_tl\cache\octo\OctoManifest.json"))
    return out


def load_manifest() -> dict:
    for p in manifest_candidates():
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError("OctoManifest.json not found")


def _download(url: str, attempts: int = 3) -> bytes:
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # pragma: no cover - network
            last = e
            time.sleep(1 + i)
    raise RuntimeError(f"download failed {url}: {last}")


def ensure_bundles(names, with_deps=True, verbose=True) -> dict[str, Path]:
    m = load_manifest()
    by_name = {b["name"]: b for b in m["assetBundleList"]}
    by_id = {b["id"]: b for b in m["assetBundleList"]}
    url_fmt = m["urlFormat"]
    need = []
    seen = set()
    stack = [by_name[n] for n in names]
    while stack:
        b = stack.pop()
        if b["name"] in seen:
            continue
        seen.add(b["name"])
        need.append(b)
        if with_deps:
            for dep in b.get("dependencie", []):
                db = by_id.get(dep)
                if db is not None:
                    stack.append(db)
    CACHE.joinpath("downloads").mkdir(parents=True, exist_ok=True)
    CACHE.joinpath("bundles").mkdir(parents=True, exist_ok=True)
    out = {}
    todo = []
    for b in need:
        dst = CACHE / "bundles" / (b["name"] + ".bundle")
        out[b["name"]] = dst
        if dst.exists() and dst.stat().st_size == b["size"]:
            continue
        todo.append(b)
    if verbose:
        print(f"{len(need)} bundles in closure, {len(todo)} to download")
    for i, b in enumerate(todo, 1):
        raw_path = CACHE / "downloads" / (b["name"] + ".bundle")
        if raw_path.exists() and raw_path.stat().st_size == b["size"]:
            raw = raw_path.read_bytes()
        else:
            raw = _download(url_fmt.replace("{o}", b["objectName"]))
            if len(raw) != b["size"]:
                raise RuntimeError(f"size mismatch {b['name']}: {len(raw)} != {b['size']}")
            raw_path.write_bytes(raw)
        dec = decrypt(raw, b["name"])
        got = hashlib.md5(dec).hexdigest()
        dst = CACHE / "bundles" / (b["name"] + ".bundle")
        dst.write_bytes(dec)
        if verbose:
            print(f"  [{i}/{len(todo)}] {b['name']} {b['size']/1e6:.2f}MB")
    return out


if __name__ == "__main__":
    names = sys.argv[1:]
    if not names:
        raise SystemExit(__doc__)
    for name, path in ensure_bundles(names).items():
        print(name, path)
