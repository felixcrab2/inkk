// Run: node --test lib/sessions.test.js
//
// Exercises the session store against a temp dir with an injected clock, so
// the 8-minute idle rule, the 2s/1s persistence timers and retention are all
// deterministic. Scoring is the REAL src/telemetry pair (not the bundled
// scoring.cjs), so this also proves the live score works on companion traces.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createStore, IDLE_MS, RETENTION_MAX, MIN_KEEP_KEYSTROKES } = require("./sessions");

let scoring = null;
async function loadScoring() {
  if (scoring) return scoring;
  const [{ extractFeatures }, { computeScore }] = await Promise.all([
    import("../../src/telemetry/features.js"),
    import("../../src/telemetry/score.js"),
  ]);
  scoring = { extractFeatures, computeScore };
  return scoring;
}

// A settable clock: tests advance it explicitly.
function clock(start = 1_700_000_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; return t; };
  fn.set = (ms) => { t = ms; };
  return fn;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inkk-sessions-"));
}

async function newStore(opts = {}) {
  const dir = opts.dir || tmpDir();
  const now = opts.now || clock();
  const store = createStore({ dir, now, genId: randomUUID, scoring: await loadScoring(), onChange: opts.onChange });
  return { store, dir, now };
}

const NOTES = { bundleId: "com.apple.Notes", app: "Notes" };
// Enough real typing for a session to survive close() (short bursts are dropped).
const KEEP = "a".repeat(MIN_KEEP_KEYSTROKES + 5);
function typeKeep(store, ctx) {
  for (const ch of KEEP) { store.keyEvent({ ...ctx, type: "keydown", name: ch }); store.keyEvent({ ...ctx, type: "keyup", name: ch }); }
}
const MAIL = { bundleId: "com.apple.mail", app: "Mail" };

// Human-ish typing: varied inter-key gaps and dwell, a space every few letters.
function typePhrase(store, now, ctx, phrase, gaps = [120, 90, 150, 80, 200, 70, 110, 300, 95, 130]) {
  let gi = 0;
  for (const ch of phrase) {
    now.advance(gaps[gi++ % gaps.length]);
    const name = ch === " " ? "Space" : ch;
    store.keyEvent({ ...ctx, type: "keydown", name, mods: "" });
    now.advance(55 + (gi % 3) * 15);
    store.keyEvent({ ...ctx, type: "keyup", name });
  }
}

test("first keystroke opens a session per app; apps run concurrently", async () => {
  const { store, now } = await newStore();
  store.keyEvent({ ...NOTES, type: "keydown", name: "h" });
  store.keyEvent({ ...NOTES, type: "keyup", name: "h" });
  now.advance(500);
  store.keyEvent({ ...MAIL, type: "keydown", name: "y" });
  store.keyEvent({ ...MAIL, type: "keyup", name: "y" });
  assert.strictEqual(store.openCount, 2);
  const list = store.list();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].app, "Mail", "newest first by lastKeyAt");
  assert.strictEqual(store.active().app, "Mail");
  // more typing in Notes routes to the SAME Notes session
  now.advance(500);
  store.keyEvent({ ...NOTES, type: "keydown", name: "i" });
  assert.strictEqual(store.list().length, 2);
  assert.strictEqual(store.active().app, "Notes");
  assert.strictEqual(store.list().find(s => s.app === "Notes").keystrokes, 2);
});

test("keystroke, deletion and paste counts follow the trace", async () => {
  const { store } = await newStore();
  for (const ch of "abc") { store.keyEvent({ ...NOTES, type: "keydown", name: ch }); store.keyEvent({ ...NOTES, type: "keyup", name: ch }); }
  store.keyEvent({ ...NOTES, type: "keydown", name: "Backspace" }); store.keyEvent({ ...NOTES, type: "keyup", name: "Backspace" });
  store.keyEvent({ ...NOTES, type: "keydown", name: "v", mods: "M" }); store.keyEvent({ ...NOTES, type: "paste", len: 42 }); store.keyEvent({ ...NOTES, type: "keyup", name: "v" });
  const s = store.active();
  assert.strictEqual(s.keystrokes, 4, "3 inputs + 1 delete");
  assert.strictEqual(s.deletions, 1);
  assert.strictEqual(s.pastes, 1);
  const kinds = store.eventsOf(s.id).map(e => e.kind);
  assert.ok(kinds.includes("session_start") && kinds.includes("paste"));
  assert.ok(store.eventsOf(s.id).every(e => e.key_char === null && e.user_id === null), "content-free, no user");
});

test("a live score appears after enough human-like typing", async () => {
  const { store, now } = await newStore();
  typePhrase(store, now, NOTES, "the quick brown fox jumps over the lazy dog again and again");
  now.advance(180); store.keyEvent({ ...NOTES, type: "keydown", name: "Backspace" }); now.advance(50); store.keyEvent({ ...NOTES, type: "keyup", name: "Backspace" });
  now.advance(2000);
  store.tick();                       // final recompute once the 1.5s window has passed
  const s = store.active();
  assert.ok(s.score, "expected a score object");
  assert.ok(["Faint", "Developing", "Strong", "Distinct"].includes(s.score.tier));
  assert.ok(Number.isFinite(s.score.score) && s.score.score >= 0 && s.score.score <= 100);
  assert.ok(Array.isArray(s.score.contributors) && s.score.contributors.length > 0);
  assert.ok(s.wordsEst >= 12, `words estimated from spaces, got ${s.wordsEst}`);
  assert.ok(s.activeMs > 0);
  const detail = store.get(s.id);
  assert.ok(detail.full && Array.isArray(detail.full.velocity_series), "detail carries the full score");
});

test("a session closes after 8 idle minutes and ends at its last key", async () => {
  const { store, now } = await newStore();
  typeKeep(store, NOTES);
  const lastKey = now();
  now.advance(IDLE_MS - 1000);
  assert.deepStrictEqual(store.closeIdle(), [], "not yet idle");
  now.advance(2000);
  const closed = store.closeIdle();
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(store.openCount, 0);
  assert.strictEqual(store.active(), null);
  const s = store.list()[0];
  assert.strictEqual(s.endedAt, lastKey);
  assert.strictEqual(store.eventsOf(s.id).at(-1).kind, "session_end");
  // the next keystroke in that app is a NEW session
  store.keyEvent({ ...NOTES, type: "keydown", name: "b" });
  assert.strictEqual(store.list().length, 2);
});

test("explicit end, delete, and certificate", async () => {
  const { store, dir } = await newStore();
  typeKeep(store, NOTES);
  const id = store.active().id;
  store.end();                        // defaults to the active session
  assert.strictEqual(store.openCount, 0);
  const cert = { code: "INKK-AAAA-BBBB-CCCC", verified: true, tier: "Strong", score: 71, issuedAt: 1, title: null, wordCount: 3, contentHash: "x" };
  assert.ok(store.setCert(id, cert));
  assert.deepStrictEqual(store.get(id).cert, cert);
  assert.ok(fs.existsSync(path.join(dir, "sessions", "certs", `${id}.json`)));
  assert.ok(store.delete(id));
  assert.strictEqual(store.get(id), null);
  assert.ok(!fs.existsSync(path.join(dir, "sessions", "certs", `${id}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, "sessions", "events", `${id}.jsonl`)));
});

test("persistence round-trips through a temp dir", async () => {
  const dir = tmpDir();
  const now = clock();
  const a = await newStore({ dir, now });
  typePhrase(a.store, now, NOTES, "words on a page and then a good deal more of them");
  now.advance(2100);
  a.store.tick();                     // 2s append + 1s index debounce have elapsed
  const id = a.store.active().id;
  assert.ok(fs.existsSync(path.join(dir, "sessions", "index.json")), "index written on tick");
  assert.ok(fs.existsSync(path.join(dir, "sessions", "events", `${id}.jsonl`)), "events appended on tick");
  a.store.closeAll();                 // what quit does
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "sessions", "index.json"), "utf8"))[0].endedAt !== null, true);

  // a fresh process
  const b = await newStore({ dir, now });
  b.store.load();
  const s = b.store.list();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].id, id);
  assert.strictEqual(s[0].keystrokes, "words on a page and then a good deal more of them".length);
  const events = b.store.eventsOf(id);
  assert.strictEqual(events[0].kind, "session_start");
  assert.strictEqual(events.at(-1).kind, "session_end");
  assert.ok(b.store.get(id).full, "full score recomputed from the jsonl");
});

test("a session left open by a crash is closed on load", async () => {
  const dir = tmpDir();
  const now = clock();
  const a = await newStore({ dir, now });
  typeKeep(a.store, NOTES);
  now.advance(1100);
  a.store.tick();                     // index written with endedAt null, then the "process dies"
  const b = await newStore({ dir, now });
  b.store.load();
  assert.strictEqual(b.store.list().length, 1);
  assert.strictEqual(b.store.list()[0].endedAt, b.store.list()[0].lastKeyAt);
  // …whereas a crash after three keys leaves nothing behind
  const dir2 = tmpDir();
  const c = await newStore({ dir: dir2, now });
  for (const ch of "saf") c.store.keyEvent({ ...NOTES, type: "keydown", name: ch });
  now.advance(1100);
  c.store.tick();
  const d = await newStore({ dir: dir2, now });
  d.store.load();
  assert.strictEqual(d.store.list().length, 0);
});

test("retention prunes beyond 60 days and beyond 400 sessions", async () => {
  const dir = tmpDir();
  const now = clock();
  const day = 24 * 60 * 60 * 1000;
  const { store } = await newStore({ dir, now });
  // one stale session, then more than RETENTION_MAX fresh ones
  now.set(1_700_000_000_000 - 61 * day);
  typeKeep(store, NOTES);
  const staleId = store.active().id;
  store.end();
  now.set(1_700_000_000_000);
  for (let i = 0; i < RETENTION_MAX + 5; i++) {
    now.advance(1000);
    typeKeep(store, { bundleId: `app.${i}`, app: `App ${i}` });
    store.end();
  }
  store.flush();
  assert.ok(fs.existsSync(path.join(dir, "sessions", "events", `${staleId}.jsonl`)));
  const removed = store.prune();
  assert.ok(removed.includes(staleId), "stale session pruned");
  assert.strictEqual(removed.length, 6, "stale + 5 over the cap");
  assert.strictEqual(store.list().length, RETENTION_MAX);
  assert.ok(!fs.existsSync(path.join(dir, "sessions", "events", `${staleId}.jsonl`)), "its events are gone too");
});

test("only a text key opens a session; chords, arrows and keyups never do", async () => {
  const { store } = await newStore();
  store.keyEvent({ ...NOTES, type: "keyup", name: "a" });                       // stray keyup (Cmd-Tab release)
  store.keyEvent({ ...NOTES, type: "keydown", name: "ArrowDown" });
  store.keyEvent({ ...NOTES, type: "keydown", name: "Escape" });
  store.keyEvent({ ...NOTES, type: "keydown", name: "c", mods: "M" });          // ⌘C
  store.keyEvent({ ...NOTES, type: "keydown", name: "Tab", mods: "M" });        // ⌘Tab
  assert.strictEqual(store.openCount, 0, "nothing opened");
  store.keyEvent({ ...NOTES, type: "keydown", name: "e", mods: "A" });          // Option+e is typing (accents, em dash)
  assert.strictEqual(store.openCount, 1);
  assert.strictEqual(store.active().keystrokes, 1);
});

test("a short burst is dropped on close, a certified one is kept", async () => {
  const { store, dir } = await newStore();
  for (const ch of "saf") { store.keyEvent({ ...NOTES, type: "keydown", name: ch }); store.keyEvent({ ...NOTES, type: "keyup", name: ch }); }
  const id = store.active().id;
  store.flush();
  assert.ok(fs.existsSync(path.join(dir, "sessions", "events", `${id}.jsonl`)));
  store.end();
  assert.strictEqual(store.list().length, 0, "three keys in Spotlight is not a session");
  assert.ok(!fs.existsSync(path.join(dir, "sessions", "events", `${id}.jsonl`)), "its file is gone");
  // but a certified short session survives
  for (const ch of "hi") store.keyEvent({ ...MAIL, type: "keydown", name: ch });
  const id2 = store.active().id;
  store.setCert(id2, { code: "INKK-AAAA-BBBB-CCCC", verified: false, tier: "Faint", score: 3, issuedAt: 1, title: null, wordCount: 1, contentHash: "x" });
  store.end();
  assert.strictEqual(store.list().length, 1);
});

test("a key after a long sleep starts a fresh session instead of stretching the old one", async () => {
  const { store, now } = await newStore();
  typeKeep(store, NOTES);
  const first = store.active().id;
  const lastKey = now();
  now.advance(10 * 60 * 60 * 1000);   // lid closed overnight: no idle timer ran
  store.keyEvent({ ...NOTES, type: "keydown", name: "m" });
  assert.notStrictEqual(store.active().id, first);
  assert.strictEqual(store.get(first).endedAt, lastKey, "old session ended at its last key");
});

test("per-event timestamps are honoured and the live ring keeps the newest events", async () => {
  const { store, now } = await newStore();
  store.keyEvent({ ...NOTES, type: "keydown", name: "a", at: { t: 12345, pt: 7.5 } });
  const e = store.eventsOf(store.active().id).find(x => x.kind === "keydown");
  assert.strictEqual(e.t, 12345);
  assert.strictEqual(e.pt, 7.5);
  now.advance(10);
  assert.ok(store.eventsOf(store.active().id).length <= 60000);
});

test("a corrupt index is set aside and sessions are rebuilt from their event files", async () => {
  const dir = tmpDir();
  const now = clock();
  const a = await newStore({ dir, now });
  typeKeep(a.store, NOTES);
  const id = a.store.active().id;
  a.store.closeAll();
  fs.writeFileSync(path.join(dir, "sessions", "index.json"), "{ not json");
  const b = await newStore({ dir, now });
  b.store.load();
  const s = b.store.list();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].id, id);
  assert.strictEqual(s[0].app, "Notes");
  assert.strictEqual(s[0].keystrokes, KEEP.length);
  assert.ok(fs.readdirSync(path.join(dir, "sessions")).some(n => n.startsWith("index.json.corrupt-")));
});

test("certifying again after writing on issues a new code and keeps the earlier certificate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkk-sess-ver-"));
  let n = 0, c = 0;
  const store = createStore({ dir, genId: () => `id-${++n}`, genCode: () => `INKK-0000-0000-${String(++c).padStart(4, "0")}` });
  const id = store.openFor("com.apple.TextEdit", "TextEdit");
  const first = store.get(id).code;
  assert.strictEqual(store.codeFor(id, "h1"), first, "the session's own code until certified");
  store.setCert(id, { code: first, contentHash: "h1" });
  assert.strictEqual(store.codeFor(id, "h1"), first, "same text, same certificate");
  const next = store.codeFor(id, "h2");
  assert.notStrictEqual(next, first, "new text, new code");
  store.setCert(id, { code: next, contentHash: "h2" });
  const s = store.get(id);
  assert.strictEqual(s.code, next);
  assert.deepStrictEqual(s.certs.map(c => c.code), [first]);
});

// ── documents and pieces ─────────────────────────────────────────────────────
// Two made-up documents open side by side in one app, as lib/context.js names them.
const PAGES = { bundleId: "com.apple.iWork.Pages", app: "Pages" };
const LETTER = { ...PAGES, docKey: "file:/Users/someone/Letter to Ada.pages", docLabel: "Letter to Ada.pages" };
const REPORT = { ...PAGES, docKey: "file:/Users/someone/Quarterly report.pages", docLabel: "Quarterly report.pages" };
const idOf = (store, doc) => store.list().find(s => s.docKey === doc.docKey && s.endedAt == null).id;

test("each document in one app gets its own session and keys follow the document in front", async () => {
  const { store, now, dir } = await newStore();
  typeKeep(store, LETTER);
  now.advance(1000);
  typeKeep(store, REPORT);
  assert.strictEqual(store.openCount, 2);
  const [report, letter] = store.list();
  assert.strictEqual(report.docKey, REPORT.docKey);
  assert.strictEqual(report.docLabel, "Quarterly report.pages");
  assert.strictEqual(letter.docKey, LETTER.docKey);
  assert.strictEqual(letter.docLabel, "Letter to Ada.pages");
  assert.strictEqual(letter.pieceId, null, "no piece until one is linked");
  assert.strictEqual(store.active().id, report.id);
  // back in the letter: the letter's own session, not the app's latest
  now.advance(1000);
  store.keyEvent({ ...LETTER, type: "keydown", name: "x" });
  assert.strictEqual(store.active().id, letter.id);
  assert.strictEqual(store.get(letter.id).keystrokes, KEEP.length + 1);
  assert.strictEqual(store.get(report.id).keystrokes, KEEP.length);
  // the document's name lives on the summary only: the trace that goes to
  // inkk.site at certify time never carries it
  store.flush();
  for (const id of [letter.id, report.id]) {
    const trace = fs.readFileSync(path.join(dir, "sessions", "events", `${id}.jsonl`), "utf8");
    assert.ok(!/Ada|Quarterly|someone/.test(trace), "no document name in the events");
  }
});

test("an unknown document continues the app's current session instead of splitting it", async () => {
  const { store, now } = await newStore();
  typeKeep(store, LETTER);
  const letter = store.active().id;
  now.advance(500);
  // the helper misses a read for a moment: the keys are still the letter's
  store.keyEvent({ ...PAGES, docKey: "", docLabel: "Pages", type: "keydown", name: "y" });
  store.keyEvent({ ...PAGES, type: "keyup", name: "y" });
  assert.strictEqual(store.openCount, 1);
  assert.strictEqual(store.active().id, letter);
  assert.strictEqual(store.get(letter).keystrokes, KEEP.length + 1);
  assert.strictEqual(store.get(letter).docLabel, "Letter to Ada.pages", "an unknown document never renames a known one");
  // with two documents open it continues the one typed in last
  now.advance(500);
  typeKeep(store, REPORT);
  const report = store.active().id;
  now.advance(500);
  store.keyEvent({ ...PAGES, type: "keydown", name: "z" });
  assert.strictEqual(store.active().id, report);
  assert.strictEqual(store.openCount, 2);
  // callers that pass only the bundle id get that same session, as before
  assert.strictEqual(store.openFor(PAGES.bundleId, "Pages"), report);
  assert.strictEqual(store.sessionFor(PAGES.bundleId).id, report);
  assert.strictEqual(store.sessionFor(PAGES.bundleId, LETTER.docKey).id, letter);
  assert.strictEqual(store.sessionFor(PAGES.bundleId, "file:/Users/someone/Elsewhere.pages"), null, "a third document would start its own");
  assert.strictEqual(store.sessionFor("com.apple.Notes"), null);
  // openFor also takes the document, as an object or a bare key
  const untitled = store.openFor("com.apple.TextEdit", "TextEdit", "title:Untitled");
  assert.strictEqual(store.get(untitled).docKey, "title:Untitled");
  assert.strictEqual(store.openFor("com.apple.TextEdit", "TextEdit", { docKey: "title:Untitled", docLabel: "Untitled" }), untitled);
  assert.strictEqual(store.get(untitled).docLabel, "Untitled");
});

test("keys typed before the document is known belong to that document", async () => {
  const { store, now } = await newStore();
  for (const ch of "Dear") { store.keyEvent({ ...PAGES, type: "keydown", name: ch }); store.keyEvent({ ...PAGES, type: "keyup", name: ch }); }
  const first = store.active().id;
  assert.strictEqual(store.get(first).docKey, "");
  now.advance(300);
  typeKeep(store, LETTER);             // the helper has named the window now
  assert.strictEqual(store.openCount, 1);
  assert.strictEqual(store.active().id, first);
  assert.strictEqual(store.get(first).docKey, LETTER.docKey);
  assert.strictEqual(store.get(first).docLabel, "Letter to Ada.pages");
  assert.strictEqual(store.get(first).keystrokes, 4 + KEEP.length);
  // from then on the letter is a document like any other
  now.advance(300);
  typeKeep(store, REPORT);
  assert.strictEqual(store.openCount, 2);
  assert.notStrictEqual(store.active().id, first);
});

test("the idle and day-change rules close each document's session on its own", async () => {
  const { store, now } = await newStore();
  typeKeep(store, LETTER);
  const letter = store.active().id;
  const letterLast = now();
  now.advance(IDLE_MS - 60_000);
  typeKeep(store, REPORT);             // still writing, in the report
  const report = store.active().id;
  now.advance(120_000);
  assert.deepStrictEqual(store.closeIdle(), [letter], "the letter went quiet, the report did not");
  assert.strictEqual(store.get(letter).endedAt, letterLast);
  assert.strictEqual(store.get(report).endedAt, null);
  // back to the letter after the break: a fresh sitting of the letter
  store.keyEvent({ ...LETTER, type: "keydown", name: "w" });
  const again = store.active().id;
  assert.notStrictEqual(again, letter);
  assert.strictEqual(store.get(again).docKey, LETTER.docKey);
  assert.strictEqual(store.openCount, 2);
  // a key after a long sleep ends that document's session where it left off,
  // without waiting for the idle timer
  const reportLast = store.get(report).lastKeyAt;
  now.advance(IDLE_MS + 1000);
  store.keyEvent({ ...REPORT, type: "keydown", name: "v" });
  assert.notStrictEqual(store.active().id, report);
  assert.strictEqual(store.get(report).endedAt, reportLast);

  // just before midnight in the letter, just after it in the report: at the
  // first quiet minute of the new day only the letter's session ends
  const midnight = new Date(2026, 8, 25).getTime();
  const late = await newStore({ now: clock(midnight - 3 * 60_000) });
  typeKeep(late.store, LETTER);
  const lateLetter = late.store.active().id;
  late.now.set(midnight + 30_000);
  typeKeep(late.store, REPORT);
  late.now.set(midnight + 105_000);
  assert.deepStrictEqual(late.store.closeIdle(), [lateLetter]);
  assert.strictEqual(late.store.openCount, 1);
});

test("a key's release goes to the session its press went to", async () => {
  const { store, now } = await newStore();
  typeKeep(store, LETTER);
  now.advance(1000);
  typeKeep(store, REPORT);
  const letter = idOf(store, LETTER), report = idOf(store, REPORT);
  const ups = (id) => store.eventsOf(id).filter(e => e.kind === "keyup").length;
  const before = { letter: ups(letter), report: ups(report) };
  // pressed in the letter; the document in front changed before the release
  store.keyEvent({ ...LETTER, type: "keydown", name: "q" });
  store.keyEvent({ ...REPORT, type: "keyup", name: "q" });
  assert.strictEqual(ups(letter), before.letter + 1);
  assert.strictEqual(ups(report), before.report);
  // a release with no press on record goes to the document in front, as before
  store.keyEvent({ ...REPORT, type: "keyup", name: "q" });
  assert.strictEqual(ups(report), before.report + 1);
});

test("a release in the next app still goes to the session its press went to", async () => {
  const { store } = await newStore();
  typeKeep(store, LETTER);
  const letter = store.active().id;
  const ups = (id) => store.eventsOf(id).filter(e => e.kind === "keyup").length;
  const before = ups(letter);
  // ⌘Tab: pressed in Pages, released once Notes is in front
  store.keyEvent({ ...LETTER, type: "keydown", name: "Meta" });
  store.keyEvent({ ...LETTER, type: "keydown", name: "Tab", mods: "M" });
  store.keyEvent({ ...NOTES, type: "keyup", name: "Tab" });
  store.keyEvent({ ...NOTES, type: "keyup", name: "Meta" });
  assert.strictEqual(ups(letter), before + 2, "both releases pair with their presses");
  assert.strictEqual(store.openCount, 1, "Notes got no session from a release");
});

test("a release after a sleep never stretches the session its press went to", async () => {
  // ⌘Tab out of the letter, the Mac sleeps (no idle timer runs), then ⌘Tab
  // back within seconds of waking: the Tab release lands in the letter again.
  const { store, now } = await newStore();
  typeKeep(store, LETTER);
  store.keyEvent({ ...LETTER, type: "keydown", name: "Tab", mods: "M" });
  const letter = store.active().id;
  const lastKey = store.get(letter).lastKeyAt;
  store.keyEvent({ bundleId: "com.apple.finder", app: "Finder", type: "keyup", name: "Tab" });
  now.advance(IDLE_MS + 1000);
  store.keyEvent({ ...LETTER, type: "keyup", name: "Tab" });
  store.keyEvent({ ...LETTER, type: "keydown", name: "h" });
  assert.notStrictEqual(store.active().id, letter, "a fresh sitting of the letter");
  assert.strictEqual(store.get(letter).endedAt, lastKey, "the old one ended at its last key");
  assert.strictEqual(store.get(letter).lastKeyAt, lastKey);

  // the same when the first release was never seen at all, so the press is
  // still on record when its release finally arrives after the gap
  typeKeep(store, REPORT);
  store.keyEvent({ ...REPORT, type: "keydown", name: "Tab", mods: "M" });
  const report = store.active().id;
  const reportLast = store.get(report).lastKeyAt;
  now.advance(IDLE_MS + 1000);
  store.keyEvent({ ...REPORT, type: "keyup", name: "Tab" });
  store.keyEvent({ ...REPORT, type: "keydown", name: "h" });
  assert.notStrictEqual(store.active().id, report);
  assert.strictEqual(store.get(report).endedAt, reportLast);
  assert.strictEqual(store.get(report).lastKeyAt, reportLast);
});

test("link ties a session to its piece, written through at once and kept across a restart", async () => {
  const dir = tmpDir();
  const now = clock();
  const changes = [];
  const a = await newStore({ dir, now, onChange: (w) => changes.push(w) });
  typeKeep(a.store, LETTER);
  const id = a.store.active().id;
  assert.strictEqual(a.store.get(id).pieceId, null);
  changes.length = 0;
  assert.strictEqual(a.store.link(id, "piece-1"), true);
  assert.strictEqual(a.store.get(id).pieceId, "piece-1");
  assert.strictEqual(a.store.active().pieceId, "piece-1");
  assert.ok(changes.includes("sessions"), "the renderer hears about it");
  // on disk straight away, without a tick for the index debounce
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "index.json"), "utf8")).find(s => s.id === id);
  assert.strictEqual(onDisk.pieceId, "piece-1");
  assert.strictEqual(onDisk.docKey, LETTER.docKey);
  assert.strictEqual(onDisk.docLabel, "Letter to Ada.pages");
  assert.strictEqual(a.store.link(id, "piece-1"), true, "linking again is a no-op");
  assert.strictEqual(a.store.link("no-such-session", "piece-1"), false);
  a.store.closeAll();

  const b = await newStore({ dir, now });
  b.store.load();
  const s = b.store.get(id);
  assert.strictEqual(s.pieceId, "piece-1");
  assert.strictEqual(s.docKey, LETTER.docKey);
  assert.strictEqual(s.docLabel, "Letter to Ada.pages");
  assert.ok(b.store.link(id, null), "null unties it");
  assert.strictEqual(b.store.get(id).pieceId, null);
});

test("a short session that is already part of a piece is kept, on close and after a crash", async () => {
  const dir = tmpDir();
  const now = clock();
  const { store } = await newStore({ dir, now });
  for (const ch of "ps") { store.keyEvent({ ...LETTER, type: "keydown", name: ch }); store.keyEvent({ ...LETTER, type: "keyup", name: ch }); }
  const id = store.active().id;
  store.link(id, "piece-1");
  store.end();
  assert.deepStrictEqual(store.list().map(s => s.id), [id], "its rhythm counts towards the piece");
  assert.strictEqual(store.eventsOf(id).at(-1).kind, "session_end");
  // …while a short one outside any piece is still dropped
  for (const ch of "saf") store.keyEvent({ ...REPORT, type: "keydown", name: ch });
  store.end();
  assert.strictEqual(store.list().length, 1);
  // a linked short session left open by a crash survives the next load too
  now.advance(1000);
  for (const ch of "ok") store.keyEvent({ ...REPORT, type: "keydown", name: ch });
  const open = store.active().id;
  store.link(open, "piece-2");
  const b = await newStore({ dir, now });
  b.store.load();
  assert.ok(b.store.get(open), "kept");
  assert.strictEqual(b.store.get(open).endedAt, b.store.get(open).lastKeyAt);
});

test("sessions recorded before documents were told apart load as an unknown document", async () => {
  const dir = tmpDir();
  const now = clock();
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const legacy = {
    id: "old-1", app: "Notes", bundleId: "com.apple.Notes", code: "INKK-AAAA-BBBB-CCCC",
    startedAt: now() - 60_000, endedAt: now() - 1000, lastKeyAt: now() - 1000,
    keystrokes: 50, deletions: 0, pastes: 0, wordsEst: 9, activeMs: 0, score: null, cert: null,
  };
  fs.writeFileSync(path.join(dir, "sessions", "index.json"), JSON.stringify([legacy]));
  const { store } = await newStore({ dir, now });
  store.load();
  const s = store.get("old-1");
  assert.strictEqual(s.docKey, "");
  assert.strictEqual(s.docLabel, "");
  assert.strictEqual(s.pieceId, null);
  assert.strictEqual(store.openCount, 0, "a closed legacy session is never reopened");

  // a torn index rebuilt from the traces: the trace never named the document
  typeKeep(store, LETTER);
  const id = store.active().id;
  store.link(id, "piece-1");
  store.closeAll();
  fs.writeFileSync(path.join(dir, "sessions", "index.json"), "{ not json");
  const b = await newStore({ dir, now });
  b.store.load();
  const rebuilt = b.store.get(id);
  assert.strictEqual(rebuilt.docKey, "");
  assert.strictEqual(rebuilt.docLabel, "");
  assert.strictEqual(rebuilt.pieceId, null, "relinked from lib/pieces.js, which lists each piece's sessions");
  assert.strictEqual(rebuilt.app, "Pages");
});
