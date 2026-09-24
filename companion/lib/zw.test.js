// Run: node --test lib/zw.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const zw = require("./zw");
const { makeCode } = require("./codes");

const CODE = "INKK-7F3A-9K2D-XQ4M";

// A byte-at-a-time CRC-8 (poly 0x07, init 0xFF), the textbook way, to check the
// bit-serial one the run uses against.
function crc8Bytes(bytes) {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

test("a run is 76 bits between two non-joiners, only the two joiners, marker first", () => {
  const run = zw.encode(CODE);
  assert.strictEqual(zw.LENGTH, 76);
  assert.strictEqual(run.length, zw.LENGTH + 2);
  assert.match(run, /^[\u200C\u200D]+$/);
  // A non-joiner at each end, so no letter next to the run is shaped by a joiner.
  assert.strictEqual(run[0], "\u200C");
  assert.strictEqual(run[run.length - 1], "\u200C");
  const bits = [...run.slice(1, -1)].map((c) => (c === zw.ONE ? "1" : "0")).join("");
  assert.strictEqual(bits.slice(0, 8), zw.MARKER);
  // 7 = 00111, F = 01111: the code's symbols, 5 bits each, most significant first.
  assert.strictEqual(bits.slice(8, 18), "0011101111");
});

test("a name that joins keeps its last letter's shape", () => {
  // Arabic, Persian and Urdu names end in letters that join to a following
  // joiner: the character right after the name must be a non-joiner, never ZWJ.
  for (const name of ["\u0639\u0644\u064A", "\u0645\u0647\u062F\u06CC", "\u062D\u0633\u06CC\u0646"]) {
    for (let i = 0; i < 50; i++) {
      const code = makeCode();
      const signed = `${name}${zw.encode(code)}`;
      assert.strictEqual(signed[name.length], "\u200C");
      assert.strictEqual(signed[signed.length - 1], "\u200C");
      assert.deepStrictEqual(zw.decodeAll(signed), [code]);
      assert.strictEqual(zw.strip(signed), name);
    }
  }
});

test("the CRC is CRC-8 poly 0x07 init 0xFF over the 60 code bits", () => {
  const { crc8 } = require("./mark");
  // Byte-aligned input: the bit-serial CRC agrees with the byte-wise one.
  const bytes = Buffer.from("123456789", "ascii");
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  assert.strictEqual(crc8(bits), crc8Bytes(bytes));
  const run = zw.encode(CODE);
  const all = [...run.slice(1, -1)].map((c) => (c === zw.ONE ? 1 : 0));
  const crc = parseInt(all.slice(68).join(""), 2);
  assert.strictEqual(crc8(all.slice(8, 68)), crc);
});

test("every code round-trips, after a name and inside prose", () => {
  for (let i = 0; i < 300; i++) {
    const code = makeCode();
    assert.deepStrictEqual(zw.decodeAll(`Ada Writer${zw.encode(code)}`), [code]);
  }
  const text = `Thanks for reading.\n\nBest,\nAda Writer${zw.encode(CODE)}\n\nSent from my Mac`;
  assert.deepStrictEqual(zw.decodeAll(text), [CODE]);
  assert.deepStrictEqual(zw.decodeAll(zw.encode("inkk-7f3a-9k2d-xq4m")), [CODE]);
});

test("several codes are found in order, repeats once", () => {
  const other = "INKK-0000-0000-0000";
  const text = `A${zw.encode(CODE)} B${zw.encode(other)} C${zw.encode(CODE)}`;
  assert.deepStrictEqual(zw.decodeAll(text), [CODE, other]);
  // Two runs back to back, with nothing between them.
  assert.deepStrictEqual(zw.decodeAll(zw.encode(other) + zw.encode(CODE)), [other, CODE]);
});

test("stray zero-width spaces, word joiners and BOMs inside a run are skipped", () => {
  const run = [...zw.encode(CODE)];
  run.splice(40, 0, "\u200B");
  run.splice(10, 0, "\u2060", "\uFEFF");
  assert.deepStrictEqual(zw.decodeAll(`Ada${run.join("")}`), [CODE]);
});

test("a run that is broken, cut short or garbled is ignored, never misread", () => {
  const run = zw.encode(CODE);
  // A visible character inside the run ends it.
  assert.deepStrictEqual(zw.decodeAll(run.slice(0, 30) + "x" + run.slice(30)), []);
  // One bit short: the last CRC bit and the closing non-joiner gone.
  assert.deepStrictEqual(zw.decodeAll(run.slice(0, run.length - 2)), []);
  // Every one of the 76 bits (the non-joiners at the ends carry none).
  for (let i = 1; i < run.length - 1; i++) {
    const flipped = run.slice(0, i) + (run[i] === zw.ONE ? zw.ZERO : zw.ONE) + run.slice(i + 1);
    assert.deepStrictEqual(zw.decodeAll(flipped), [], `bit ${i - 1}`);
  }
  // Losing the non-joiners at the ends loses nothing.
  assert.deepStrictEqual(zw.decodeAll(run.slice(1, -1)), [CODE]);
  // Junk before a run does not hide it.
  assert.deepStrictEqual(zw.decodeAll(zw.ZERO.repeat(5) + zw.ONE.repeat(3) + run), [CODE]);
});

test("ordinary text with joiners has no codes", () => {
  assert.deepStrictEqual(zw.decodeAll(""), []);
  assert.deepStrictEqual(zw.decodeAll(null), []);
  assert.deepStrictEqual(zw.decodeAll("A family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}, and می\u200Cخواهم."), []);
  assert.deepStrictEqual(zw.decodeAll("\u200C\u200D".repeat(200)), []);
});

test("encode refuses what is not a code", () => {
  assert.throws(() => zw.encode("INKK-123"), TypeError);
  assert.throws(() => zw.encode(""), TypeError);
});

test("strip removes every zero-width character and nothing else", () => {
  const s = `Ada Writer${zw.encode(CODE)}\u200B\u2060\uFEFF, é\u00A0ok`;
  assert.strictEqual(zw.strip(s), "Ada Writer, é\u00A0ok");
  assert.strictEqual(zw.strip(null), "");
});
