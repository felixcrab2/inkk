// inkk companion — the pixel mark: an INKK code carried by the ink of a name.
//
// When a writer signs an email, their name goes in as a small image. The
// pixels of that name carry the certificate's code, like a QR code only a
// computer can see: to a reader it is a name in near-black ink; to the
// desktop app, a screenshot of the email is enough to read the code back.
//
//   encodeMark(img, code) → { bits, groups, inkPixels }
//     img: { width, height, data } RGBA (Uint8ClampedArray, Uint8Array or
//     Buffer), the name drawn in dark ink on a transparent background (ink =
//     alpha) or on an opaque light one (ink = darkness against that
//     background). Recolours the ink in place, keeping every pixel's coverage.
//     bits: the 76-bit frame written; groups: ink groups (76 to 81, by the
//     name's shape); inkPixels: pixels recoloured. Throws Error("mark_too_small") when the ink cannot
//     hold the frame reliably (draw the name larger) and Error("bad_code").
//   decodeMarks(img, { format: "rgba" | "bgra" }) → [{ code, box, confidence }]
//     img: a screenshot of any size; box in its pixels; confidence 0..1,
//     best first. Only marks whose sync and CRC check out are reported.
//   BITS, codeToBits(code) → 60 bits, bitsToCode(bits) → code, crc8(bits).
//
// FRAME (76 bits). The code's 12 Crockford symbols are 60 bits (5 each, most
// significant first), followed by a CRC-8 of those bits (poly 0x07, init
// 0xFF). Those 68 bits are whitened with a fixed PN9 sequence, so every code,
// even INKK-0000-0000-0000, uses both inks about equally. Eight sync bits
// (10110100) sit spread across the frame at slots 0, 11, 21, 32, 43, 54, 64
// and 75. Sync and CRC together are 16 check bits.
//
// LAYOUT. Ink is weighed by coverage and read left to right (x, then y): it is
// cut into column bands holding equal ink, and each band into rows holding
// equal ink, one bit per cell; cells past 76 repeat the first slots. The cut
// points are quantiles of the ink itself, so the decoder recomputes them from
// whatever ink it sees, at any scale, without knowing the original size. The
// number of rows follows the ink's shape, round(sqrt(180 / aspect)) from 2 to
// 9 (aspect from ink quantiles, so also scale-free), which gives every bit a
// compact patch rather than a sliver of one stem. In EB Garamond,
// "Jonathan Abernethy" gets 4 rows, "Felix Crabtree" 5, "Ana Diaz" 6, "Felix"
// and "Jo Li" 8. Measured, 18 frames per cell: a fixed 2 x 38 read short
// names at 0.5x with chroma subsampling 0 times in 18 (now 18) and after JPEG
// q80 13 (now 18); in real Chromium "Jo Li" went from 8 of 18 rows to 18.
// Thin strips (1 x 76) and writing the frame twice (top and bottom halves as
// copies) both measured worse than one compact copy.
//
// INKS. Bit 1 is cool rgb(14, 26, 38), bit 0 warm rgb(38, 26, 14): the
// signature's ink #1a1a1a moved 12 steps each way along blue-red with green
// held midway, so the two average to exactly #1a1a1a and the name reads as
// plain near-black. Each is about ΔE00 8-9 from #1a1a1a (the spec's suggested
// rgb(16,20,40)/(40,20,16) are ΔE00 12, and average to a purple cast of ΔE00
// 8); inside 1-3 px strokes of 30 px type, chromatic detail at that level is
// far below what the eye resolves. 12 steps is the knee of a measured sweep
// (60 px names, 12 frames per cell): at 10, a colour cast of 4 per channel
// already defeats 4 frames in 12, at 8 all 12 and JPEG q80 2; at 12 and 14
// every cell reads 12/12. Holding green midway is also a signature: navy,
// brown, green and purple text all move green, so the decoder can tell them
// from the mark.
//
// DECODING. Candidate pixels are dark (luminance under 155) and weakly tinted
// (|B-R| at least 4 and between 3% and 30% of their darkness, which rules out
// neutral text, blue links and saturated colour). They are gathered on a 4 px
// grid into regions; each region's tinted components are grouped into lines of
// text (a photo or panel far taller than the letters is set aside) and the
// words of a line joined by gap against line height. Each line is then
// re-read from a box of its own, with the background, ink coverage and
// letters measured locally; untinted components inside the line (hairlines
// that lost their colour to blur) count as ink, while blobs far taller or
// more solid than the letters (an avatar, a logo) do not. The equal-ink groups
// are recomputed from the observed coverage (with the neighbouring row count
// too when the aspect sits near a boundary), and each bit's tint is solved by
// least squares from the whole tint field, modelling the extra blur chroma
// picks up (Gaussian, three widths: resampling, 4:2:0 subsampling, JPEG).
// A read counts only if it looks like a mark: two tint levels, each at least
// 16 of 76 bits, symmetric about a small offset (a colour cast moves both),
// 4 to 40 apart per level, green neutral, and not a smear. Then sync + CRC
// must pass; failing that, on the cleanest read only and only when it is
// nearly clean, up to two of the four weakest data bits are flipped.
//
// FALSE POSITIVES. Neutral text, blue links, photos, gradients, UI and
// one-colour tinted text never reach sync and CRC. Text deliberately inked in
// two alternating dark tints can pass the two-level test; then the 16 check
// bits decide, with 13 guesses per line (16 near a row boundary): about 2 in
// 10,000 such lines. In a 720-image corpus (mail windows, photos, UI, dark
// two-tone code, per-letter cool/warm text, each rescaled, subsampled,
// colour-converted and JPEG'd) none was reported; a false code would also
// have to exist in the ledger to show.
//
// Pure JavaScript without imports: runs in Node and, bundled by esbuild, in
// the browser (or as a plain script, where it defines globalThis.inkkMark).

"use strict";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAYLOAD_BITS = 60;
const CRC_BITS = 8;
const SYNC = [1, 0, 1, 1, 0, 1, 0, 0];
const BITS = SYNC.length + PAYLOAD_BITS + CRC_BITS;
const COOL = [14, 26, 38];
const WARM = [38, 26, 14];
// Coverage-weighted ink the frame needs, about 34 solid pixels per bit. In
// EB Garamond at 30 px CSS drawn at 2x, "Felix Crabtree" has 4,166 and "Ana
// Diaz" 2,790; "Felix" alone has 1,590 (3,115 at 43 px). Long names read
// reliably from about 2,000; short and single names, whose ink sits in fewer,
// bigger letters, need the margin.
const MIN_INK = 2600;

// ---------------------------------------------------------------------------
// Frame

function codeToBits(code) {
  const body = String(code || "").toUpperCase().replace(/^INKK[\s\-_.]*/, "").replace(/[\s\-_.]/g, "");
  if (body.length !== 12) throw new Error("bad_code");
  const bits = [];
  for (const ch of body) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("bad_code");
    for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
  }
  return bits;
}

function bitsToCode(bits) {
  if (!bits || bits.length !== PAYLOAD_BITS) return null;
  let s = "";
  for (let i = 0; i < 12; i++) {
    let v = 0;
    for (let b = 0; b < 5; b++) v = (v << 1) | (bits[i * 5 + b] ? 1 : 0);
    s += ALPHABET[v];
  }
  return `INKK-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function crc8(bits) {
  let crc = 0xff;
  for (const bit of bits) {
    const top = ((crc >> 7) & 1) ^ (bit ? 1 : 0);
    crc = (crc << 1) & 0xff;
    if (top) crc ^= 0x07;
  }
  return crc;
}

const WHITEN = (() => {
  const out = [];
  let s = 0x1ff;
  for (let i = 0; i < PAYLOAD_BITS + CRC_BITS; i++) {
    out.push(s & 1);
    s = ((s << 1) | (((s >> 8) ^ (s >> 4)) & 1)) & 0x1ff;
  }
  return out;
})();

const SYNC_SLOTS = SYNC.map((_, i) => Math.round((i * (BITS - 1)) / (SYNC.length - 1)));
const DATA_SLOTS = [];
for (let i = 0; i < BITS; i++) if (!SYNC_SLOTS.includes(i)) DATA_SLOTS.push(i);

function frameBits(code) {
  const data = codeToBits(code);
  const crc = crc8(data);
  for (let b = 7; b >= 0; b--) data.push((crc >> b) & 1);
  const frame = new Array(BITS).fill(0);
  SYNC_SLOTS.forEach((slot, i) => { frame[slot] = SYNC[i]; });
  DATA_SLOTS.forEach((slot, i) => { frame[slot] = data[i] ^ WHITEN[i]; });
  return frame;
}

function unframe(frame) {
  for (let i = 0; i < SYNC.length; i++) if (frame[SYNC_SLOTS[i]] !== SYNC[i]) return null;
  const data = DATA_SLOTS.map((slot, i) => frame[slot] ^ WHITEN[i]);
  const payload = data.slice(0, PAYLOAD_BITS);
  let crc = 0;
  for (let i = PAYLOAD_BITS; i < data.length; i++) crc = (crc << 1) | data[i];
  return crc8(payload) === crc ? bitsToCode(payload) : null;
}

// ---------------------------------------------------------------------------
// Layout: ink pixels in x-then-y order, weighted by coverage → frame slot.
// The ink is cut into `cols` bands of equal ink, each band into `rows` of
// equal ink; group (band b, row r) carries slot (b * rows + r) mod 76, so the
// few groups past 76 repeat the first slots. Rows follow the ink's shape:
// round(sqrt(180 / aspect)), 2 to 9, which keeps each bit's patch of ink
// about as wide as it is tall.

function rowsFor(aspect) {
  return Math.max(2, Math.min(9, Math.round(Math.sqrt(180 / aspect))));
}

function layoutOf(rows) {
  return { rows, cols: Math.ceil(BITS / rows) };
}

// The layout the aspect implies, plus its neighbour when the aspect is within
// 12% of a boundary (blur and rounding move a measured aspect that much).
function layoutsFor(aspect) {
  const out = [layoutOf(rowsFor(aspect))];
  for (const f of [0.88, 1.12]) {
    const r = rowsFor(aspect * f);
    if (!out.some((l) => l.rows === r)) out.push(layoutOf(r));
  }
  return out;
}

// Width over height of the ink, from coverage-weighted quantiles (2-98% across,
// 5-95% down), which rescaling and blur leave where they were.
function inkAspect(xs, ys, cs, n) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, tot = 0;
  for (let i = 0; i < n; i++) {
    if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  const hx = new Float64Array(x1 - x0 + 1), hy = new Float64Array(y1 - y0 + 1);
  for (let i = 0; i < n; i++) { hx[xs[i] - x0] += cs[i]; hy[ys[i] - y0] += cs[i]; tot += cs[i]; }
  const at = (h, p) => {
    let acc = 0;
    for (let v = 0; v < h.length; v++) {
      if (acc + h[v] >= p * tot) return v + (p * tot - acc) / (h[v] || 1);
      acc += h[v];
    }
    return h.length;
  };
  return (at(hx, 0.98) - at(hx, 0.02)) / Math.max(1, at(hy, 0.95) - at(hy, 0.05));
}

function assignSlots(xs, ys, cs, n, lay) {
  const { rows, cols } = lay;
  let total = 0;
  for (let i = 0; i < n; i++) total += cs[i];
  const byBand = Array.from({ length: cols }, () => []);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const mid = cum + cs[i] / 2;
    cum += cs[i];
    byBand[Math.min(cols - 1, Math.floor((mid * cols) / total))].push(i);
  }
  const slot = new Int32Array(n);
  for (let b = 0; b < cols; b++) {
    const list = byBand[b];
    list.sort((p, q) => (ys[p] - ys[q]) || (xs[p] - xs[q]));
    let bt = 0;
    for (const i of list) bt += cs[i];
    let bc = 0;
    for (const i of list) {
      const mid = bc + cs[i] / 2;
      bc += cs[i];
      slot[i] = (b * rows + (bt > 0 ? Math.min(rows - 1, Math.floor((mid * rows) / bt)) : 0)) % BITS;
    }
  }
  return slot;
}

// ---------------------------------------------------------------------------
// Encode

function encodeMark(img, code) {
  if (!validImage(img)) throw new Error("bad_image");
  const frame = frameBits(code);
  const { width: W, height: H, data } = img;
  const n = W * H;
  let transparent = 0;
  for (let i = 3; i < n * 4; i += 4) if (data[i] < 250) transparent++;
  const alphaMode = transparent > n * 0.02;
  const cov = new Float32Array(n);
  let bg = [255, 255, 255];
  if (alphaMode) {
    for (let i = 0; i < n; i++) cov[i] = data[i * 4 + 3] / 255;
  } else {
    // Opaque: ink is darkness against the image's own background (its most
    // common light level), so a light grey card stays untouched.
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[Math.round(lumAt(data, i * 4))]++;
    const bgLum = percentile(hist, n, 0.75);
    const darkest = percentile(hist, n, 0);
    let sr = 0, sg = 0, sb = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (lumAt(data, i * 4) < bgLum - 2) continue;
      sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; k++;
    }
    bg = [sr / k, sg / k, sb / k];
    const span = Math.max(1, bgLum - darkest);
    for (let i = 0; i < n; i++) cov[i] = Math.max(0, Math.min(1, (bgLum - lumAt(data, i * 4)) / span));
  }
  let count = 0, mass = 0;
  for (let i = 0; i < n; i++) if (cov[i] >= 0.02) { count++; mass += cov[i]; }
  if (mass < MIN_INK) throw new Error("mark_too_small");
  const xs = new Int32Array(count), ys = new Int32Array(count), cs = new Float32Array(count);
  let k = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    const c = cov[y * W + x];
    if (c >= 0.02) { xs[k] = x; ys[k] = y; cs[k] = c; k++; }
  }
  const lay = layoutOf(rowsFor(inkAspect(xs, ys, cs, count)));
  const slot = assignSlots(xs, ys, cs, count, lay);
  for (let i = 0; i < count; i++) {
    const ink = frame[slot[i]] ? COOL : WARM;
    const o = (ys[i] * W + xs[i]) * 4;
    if (alphaMode) {
      data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2];
    } else {
      const c = cs[i];
      for (let ch = 0; ch < 3; ch++) data[o + ch] = Math.round(bg[ch] + c * (ink[ch] - bg[ch]));
    }
  }
  return { bits: frame, groups: lay.rows * lay.cols, inkPixels: count };
}

function validImage(img) {
  return !!img && !!img.data && img.width > 0 && img.height > 0 && img.data.length >= img.width * img.height * 4;
}

function lumAt(d, o) {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}

function percentile(hist, n, q) {
  const target = n * q;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > target) return v; }
  return 255;
}

// ---------------------------------------------------------------------------
// Decode

const CELL = 4;
const INK = 0.04;
const MIN_TINT = 4;
const MAX_TINT = 40;
const MIN_EACH = 16;
const MAX_BIAS = 0.35;
const MAX_GREEN = 0.3;
const MAX_CV = 0.8;
const CHASE_CV = 0.6;
const CHASE_WEAK = 5;
const SIGMAS = [0.5, 1.1, 1.8];
const MAXS = 6;

function decodeMarks(img, opts) {
  if (!validImage(img)) return [];
  const bgra = opts && opts.format === "bgra";
  const rI = bgra ? 2 : 0, bI = bgra ? 0 : 2;
  const { width: W, height: H, data } = img;
  // Candidate pixels, counted on a coarse grid; occupied cells, widened a
  // little, form regions.
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const grid = new Uint16Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = ((y / CELL) | 0) * gw;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (isCandidate(data[o + rI], data[o + 1], data[o + bI])) grid[row + ((x / CELL) | 0)]++;
    }
  }
  const occ = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    if (grid[gy * gw + gx] < 2) continue;
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++)
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) occ[yy * gw + xx] = 1;
  }
  const seen = new Uint8Array(gw * gh);
  const stack = [];
  const lines = [];
  for (let s = 0; s < gw * gh; s++) {
    if (!occ[s] || seen[s]) continue;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1, cands = 0;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw, cy = (c / gw) | 0;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      cands += grid[c];
      if (cx > 0 && occ[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (cx < gw - 1 && occ[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cy > 0 && occ[c - gw] && !seen[c - gw]) { seen[c - gw] = 1; stack.push(c - gw); }
      if (cy < gh - 1 && occ[c + gw] && !seen[c + gw]) { seen[c + gw] = 1; stack.push(c + gw); }
    }
    if (cands < 8) continue;
    // The region's tinted letters, as lines of text in page coordinates.
    const reg = scanBox(img, x0 * CELL - 3, y0 * CELL - 3, (x1 + 1) * CELL + 3, (y1 + 1) * CELL + 3, rI, bI);
    if (!reg) continue;
    for (const l of textLines(reg.info, 8)) {
      lines.push({ x0: reg.bx0 + l.x0, x1: reg.bx0 + l.x1, y0: reg.by0 + l.core0, y1: reg.by0 + l.core1, cands: l.cands });
    }
  }
  // Words of one line join, pairwise then transitively, when the gap between
  // them is small against the line's height, whatever the scale. This runs
  // after photos and panels were set aside, so a picture beside the name
  // cannot keep its words apart.
  const parent = lines.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    const ha = A.y1 - A.y0 + 1, hb = B.y1 - B.y0 + 1;
    const hmin = Math.min(ha, hb), hmax = Math.max(ha, hb);
    const ov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1;
    const gap = Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1);
    if (ov >= hmin * 0.5 && hmax <= hmin * 2 && gap <= Math.max(hmin * 1.2, hmax * 0.8)) parent[find(i)] = find(j);
  }
  const joined = new Map();
  lines.forEach((l, i) => {
    const r = find(i);
    const J = joined.get(r);
    if (!J) joined.set(r, { ...l });
    else Object.assign(J, { x0: Math.min(J.x0, l.x0), x1: Math.max(J.x1, l.x1), y0: Math.min(J.y0, l.y0), y1: Math.max(J.y1, l.y1), cands: J.cands + l.cands });
  });
  const out = [];
  for (const line of joined.values()) {
    if (line.cands < 40) continue;
    const res = decodeTextLine(img, line, rI, bI);
    if (!res) continue;
    const dup = out.find((o) => o.code === res.code && overlaps(o.box, res.box));
    if (dup) { if (res.confidence > dup.confidence) Object.assign(dup, res); continue; }
    out.push(res);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function isCandidate(r, g, b) {
  const dark = 255 - (0.299 * r + 0.587 * g + 0.114 * b);
  if (dark < 100) return false;
  const ad = b > r ? b - r : r - b;
  return ad >= 4 && ad >= dark * 0.03 && ad <= dark * 0.3;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// One line of text, re-read from a box of its own: background, ink and
// letters are measured locally, so a photo or another line that sat in the
// same region cannot bend the read.
function decodeTextLine(img, line, rI, bI) {
  const m = Math.ceil((line.y1 - line.y0 + 1) * 0.5) + 2;
  const box = scanBox(img, line.x0 - m, line.y0 - m, line.x1 + 1 + m, line.y1 + 1 + m, rI, bI);
  if (!box) return null;
  const ty0 = line.y0 - box.by0, ty1 = line.y1 - box.by0;
  const same = textLines(box.info, 40)
    .map((l) => ({ l, ov: Math.min(l.core1, ty1) - Math.max(l.core0, ty0) }))
    .filter((c) => c.ov > 0)
    .sort((p, q) => q.ov - p.ov)[0];
  return same ? decodeLine(box, same.l) : null;
}

// Pixels of a box: blue-red tint, green offset, ink coverage against the
// local background, and the 8-connected ink components.
function scanBox(img, x0, y0, x1, y1, rI, bI) {
  const { width: W, height: H, data } = img;
  const bx0 = Math.max(0, Math.floor(x0)), by0 = Math.max(0, Math.floor(y0));
  const bw = Math.min(W, Math.ceil(x1)) - bx0, bh = Math.min(H, Math.ceil(y1)) - by0;
  if (bw < 8 || bh < 4) return null;
  const n = bw * bh;
  const lum = new Float32Array(n), tint = new Float32Array(n), gof = new Float32Array(n);
  const cand = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const o = ((y + by0) * W + (x + bx0)) * 4;
    const R = data[o + rI], G = data[o + 1], B = data[o + bI];
    const i = y * bw + x;
    const l = 0.299 * R + 0.587 * G + 0.114 * B;
    lum[i] = l;
    tint[i] = B - R;
    gof[i] = G - (R + B) / 2;
    cand[i] = isCandidate(R, G, B) ? 1 : 0;
    hist[Math.round(l)]++;
  }
  // The name sits on a light background, and most of its box is background.
  const bgLum = percentile(hist, n, 0.75);
  if (bgLum < 170) return null;
  let bgT = 0, bgG = 0, bgN = 0;
  for (let i = 0; i < n; i++) if (lum[i] >= bgLum - 3) { bgT += tint[i]; bgG += gof[i]; bgN++; }
  bgT /= bgN; bgG /= bgN;
  const span = Math.max(40, bgLum - percentile(hist, n, 0.01));
  const cov = new Float32Array(n);
  for (let i = 0; i < n; i++) cov[i] = Math.max(0, Math.min(1, (bgLum - lum[i]) / span));
  // How deep each pixel sits inside solid ink (chamfer distance): a letter is
  // at most a stroke or two thick, a photo or an avatar is solid throughout.
  const depth = new Float32Array(n);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x;
    if (cov[i] < 0.5) continue;
    let d = Math.min(x > 0 ? depth[i - 1] + 1 : 1, y > 0 ? depth[i - bw] + 1 : 1);
    if (y > 0) d = Math.min(d, x > 0 ? depth[i - bw - 1] + 1.4 : 1.4, x < bw - 1 ? depth[i - bw + 1] + 1.4 : 1.4);
    depth[i] = d;
  }
  for (let y = bh - 1; y >= 0; y--) for (let x = bw - 1; x >= 0; x--) {
    const i = y * bw + x;
    if (!depth[i]) continue;
    let d = Math.min(depth[i], x < bw - 1 ? depth[i + 1] + 1 : 1, y < bh - 1 ? depth[i + bw] + 1 : 1);
    if (y < bh - 1) d = Math.min(d, x < bw - 1 ? depth[i + bw + 1] + 1.4 : 1.4, x > 0 ? depth[i + bw - 1] + 1.4 : 1.4);
    depth[i] = d;
  }
  // Components: letters, or runs of touching letters. A seed carries the tint.
  const comp = new Int32Array(n).fill(-1);
  const info = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (cov[s] < INK || comp[s] >= 0) continue;
    const ci = { id: info.length, cands: 0, core: 0, thick: 0, x0: bw, y0: bh, x1: -1, y1: -1, edge: false };
    comp[s] = ci.id; stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      if (cand[c]) ci.cands++;
      if (cov[c] > 0.6) ci.core++;
      if (depth[c] > ci.thick) ci.thick = depth[c];
      const cx = c % bw, cy = (c / bw) | 0;
      if (cx < ci.x0) ci.x0 = cx; if (cx > ci.x1) ci.x1 = cx; if (cy < ci.y0) ci.y0 = cy; if (cy > ci.y1) ci.y1 = cy;
      if (cx === 0 || cy === 0 || cx === bw - 1 || cy === bh - 1) ci.edge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const q = yy * bw + xx;
        if (comp[q] < 0 && cov[q] >= INK) { comp[q] = ci.id; stack.push(q); }
      }
    }
    // Components cut by the box belong to something outside it.
    ci.seed = !ci.edge && ci.cands >= 2 && ci.cands >= ci.core * 0.2;
    info.push(ci);
  }
  return { bx0, by0, bw, bh, n, tint, gof, cov, comp, info, bgT, bgG };
}

// Seeds grouped into lines of text. Letters of a line share a height and a
// stroke, so a photo, an avatar or a panel (far taller than the letters, or
// solid far deeper than their strokes) is set aside first; then the tallest
// letters define each line's span (its core) and smaller ones join the line
// whose core holds their centre.
function textLines(info, minCands) {
  const hgt = (ci) => ci.y1 - ci.y0 + 1;
  const seeds = info.filter((ci) => ci.seed);
  if (!seeds.length) return [];
  const mid = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  const tall = mid(seeds.map(hgt)) * 2.5;
  const deep = mid(seeds.map((ci) => ci.thick)) * 3 + 2;
  for (const ci of info) ci.tall = hgt(ci) > tall || ci.thick > deep;
  const lines = [];
  for (const ci of seeds.filter((c) => !c.tall).sort((a, b) => hgt(b) - hgt(a))) {
    const cy = (ci.y0 + ci.y1) / 2;
    let line = lines.find((l) => cy >= l.core0 && cy <= l.core1);
    if (!line) { line = { core0: ci.y0, core1: ci.y1, members: [], cands: 0, x0: ci.x0, x1: ci.x1, y0: ci.y0, y1: ci.y1 }; lines.push(line); }
    line.members.push(ci);
    line.cands += ci.cands;
    line.x0 = Math.min(line.x0, ci.x0); line.x1 = Math.max(line.x1, ci.x1);
    line.y0 = Math.min(line.y0, ci.y0); line.y1 = Math.max(line.y1, ci.y1);
  }
  return lines.filter((l) => l.cands >= minCands);
}

function decodeLine(reg, line) {
  const { bx0, by0, bw, bh, n, tint, gof, cov, comp, info, bgT, bgG } = reg;
  const lh = line.y1 - line.y0 + 1;
  const reach = lh * 0.6;
  // The line's ink: its seeds, plus untinted components inside its band (the
  // mark's own hairlines whose colour blurred away). Leaving one out would
  // shift every group after it.
  const keep = new Uint8Array(info.length);
  for (const ci of line.members) keep[ci.id] = 1;
  for (const ci of info) {
    if (ci.seed || ci.edge || ci.tall || ci.y1 - ci.y0 + 1 > lh * 1.2) continue;
    const cy = (ci.y0 + ci.y1) / 2;
    if (ci.x0 >= line.x0 - reach && ci.x1 <= line.x1 + reach && cy >= line.y0 && cy <= line.y1) keep[ci.id] = 1;
  }
  let count = 0;
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && keep[comp[i]]) count++;
  if (count < BITS * 4) return null;
  const xs = new Int32Array(count), ys = new Int32Array(count), cs = new Float32Array(count);
  let k = 0, mx0 = bw, my0 = bh, mx1 = -1, my1 = -1;
  for (let x = 0; x < bw; x++) for (let y = 0; y < bh; y++) {
    const i = y * bw + x;
    if (comp[i] < 0 || !keep[comp[i]]) continue;
    xs[k] = x; ys[k] = y; cs[k] = cov[i];
    if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y;
    k++;
  }
  // Tint and green offset with the background's own cast taken out.
  const dField = new Float32Array(n), gField = new Float32Array(n);
  for (let i = 0; i < n; i++) { dField[i] = tint[i] - (1 - cov[i]) * bgT; gField[i] = gof[i] - (1 - cov[i]) * bgG; }
  const ws = { rs: new Int16Array(n * MAXS), rw: new Float32Array(n * MAXS), rk: new Uint8Array(n), touched: new Int32Array(n) };
  const box = { x: bx0 + mx0, y: by0 + my0, w: mx1 - mx0 + 1, h: my1 - my0 + 1 };
  const reads = [];
  for (const lay of layoutsFor(inkAspect(xs, ys, cs, count))) {
    const slotOf = assignSlots(xs, ys, cs, count, lay);
    // A cheap first look (plain per-slot means) stops one-colour text and noise.
    const sd = new Float64Array(BITS), sc = new Float64Array(BITS);
    for (let i = 0; i < count; i++) { sd[slotOf[i]] += dField[ys[i] * bw + xs[i]]; sc[slotOf[i]] += cs[i]; }
    for (let i = 0; i < BITS; i++) sd[i] = sc[i] > 0 ? sd[i] / sc[i] : 0;
    if (!roughlyTwoLevel(sd)) continue;
    // The mark's inks differ only along blue-red, green held midway.
    let green = null;
    const greenOk = (q) => {
      if (!green) green = solveTints(ws, xs, ys, cs, slotOf, count, bw, bh, gField, 1.1);
      let gm = 0, ga = 0;
      for (const g of green) { gm += g; ga += Math.abs(g); }
      return Math.abs(gm / BITS) <= q.T * MAX_GREEN && ga / BITS <= q.T * MAX_GREEN * 1.5;
    };
    // Each blur model is read plainly; the weakest bits are second-guessed
    // only on the cleanest read of all, which keeps the guesses per line few.
    for (const sigma of SIGMAS) {
      const soft = solveTints(ws, xs, ys, cs, slotOf, count, bw, bh, dField, sigma);
      const q = assess(soft);
      if (!q || !greenOk(q)) continue;
      const found = readFrame(soft, q, 0);
      if (found) return { code: found.code, box, confidence: found.confidence };
      reads.push({ soft, q });
    }
  }
  const best = reads.sort((p, q) => p.q.cv - q.q.cv)[0];
  const found = best && readFrame(best.soft, best.q, 2);
  return found ? { code: found.code, box, confidence: found.confidence } : null;
}

// Least-squares tint per slot: the observed tint field is modelled as each
// slot's tint times its ink coverage, blurred by a Gaussian of `sigma` (the
// extra softness chroma picks up from subsampling, resampling and JPEG).
// `ws` is scratch space shared by the solves of one line.
function solveTints(ws, xs, ys, cs, slotOf, n, bw, bh, field, sigma) {
  const R = Math.ceil(sigma * 2);
  const kdx = [], kdy = [], kw = [];
  let ks = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    if (w < 0.01) continue;
    kdx.push(dx); kdy.push(dy); kw.push(w); ks += w;
  }
  const K = kw.length;
  for (let j = 0; j < K; j++) kw[j] /= ks;
  const { rs, rw, rk, touched } = ws;
  let nt = 0;
  for (let i = 0; i < n; i++) {
    const s = slotOf[i], c = cs[i];
    for (let j = 0; j < K; j++) {
      const x = xs[i] + kdx[j], y = ys[i] + kdy[j];
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const p = y * bw + x;
      let r = rk[p];
      if (r === 0) touched[nt++] = p;
      const base = p * MAXS;
      let m = 0;
      while (m < r && rs[base + m] !== s) m++;
      if (m === r) { if (r === MAXS) continue; rs[base + m] = s; rw[base + m] = 0; rk[p] = ++r; }
      rw[base + m] += kw[j] * c;
    }
  }
  const ATA = new Float64Array(BITS * BITS), ATd = new Float64Array(BITS);
  for (let t = 0; t < nt; t++) {
    const p = touched[t], r = rk[p], base = p * MAXS, d = field[p];
    for (let a = 0; a < r; a++) {
      const sa = rs[base + a], wa = rw[base + a];
      ATd[sa] += wa * d;
      for (let b = 0; b < r; b++) ATA[sa * BITS + rs[base + b]] += wa * rw[base + b];
    }
    rk[p] = 0;
  }
  let tr = 0;
  for (let i = 0; i < BITS; i++) tr += ATA[i * BITS + i];
  const lambda = (tr / BITS) * 0.02 + 1e-9;
  for (let i = 0; i < BITS; i++) ATA[i * BITS + i] += lambda;
  return cholSolve(ATA, ATd, BITS);
}

function cholSolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

// Two tint levels, split at the midpoint of their means: a colour cast on the
// ink moves both levels together and is absorbed rather than read as bits.
function twoLevels(soft, minEach, rounds) {
  let b = 0, mp = 0, mn = 0;
  for (let it = 0; it < rounds; it++) {
    let sp = 0, sn = 0, np = 0, nn = 0;
    for (const v of soft) { if (v > b) { np++; sp += v; } else { nn++; sn += v; } }
    if (np < minEach || nn < minEach) return null;
    mp = sp / np; mn = sn / nn;
    b = (mp + mn) / 2;
  }
  return { T: (mp - mn) / 2, b };
}

function roughlyTwoLevel(soft) {
  const l = twoLevels(soft, MIN_EACH / 2, 4);
  return !!l && l.T >= MIN_TINT / 2 && l.T <= MAX_TINT * 1.5 && Math.abs(l.b) <= l.T * 0.8;
}

// Does a soft read look like a mark at all? Two levels, one cool and one
// warm, each holding a fair share of the bits, about as far apart as the inks
// are, symmetric about a small offset, and cleanly separated. Photos, UI and
// coloured text give one level, lopsided ones, or a smear.
function assess(soft) {
  const l = twoLevels(soft, MIN_EACH, 6);
  if (!l || !(l.T >= MIN_TINT) || l.T > MAX_TINT || Math.abs(l.b) > l.T * MAX_BIAS) return null;
  let mean = 0;
  for (const v of soft) mean += Math.abs(v - l.b);
  mean /= BITS;
  let va = 0, weak = 0;
  for (const v of soft) { const m = Math.abs(v - l.b); va += (m - mean) * (m - mean); if (m < l.T * 0.3) weak++; }
  const cv = Math.sqrt(va / BITS) / mean;
  return cv > MAX_CV ? null : { T: l.T, b: l.b, cv, weak };
}

// Soft read → code. With `maxFlips`, up to that many of the four weakest data
// bits are flipped at once and sync + CRC re-checked; only a read that is
// already nearly clean, with its sync intact, qualifies.
function readFrame(soft, q, maxFlips) {
  const frame = Array.from(soft, (x) => (x > q.b ? 1 : 0));
  const quality = Math.min(1, q.T / 12) * Math.max(0, 1 - q.weak / 10) * Math.min(1, 1.3 - q.cv);
  const conf = (flips) => Math.max(0.05, Math.round(quality * (1 - 0.2 * flips) * 100) / 100);
  if (!maxFlips) {
    const code = unframe(frame);
    return code ? { code, confidence: conf(0) } : null;
  }
  if (q.cv > CHASE_CV || q.weak > CHASE_WEAK) return null;
  for (let i = 0; i < SYNC.length; i++) if (frame[SYNC_SLOTS[i]] !== SYNC[i]) return null;
  const weakest = DATA_SLOTS.slice().sort((i, j) => Math.abs(soft[i] - q.b) - Math.abs(soft[j] - q.b)).slice(0, 4);
  const tries = weakest.map((i) => [i]);
  if (maxFlips > 1) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) tries.push([weakest[i], weakest[j]]);
  for (const t of tries) {
    const f = frame.slice();
    for (const i of t) f[i] ^= 1;
    const code = unframe(f);
    if (code) return { code, confidence: conf(t.length) };
  }
  return null;
}

const api = { BITS, encodeMark, decodeMarks, codeToBits, bitsToCode, crc8 };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else globalThis.inkkMark = api;
