// Text fingerprints for certificates: one for the whole text, one per sentence.
//
// A certificate binds a code to a text. Readers rarely see that text exactly as
// it was certified: an email arrives inside quoted headers and a signature, a
// document picks up the seal line, a paragraph gets trimmed. So besides the
// whole-text fingerprint (content_hash) a certificate carries a sketch: a short
// fingerprint of every sentence. A reader's app sketches what it can see and
// reports how much of the certified text is there, unchanged.
//
// Pure and crypto-agnostic: the SHA-256 function is injected, so the same code
// runs in the browser (Web Crypto), in the desktop companion (node:crypto) and
// in the Vercel function. Nothing here ever leaves the device; only the hashes do.

import { normalizePlainText } from "./code.js";

// Everything a seal adds to a text, removed before fingerprinting, so a code or
// seal link appended after certifying never changes the fingerprint.
const SEAL_PATTERNS = [
  /\binkk\.?\s+(?:https?:\/\/)?(?:www\.)?inkk\.site\/v\/[A-Za-z0-9._~-]+/gi,
  /(?:https?:\/\/)?(?:www\.)?inkk\.site\/v\/[A-Za-z0-9._~-]+/gi,
  /\bINKK2\.[A-Za-z0-9_-]{20,}/g,
  /\bINKK[-‐-― ]?[0-9A-Za-z]{4}[-‐-― ]?[0-9A-Za-z]{4}[-‐-― ]?[0-9A-Za-z]{4}\b/gi,
];

export const SKETCH_HEX = 10;        // 40-bit prefixes: tiny, and collisions are irrelevant at this scale
export const SKETCH_MAX = 600;       // sentences kept per certificate
export const SENTENCE_MIN = 16;      // shorter fragments ("Thanks," "Best,") carry no signal

// The text a certificate is about: normalised, with any seal removed.
export function canonicalText(input) {
  let t = normalizePlainText(input || "");
  for (const re of SEAL_PATTERNS) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
}

// Sentences of a canonical text. Splits after . ! ? … (and any closing quote or
// bracket that follows), which is enough for prose; exactness does not matter
// as long as the writer's and the reader's side split the same way.
export function sentences(canonical) {
  if (!canonical) return [];
  return canonical
    .split(/(?<=[.!?…]["'”’)\]]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A sentence's matching key: case, punctuation and spacing do not count, so
// smart quotes, autocorrect capitals and reflowed lines still match.
export function sentenceKey(s) {
  return String(s).toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function keysOf(input) {
  const seen = new Set();
  const out = [];
  for (const s of sentences(canonicalText(input))) {
    const k = sentenceKey(s);
    if (k.length < SENTENCE_MIN || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= SKETCH_MAX) break;
  }
  return out;
}

// sha256hex: (string) => hex string, or a Promise of one.
export async function textFingerprint(input, sha256hex) {
  const t = canonicalText(input);
  return t ? await sha256hex(t) : null;
}

export async function textSketch(input, sha256hex) {
  const keys = keysOf(input);
  const out = [];
  for (const k of keys) out.push((await sha256hex(k)).slice(0, SKETCH_HEX));
  return out;
}

// The reader's side sees text framed by things the writer never typed: email
// headers without full stops, a signature, lines hard-wrapped at 72 columns.
// So it tries several segmentations of the raw text and keeps every key any of
// them produces: the whole text, each paragraph, each line, and each run from
// a line start to the end of its paragraph. The writer's side stays exactly
// sentences(canonicalText(text)), which is always among these.
function readerKeys(observed) {
  const raw = String(observed || "").replace(/\r\n?/g, "\n");
  const keys = new Set();
  const add = (chunk) => {
    for (const s of sentences(canonicalText(chunk))) {
      const k = sentenceKey(s);
      if (k.length >= SENTENCE_MIN) keys.add(k);
    }
  };
  add(raw);
  for (const para of raw.split(/\n\s*\n/)) {
    add(para);
    const lines = para.split("\n");
    for (let i = 0; i < lines.length; i++) {
      add(lines[i]);
      if (i > 0) add(lines.slice(i).join("\n"));
    }
  }
  return keys;
}

// How much of a certified text is present, unchanged, in what a reader sees.
//   state "match"    every certified sentence is there (or the whole-text hash matches)
//   state "partial"  most of it is (>= 60%)
//   state "differs"  little or none of it is
//   state "unknown"  nothing to compare (no sketch, no text)
export async function compareText({ contentHash, sketch }, observed, sha256hex) {
  if (!observed || !String(observed).trim()) return { state: "unknown", ratio: null };
  if (contentHash) {
    const whole = await textFingerprint(observed, sha256hex);
    if (whole && whole === contentHash) return { state: "match", ratio: 1 };
    // Certificates issued before canonicalText hashed normalizePlainText directly.
    const legacy = await sha256hex(normalizePlainText(observed));
    if (legacy === contentHash) return { state: "match", ratio: 1 };
  }
  if (!Array.isArray(sketch) || sketch.length === 0) return { state: contentHash ? "differs" : "unknown", ratio: null };
  const seen = new Set();
  for (const k of readerKeys(observed)) seen.add((await sha256hex(k)).slice(0, SKETCH_HEX));
  let found = 0;
  for (const h of sketch) if (seen.has(h)) found++;
  const ratio = found / sketch.length;
  return { state: ratio >= 0.98 ? "match" : ratio >= 0.6 ? "partial" : "differs", ratio };
}
