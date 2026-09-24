// Run: node --test src/verify/sketch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalText, sentences, sentenceKey, textSketch, textFingerprint, compareText, SKETCH_HEX } from "./sketch.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const PIECE = `On slow mornings the kettle takes its time, and so do I. There is a particular
quality to the light before seven that makes every sentence feel provisional.
I have learned to wait for it. Most days it is worth the wait!`;

test("seals never change the fingerprint", async () => {
  const sealed = `${PIECE}\n\ninkk. inkk.site/v/INKK-7F3A-9K2D-XQ4M`;
  const coded = `${PIECE} INKK-7F3A-9K2D-XQ4M https://www.inkk.site/v/INKK-7F3A-9K2D-XQ4M`;
  const base = await textFingerprint(PIECE, sha);
  assert.equal(await textFingerprint(sealed, sha), base);
  assert.equal(await textFingerprint(coded, sha), base);
  assert.equal(canonicalText("a  b\n\nc"), "a b c");
});

test("sentences split on terminal punctuation and closing quotes", () => {
  const s = sentences(canonicalText(`He said "stop." Then he left! Did he? Yes.`));
  assert.deepEqual(s, [`He said "stop."`, "Then he left!", "Did he?", "Yes."]);
  assert.equal(sentenceKey("  Don’t — STOP, now!  "), "don t stop now");
});

test("sketch is short fingerprints, one per substantial sentence", async () => {
  const sk = await textSketch(PIECE, sha);
  assert.equal(sk.length, 4);
  for (const h of sk) assert.match(h, new RegExp(`^[0-9a-f]{${SKETCH_HEX}}$`));
  assert.deepEqual(await textSketch("Thanks. Best.", sha), []);
});

test("a reader's view of an email still matches the certified text", async () => {
  const cert = { contentHash: await textFingerprint(PIECE, sha), sketch: await textSketch(PIECE, sha) };
  const inbox = `From: Felix Crabtree <f@example.com>\nSubject: mornings\nTo: you\n\n${PIECE.replace(/\n/g, " ")}\n\nFelix\ninkk. inkk.site/v/INKK-7F3A-9K2D-XQ4M\n\nSent from my Mac`;
  const r = await compareText(cert, inbox, sha);
  assert.equal(r.state, "match");
  assert.equal(r.ratio, 1);
  assert.equal((await compareText(cert, PIECE, sha)).state, "match");
});

test("edits show as partial or differs; nothing to compare is unknown", async () => {
  const cert = { contentHash: await textFingerprint(PIECE, sha), sketch: await textSketch(PIECE, sha) };
  const edited = PIECE.replace("Most days it is worth the wait!", "Some days it is not.");
  const r1 = await compareText(cert, edited, sha);
  assert.equal(r1.state, "partial");
  assert.equal(r1.ratio, 0.75);
  assert.equal((await compareText(cert, "Something else entirely, written by someone else.", sha)).state, "differs");
  assert.equal((await compareText(cert, "", sha)).state, "unknown");
  assert.equal((await compareText({ contentHash: null, sketch: [] }, PIECE, sha)).state, "unknown");
});

test("legacy certificates (normalised text, no sketch) still match exactly", async () => {
  const { normalizePlainText } = await import("./code.js");
  const legacy = { contentHash: sha(normalizePlainText(PIECE)), sketch: null };
  assert.equal((await compareText(legacy, PIECE, sha)).state, "match");
});

// The run a signed name carries (companion/lib/zw.js): only the two joiners.
const HIDDEN = "\u200D\u200C\u200D\u200D\u200C\u200D\u200C\u200C".repeat(9) + "\u200C\u200D\u200C\u200D";

test("zero-width characters, a signed name's hidden code among them, never change a fingerprint", async () => {
  const signed = `${PIECE}\n\nBest,\nAda Writer${HIDDEN}`;
  const plain = `${PIECE}\n\nBest,\nAda Writer`;
  assert.equal(canonicalText(signed), canonicalText(plain));
  assert.equal(await textFingerprint(signed, sha), await textFingerprint(plain, sha));
  assert.deepEqual(await textSketch(signed, sha), await textSketch(plain, sha));
  // Inside words they are removed, not turned into spaces.
  assert.equal(canonicalText("mor\u200Bning\u2060 li\uFEFFght\u200C"), "morning light");
  const cert = { contentHash: await textFingerprint(PIECE, sha), sketch: await textSketch(PIECE, sha) };
  assert.equal((await compareText(cert, `${PIECE}\n\nAda Writer${HIDDEN}`, sha)).state, "match");
});

test("certificates issued while zero-width characters still counted keep matching", async () => {
  const { normalizePlainText } = await import("./code.js");
  const withJoiner = `${PIECE} A family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.`;
  // canonicalText as it was: the seal removed, the joiners kept.
  const before = { contentHash: sha(normalizePlainText(withJoiner)), sketch: null };
  assert.notEqual(before.contentHash, await textFingerprint(withJoiner, sha));
  const sealed = `${withJoiner}\n\ninkk. inkk.site/v/INKK-7F3A-9K2D-XQ4M`;
  assert.equal((await compareText(before, sealed, sha)).state, "match");
});
