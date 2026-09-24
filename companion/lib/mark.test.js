// Run: node --test companion/lib/mark.test.js
//
// The pixel mark end to end in plain Node: a name is drawn as anti-aliased,
// glyph-like ink (stems, bowls, hairlines, serifs), encoded, composited into a
// mail window among grey text, a blue link and a photo, then put through what
// happens between a sent email and a screenshot of it: rescaling, colour
// management, chroma subsampling, JPEG. The decoder must find the right code
// in roughly the right place, and nothing at all where there is no mark.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const mark = require("./mark");
const { BITS, encodeMark, decodeMarks, codeToBits, bitsToCode, crc8 } = mark;

// ---------------------------------------------------------------------------
// Synthetic ink

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function inside(sh, px, py) {
  switch (sh.t) {
    case "rect": return px >= sh.x0 && px <= sh.x1 && py >= sh.y0 && py <= sh.y1;
    case "cap": {
      const dx = sh.x1 - sh.x0, dy = sh.y1 - sh.y0;
      const L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - sh.x0) * dx + (py - sh.y0) * dy) / L));
      const ex = sh.x0 + t * dx - px, ey = sh.y0 + t * dy - py;
      return ex * ex + ey * ey <= sh.r * sh.r;
    }
    case "ring": {
      const ux = (px - sh.cx) / (sh.rx + sh.wx / 2), uy = (py - sh.cy) / (sh.ry + sh.wy / 2);
      if (ux * ux + uy * uy > 1) return false;
      const ix = (px - sh.cx) / Math.max(0.1, sh.rx - sh.wx / 2), iy = (py - sh.cy) / Math.max(0.1, sh.ry - sh.wy / 2);
      if (ix * ix + iy * iy < 1) return false;
      return sh.clip ? sh.clip(Math.atan2(py - sh.cy, px - sh.cx), px - sh.cx, py - sh.cy) : true;
    }
    case "disk": { const dx = px - sh.cx, dy = py - sh.cy; return dx * dx + dy * dy <= sh.r * sh.r; }
  }
  return false;
}

function bboxOf(sh) {
  switch (sh.t) {
    case "rect": return [sh.x0, sh.y0, sh.x1, sh.y1];
    case "cap": return [Math.min(sh.x0, sh.x1) - sh.r, Math.min(sh.y0, sh.y1) - sh.r, Math.max(sh.x0, sh.x1) + sh.r, Math.max(sh.y0, sh.y1) + sh.r];
    case "ring": return [sh.cx - sh.rx - sh.wx, sh.cy - sh.ry - sh.wy, sh.cx + sh.rx + sh.wx, sh.cy + sh.ry + sh.wy];
    default: return [sh.cx - sh.r, sh.cy - sh.r, sh.cx + sh.r, sh.cy + sh.r];
  }
}

// 4x4 supersampled coverage, like a text rasteriser's grey-scale anti-aliasing.
function rasterise(shapes, W, H, SS = 4) {
  const MW = W * SS;
  const mask = new Uint8Array(MW * H * SS);
  for (const sh of shapes) {
    const [x0, y0, x1, y1] = bboxOf(sh);
    const sx0 = Math.max(0, Math.floor(x0 * SS)), sy0 = Math.max(0, Math.floor(y0 * SS));
    const sx1 = Math.min(MW - 1, Math.ceil(x1 * SS)), sy1 = Math.min(H * SS - 1, Math.ceil(y1 * SS));
    for (let sy = sy0; sy <= sy1; sy++) for (let sx = sx0; sx <= sx1; sx++) {
      if (!mask[sy * MW + sx] && inside(sh, (sx + 0.5) / SS, (sy + 0.5) / SS)) mask[sy * MW + sx] = 1;
    }
  }
  const cov = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let yy = 0; yy < SS; yy++) for (let xx = 0; xx < SS; xx++) s += mask[(y * SS + yy) * MW + x * SS + xx];
    cov[y * W + x] = s / (SS * SS);
  }
  return cov;
}

// Letters from stems, bowls, arches and hairlines with serif-face contrast.
function letter(ch, x, m, out) {
  const { base, xh, asc, sw, hw } = m;
  const top = base - xh, atop = base - asc;
  const stem = (sx, y0, y1) => out.push({ t: "rect", x0: sx, x1: sx + sw, y0, y1 });
  const serif = (sx, y) => out.push({ t: "rect", x0: sx - sw * 0.7, x1: sx + sw * 1.7, y0: y - hw * 0.6, y1: y + hw * 0.6 });
  const bowl = (cx, cy, rx, ry, clip) => out.push({ t: "ring", cx, cy, rx, ry, wx: sw, wy: hw * 1.3, clip });
  const hair = (x0, y0, x1, y1, w = hw) => out.push({ t: "cap", x0, y0, x1, y1, r: w / 2 });
  const w = xh * 0.55;
  switch (ch) {
    case "o": bowl(x + w * 0.5 + sw, base - xh / 2, w * 0.5, xh / 2); return w + sw * 2.4;
    case "e": bowl(x + w * 0.5 + sw, base - xh / 2, w * 0.5, xh / 2, (a) => !(a > 0.15 && a < 0.9)); hair(x + sw * 0.6, base - xh * 0.55, x + w + sw * 1.5, base - xh * 0.55); return w + sw * 2.4;
    case "c": bowl(x + w * 0.5 + sw, base - xh / 2, w * 0.5, xh / 2, (a) => !(a > -0.6 && a < 0.6)); return w + sw * 1.8;
    case "a": bowl(x + w * 0.35 + sw, base - xh * 0.3, w * 0.38, xh * 0.3); stem(x + w * 0.75 + sw, top + xh * 0.15, base); hair(x + sw, top + xh * 0.2, x + w * 0.8 + sw, top, hw); return w + sw * 2.6;
    case "i": stem(x + sw, top, base); serif(x + sw, base); out.push({ t: "disk", cx: x + sw * 1.5, cy: top - xh * 0.3, r: sw * 0.8 }); return sw * 3.5;
    case "l": stem(x + sw, atop, base); serif(x + sw, base); serif(x + sw, atop); return sw * 3.5;
    case "t": stem(x + sw, top - xh * 0.35, base); hair(x, top, x + sw * 3.5, top); return sw * 4;
    case "r": stem(x + sw, top, base); serif(x + sw, base); bowl(x + sw * 2.6, top + xh * 0.3, w * 0.35, xh * 0.3, (a, dx, dy) => dy < 0 && dx > -w * 0.2); return w * 0.8 + sw * 2;
    case "n": case "h": case "m": {
      stem(x + sw, ch === "h" ? atop : top, base); serif(x + sw, base);
      let adv = x + sw;
      for (let k = 0; k < (ch === "m" ? 2 : 1); k++) {
        bowl(adv + w * 0.45 + sw * 0.5, top + xh * 0.35, w * 0.45, xh * 0.35, (a, dx, dy) => dy < 0);
        stem(adv + w * 0.9, top + xh * 0.35, base); serif(adv + w * 0.9, base);
        adv += w * 0.9;
      }
      return adv - x + sw * 2.4;
    }
    case "u": stem(x + sw, top, base - xh * 0.35); bowl(x + w * 0.45 + sw * 1.5, base - xh * 0.35, w * 0.45, xh * 0.35, (a, dx, dy) => dy > 0); stem(x + w * 0.9 + sw, top, base); return w + sw * 3;
    case "b": case "d": stem(ch === "b" ? x + sw : x + w + sw, atop, base); bowl(x + w * 0.5 + sw * 1.2, base - xh / 2, w * 0.5, xh / 2); return w + sw * 2.6;
    case "x": case "v": hair(x + sw * 0.5, top, x + w + sw, base, sw * 0.9); if (ch === "x") hair(x + w + sw, top, x + sw * 0.5, base); else hair(x + w + sw, top, x + w * 0.5 + sw, base); return w + sw * 2.2;
    case "s": bowl(x + w * 0.4 + sw, top + xh * 0.25, w * 0.4, xh * 0.25, (a, dx, dy) => !(dx > 0 && dy > 0)); bowl(x + w * 0.4 + sw, base - xh * 0.25, w * 0.4, xh * 0.25, (a, dx, dy) => !(dx < 0 && dy < 0)); return w + sw * 1.8;
    case "F": case "E": stem(x + sw, atop, base); serif(x + sw, base); hair(x + sw, atop + hw / 2, x + w * 1.3 + sw, atop + hw / 2, hw * 1.4); hair(x + sw, atop + asc * 0.48, x + w + sw, atop + asc * 0.48, hw * 1.3); if (ch === "E") hair(x + sw, base - hw / 2, x + w * 1.3 + sw, base - hw / 2, hw * 1.4); return w * 1.3 + sw * 2.5;
    case "C": bowl(x + asc * 0.4 + sw, base - asc / 2, asc * 0.4, asc / 2, (a) => !(a > -0.5 && a < 0.5)); return asc * 0.8 + sw * 2;
    case "B": case "D": stem(x + sw, atop, base); bowl(x + sw * 1.5, base - asc / 2, asc * 0.38, asc / 2, (a, dx) => dx > 0); return asc * 0.45 + sw * 2.5;
    case "T": hair(x, atop + hw / 2, x + asc * 0.7, atop + hw / 2, hw * 1.4); stem(x + asc * 0.35 - sw / 2, atop, base); serif(x + asc * 0.35 - sw / 2, base); return asc * 0.7 + sw;
    case "H": case "M": stem(x + sw, atop, base); stem(x + asc * 0.6, atop, base); hair(x + sw, base - asc * 0.5, x + asc * 0.6, base - asc * 0.5, hw * 1.3); serif(x + sw, base); serif(x + asc * 0.6, base); return asc * 0.6 + sw * 3;
    case "A": hair(x + sw * 0.5, base, x + asc * 0.35, atop, hw * 1.2); hair(x + asc * 0.35, atop, x + asc * 0.7, base, sw); hair(x + asc * 0.2, base - asc * 0.35, x + asc * 0.55, base - asc * 0.35); return asc * 0.75 + sw;
    case "J": stem(x + asc * 0.3, atop, base - xh * 0.2); bowl(x + asc * 0.18, base - xh * 0.25, asc * 0.13, xh * 0.25, (a, dx, dy) => dy > 0); return asc * 0.45;
    default: return xh * 0.45;
  }
}

// Text on a transparent canvas of height H (ink about 0.6 H tall). H = 72
// gives the ink height of a 30 px CSS name drawn at 2x (~44 px).
function renderText(text, H, opts = {}) {
  const r = rng(opts.seed || 7);
  const m = { base: H * 0.74, xh: H * 0.34, asc: H * 0.55, sw: H * 0.075, hw: H * 0.03 };
  const shapes = [];
  let x = H * 0.15;
  for (const ch of text) x += letter(ch, x, m, shapes) + H * 0.035 + (r() - 0.5) * H * 0.01;
  const W = Math.ceil(x + H * 0.15);
  const cov = rasterise(shapes, W, H);
  const ink = opts.ink || [26, 26, 26];
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = ink[0]; data[i * 4 + 1] = ink[1]; data[i * 4 + 2] = ink[2];
    data[i * 4 + 3] = Math.round(cov[i] * 255);
  }
  return { width: W, height: H, data };
}

const clone = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

function inkBox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > 16) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// Screenshot transforms

function blank(W, H, rgb = [255, 255, 255]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { width: W, height: H, data };
}

function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const X = ox + x, Y = oy + y;
    if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
    const s = (y * src.width + x) * 4, d = (Y * dst.width + X) * 4;
    const a = src.data[s + 3] / 255;
    for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round(src.data[s + c] * a + dst.data[d + c] * (1 - a));
  }
}

function fillRect(dst, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const d = (y * dst.width + x) * 4;
    dst.data[d] = rgb[0]; dst.data[d + 1] = rgb[1]; dst.data[d + 2] = rgb[2];
  }
}

function crop(img, x, y, w, h) {
  const out = blank(w, h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const X = x + xx, Y = y + yy;
    if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
    for (let c = 0; c < 4; c++) out.data[(yy * w + xx) * 4 + c] = img.data[(Y * img.width + X) * 4 + c];
  }
  return out;
}

function scaleBilinear(img, s) {
  const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const out = new Uint8ClampedArray(W * H * 4);
  const sw = img.width, sh = img.height, d = img.data;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        out[(y * W + x) * 4 + c] = Math.round((d[(y0 * sw + x0) * 4 + c] * (1 - tx) + d[(y0 * sw + x1) * 4 + c] * tx) * (1 - ty)
          + (d[(y1 * sw + x0) * 4 + c] * (1 - tx) + d[(y1 * sw + x1) * 4 + c] * tx) * ty);
      }
    }
  }
  return { width: W, height: H, data: out };
}

// Exact box-filter resampling (what a good downscaler converges to).
function scaleArea(img, s) {
  const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const sx = img.width / W, sy = img.height / H;
  const tmp = new Float32Array(W * img.height * 4);
  const d = img.data, sw = img.width;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < W; x++) {
    const a = x * sx, b = (x + 1) * sx;
    for (let k = Math.floor(a); k < Math.ceil(b); k++) {
      const wgt = Math.min(b, k + 1) - Math.max(a, k);
      if (wgt <= 0) continue;
      for (let c = 0; c < 4; c++) tmp[(y * W + x) * 4 + c] += d[(y * sw + Math.min(sw - 1, k)) * 4 + c] * wgt / sx;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = y * sy, b = (y + 1) * sy;
    const acc = [0, 0, 0, 0];
    for (let k = Math.floor(a); k < Math.ceil(b); k++) {
      const wgt = Math.min(b, k + 1) - Math.max(a, k);
      if (wgt <= 0) continue;
      for (let c = 0; c < 4; c++) acc[c] += tmp[(Math.min(img.height - 1, k) * W + x) * 4 + c] * wgt;
    }
    for (let c = 0; c < 4; c++) out[(y * W + x) * 4 + c] = Math.round(acc[c] / sy);
  }
  return { width: W, height: H, data: out };
}

function mapRGB(img, f) {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < img.width * img.height; i++) {
    const [r, g, b] = f(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
    out[i * 4] = Math.round(r); out[i * 4 + 1] = Math.round(g); out[i * 4 + 2] = Math.round(b);
  }
  return { width: img.width, height: img.height, data: out };
}
const shift = (img, dr, dg, db) => mapRGB(img, (r, g, b) => [r + dr, g + dg, b + db]);
const gamma = (img, gm) => mapRGB(img, (r, g, b) => [r, g, b].map((v) => 255 * Math.pow(v / 255, gm)));
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
// sRGB content re-expressed in Display P3, as a colour-managed capture on a P3 screen stores it.
const P3 = [[0.8225, 0.1774, 0], [0.0332, 0.9669, 0], [0.0171, 0.0724, 0.9108]];
const p3 = (img) => mapRGB(img, (r, g, b) => {
  const l = [toLin(r), toLin(g), toLin(b)];
  return P3.map((row) => toSrgb(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
});

function toYCC(img) {
  const n = img.width * img.height;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { Y, Cb, Cr };
}
function fromYCC(W, H, Y, Cb, Cr) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const cb = Cb[i] - 128, cr = Cr[i] - 128;
    out[i * 4] = Math.round(Y[i] + 1.402 * cr);
    out[i * 4 + 1] = Math.round(Y[i] - 0.344136 * cb - 0.714136 * cr);
    out[i * 4 + 2] = Math.round(Y[i] + 1.772 * cb);
    out[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data: out };
}
function subsample(C, W, H) {
  const w2 = Math.ceil(W / 2), h2 = Math.ceil(H / 2);
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    let s = 0, k = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (2 * x + dx < W && 2 * y + dy < H) { s += C[(2 * y + dy) * W + 2 * x + dx]; k++; }
    }
    out[y * w2 + x] = s / k;
  }
  return out;
}
function upsample(c, W, H) {
  const w2 = Math.ceil(W / 2), h2 = Math.ceil(H / 2);
  const at = (x, y) => c[Math.min(h2 - 1, Math.max(0, y)) * w2 + Math.min(w2 - 1, Math.max(0, x))];
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = (x - 0.5) / 2, fy = (y - 0.5) / 2, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    out[y * W + x] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  }
  return out;
}
// 4:2:0 chroma: colour averaged over 2x2 blocks, luma kept.
function chroma420(img) {
  const { Y, Cb, Cr } = toYCC(img);
  const W = img.width, H = img.height;
  return fromYCC(W, H, Y, upsample(subsample(Cb, W, H), W, H), upsample(subsample(Cr, W, H), W, H));
}

// Baseline JPEG's losses without the entropy coding: 4:2:0 chroma, 8x8 DCT,
// the standard quantisation tables scaled for `q` the way libjpeg does it.
const QY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99].concat(new Array(32).fill(99));
const COS = (() => { const t = new Float64Array(64); for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1); return t; })();
function dctPlane(P, W, H, table, q) {
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const Q = table.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  const out = new Float32Array(W * H);
  const blk = new Float64Array(64), tmp = new Float64Array(64), F = new Float64Array(64);
  for (let by = 0; by < H; by += 8) for (let bx = 0; bx < W; bx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = P[Math.min(H - 1, by + y) * W + Math.min(W - 1, bx + x)] - 128;
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * COS[x * 8 + u]; tmp[y * 8 + u] = s; }
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y * 8 + v];
      F[v * 8 + u] = Math.round((s / 4) / Q[v * 8 + u]) * Q[v * 8 + u];
    }
    for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) s += F[v * 8 + u] * COS[x * 8 + u]; tmp[v * 8 + x] = s; }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * COS[y * 8 + v];
      if (by + y < H && bx + x < W) out[(by + y) * W + bx + x] = Math.max(0, Math.min(255, s / 4 + 128));
    }
  }
  return out;
}
function jpeg(img, q) {
  const W = img.width, H = img.height, w2 = Math.ceil(W / 2), h2 = Math.ceil(H / 2);
  const { Y, Cb, Cr } = toYCC(img);
  return fromYCC(W, H, dctPlane(Y, W, H, QY, q),
    upsample(dctPlane(subsample(Cb, W, H), w2, h2, QC, q), W, H),
    upsample(dctPlane(subsample(Cr, W, H), w2, h2, QC, q), W, H));
}

// ---------------------------------------------------------------------------
// Scenes

const WORDS = ["the", "letter", "one", "about", "chance", "rather", "when", "then", "this", "notes", "bread", "trade", "there", "Thanks", "Best", "Hello", "Monday", "inbox", "reader", "to", "a", "on", "it"];
function textLine(n, H, ink, seed) {
  const r = rng(seed);
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
  return renderText(words.join(" "), H, { ink, seed });
}

function photo(W, H, seed) {
  const r = rng(seed);
  const blobs = Array.from({ length: 14 }, () => ({ x: r() * W, y: r() * H, s: 10 + r() * W * 0.3, c: [0, 0, 0].map(() => r() * 255 * (0.3 + r())) }));
  const img = blank(W, H, [0, 0, 0]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [8, 10, 12];
    let ws = 0.2;
    for (const b of blobs) {
      const w = Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (b.s * b.s));
      ws += w;
      for (let c = 0; c < 3; c++) acc[c] += b.c[c] * w;
    }
    for (let c = 0; c < 3; c++) img.data[(y * W + x) * 4 + c] = (acc[c] / ws) * (0.4 + 0.6 * Math.sin(x * 0.05 + y * 0.03) ** 2) + (r() - 0.5) * 24;
  }
  return img;
}

// A mail window at 2x: toolbar with a blue button, a sidebar of grey labels,
// body text in two greys, a blue link, a photo, a gradient, navy and brown
// text. The signature goes under the body text at `markAt`.
function mailWindow(seed = 3, W = 1000, H = 640) {
  const img = blank(W, H);
  fillRect(img, 0, 0, W, 56, [240, 240, 240]);
  fillRect(img, 0, 56, W, 1, [214, 214, 214]);
  for (let i = 0; i < 6; i++) fillRect(img, 24 + i * 44, 18, 22, 20, [110, 110, 110]);
  fillRect(img, W - 180, 14, 140, 28, [26, 115, 232]);
  blit(img, textLine(2, 22, [255, 255, 255], 11), W - 170, 17);
  fillRect(img, 0, 57, 220, H - 57, [246, 246, 246]);
  for (let i = 0; i < 8; i++) blit(img, textLine(2 + (i % 3), 26, [60, 60, 60], 20 + i + seed), 16, 80 + i * 40);
  let y = 80;
  for (let i = 0; i < 5; i++) { blit(img, textLine(5 + (i % 3), 34, [34, 34, 34], 100 + i + seed), 250, y); y += 44; }
  blit(img, textLine(4, 34, [0, 0, 238], 55 + seed), 250, y); y += 44;
  blit(img, textLine(4, 34, [85, 85, 85], 56 + seed), 250, y); y += 48;
  const markAt = { x: 250, y };
  blit(img, photo(220, 150, seed + 9), W - 250, 300);
  for (let x = 0; x < 240; x++) fillRect(img, W - 260 + x, H - 50, 1, 26, [Math.round(40 + x * 0.7), Math.round(20 + x * 0.3), Math.round(80 + x * 0.5)]);
  blit(img, textLine(3, 28, [20, 20, 48], 77 + seed), W - 260, 480);
  blit(img, textLine(3, 28, [60, 30, 20], 78 + seed), W - 260, 520);
  return { img, markAt };
}

const CODE_A = "INKK-7F3A-9K2D-XQ4M";
const CODE_B = "INKK-M4QX-D2K9-A3F7";

function sceneWithMark(name, H, code, seed) {
  const ink = renderText(name, H, { seed });
  const info = encodeMark(ink, code);
  const { img, markAt } = mailWindow(seed);
  blit(img, ink, markAt.x, markAt.y);
  const b = inkBox(ink);
  return { img, info, box: { x: markAt.x + b.x, y: markAt.y + b.y, w: b.w, h: b.h } };
}

// ---------------------------------------------------------------------------
// Frame

test("codes round-trip through 60 bits; the frame is 76 bits", () => {
  assert.strictEqual(BITS, 76);
  for (const code of [CODE_A, CODE_B, "INKK-0000-0000-0000", "INKK-ZZZZ-ZZZZ-ZZZZ"]) {
    const bits = codeToBits(code);
    assert.strictEqual(bits.length, 60);
    assert.ok(bits.every((b) => b === 0 || b === 1));
    assert.strictEqual(bitsToCode(bits), code);
  }
  assert.strictEqual(bitsToCode(codeToBits("inkk 7f3a 9k2d xq4m")), CODE_A);
  assert.throws(() => codeToBits("INKK-7F3A-9K2D"), /bad_code/);
  assert.throws(() => codeToBits("INKK-7F3A-9K2D-XQ4U"), /bad_code/);
  assert.strictEqual(bitsToCode([1, 0, 1]), null);
});

test("crc8 is deterministic, byte-sized and catches single-bit slips", () => {
  const bits = codeToBits(CODE_A);
  const c = crc8(bits);
  assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
  assert.strictEqual(crc8(bits), c);
  for (let i = 0; i < bits.length; i++) {
    const f = bits.slice();
    f[i] ^= 1;
    assert.notStrictEqual(crc8(f), c, `bit ${i}`);
  }
});

// ---------------------------------------------------------------------------
// Encode

test("encodeMark recolours the ink in place, keeping coverage, and returns the frame", () => {
  const src = renderText("Felix Crabtree", 72, { seed: 1 });
  const img = clone(src);
  const res = encodeMark(img, CODE_A);
  assert.strictEqual(res.bits.length, BITS);
  assert.ok(res.groups >= BITS && res.groups <= BITS + 8, `groups ${res.groups}`);
  assert.ok(res.inkPixels > 2000);
  let cool = 0, warm = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    assert.strictEqual(img.data[i * 4 + 3], src.data[i * 4 + 3], "alpha is untouched");
    if (!img.data[i * 4 + 3]) continue;
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    assert.ok(Math.max(r, g, b) <= 48, "ink stays near-black");
    if (b > r) cool++; else warm++;
  }
  assert.ok(cool > 0.3 * (cool + warm) && warm > 0.3 * (cool + warm), `balanced tints ${cool}/${warm}`);
  const found = decodeMarks(composite(img));
  assert.deepStrictEqual(found.map((f) => f.code), [CODE_A]);
});

test("encodeMark also works on an opaque white background", () => {
  const src = composite(renderText("Jonathan Abernethy", 72, { seed: 2 }));
  const res = encodeMark(src, CODE_B);
  assert.strictEqual(res.bits.length, BITS);
  for (let i = 0; i < src.width * src.height; i++) assert.strictEqual(src.data[i * 4 + 3], 255);
  const page = blank(src.width + 40, src.height + 40);
  blit(page, src, 20, 20);
  assert.deepStrictEqual(decodeMarks(page).map((f) => f.code), [CODE_B]);
});

test("on an opaque light grey card only the ink changes", () => {
  const ink = renderText("Felix Crabtree", 72, { seed: 4 });
  const card = blank(ink.width, ink.height, [238, 238, 236]);
  blit(card, ink, 0, 0);
  const before = clone(card);
  encodeMark(card, CODE_A);
  let changedBg = 0;
  for (let i = 0; i < card.width * card.height; i++) {
    if (ink.data[i * 4 + 3] === 0) for (let c = 0; c < 3; c++) if (card.data[i * 4 + c] !== before.data[i * 4 + c]) changedBg++;
  }
  assert.strictEqual(changedBg, 0, "background pixels untouched");
  const page = blank(card.width + 40, card.height + 40, [238, 238, 236]);
  blit(page, card, 20, 20);
  assert.deepStrictEqual(decodeMarks(page).map((f) => f.code), [CODE_A]);
});

test("encodeMark refuses a name with too little ink", () => {
  assert.throws(() => encodeMark(renderText("Al", 72), CODE_A), /mark_too_small/);
  assert.throws(() => encodeMark(renderText("Felix Crabtree", 20), CODE_A), /mark_too_small/);
  assert.throws(() => encodeMark(blank(300, 60), CODE_A), /mark_too_small/);
  assert.throws(() => encodeMark(renderText("Felix Crabtree", 72), "INKK-12"), /bad_code/);
  assert.throws(() => encodeMark({ width: 10, height: 10, data: new Uint8ClampedArray(12) }, CODE_A), /bad_image/);
});

function composite(img) {
  const out = blank(img.width, img.height);
  blit(out, img, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Robustness matrix

const TRANSFORMS = [
  ["1x", (i) => i],
  ["bilinear 0.5x", (i) => scaleBilinear(i, 0.5)],
  ["bilinear 0.75x", (i) => scaleBilinear(i, 0.75)],
  ["bilinear 1.5x", (i) => scaleBilinear(i, 1.5)],
  ["bilinear 2x", (i) => scaleBilinear(i, 2)],
  ["area 0.5x", (i) => scaleArea(i, 0.5)],
  ["area 0.75x", (i) => scaleArea(i, 0.75)],
  ["area 1.5x", (i) => scaleArea(i, 1.5)],
  ["area 2x", (i) => scaleArea(i, 2)],
  ["shift +4,0,-4", (i) => shift(i, 4, 0, -4)],
  ["shift -4,+4,+4", (i) => shift(i, -4, 4, 4)],
  ["gamma 0.9", (i) => gamma(i, 0.9)],
  ["gamma 1.1", (i) => gamma(i, 1.1)],
  ["P3 matrix", (i) => p3(i)],
  ["chroma 2x2", (i) => chroma420(i)],
  ["chroma 2x2 @0.75x", (i) => chroma420(scaleArea(i, 0.75))],
  ["chroma 2x2 @0.5x", (i) => chroma420(scaleArea(i, 0.5))],
  ["P3+gamma1.1+chroma @0.75x", (i) => chroma420(gamma(p3(scaleArea(i, 0.75)), 1.1))],
  ["shift+gamma0.9 @1.5x", (i) => gamma(shift(scaleBilinear(i, 1.5), -3, 2, 4), 0.9)],
  ["JPEG q90", (i) => jpeg(i, 90)],
  ["JPEG q80", (i) => jpeg(i, 80)],
  ["JPEG q80 @1.5x", (i) => jpeg(scaleArea(i, 1.5), 80)],
];

function scaleOf(name) { const m = /(?:^|[ @])([\d.]+)x(?!\d)/.exec(name); return m ? Number(m[1]) : 1; }

function boxClose(got, want, s) {
  const tol = 3 + 2 * s;
  return Math.abs(got.x - want.x * s) <= tol && Math.abs(got.y - want.y * s) <= tol
    && Math.abs(got.w - want.w * s) <= tol + want.w * s * 0.05 && Math.abs(got.h - want.h * s) <= tol + want.h * s * 0.1;
}

// Columns: name, bitmap height, code, and whether the column is asserted.
// H 72 is the ink of a 30 px CSS name at 2x (about 44 px tall). A short name
// is drawn larger (the signature flow does so on "mark_too_small"). H 60 is a
// smaller rendering near the minimum ink and "Felix" a first name alone, reported to show where the
// margin runs out.
const COLUMNS = [
  { name: "Felix Crabtree", H: 72, code: CODE_A, seed: 1, required: true },
  { name: "Jonathan Abernethy", H: 72, code: CODE_B, seed: 2, required: true },
  { name: "Ada Hu", H: 110, code: "INKK-0000-0000-0000", seed: 5, required: true },
  { name: "Maria Delacroix", H: 60, code: "INKK-HJKM-NPQR-STVW", seed: 3, required: false },
  { name: "Felix", H: 130, code: "INKK-ZZZZ-ZZZZ-ZZZZ", seed: 6, required: false },
];

test("decodes the mark from a mail window through scaling, colour management, chroma loss and JPEG", () => {
  const scenes = COLUMNS.map((c) => sceneWithMark(c.name, c.H, c.code, c.seed));
  const rows = [];
  const failures = [];
  for (const [tn, f] of TRANSFORMS) {
    const s = scaleOf(tn);
    const cells = COLUMNS.map((col, k) => {
      const sc = scenes[k];
      // JPEG is simulated on the part of the window around the signature to keep the run short.
      const heavy = /JPEG/.test(tn);
      const cx = heavy ? sc.box.x - 120 : 0, cy = heavy ? sc.box.y - 150 : 0;
      const base = heavy ? crop(sc.img, cx, cy, sc.box.w + 240, sc.box.h + 300) : sc.img;
      const want = { x: sc.box.x - cx, y: sc.box.y - cy, w: sc.box.w, h: sc.box.h };
      const found = decodeMarks(f(base));
      const hit = found.find((m) => m.code === col.code);
      const wrong = found.filter((m) => m.code !== col.code);
      const ok = !!hit && !wrong.length && boxClose(hit.box, want, s);
      if (!ok && col.required) failures.push(`${tn} / ${col.name}: ${JSON.stringify(found)} want ${JSON.stringify(want)} x${s}`);
      if (wrong.length) failures.push(`${tn} / ${col.name}: WRONG ${wrong.map((w) => w.code)}`);
      return ok ? `ok ${hit.confidence.toFixed(2)}` : wrong.length ? "WRONG" : "miss";
    });
    rows.push([tn, ...cells]);
  }
  const head = ["transform", ...COLUMNS.map((c) => `${c.name} (${c.H}px${c.required ? "" : ", info"})`)];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(["", line(head), ...rows.map(line), ""].join("\n"));
  assert.deepStrictEqual(failures, []);
});

test("finds two different marks in one capture, in BGRA and from a Buffer", () => {
  const a = renderText("Felix Crabtree", 72, { seed: 1 });
  const b = renderText("Maria Delacroix", 72, { seed: 3 });
  encodeMark(a, CODE_A);
  encodeMark(b, CODE_B);
  const { img } = mailWindow(5, 1000, 640);
  blit(img, a, 250, 420);
  blit(img, b, 250, 520);
  const bgra = Buffer.alloc(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    bgra[i] = img.data[i + 2]; bgra[i + 1] = img.data[i + 1]; bgra[i + 2] = img.data[i]; bgra[i + 3] = 255;
  }
  const found = decodeMarks({ width: img.width, height: img.height, data: bgra }, { format: "bgra" });
  assert.deepStrictEqual(found.map((f) => f.code).sort(), [CODE_A, CODE_B].sort());
  for (const f of found) {
    assert.ok(f.confidence > 0 && f.confidence <= 1);
    assert.ok(f.box.y >= 400 && f.box.y + f.box.h <= 600, JSON.stringify(f.box));
  }
  // Read as RGBA by mistake, the blue-red axis flips and nothing decodes.
  assert.deepStrictEqual(decodeMarks({ width: img.width, height: img.height, data: bgra }), []);
});

test("a cropped mark gives no code rather than a wrong one", () => {
  const ink = renderText("Felix Crabtree", 72, { seed: 1 });
  encodeMark(ink, CODE_A);
  for (const frac of [0.5, 0.8, 0.93]) {
    const page = blank(Math.round(ink.width * frac) + 40, ink.height + 40);
    blit(page, crop(ink, 0, 0, Math.round(ink.width * frac), ink.height), 20, 20);
    assert.deepStrictEqual(decodeMarks(page).filter((f) => f.code !== CODE_A), [], `crop ${frac}`);
  }
});

// ---------------------------------------------------------------------------
// False positives

function codeScene(seed) {
  // Syntax colouring in dark, weakly tinted inks: two-level colour at word scale.
  const PAL = [[30, 30, 62], [62, 36, 24], [26, 46, 34], [52, 30, 54], [22, 22, 22], [40, 40, 70], [70, 40, 30], [16, 20, 40], [40, 20, 16], [31, 35, 40]];
  const r = rng(seed);
  const img = blank(700, 420);
  let y = 10;
  while (y < 380) {
    let x = 10 + Math.floor(r() * 40);
    const h = 24 + Math.floor(r() * 30);
    for (let t = 0; t < 6 && x < 650; t++) {
      const g = renderText(["const", "mark", "return", "decode", "if", "for", "let", "tint", "x", "the"][Math.floor(r() * 10)], h, { ink: PAL[Math.floor(r() * PAL.length)], seed: seed * 7 + t });
      blit(img, g, x, y);
      x += g.width + 6;
    }
    y += h + 4;
  }
  return img;
}

function alternating(seed) {
  // Every letter in a random cool or warm near-black: the most mark-like thing that is not a mark.
  const r = rng(seed);
  const img = blank(760, 220);
  let y = 10;
  for (let line = 0; line < 3; line++) {
    const h = 44 + Math.floor(r() * 24);
    let x = 10;
    for (const ch of ["Jonathan Crabtree", "Maria Delacroix", "Hello there reader"][line]) {
      const col = r() < 0.5 ? [14 + r() * 6, 26, 38 + r() * 6] : [38 + r() * 6, 26, 14 + r() * 6];
      const g = renderText(ch, h, { ink: col, seed: seed + x });
      blit(img, g, x, y);
      x += g.width - h * 0.3;
    }
    y += h + 6;
  }
  return img;
}

function uiScene(seed) {
  const r = rng(seed);
  const img = blank(900, 560);
  for (let i = 0; i < 12; i++) {
    const col = [r() * 255, r() * 255, r() * 255].map(Math.round);
    fillRect(img, 20 + (i % 4) * 210, 20 + Math.floor(i / 4) * 60, 190, 40, col);
    blit(img, textLine(2, 24, col[0] + col[1] + col[2] > 380 ? [20, 20, 20] : [255, 255, 255], seed + i), 30 + (i % 4) * 210, 28 + Math.floor(i / 4) * 60);
  }
  for (let x = 0; x < 860; x++) for (let y = 220; y < 300; y++) {
    const d = (y * 900 + 20 + x) * 4;
    img.data[d] = (x / 860) * 255; img.data[d + 1] = 30 + (y - 220); img.data[d + 2] = 255 - (x / 860) * 200;
  }
  fillRect(img, 20, 320, 860, 220, [30, 30, 34]); // dark-mode panel with light text
  for (let i = 0; i < 4; i++) blit(img, textLine(5, 30, [225, 225, 230], seed + 40 + i), 40, 330 + i * 50);
  return img;
}

test("finds nothing in windows, photos, UI and coloured text that carry no mark", () => {
  const scenes = [];
  for (let k = 0; k < 3; k++) scenes.push([`mail ${k}`, mailWindow(20 + k).img]);
  for (let k = 0; k < 4; k++) scenes.push([`photo ${k}`, photo(420, 300, 30 + k)]);
  for (let k = 0; k < 4; k++) scenes.push([`code ${k}`, codeScene(40 + k)]);
  for (let k = 0; k < 4; k++) scenes.push([`alternating ${k}`, alternating(50 + k)]);
  for (let k = 0; k < 2; k++) scenes.push([`ui ${k}`, uiScene(60 + k)]);
  const variants = [["1x", (i) => i], ["area 0.5x", (i) => scaleArea(i, 0.5)], ["bilinear 1.5x", (i) => scaleBilinear(i, 1.5)], ["chroma 2x2", chroma420], ["P3", p3], ["JPEG q80", (i) => jpeg(i, 80)]];
  const hits = [];
  let decoded = 0;
  for (const [sn, img] of scenes) for (const [vn, f] of variants) {
    const found = decodeMarks(f(img));
    decoded++;
    if (found.length) hits.push(`${sn} / ${vn}: ${JSON.stringify(found)}`);
  }
  console.log(`false-positive corpus: ${decoded} images, ${hits.length} with a reported mark`);
  assert.deepStrictEqual(hits, []);
});

test("random noise, flat colours and gradients decode to nothing", () => {
  const r = rng(99);
  const noise = blank(500, 300);
  for (let i = 0; i < noise.data.length; i += 4) for (let c = 0; c < 3; c++) noise.data[i + c] = r() * 255;
  const dark = blank(500, 300, [18, 22, 40]);
  const grad = blank(500, 300);
  for (let y = 0; y < 300; y++) for (let x = 0; x < 500; x++) {
    const d = (y * 500 + x) * 4;
    grad.data[d] = x / 2; grad.data[d + 1] = y / 1.5; grad.data[d + 2] = 255 - x / 2;
  }
  for (const img of [noise, dark, grad, blank(10, 10), blank(1, 1)]) assert.deepStrictEqual(decodeMarks(img), []);
});

// ---------------------------------------------------------------------------
// Browser bundle

test("bundles for the browser with esbuild and decodes there", () => {
  let esbuild;
  try { esbuild = require("esbuild"); } catch { return; }
  const out = esbuild.buildSync({ entryPoints: [require.resolve("./mark")], bundle: true, format: "iife", globalName: "inkkMark", platform: "browser", write: false, logLevel: "silent" });
  const src = out.outputFiles[0].text;
  assert.ok(!/\brequire\(["'`]/.test(src), "no module require() left in the browser bundle");
  const vm = require("node:vm");
  const ctx = vm.createContext({ Uint8ClampedArray, Float32Array, Float64Array, Int32Array, Int16Array, Uint8Array, Uint16Array, Uint32Array, Math, Array, Error, Number, String, Object });
  vm.runInContext(src, ctx);
  const img = renderText("Felix Crabtree", 72, { seed: 1 });
  ctx.inkkMark.encodeMark(img, CODE_A);
  const found = JSON.parse(JSON.stringify(ctx.inkkMark.decodeMarks(composite(img)))); // out of the sandbox's realm
  assert.deepStrictEqual(found.map((f) => f.code), [CODE_A]);
});
