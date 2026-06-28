// Verification codes + content hashing for inkk's human-signal certificates.
//
// A certificate is a *handle*: paste the code into inkk and it looks the piece
// up in inkk's own ledger and reports what process inkk recorded. The code does
// not "contain" the proof — inkk is the authority. (This is deliberately
// upgradeable to a self-verifying signed token later: the INKK prefix below
// leaves room for an INKK2… signed format.)
//
// The certificate is bound to the *text* through a content hash, so a reader
// holding an exported PDF can confirm "this code corresponds to text whose
// fingerprint is X" without inkk ever storing a copy of the text or the
// keystroke process.
//
// Everything here is pure and deterministic (the hash) or crypto-random (the
// code) — no React — so it is unit-testable in isolation.

// Crockford base32: no I, L, O, U — so the printed code can't be misread.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "INKK";
const GROUPS = 3;       // INKK-XXXX-XXXX-XXXX
const GROUP_LEN = 4;
const BODY_LEN = GROUPS * GROUP_LEN; // 12 symbols ≈ 60 bits of entropy

// Tiers that earn the "human-verified" mark. The score's tier names already
// communicate strength; "Strong" is the threshold the product promises.
const VERIFIED_TIERS = new Set(["Strong", "Distinct"]);

export function isVerifiedTier(tier) {
  return VERIFIED_TIERS.has(tier);
}

// Generate a fresh verification code, e.g. "INKK-7F3A-9K2D-XQ4M".
// Uniqueness is ultimately guaranteed by the ledger's primary-key constraint;
// 60 bits makes accidental collisions vanishingly unlikely.
export function makeVerifyCode() {
  const bytes = randomBytes(BODY_LEN);
  let body = "";
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return formatBody(body);
}

function formatBody(body) {
  const groups = [];
  for (let i = 0; i < body.length; i += GROUP_LEN) groups.push(body.slice(i, i + GROUP_LEN));
  return `${PREFIX}-${groups.join("-")}`;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = typeof window !== "undefined" ? window.crypto : undefined;
  if (c && c.getRandomValues) { c.getRandomValues(out); return out; }
  // Fallback (test/older env) — not cryptographic, but the ledger PK still
  // guarantees uniqueness and these codes are lookup handles, not secrets.
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

// Normalise whatever the user pasted (with or without the INKK- prefix, lower
// case, spaces, ambiguous glyphs) back to the canonical stored form. Returns
// null if it can't be read as a valid code.
export function parseVerifyCode(input) {
  if (!input) return null;
  let s = String(input).toUpperCase().trim();
  // Strip a leading "INKK" prefix (and its separator) BEFORE glyph mapping —
  // the prefix's own "I"/"K" must not be rewritten by the rules below.
  s = s.replace(/^INKK[\s\-_.]*/, "");
  // Map Crockford's ambiguous glyphs onto their canonical symbols.
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
  // Drop everything that isn't an alphabet symbol (spaces, dashes).
  s = s.replace(new RegExp(`[^${ALPHABET}]`, "g"), "");
  if (s.length !== BODY_LEN) return null;
  return formatBody(s);
}

// Strip HTML to the plain text a reader would actually copy, then normalise so
// the hash is stable across HTML markup differences and copy/paste reflow.
// IMPORTANT: this must produce the same string at publish time (from editor
// HTML) and at verify time (from pasted plain text).
export function normalizePlainText(htmlOrText) {
  if (!htmlOrText) return "";
  // Insert whitespace at line-break and block boundaries first, so words on
  // either side of <br>/</p>/</div> aren't glued together when tags are removed.
  const s = String(htmlOrText)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, " ");
  let text;
  if (/<[a-z][\s\S]*>/i.test(s) && typeof document !== "undefined") {
    const el = document.createElement("div");
    el.innerHTML = s;
    text = el.textContent || el.innerText || "";
  } else {
    // Already plain text (or no DOM available) — strip any stray tags crudely.
    text = s.replace(/<[^>]*>/g, " ");
  }
  // JS \s already matches the non-breaking space, so one collapse covers it.
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

// SHA-256 of the normalised plain text, hex. Returns null where Web Crypto's
// subtle digest is unavailable (e.g. insecure http context) so callers can
// degrade gracefully rather than throw.
export async function hashContent(htmlOrText) {
  const text = normalizePlainText(htmlOrText);
  const c = typeof window !== "undefined" ? window.crypto : undefined;
  if (!c?.subtle || typeof TextEncoder === "undefined") return null;
  try {
    const buf = await c.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export const __test__ = { ALPHABET, PREFIX, BODY_LEN, formatBody };
