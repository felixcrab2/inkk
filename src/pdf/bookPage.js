// Book-page PDF renderer.
//
// Parses the editor's HTML (paragraphs, line breaks and images), lays the
// content out on a high-DPI canvas with classical book typography
// (justified text, drop cap, paragraph indents, hard line breaks preserved),
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

// Canvas scale. 4× ≈ 288 dpi — crisp at Instagram sizes.
const PX = 4;
const CW = PAGE_W_PT * PX;
const CH = PAGE_H_PT * PX;

// Warm ink, slightly transparent under multiply for "absorbed letterpress".
const INK_BODY    = "#241a12";
const INK_TITLE   = "#1f1610";
const INK_FOOTER  = "#7a6a58";
const INK_HEADER  = "#a8967e";
const INK_ALPHA   = 0.93;

// Margins (pt). Generous, book-like.
const M_X       = 72;
const M_TOP     = 96;
const M_BOT     = 80;
const HEADER_Y  = 40;   // running header baseline (pt from top)
const FOOTER_FROM_BOTTOM = 34;

// Typography (pt).
const T_TITLE   = 13.5;
const T_HEADER  = 8.5;
const T_BODY    = 11.25;
const T_DROPCAP = 56;
const T_FOOTER  = 9;

// Drop cap spans this many body lines.
const DROPCAP_LINES = 3;

const LINE_H_PT      = T_BODY * 1.55;
const LINE_H         = LINE_H_PT * PX;
const PARA_GAP       = 4 * PX;
const PARA_INDENT_PT = 16;
const PARA_INDENT    = PARA_INDENT_PT * PX;

const IMG_VPAD_PT  = 12;
const IMG_VPAD     = IMG_VPAD_PT * PX;
const IMG_WIDTH_FRAC = 1.0;   // images fill the text measure (0–1)

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

function font(sizePt, italic = false) {
  return `${italic ? "italic " : ""}${sizePt * PX}px "Cormorant Garamond", "EB Garamond", Georgia, serif`;
}

// Parse the editor HTML into an ordered list of blocks:
//   { type: "text",  segments: ["seg-1 text", "seg-2 text", ...] }
//   { type: "image", src }
// Segments inside a text block are joined by hard line-breaks; blocks are
// joined by paragraph breaks.
function parseHtmlToBlocks(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";

  const tokens = [];
  function walk(node) {
    if (node.nodeType === 3) {
      if (node.nodeValue) tokens.push({ type: "text", text: node.nodeValue });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "img") {
      const src = node.getAttribute("src");
      if (src) tokens.push({ type: "image", src });
      return;
    }
    if (tag === "br") { tokens.push({ type: "break" }); return; }
    const block = tag === "div" || tag === "p" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "li" || tag === "blockquote";
    for (const child of node.childNodes) walk(child);
    if (block) tokens.push({ type: "break" });
  }
  for (const child of container.childNodes) walk(child);

  // Collapse into blocks.
  const blocks = [];
  let curText = [];
  let curSegments = [];
  let breaks = 0;

  const flushSeg = () => {
    if (curText.length) {
      const merged = curText.join("").replace(/\s+/g, " ").trim();
      if (merged) curSegments.push(merged);
      curText = [];
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
        if (parts[i]) curText.push(parts[i]);
        if (i < parts.length - 1) flushSeg();
      }
    } else if (tok.type === "break") {
      flushSeg();
      breaks++;
      if (breaks >= 2) { flushPara(); breaks = 0; }
    } else if (tok.type === "image") {
      breaks = 0;
      flushPara();
      blocks.push({ type: "image", src: tok.src });
    }
  }
  flushPara();
  return blocks;
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

function drawLine(ctx, line, x, y) {
  const text = line.text;
  if (!text) return;
  const words = text.split(" ").filter(Boolean);
  if (words.length <= 1 || line.endOfSegment) {
    ctx.fillText(text, x, y);
    return;
  }
  const wordsW = words.reduce((s, w) => s + ctx.measureText(w).width, 0);
  const totalGapsW = line.width - wordsW;
  const gapW = totalGapsW / (words.length - 1);
  const naturalGap = ctx.measureText(" ").width;
  if (gapW > naturalGap * MAX_GAP_RATIO || gapW < 0) {
    ctx.fillText(text, x, y);
    return;
  }
  let cx = x;
  for (let i = 0; i < words.length; i++) {
    ctx.fillText(words[i], cx, y);
    cx += ctx.measureText(words[i]).width + gapW;
  }
}

// Compute the height in canvas px an image will take given the available text
// width. Capped to a fraction of the page height so a tall photo doesn't push
// everything else out.
function imageDims(image, fullWidth, maxHeightOnPage) {
  if (!image || !image.naturalWidth) return { w: 0, h: 0 };
  const w = fullWidth * IMG_WIDTH_FRAC;
  let h = w * (image.naturalHeight / image.naturalWidth);
  if (h > maxHeightOnPage) {
    h = maxHeightOnPage;
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
        // Resize to fit remaining space if image is huge.
        const { w, h } = imageDims(it.img, fullWidth, otherPageHeight - 2 * IMG_VPAD);
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

async function renderOnePage({ texture, drawInk }) {
  const canvas = document.createElement("canvas");
  canvas.width  = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");

  // 1. Paper full-bleed.
  ctx.drawImage(texture, 0, 0, CW, CH);

  // 2. All ink (text + images) drawn under multiply blend, slightly
  //    transparent.
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = INK_ALPHA;
  drawInk(ctx);
  ctx.restore();

  // 3. Sparse grain for cohesion.
  ctx.save();
  ctx.globalAlpha = 0.025;
  ctx.fillStyle = "#1a1410";
  const STEP = 3;
  for (let y = 0; y < CH; y += STEP) {
    for (let x = 0; x < CW; x += STEP) {
      if (Math.random() < 0.008) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();

  // 4. Paper-on-paper soft-light pass — bakes fibres into both letters and
  //    photographs.
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.45;
  ctx.drawImage(texture, 0, 0, CW, CH);
  ctx.restore();

  return canvas;
}

/**
 * Render the book PDF for the given HTML body.
 *
 * @param {object} opts
 * @param {string} opts.title          — used as a small italic chapter title
 *                                       on page 1 (wraps) and a tiny running
 *                                       header on subsequent pages.
 * @param {string} opts.html           — editor HTML (paragraphs, line breaks,
 *                                       images preserved).
 * @param {function} opts.onPage       — async fn(canvas, pageIndex, totalPages)
 */
export async function renderBookPdfPages({ title, html, onPage }) {
  await document.fonts.ready;
  const texture = await loadTexture();

  // Measurement canvas (for wrap and layout calculations).
  const measure = document.createElement("canvas");
  measure.width = CW; measure.height = CH;
  const mctx = measure.getContext("2d");

  const fullWidth  = (PAGE_W_PT - M_X * 2) * PX;
  const bodyTop    = M_TOP * PX;
  const bodyBottom = (PAGE_H_PT - M_BOT) * PX;
  const otherPageHeight = bodyBottom - bodyTop;

  // ── Title (wrapped) ──────────────────────────────────────────────────────
  const titleStr = (title || "").trim();
  let titleLines = [];
  let titleBlockH = 0;
  if (titleStr) {
    mctx.font = font(T_TITLE, true);
    titleLines = wrapSegment(mctx, titleStr, fullWidth).map(l => l.text);
    if (!titleLines.length) titleLines = [titleStr];
    titleBlockH = titleLines.length * T_TITLE * PX * TITLE_LINE_MULT + 26 * PX;
  }
  const firstPageHeight = otherPageHeight - titleBlockH;

  // ── Body: parse and preload images ───────────────────────────────────────
  const blocks = parseHtmlToBlocks(html);
  // Strip leading empty text blocks.
  while (blocks.length && blocks[0].type === "text" && !blocks[0].segments.length) blocks.shift();

  // Drop cap based on the first character of the first text block.
  let firstChar = "";
  let useDropCap = false;
  if (blocks.length && blocks[0].type === "text" && blocks[0].segments.length) {
    const first = blocks[0].segments[0];
    const c = (first.match(/^\s*([A-Za-z])/) || [])[1];
    if (c) {
      firstChar = c.toUpperCase();
      useDropCap = true;
      // Remove the first letter from the first segment.
      blocks[0] = {
        type: "text",
        segments: [
          first.replace(/^\s*[A-Za-z]/, ""),
          ...blocks[0].segments.slice(1),
        ].map(s => s ?? ""),
      };
    }
  }

  const dropCapW   = useDropCap ? T_DROPCAP * PX * 0.72 : 0;
  const dropCapH   = useDropCap ? T_DROPCAP * PX * 0.95 : 0;
  const dropCapIndent = useDropCap ? dropCapW + 10 * PX : 0;

  // Preload images so we can size them during pagination.
  await Promise.all(blocks.filter(b => b.type === "image").map(async (b) => {
    b.img = await loadImg(b.src);
  }));

  // Build render items.
  const items = [];
  blocks.forEach((block, bi) => {
    if (block.type === "image") {
      if (block.img) items.push({ type: "image", img: block.img });
      return;
    }
    // text block
    if (bi > 0) items.push({ type: "gap" });
    let dropCapLinesLeft = (bi === 0 && useDropCap) ? DROPCAP_LINES : 0;
    const isFirstParaForIndent = bi > 0;
    block.segments.forEach((seg, si) => {
      // For segment 0 of a paragraph (not first paragraph) → first-line indent.
      const wantsParaIndent = si === 0 && isFirstParaForIndent;
      const wrapOpts = {};
      if (dropCapLinesLeft > 0) {
        wrapOpts.narrowCount = dropCapLinesLeft;
        wrapOpts.narrowWidth = fullWidth - dropCapIndent;
      } else if (wantsParaIndent) {
        wrapOpts.narrowCount = 1;
        wrapOpts.narrowWidth = fullWidth - PARA_INDENT;
      }
      mctx.font = font(T_BODY);
      const lines = wrapSegment(mctx, seg || "", fullWidth, wrapOpts);
      lines.forEach((ln, li) => {
        const item = {
          type: "line",
          text: ln.text,
          width: ln.width,
          endOfSegment: !!ln.endOfSegment,
        };
        if (li < (wrapOpts.narrowCount || 0)) {
          // Apply indent visually.
          if (dropCapLinesLeft > 0) {
            item.indent = dropCapIndent;
            dropCapLinesLeft = Math.max(0, dropCapLinesLeft - 1);
          } else if (wantsParaIndent && li === 0) {
            item.indent = PARA_INDENT;
          }
        } else if (dropCapLinesLeft > 0 && li >= (wrapOpts.narrowCount || 0)) {
          // Should not happen with the above wrapOpts, but be defensive.
          dropCapLinesLeft = 0;
        }
        items.push(item);
      });
      // If segment wrapped into fewer lines than dropCapLinesLeft, we still
      // need to consume those lines. Subtract by lines.length on top of what
      // was applied above? Already handled in the loop.
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
      drawInk(ctx) {
        ctx.textBaseline = "alphabetic";
        let y = bodyTop;

        // ── Page 1: small italic chapter title (wrapped) ────────────────
        if (isFirst && titleStr) {
          ctx.font = font(T_TITLE, true);
          ctx.fillStyle = INK_TITLE;
          ctx.textAlign = "center";
          for (const ln of titleLines) {
            ctx.fillText(ln, CW / 2, y + T_TITLE * PX);
            y += T_TITLE * PX * TITLE_LINE_MULT;
          }
          y += 18 * PX;       // space after title block
        }

        // ── Page 2+: tiny italic running header ─────────────────────────
        if (!isFirst && titleStr) {
          ctx.font = font(T_HEADER, true);
          ctx.fillStyle = INK_HEADER;
          ctx.textAlign = "center";
          // For long titles, truncate header — running header should be one line.
          mctx.font = font(T_HEADER, true);
          let hdr = titleStr;
          if (mctx.measureText(hdr).width > fullWidth) {
            while (hdr.length > 6 && mctx.measureText(hdr + "…").width > fullWidth) hdr = hdr.slice(0, -1);
            hdr += "…";
          }
          ctx.fillText(hdr, CW / 2, HEADER_Y * PX);
        }

        // ── Drop cap (page 1 only) ──────────────────────────────────────
        if (isFirst && useDropCap) {
          ctx.font = font(T_DROPCAP);
          ctx.fillStyle = INK_TITLE;
          ctx.textAlign = "left";
          // Cap baseline ≈ bottom of body line (DROPCAP_LINES-1)+1 (so cap
          // bottom aligns near the bottom of the last covered line).
          const capBaseline = y + Math.min(dropCapH, LINE_H * DROPCAP_LINES - 4 * PX);
          ctx.fillText(firstChar, M_X * PX, capBaseline);
        }

        // ── Body ────────────────────────────────────────────────────────
        ctx.font = font(T_BODY);
        ctx.fillStyle = INK_BODY;
        ctx.textAlign = "left";
        const leftX = M_X * PX;
        const baselineOffset = T_BODY * PX * 0.82;

        for (const it of pageItems) {
          if (it.type === "gap")   { y += PARA_GAP; continue; }
          if (it.type === "image") {
            const w = it._w, h = it._h;
            const x = (CW - w) / 2;
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
          drawLine(ctx, { text: it.text, width: it.width, endOfSegment: it.endOfSegment }, x, y + baselineOffset);
          y += LINE_H;
        }

        // ── Footer: pretty page number ──────────────────────────────────
        const footerBaseline = (PAGE_H_PT - FOOTER_FROM_BOTTOM) * PX;
        ctx.font = font(T_FOOTER, true);
        ctx.fillStyle = INK_FOOTER;
        ctx.textAlign = "center";
        // En-spaces around dots for elegance.
        ctx.fillText(`· ${pageNum} ·`, CW / 2, footerBaseline);
      },
    });

    await onPage(canvas, pi, totalPages);
  }
}
