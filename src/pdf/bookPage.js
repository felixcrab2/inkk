// Book-page PDF renderer.
//
// Parses the editor's HTML (paragraphs, line breaks and images), lays the
// content out on a high-DPI canvas with classical book typography
// (justified text, paragraph indents, hard line breaks preserved),
// and embeds each page as a JPEG inside a custom-sized PDF.
//
// All ink (text and images) is drawn under `multiply` blend mode, then a
// second pass of the paper texture is applied in `soft-light` to bake the
// page's fibres into both letters and photographs.

import bookPaperTexture from "../assets/blankpage.jpg";

const TEX_W = 1450;
const TEX_H = 1930;

export const PAGE_W_PT = 480;                                      // ~6.67"
export const PAGE_H_PT = Math.round(PAGE_W_PT * (TEX_H / TEX_W));  // ~639

// Canvas scale (supersampling). 6× ≈ 432 dpi — crisp text and images in print
// and at Instagram sizes. Higher = sharper output at the cost of memory/time.
const PX = 6;

// Preset page dimensions (pt) for Instagram-style PNG exports.
export const PAGE_PRESETS = {
  book:         { w: PAGE_W_PT, h: PAGE_H_PT },              // 480 × 639
  square:       { w: 480, h: 480 },                          // 1:1 (Instagram post)
  portrait:     { w: 480, h: 600 },                          // 4:5 (Instagram portrait)
};

// Solid black ink at full opacity for crisp, fully-black text on the page.
const INK_BODY    = "#000000";
const INK_TITLE   = "#000000";
const INK_FOOTER  = "#000000";
const INK_HEADER  = "#000000";   // running head (author) — black, like the body
const INK_ALPHA   = 1.0;

// Paper tone: heavy desaturation + slight brightness for near-white paper.
// Lower saturation pulls the yellow out; the brightness lift keeps it a touch
// brighter than the raw scan without going to bleached white.
const PAPER_FILTER = "saturate(0.34) brightness(1.045)";

// The scanned sheet has a warm "tea-dipped" darkening in its lower corners and
// edges. Compositing a warm paper tone in `lighten` raises only the pixels
// darker than the tone toward it, so the heavy corners come up to an even,
// luminous paper while the bright field and fibre texture stay untouched (a
// flat fill or symmetric vignette would wash out the texture or miss the
// asymmetric staining). Kept warm and below pure white so it still reads as
// paper, not bleached stock.
const PAPER_LIFT_COLOR = "rgb(246, 244, 240)";
const PAPER_LIFT_ALPHA = 0.87;

// Header / footer offsets (pt). Margins are now computed proportionally
// per page size inside renderBookPdfPages so non-default aspects still
// look book-like.
const HEADER_Y  = 40;   // running header baseline (pt from top)
const FOOTER_FROM_BOTTOM = 34;

// Typography (pt).
// Title is kept only slightly larger than the body so the rendered page
// matches the editor, where the title sits just above the prose size.
const T_TITLE   = 12.0;
const T_HEADER  = 6.0;   // running head (author): a lot smaller than the body
const T_BODY    = 11.25;
const T_FOOTER  = 10.5;

// Letter-spacing (em) for the uppercase running head — the wide tracking is
// what makes small caps read as deliberate rather than faded.
const HEADER_TRACK = 0.16;

// Letter-spacing (em) for the page-1 title. Kept very tight to match the
// editor's uppercase title (CSS letter-spacing: -0.02em).
const TITLE_TRACK = -0.02;

const LINE_H_PT      = T_BODY * 1.55;
const LINE_H         = LINE_H_PT * PX;
// A clear blank-line-ish break between paragraphs (applies in both plain and
// indented modes, so an indented paragraph also gets a visible break).
const PARA_GAP       = Math.round(LINE_H * 0.6);
const PARA_INDENT_PT = 16;
const PARA_INDENT    = PARA_INDENT_PT * PX;

const IMG_VPAD_PT  = 12;
const IMG_VPAD     = IMG_VPAD_PT * PX;

// Title wrap leading multiplier.
const TITLE_LINE_MULT = 1.3;

// Justification: collapse to flush-left if word gaps would exceed this
// multiple of the natural space width.
const MAX_GAP_RATIO  = 2.6;

// ── helpers ───────────────────────────────────────────────────────────────

let textureCache = null;
function loadTexture() {
  if (textureCache) return textureCache;
  textureCache = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = bookPaperTexture;
  });
  return textureCache;
}

function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function font(sizePt, italic = false, bold = false) {
  return `${italic ? "italic" : "normal"} ${bold ? "600" : "400"} ${sizePt * PX}px "Cormorant Garamond", "EB Garamond", Georgia, serif`;
}

// Width of `text` if drawn with per-character tracking (canvas has no native
// letter-spacing we can rely on across export environments, so we measure and
// place glyphs ourselves).
function trackedWidth(ctx, text, sizePt, trackEm) {
  const tracking = trackEm * sizePt * PX;
  const chars = [...text];
  let w = 0;
  for (const ch of chars) w += ctx.measureText(ch).width;
  return w + tracking * Math.max(0, chars.length - 1);
}

// Draw `text` centred on `cx` with even letter-spacing. Assumes ctx.font/
// fillStyle are already set; restores textAlign afterwards.
function drawTrackedCentered(ctx, text, cx, baseline, sizePt, trackEm) {
  const tracking = trackEm * sizePt * PX;
  const chars = [...text];
  const widths = chars.map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  let x = cx - total / 2;
  chars.forEach((ch, i) => { ctx.fillText(ch, x, baseline); x += widths[i] + tracking; });
  ctx.textAlign = prevAlign;
}

// Parse the editor HTML into an ordered list of blocks:
//   { type: "text",  segments: [ [run, run, ...], [run, ...] ] }   // styled runs
//   { type: "image", src }
// A run is { text, b, i }. Segments inside a text block are joined by hard
// line-breaks; blocks are joined by paragraph breaks.
export function parseHtmlToBlocks(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";

  // tokens: { type: "text", text, b, i } | { type: "image", src } | { type: "break" }
  const tokens = [];
  function walk(node, ctx) {
    if (node.nodeType === 3) {
      if (node.nodeValue) tokens.push({ type: "text", text: node.nodeValue, b: ctx.b, i: ctx.i });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "img") {
      const src = node.getAttribute("src");
      if (src) {
        // Honor the editor's per-image width (inline "width:NN%") and alignment
        // (data-align). Default: full measure, centered.
        let frac = 1;
        const wStyle = node.style && node.style.width;
        if (wStyle && wStyle.endsWith("%")) {
          const p = parseFloat(wStyle);
          if (p > 0 && p <= 100) frac = p / 100;
        }
        const align = (node.dataset && node.dataset.align) || "center";
        tokens.push({ type: "image", src, frac, align });
      }
      return;
    }
    if (tag === "br") { tokens.push({ type: "break" }); return; }
    const block = tag === "div" || tag === "p" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "li" || tag === "blockquote";
    const fw = node.style?.fontWeight;
    const fs = node.style?.fontStyle;
    const next = {
      b: ctx.b || tag === "b" || tag === "strong" || fw === "bold" || +fw >= 600,
      i: ctx.i || tag === "i" || tag === "em" || fs === "italic" || fs === "oblique",
    };
    // A block element both starts and ends a paragraph. The leading break is
    // what keeps a block (e.g. a <div> paragraph) from merging into preceding
    // bare text — without it the first two paragraphs run together. Empty
    // breaks collapse harmlessly during the block-building pass below.
    if (block) tokens.push({ type: "break" });
    for (const child of node.childNodes) walk(child, next);
    if (block) tokens.push({ type: "break" });
  }
  for (const child of container.childNodes) walk(child, { b: false, i: false });

  // Collapse into blocks.
  const blocks = [];
  let curRuns = [];     // current segment's runs
  let curSegments = []; // current paragraph's segments
  let breaks = 0;

  const flushSeg = () => {
    if (curRuns.length) {
      const trimmed = trimRuns(mergeAdjacentRuns(curRuns));
      if (trimmed.length) curSegments.push(trimmed);
      curRuns = [];
    }
  };
  const flushPara = () => {
    flushSeg();
    if (curSegments.length) {
      blocks.push({ type: "text", segments: curSegments });
      curSegments = [];
    }
  };

  for (const tok of tokens) {
    if (tok.type === "text") {
      breaks = 0;
      const parts = tok.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) curRuns.push({ text: parts[i], b: tok.b, i: tok.i });
        if (i < parts.length - 1) flushSeg();
      }
    } else if (tok.type === "break") {
      flushSeg();
      breaks++;
      if (breaks >= 1) { flushPara(); breaks = 0; }
    } else if (tok.type === "image") {
      breaks = 0;
      flushPara();
      blocks.push({ type: "image", src: tok.src, frac: tok.frac, align: tok.align });
    }
  }
  flushPara();
  return blocks;
}

function mergeAdjacentRuns(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.b === r.b && last.i === r.i) last.text += r.text;
    else out.push({ text: r.text, b: r.b, i: r.i });
  }
  return out;
}

function trimRuns(runs) {
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  while (runs.length) {
    const t = runs[0].text.replace(/^\s+/, "");
    if (t === "") runs.shift();
    else { runs[0].text = t; break; }
  }
  while (runs.length) {
    const t = runs[runs.length - 1].text.replace(/\s+$/, "");
    if (t === "") runs.pop();
    else { runs[runs.length - 1].text = t; break; }
  }
  return runs;
}

// Tokenize a list of runs into word/space units. Words straddling style
// boundaries are kept as single tokens with multiple "sub" segments so
// wrapping never splits an italicized fragment from the rest of its word.
function tokenizeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const re = /\s+|\S+/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const text = m[0];
      const isSpace = /\s/.test(text[0]);
      const last = out[out.length - 1];
      if (last && !last.isSpace && !isSpace) {
        last.subs.push({ text, b: r.b, i: r.i });
      } else {
        out.push({ isSpace, subs: [{ text, b: r.b, i: r.i }] });
      }
    }
  }
  return out;
}

function measureToken(ctx, tok) {
  let w = 0;
  let curFont = null;
  for (const s of tok.subs) {
    const f = font(T_BODY, s.i, s.b);
    if (f !== curFont) { ctx.font = f; curFont = f; }
    w += ctx.measureText(s.text).width;
  }
  return w;
}

// Wrap a single text segment into lines, supporting a narrower width for the
// first `narrowCount` lines (used for drop cap and first-line indent).
function wrapSegment(ctx, text, fullWidth, opts = {}) {
  const { narrowCount = 0, narrowWidth = fullWidth } = opts;
  const widthFor = (i) => i < narrowCount ? narrowWidth : fullWidth;
  const out = [];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return out;

  let line = "";
  let idx = 0;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= widthFor(idx)) {
      line = test;
    } else {
      if (line) { out.push({ text: line, width: widthFor(idx) }); idx++; }
      if (ctx.measureText(w).width > widthFor(idx)) {
        // Break overlong word by character.
        let chunk = "";
        for (const ch of w) {
          if (ctx.measureText(chunk + ch).width > widthFor(idx)) {
            out.push({ text: chunk, width: widthFor(idx) }); idx++;
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      } else {
        line = w;
      }
    }
  }
  if (line) out.push({ text: line, width: widthFor(idx) });
  if (out.length) out[out.length - 1].endOfSegment = true;
  return out;
}

// Wrap a styled segment (array of runs) into lines, supporting narrow first
// lines (drop cap / paragraph indent). Each line is { tokens, width,
// endOfSegment } where tokens preserve per-character style.
function wrapRuns(ctx, runs, fullWidth, opts = {}) {
  const { narrowCount = 0, narrowWidth = fullWidth } = opts;
  const widthFor = (i) => i < narrowCount ? narrowWidth : fullWidth;
  const tokens = tokenizeRuns(runs);
  if (!tokens.length) return [];

  const lines = [];
  let cur = [];
  let curW = 0;
  let idx = 0;

  const pushLine = (markEnd = false) => {
    const trimmed = dropTrailingSpaces(cur);
    if (trimmed.length || markEnd) {
      lines.push({ tokens: trimmed, width: widthFor(idx), endOfSegment: markEnd });
    }
    cur = []; curW = 0; idx++;
  };

  for (const t of tokens) {
    if (cur.length === 0 && t.isSpace) continue; // skip leading space on a line
    const w = measureToken(ctx, t);
    const lineMax = widthFor(idx);
    if (curW + w > lineMax && cur.length) {
      if (t.isSpace) { pushLine(); continue; }
      pushLine();
      cur.push({ ...t, _w: w });
      curW = w;
      continue;
    }
    cur.push({ ...t, _w: w });
    curW += w;
  }
  if (cur.length) {
    lines.push({ tokens: dropTrailingSpaces(cur), width: widthFor(idx), endOfSegment: true });
  } else if (lines.length) {
    lines[lines.length - 1].endOfSegment = true;
  }
  return lines;
}

function dropTrailingSpaces(toks) {
  let i = toks.length - 1;
  while (i >= 0 && toks[i].isSpace) i--;
  return toks.slice(0, i + 1);
}

function drawTokenLine(ctx, tokens, lineWidth, x, y, endOfSegment, justify = true) {
  if (!tokens.length) return;
  let natural = 0;
  for (const t of tokens) natural += t._w;

  // Justify only when enabled, not last line of segment, and there's something to stretch.
  const spaceCount = tokens.filter(t => t.isSpace).length;
  let extra = 0;
  if (justify && !endOfSegment && spaceCount > 0) {
    // Use a roman-weight space width as the reference so style-mix doesn't trip
    // the MAX_GAP_RATIO sanity check.
    ctx.font = font(T_BODY);
    const naturalSpaceW = ctx.measureText(" ").width;
    extra = (lineWidth - natural) / spaceCount;
    if (extra < 0 || (naturalSpaceW + extra) > naturalSpaceW * MAX_GAP_RATIO) extra = 0;
  }

  let cx = x;
  let curFont = null;
  for (const t of tokens) {
    for (const s of t.subs) {
      const f = font(T_BODY, s.i, s.b);
      if (f !== curFont) { ctx.font = f; curFont = f; }
      ctx.fillText(s.text, cx, y);
      cx += ctx.measureText(s.text).width;
    }
    if (t.isSpace && extra) cx += extra;
  }
}

// Compute the height in canvas px an image will take given the available text
// width. Capped to a fraction of the page height so a tall photo doesn't push
// everything else out.
function imageDims(image, fullWidth, maxHeightOnPage, frac = 1) {
  if (!image || !image.naturalWidth) return { w: 0, h: 0 };
  const f = Math.min(1, Math.max(0.1, frac || 1));
  let w = fullWidth * f;
  let h = w * (image.naturalHeight / image.naturalWidth);
  if (h > maxHeightOnPage) {
    // Height-capped (very tall image): scale width down too to keep aspect.
    h = maxHeightOnPage;
    w = h * (image.naturalWidth / image.naturalHeight);
  }
  return { w, h };
}

// Take a list of render items and pack into pages, respecting available
// vertical space.
function paginate(items, firstPageHeight, otherPageHeight, fullWidth) {
  const pages = [];
  let i = 0;
  let isFirst = true;

  while (i < items.length) {
    const avail = isFirst ? firstPageHeight : otherPageHeight;
    let used = 0;
    const taken = [];
    let firstOfPage = true;

    while (i < items.length) {
      const it = items[i];
      let cost = 0;
      if (it.type === "line")     cost = LINE_H;
      else if (it.type === "gap") cost = PARA_GAP;
      else if (it.type === "image") {
        // Resize to the image's chosen width fraction, fitting remaining space.
        const { w, h } = imageDims(it.img, fullWidth, otherPageHeight - 2 * IMG_VPAD, it.frac);
        it._w = w; it._h = h;
        cost = h + 2 * IMG_VPAD;
      }
      if (firstOfPage && it.type === "gap") { i++; continue; }
      // If an image doesn't fit, bump to next page (unless it's so tall
      // nothing fits anywhere — then accept and crop on this page).
      if (it.type === "image" && used + cost > avail && taken.length) break;
      if (it.type !== "image" && used + cost > avail) break;
      taken.push(it); used += cost; i++; firstOfPage = false;
    }
    pages.push(taken);
    if (!taken.length) break;
    isFirst = false;
  }
  return pages;
}

// ── page rendering ────────────────────────────────────────────────────────

async function renderOnePage({ texture, drawInk, cw, ch, paperTexture }) {
  const canvas = document.createElement("canvas");
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  // High-quality resampling for the upscaled paper texture and any photos.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // 1. Background — paper texture or flat inkk background.
  if (paperTexture && texture) {
    ctx.save();
    ctx.filter = PAPER_FILTER;
    ctx.drawImage(texture, 0, 0, cw, ch);
    ctx.restore();

    // Lift the texture's dark, tea-stained corners/edges toward an even paper
    // tone before any ink is laid down (so text stays crisp on top).
    ctx.save();
    ctx.globalCompositeOperation = "lighten";
    ctx.globalAlpha = PAPER_LIFT_ALPHA;
    ctx.fillStyle = PAPER_LIFT_COLOR;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  } else {
    ctx.fillStyle = "#f3f2ef";
    ctx.fillRect(0, 0, cw, ch);
  }

  // 2. All ink (text + images) drawn under multiply blend, slightly
  //    transparent.
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = INK_ALPHA;
  drawInk(ctx);
  ctx.restore();

  if (paperTexture && texture) {
    // 3. Sparse grain for cohesion (only when paper is on).
    ctx.save();
    ctx.globalAlpha = 0.025;
    ctx.fillStyle = "#1a1410";
    const STEP = 3;
    for (let y = 0; y < ch; y += STEP) {
      for (let x = 0; x < cw; x += STEP) {
        if (Math.random() < 0.008) ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();

    // 4. Paper-on-paper soft-light pass — bakes fibres into both letters and
    //    photographs.
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = 0.18;
    ctx.filter = PAPER_FILTER;
    ctx.drawImage(texture, 0, 0, cw, ch);
    ctx.restore();
  }

  return canvas;
}

/**
 * Render the book PDF for the given HTML body.
 *
 * @param {object} opts
 * @param {string} opts.title          used as a chapter title on page 1
 *                                       (wraps) and a tiny running header on
 *                                       subsequent pages.
 * @param {string} opts.html           editor HTML (paragraphs, line breaks,
 *                                       images preserved).
 * @param {function} opts.onPage       async fn(canvas, pageIndex, totalPages)
 */
export async function renderBookPdfPages({ title, byline, html, onPage, options = {} }) {
  await document.fonts.ready;

  const {
    pageW            = PAGE_W_PT,
    pageH            = PAGE_H_PT,
    justify          = false,
    paragraphIndent  = false,
    paperTexture     = true,
  } = options;

  const texture = paperTexture ? await loadTexture() : null;
  const cw = pageW * PX;
  const ch = pageH * PX;
  // Proportional margins so non-default aspects still look book-like.
  const mX   = Math.round(pageW * 0.15);
  const mTop = Math.round(pageH * 0.15);
  const mBot = Math.round(pageH * 0.125);
  // Fixed gap between the title block and the body (≈ 1.5× a body line).
  const TITLE_BODY_GAP = 30 * PX;

  // Measurement canvas (for wrap and layout calculations).
  const measure = document.createElement("canvas");
  measure.width = cw; measure.height = ch;
  const mctx = measure.getContext("2d");

  const fullWidth  = (pageW - mX * 2) * PX;
  const bodyTop    = mTop * PX;
  const bodyBottom = (pageH - mBot) * PX;
  const otherPageHeight = bodyBottom - bodyTop;

  // ── Title (wrapped) ──────────────────────────────────────────────────────
  // Rendered as typed (natural case) to match the editor title. The running
  // head still small-caps it (book convention) where it is drawn.
  const titleStr  = (title  || "").trim();
  const bylineStr = (byline || "").trim();
  let titleLines = [];
  let titleBlockH = 0;
  if (titleStr) {
    mctx.font = font(T_TITLE, false, true);
    titleLines = wrapSegment(mctx, titleStr, fullWidth).map(l => l.text);
    if (!titleLines.length) titleLines = [titleStr];
    // The author lives in the running head (book convention), not under the
    // title — so the title block reserves only the title lines plus the gap.
    titleBlockH = titleLines.length * T_TITLE * PX * TITLE_LINE_MULT + TITLE_BODY_GAP;
  }
  const firstPageHeight = otherPageHeight - titleBlockH;

  // ── Body: parse and preload images ───────────────────────────────────────
  const blocks = parseHtmlToBlocks(html);
  // Strip leading empty text blocks.
  while (blocks.length && blocks[0].type === "text" && !blocks[0].segments.length) blocks.shift();

  // Preload images so we can size them during pagination.
  await Promise.all(blocks.filter(b => b.type === "image").map(async (b) => {
    b.img = await loadImg(b.src);
  }));

  // Build render items.
  const items = [];
  blocks.forEach((block, bi) => {
    if (block.type === "image") {
      if (block.img) items.push({ type: "image", img: block.img, frac: block.frac, align: block.align });
      return;
    }
    // text block
    if (bi > 0) items.push({ type: "gap" });
    const isFirstParaForIndent = bi > 0;
    block.segments.forEach((seg, si) => {
      // For segment 0 of a paragraph (not first paragraph) → first-line indent.
      const wantsParaIndent = paragraphIndent && si === 0 && isFirstParaForIndent;
      const wrapOpts = {};
      if (wantsParaIndent) {
        wrapOpts.narrowCount = 1;
        wrapOpts.narrowWidth = fullWidth - PARA_INDENT;
      }
      const lines = wrapRuns(mctx, seg || [], fullWidth, wrapOpts);
      lines.forEach((ln, li) => {
        items.push({
          type: "line",
          tokens: ln.tokens,
          width: ln.width,
          endOfSegment: !!ln.endOfSegment,
          indent: (wantsParaIndent && li === 0) ? PARA_INDENT : 0,
        });
      });
    });
  });

  const pages = paginate(items, firstPageHeight, otherPageHeight, fullWidth);
  const totalPages = pages.length || 1;

  for (let pi = 0; pi < totalPages; pi++) {
    const isFirst = pi === 0;
    const pageNum = pi + 1;
    const pageItems = pages[pi] || [];

    const canvas = await renderOnePage({
      texture,
      cw, ch, paperTexture,
      drawInk(ctx) {
        ctx.textBaseline = "alphabetic";
        let y = bodyTop;

        // ── Running head (top of page, small tracked caps) ──────────────
        // Book convention: the author sits at the top of the opening page and
        // every verso (even) page; the title runs on recto (odd) continuation
        // pages. With no author, the opener stays clean and the title runs on
        // later pages. This is where attribution lives — never under the title.
        let headText = null;
        if (bylineStr && (isFirst || pageNum % 2 === 0)) headText = bylineStr;
        else if (!isFirst && titleStr)                   headText = titleStr;
        if (headText) {
          headText = headText.toUpperCase();
          ctx.font = font(T_HEADER, false);
          ctx.fillStyle = INK_HEADER;
          if (trackedWidth(ctx, headText, T_HEADER, HEADER_TRACK) > fullWidth) {
            while (headText.length > 6 && trackedWidth(ctx, headText + "…", T_HEADER, HEADER_TRACK) > fullWidth) headText = headText.slice(0, -1);
            headText += "…";
          }
          drawTrackedCentered(ctx, headText, cw / 2, HEADER_Y * PX, T_HEADER, HEADER_TRACK);
        }

        // ── Page 1: title (wrapped, centred) ────────────────────────────
        if (isFirst && titleStr) {
          ctx.font = font(T_TITLE, false, true);
          ctx.fillStyle = INK_TITLE;
          for (const ln of titleLines) {
            drawTrackedCentered(ctx, ln, cw / 2, y + T_TITLE * PX, T_TITLE, TITLE_TRACK);
            y += T_TITLE * PX * TITLE_LINE_MULT;
          }
          y += TITLE_BODY_GAP;
        }

        // ── Body ────────────────────────────────────────────────────────
        ctx.font = font(T_BODY);
        ctx.fillStyle = INK_BODY;
        ctx.textAlign = "left";
        const leftX = mX * PX;
        const baselineOffset = T_BODY * PX * 0.82;

        for (const it of pageItems) {
          if (it.type === "gap")   { y += PARA_GAP; continue; }
          if (it.type === "image") {
            const w = it._w, h = it._h;
            // Position within the text measure by the chosen alignment.
            let x;
            if (it.align === "left")       x = leftX;
            else if (it.align === "right") x = leftX + fullWidth - w;
            else                           x = leftX + (fullWidth - w) / 2;
            // Slight desaturation/contrast as a film/print look; multiply
            // blend (active on the surrounding save) bakes it into paper.
            ctx.save();
            ctx.filter = "saturate(0.78) brightness(1.02) contrast(0.95)";
            ctx.drawImage(it.img, x, y + IMG_VPAD, w, h);
            ctx.restore();
            y += h + 2 * IMG_VPAD;
            ctx.font = font(T_BODY);
            ctx.fillStyle = INK_BODY;
            ctx.textAlign = "left";
            continue;
          }
          // line
          const x = leftX + (it.indent || 0);
          drawTokenLine(ctx, it.tokens, it.width, x, y + baselineOffset, it.endOfSegment, justify);
          y += LINE_H;
        }

        // ── Footer: pretty page number ──────────────────────────────────
        const footerBaseline = (pageH - FOOTER_FROM_BOTTOM) * PX;
        ctx.font = font(T_FOOTER, true);
        ctx.fillStyle = INK_FOOTER;
        ctx.textAlign = "center";
        // En-spaces around dots for elegance.
        ctx.fillText(`· ${pageNum} ·`, cw / 2, footerBaseline);
      },
    });

    await onPage(canvas, pi, totalPages);
  }
}
