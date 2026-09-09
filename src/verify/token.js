// INKK2 — self-verifying certificate tokens.
//
// The INKK-XXXX-XXXX-XXXX code is a *handle*: it means nothing without asking
// inkk's ledger. An INKK2 token is the opposite — it carries its own proof, so
// a reader can verify a piece with no network call, no lookup, and no trust in
// inkk being online (or existing). That property is what an institution asks
// about before licensing anything, and it means inkk never learns who checked
// which document.
//
// Layout — 88 bytes, base64url'd behind an "INKK2." prefix (124 chars total):
//
//   payload (24 bytes)
//     0      version   0x02
//     1      keyId     which inkk signing key (allows rotation)
//     2      score     0..100
//     3      tier      0 Faint · 1 Developing · 2 Strong · 3 Distinct
//     4..7   issuedAt  uint32 BE, unix seconds
//     8..23  hash16    first 16 bytes of SHA-256(normalised text)
//   signature (64 bytes)
//     Ed25519 over the 24 payload bytes
//
// 128 bits of content hash is far past collision-resistance for this job, and
// truncating is what keeps the token short enough to live in a mailto-safe URL.
//
// This module is deliberately crypto-agnostic: sign/verify are injected, so it
// imports cleanly into the browser bundle, Electron's main process and the
// Vercel function without dragging node:crypto into any of them.

const MAGIC = "INKK2.";
const PAYLOAD_LEN = 24;
const SIG_LEN = 64;
export const TOKEN_VERSION = 2;

export const TIERS = ["Faint", "Developing", "Strong", "Distinct"];
const TIER_INDEX = new Map(TIERS.map((t, i) => [t, i]));

// Crockford base32 — same alphabet as the short code, so both notations of a
// certificate are drawn from one vocabulary.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function b64urlEncode(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(str, "base64url"));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex, len) {
  const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2) || "0", 16);
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pack certificate facts into the 24-byte payload that gets signed.
 *
 * @param {object} c
 * @param {number} c.score        0..100
 * @param {string} c.tier         one of TIERS
 * @param {string} c.contentHash  hex SHA-256 of the normalised text
 * @param {number} [c.issuedAt]   unix SECONDS (not ms)
 * @param {number} [c.keyId]      signing key id, default 1
 */
export function buildPayload({ score, tier, contentHash, issuedAt, keyId = 1 }) {
  const p = new Uint8Array(PAYLOAD_LEN);
  p[0] = TOKEN_VERSION;
  p[1] = keyId & 0xff;
  p[2] = Math.max(0, Math.min(100, Math.round(score || 0)));
  p[3] = TIER_INDEX.get(tier) ?? 0;
  const t = Math.floor(issuedAt ?? (Date.now() / 1000));
  p[4] = (t >>> 24) & 0xff; p[5] = (t >>> 16) & 0xff; p[6] = (t >>> 8) & 0xff; p[7] = t & 0xff;
  p.set(hexToBytes(contentHash, 16), 8);
  return p;
}

export function readPayload(p) {
  const t = ((p[4] << 24) >>> 0) + (p[5] << 16) + (p[6] << 8) + p[7];
  return {
    version: p[0],
    keyId: p[1],
    score: p[2],
    tier: TIERS[p[3]] ?? TIERS[0],
    issuedAt: t,                       // unix seconds
    issuedAtISO: new Date(t * 1000).toISOString(),
    hash16: bytesToHex(p.slice(8, 24)),
  };
}

/** Assemble the printable token from a payload and its signature. */
export function encodeToken(payload, signature) {
  if (payload.length !== PAYLOAD_LEN) throw new Error("bad payload length");
  if (signature.length !== SIG_LEN) throw new Error("bad signature length");
  const all = new Uint8Array(PAYLOAD_LEN + SIG_LEN);
  all.set(payload, 0);
  all.set(signature, PAYLOAD_LEN);
  return MAGIC + b64urlEncode(all);
}

/**
 * Parse a token. Structural only — says nothing about authenticity, which
 * needs verifyToken. Returns null if this isn't a well-formed INKK2 token.
 */
export function decodeToken(token) {
  const s = String(token || "").trim();
  const body = s.startsWith(MAGIC) ? s.slice(MAGIC.length)
    : s.includes(MAGIC) ? s.slice(s.indexOf(MAGIC) + MAGIC.length)   // tolerate a URL prefix
    : null;
  if (!body) return null;
  let bytes;
  try { bytes = b64urlDecode(body.replace(/[^A-Za-z0-9_-]/g, "")); } catch { return null; }
  if (bytes.length !== PAYLOAD_LEN + SIG_LEN) return null;
  const payload = bytes.slice(0, PAYLOAD_LEN);
  if (payload[0] !== TOKEN_VERSION) return null;
  return { payload, signature: bytes.slice(PAYLOAD_LEN), ...readPayload(payload) };
}

/**
 * Verify a token offline.
 *
 * @param {string} token
 * @param {(payload: Uint8Array, signature: Uint8Array, keyId: number) => boolean} verifySig
 * @param {object} [opts]
 * @param {string} [opts.contentHash] hex SHA-256 of the text the reader holds
 * @returns {{ok: boolean, reason?: string, ...}} `textMatches` is true/false
 *          when a hash was supplied, null when the reader has no text — the
 *          three states the receiver UI needs to distinguish.
 */
export function verifyToken(token, verifySig, { contentHash } = {}) {
  const t = decodeToken(token);
  if (!t) return { ok: false, reason: "malformed" };
  let signed = false;
  try { signed = !!verifySig(t.payload, t.signature, t.keyId); } catch { signed = false; }
  if (!signed) return { ok: false, reason: "bad-signature", ...stripBytes(t) };
  const textMatches = contentHash == null ? null
    : bytesToHex(hexToBytes(contentHash, 16)) === t.hash16;
  return { ok: true, textMatches, ...stripBytes(t) };
}

function stripBytes({ payload, signature, ...rest }) { return rest; }

/**
 * The short, human-readable form of the same certificate. Derived from the
 * token rather than random, so INKK-7F3A-9K2D and the long token are two
 * notations of one thing.
 *
 * @param {string} token
 * @param {(bytes: Uint8Array) => Uint8Array} sha256  digest function
 */
export function shortCodeFromToken(token, sha256) {
  const t = decodeToken(token);
  if (!t) return null;
  const all = new Uint8Array(PAYLOAD_LEN + SIG_LEN);
  all.set(t.payload, 0); all.set(t.signature, PAYLOAD_LEN);
  const digest = sha256(all);
  let body = "";
  for (let i = 0; i < 12; i++) body += ALPHABET[digest[i] % ALPHABET.length];
  return `INKK-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** The URL a reader lands on. Everything needed to verify is in the path. */
export function tokenURL(token, base = "https://inkk.site") {
  return `${base}/v/${token}`;
}

export const __test__ = { MAGIC, PAYLOAD_LEN, SIG_LEN, ALPHABET, hexToBytes, bytesToHex };
