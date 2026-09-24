// Run: npm run build && node --test lib/stamp.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const scoring = require("./scoring.cjs");
const docmeta = require("./docmeta");
const { createStamper } = require("./stamp");

const sha = (x) => crypto.createHash("sha256").update(x, "utf8").digest("hex");
const V1 = "The river ran low that summer, and the stones came up out of the water like the backs of animals. We walked on them to the far bank every evening.";
const V2 = V1 + " Then the rain came back in September and the stones went under again, one by one, until only the largest was left.";

function docx(dir, name, text) {
  const txt = path.join(dir, `${name}.txt`);
  fs.writeFileSync(txt, text);
  const out = path.join(dir, `${name}.docx`);
  execFileSync("/usr/bin/textutil", ["-convert", "docx", txt, "-output", out]);
  fs.rmSync(txt);
  return out;
}

function rig(dir, file, { newFiles = [] } = {}) {
  let t = 1_000_000_000_000;
  let n = 0;
  const stamps = [], certs = [];
  const stamper = createStamper({
    docmeta, scoring, sha, helper: { available: () => false },
    reader: { pidOf: async () => null, readDocumentPath: async () => file },
    getFront: () => ({ bundleId: "com.microsoft.Word", name: "Word" }),
    findSession: () => ({ id: "s1", keystrokes: 900 }),
    certifyText: async ({ text }) => {
      const cert = { code: `INKK-0000-0000-000${++n}`, contentHash: await scoring.textFingerprint(text, sha) };
      certs.push(cert);
      return { ok: true, cert };
    },
    onStamp: (s) => stamps.push(s),
    now: () => t, findNew: async () => newFiles,
  });
  return { stamper, stamps, certs, advance: (ms) => { t += ms; }, at: () => t };
}

// Set a file's modification time to the rig's clock (the stamper compares with it).
const touch = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));

test("saving the document being written certifies it and stamps the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkk-stamp-"));
  const file = docx(dir, "essay", V1);
  const r = rig(dir, file);
  touch(file, r.at() - 60000);
  await r.stamper.tick();                                 // starts following; nothing saved yet
  assert.strictEqual(r.certs.length, 0);

  fs.writeFileSync(file, fs.readFileSync(docx(dir, "tmp1", V1)));   // a save
  touch(file, r.at());
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 0, "still being written");
  r.advance(5000);
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 1);
  assert.strictEqual((await docmeta.readStamp(file)).code, "INKK-0000-0000-0001");

  // Saved again with the same words but the app dropped the stamp: same code back.
  fs.writeFileSync(file, fs.readFileSync(docx(dir, "tmp2", V1)));
  execFileSync("/usr/bin/xattr", ["-c", file]);
  touch(file, r.at());
  r.advance(5000);
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 1);
  assert.strictEqual((await docmeta.readStamp(file)).code, "INKK-0000-0000-0001");

  // New words: a new version, but not before autosave's quiet period is over.
  fs.writeFileSync(file, fs.readFileSync(docx(dir, "tmp3", V2)));
  touch(file, r.at());
  r.advance(5000);
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 1, "held back: certified moments ago");
  r.advance(3 * 60 * 1000);
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 2);
  assert.strictEqual((await docmeta.readStamp(file)).code, "INKK-0000-0000-0002");
});

test("an exported copy of a certified text is stamped with its code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkk-stamp-"));
  const exported = docx(dir, "export", V1);
  const r = rig(dir, null, { newFiles: [exported] });
  touch(exported, r.at() - 10000);
  r.stamper.remember({ code: "INKK-AAAA-BBBB-CCCC", sessionId: "s1", contentHash: await scoring.textFingerprint(V1, sha), sketch: await scoring.textSketch(V1, sha) });
  await r.stamper.tick();
  assert.strictEqual(r.certs.length, 0, "an exact copy needs no new certificate");
  assert.strictEqual((await docmeta.readStamp(exported)).code, "INKK-AAAA-BBBB-CCCC");
});

test("an unrelated new file is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkk-stamp-"));
  const other = docx(dir, "invoice", "Invoice number 42 for services rendered in August, payable within thirty days of receipt. Thank you for your business.");
  const r = rig(dir, null, { newFiles: [other] });
  touch(other, r.at() - 10000);
  r.stamper.remember({ code: "INKK-AAAA-BBBB-CCCC", sessionId: "s1", contentHash: await scoring.textFingerprint(V1, sha), sketch: await scoring.textSketch(V1, sha) });
  await r.stamper.tick();
  assert.strictEqual(await docmeta.readStamp(other), null);
  assert.strictEqual(r.stamps.length, 0);
});
