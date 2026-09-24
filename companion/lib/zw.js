// inkk companion — a code in invisible ink.
//
// A signed name carries its code in its pixels, but a picture does not go
// everywhere: plain-text mail keeps only the text part, web mail throws away
// pasted pictures it cannot fetch, and a picture's description is text too.
// Wherever the name travels as text, its code travels right after it, written
// in two characters that take no space: ZERO WIDTH NON-JOINER for 0 and ZERO
// WIDTH JOINER for 1. Persian, the Indic scripts and every emoji family depend
// on those two, so mail apps, editors and the clipboard keep them, and
// Accessibility reads them back like any other character. The recipient sees
// the name and nothing else; inkk on their Mac sees the code.
//
//   encode(code)      → the invisible run for an INKK code (78 characters)
//   decodeAll(text)   → every code hidden in a text, in order, without repeats
//   strip(text)       → the text without zero-width characters
//
// THE RUN. An 8-bit start marker (10110100, the pixel mark's sync pattern,
// which cannot overlap itself, so a reader finds where a run starts), then the
// code's 60 bits and their CRC-8 exactly as the pixel mark computes them
// (lib/mark.js: 12 Crockford symbols, 5 bits each, most significant first;
// poly 0x07, init 0xFF). A run cut short or garbled fails the CRC and is
// ignored rather than misread.
//
// A ZERO WIDTH NON-JOINER stands on each side of those 76 bits. ZERO WIDTH
// JOINER is join-causing: straight after the last letter of an Arabic,
// Persian or Urdu name (علی, حسین) it would pull that letter into its
// connecting form, a visible tail in exactly the plain text a recipient sees
// when the picture is dropped. The non-joiners keep the name's last letter,
// and whatever is typed after the run, shaped as if the run were not there.
// They carry no bits: a reader looks for the marker at every offset.
//
// A run must be contiguous: a stray visible character ends it. Other invisible
// characters an editor may slip in (ZERO WIDTH SPACE, WORD JOINER, a byte
// order mark) are skipped over.

"use strict";

const { codeToBits, bitsToCode, crc8 } = require("./mark");

const ZERO = "\u200C";
const ONE = "\u200D";
const MARKER = "10110100";
const PAYLOAD_BITS = 60;
const CRC_BITS = 8;
const LENGTH = MARKER.length + PAYLOAD_BITS + CRC_BITS;   // the bits; a run is 2 longer

const RUN_RE = /[\u200B-\u200D\u2060\uFEFF]+/g;
const SKIPPED_RE = /[\u200B\u2060\uFEFF]/g;
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

function encode(code) {
  let payload;
  try { payload = codeToBits(code); } catch { throw new TypeError(`not an INKK code: ${code}`); }
  const crc = crc8(payload);
  let bits = MARKER + payload.join("");
  for (let b = CRC_BITS - 1; b >= 0; b--) bits += (crc >> b) & 1;
  let out = ZERO;
  for (const bit of bits) out += bit === "1" ? ONE : ZERO;
  return out + ZERO;
}

// The code whose run starts at `at` in a string of "0"/"1", or null.
function readAt(bits, at) {
  if (!bits.startsWith(MARKER, at)) return null;
  const start = at + MARKER.length;
  const payload = [];
  for (let i = start; i < start + PAYLOAD_BITS; i++) payload.push(bits.charCodeAt(i) === 49 ? 1 : 0);
  const crc = parseInt(bits.slice(start + PAYLOAD_BITS, start + PAYLOAD_BITS + CRC_BITS), 2);
  return crc8(payload) === crc ? bitsToCode(payload) : null;
}

function decodeAll(text) {
  const out = [];
  if (!text) return out;
  const seen = new Set();
  for (const m of String(text).matchAll(RUN_RE)) {
    if (m[0].length < LENGTH) continue;
    const bits = m[0].replace(SKIPPED_RE, "").replace(/\u200C/g, "0").replace(/\u200D/g, "1");
    for (let at = 0; at + LENGTH <= bits.length;) {
      const code = readAt(bits, at);
      if (!code) { at++; continue; }
      if (!seen.has(code)) { seen.add(code); out.push(code); }
      at += LENGTH;
    }
  }
  return out;
}

function strip(text) {
  return String(text == null ? "" : text).replace(INVISIBLE_RE, "");
}

module.exports = { encode, decodeAll, strip, ZERO, ONE, MARKER, LENGTH };
