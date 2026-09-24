// inkk companion — writing-session model + persistence.
//
// A "session" is one stretch of typing in one app. Sessions are keyed by the
// front app's bundle id and may be open concurrently (drafting in Notes while
// answering mail is two sessions, not one), and each one carries the exact
// writing_event_batches trace that capture.js reconstructs from physical keys —
// key_char always null, so the store holds the RHYTHM of writing and, by
// construction, never the words.
//
// Lifecycle:  first keystroke in an app → openFor()  … typing …  → closed after
// IDLE_MS without keys (closeIdle, driven by a 30s timer in main), on an
// explicit end(), on quit (closeAll), or when the day changes.
//
// This module is deliberately pure-ish: the clock, id generator and scorer are
// injected, and all I/O goes through a handful of small sync helpers at the
// bottom, so the whole lifecycle unit-tests in plain Node against a temp dir
// (see sessions.test.js). Nothing here touches Electron.
//
// Layout under `dir`:
//   sessions/index.json          array of SessionSummary (atomic write)
//   sessions/events/<id>.jsonl   append-only, one event per line
//   sessions/certs/<id>.json     the certificate, once issued

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createCapture, classifyKey, PRINTABLE } = require("../capture");

const IDLE_MS = 8 * 60 * 1000;         // close a session after this long without keys
const DAY_CHANGE_GRACE_MS = 60 * 1000; // …or at the first quiet minute after midnight
const SCORE_INTERVAL_MS = 1500;        // live score: recompute at most this often
const APPEND_INTERVAL_MS = 2000;       // jsonl appends are buffered up to this long
const INDEX_DEBOUNCE_MS = 1000;        // index.json writes are debounced this long
const MIN_EVENTS_FOR_SCORE = 8;        // same floor as the website's recomputeScore
const RETENTION_DAYS = 60;
const RETENTION_MAX = 400;
const MAX_EVENTS_IN_MEMORY = 60000;    // /api/certify caps events at 60000 too
const TRIM_CHUNK = 2000;               // …kept as a ring: drop the oldest chunk when full
const MIN_KEEP_KEYSTROKES = 40;        // shorter sessions (Spotlight, a filename) are noise and are dropped on close

// A keydown that would put text on the page: printable keys, Enter,
// Backspace/Delete, without a ⌘/Ctrl chord. Only these OPEN a session; a lone
// Cmd-Tab, arrow key or Escape in Finder never does.
function isTextKey(name, mods) {
  if (mods && /[MC]/.test(mods)) return false;
  const [kc] = classifyKey(name);
  return PRINTABLE.has(kc) || name === "Enter" || name === "Backspace" || name === "Delete";
}

// Local calendar day, used for the "session never spans a date" rule.
function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// The renderer's Score: the headline numbers plus the ranked contributors,
// without the diagnostic bulk (subs, series) that only the detail view needs.
function slimScore(full) {
  if (!full) return null;
  return {
    score: full.score,
    tier: full.tier,
    confidence: full.confidence,
    contributors: (full.contributors || []).map(c => ({ key: c.key, label: c.label, value: c.value })),
  };
}

function createStore({ dir, now = Date.now, hrnow = null, genId, scoring = null, onChange = null }) {
  if (!dir) throw new Error("sessions: dir is required");
  if (!genId) throw new Error("sessions: genId is required");
  const clockHr = hrnow || now;

  const sessionsDir = path.join(dir, "sessions");
  const eventsDir = path.join(sessionsDir, "events");
  const certsDir = path.join(sessionsDir, "certs");
  const indexFile = path.join(sessionsDir, "index.json");
  const eventsFile = (id) => path.join(eventsDir, `${id}.jsonl`);
  const certFile = (id) => path.join(certsDir, `${id}.json`);

  const summaries = new Map();   // id → SessionSummary (open and closed)
  const live = new Map();        // id → in-memory state for OPEN sessions
  const openByApp = new Map();   // bundleId → id of the open session for that app
  const fullCache = new Map();   // id → last full computeScore() output
  let activeId = null;           // session that got the most recent keystroke
  let indexDirtyAt = null;
  let lastAppendAt = 0;

  const emit = (what) => { if (onChange) onChange(what); };
  const markIndex = () => { if (indexDirtyAt === null) indexDirtyAt = now(); };

  // ── open / route ──────────────────────────────────────────────────────────
  function openFor(bundleId, app) {
    const existing = openByApp.get(bundleId);
    if (existing) return existing;
    const t = now();
    const id = genId();
    const cap = createCapture({
      userId: null,                // the server derives the user at certify time
      docId: id, sessionId: genId(),
      genId, now, hrnow: clockHr,
    });
    cap.start({ platform: process.platform, app, bundle_id: bundleId, surface: "companion" });
    const summary = {
      id, app, bundleId,
      startedAt: t, endedAt: null, lastKeyAt: t,
      keystrokes: 0, deletions: 0, pastes: 0, wordsEst: 0, activeMs: 0,
      score: null, cert: null,
    };
    summaries.set(id, summary);
    live.set(id, { cap, events: [], pending: [], spaceDowns: 0, scoredAt: 0, scoreDirty: false });
    openByApp.set(bundleId, id);
    drain(id);
    markIndex();
    emit("sessions");
    return id;
  }

  // Move newly produced capture events into the session's buffers and keep the
  // running counts in step. Called after every capture call.
  function drain(id) {
    const s = summaries.get(id), l = live.get(id);
    const fresh = l.cap.drain();
    for (const e of fresh) {
      l.events.push(e);
      if (l.events.length > MAX_EVENTS_IN_MEMORY + TRIM_CHUNK) l.events.splice(0, TRIM_CHUNK);   // ring: newest wins
      l.pending.push(JSON.stringify(e));
      if (e.kind === "input") s.keystrokes++;
      else if (e.kind === "delete") { s.keystrokes++; s.deletions++; }
      else if (e.kind === "paste") s.pastes++;
      else if (e.kind === "keydown" && e.key_class === "space") l.spaceDowns++;
    }
    return fresh.length;
  }

  // One physical key event from the hook, already attributed to an app.
  //   { bundleId, app, type: 'keydown'|'keyup'|'paste', name, mods, len, at: { t, pt } }
  function keyEvent({ bundleId, app, type, name, mods, len, at }) {
    if (!bundleId) return null;
    const t = at?.t ?? now();
    // An open session that has been idle past the limit (the Mac slept, or a
    // long break), or that started on another calendar day, ends where it left
    // off before this key can extend it — the 30s idle timer doesn't run
    // through sleep, so this is the check that actually catches that case.
    const existing = openByApp.get(bundleId);
    if (existing) {
      const es = summaries.get(existing);
      const idle = t - es.lastKeyAt;
      if (idle >= IDLE_MS || (dayKey(t) !== dayKey(es.startedAt) && idle >= DAY_CHANGE_GRACE_MS)) close(existing, es.lastKeyAt);
    }
    if (!openByApp.get(bundleId) && !(type === "keydown" && isTextKey(name, mods))) return null;
    const id = openFor(bundleId, app || bundleId);
    const s = summaries.get(id), l = live.get(id);
    if (type === "keydown") l.cap.keydown(name, mods || "", at);
    else if (type === "keyup") l.cap.keyup(name, at);
    else if (type === "paste") l.cap.paste(len || 0, at);
    else return id;
    drain(id);
    s.lastKeyAt = t;
    if (type !== "keyup") activeId = id;
    l.scoreDirty = true;
    if (t - l.scoredAt >= SCORE_INTERVAL_MS) score(id, t);
    markIndex();
    emit("active");
    return id;
  }

  // ── live score ────────────────────────────────────────────────────────────
  // words = space keydowns + 1 (the same estimate the website uses when it has
  // no document to count). Score is process-only, so this is all it needs.
  function score(id, t = now()) {
    const s = summaries.get(id), l = live.get(id);
    if (!s || !l) return;
    l.scoredAt = t;
    l.scoreDirty = false;
    if (!scoring || l.events.length < MIN_EVENTS_FOR_SCORE) return;
    const words = l.spaceDowns + 1;
    const full = scoring.computeScore(scoring.extractFeatures(l.events, { words }));
    fullCache.set(id, full);
    s.score = slimScore(full);
    s.activeMs = full.active_time_ms || 0;
    s.wordsEst = words;
    markIndex();
  }

  // ── close ─────────────────────────────────────────────────────────────────
  function close(id, endedAt) {
    const s = summaries.get(id), l = live.get(id);
    if (!s || !l) return;
    l.cap.stop();
    drain(id);
    score(id);
    s.endedAt = endedAt ?? now();
    live.delete(id);
    if (openByApp.get(s.bundleId) === id) openByApp.delete(s.bundleId);
    if (activeId === id) activeId = null;
    // A few keys in a Save dialog or Spotlight is not a writing session: drop it
    // rather than let it clutter Recent. Anything certified is always kept.
    if (s.keystrokes < MIN_KEEP_KEYSTROKES && !s.cert) {
      summaries.delete(id);
      fullCache.delete(id);
      rmQuiet(eventsFile(id));
      markIndex();
      emit("sessions");
      return;
    }
    appendEvents(id, l);
    markIndex();
    emit("sessions");
  }

  function closeIdle(nowMs = now()) {
    const closed = [];
    for (const [id] of live) {
      const s = summaries.get(id);
      const idle = nowMs - s.lastKeyAt;
      if (idle >= IDLE_MS) { close(id, s.lastKeyAt); closed.push(id); continue; }
      // A session never spans a calendar day: close at the first quiet minute
      // after midnight (an author mid-sentence at 00:00 isn't cut off).
      if (dayKey(nowMs) !== dayKey(s.startedAt) && idle >= DAY_CHANGE_GRACE_MS) { close(id, s.lastKeyAt); closed.push(id); }
    }
    return closed;
  }

  function end(id) {
    const target = id || activeId;
    if (target && live.has(target)) close(target, now());
  }

  function closeAll() {
    for (const id of [...live.keys()]) close(id, now());
    flush();
  }

  function remove(id) {
    if (live.has(id)) close(id, now());
    if (!summaries.delete(id)) return false;
    fullCache.delete(id);
    rmQuiet(eventsFile(id));
    rmQuiet(certFile(id));
    markIndex();
    emit("sessions");
    return true;
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  const list = () => [...summaries.values()].sort((a, b) => b.lastKeyAt - a.lastKeyAt).map(s => ({ ...s }));

  const active = () => (activeId && live.has(activeId) ? { ...summaries.get(activeId) } : null);

  // All events for a session: the in-memory ring while open, the jsonl after —
  // in both cases the most recent MAX_EVENTS_IN_MEMORY, so a certificate is
  // computed from the same tail whether the session is live or closed.
  function eventsOf(id) {
    const l = live.get(id);
    if (l) return l.events.slice(-MAX_EVENTS_IN_MEMORY);
    return readJsonl(eventsFile(id)).slice(-MAX_EVENTS_IN_MEMORY);
  }

  function get(id) {
    const s = summaries.get(id);
    if (!s) return null;
    let full = fullCache.get(id) || null;
    if (!full && scoring) {
      const events = eventsOf(id);
      if (events.length >= MIN_EVENTS_FOR_SCORE) {
        const words = events.filter(e => e.kind === "keydown" && e.key_class === "space").length + 1;
        full = scoring.computeScore(scoring.extractFeatures(events, { words }));
        fullCache.set(id, full);
      }
    }
    return { ...s, full };
  }

  function setCert(id, cert) {
    const s = summaries.get(id);
    if (!s) return false;
    s.cert = cert;
    writeJsonAtomic(certFile(id), cert);
    markIndex();
    emit("sessions");
    return true;
  }

  // ── time-driven housekeeping (main calls this every second) ───────────────
  // Returns true when something the UI shows may have changed.
  function tick(nowMs = now()) {
    let changed = false;
    for (const [id, l] of live) {
      if (l.scoreDirty && nowMs - l.scoredAt >= SCORE_INTERVAL_MS) { score(id, nowMs); changed = true; }
    }
    if (nowMs - lastAppendAt >= APPEND_INTERVAL_MS) appendAll(nowMs);
    if (indexDirtyAt !== null && nowMs - indexDirtyAt >= INDEX_DEBOUNCE_MS) writeIndex();
    return changed;
  }

  // Everything to disk, now (quit, or a test wanting a deterministic state).
  function flush() {
    appendAll(now());
    if (indexDirtyAt !== null) writeIndex();
  }

  // ── persistence ───────────────────────────────────────────────────────────
  function appendEvents(id, l) {
    if (!l.pending.length) return;
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.appendFileSync(eventsFile(id), l.pending.join("\n") + "\n");
    l.pending.length = 0;
  }

  function appendAll(nowMs) {
    lastAppendAt = nowMs;
    for (const [id, l] of live) appendEvents(id, l);
  }

  function writeIndex() {
    indexDirtyAt = null;
    writeJsonAtomic(indexFile, list());
  }

  // Read what a previous run left behind. Anything still "open" in the index
  // belongs to a process that died mid-session; it is closed at its last key.
  function load(nowMs = now()) {
    let arr = readJson(indexFile);
    if (!Array.isArray(arr) && fs.existsSync(indexFile)) {
      // A torn index (crash mid-write) must not erase the history it pointed
      // at: set it aside and rebuild what we can from the event files.
      try { fs.renameSync(indexFile, `${indexFile}.corrupt-${nowMs}`); } catch { /* ignore */ }
      arr = rebuildFromEvents();
      indexDirtyAt = 0;
    }
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (!s || typeof s.id !== "string") continue;
        if (s.endedAt == null) { s.endedAt = s.lastKeyAt; indexDirtyAt = indexDirtyAt ?? 0; }
        summaries.set(s.id, s);
      }
    }
    prune(nowMs);
    if (indexDirtyAt !== null) writeIndex();
    emit("sessions");
    return summaries.size;
  }

  // Reconstruct summaries from sessions/events/*.jsonl (+ certs) when the
  // index is unreadable. Scores are recomputed lazily by get().
  function rebuildFromEvents() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(eventsDir).filter(n => n.endsWith(".jsonl")); } catch { return out; }
    for (const n of names) {
      const id = n.slice(0, -6);
      const evs = readJsonl(path.join(eventsDir, n));
      if (!evs.length) continue;
      const first = evs[0], last = evs[evs.length - 1];
      const start = evs.find(e => e.kind === "session_start");
      const s = {
        id, app: start?.payload?.app || "Unknown app", bundleId: start?.payload?.bundle_id || "",
        startedAt: first.t, endedAt: last.t, lastKeyAt: last.t,
        keystrokes: 0, deletions: 0, pastes: 0, wordsEst: 0, activeMs: 0, score: null,
        cert: readJson(certFile(id)),
      };
      for (const e of evs) {
        if (e.kind === "input") s.keystrokes++;
        else if (e.kind === "delete") { s.keystrokes++; s.deletions++; }
        else if (e.kind === "paste") s.pastes++;
        else if (e.kind === "keydown" && e.key_class === "space") s.wordsEst++;
      }
      s.wordsEst += 1;
      out.push(s);
    }
    return out;
  }

  // Retention: the last RETENTION_DAYS, at most RETENTION_MAX sessions.
  function prune(nowMs = now()) {
    const cutoff = nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const ordered = list();
    const removed = [];
    ordered.forEach((s, i) => {
      if (live.has(s.id)) return;
      if (s.lastKeyAt < cutoff || i >= RETENTION_MAX) removed.push(s.id);
    });
    for (const id of removed) {
      summaries.delete(id);
      fullCache.delete(id);
      rmQuiet(eventsFile(id));
      rmQuiet(certFile(id));
    }
    if (removed.length) markIndex();
    return removed;
  }

  return {
    openFor, keyEvent, closeIdle, end, closeAll, delete: remove,
    list, get, active, eventsOf, setCert,
    tick, flush, load, prune,
    get openCount() { return live.size; },
  };
}

// ── small sync I/O helpers ───────────────────────────────────────────────────
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
  }
  return out;
}

function rmQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

module.exports = {
  createStore, slimScore, dayKey, isTextKey,
  IDLE_MS, SCORE_INTERVAL_MS, RETENTION_DAYS, RETENTION_MAX, MIN_EVENTS_FOR_SCORE, MIN_KEEP_KEYSTROKES,
};
