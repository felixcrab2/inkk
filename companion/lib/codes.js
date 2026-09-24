// inkk companion — codes and fingerprints, in plain Node.
//
// A session gets its INKK code the moment it opens, so the code is on screen
// long before anyone asks for it; certifying binds that code to a fingerprint
// in the ledger. The alphabet and shape match src/verify/code.js exactly
// (Crockford base32, INKK-XXXX-XXXX-XXXX), so a code minted here verifies like
// one minted in the editor. Fingerprints are SHA-256 of the same normalised
// text the website hashes, via the bundled normalizePlainText.

"use strict";

const { randomBytes, createHash } = require("node:crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function makeCode() {
  const bytes = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % 32];
  return `INKK-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// The fingerprint of a piece of text (already normalised by the caller).
function hashText(normalised) {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

// When no text can be read, the certificate binds to the session itself.
function sessionHash(sessionId) {
  return createHash("sha256").update(`inkk-session:${sessionId}`, "utf8").digest("hex");
}

// Codes and seal links as they appear in the wild: "INKK-7F3A-9K2D-XQ4M",
// "inkk.site/v/INKK-…", with the usual typing slips (o→0, i/l→1) tolerated
// the same way the website's parseVerifyCode tolerates them.
const CODE_RE = /\bINKK[-‐-―\s]?([0-9A-Za-z]{4})[-‐-―\s]?([0-9A-Za-z]{4})[-‐-―\s]?([0-9A-Za-z]{4})\b/g;
function normaliseCode(a, b, c) {
  const fix = (s) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
  const body = fix(a + b + c);
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return null;
  return `INKK-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}
function findCodes(text) {
  const out = [];
  const seen = new Set();
  if (!text) return out;
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(text))) {
    const code = normaliseCode(m[1], m[2], m[3]);
    if (code && !seen.has(code)) { seen.add(code); out.push(code); }
  }
  return out;
}

module.exports = { makeCode, hashText, sessionHash, findCodes, ALPHABET };
