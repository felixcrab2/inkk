// Run: node --test lib/codes.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { makeCode, hashText, sessionHash, findCodes, ALPHABET } = require("./codes");

test("codes have the website's shape and alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.match(c, /^INKK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    for (const ch of c.replace(/INKK-|-/g, "")) assert.ok(ALPHABET.includes(ch));
  }
  assert.notStrictEqual(makeCode(), makeCode());
});

test("fingerprints are stable and session hashes are distinct from text hashes", () => {
  assert.strictEqual(hashText("the same words"), hashText("the same words"));
  assert.notStrictEqual(hashText("the same words"), hashText("the same words."));
  assert.notStrictEqual(sessionHash("abc"), hashText("abc"));
  assert.match(sessionHash("abc"), /^[0-9a-f]{64}$/);
});

test("codes are found in prose, links and with typing slips, and deduplicated", () => {
  const text = `Thanks for reading.\n\ninkk. INKK-7F3A-9K2D-XQ4M · inkk.site/v/INKK-7F3A-9K2D-XQ4M\n` +
    `Another one: inkk-7f3a 9k2d xq4m and a slip: INKK-OF3A-9K2D-XQ4M. Not a code: INKK-ZZ.`;
  const found = findCodes(text);
  assert.deepStrictEqual(found, ["INKK-7F3A-9K2D-XQ4M", "INKK-0F3A-9K2D-XQ4M"]);
  assert.deepStrictEqual(findCodes(""), []);
  assert.deepStrictEqual(findCodes("nothing here"), []);
});
