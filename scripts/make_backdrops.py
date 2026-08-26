#!/usr/bin/env python3
"""
Build the engraving backdrops (public/backdrops/*.webp).

Each source plate is reduced to pure ink on transparency:
  • grayscale + per-image autocontrast (paper -> white, ink -> black)
  • sharpened
  • luminance -> alpha through a narrow near-binary ramp: paper and the
    white between hatching strokes go fully transparent, stroke cores go
    fully opaque pure black, with only a thin anti-aliasing band between.
The site then fades the lines alone (opacity), so the page never greys.

Sources:
  scripts/assets/durer/          Christie's photographs of Dürer plates
  ~/Desktop/Inkk Inspo Pictures  the non-Dürer plates (Flammarion, Merian,
                                 van der Straet)
Re-run after adding a source: python3 scripts/make_backdrops.py
"""
import os
from PIL import Image, ImageFilter, ImageOps

HERE    = os.path.dirname(os.path.abspath(__file__))
DURER   = os.path.join(HERE, "assets", "durer")
DESKTOP = os.path.expanduser("~/Desktop/Inkk Inspo Pictures")
DST     = os.path.join(os.path.dirname(HERE), "public", "backdrops")

# name -> source path
SOURCES = {
    # Christie's Dürers (photographed impressions, ~3200px)
    "jerome":        os.path.join(DURER, "st-jerome.jpg"),
    "melencolia":    os.path.join(DURER, "melencolia.jpg"),
    "rhinoceros":    os.path.join(DURER, "rhinoceros.jpg"),
    "four-horsemen": os.path.join(DURER, "four-horsemen.jpg"),
    "prodigal-son":  os.path.join(DURER, "prodigal-son.jpg"),
    "st-eustace":    os.path.join(DURER, "st-eustace.jpg"),
    "whore-babylon": os.path.join(DURER, "whore-babylon.jpg"),
    # the Flammarion engraving (high-res scan; also the landing plate)
    "flammarion":    os.path.join(DESKTOP, "Flammarion.jpg"),
    # cut for quality (softer sources read muddy next to the Christie's set):
    # "cosmos":      os.path.join(DESKTOP, "Alchemy-picture-M.-Merian-for-website.jpg"),
    # "destillatio": os.path.join(DESKTOP, "3_van-der-straet_destillatio-web.jpg"),
}

MAX   = 2600   # longest side
WHITE = 200    # luminance at/above -> fully transparent (perfect white)
BLACK = 120    # luminance at/below -> fully opaque (perfect black)
INK   = (0, 0, 0)

def build(name, src):
    im = Image.open(src).convert("L")
    if max(im.size) > MAX:
        s = MAX / max(im.size)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im = ImageOps.autocontrast(im, cutoff=2)
    im = im.filter(ImageFilter.UnsharpMask(radius=2.0, percent=140, threshold=2))
    def alpha(v):
        if v >= WHITE: return 0
        if v <= BLACK: return 255
        return round(255 * (WHITE - v) / (WHITE - BLACK))
    out = Image.new("RGBA", im.size, INK + (0,))
    out.putalpha(im.point(alpha))
    path = os.path.join(DST, f"{name}.webp")
    out.save(path, quality=85, method=6, alpha_quality=95)
    return im.size, os.path.getsize(path) // 1024

def main():
    os.makedirs(DST, exist_ok=True)
    total = 0
    for name, src in SOURCES.items():
        if not os.path.exists(src):
            print(f"{name:14s} SKIPPED (missing {src})")
            continue
        size, kb = build(name, src)
        total += kb
        print(f"{name:14s} {size[0]}x{size[1]}  {kb} KB")
    print(f"total {total} KB")

if __name__ == "__main__":
    main()
