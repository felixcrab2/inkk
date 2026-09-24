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
