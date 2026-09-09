#!/usr/bin/env python3
"""
Generate TikTok photo carousels (1080x1920) from the real inkk seed pieces
(scripts/seed/posts.json). Minimal: small EB Garamond text only. Final slide
is a minimalist "human signal" radar of the writing-process factors, with
`inkk.` / `Write Human.` beneath it.
"""
import os, re, json, html, shutil, math
from PIL import Image, ImageDraw, ImageFont

# ── Look ───────────────────────────────────────────────────────────────────
BG   = (250, 248, 244)   # soft off-white paper (barely warm)
INK  = (42, 42, 42)      # near-black

W, H     = 1080, 1920
LMARGIN  = 130
RMARGIN  = 182           # wider right margin so TikTok's side UI doesn't clip text
TXTW     = W - LMARGIN - RMARGIN
MAX_H    = 1440          # vertical area text may occupy
UP_SHIFT = 70            # nudge the whole block up the page

BODY_SIZE  = 40          # "quite small"
TITLE_SIZE = 44
LOGO_SIZE  = 78          # small: Garamond reads better restrained
TAG_SIZE   = 42
LH         = 1.5         # line-height multiple
PARA_GAP   = 0.7         # blank space between paragraphs (x body advance)
TITLE_GAP  = 1.3         # space after the title

FONT_DIR = "/Library/Fonts/MMP-Freefonts/EB_Garamond/static"
def fp(n):
    p = os.path.join(FONT_DIR, n)
    return p if os.path.exists(p) else os.path.join(FONT_DIR, "EBGaramond-Regular.ttf")
F_REG, F_ITAL, F_SEMI = fp("EBGaramond-Regular.ttf"), fp("EBGaramond-Italic.ttf"), fp("EBGaramond-SemiBold.ttf")
# Quiet sans for the radar axis labels (matches the app's system-UI font layer).
F_SANS = next((p for p in ("/System/Library/Fonts/Helvetica.ttc",
                           "/System/Library/Fonts/Supplemental/Arial.ttf") if os.path.exists(p)), F_REG)

# ── Human-signal radar (last slide) ─────────────────────────────────────────
# The nine writing-process factors, each at a different value: a jagged shape
# that reads as "a human wrote this, and every human writes differently."
RADAR_DIMS = ["TIMING", "CONTACT", "RHYTHM", "SPEED", "BURSTS",
              "THOUGHT", "PAUSES", "REVISION", "EDITS"]
RADAR_VALS = [0.90, 0.52, 0.78, 0.34, 0.84, 0.44, 0.30, 0.58, 0.68]
RADAR_R    = 132          # data radius in final px (small, a quiet mark)
RADAR_RINGS = 4
WEB_COL    = (206, 203, 198)   # soft warm grey web on the paper
LABEL_COL  = (150, 147, 142)   # muted label grey
FILL_COL   = (60, 60, 60, 24)  # barely-there polygon fill

_c = {}
def font(path, size):
    if (path, size) not in _c:
        _c[(path, size)] = ImageFont.truetype(path, size)
    return _c[(path, size)]

BODY  = font(F_REG, BODY_SIZE)
TITLE = font(F_ITAL, TITLE_SIZE)
_scratch = ImageDraw.Draw(Image.new("RGB", (10, 10)))

def wrap(text, fnt):
    lines = []
    for hard in text.split("\n"):
        words, line = hard.split(" "), ""
        for w in words:
            trial = w if not line else line + " " + w
            if _scratch.textlength(trial, font=fnt) <= TXTW:
                line = trial
            else:
                lines.append(line); line = w
        lines.append(line)
    return lines

BODY_ADV  = BODY_SIZE * LH
TITLE_ADV = TITLE_SIZE * LH

# ── Content prep ───────────────────────────────────────────────────────────
def to_paragraphs(content_html):
    s = content_html.replace("</p>", "\n\n").replace("<p>", "")
    s = re.sub(r"<[^>]+>", "", s)          # drop <em> etc.
    s = html.unescape(s)
    return [p.strip() for p in s.split("\n\n") if p.strip()]

def paginate(title, paragraphs):
    """One paragraph per slide, so the piece is cut across a few slides.
    The title rides on the first slide. Overlong paragraphs split to fit."""
    slides = []
    for p in paragraphs:
        lines = wrap(p, BODY)
        budget = int((MAX_H if slides else
                      MAX_H - (len(wrap(title, TITLE)) * TITLE_ADV + TITLE_ADV * TITLE_GAP)) / BODY_ADV)
        for i in range(0, len(lines), max(1, budget)):
            slides.append([lines[i:i + max(1, budget)]])
    return slides

# ── Rendering ──────────────────────────────────────────────────────────────
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
    """Draw the minimalist writing-process radar centred at (cx, cy). Web,
    spokes, polygon and dots are supersampled for smooth edges; the axis
    labels are drawn at 1x so the type stays crisp."""
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
    for k in range(1, RADAR_RINGS + 1):          # concentric rings
        ring = [pt(Rs * k / RADAR_RINGS, i) for i in range(n)]
        dl.line(ring + [ring[0]], fill=web, width=int(1.2 * SS), joint="curve")
    for i in range(n):                            # spokes
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
    """Draw letter-spaced text centred on cx (PIL has no native tracking)."""
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

    # A small radar, a quiet "HUMAN VERIFIED" stamp, the wordmark, and the
    # invitation. Kept uncrowded: four elements. Radar extents (incl. labels)
    # reach a little further above (top axis) than below (axes at 70/110 deg).
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

# ── Song pairings (emotional, TikTok-friendly, matched to each piece) ───────
SONGS = {
    "Stand on the right": (
        "This Must Be the Place (Naive Melody) by Talking Heads",
        "warm, wry, everyday-life feeling that suits the mundane commute musing.",
        "Vienna by Billy Joel"),
    "I bought a label maker": (
        "Home by Edith Whiskers",
        "cosy and domestic, matches the quiet comfort of naming everything in the house.",
        "Ribs by Lorde"),
    "It does that": (
        "No Surprises by Radiohead",
        "gently numb and modern, mirrors the resignation of 'it does that.'",
        "Everybody Wants to Rule the World by Tears for Fears"),
    "The pigeon man": (
        "Saturn by Sleeping at Last",
        "tender awe, fits watching a stranger's small patient ritual.",
        "Sparks by Coldplay"),
    "Instead of": (
        "Chamber of Reflection by Mac DeMarco",
        "dreamy and alone-with-your-thoughts, matches a whole day of avoidance.",
        "I Love You So by The Walters"),
    "My nan's handwriting": (
        "Supermarket Flowers by Ed Sheeran",
        "literally about clearing out a late grandmother's things. Biggest tear-jerker of the set.",
        "Slipping Through My Fingers by ABBA"),
    "Third city": (
        "Somewhere Only We Know by Keane",
        "aching for a place to belong, fits the loneliness of arriving somewhere new.",
        "The Night We Met by Lord Huron"),
    "He learned my name": (
        "Sparks by Coldplay",
        "soft and intimate, matches the warmth of being seen and remembered.",
        "First Day of My Life by Bright Eyes"),
    "Rain on purpose": (
        "Holocene by Bon Iver",
        "rain-soaked and quietly euphoric, fits the freedom of giving up on staying dry.",
        "August by Taylor Swift"),
    "Books I've started": (
        "Vienna by Billy Joel",
        "'slow down, you're doing fine' echoes 'the Romans will wait.'",
        "From the Start by Laufey"),
    "The time difference": (
        "To Build a Home by The Cinematic Orchestra",
        "aching and swelling, made for love stretched across distance and time zones.",
        "Landslide by Fleetwood Mac"),
    "Still holding hands": (
        "Harvest Moon by Neil Young",
        "gentle old-love song, fits watching a couple with decades of quiet shorthand.",
        "Can't Help Falling in Love by Elvis Presley"),
    "The group chat went quiet": (
        "Ribs by Lorde",
        "the definitive growing-up-and-drifting-apart sound, made for a friendship that faded without a fight.",
        "Ivy by Frank Ocean"),
    "Cold water": (
        "Experience by Ludovico Einaudi",
        "soaring piano for the euphoria of doing something wild and feeling completely awake.",
        "Alaska by Maggie Rogers"),
    "The book that got me through": (
        "The Book of Love by Peter Gabriel",
        "tender and warm, fits a stupid, average, secretly load-bearing book kept by the door.",
        "First Day of My Life by Bright Eyes"),
    "Blue hour": (
        "Space Song by Beach House",
        "dreamy and suspended, made for the city turning blue for twenty minutes at dusk.",
        "An Ending (Ascent) by Brian Eno"),
    "Snow, first": (
        "Gymnopedie No. 1 by Erik Satie",
        "sparse, still, unhurried piano that matches an empty street under fresh snow.",
        "Nuvole Bianche by Ludovico Einaudi"),
    "The way you sleep": (
        "Pink + White by Frank Ocean",
        "soft and intimate, for watching someone you love sleep at 6am.",
        "Sea of Love by Cat Power"),
    "My grandmother's kitchen": (
        "In My Life by The Beatles",
        "pure warm nostalgia for the people and places that made you.",
        "Postcards from Italy by Beirut"),
    "On being unfinished": (
        "Time by Hans Zimmer",
        "slow, vast, building, fits a meditation on always becoming and never arriving.",
        "Landslide by Fleetwood Mac"),
    "The last time": (
        "The Night We Met by Lord Huron",
        "aching nostalgia for a moment you never knew was the last; made for looking back.",
        "Landslide by Fleetwood Mac"),
    "The grey coming in": (
        "The Luckiest by Ben Folds",
        "quietly devoted, holds the ache of loving something whose time is shorter than yours.",
        "Photograph by Ed Sheeran"),
    "My dad texts like it's a letter": (
        "Father and Son by Cat Stevens",
        "a tender father-son song for a dad knocking gently at the edge of your grown-up life.",
        "My Old Man by Mac DeMarco"),
    "The house sold in spring": (
        "Landslide by Fleetwood Mac",
        "'children get older, I'm getting older too', for time moving through a house you no longer live in.",
        "To Build a Home by The Cinematic Orchestra"),
    "The stranger at the till": (
        "Lean on Me by Bill Withers",
        "warm and communal, for a small kindness quietly passed from stranger to stranger.",
        "Put a Little Love in Your Heart by Jackie DeShannon"),
    "The organised one": (
        "Mirrorball by Taylor Swift",
        "a disco ball showing a different face to every corner of the room; the piece in one lyric.",
        "Falling Behind by Laufey"),
    "The two seconds": (
        "jealousy, jealousy by Olivia Rodrigo",
        "the poison named out loud, then swallowed; comedy and confession in one sound.",
        "Congratulations by Post Malone"),
    "The bread phase": (
        "Growing Sideways by Noah Kahan",
        "growing without a destination is the whole song; fits a life tried on in phases.",
        "Put Your Records On by Corinne Bailey Rae"),
    "Three seconds long": (
        "People Watching by Conan Gray",
        "an anthem for imagining strangers' lives, flipped here onto the strangers imagining yours.",
        "This Must Be the Place (Naive Melody) by Talking Heads"),
    "Four hours": (
        "When We Were Young by Adele",
        "aching for the parts of a life that slip away while you're living it.",
        "About You by The 1975"),
    "Tom Football": (
        "You've Got a Friend in Me by Randy Newman",
        "eleven years of friendship wearing a daft label; warm and unserious, like the name he never updated.",
        "With a Little Help from My Friends by The Beatles"),
    "To be fair": (
        "Anti-Hero by Taylor Swift",
        "'it's me, hi' is the entire piece: meeting yourself as a character everyone else already knows.",
        "You're So Vain by Carly Simon"),
    "Take four": (
        "This Is Me Trying by Taylor Swift",
        "trying hard to sound effortless, and it still being the truest take.",
        "Fake Happy by Paramore"),
    "The phone number": (
        "The House That Built Me by Miranda Lambert",
        "literally about going back to the childhood home that made you; wrecks people.",
        "Castle on the Hill by Ed Sheeran"),
    "The house at night": (
        "Never Grow Up by Taylor Swift",
        "a lullaby about the safety of a child's home and time quietly taking it away.",
        "Landslide by Fleetwood Mac"),
    "The endless summer": (
        "The Suburbs by Arcade Fire",
        "childhood summers and the slow ache of moving past the feeling of them.",
        "Ribs by Lorde"),
    "The argument I never had": (
        "The Archer by Taylor Swift",
        "restless and up-at-night, for a mind that keeps running conversations it can't stop.",
        "Motion Sickness by Phoebe Bridgers"),
    "The one who got away": (
        "the 1 by Taylor Swift",
        "a gentle daydream about the person who got away; wistful, not bitter.",
        "The Night We Met by Lord Huron"),
    "The last native speakers": (
        "Hoppipolla by Sigur Ros",
        "literally sung in a private invented language only the band shares; swelling and euphoric.",
        "First Day of My Life by Bright Eyes"),
    "The one thing you can't keep": (
        "Saturn by Sleeping at Last",
        "'how rare and beautiful it is to even exist' is the exact thought the piece lands on.",
        "Nuvole Bianche by Ludovico Einaudi"),
    "The wing": (
        "The Best Day by Taylor Swift",
        "a grown child finally seeing the depth of a mother's quiet, invisible love.",
        "In My Life by The Beatles"),
    "The last ordinary day": (
        "Seventeen by Sharon Van Etten",
        "aching for who you were and who you were it with; made for a friendship that just faded.",
        "Ribs by Lorde"),
    "The toy": (
        "Puff the Magic Dragon by Peter, Paul and Mary",
        "literally the story of a child who grows up and leaves behind the friend who loved them; wrecks anyone who catches the meaning.",
        "Time in a Bottle by Jim Croce"),
    "Your name was a wish": (
        "Forever Young by Bob Dylan",
        "a parent's whole hope for a child said aloud as a blessing; the wish that lives inside the name.",
        "Isn't She Lovely by Stevie Wonder"),
}

# 5 new original pieces in the personas' voices (not yet in posts.json).
NEW_PIECES = [
    {"author_username": "e.vestergaard", "title": "The time difference", "content":
     """<p>My mum calls at the wrong time now. There's an hour between us and neither of us can ever remember which way it goes.</p><p>So the phone goes at seven in the morning, or eleven at night, and one of us is always slightly the wrong version of ourselves for it. Half asleep, or half out the door.</p><p>She tells me the small news. The neighbour's extension. What the dog did. A cousin I've never met is having a baby. None of it matters and all of it does.</p><p>What she's actually saying, under the extension and the dog, is: are you still there. Are you still mine, all the way over there.</p><p>And what I say back, under the "yeah, mum, I'm fine," is: yes. Always. Even at seven in the morning. Even an hour out of sync.</p>"""},
    {"author_username": "oliveandash", "title": "Still holding hands", "content":
     """<p>An old couple get on my bus most Thursdays. They've been getting on it, I'd guess, about forty years longer than I've been alive.</p><p>He goes up the step first, then turns and puts his hand out without looking, completely certain hers will be there. It always is.</p><p>They don't talk much. They've clearly said everything already. She picks a bit of fluff off his collar. He holds her bag while she finds her pass. Small, worn-smooth things.</p><p>I'm thirty-one and I still perform being fine on dates. I watch them do forty years of shorthand in four bus stops and I think: that. Whatever that is. That's the whole thing.</p><p>They got off at the garden centre. He put his hand out again on the way down. She took it again. Of course she did.</p>"""},
    {"author_username": "saltmarsh", "title": "The group chat went quiet", "content":
     """<p>The group chat has a name so stupid I won't type it here. Six of us. It used to go off forty times a day.</p><p>I scrolled up today. It used to be constant nonsense. Now there's a gap, and someone's "haha" from three weeks ago just sitting there, the last thing anyone said.</p><p>Nobody fell out. That's the thing. There's no story. Jobs happened. A couple of kids happened. A couple of house moves to towns none of us can afford to visit each other in.</p><p>I typed "we should actually do something" and then deleted it, because we've all typed that, and it's become a thing you say instead of a thing you do.</p><p>So I sent a photo of the pub we used to go to instead. Within a minute, five phones somewhere lit up. Five blokes remembering at once. It's not nothing. It might even be everything.</p>"""},
    {"author_username": "paper_kite", "title": "Cold water", "content":
     """<p>Got in the sea in April. Nobody in their right mind gets in the sea here in April. That's rather the point.</p><p>There's a moment, right when the cold hits your chest, where your body is completely certain you've made a serious mistake. Everything in you shouts. And then, a few seconds later, it goes quiet. Really quiet.</p><p>For about a minute out there I wasn't thinking about a single thing. No list. No phone. No what-am-I-doing-with-my-life. Just cold, and salt, and being stupidly, completely awake.</p><p>I don't know why it takes freezing water to switch my head off. Therapy would probably be easier. But the sea doesn't book three weeks in advance, and it's free.</p><p>Came out shaking and grinning like an idiot. A dog walker gave me a look. I gave her a thumbs up. Best I've felt all month.</p>"""},
    {"author_username": "marginalia", "title": "The book that got me through", "content":
     """<p>There's a book I've read six times, and only ever in bad years.</p><p>It isn't even that good, objectively. I'd never recommend it. But I read it first during a spectacularly grim winter, and it was the one warm room I could get to when everything else was locked.</p><p>So now it's a bit like a coat by the door. When things go wrong I don't call anyone, I'm rubbish at that. I just quietly reread the book. My partner has learned to spot it. "Rough week?" she says, seeing it on the arm of the sofa.</p><p>The strange thing is I can never remember the plot between readings. Every time it's new. Every time it helps a little, then slips out of my head again, ready to do it once more when I next need it.</p><p>I hope everyone has a book like this. A stupid, average, secretly load-bearing book. Mine's downstairs right now. It's been a week.</p>"""},
    # 16-20: deliberately varied voices (lyrical, sparse, second-person, lush, essayistic)
    {"author_username": "nightjar", "title": "Blue hour", "content":
     """<p>For about twenty minutes, the city turns blue.</p><p>Not the postcard blue of noon, but a deeper one, the colour that lives inside ice, that pools in the hollows of the streets once the sun has gone but the dark has not yet arrived to claim them.</p><p>The windows come on one by one, small amber confessions, each a room with someone in it doing something ordinary and holy: filling a kettle, folding a shirt, leaning to kiss a child who does not yet know how brief any of this is.</p><p>I stand at my own glass on the fourth floor and I am, for these few minutes, no one at all. Just a pair of eyes the city forgot to switch off.</p><p>Then the blue thickens to black, the spell closes over, and I go back into my life, changed by nothing, carrying it anyway.</p>"""},
    {"author_username": "nightjar", "title": "Snow, first", "content":
     """<p>Snow in the night. Nobody saw it fall.</p><p>Morning: the street rewritten. Bins, bollards, parked cars. All of it forgiven under the same white sentence.</p><p>One set of footprints. Someone braver, up before the world, already gone.</p><p>I stay in. Warm side of the glass. I watch the light come off it. Clean. Borrowed. Ending already.</p><p>By noon it will be grey mush and everyone will have somewhere to be. Not yet. For one hour the street holds its breath, and I am the only one awake to hear it.</p>"""},
    {"author_username": "quietly", "title": "The way you sleep", "content":
     """<p>You sleep like you are bracing for something. Always have. Knees drawn up, one fist near your mouth, as if even in dreams you are not quite convinced the world is safe.</p><p>I wake before you most mornings and I don't reach for my phone. I watch the small weather of your face instead. A frown that comes and goes. Your mouth working around a word you will never remember.</p><p>You would hate this. You think you are difficult to love. You apologise for taking up space, for needing things, for crying at adverts.</p><p>But here is the truth I know at 6am and you will not let me tell you at any other hour: there is nothing about you I am enduring. I chose the frown. I chose the fist. I chose the whole braced, tender, impossible lot of it.</p><p>Then you stir, and open one eye, and say something grumpy, and I love you so much I can hardly stand it. Coffee?</p>"""},
    {"author_username": "hearthside", "title": "My grandmother's kitchen", "content":
     """<p>My grandmother cooks like she is feeding a village that might, at any moment, arrive.</p><p>There is always too much. Pans on every ring, the windows fogged, a radio somewhere losing an argument with the extractor fan. The smell reaches you at the gate: garlic, and something sweet, and the particular warmth of a house that has never once been empty of food.</p><p>She does not measure. She has never measured. She cooks the way rivers run, by feel and downhill instinct, tasting from a wooden spoon worn concave by fifty years of tasting.</p><p>Sit down, she says, before you have your coat off. Eat, she says, before you are hungry. It was never really about the food. The food is just the shape her love takes, because in her language nobody learned to say the words, so they said carrots instead, and gravy, and here, have more.</p><p>I am forty next year and I still cannot leave her house weighing what I weighed when I arrived. I hope I never can.</p>"""},
    {"author_username": "unfinished", "title": "On being unfinished", "content":
     """<p>I used to think there would be a day I arrived. That adulthood was a room you eventually walked into, and the door closed behind you, and that was that: finished, whole, done.</p><p>Nobody warns you of the truth, which is that you are always halfway. Always mid-sentence. You reach the end of an ordinary Tuesday with a book open on the arm of the chair, a list on the fridge, and something you meant to say to someone still unsaid in your throat.</p><p>For years this frightened me. Now, on the good days, I think it might be the kindest thing about being alive: that you never run out of unfinished. That there is always one more river you have not followed to the sea.</p><p>The trick, I am learning, is to stop waiting for the room with the closing door. It is not coming. There is only this: the long, lit corridor, and the going, and the going.</p><p>So I go. Unfinished. Still becoming. Which is, I have decided, just another word for still here.</p>"""},
    # 21-25: batch two, made to hit hard — impermanence, aging parents, kindness.
    {"author_username": "unfinished", "title": "The last time", "content":
     """<p>Nobody tells you when it's the last time. That's the quiet trick of it.</p><p>There was a last time your dad carried you up to bed, and neither of you knew it was the last. A last time your whole family stood in one kitchen at once. A last time you played out in the street until the lights came on, and then, without any ceremony at all, you simply never did again.</p><p>We brace for the endings we can see coming. We take photos at the airport. We make the speech, we say goodbye properly. But the ones that actually shape a life slip past unmarked, dressed as an ordinary Tuesday.</p><p>It could ruin you, thinking like this. Or it could do the opposite. Because it means today, some perfectly forgettable today, might be a last time too. The last time you hear a certain laugh. The last easy phone call, before things get complicated.</p><p>So I rang my mum for no reason. She asked what was wrong. Nothing, I said. Nothing's wrong. I just wanted to use one of the times while I've still got them to spare.</p>"""},
    {"author_username": "oliveandash", "title": "The grey coming in", "content":
     """<p>There's grey coming in around his muzzle now. I couldn't tell you when it started. One day he was just a little older than he used to be.</p><p>He still does all the daft things. Loses his mind at the postman. Brings me a shoe when he's pleased with himself. Sighs like a put-upon old man when I stand up and ruin his plans for a lie-in.</p><p>But he takes the stairs slower now. He sleeps deeper, harder to wake. On cold mornings he waits a second longer before deciding the walk is worth it, and then he decides that it is, every single time, because I'm on the other end of the lead.</p><p>Nobody warns you that loving a dog is signing up, knowingly, for a grief you can see coming from years off. You get maybe a decade if you're lucky. You spend it being the entire world to something that will only ever be one chapter of yours.</p><p>He's asleep on my feet as I write this, going grey, running somewhere in his sleep. I'm not going to spend the good years being sad about the end of them. I'm going to take him out. He's already waiting at the door.</p>"""},
    {"author_username": "saltmarsh", "title": "My dad texts like it's a letter", "content":
     """<p>My dad texts like every message might one day be read aloud in a court of law.</p><p>Full sentences. Proper punctuation. A capital letter standing to attention at the start of every line. And at the end, always, "Dad." As though I might otherwise be unsure which of the men in my life is asking whether I got home alright.</p><p>It used to make me laugh. Dad, I know it's you, your name is right there at the top of the phone. He'd do it anyway. "Hope work is treating you well. Let me know if you need anything at all. Dad."</p><p>Then I noticed they were coming more often. A photo of the garden. A bird he couldn't name. The football score, as if I couldn't see it for myself. And I understood, slowly, what the texts really were. They were him, standing at the edge of my grown-up life, knocking gently to check he was still allowed in.</p><p>I text back properly now. Full sentences. And I sign mine too. It's the only language the two of us have ever really had, and I'd be a fool to stop speaking it while he's still there on the other end to answer.</p>"""},
    {"author_username": "hearthside", "title": "The house sold in spring", "content":
     """<p>I drove past the old house last week. Somebody has painted the front door a colour we would never have chosen.</p><p>There was a child's bike dropped on its side in the front garden, right where I used to leave mine. A trampoline round the back, just visible over the fence. Different curtains in what used to be my window, the window I did the whole of my growing up behind.</p><p>It is such a strange thing, to stand on a pavement and look at the exact spot where you learned to be a person, and to have no right at all to knock on the door. To be a stranger to the walls that once knew you best of anyone.</p><p>Some family in there is having its entire childhood right now, in my rooms, with no idea about mine. One day their kid will drive past too, and feel this precise ache, and be certain the house was only ever theirs.</p><p>A house doesn't remember anyone. It just holds whoever is inside it, then lets them go, then holds the next lot just as tightly. I sat in the car a minute. Then I let it go as well, and drove home, to the place that is mine now, and put the kettle on.</p>"""},
    {"author_username": "paper_kite", "title": "The stranger at the till", "content":
     """<p>I was nineteen and short by about four pounds at the till, doing that hot-faced maths where you hand things back one at a time.</p><p>The man behind me just said "get that" to the cashier, nodding at my little pile. He didn't make a thing of it. Didn't want thanking. When I started to, he waved it off and said, "someone did it for me once. Do it for someone one day."</p><p>I never saw him again. I don't know his name. His face is long gone. I couldn't pick him out of a crowded room. But I have thought about him for fifteen years, which is a strange kind of immortality to hand a stranger without ever meaning to.</p><p>And I have done it since. More than once. A shopping, a coffee, a train ticket for someone counting out coins. Every time, I say the line. Someone did it for me once. Every time, I watch it land on their face the way it once landed on mine.</p><p>He will never know he is still going. That one ordinary bloke, on one ordinary Tuesday, started something that is still moving quietly through the world, paying for strangers' shopping in towns he has never set foot in. That's the thing about a kindness. You never get to find out how far it travels.</p>"""},
    # 26-30: batch three, take two. No death, no elegy. Real, slightly
    # uncomfortable, oddly specific: the stuff people feel and don't post.
    # Endings stay open; no aphorism bows.
    {"author_username": "oliveandash", "title": "The organised one", "content":
     """<p>My flatmate was on the phone to her mum last night and I heard her say my name. So I stopped dead in the hallway, obviously, like a burglar, and listened.</p><p>"Liv? She's lovely. Dead organised. She's got a whole thing about mugs, don't ask. Quite shy till you know her, and then, honestly, she never stops."</p><p>I went back to my room and sat with that for a while. Not because it was unkind. It was said with such fondness it nearly knocked me over. But: shy. Organised. A thing about mugs. Somewhere in another town, a woman I have never met now holds a version of me built entirely out of that.</p><p>The strange part is the gap. I don't feel shy, I feel like I'm holding back so I don't flatten people. I don't feel organised, I feel like I'm barely coping and the mugs are how I cope. From in here it's all weather and noise. From out there, apparently, it looks like calm.</p><p>There are as many versions of you as there are people who've met you, and not one of them matches yours, and nobody is lying. I made two teas and took her one. In the good mugs. Obviously.</p>"""},
    # 27-31: varied themes, clean and universal (no regional colloquialisms).
    # Heart-wrenching nostalgia plus thought-provoking. "The organised one"
    # above is kept; this replaces the phone/voice-note batch the user passed on.
    {"author_username": "hearthside", "title": "The phone number", "content":
     """<p>I still know my childhood phone number. I could not tell you my own from two addresses ago, but that one I could recite in my sleep, the way you know a song you never chose to learn.</p><p>It rang in a hallway that no longer exists in any way that matters. Green carpet. A small table with a notepad and a pen on a string. My mother's voice lifting at the end when she answered, brighter than her real voice, in case it was someone who needed her to be.</p><p>I dialled it once, a few years ago, from a station platform, for no reason I could have defended. Someone answered. A young man, distracted, a radio on somewhere behind him. I said sorry, wrong number, and hung up, and stood there holding the fact that my entire childhood now has someone else's coats in the hall.</p><p>That is the quiet arithmetic of growing up. The rooms that made you, still standing, fully furnished, completely closed to you. You cannot go back. You can only remember, which is its own kind of going back, and leaves you lonelier than before you tried.</p><p>The number still works. That is the part I cannot get past. There is a sequence of digits I could press right now that would make a telephone ring in the exact centre of my childhood, and a stranger would answer, and it would not be for me. It has not been for me in twenty years. I know it by heart regardless. The heart keeps the address long after the world has changed the locks.</p>"""},
    {"author_username": "nightjar", "title": "The house at night", "content":
     """<p>The thing I miss most is a sound I will never hear again: my parents awake downstairs while I fell asleep.</p><p>You know the one. The low weather of adult voices coming up through a floor. A tap running. The particular music of plates being stacked by someone who is not you and does not need your help. A door, a laugh, the muffled evening news. None of the words reached me, and none of them had to.</p><p>Because what that sound meant, what it actually said, up through the boards and into a small dark room, was this: the world is being handled. Someone large and capable is still awake, the doors are locked, and you may let go of the entire day now. Sleep. It is all taken care of.</p><p>Nobody tells you it is a limited offer. There is a last night you fall asleep to the sound of your parents managing the world, and then, at some point you will never be able to locate, the sound becomes your own footsteps, your own turning of the lock, your own quiet competence performed for someone smaller down the hall.</p><p>I am the low voice through the floor now. I am the one stacking the plates so the house sounds safe. And some nights, turning off the last light, I would give almost anything to be upstairs again, small and certain, listening to the enormous handled world, not yet knowing that the sound was a person, and the person was tired, and the person was doing all of it for me.</p>"""},
    {"author_username": "unfinished", "title": "The endless summer", "content":
     """<p>A single childhood summer was longer than the last five years put together. The arithmetic makes no sense and it is completely true.</p><p>Six weeks, once, was a continent. You went in as one person in July and came out in September as another, browner, taller, in possession of a whole new self and a scar you were proud of. Each day had a morning, a vast middle, and a long golden evening, and you lived in it completely before you would let it end.</p><p>Now a year arrives, and I look up, and it has gone. I could not tell you where the spring went. Someone once explained the science: time feels faster because each year is measured against all the years you have already had, so it becomes a thinner and thinner slice of the whole. A summer was a tenth of my life then. Now it is a rounding error.</p><p>But I think it is more than fractions. When you are small, everything is the first time. First sea, first snow, first night still awake past midnight. The mind writes the first time in ink and files every time after in faint pencil, easy to lose. We do not run out of years. We run out of firsts.</p><p>So I have started, quietly, collecting new ones. A food I have never tried. A street I have no reason to walk down. One small deliberate strangeness most days, to make the mind reach for its pen again. It is the closest thing I have found to slowing the whole thing down. You cannot have the endless summer back. But you can, now and then, make a single afternoon long again.</p>"""},
    {"author_username": "marginalia", "title": "The argument I never had", "content":
     """<p>Last night I won an argument that never happened, against a person who has no idea we were ever fighting.</p><p>You know how it goes. Someone said a small thing, days ago, almost certainly meaning nothing by it. And in the dark your mind takes it out, and sharpens it, and builds an entire courtroom around it. You deliver the perfect line. They have no answer. The imaginary audience is silenced by your composure. You win, completely, at two in the morning, against no one.</p><p>What unsettles me is the effort of it. I will forget a birthday, an appointment, the title of a book I loved. But this conversation, which does not exist, I have rehearsed in full, three times over, with revisions. My mind will build a cathedral to a slight and let a genuine kindness evaporate by lunchtime.</p><p>I think it is because the mind cannot bear an unfinished thing. A real conversation ends and is gone. An imagined one can be run again, and improved, and won, forever, which is exactly why it never sets you free. You are not preparing. There is nothing to prepare for. You are feeding something that only grows by being fed.</p><p>And the person is asleep. They are not thinking of you at all. That is the joke of it, and also the mercy. Nearly everyone you have ever argued with in the dark is, at that same moment, simply sleeping, being no one's villain, dreaming of something else entirely. Most of our enemies would be astonished to learn they had ever been cast.</p>"""},
    {"author_username": "quietly", "title": "The one who got away", "content":
     """<p>Here is a thought that will follow you around for days once you let it in. Somewhere out there, you are the one who got away.</p><p>Not to everyone. But to someone. A person you may barely remember, or remember far too well, is now and then stopped in their tracks, on an ordinary evening, by the thought of you. What might have been. The version of their life with you still in it. You are not the lead in that story. You are the ghost of it. The road they did not take, wearing your face.</p><p>It rearranges things, does it not. You spend your whole life as the protagonist, quietly cataloguing your own losses, the people you let slip through. It rarely occurs to you that you are also an entry in someone else's catalogue. That you have been, without any effort, without even remembering their surname any more, the great unanswered question of a life you are not living.</p><p>I find it strangely steadying. All of us walking around, each convinced we are the one who loved and lost, none of us realising we are also the one who was loved and lost by somebody else. The accounts balance. Every almost is felt from both sides, only never at the same moment, or the two of you would surely have done something about it.</p><p>So be gentle with the ones you let go, and gentler with yourself for the ones who let go of you. Somewhere tonight, a person you have not pictured in years is picturing you, softly, and then getting on with their evening. You will never know that it happened. It is happening anyway.</p>"""},
    # 32-33: the highest bar the user has set — poetic, quotable line by line,
    # gut-wrenching. One love, one nostalgia. Clean universal voice, no
    # colloquialisms, no death as the lever.
    {"author_username": "oliveandash", "title": "The last native speakers", "content":
     """<p>Every love invents a language, and every language has exactly two speakers.</p><p>Ours has a word for the particular light in the kitchen at five in the afternoon. It has a sound my partner makes that means "rescue me from this conversation," and another, almost identical, that means "do not rescue me, I am enjoying this." There is a whole grammar of glances. An entire literature composed in the raising of a single eyebrow across a crowded room.</p><p>Nobody taught us any of it. We built it the way coral builds a reef, one small secretion of meaning at a time: a joke that happened to survive, a mishearing we chose to keep, the name of a stranger neither of us can place, whose forgotten story somehow became our word for a certain kind of sadness. Years of this. A dictionary written in a hand that only two people on earth will ever read.</p><p>And here is the thought I cannot set down. A language with two speakers is always one goodbye away from being a language with none. Everything we have made, this fluent and secret country, cannot outlast the two of us. There will come a last time our word for the five o'clock light is ever spoken aloud, and after that it will be a sound the world does not contain, and no dictionary anywhere will record that it is missing.</p><p>So I have decided to be lavish about it. To spend the language recklessly while there are still two of us to speak it. To laugh at the oldest joke as though it were made this morning. Every marriage, every long friendship, is a small civilisation with a tongue of its own, and every one of them is always, quietly, the last of its kind. Say the words. Say them out loud, while they still mean something to someone who is not you.</p>"""},
    {"author_username": "unfinished", "title": "The one thing you can't keep", "content":
     """<p>You can keep almost everything from a moment except the one thing you wanted.</p><p>I can return to a particular afternoon when I was seven, in a garden that has since been sold, paved over, forgotten by everyone alive but me. I can give you the heat of the stone through my bare feet, the taste of something orange and frozen dissolving too fast in the sun, the exact pitch of my mother laughing at a joke I was too young to follow. I have all of it. Every detail is filed and safe.</p><p>Everything except the feeling. The whole, unbroken feeling of being seven and certain that nothing bad was coming. That is the one thing the memory will not give back. I can stand at the window of that afternoon with my hands flat against the glass and see the entire room, lit and warm and complete. I simply cannot get in. Nostalgia is precisely this: not the memory of a place, but the ache of being shut out of a feeling you once lived inside.</p><p>They tell you to hold on to moments. But you can no more hold a moment than you can hold running water. You can only wet your hands, and remember, long after, that it was cold. The photograph keeps the smile and loses the joy. The mind keeps the whole afternoon and quietly draws the sunlight out of it, year by year, until you are left with a perfect, colourless map of a country you can no longer afford to enter.</p><p>And still I go back, most days, and press my hands to the glass. Because there is a mercy folded inside the cruelty of it. If I can ache this much for a garden that no longer exists, then the feeling was real, and vast, and mine. To be homesick for your own life is proof that you were, at least once, wholly and unbearably alive inside it. And I would rather stand locked out of that afternoon forever than have never once stood within it.</p>"""},
    # 34-35: poetic, tighter (four movements), fresh non-digital topics. An
    # original take that wrenches. One a mother's hidden sacrifice, one the
    # grief that gets no ritual.
    {"author_username": "e.vestergaard", "title": "The wing", "content":
     """<p>For the whole of my childhood, my mother preferred the wing.</p><p>Every Sunday the good meat went onto our plates, and she took the small dark scrap with almost nothing on it, and said, without fail, that it was the part she liked best. I believed her the way you believe in weather. Some people like the wing. My mother was one of them. It was simply a fact about the world.</p><p>I was thirty before I understood that no one likes the wing. That there is no woman alive who prefers the scrap to the feast. There was only a woman who had done the arithmetic of a small kitchen a thousand times and found, each time, that there was just enough if she wanted less. She never sacrificed loudly. She called it a preference, so that we could eat without tasting the guilt, and it worked for twenty years.</p><p>This is the thing they never tell you about love: most of it happens where you cannot see it, disguised as something smaller. It hides inside the ordinary so well that you can sit at its table every week of your life and mistake it for a woman who simply liked the wing. I understand now. So I called her, and I did not explain why. I only asked what she would like to eat, if she could have anything in the world, and I listened to her hesitate, this woman who had spent my whole life insisting she wanted less. Then I went home, and I gave her the whole of it, and I watched her, at last, be hungry in front of me.</p>"""},
    {"author_username": "marginalia", "title": "The last ordinary day", "content":
     """<p>The friendships that mattered most did not end. That is the cruel part. They thinned, like a fog you never notice lifting until you look up and the whole street is clear and the fog is simply gone.</p><p>There was a last time my oldest friend and I spoke as ourselves, easily, in the old shorthand, and neither of us marked it, because neither of us knew. There was no argument. No betrayal. Only a call not returned quite as quickly, a season that got busy, a reply that landed a little flatter than before, and then the slow and courteous drift of two people becoming, by no decision at all, strangers who once knew everything about each other.</p><p>We hold funerals for people. We put on dark clothes and play slow music and set aside a whole day to say that a life mattered. But there is no ceremony for a friendship that fades. No gathering, no words, no casserole left on a doorstep. The person who once knew the whole of you becomes a name your thumb hovers over and moves past, and the world offers you no ritual for the grief, because technically nothing happened. Everyone is still alive. Somehow that is worse.</p><p>So let this be the ceremony. To everyone I loved and simply drifted from: I remember. I remember who I was when I was yours, and how safe it felt to be that known, and that no one since has ever laughed at quite that thing in quite that way. We did not fall out. We fell quiet. And wherever you are tonight, in the middle of your busy and faraway life, a person you long ago stopped calling still counts you, without a word, among the great loves of their life.</p>"""},
    # 36-37: hook-first, tight carousels (short slides, scroll-stopper slide 1).
    # the-toy = first love / first abandonment; your-name-was-a-wish = the name
    # chosen for you before you existed.
    {"author_username": "quietly", "title": "The toy", "content":
     """<p>There was a toy you loved so much you would have died for it. You couldn't tell me where it is now.</p><p>You took it everywhere. You worried when it was cold. You were certain, with your whole small heart, that it loved you back, and you weren't wrong to be, because you were pouring in enough love for two.</p><p>And then, one ordinary year, you simply stopped. No goodbye. No last hug you knew was the last. It slipped down the side of a bed, or into a box, or a bag for the charity shop, and you didn't cry, because you didn't notice. You had already gone.</p><p>It was the first thing you loved completely, and the first thing you left without knowing you were leaving. Somewhere it is still waiting: the small, patient face that taught you how to love, sitting exactly where you set it down, for a child who grew up and never came back.</p>"""},
    {"author_username": "e.vestergaard", "title": "Your name was a wish", "content":
     """<p>Before you were born, someone sat in a quiet room and said your name out loud, just to hear it. You weren't there yet. It was said to no one. It was said to you.</p><p>They were still choosing. Trying names on the empty air, imagining a face they had never seen, a whole person folded up inside a sound. Then they reached yours, and said it softly, into a future they had already put you in.</p><p>So your name was never really a word. It was the first wish anyone ever made for you. Hope, before it was a label. Spoken by someone who loved you before you had done a single thing to deserve it, when you were nothing but a possibility they couldn't wait to meet.</p><p>You've heard it a thousand times since. Shouted across playgrounds, called off registers, worn smooth in strangers' mouths. But it began as something whispered into an empty room. Every time your mother says it, that is what you are hearing. Not your name. The wish. Still being made.</p>"""},
]

# Benched (user passed on these; kept here unrendered in case they're wanted).
BENCHED_PIECES = [
    {"author_username": "saltmarsh", "title": "The two seconds", "content":
     """<p>My mate Dan got the job. The proper one, the one with the salary you don't say out loud. And when he told us at the pub there was a gap of about two seconds before I said "get in," and I want to be honest about what happened in those two seconds.</p><p>It wasn't joy. Joy turned up about a pint later, and it was real when it arrived. But first there was a cold little drop in my stomach, like missing a stair. He's off. I'm still here. Both feelings at full volume, at the same time.</p><p>We'll admit to road rage, hangovers, crying at adverts. Not to the flicker of poison when a friend does well. You're meant to be a good person, and we've decided good people don't get the flicker.</p><p>I think everyone gets the flicker. I think the whole test is the two seconds. Whether you swallow it and mean the toast. I meant the toast. I got the next round in. I was also about twenty minutes quieter than usual, and Dan, because he's Dan, pretended not to clock it.</p><p>He'd have had his own two seconds if it were me. I know he would. That's not friendship failing. That might just be what friendship is. Two people rooting for each other at ninety-eight percent, forever, both knowing it, neither saying.</p>"""},
    {"author_username": "paper_kite", "title": "The bread phase", "content":
     """<p>In January I was a runner. There's an app that can prove it. By March I was someone who bakes bread. For one strange fortnight in May, I was restoring a chair.</p><p>The starter is dead in the fridge and I feel worse about it than I expected. The trainers are by the door, dry as museum pieces. The chair sits in the spare room, half stripped, waiting for a version of me that no longer exists.</p><p>Flighty, my gran calls it. My dad has had one hobby for forty years and guards it like a border. Every few months he asks how the running's going, which is his little joke, and fair enough.</p><p>But I've stopped apologising. Each one was me trying on a life. The runner's life. The baker's, small and floury and warm. Two whole weeks of believing I was a person who fixes things. None of them fitted, and the only way to find that out was to wear them.</p><p>The sea swimming stuck. Two years now, every week, no app, no kit, no phase. You can never tell in advance which one will hold, so you keep trying them on. The chair can stay where it is. That room isn't a monument to quitting. It's a fitting room.</p>"""},
    {"author_username": "unfinished", "title": "Three seconds long", "content":
     """<p>Somewhere out there, a woman is telling a story about me. In it, I am "this absolute wally at Leeds station" who walked, at full speed, into a glass barrier in front of a hundred people, then took a small bow and vanished from her life forever.</p><p>It happened nine years ago. It remains the most embarrassing moment of my life. For her, it might be a favourite. Dinner table. "Tell the glass one," someone says. And there I go again, three seconds long, doing my bow in a kitchen I will never see.</p><p>I have my own cast, after all. The man who sprinted the whole length of a train to hand my dad his dropped glove. The woman who gave me her umbrella in a downpour, no explanation, and just walked off into it. I've told their three seconds a hundred times. They have no idea they're in the repertoire.</p><p>We think a life is the long thing we're doing here in the middle. But we're also scattered through everyone else's, in fragments, doing our little turn. A sentence in one house. A nickname in another. You will never find out how many rooms you're told in.</p><p>I hope the woman from Leeds keeps telling it. I hope she does the bow properly. If I'm going to be three seconds long in a stranger's head, let them be funny ones.</p>"""},
    {"author_username": "nightjar", "title": "Four hours", "content":
     """<p>I have been alive for thirty-four years and I can remember, if I'm honest, about four hours of it.</p><p>Not four hours in a row. Fragments. A red anorak on a beach. The smell of the stairwell in my first flat. Light crossing a ceiling in a room I can't place. The whole of 2017 has condensed into wet tarmac outside a chip shop, and I couldn't even tell you which town.</p><p>The rest happened. There are photographs, bank statements, a scar. Thousands of dinners were eaten. Somebody cut my hair three hundred times. None of it is missing, exactly. It has been folded into me so tightly it no longer opens.</p><p>This used to frighten me. What is the point of a Tuesday if it doesn't keep? But you don't remember eating, and here you are, fed. The lost years are the part of the house you never look at. Foundations don't ask to be remembered.</p><p>Still, once a day now, I stop and look at whatever is in front of me and think: this might be one of the frames that survives. It changes how you stand in a room. The mind keeps the chip shop and lets the wedding go. Nobody knows why. It is making the only copy of your life you will ever have, and it doesn't take requests.</p>"""},
]

def song_txt(title):
    primary, why, alt = SONGS.get(title, ("", "", ""))
    return (f"{title}\n\n"
            f"SONG: {primary}\n"
            f"WHY: {why}\n"
            f"ALT:  {alt}\n\n"
            f"Tip: search the song on TikTok and use the trending version "
            f"(often a slowed or sped-up edit) so it rides the sound.\n")

# ── Build ──────────────────────────────────────────────────────────────────
def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    data = json.load(open(os.path.join(here, "seed", "posts.json")))
    out = os.path.join(os.path.dirname(here), "tiktok-carousels")
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    for n, piece in enumerate(data["pieces"] + NEW_PIECES, 1):
        title = piece["title"]
        paras = to_paragraphs(piece["content"])
        folder = os.path.join(out, f"{n:02d}-{slug(title)}")
        os.makedirs(folder)
        pages = paginate(title, paras)
        i = 1
        for pi, groups in enumerate(pages):
            img = render_text_slide(title if pi == 0 else None, groups)
            img.save(os.path.join(folder, f"slide-{i}.png")); i += 1
        render_brand_slide().save(os.path.join(folder, f"slide-{i}.png"))
        with open(os.path.join(folder, "song.txt"), "w") as f:
            f.write(song_txt(title))
        print(f"  {n:02d}-{slug(title)}: {len(pages)} text + 1 closing + song.txt")
    print(f"Done -> {out}")

if __name__ == "__main__":
    main()
