// Run: node --test lib/pieces.test.js
//
// Pieces against a temp dir with an injected clock and ids. The text functions
// are the ESM source in src/verify/sketch.js (the same code lib/scoring.cjs
// bundles), so these tests follow that file rather than a stale build; one
// test checks the default, bundled path. Every text below is made up.

"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createPieces, overlapMatches, RETENTION_DAYS, RETENTION_MAX, MAX_VERSIONS, MAX_SESSIONS, KEYS_MAX } = require("./pieces");

const DAY = 24 * 60 * 60 * 1000;

let sketch = null;
async function loadSketch() {
  if (!sketch) sketch = await import("../../src/verify/sketch.js");
  return sketch;
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; return t; };
  return fn;
}

function counter(prefix) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const made = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "inkk-pieces-"));
  made.push(d);
  return d;
}
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const SECRET = Buffer.alloc(32, 7);

async function newPieces(opts = {}) {
  const dir = opts.dir || tmpDir();
  const now = opts.now || clock();
  const pieces = createPieces({
    dir, now,
    secret: opts.secret || SECRET,
    genId: opts.genId || counter("piece-"),
    genCode: opts.genCode || counter("INKK-0000-0000-"),
    scoring: await loadSketch(),
    onChange: opts.onChange,
    writeDelayMs: opts.writeDelayMs ?? 60_000,
  });
  return { pieces, dir, now };
}

// Where the writer is. None of these words appear in the texts below, so the
// plaintext check can tell metadata from writing.
const QUILL = { bundleId: "com.example.quill", app: "Quill", docKey: "title:Untitled 3", docLabel: "Untitled 3" };

const P1 = "The lighthouse keeper counted the gulls every morning before breakfast. Some days there were forty, some days only a handful circling the rocks. He wrote the numbers in a green ledger that smelled of salt and pipe smoke.";
const P2 = "In winter the lamp needed trimming twice each night. The stairs were narrow and wound around a cold iron column. By February his knees complained on every single step.";
const P3 = "His sister sent parcels from the mainland whenever the ferry could cross. Usually they held oranges, wool socks and a newspaper three weeks old. He read the crossword first and saved the rest for storms.";
const P4 = "Nobody asked him to tally the gulls. He simply liked knowing that something on the island could be measured. The ledger now fills an entire shelf in the harbour museum.";
const P5 = "Years after he retired, a schoolteacher wrote to ask about the gull numbers. He mailed her photocopies of the whole winter of nineteen seventy-one. Her pupils drew graphs on butcher paper and pinned them along the corridor.";
const ORCHARD = "Marisol planted the plum trees the spring her daughter learned to walk. Twenty years later the orchard sprawls across both hillsides. Each August the neighbours arrive with baskets and ladders. They trade jam recipes and argue gently about pruning. The oldest tree still leans toward the creek, as if listening.";

const join = (...paras) => paras.join("\n\n");
const BASE = join(P1, P2);

test("fingerprint: salted 64-bit keys per sentence, deduplicated, seals and short lines ignored", async () => {
  const { pieces } = await newPieces();
  const keys = pieces.fingerprint(BASE);
  assert.strictEqual(keys.length, 6);
  for (const k of keys) assert.match(k, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(pieces.fingerprint(BASE), keys, "deterministic");
  // Case, punctuation, spacing and a seal after the text do not change them;
  // a short sign-off and a repeated sentence add nothing.
  const dressed = `${BASE.toUpperCase().replace(/\n\n/g, "\n")}\n\nThanks!\n${P1.split(". ")[0]}.\n\ninkk. inkk.site/v/INKK-7F3A-9K2D-XQ4M`;
  assert.deepStrictEqual(pieces.fingerprint(dressed), keys);
  assert.deepStrictEqual(pieces.fingerprint(""), []);
  assert.deepStrictEqual(pieces.fingerprint("Okay. Yes. See you soon!"), []);
  assert.deepStrictEqual(pieces.fingerprint(null), []);
  // Capped like a certificate's sketch.
  const long = Array.from({ length: KEYS_MAX + 50 }, (_, i) => `Entry ${i} in the ledger records a quiet evening.`).join(" ");
  assert.strictEqual(pieces.fingerprint(long).length, KEYS_MAX);
});

test("the overlap rule", () => {
  assert.strictEqual(overlapMatches(2, 4, 4), true);
  assert.strictEqual(overlapMatches(2, 5, 40), false, "two of five is under half");
  assert.strictEqual(overlapMatches(3, 5, 40), true);
  assert.strictEqual(overlapMatches(1, 1, 1), true, "a one-sentence piece, the same sentence");
  assert.strictEqual(overlapMatches(1, 1, 9), false, "one sentence in common is a coincidence");
  assert.strictEqual(overlapMatches(1, 2, 2), false);
});

test("the same text identifies the same piece across sessions", async () => {
  const changes = [];
  const { pieces, now } = await newPieces({ onChange: (w) => changes.push(w) });
  const first = pieces.identify({ ...QUILL, sessionId: "s1", text: BASE, code: "INKK-AAAA-BBBB-CCCC" });
  assert.deepStrictEqual(first, { pieceId: "piece-1", continued: false, via: "new" });
  assert.strictEqual(pieces.get("piece-1").code, "INKK-AAAA-BBBB-CCCC", "a new piece takes its session's code");
  assert.ok(changes.includes("pieces"));

  now.advance(60_000);
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: BASE }), { pieceId: "piece-1", continued: false, via: "text" });

  now.advance(3 * DAY);
  const back = pieces.identify({ ...QUILL, sessionId: "s2", text: BASE, code: "INKK-DDDD-EEEE-FFFF" });
  assert.deepStrictEqual(back, { pieceId: "piece-1", continued: true, via: "text" });
  const p = pieces.get("piece-1");
  assert.deepStrictEqual(p.sessions, ["s1", "s2"]);
  assert.strictEqual(p.code, "INKK-AAAA-BBBB-CCCC", "continuing keeps the piece's code");
  assert.strictEqual(p.lastAt, now());
  assert.strictEqual(pieces.pieceOf("s2").id, "piece-1");
  assert.strictEqual(pieces.pieceOf("s1").id, "piece-1");
  assert.strictEqual(pieces.list().length, 1);
});

test("appending, editing one sentence and reordering paragraphs still match", async () => {
  const variants = {
    appended: join(P1, P2, P3, P4, P5),
    edited: join(P1, P2.replace("twice each night", "three times on stormy nights")),
    reordered: join(P2, P1),
    trimmed: join(P1, P2.split(". ").slice(0, 2).join(". ") + "."),
  };
  for (const [name, text] of Object.entries(variants)) {
    const { pieces } = await newPieces();
    pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
    const r = pieces.identify({ ...QUILL, sessionId: "s2", text });
    assert.deepStrictEqual(r, { pieceId: "piece-1", continued: true, via: "text" }, name);
  }
});

test("a piece follows its text as it evolves", async () => {
  const { pieces, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: join(P1, P2) });
  now.advance(DAY);
  pieces.identify({ ...QUILL, sessionId: "s2", text: join(P1, P2, P3, P4) });
  now.advance(DAY);
  // The opening two paragraphs are gone; what is left only overlaps with the
  // second version, which is the one the piece now remembers.
  const r = pieces.identify({ ...QUILL, sessionId: "s3", text: join(P3, P4, P5) });
  assert.deepStrictEqual(r, { pieceId: "piece-1", continued: true, via: "text" });
  assert.deepStrictEqual(pieces.get("piece-1").keys, pieces.fingerprint(join(P3, P4, P5)));
  assert.deepStrictEqual(pieces.get("piece-1").sessions, ["s1", "s2", "s3"]);
});

test("a different text makes a new piece; one shared sentence does not merge two", async () => {
  const { pieces } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: join(P1, P2) });
  const other = pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD, code: "INKK-1111-2222-3333" });
  assert.deepStrictEqual(other, { pieceId: "piece-2", continued: false, via: "new" });
  assert.strictEqual(pieces.get("piece-2").code, "INKK-1111-2222-3333");

  const borrowed = `${P1.split(". ")[0]}. ${P3}`;   // one sentence of the first piece, then new ones
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s3", text: borrowed }), { pieceId: "piece-3", continued: false, via: "new" });
  assert.strictEqual(pieces.list().length, 3);
});

test("the best overlap wins, then the most recent", async () => {
  const { pieces, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: join(P1, P2) });
  now.advance(1000);
  pieces.identify({ ...QUILL, sessionId: "s2", text: join(P3, P4) });
  now.advance(1000);
  // Six sentences in common with the first, three with the second.
  assert.strictEqual(pieces.identify({ ...QUILL, sessionId: "s3", text: join(P1, P2, P3) }).pieceId, "piece-1");

  // Equal overlap: the piece touched last.
  const { pieces: q, now: qnow } = await newPieces();
  q.identify({ ...QUILL, sessionId: "a", text: join(P1, P3, P5) });
  qnow.advance(1000);
  // Three of nine in common with the first: a piece of its own.
  assert.strictEqual(q.identify({ ...QUILL, sessionId: "b", text: join(P1, P2, P4) }).pieceId, "piece-2");
  qnow.advance(1000);
  assert.strictEqual(q.identify({ ...QUILL, sessionId: "c", text: P1 }).pieceId, "piece-2");
});

test("a one-sentence piece is found by that sentence", async () => {
  const { pieces } = await newPieces();
  const line = "The ferry leaves at half past seven, weather permitting.";
  pieces.identify({ ...QUILL, sessionId: "s1", text: line });
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s2", text: line }), { pieceId: "piece-1", continued: true, via: "text" });
});

test("the same file wins, even with no text and over another piece's text", async () => {
  const { pieces, now } = await newPieces();
  const docPath = "/Volumes/Shared/manuscript.pages";
  const FILE = { bundleId: "com.example.quill", app: "Quill", docKey: `file:${docPath}`, docLabel: "manuscript.pages", docPath };
  pieces.identify({ ...FILE, sessionId: "s1", text: BASE });
  pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD });
  now.advance(10 * DAY);

  assert.deepStrictEqual(pieces.identify({ ...FILE, sessionId: "s3", text: "" }), { pieceId: "piece-1", continued: true, via: "file" });
  assert.deepStrictEqual(pieces.get("piece-1").keys, pieces.fingerprint(BASE), "an empty read keeps the fingerprints");
  assert.strictEqual(pieces.identify({ ...FILE, sessionId: "s4", text: ORCHARD }).pieceId, "piece-1");
  const p = pieces.get("piece-1");
  assert.strictEqual(p.docPath, docPath);
  assert.strictEqual(p.docLabel, "manuscript.pages");

  // A file last seen more than the retention window ago is no longer this piece.
  now.advance((RETENTION_DAYS + 1) * DAY);
  assert.strictEqual(pieces.identify({ docPath, sessionId: "s5", text: "" }), null);
  // A window title is never a path.
  assert.strictEqual(pieces.identify({ docPath: "Untitled 3", sessionId: "s6", text: "" }), null);
});

test("a cleared document keeps its session's piece", async () => {
  const { pieces } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: "" }), { pieceId: "piece-1", continued: false, via: "session" });
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: "Okay." }), { pieceId: "piece-1", continued: false, via: "session" });
  // The fingerprints were not wiped by the empty reads: the text is still known.
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s2", text: BASE }), { pieceId: "piece-1", continued: true, via: "text" });
  // …and nothing to go on, in a session no piece knows, is no piece at all.
  assert.strictEqual(pieces.identify({ ...QUILL, sessionId: "s9", text: "" }), null);
  assert.strictEqual(pieces.identify({ ...QUILL, text: "Hi." }), null);
  assert.strictEqual(pieces.list().length, 1);
});

test("a session that wrote in two pieces belongs to the one it touched last", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  now.advance(1000);
  pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD });
  now.advance(1000);
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: ORCHARD }), { pieceId: "piece-2", continued: true, via: "text" });
  assert.strictEqual(pieces.pieceOf("s1").id, "piece-2");
  assert.deepStrictEqual(pieces.get("piece-1").sessions, ["s1"], "the earlier piece still counts its rhythm");
  pieces.flush();
  const again = createPieces({ dir, now, secret: SECRET, genId: counter("x-"), scoring: await loadSketch() });
  again.load();
  assert.strictEqual(again.pieceOf("s1").id, "piece-2");
  // Forgetting that piece hands the session back to the other one.
  assert.strictEqual(again.remove("piece-2"), true);
  assert.strictEqual(again.pieceOf("s1").id, "piece-1");
  assert.strictEqual(again.pieceOf("s2"), null);
});

test("after a restart a session keeps its piece, whichever piece was touched since", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  now.advance(1000);
  pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD });
  now.advance(1000);
  assert.strictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: ORCHARD }).pieceId, "piece-2");
  now.advance(1000);
  // Another session carries the first text on, so piece-1 is the piece touched
  // last by anyone; s1's piece is still piece-2.
  assert.deepStrictEqual(pieces.identify({ ...QUILL, sessionId: "s3", text: join(P1, P2, P3) }), { pieceId: "piece-1", continued: true, via: "text" });
  assert.deepStrictEqual(pieces.list().map((p) => p.id), ["piece-1", "piece-2"]);
  assert.strictEqual(pieces.pieceOf("s1").id, "piece-2");
  pieces.flush();

  // Times, not text: the index says when each session last wrote in each piece.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "pieces", "index.json"), "utf8"));
  const t0 = 1_700_000_000_000;
  assert.deepStrictEqual(onDisk.map((p) => [p.id, p.touched]), [
    ["piece-1", { s1: t0, s3: t0 + 3000 }],
    ["piece-2", { s2: t0 + 1000, s1: t0 + 2000 }],
  ]);

  const again = createPieces({ dir, now, secret: SECRET, genId: counter("x-"), scoring: await loadSketch() });
  again.load();
  assert.strictEqual(again.pieceOf("s1").id, "piece-2");
  assert.strictEqual(again.pieceOf("s3").id, "piece-1");
  now.advance(1000);
  assert.deepStrictEqual(again.identify({ ...QUILL, sessionId: "s1", text: "" }), { pieceId: "piece-2", continued: true, via: "session" });
});

test("the order holds within one millisecond and with the clock set back", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD });
  // Same millisecond: s1 moves to piece-2, and piece-1 then gets a later lastAt
  // from another session.
  assert.strictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: ORCHARD }).pieceId, "piece-2");
  pieces.attach("piece-1", "s3");
  // The clock goes back a day and s1 is read again with nothing on screen.
  now.advance(-DAY);
  assert.strictEqual(pieces.identify({ ...QUILL, sessionId: "s1", text: "" }).pieceId, "piece-2");
  // s4 moves from piece-2 to piece-1 at the very same (earlier) time.
  pieces.identify({ ...QUILL, sessionId: "s4", text: ORCHARD });
  assert.strictEqual(pieces.attach("piece-1", "s4"), true);
  assert.strictEqual(pieces.pieceOf("s4").id, "piece-1");
  pieces.flush();

  const again = createPieces({ dir, now, secret: SECRET, genId: counter("x-"), scoring: await loadSketch() });
  again.load();
  for (const [s, id] of [["s1", "piece-2"], ["s2", "piece-2"], ["s3", "piece-1"], ["s4", "piece-1"]]) {
    assert.strictEqual(again.pieceOf(s).id, id, s);
    assert.strictEqual(pieces.pieceOf(s).id, id, s);
  }
});

test("a piece keeps at most MAX_SESSIONS sessions, and their times with them", async () => {
  const { pieces, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "a0", text: BASE });
  now.advance(1000);
  pieces.identify({ ...QUILL, sessionId: "other", text: ORCHARD });
  now.advance(1000);
  pieces.attach("piece-2", "a0");      // a0 has written in both; piece-2 last
  now.advance(1000);
  pieces.attach("piece-1", "a0");      // …and now piece-1
  for (let i = 1; i <= MAX_SESSIONS; i++) pieces.attach("piece-1", `a${i}`);
  const p = pieces.get("piece-1");
  assert.strictEqual(p.sessions.length, MAX_SESSIONS);
  assert.strictEqual(p.sessions[0], "a1");
  assert.deepStrictEqual(Object.keys(p.touched).sort(), [...p.sessions].sort());
  // The session trimmed from piece-1 goes back to the other piece it wrote in.
  assert.strictEqual(pieces.pieceOf("a0").id, "piece-2");
});

test("attach, get, list and remove", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  now.advance(1000);
  pieces.identify({ ...QUILL, sessionId: "s2", text: ORCHARD });
  assert.deepStrictEqual(pieces.list().map((p) => p.id), ["piece-2", "piece-1"], "newest first");

  now.advance(1000);
  assert.strictEqual(pieces.attach("piece-1", "s7"), true);
  assert.strictEqual(pieces.pieceOf("s7").id, "piece-1");
  assert.deepStrictEqual(pieces.list().map((p) => p.id), ["piece-1", "piece-2"]);
  assert.strictEqual(pieces.attach("nope", "s7"), false);
  assert.strictEqual(pieces.get("nope"), null);

  // Copies: changing what came back changes nothing inside.
  const copy = pieces.get("piece-1");
  copy.keys.length = 0; copy.sessions.push("zz"); copy.touched.s7 = 0;
  assert.strictEqual(pieces.get("piece-1").keys.length, 6);
  assert.deepStrictEqual(pieces.get("piece-1").sessions, ["s1", "s7"]);
  assert.strictEqual(pieces.get("piece-1").touched.s7, now());

  // Removing is on disk at once, without a flush.
  pieces.flush();
  assert.strictEqual(pieces.remove("piece-1"), true);
  assert.strictEqual(pieces.remove("piece-1"), false);
  assert.strictEqual(pieces.pieceOf("s1"), null);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "pieces", "index.json"), "utf8"));
  assert.deepStrictEqual(onDisk.map((p) => p.id), ["piece-2"]);
});

test("certificates: versions and the next code, as for sessions", async () => {
  const { pieces, dir } = await newPieces({ genCode: counter("INKK-NEW0-0000-") });
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE, code: "INKK-AAAA-0000-0001" });
  assert.strictEqual(pieces.codeFor("piece-1", "h1"), "INKK-AAAA-0000-0001", "uncertified: the piece's own code");

  assert.strictEqual(pieces.setCert("piece-1", { code: "INKK-AAAA-0000-0001", contentHash: "h1", verified: true }), true);
  // Certificates reach disk without waiting for a flush.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "pieces", "index.json"), "utf8"));
  assert.strictEqual(onDisk[0].cert.code, "INKK-AAAA-0000-0001");

  assert.strictEqual(pieces.codeFor("piece-1", "h1"), "INKK-AAAA-0000-0001", "same text, same code");
  const next = pieces.codeFor("piece-1", "h2");
  assert.strictEqual(next, "INKK-NEW0-0000-1", "the text moved on: a new code");
  pieces.setCert("piece-1", { code: next, contentHash: "h2" });
  let p = pieces.get("piece-1");
  assert.strictEqual(p.code, next);
  assert.strictEqual(p.cert.contentHash, "h2");
  assert.deepStrictEqual(p.certs.map((c) => c.code), ["INKK-AAAA-0000-0001"]);
  // Re-affirming the same code does not add a version.
  pieces.setCert("piece-1", { code: next, contentHash: "h2", verified: true });
  assert.strictEqual(pieces.get("piece-1").certs.length, 1);

  for (let i = 0; i < MAX_VERSIONS + 5; i++) pieces.setCert("piece-1", { code: `INKK-VER0-0000-${i}`, contentHash: `v${i}` });
  p = pieces.get("piece-1");
  assert.strictEqual(p.certs.length, MAX_VERSIONS);
  assert.strictEqual(p.certs[0].code, `INKK-VER0-0000-${MAX_VERSIONS + 3}`, "newest first");

  assert.strictEqual(pieces.setCert("nope", { code: "INKK-X" }), false);
  assert.strictEqual(pieces.codeFor("nope", "h1"), null);
});

test("persistence round trip", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE, code: "INKK-AAAA-0000-0001" });
  now.advance(1000);
  pieces.identify({ bundleId: "com.example.pad", app: "Pad", docPath: "/Volumes/Shared/orchard.txt", docKey: "file:/Volumes/Shared/orchard.txt", docLabel: "orchard.txt", sessionId: "s2", text: ORCHARD, code: "INKK-BBBB-0000-0002" });
  pieces.attach("piece-1", "s3");
  pieces.setCert("piece-2", { code: "INKK-BBBB-0000-0002", contentHash: "h" });
  pieces.flush();

  const file = path.join(dir, "pieces", "index.json");
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  const again = createPieces({ dir, now, secret: SECRET, genId: counter("x-"), scoring: await loadSketch() });
  assert.strictEqual(again.load(), 2);
  assert.deepStrictEqual(again.list(), pieces.list());
  assert.strictEqual(again.pieceOf("s3").id, "piece-1");
  now.advance(DAY);
  assert.deepStrictEqual(again.identify({ ...QUILL, sessionId: "s4", text: join(P2, P1) }), { pieceId: "piece-1", continued: true, via: "text" });
  assert.strictEqual(again.identify({ docPath: "/Volumes/Shared/orchard.txt", sessionId: "s5", text: "" }).pieceId, "piece-2");
});

test("routine updates are written a moment later, or on flush", async () => {
  const { pieces, dir } = await newPieces({ writeDelayMs: 20 });
  const file = path.join(dir, "pieces", "index.json");
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  assert.strictEqual(fs.existsSync(file), false);
  for (let waited = 0; !fs.existsSync(file) && waited < 2000; waited += 10) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);

  const { pieces: q, dir: qdir } = await newPieces();
  q.identify({ ...QUILL, sessionId: "s1", text: BASE });
  q.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(qdir, "pieces", "index.json"), "utf8")).length, 1);
});

test("no text on disk: the index holds fingerprints, never words", async () => {
  const { pieces, dir, now } = await newPieces();
  const texts = [BASE, join(P1, P2, P3, P4, P5), ORCHARD, join(P3, P1)];
  texts.forEach((text, i) => { now.advance(1000); pieces.identify({ ...QUILL, sessionId: `s${i}`, text }); });
  pieces.setCert("piece-1", { code: "INKK-AAAA-0000-0001", contentHash: "0".repeat(64), verified: true, wordCount: 120 });
  pieces.flush();

  const raw = fs.readFileSync(path.join(dir, "pieces", "index.json"), "utf8");
  // Every word of four letters or more (skipping ones spelt only with a–f,
  // which hex could contain by chance) must be absent as a word.
  const words = new Set(texts.join(" ").toLowerCase().match(/\p{L}{4,}/gu).filter((w) => /[g-z]/.test(w)));
  assert.ok(words.size > 100);
  for (const w of words) assert.doesNotMatch(raw, new RegExp(`\\b${w}\\b`, "i"), `"${w}" is on disk`);
  // …and so is every sentence key, the form the text takes just before it is hashed.
  const { sentences, canonicalText, sentenceKey } = await loadSketch();
  for (const s of sentences(canonicalText(texts.join(" ")))) assert.ok(!raw.includes(sentenceKey(s)));
  for (const p of JSON.parse(raw)) for (const k of p.keys) assert.match(k, /^[0-9a-f]{16}$/);
});

test("a different secret never matches: the fingerprints are salted", async () => {
  const { pieces, dir, now } = await newPieces();
  pieces.identify({ ...QUILL, sessionId: "s1", text: BASE });
  pieces.flush();

  const other = createPieces({ dir, now, secret: randomBytes(32), genId: counter("other-"), scoring: await loadSketch() });
  other.load();
  const mine = new Set(pieces.fingerprint(BASE));
  assert.strictEqual(other.fingerprint(BASE).filter((k) => mine.has(k)).length, 0);
  assert.deepStrictEqual(other.identify({ ...QUILL, sessionId: "s2", text: BASE }), { pieceId: "other-1", continued: false, via: "new" });
});

test("prune: 60 days untouched, at most 400, certified pieces keep their place", async () => {
  const { pieces, now } = await newPieces();
  const n = RETENTION_MAX + 5;
  const write = (i) => {
    now.advance(1000);
    const r = pieces.identify({ ...QUILL, sessionId: `s${i}`, text: `Ledger entry number ${i} records a quiet evening by the stove.` });
    assert.strictEqual(r.pieceId, `piece-${i + 1}`);
  };
  // The two oldest pieces are certified; then the rest are written.
  write(0); write(1);
  pieces.setCert("piece-1", { code: "INKK-C1" });
  pieces.setCert("piece-2", { code: "INKK-C2" });
  for (let i = 2; i < n; i++) write(i);

  // Everything is inside the window: the cap keeps the certified pair and the
  // 398 newest of the rest.
  const removed = pieces.prune(now());
  assert.strictEqual(pieces.size, RETENTION_MAX);
  assert.deepStrictEqual(removed.sort(), ["piece-3", "piece-4", "piece-5", "piece-6", "piece-7"]);
  assert.ok(pieces.get("piece-1") && pieces.get("piece-2"));
  assert.strictEqual(pieces.pieceOf("s3"), null, "a dropped piece lets go of its sessions");

  // 61 days on, only what was touched in the window stays, certified or not.
  now.advance(59 * DAY);
  pieces.identify({ ...QUILL, sessionId: "s100", text: "" });   // touches piece-101 through its session
  now.advance(2 * DAY);
  pieces.prune(now());
  assert.deepStrictEqual(pieces.list().map((p) => p.id), ["piece-101"]);
});

test("load: a torn index is set aside, not trusted", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "pieces"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pieces", "index.json"), "[{\"id\":\"piece-1\",\"keys\":[\"ab");
  const { pieces } = await newPieces({ dir });
  assert.strictEqual(pieces.load(), 0);
  assert.ok(fs.readdirSync(path.join(dir, "pieces")).some((f) => f.startsWith("index.json.corrupt-")));

  // Malformed entries are cleaned, not taken as they are.
  fs.writeFileSync(path.join(dir, "pieces", "index.json"), JSON.stringify([
    {
      id: "ok", code: "INKK-OK", keys: ["0123456789abcdef", "not a key", "0123456789abcdef"], sessions: ["s1", 5, "s2", "__proto__"],
      touched: { s1: "soon", s2: 1_699_999_999_000, gone: 9 }, createdAt: 1_700_000_000_000, lastAt: 1_700_000_000_000,
    },
    { keys: [] },
    "nonsense",
  ]));
  const { pieces: q } = await newPieces({ dir });
  assert.strictEqual(q.load(), 1);
  const p = q.get("ok");
  assert.deepStrictEqual(p.keys, ["0123456789abcdef"]);
  assert.deepStrictEqual(p.sessions, ["s1", "s2", "__proto__"]);
  assert.deepStrictEqual(p.certs, []);
  // A time for each listed session and nothing else; a missing or unusable
  // one is the piece's lastAt. No session id reaches Object.prototype.
  assert.deepStrictEqual(Object.entries(p.touched), [["s1", 1_700_000_000_000], ["s2", 1_699_999_999_000], ["__proto__", 1_700_000_000_000]]);
  assert.strictEqual(Object.getPrototypeOf(p.touched), null);
  assert.strictEqual(q.pieceOf("s1").id, "ok");
  assert.strictEqual(q.pieceOf("__proto__").id, "ok");
  assert.strictEqual({}.s1, undefined);
});

test("arguments: a secret is required, and the bundled text functions are the default", async () => {
  await assert.rejects(async () => createPieces({ dir: tmpDir(), scoring: await loadSketch() }), /secret/);
  await assert.rejects(async () => createPieces({ dir: tmpDir(), secret: Buffer.alloc(8), scoring: await loadSketch() }), /secret/);
  assert.throws(() => createPieces({ secret: SECRET }), /dir/);

  const bundled = path.join(__dirname, "scoring.cjs");
  if (!fs.existsSync(bundled)) return;   // a checkout that has not run build.js yet
  const viaDefault = createPieces({ dir: tmpDir(), secret: SECRET });
  const { pieces } = await newPieces();
  assert.deepStrictEqual(viaDefault.fingerprint(join(P1, P2, P3)), pieces.fingerprint(join(P1, P2, P3)));
});
