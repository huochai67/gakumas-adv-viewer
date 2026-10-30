"""Export 2D ADV backgrounds (env_2d_* bundles) as PNGs for the viewer.

Each env_2d bundle holds one Texture2D plus the UIBackground material; the
viewer only needs the texture, so this copies it to web/assets/tex/<name>.png
and records the pixel size in bg.json (the script drives quad scale/position).
"""
from __future__ import annotations

import json
from pathlib import Path

import assets

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "web" / "assets" / "tex"
OUT = ROOT / "web" / "assets"


def main():
    env = assets.load_env()
    TEX.mkdir(parents=True, exist_ok=True)
    meta = {}
    for f in env.files.values():
        name = getattr(f, "name", "") or ""
        if not name.startswith("env_2d_"):
            continue
        bundle = name[:-len(".bundle")] if name.endswith(".bundle") else name
        for o in assets.objects_of(f, "Texture2D"):
            t = o.read()
            img = t.image
            if img is None:
                continue
            path = TEX / f"{t.m_Name}.png"
            path.write_bytes(assets.texture_png(t))
            meta[bundle] = {"texture": f"tex/{t.m_Name}.png",
                            "width": img.width, "height": img.height}
            print(bundle, t.m_Name, img.size)
    (OUT / "bg.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
