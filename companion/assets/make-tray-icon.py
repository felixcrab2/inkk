#!/usr/bin/env python3
"""
Render the menu-bar tray icons: the wordmark "inkk." in IM Fell English (the repo's
own src/assets/IMFellEnglish-Regular.ttf) as macOS *template* images — black
glyphs on transparency. macOS recolours template images to match the menu bar,
so they show white on a dark bar and black on a light one, like native icons.

Two variants, each at 1x and 2x (Electron picks the @2x automatically on Retina):
  iconTemplate.png / @2x          idle: "inkk."
  iconTemplateActive.png / @2x    a session is live: "inkk." + a filled dot
                                  (4px at 1x, 8px at 2x) after the period
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.normpath(os.path.join(HERE, "..", "..", "src", "assets", "IMFellEnglish-Regular.ttf"))
TEXT = "inkk."
H1 = 15        # 1x wordmark height (px); menu bar is ~22px — kept a touch small
DOT = 4        # 1x diameter of the "live" dot
DOT_GAP = 3    # 1x gap between the period and the dot
PAD = 2        # 1x side padding so the wordmark isn't jammed against neighbours


def wordmark(scale):
    # Render large, crop to ink, downscale for crisp edges.
    big = ImageFont.truetype(FONT, 400)
    tmp = Image.new("RGBA", (2000, 800), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((20, 20), TEXT, font=big, fill=(0, 0, 0, 255))
    glyph = tmp.crop(tmp.getbbox())
    target_h = H1 * scale
    w = round(glyph.width * (target_h / glyph.height))
    return glyph.resize((w, target_h), Image.LANCZOS)


def render(scale, active):
    mark = wordmark(scale)
    pad = PAD * scale
    dot = DOT * scale
    extra = (DOT_GAP * scale + dot) if active else 0
    canvas = Image.new("RGBA", (mark.width + pad * 2 + extra, mark.height), (0, 0, 0, 0))
    canvas.paste(mark, (pad, 0), mark)
    if active:
        # Sit the dot on the baseline, i.e. level with the period. Draw at 4x
        # and downsample so the circle is anti-aliased like the glyphs.
        ss = 4
        big = Image.new("RGBA", (dot * ss, dot * ss), (0, 0, 0, 0))
        ImageDraw.Draw(big).ellipse((0, 0, dot * ss - 1, dot * ss - 1), fill=(0, 0, 0, 255))
        circle = big.resize((dot, dot), Image.LANCZOS)
        x = pad + mark.width + DOT_GAP * scale
        y = mark.height - dot - round(0.5 * scale)
        canvas.paste(circle, (x, y), circle)
    return canvas


for scale, suffix in ((1, ""), (2, "@2x")):
    for active, stem in ((False, "iconTemplate"), (True, "iconTemplateActive")):
        img = render(scale, active)
        name = f"{stem}{suffix}.png"
        img.save(os.path.join(HERE, name))
        print(f"{name}: {img.width}x{img.height}")
