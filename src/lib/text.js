// In-place smart typography on the contenteditable. Looks at the text around
// the caret and rewrites common ASCII sequences into proper book glyphs.
// Invisible to the user — no toolbar, no shortcuts.
export function applySmartTypography() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const offset = range.startOffset;
  const text = node.nodeValue;
  if (!text) return;
  const before = text.slice(0, offset);
  const after  = text.slice(offset);
  const setCaret = (n, off) => { try { sel.collapse(n, off); } catch {} };

  // Auto-list: "- " or "N. " at the very start of a paragraph.
  // Chrome sometimes places a <br> placeholder before the text node in a new
  // div, so we allow that as "first in paragraph" too.
  if (before === "- " || /^\d+\. $/.test(before)) {
    const parent = node.parentElement;
    const prevSib = node.previousSibling;
    const isFirstInPara = !prevSib ||
      (prevSib.nodeType === Node.ELEMENT_NODE && prevSib.tagName === "BR" && !prevSib.previousSibling);
    if (isFirstInPara && parent) {
      let listDiv = null;
      if (parent.id === "text") {
        // Bare text node directly in #text — wrap it in a div first
        const wrapper = document.createElement("div");
        parent.insertBefore(wrapper, node);
        wrapper.appendChild(node);
        listDiv = wrapper;
      } else if (["DIV","P"].includes(parent.tagName) && parent.parentElement?.id === "text") {
        listDiv = parent;
      }
      if (listDiv) {
        // Remove any <br> placeholder that was inside the div
        listDiv.querySelectorAll("br").forEach(br => br.remove());
        if (before === "- ") {
          node.nodeValue = "\u2022 " + after;
          listDiv.setAttribute("data-list", "bullet");
        } else {
          const num = before.match(/^(\d+)\. $/)[1];
          node.nodeValue = num + ". " + after;
          listDiv.setAttribute("data-list", "ordered");
        }
        setCaret(node, before.length);
        return;
      }
    }
  }

  // Em dash: -- → —
  if (before.endsWith("--")) {
    node.nodeValue = before.slice(0, -2) + "—" + after;
    setCaret(node, offset - 1);
    return;
  }
  // Ellipsis: ... → …
  if (before.endsWith("...")) {
    node.nodeValue = before.slice(0, -3) + "…" + after;
    setCaret(node, offset - 2);
    return;
  }
  // Curly double quote.
  if (before.endsWith('"')) {
    const prev = before.length >= 2 ? before[before.length - 2] : "";
    const opening = !prev || /[\s([{—–]/.test(prev);
    const glyph = opening ? "“" : "”";
    node.nodeValue = before.slice(0, -1) + glyph + after;
    setCaret(node, offset);
    return;
  }
  // Curly single quote / apostrophe.
  if (before.endsWith("'")) {
    const prev = before.length >= 2 ? before[before.length - 2] : "";
    const opening = !prev || /[\s([{—–]/.test(prev);
    const glyph = opening ? "‘" : "’";
    node.nodeValue = before.slice(0, -1) + glyph + after;
    setCaret(node, offset);
    return;
  }

  // Markdown emphasis on close: *word*/_word_ → italic, **word**/__word__ → bold.
  // The opening marker must sit at a word boundary, so snake_case, file_names and
  // "2 * 3" are left alone.
  const lastCh = before.slice(-1);
  if ((lastCh === "_" || lastCh === "*") && node.parentNode) {
    const mBold = before.match(/(^|[\s([{“‘"'—–])(\*\*|__)([^\s*_][^*_\n]*?)\2$/);
    const mItal = before.match(/(^|[\s([{“‘"'—–])([*_])([^\s*_][^*_\n]*?)\2$/);
    const m = mBold || mItal;
    if (m) {
      const pre = m[1], inner = m[3];
      const startIdx = offset - (m[0].length - pre.length);   // index of the opening marker
      node.nodeValue = text.slice(0, startIdx);               // keep text before it (incl. pre)
      const el = document.createElement(mBold ? "strong" : "em");
      el.textContent = inner;
      const afterNode = document.createTextNode(after);
      node.parentNode.insertBefore(afterNode, node.nextSibling);
      node.parentNode.insertBefore(el, afterNode);
      setCaret(afterNode, 0);
      return;
    }
  }
}

export function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const r = document.createRange();
  r.setStart(pos.offsetNode, pos.offset);
  r.collapse(true);
  return r;
}

export async function compressImage(file, maxDim = 2600) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = e => {
      const img = new window.Image();
      img.onerror = () => resolve(null);   // undecodable format (e.g. HEIC)
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";   // crisper downscaling
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Title case ────────────────────────────────────────────────────────────────
// Capitalize a title the conventional way: the first and last word always go up,
// and the first word after a colon (subtitle); short "minor" words (articles,
// coordinating conjunctions, short prepositions) stay down in between. Acronyms
// and intentional mixed-case (NASA, iPhone) are preserved.
export const TITLE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "en", "for", "if", "in", "nor",
  "of", "on", "or", "per", "so", "the", "to", "v", "vs", "via", "yet",
]);

export function capitalizeTitleWord(word) {
  // Capitalize each hyphen-separated part: "self-portrait" -> "Self-Portrait".
  return word.split("-").map(part => {
    if (!part) return part;
    // Preserve acronyms (NASA) and intentional inner caps (iPhone, McCoy).
    if (/[A-Z]/.test(part.slice(1)) || (part.length > 1 && part === part.toUpperCase())) return part;
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join("-");
}

export function titleCase(input) {
  const str = (input || "").replace(/\s+/g, " ").trim();
  if (!str) return str;
  const words = str.split(" ");
  const last = words.length - 1;
  let capNext = true;   // first word always capitalized
  return words.map((word, i) => {
    const forceCap = capNext || i === last;
    capNext = /:$/.test(word);   // word after a colon starts a subtitle
    const bare = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!forceCap && TITLE_MINOR_WORDS.has(bare)) return word.toLowerCase();
    return capitalizeTitleWord(word);
  }).join(" ");
}

// Title-case the words the user has already finished (those followed by
// whitespace), leaving the word currently being typed alone — except the first
// word, which is always capitalized. Last-word/minor-word fixes happen in the
// full titleCase() pass on blur/Enter. Case-only, so caret offsets stay valid.
export function liveTitleCase(text) {
  if (!text) return text;
  const trailingWS = /\s$/.test(text);
  const parts = text.split(/(\s+)/);   // words at even indices, whitespace at odd
  let lastWordIdx = -1;
  for (let i = 0; i < parts.length; i++) if (i % 2 === 0 && parts[i] !== "") lastWordIdx = i;
  let firstSeen = false;
  let capNext = true;
  return parts.map((tok, i) => {
    if (i % 2 === 1 || tok === "") return tok;
    const isFirst = !firstSeen; firstSeen = true;
    const inProgress = i === lastWordIdx && !trailingWS;
    const forceCap = capNext;
    capNext = /:$/.test(tok);
    if (inProgress && !isFirst) return tok;   // don't touch the word being typed
    const bare = tok.toLowerCase().replace(/[^a-z]/g, "");
    if (!forceCap && TITLE_MINOR_WORDS.has(bare)) return tok.toLowerCase();
    return capitalizeTitleWord(tok);
  }).join("");
}

// Caret offset (character count from start) within a single-line editable.
export function titleCaretOffset(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

export function setTitleCaret(el, offset) {
  const node = el.firstChild;
  if (!node) return;
  const len = (node.textContent || "").length;
  const range = document.createRange();
  range.setStart(node, Math.min(offset, len));
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function isMobile() {
  if (typeof navigator === "undefined") return false;
  // Direct signals.
  if (navigator.maxTouchPoints > 0) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")) return true;
  // A phone with "Request Desktop Site" on sends a desktop user-agent and can
  // report maxTouchPoints as 0 — but its primary pointer is still a finger and
  // the physical screen stays small. Without catching this it would wrongly get
  // the in-page Google button, which dead-ends on mobile (gsi/transform), so we
  // treat a coarse-pointer or small-screen device as mobile too.
  try {
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
    const w = window.screen && window.screen.width;
    if (w && w <= 820) return true;
  } catch {}
  return false;
}
