// Run: node --test companion/capture.test.js
//
// Proves the companion's physical-key → event translation produces a trace the
// REAL server-side feature extractor can score (imported straight from src, so
// this test breaks if the two ever drift).

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { randomUUID } = require("node:crypto");
const { createCapture } = require("./capture");

// A deterministic clock: each call advances by a supplied gap so we can shape
// realistic inter-keystroke timing without wall-clock flakiness.
function scriptedClock(gaps) {
  let t = 1_000_000;
  let i = 0;
  return () => {
    const g = i < gaps.length ? gaps[i] : 40;
    i++;
    t += g;
    return t;
  };
}

function newCapture(clock) {
  return createCapture({
    userId: "u-test",
    docId: "doc-test",
    sessionId: "sess-test",
    genId: randomUUID,
    now: clock,
    hrnow: clock,
  });
}

test("session_start is seq 0 and content-free", () => {
  const cap = newCapture(scriptedClock([]));
  cap.start({ platform: "darwin", app: "Notes" });
  const e = cap.events[0];
  assert.strictEqual(e.kind, "session_start");
  assert.strictEqual(e.seq, 0);
  assert.strictEqual(e.schema_version, 2);
  assert.strictEqual(e.key_char, null);
});

test("a printable key emits keydown, input(+1), keyup — and never key_char", () => {
  const cap = newCapture(scriptedClock([10, 10, 10]));
  cap.start();
  cap.keydown("h");
  cap.keyup("h");
  const kinds = cap.events.slice(1).map(e => e.kind);
  assert.deepStrictEqual(kinds, ["keydown", "input", "keyup"]);
  const input = cap.events.find(e => e.kind === "input");
  assert.strictEqual(input.len_delta, 1);
  assert.strictEqual(input.caret_pos, 1);
  assert.strictEqual(cap.events.every(e => e.key_char === null), true);
});

test("backspace emits a delete(-1) and walks the caret back", () => {
  const cap = newCapture(scriptedClock([]));
  cap.start();
  cap.keydown("a"); cap.keyup("a");
  cap.keydown("b"); cap.keyup("b");
  assert.strictEqual(cap.caret, 2);
  cap.keydown("Backspace"); cap.keyup("Backspace");
  assert.strictEqual(cap.caret, 1);
  const del = cap.events.find(e => e.kind === "delete");
  assert.strictEqual(del.len_delta, -1);
});

test("paste records length only, never the text", () => {
  const cap = newCapture(scriptedClock([]));
  cap.start();
  cap.paste(42);
  const p = cap.events.find(e => e.kind === "paste");
  assert.strictEqual(p.len_delta, 42);
  assert.strictEqual(p.payload.paste_len, 42);
  assert.strictEqual(p.key_char, null);
  assert.strictEqual(p.input_type, "insertFromPaste");
});

test("captured trace scores through the REAL extractFeatures", async () => {
  // Import the actual server-side extractor — the same module api/certify.mjs
  // uses. If the companion's event shape drifts from what it expects, iki.n or
  // dwell.n go to zero and this fails.
  const { extractFeatures } = await import("../src/telemetry/features.js");

  // ~50 characters of human-ish typing: varied inter-key gaps, varied dwell,
  // plus a correction, driven by an explicit mutable clock.
  let clk = 2_000_000;
  const cap = createCapture({
    userId: "u", docId: "doc-scored", sessionId: "s",
    genId: randomUUID, now: () => clk, hrnow: () => clk,
  });
  cap.start({ platform: "darwin", app: "Microsoft Word" });
  const gaps = [120, 90, 150, 80, 200, 70, 110, 300, 95, 130];
  const phrase = "the quick brown fox jumps over the lazy dog again";
  let gi = 0;
  for (const ch of phrase) {
    clk += gaps[gi++ % gaps.length];       // inter-key gap
    const name = ch === " " ? "Space" : ch;
    cap.keydown(name);
    clk += 55 + (gi % 3) * 15;             // dwell
    cap.keyup(name);
  }
  // a correction
  clk += 180; cap.keydown("Backspace"); clk += 50; cap.keyup("Backspace");
  clk += 140; cap.keydown("x"); clk += 60; cap.keyup("x");
  cap.stop();

  const feats = extractFeatures(cap.events, { words: 10 });
  assert.ok(feats.iki.n > 5, `expected IKI samples, got ${feats.iki.n}`);
  assert.ok(feats.dwell.n > 5, `expected dwell samples, got ${feats.dwell.n}`);
  assert.ok(feats.typed_chars > 40, `expected typed chars, got ${feats.typed_chars}`);
  assert.ok(feats.deletion_events >= 1, "expected the correction to register");
});
