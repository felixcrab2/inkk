// Book-page PDF renderer.
//
// Renders each page of a document onto a high-DPI canvas with a real
// paper-texture background and ink drawn in `multiply` composite mode,
// so the result is visually indistinguishable from a scanned book page.
//
// The canvas is then embedded as a single JPEG image per PDF page.

import bookPaperTexture from "../assets/blankpage.jpg";

const TEX_W = 1450;
const TEX_H = 1930;

// Page size in PDF points (1 pt = 1/72 in). Matches the texture's aspect
// (1450×1930 ≈ 0.751) so the paper doesn't get squashed.
export const PAGE_W_PT = 468;                                // ≈ 6.5"
export const PAGE_H_PT = Math.round(PAGE_W_PT * (TEX_H / TEX_W));   // ≈ 623

// Canvas render scale. 3× ≈ 216 dpi — crisp text without massive payloads.
const PX = 3;
const CW = PAGE_W_PT * PX;
const CH = PAGE_H_PT * PX;

// Colours — warm dark ink reads as real letterpress on cream paper.
const INK         = "#1a1410";
const INK_MUTED   = "#605044";
const INK_FAINT   = "#8c7a68";
const INK_RULE    = "#b8a892";

// Margins (pt, in page space).
const M_X   = 56;
const M_TOP = 64;
const M_BOT = 56;

// Typography (pt). Scaled up by PX when drawing to canvas.
const T_TITLE   = 22;
const T_BYLINE  = 9.5;
const T_HS      = 8;
const T_BODY    = 11.5;
const T_DROPCAP = 36;
const T_FOOTER  = 8.5;

// Line metrics, already in canvas-px scale (matches the *PX usages below).
const LINE_H    = T_BODY * 1.62 * PX;
const PARA_GAP  = 9 * PX;

// ── helpers ────────────────────────────────────────────────────────────────

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

function font(sizePt, italic = false) {
  // Use the @fontsource Cormorant Garamond family already loaded by App.
  return `${italic ? "italic " : ""}${sizePt * PX}px "Cormorant Garamond", "EB Garamond", Georgia, serif`;
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (!para.trim()) { out.push(""); continue; }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) out.push(line);
        // word longer than maxWidth — break by character.
        if (ctx.measureText(w).width > maxWidth) {
          let chunk = "";
          for (const ch of w) {
            if (ctx.measureText(chunk + ch).width > maxWidth) {
              out.push(chunk); chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = w;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// Paginate body paragraphs into pages of lines, respecting available
// vertical space on each page (smaller on the first, where the title block
// lives).
function paginate({ ctx, paragraphs, maxWidth, firstPageHeight, otherPageHeight, dropCap }) {
  const all = [];   // array of { type:"line"|"gap", text? }
  paragraphs.forEach((para, pi) => {
    if (pi > 0) all.push({ type: "gap" });
    const lines = wrapLines(ctx, para, maxWidth);
    for (const ln of lines) all.push({ type: "line", text: ln });
  });

  const pages = [];
  let i = 0, isFirst = true;
  while (i < all.length) {
    const avail = isFirst ? firstPageHeight : otherPageHeight;
    let used = 0;
    const lines = [];
    let firstLineOfPage = true;
    while (i < all.length) {
      const item = all[i];
      const cost = item.type === "gap" ? PARA_GAP : LINE_H;
      // Skip leading gap if it's the very first item on the page (so para
      // breaks don't waste a top line).
      if (firstLineOfPage && item.type === "gap") { i++; continue; }
      if (used + cost > avail) break;
      lines.push(item);
      used += cost; i++; firstLineOfPage = false;
    }
    pages.push(lines);
    isFirst = false;
    if (!lines.length) break;   // safety
  }
  // Drop-cap-aware: drop cap shifts the first ~2 lines of page 1 rightward.
  if (dropCap && pages[0]) {
    let lineIndex = 0;
    for (let k = 0; k < pages[0].length && lineIndex < 2; k++) {
      if (pages[0][k].type === "line") { pages[0][k].indent = dropCap.indent; lineIndex++; }
    }
  }
  return pages;
}

// ── public renderer ───────────────────────────────────────────────────────

/**
 * Render a single page (as a canvas) — texture + ink-multiplied text.
 * Used internally; exported for tests/inspection.
 */
async function renderOnePage({ texture, drawInk }) {
  const canvas = document.createElement("canvas");
  canvas.width  = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");

  // Paper — fill bleed.
  ctx.drawImage(texture, 0, 0, CW, CH);

  // Subtle warmth tint to unify with the texture.
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  drawInk(ctx);
  ctx.restore();

  // Faint grain on top for cohesion.
  ctx.save();
  ctx.globalAlpha = 0.04;
  ctx.fillStyle = "#1a1410";
  for (let y = 0; y < CH; y += 2) {
    for (let x = 0; x < CW; x += 2) {
      if ((Math.random() * 100) < 1) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();

  return canvas;
}

/**
 * Render the full book PDF for the given content.
 *
 * @param {object} opts
 * @param {string} opts.title          — title for the title block
 * @param {string} opts.author         — author byline string
 * @param {string} opts.dateStr        — date string (already formatted)
 * @param {string} opts.body           — plain text body (paragraphs separated by blank lines)
 * @param {object} [opts.humanSignal]  — { tier, score, words } shown under byline
 * @param {function} addPage           — async fn(canvas, pageIndex) called per page;
 *                                       used by App.js to push pages into a jsPDF instance.
 */
export async function renderBookPdfPages({ title, author, dateStr, body, humanSignal, onPage }) {
  await document.fonts.ready;
  const texture = await loadTexture();

  // Measurement canvas (for wrap/pagination).
  const measure = document.createElement("canvas");
  measure.width = CW; measure.height = CH;
  const mctx = measure.getContext("2d");

  const bodyMaxWidth = (PAGE_W_PT - M_X * 2) * PX;
  const bodyTop = M_TOP * PX;
  const bodyBottom = (PAGE_H_PT - M_BOT) * PX;
  const otherPageHeight = bodyBottom - bodyTop;

  // Title block measurement (drives firstPageHeight).
  mctx.font = font(T_TITLE);
  const titleLines = wrapLines(mctx, title, bodyMaxWidth);
  const titleH = titleLines.length * T_TITLE * PX * 1.18 + 8 * PX;

  const bylineParts = [author, dateStr].filter(Boolean).join("  ·  ");
  const bylineH = bylineParts ? T_BYLINE * PX * 1.4 + 6 * PX : 0;

  const hsLine = humanSignal && (humanSignal.tier || humanSignal.score != null)
    ? `Human Signal: ${humanSignal.tier || ""}${humanSignal.score != null ? `  ·  ${humanSignal.score}/100` : ""}${humanSignal.words != null ? `  ·  ${humanSignal.words} words` : ""}`
    : null;
  const hsH = hsLine ? T_HS * PX * 1.4 + 4 * PX : 0;

  const ruleH = 16 * PX;
  const blockH = titleH + bylineH + hsH + ruleH + 18 * PX;     // extra spacer
  const firstPageHeight = otherPageHeight - blockH;

  // First-paragraph drop cap planning.
  mctx.font = font(T_BODY);
  const firstChar = (body.trim()[0] || "").toUpperCase();
  const dropCap = firstChar && /[A-Za-z]/.test(firstChar) ? {
    glyph: firstChar,
    width:  T_DROPCAP * PX * 0.72,
    height: T_DROPCAP * PX * 0.9,
    indent: T_DROPCAP * PX * 0.8,
  } : null;

  // Strip the first character from the body if we're using it as drop cap.
  const bodyText = dropCap ? body.trim().slice(1) : body;
  const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) paragraphs.push("");

  const pageLines = paginate({
    ctx: mctx, paragraphs, maxWidth: bodyMaxWidth,
    firstPageHeight, otherPageHeight, dropCap,
  });

  const totalPages = pageLines.length;

  for (let pi = 0; pi < totalPages; pi++) {
    const isFirst = pi === 0;
    const pageNum = pi + 1;

    const canvas = await renderOnePage({
      texture,
      drawInk(ctx) {
        ctx.textBaseline = "alphabetic";

        let y = bodyTop;

        // ── Title block (first page only) ─────────────────────────────────
        if (isFirst) {
          ctx.fillStyle = INK;
          ctx.font = font(T_TITLE);
          ctx.textAlign = "center";
          for (const ln of titleLines) {
            ctx.fillText(ln, CW / 2, y + T_TITLE * PX);
            y += T_TITLE * PX * 1.18;
          }
          y += 8 * PX;

          if (bylineParts) {
            ctx.fillStyle = INK_MUTED;
            ctx.font = font(T_BYLINE, true);   // italic byline
            ctx.fillText(bylineParts, CW / 2, y + T_BYLINE * PX);
            y += T_BYLINE * PX * 1.4 + 6 * PX;
          }

          if (hsLine) {
            ctx.fillStyle = INK_FAINT;
            ctx.font = font(T_HS);
            ctx.fillText(hsLine, CW / 2, y + T_HS * PX);
            y += T_HS * PX * 1.4 + 4 * PX;
          }

          // Rule under the title block.
          y += 6 * PX;
          ctx.strokeStyle = INK_RULE;
          ctx.lineWidth = 0.6 * PX;
          ctx.beginPath();
          ctx.moveTo(CW * 0.42, y);
          ctx.lineTo(CW * 0.58, y);
          ctx.stroke();
          y += 12 * PX;
        }

        // ── Body lines ────────────────────────────────────────────────────
        ctx.textAlign = "left";
        ctx.fillStyle = INK;
        ctx.font = font(T_BODY);
        const leftX = M_X * PX;

        // Drop cap (first page only, first paragraph).
        if (isFirst && dropCap) {
          ctx.fillStyle = INK;
          ctx.font = font(T_DROPCAP);
          ctx.textAlign = "left";
          // Drop cap baseline aligned with bottom of second body line.
          const capBaseline = y + T_DROPCAP * PX * 0.82;
          ctx.fillText(dropCap.glyph, leftX, capBaseline);
          ctx.font = font(T_BODY);
        }

        const items = pageLines[pi];
        for (const item of items) {
          if (item.type === "gap") { y += PARA_GAP; continue; }
          const x = leftX + (item.indent || 0);
          ctx.fillText(item.text, x, y + T_BODY * PX);
          y += LINE_H;
        }

        // ── Footer (brand + page number) ──────────────────────────────────
        const footerY = (PAGE_H_PT - 30) * PX;
        ctx.font = font(T_FOOTER, true);
        ctx.fillStyle = INK_FAINT;
        ctx.textAlign = "left";
        ctx.fillText("inkk.", M_X * PX, footerY);
        ctx.textAlign = "center";
        ctx.fillText(String(pageNum), CW / 2, footerY);
        ctx.textAlign = "right";
        ctx.fillText(`${pageNum} / ${totalPages}`, (PAGE_W_PT - M_X) * PX, footerY);
      },
    });

    await onPage(canvas, pi, totalPages);
  }
}
