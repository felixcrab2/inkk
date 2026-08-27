#!/usr/bin/env python3
"""
Render the menu-bar tray icon: the wordmark "inkk." in EB Garamond as a macOS
*template* image (black glyphs on transparency). macOS recolours template
images to match the menu bar, so this shows up white on a dark bar and black on
a light one, exactly like the native icons.

Outputs (Electron picks the @2x automatically on Retina):
  iconTemplate.png      ~18px tall
  iconTemplate@2x.png   ~36px tall
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = "/Library/Fonts/MMP-Freefonts/EB_Garamond/static"
FONT = os.path.join(FONT_DIR, "EBGaramond-SemiBold.ttf")   # matches the brand wordmark
TEXT = "inkk."
H1 = 15   # 1x target height (px); menu bar is ~22px tall — kept a touch small

def render(scale):
    # Render large, then crop to ink and downscale for crisp edges.
    big = ImageFont.truetype(FONT, 400)
    tmp = Image.new("RGBA", (2000, 800), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    d.text((20, 20), TEXT, font=big, fill=(0, 0, 0, 255))
    bbox = tmp.getbbox()
    glyph = tmp.crop(bbox)
    target_h = H1 * scale
    w = round(glyph.width * (target_h / glyph.height))
    out = glyph.resize((w, target_h), Image.LANCZOS)
    # small side padding so the wordmark isn't jammed against the next icon
    pad = 2 * scale
    canvas = Image.new("RGBA", (w + pad * 2, target_h), (0, 0, 0, 0))
    canvas.paste(out, (pad, 0), out)
    return canvas

for scale, name in ((1, "iconTemplate.png"), (2, "iconTemplate@2x.png")):
    img = render(scale)
    img.save(os.path.join(HERE, name))
    print(f"{name}: {img.width}x{img.height}")
