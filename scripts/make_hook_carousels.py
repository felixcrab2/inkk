#!/usr/bin/env python3
"""
Generate the painting-hook TikTok carousels (1080x1920), pieces 38-40.

New format: slide 1 is a beautiful public-domain painting with a TikTok-style
white text hook over it ("and people think AI can replace human writing >>>>").
Slides 2+ are the piece in the house paper style (small EB Garamond, one
paragraph per slide, italic title on the first text slide). Final slide is the
canonical human-signal radar brand card.

Paper-slide + radar rendering is copied verbatim from the canonical
make_carousels.py (rabat workspace) so the batches match pixel-for-pixel.
Outputs only 38-40 into tiktok-carousels/ (does not touch anything else).
"""
import os, re, html, math
from PIL import Image, ImageDraw, ImageFont

# ── Look (identical to canonical) ──────────────────────────────────────────
BG   = (250, 248, 244)
INK  = (42, 42, 42)

W, H     = 1080, 1920
LMARGIN  = 130
RMARGIN  = 182
TXTW     = W - LMARGIN - RMARGIN
MAX_H    = 1440
UP_SHIFT = 70

BODY_SIZE  = 40
TITLE_SIZE = 44
LOGO_SIZE  = 78
LH         = 1.5
PARA_GAP   = 0.7
TITLE_GAP  = 1.3

FONT_DIR = "/Library/Fonts/MMP-Freefonts/EB_Garamond/static"
def fp(n):
    p = os.path.join(FONT_DIR, n)
    return p if os.path.exists(p) else os.path.join(FONT_DIR, "EBGaramond-Regular.ttf")
F_REG, F_ITAL, F_SEMI = fp("EBGaramond-Regular.ttf"), fp("EBGaramond-Italic.ttf"), fp("EBGaramond-SemiBold.ttf")
F_SANS = next((p for p in ("/System/Library/Fonts/Helvetica.ttc",
                           "/System/Library/Fonts/Supplemental/Arial.ttf") if os.path.exists(p)), F_REG)
# TikTok-style hook text: heavy plain sans, white with a black stroke.
F_HOOK = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

RADAR_DIMS = ["TIMING", "CONTACT", "RHYTHM", "SPEED", "BURSTS",
              "THOUGHT", "PAUSES", "REVISION", "EDITS"]
RADAR_VALS = [0.90, 0.52, 0.78, 0.34, 0.84, 0.44, 0.30, 0.58, 0.68]
RADAR_R    = 132
RADAR_RINGS = 4
WEB_COL    = (206, 203, 198)
LABEL_COL  = (150, 147, 142)
FILL_COL   = (60, 60, 60, 24)

_c = {}
def font(path, size):
    if (path, size) not in _c:
        _c[(path, size)] = ImageFont.truetype(path, size)
    return _c[(path, size)]

BODY  = font(F_REG, BODY_SIZE)
TITLE = font(F_ITAL, TITLE_SIZE)
_scratch = ImageDraw.Draw(Image.new("RGB", (10, 10)))

def wrap(text, fnt, width=None):
    width = width or TXTW
    lines = []
    for hard in text.split("\n"):
        words, line = hard.split(" "), ""
        for w in words:
            trial = w if not line else line + " " + w
            if _scratch.textlength(trial, font=fnt) <= width:
                line = trial
            else:
                lines.append(line); line = w
        lines.append(line)
    return lines

BODY_ADV  = BODY_SIZE * LH
TITLE_ADV = TITLE_SIZE * LH

def to_paragraphs(content_html):
    s = content_html.replace("</p>", "\n\n").replace("<p>", "")
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return [p.strip() for p in s.split("\n\n") if p.strip()]

def paginate(title, paragraphs):
    slides = []
    for p in paragraphs:
        lines = wrap(p, BODY)
        budget = int((MAX_H if slides else
                      MAX_H - (len(wrap(title, TITLE)) * TITLE_ADV + TITLE_ADV * TITLE_GAP)) / BODY_ADV)
        for i in range(0, len(lines), max(1, budget)):
            slides.append([lines[i:i + max(1, budget)]])
    return slides

def render_text_slide(title, para_line_groups):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    title_lines = wrap(title, TITLE) if title else []
    total = 0.0
    if title_lines:
        total += len(title_lines) * TITLE_ADV + TITLE_ADV * TITLE_GAP
    for i, g in enumerate(para_line_groups):
        total += len(g) * BODY_ADV + (BODY_ADV * PARA_GAP if i else 0)
    y = (H - total) / 2 - UP_SHIFT
    if title_lines:
        for ln in title_lines:
            d.text((LMARGIN, y), ln, font=TITLE, fill=INK)
            y += TITLE_ADV
        y += TITLE_ADV * TITLE_GAP
    for i, g in enumerate(para_line_groups):
        if i:
            y += BODY_ADV * PARA_GAP
        for ln in g:
            d.text((LMARGIN, y), ln, font=BODY, fill=INK)
            y += BODY_ADV
    return img

def render_radar(img, cx, cy):
    n = len(RADAR_DIMS)
    SS, pad = 3, 26
    box = int((RADAR_R + pad) * 2)
    L = box * SS
    layer = Image.new("RGBA", (L, L), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    lc, Rs = L / 2, RADAR_R * SS
    def pt(rr, i):
        a = math.radians(-90 + i * (360 / n))
        return (lc + rr * math.cos(a), lc + rr * math.sin(a))
    web = WEB_COL + (255,)
    for k in range(1, RADAR_RINGS + 1):
        ring = [pt(Rs * k / RADAR_RINGS, i) for i in range(n)]
        dl.line(ring + [ring[0]], fill=web, width=int(1.2 * SS), joint="curve")
    for i in range(n):
        dl.line([(lc, lc), pt(Rs, i)], fill=web, width=int(1.2 * SS))
    dpoly = [pt(Rs * RADAR_VALS[i], i) for i in range(n)]
    dl.polygon(dpoly, fill=FILL_COL)
    dl.line(dpoly + [dpoly[0]], fill=INK + (255,), width=int(2.0 * SS), joint="curve")
    dot = int(4 * SS)
    for x, y in dpoly:
        dl.ellipse([x - dot, y - dot, x + dot, y + dot], fill=INK + (255,))
    layer = layer.resize((box, box), Image.LANCZOS)
    img.paste(layer, (int(cx - box / 2), int(cy - box / 2)), layer)
    d = ImageDraw.Draw(img)
    lab = font(F_SANS, 21)
    for i, name in enumerate(RADAR_DIMS):
        a = math.radians(-90 + i * (360 / n))
        d.text((cx + (RADAR_R + 36) * math.cos(a), cy + (RADAR_R + 36) * math.sin(a)),
               name, font=lab, fill=LABEL_COL, anchor="mm")

def draw_tracked(d, cx, y, text, fnt, fill, track):
    widths = [d.textlength(c, font=fnt) for c in text]
    x = cx - (sum(widths) + track * (len(text) - 1)) / 2
    for c, w in zip(text, widths):
        d.text((x, y), c, font=fnt, fill=fill)
        x += w + track

def render_brand_slide():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    logo = font(F_SEMI, LOGO_SIZE)
    cta = font(F_REG, 40)
    la, ld = logo.getmetrics()
    gap, CTA_SIZE = 30, 40
    VER_SIZE, VER_TRACK = 28, 6
    CTA_TEXT = "Write yours at www.inkk.site"
    graph_top_ext, graph_bot_ext = 182, 172
    GAP_CAP, GAP_MID = 42, 62
    text_block = la + gap + CTA_SIZE
    total = graph_top_ext + graph_bot_ext + GAP_CAP + VER_SIZE + GAP_MID + text_block
    start = (H - total) / 2 - 20
    render_radar(img, W / 2, start + graph_top_ext)
    vy = start + graph_top_ext + graph_bot_ext + GAP_CAP
    draw_tracked(d, W / 2, vy, "HUMAN VERIFIED", font(F_SANS, VER_SIZE), (126, 123, 118), VER_TRACK)
    top = vy + VER_SIZE + GAP_MID
    d.text(((W - d.textlength("inkk.", font=logo)) / 2, top), "inkk.", font=logo, fill=INK)
    cy2 = top + la + gap
    d.text(((W - d.textlength(CTA_TEXT, font=cta)) / 2, cy2), CTA_TEXT, font=cta, fill=INK)
    return img

# ── Painting hook slide ────────────────────────────────────────────────────
HOOK_TEXT   = "and people think AI can replace human writing >>>>"
HOOK_SIZE   = 58
HOOK_LH     = 1.32
HOOK_WIDTH  = W - 2 * 110          # wider than the paper margins, TikTok-like
HOOK_STROKE = 6
HOOK_Y_MID  = 0.30                 # centre of the text block, as fraction of H
OVERLAY     = 66                   # 0-255 black wash so white text reads

def render_hook_slide(painting_path, y_mid=None, crop_x=0.5):
    src = Image.open(painting_path).convert("RGB")
    # scale to cover 1080x1920; crop_x picks the horizontal window (0 left, 1 right)
    scale = max(W / src.width, H / src.height)
    src = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
    x0, y0 = round((src.width - W) * crop_x), (src.height - H) // 2
    img = src.crop((x0, y0, x0 + W, y0 + H))
    img.paste(Image.new("RGB", (W, H), (0, 0, 0)),
              (0, 0), Image.new("L", (W, H), OVERLAY))
    d = ImageDraw.Draw(img)
    fnt = font(F_HOOK, HOOK_SIZE)
    lines = wrap(HOOK_TEXT, fnt, HOOK_WIDTH)
    adv = HOOK_SIZE * HOOK_LH
    y = H * (y_mid if y_mid is not None else HOOK_Y_MID) - (len(lines) * adv) / 2
    for ln in lines:
        d.text((W / 2, y), ln, font=fnt, fill=(255, 255, 255),
               anchor="ma", stroke_width=HOOK_STROKE, stroke_fill=(0, 0, 0))
        y += adv
    return img

# ── Pieces 38-40 ───────────────────────────────────────────────────────────
# Take two, after the fake-profound critique. Rules for this batch:
#  • the CLAIM must be unsaid (not just the topic), and testable against life
#  • no announcements ("here is the thing"), no homework endings ("so tonight,
#    do X"), no aphorism stacking; one earned figure per piece, flatness is ok
#  • three different registers so the batch doesn't share one voice:
#    kinetic-funny / flint-cold / tender-precise
PIECES = [
    {"author_username": "paper_kite", "title": "Flat out",
     "painting": "sorolla-running-beach.jpg", "hook_y": 0.16, "crop_x": 0.12, "content":
     """<p>At eight I ran everywhere. Not to things. Just at them. Running was not transport, it was a way of being in the day, down hills, across car parks, along the wet sand with my arms out.</p><p>Then somewhere, quietly, I stopped. Not all at once. Running became jogging, which is running with the joy administered out of it. Then jogging became exercise, which is running as a payment. And now I move at one speed, a sensible adult speed, chosen for me by nobody I can name.</p><p>The strange part is that the top gear is still there. I could sprint right now. There is a road outside and legs under me and nothing actually stopping me. You could too. Neither of us will. We keep our fastest self in reserve, for something, for later, for an emergency that had better be worth it.</p><p>My niece is six. Last week she held my hand at the school gate, saw her friend across the field, and was simply gone, at maximum, instantly, the way a swift leaves a wire. No warm-up. No decision that I could detect. All of it, at once, spent freely, because to her the top speed is not a reserve. It is the point. Some evening soon, on an empty road, in bad shoes, I am going to find out what is left.</p>"""},
    {"author_username": "saltmarsh", "title": "The arithmetic",
     "painting": "vermeer-balance.jpg", "hook_y": 0.14, "content":
     """<p>I read menus right to left. Price first, then the dish. I did not decide to do this. It was installed before I could have noticed it happening, in a kitchen where my mother did sums on the back of an envelope with the door shut.</p><p>There was a number in our house. Nobody ever said it out loud. It was the number past which things became a discussion, and I could feel where it sat the way you can feel a wall in the dark. Trainers under it. School trip over it. I learned it so young that it does not feel like knowledge. It feels like eyesight.</p><p>I am fine now. That is the strange part. The account behaves. The card does not flinch. And still, at the supermarket, a running total climbs in my head and checks itself at the till, and is proud when it lands within a pound. A small employee of a household that closed twenty years ago.</p><p>Last year, in a restaurant, on purpose, I ordered without reading the prices once. I would like to report that it felt like freedom. It felt like leaving a door unlocked. Some people are still paying off their childhoods. Mine just does the books, quietly, every day, in a currency that no longer exists.</p>"""},
    {"author_username": "e.vestergaard", "title": "The apology",
     "painting": "hammershoi-interior.jpg", "content":
     """<p>My mother has started apologising for my childhood. It arrives sideways, while she is drying plates. "You were left on your own too much," she says, to the plate. "I should have been softer with you. I did not know anything. I was twenty-four."</p><p>The childhood she is describing is over. It finished decades ago, the way weather finishes. Some of it I keep. Some of it I set down years ago. I am, by any honest measure, fine.</p><p>But she is not fine. She still lives there. We got to leave, and the people who raised us stayed on, walking the old rooms, running the same seven mistakes on a loop, keeping a file open on a case the only witness has closed. My mother is the last resident of a place I moved out of twenty years ago. The guilt kept her behind after everyone else had gone.</p><p>So now, when it starts, I put down the tea towel and I am not soft, I am precise, because precision is the thing she needs. "You were twenty-four. You were doing it with no money and no sleep and nobody showing you how. I remember being loved. That is all I kept." She nods, and does not believe me, and feels lighter for a few weeks anyway. I used to think forgiving her was the last job of my childhood. It is not. The last job is getting her to put it down too. I am still at work.</p>"""},
]

SONGS = {
    "Flat out": (
        "Dog Days Are Over by Florence + The Machine",
        "the song is literally an order to run flat out, and the drums arrive like the sprint itself.",
        "Born to Run by Bruce Springsteen"),
    "The arithmetic": (
        "Fast Car by Tracy Chapman",
        "a childhood spent doing the sums of a household, and the dream of driving out of it; the exact ache of the piece.",
        "Castle on the Hill by Ed Sheeran"),
    "The apology": (
        "Godspeed by Frank Ocean",
        "a blessing released backward with love; the sound of letting someone off the hook at last.",
        "Wildflowers by Tom Petty"),
}

START_N = 38   # canonical set ends at 37

def song_txt(title):
    primary, why, alt = SONGS.get(title, ("", "", ""))
    return (f"{title}\n\n"
            f"SONG: {primary}\n"
            f"WHY: {why}\n"
            f"ALT:  {alt}\n\n"
            f"Tip: search the song on TikTok and use the trending version "
            f"(often a slowed or sped-up edit) so it rides the sound.\n")

def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    paintings = os.path.join(here, "assets", "paintings")
    out = os.path.join(os.path.dirname(here), "tiktok-carousels")
    os.makedirs(out, exist_ok=True)

    for n, piece in enumerate(PIECES, START_N):
        title = piece["title"]
        paras = to_paragraphs(piece["content"])
        folder = os.path.join(out, f"{n:02d}-{slug(title)}")
        os.makedirs(folder, exist_ok=True)
        i = 1
        render_hook_slide(os.path.join(paintings, piece["painting"]),
                          piece.get("hook_y"), piece.get("crop_x", 0.5)).save(
            os.path.join(folder, f"slide-{i}.png")); i += 1
        pages = paginate(title, paras)
        for pi, groups in enumerate(pages):
            img = render_text_slide(title if pi == 0 else None, groups)
            img.save(os.path.join(folder, f"slide-{i}.png")); i += 1
        render_brand_slide().save(os.path.join(folder, f"slide-{i}.png"))
        with open(os.path.join(folder, "song.txt"), "w") as f:
            f.write(song_txt(title))
        print(f"  {n:02d}-{slug(title)}: 1 hook + {len(pages)} text + 1 closing + song.txt")
    print(f"Done -> {out}")

if __name__ == "__main__":
    main()
