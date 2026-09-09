// Run: node --test src/verify/token.test.mjs
//
// INKK2 tokens are the trust anchor for offline verification, so the cases that
// matter most are the adversarial ones: a tampered score, a swapped signature,
// and a token presented alongside text it doesn't belong to.

import { test } from "node:test";
import assert from "node:assert";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  buildPayload, encodeToken, decodeToken, verifyToken,
  shortCodeFromToken, tokenURL, TIERS, __test__,
} from "./token.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

const signer = (payload) => new Uint8Array(sign(null, Buffer.from(payload), privateKey));
const verifier = (key) => (payload, signature) =>
  verify(null, Buffer.from(payload), key, Buffer.from(signature));
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest());
const hashHex = (text) => createHash("sha256").update(text).digest("hex");

const CERT = { score: 87, tier: "Distinct", contentHash: hashHex("a real essay"), issuedAt: 1780000000, keyId: 1 };
const mint = (c = CERT) => encodeToken(buildPayload(c), signer(buildPayload(c)));

test("token is the documented shape and length", () => {
  const t = mint();
  assert.ok(t.startsWith("INKK2."));
  assert.strictEqual(t.length, 124);
  assert.ok(/^INKK2\.[A-Za-z0-9_-]+$/.test(t), "must be URL-safe");
});

test("round-trips every field", () => {
  const d = decodeToken(mint());
  assert.strictEqual(d.score, 87);
  assert.strictEqual(d.tier, "Distinct");
  assert.strictEqual(d.version, 2);
  assert.strictEqual(d.keyId, 1);
  assert.strictEqual(d.issuedAt, 1780000000);
  assert.strictEqual(d.hash16, hashHex("a real essay").slice(0, 32));
});

test("verifies offline against the right key", () => {
  const r = verifyToken(mint(), verifier(publicKey));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.score, 87);
  assert.strictEqual(r.textMatches, null, "no text supplied → unknown, not false");
});

test("confirms matching text, rejects different text", () => {
  const t = mint();
  assert.strictEqual(verifyToken(t, verifier(publicKey), { contentHash: hashHex("a real essay") }).textMatches, true);
  assert.strictEqual(verifyToken(t, verifier(publicKey), { contentHash: hashHex("a real essay.") }).textMatches, false);
});

test("ADVERSARIAL: a forged score fails the signature", () => {
  const d = decodeToken(mint());
  const tampered = new Uint8Array(d.payload);
  tampered[2] = 100;                                  // rewrite the score
  const forged = encodeToken(tampered, d.signature);
  const r = verifyToken(forged, verifier(publicKey));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "bad-signature");
});

test("ADVERSARIAL: a token signed by anyone else fails", () => {
  const p = buildPayload(CERT);
  const impostor = encodeToken(p, new Uint8Array(sign(null, Buffer.from(p), other.privateKey)));
  assert.strictEqual(verifyToken(impostor, verifier(publicKey)).ok, false);
});

test("garbage and truncation are rejected, not crashed on", () => {
  for (const bad of ["", "hello", "INKK2.", "INKK2.!!!!", "INKK-7F3A-9K2D-XQ4M", mint().slice(0, 80)]) {
    assert.strictEqual(decodeToken(bad), null, `should reject: ${bad}`);
    assert.strictEqual(verifyToken(bad, verifier(publicKey)).ok, false);
  }
});

test("tolerates being handed the whole URL", () => {
  const t = mint();
  assert.strictEqual(decodeToken(tokenURL(t)).score, 87);
  assert.ok(tokenURL(t).startsWith("https://inkk.site/v/INKK2."));
});

test("short code is derived, stable, and in the existing format", () => {
  const t = mint();
  const code = shortCodeFromToken(t, sha256);
  assert.match(code, /^INKK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.strictEqual(code, shortCodeFromToken(t, sha256), "must be deterministic");
  for (const ch of code.replace(/INKK-|-/g, "")) assert.ok(__test__.ALPHABET.includes(ch), "Crockford only");
});

test("distinct certificates get distinct short codes", () => {
  const a = shortCodeFromToken(mint(), sha256);
  const b = shortCodeFromToken(mint({ ...CERT, score: 42 }), sha256);
  assert.notStrictEqual(a, b);
});

test("all four tiers survive the round trip", () => {
  for (const tier of TIERS) {
    assert.strictEqual(decodeToken(mint({ ...CERT, tier })).tier, tier);
  }
});
