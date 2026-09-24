// Run: npm run build && node --test lib/receiver.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const scoring = require("./scoring.cjs");
const { createReceiver } = require("./receiver");

const sha = (x) => crypto.createHash("sha256").update(x, "utf8").digest("hex");
const PIECE = "The river ran low that summer, and the stones came up out of the water like the backs of animals. We walked on them to the far bank every evening until the rain came back in September.";
const CODE = "INKK-4B7N-R2XE-8KMT";

async function certFor(text, extra = {}) {
  return {
    code: CODE, verified: true, score_tier: "Strong", author_name: "Ada Writer",
    content_hash: await scoring.textFingerprint(text, sha), text_sketch: await scoring.textSketch(text, sha), ...extra,
  };
}

function rig({ win, doc = null, cert, pictures = false, marks = [] }) {
  const seals = [];
  let t = 0;
  const helper = {
    available: () => true,
    frontWindow: async () => ({ id: 7, pid: 1, bundleId: "com.apple.mail", owner: "Mail", title: "Re: the river" }),
    captureWindow: async () => "/tmp/x.png", loadImage: () => ({ width: 1, height: 1, data: Buffer.alloc(4), format: "bgra" }),
    ocr: async () => [], discard: () => {},
  };
  const reader = {
    readWindow: async () => ({ title: "Re: the river", document: "", text: "", links: [], images: [], ...win }),
    readDocumentPath: async () => (doc ? doc.path : null),
  };
  const docmeta = {
    readStamp: async (p) => (doc && p === doc.path ? { code: CODE, via: "docx" } : null),
    extractText: async () => (doc ? doc.text : null),
  };
  const lookup = { get: async (code) => (code === CODE ? cert : null) };
  const mark = { decodeMarks: () => marks };
  const r = createReceiver({
    helper, reader, docmeta, mark, lookup, scoring, sha, now: () => t,
    ownBundleId: "site.inkk.companion", canReadPictures: () => pictures, onSeal: (s) => seals.push(s),
  });
  return { r, seals };
}

test("a code in an email is found and the email's text is checked against it", async () => {
  const cert = await certFor(PIECE);
  const { r, seals } = rig({ cert, win: { text: `From: Ada\nTo: me\nSubject: the river\n\n${PIECE}\n\nAda\ninkk. inkk.site/v/${CODE}\n\nInbox\nOther message preview` } });
  await r.tick({ force: true });
  assert.strictEqual(seals.length, 1);
  assert.strictEqual(seals[0].code, CODE);
  assert.strictEqual(seals[0].source, "text");
  assert.strictEqual(seals[0].match.state, "match");
  assert.strictEqual(seals[0].cert.author_name, "Ada Writer");
});

test("a signed name: the seal link behind the picture is enough, no screen reading", async () => {
  const cert = await certFor(PIECE);
  const { r, seals } = rig({ cert, win: { text: PIECE, links: [`https://www.inkk.site/v/${CODE}`], images: ["Ada Writer"] } });
  await r.tick({ force: true });
  assert.strictEqual(seals[0].source, "link");
  assert.strictEqual(seals[0].match.state, "match");
});

test("an edited email reads as changed", async () => {
  const cert = await certFor(PIECE);
  const { r, seals } = rig({ cert, win: { text: `Something else entirely was written here instead of the piece. inkk.site/v/${CODE}` } });
  await r.tick({ force: true });
  assert.strictEqual(seals[0].match.state, "differs");
});

test("a document's code comes from its metadata and its own text is compared", async () => {
  const cert = await certFor(PIECE);
  const { r, seals } = rig({ cert, win: { text: "Toolbar Page 1 of 1 Word count" }, doc: { path: "/Users/x/essay.docx", text: PIECE } });
  await r.tick({ force: true });
  assert.strictEqual(seals[0].source, "file");
  assert.strictEqual(seals[0].path, "/Users/x/essay.docx");
  assert.strictEqual(seals[0].match.state, "match");
});

test("pictures are read only when that is switched on", async () => {
  const cert = await certFor(PIECE);
  const off = rig({ cert, win: { text: PIECE }, marks: [{ code: CODE, confidence: 1 }] });
  await off.r.tick({ force: true });
  assert.deepStrictEqual(off.seals, [], "nothing without the switch (and nothing to clear)");
  const on = rig({ cert, win: { text: PIECE }, pictures: true, marks: [{ code: CODE, confidence: 1 }] });
  await on.r.tick({ force: true });
  assert.strictEqual(on.seals[0].source, "mark");
  assert.strictEqual(on.seals[0].match.state, "match");
});

test("an unknown code is shown as not in the ledger; the popover in front keeps the last seal", async () => {
  const { r, seals } = rig({ cert: null, win: { text: `code ${CODE}` } });
  await r.tick({ force: true });
  assert.strictEqual(seals[0].cert, null);
  assert.strictEqual(seals[0].offline, false);
});
