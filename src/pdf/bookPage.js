// Book-page PDF renderer.
//
// Renders each page onto a very-high-DPI canvas with a real paper-texture
// background and warm ink drawn in `multiply` blend mode. Text is fully
// justified with classical book-style paragraph indentation. Each canvas
// is embedded as a JPEG in a custom-sized PDF — the result is meant to be
// shareable as a book-page image.

import bookPaperTexture from "../assets/blankpage.jpg";

const TEX_W = 1450;
const TEX_H = 1930;

// PDF page in points (1 pt = 1/72 in). Matches the texture's aspect so paper
// doesn't get squashed.
export const PAGE_W_PT = 480;                                      // ~6.67"
export const PAGE_H_PT = Math.round(PAGE_W_PT * (TEX_H / TEX_W));  // ~639

// Canvas render scale. 4× ≈ 288 dpi — text stays crisp at any export size.
const PX = 4;
const CW = PAGE_W_PT * PX;
const CH = PAGE_H_PT * PX;

// Warm ink — slightly lighter than pure black so the multiply blend with
// cream paper feels like absorbed letterpress ink rather than printed toner.
const INK_BODY    = "#241a12";
const INK_TITLE   = "#1f1610";
const INK_FOOTER  = "#7a6a58";
const INK_HEADER  = "#a8967e";
const INK_ALPHA   = 0.93;

// Margins (pt). Generous, book-like; outer margin slightly wider than top.
const M_X       = 64;
const M_TOP     = 86;
const M_BOT     = 70;
const HEADER_Y  = 36;   // running header baseline (in pt, from top)
const FOOTER_Y_FROM_BOTTOM = 32;

// Typography (pt).
const T_TITLE   = 13;     // first-page chapter heading — italic, small
const T_HEADER  = 8.5;    // running header on subsequent pages
const T_BODY    = 11.25;
const T_DROPCAP = 38;
const T_FOOTER  = 9;

// Leading and indents.
const LINE_H_PT      = T_BODY * 1.55;
const LINE_H         = LINE_H_PT * PX;
const PARA_GAP       = 4 * PX;          // tiny extra between paragraphs (most of the air comes from indent)
const PARA_INDENT_PT = 16;              // first-line indent (~1.4em)
const PARA_INDENT    = PARA_INDENT_PT * PX;

// Justification safety: collapse to left-aligned if gap-spacing would exceed
// this multiple of the natural space width (avoids huge gaps on short lines).
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

function font(sizePt, italic = false, smallCaps = false) {
  const variant = smallCaps ? "small-caps " : "";
  return `${italic ? "italic " : ""}${variant}${sizePt * PX}px "Cormorant Garamond", "EB Garamond", Georgia, serif`;
}

// Wrap a paragraph into lines, where the FIRST `narrowCount` lines may
// have a reduced width (for drop-cap wrap, or first-line indent).
function wrapPara(ctx, text, fullWidth, opts = {}) {
  const { narrowCount = 0, narrowWidth = fullWidth } = opts;
  const widthFor = (idx) => idx < narrowCount ? narrowWidth : fullWidth;
  const out = [];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [{ text: "", width: fullWidth }];

  let line = "";
  let idx = 0;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= widthFor(idx)) {
      line = test;
    } else {
      if (line) { out.push({ text: line, width: widthFor(idx) }); idx++; }
      // Word longer than the line width: break by character.
      if (ctx.measureText(w).width > widthFor(idx)) {
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
  // Mark the last line.
  if (out.length) out[out.length - 1].lastOfPara = true;
  if (out.length) out[0].firstOfPara = true;
  return out;
}

// Draw one line, justified across `lineWidth` from `x`, unless it's the last
// line of a paragraph or the spacing would look absurd — in which case draw it
// flush-left.
function drawLine(ctx, line, x, y) {
  const text = line.text;
  if (!text) return;
  const words = text.split(" ").filter(Boolean);
  if (words.length <= 1 || line.lastOfPara) {
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

// Paginate the body. Page 1 may have less vertical room (chapter title).
function paginate(items, firstPageHeight, otherPageHeight) {
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
      const cost = it.type === "gap" ? PARA_GAP : LINE_H;
      // Drop a leading paragraph gap at the very top of a page — it's just
      // wasted whitespace.
      if (firstOfPage && it.type === "gap") { i++; continue; }
      if (used + cost > avail) break;
      taken.push(it); used += cost; i++; firstOfPage = false;
    }
    pages.push(taken);
    if (!taken.length) break;        // safety
    isFirst = false;
  }
  return pages;
}

// ── public renderer ───────────────────────────────────────────────────────

async function renderOnePage({ texture, drawInk, drawDecor }) {
  const canvas = document.createElement("canvas");
  canvas.width  = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");

  // 1. Paper — full bleed.
  ctx.drawImage(texture, 0, 0, CW, CH);

  // 2. Ink, drawn with multiply blend so it lives in the paper, not on top.
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = INK_ALPHA;
  drawInk(ctx);
  ctx.restore();

  // 3. Sparse grain on top for cohesion (very faint).
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

  // 4. A second pass of the paper texture in `soft-light` blend mode at very
  // low opacity. This bakes the paper's fibres into the ink so the text looks
  // a little uneven, like absorbed letterpress.
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.45;
  ctx.drawImage(texture, 0, 0, CW, CH);
  ctx.restore();

  if (drawDecor) drawDecor(ctx);
  return canvas;
}

/**
 * Render the book PDF for the given content.
 *
 * @param {object} opts
 * @param {string} opts.title          — title (used as quiet chapter heading on page 1 and running header on page 2+)
 * @param {string} opts.body           — plain text body (paragraphs separated by blank lines)
 * @param {function} opts.onPage       — async fn(canvas, pageIndex, totalPages) called per page
 */
export async function renderBookPdfPages({ title, body, onPage }) {
  await document.fonts.ready;
  const texture = await loadTexture();

  const measure = document.createElement("canvas");
  measure.width = CW; measure.height = CH;
  const mctx = measure.getContext("2d");

  const fullWidth   = (PAGE_W_PT - M_X * 2) * PX;
  const bodyTop     = M_TOP * PX;
  const bodyBottom  = (PAGE_H_PT - M_BOT) * PX;
  const otherPageHeight = bodyBottom - bodyTop;

  // Title block measurement (drives firstPageHeight).
  const hasTitle = !!title && title.trim();
  const titleBlockH = hasTitle ? (T_TITLE * PX * 1.5 + 28 * PX) : 0;
  const firstPageHeight = otherPageHeight - titleBlockH;

  // Drop-cap planning.
  mctx.font = font(T_BODY);
  const firstChar = (body.trim()[0] || "").toUpperCase();
  const useDropCap = firstChar && /[A-Za-z]/.test(firstChar);
  const dropCapW   = useDropCap ? T_DROPCAP * PX * 0.72 : 0;
  const dropCapH   = useDropCap ? T_DROPCAP * PX * 0.95 : 0;
  const dropCapIndent = useDropCap ? dropCapW + 8 * PX : 0;

  // Wrap each paragraph.
  const trimmed = body.trim();
  const firstBodyText = useDropCap ? trimmed.slice(1) : trimmed;
  const paraTexts = firstBodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paraTexts.length) paraTexts.push("");

  // Build an ordered list of `{type:"line", ...}` and `{type:"gap"}` items.
  const items = [];
  paraTexts.forEach((para, pi) => {
    if (pi > 0) items.push({ type: "gap" });
    const isFirstPara = pi === 0;
    const wrapOpts = isFirstPara
      ? (useDropCap
        ? { narrowCount: 2, narrowWidth: fullWidth - dropCapIndent }
        : {})
      : { narrowCount: 1, narrowWidth: fullWidth - PARA_INDENT };
    const lines = wrapPara(mctx, para, fullWidth, wrapOpts);
    lines.forEach((ln, li) => {
      items.push({
        type: "line",
        text: ln.text,
        width: ln.width,
        firstOfPara: li === 0,
        lastOfPara: li === lines.length - 1,
        paraIndex: pi,
        lineInPara: li,
        // First two body lines of the drop-cap paragraph are indented around the cap.
        dropCapIndented: isFirstPara && useDropCap && li < 2,
        // First line of every paragraph except the dropcap one is indented.
        indented: !isFirstPara && li === 0,
      });
    });
  });

  const pages = paginate(items, firstPageHeight, otherPageHeight);
  const totalPages = pages.length;

  for (let pi = 0; pi < totalPages; pi++) {
    const isFirst = pi === 0;
    const pageNum = pi + 1;

    const canvas = await renderOnePage({
      texture,
      drawInk(ctx) {
        ctx.textBaseline = "alphabetic";
        let y = bodyTop;

        // ── Page 1: small italic chapter title ───────────────────────────
        if (isFirst && hasTitle) {
          ctx.font = font(T_TITLE, true);
          ctx.fillStyle = INK_TITLE;
          ctx.textAlign = "center";
          ctx.fillText(title.trim(), CW / 2, y + T_TITLE * PX);
          y += T_TITLE * PX * 1.5 + 28 * PX;
        }

        // ── Subsequent pages: running header with title in italic ─────────
        if (!isFirst && hasTitle) {
          ctx.font = font(T_HEADER, true);
          ctx.fillStyle = INK_HEADER;
          ctx.textAlign = "center";
          ctx.fillText(title.trim(), CW / 2, HEADER_Y * PX);
        }

        // ── Drop cap (page 1 only, before body) ──────────────────────────
        if (isFirst && useDropCap) {
          ctx.font = font(T_DROPCAP);
          ctx.fillStyle = INK_TITLE;
          ctx.textAlign = "left";
          // Drop cap baseline ≈ bottom of line 2 of body.
          const capBaseline = y + Math.min(dropCapH, LINE_H * 2 - 2 * PX);
          ctx.fillText(firstChar, M_X * PX, capBaseline);
        }

        // ── Body ─────────────────────────────────────────────────────────
        ctx.font = font(T_BODY);
        ctx.fillStyle = INK_BODY;
        ctx.textAlign = "left";
        const leftX = M_X * PX;
        const baselineOffset = T_BODY * PX * 0.82;

        for (const it of pages[pi]) {
          if (it.type === "gap") { y += PARA_GAP; continue; }
          let x = leftX;
          let lineWidth = it.width;
          if (it.dropCapIndented) {
            x = leftX + dropCapIndent;
          } else if (it.indented) {
            x = leftX + PARA_INDENT;
          }
          drawLine(ctx, { text: it.text, width: lineWidth, lastOfPara: it.lastOfPara }, x, y + baselineOffset);
          y += LINE_H;
        }

        // ── Footer (centered italic page number only) ────────────────────
        const footerBaseline = (PAGE_H_PT - FOOTER_Y_FROM_BOTTOM) * PX;
        ctx.font = font(T_FOOTER, true);
        ctx.fillStyle = INK_FOOTER;
        ctx.textAlign = "center";
        ctx.fillText(String(pageNum), CW / 2, footerBaseline);
      },
    });

    await onPage(canvas, pi, totalPages);
  }
}
