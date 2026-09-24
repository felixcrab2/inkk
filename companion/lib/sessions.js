// inkk companion — writing-session model + persistence.
//
// A "session" is one stretch of typing in one document of one app. Sessions
// are keyed by the front app's bundle id and the document in front of it (the
// docKey lib/context.js derives from the window: a file path or a title, ""
// when it can't tell) and may be open concurrently: drafting in Notes while
// answering mail is two sessions, and so are two letters open side by side in
// Pages. Each one carries the exact writing_event_batches trace that capture.js
// reconstructs from physical keys — key_char always null, so the store holds
// the RHYTHM of writing and, by construction, never the words. The document's
// key and label live on the summary only, never in the trace that is sent to
// inkk.site at certify time.
//
// A session can be linked to a piece (lib/pieces.js): the piece of writing its
// typing went into, so a letter picked up again tomorrow is one piece written
// over two sittings rather than two unrelated sessions.
//
// Lifecycle:  first keystroke in a document → openFor()  … typing …  → closed after
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
const MAX_VERSIONS = 20;               // earlier certificates kept per session

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

function createStore({ dir, now = Date.now, hrnow = null, genId, genCode = null, scoring = null, onChange = null }) {
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
  const openByDoc = new Map();   // routeKey(bundleId, docKey) → id of the open session for that document
  const pressedIn = new Map();   // key name → the session that key's press went to
  const fullCache = new Map();   // id → last full computeScore() output
  let activeId = null;           // session that got the most recent keystroke
  let indexDirtyAt = null;
  let lastAppendAt = 0;

  const emit = (what) => { if (onChange) onChange(what); };
  const markIndex = () => { if (indexDirtyAt === null) indexDirtyAt = now(); };

  // ── open / route ──────────────────────────────────────────────────────────
  // A route is one app and one document; a newline never occurs in a bundle id.
  const routeKey = (bundleId, docKey) => `${bundleId}\n${docKey || ""}`;

  // The open session that keys typed in this app and document continue, or
  // null. A known document has its own session. An unknown one ("": no helper,
  // no Accessibility, a read that failed for a moment) is not a new document:
  // it continues whichever of the app's sessions was typed in last, which is
  // exactly one session per app, as before, when no document is ever known.
  // And an app's first keys can come before its document is known (the helper
  // still starting, Accessibility granted mid-letter): that nameless session
  // was this document all along, so the document continues it.
  function continuing(bundleId, docKey) {
    const own = openByDoc.get(routeKey(bundleId, docKey));
    if (own) return own;
    if (docKey) return openByDoc.get(routeKey(bundleId, "")) || null;
    let last = null;
    for (const id of live.keys()) {
      const s = summaries.get(id);
      if (s.bundleId === bundleId && (!last || s.lastKeyAt > last.lastKeyAt)) last = s;
    }
    return last ? last.id : null;
  }

  // A nameless session takes the document it turned out to be, and a label
  // keeps up with what the document is called. An unknown document never
  // renames a known one.
  function nameDoc(id, docKey, docLabel) {
    const s = summaries.get(id);
    if (!docKey || (s.docKey && s.docKey !== docKey)) return;
    let renamed = false;
    if (!s.docKey) {
      openByDoc.delete(routeKey(s.bundleId, ""));
      s.docKey = docKey;
      openByDoc.set(routeKey(s.bundleId, docKey), id);
      renamed = true;
    }
    if (docLabel && s.docLabel !== docLabel) { s.docLabel = docLabel; renamed = true; }
    if (!renamed) return;
    markIndex();
    emit("sessions");
  }

  // `doc` is { docKey, docLabel } (or just the docKey). A caller that passes
  // only the bundle id gets the app's current session, as it always has.
  function openFor(bundleId, app, doc) {
    const d = typeof doc === "string" ? { docKey: doc } : (doc || {});
    const docKey = d.docKey || "", docLabel = d.docLabel || "";
    const existing = continuing(bundleId, docKey);
    if (existing) { nameDoc(existing, docKey, docLabel); return existing; }
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
      docKey, docLabel, pieceId: null,    // the piece is linked once its text has been recognised
      code: genCode ? genCode() : null,   // ready from the first keystroke; certifying binds it
      startedAt: t, endedAt: null, lastKeyAt: t,
      keystrokes: 0, deletions: 0, pastes: 0, wordsEst: 0, activeMs: 0,
      score: null, cert: null,
    };
    summaries.set(id, summary);
    live.set(id, { cap, events: [], pending: [], spaceDowns: 0, scoredAt: 0, scoreDirty: false });
    openByDoc.set(routeKey(bundleId, docKey), id);
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

  // One physical key event from the hook, already attributed to an app and,
  // when the helper could tell, to the document in front of it.
  //   { bundleId, app, docKey, docLabel, type: 'keydown'|'keyup'|'paste', name, mods, len, at: { t, pt } }
  function keyEvent({ bundleId, app, docKey, docLabel, type, name, mods, len, at }) {
    if (!bundleId) return null;
    const t = at?.t ?? now();
    const doc = { docKey: docKey || "", docLabel: docLabel || "" };
    // A release goes where its press went, even when the app or document in
    // front changed while the key was held (⌘Tab, ⌘` to the next window, a
    // poll landing mid-key), so every session's dwell times pair up. A
    // physical key is held only once at a time, so the key's name alone says
    // which press this is, and whichever app the release lands in consumes it.
    // But only while that session is still going: a release after the session
    // went stale (a press whose release was never seen, then a sleep) takes
    // the normal path below, which ends the session where it left off rather
    // than let the release stretch it across the gap.
    const pressedId = name ? pressedIn.get(name) : undefined;
    if (type === "keyup" && name) pressedIn.delete(name);
    let id = type === "keyup" && live.has(pressedId) && !isStale(pressedId, t) ? pressedId : null;
    if (!id) {
      // The session this key would continue, if it has been idle past the
      // limit (the Mac slept, or a long break) or started on another calendar
      // day, ends where it left off before this key can extend it — the 30s
      // idle timer doesn't run through sleep, so this is the check that
      // actually catches that case.
      for (let c = continuing(bundleId, doc.docKey); c && isStale(c, t); c = continuing(bundleId, doc.docKey)) {
        close(c, summaries.get(c).lastKeyAt);
      }
      if (!continuing(bundleId, doc.docKey) && !(type === "keydown" && isTextKey(name, mods))) return null;
      id = openFor(bundleId, app || bundleId, doc);
    }
    const s = summaries.get(id), l = live.get(id);
    if (type === "keydown") { l.cap.keydown(name, mods || "", at); if (name) pressedIn.set(name, id); }
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
    const end = endedAt ?? now();
    l.cap.stop({ t: end });
    drain(id);
    score(id);
    s.endedAt = end;
    live.delete(id);
    const route = routeKey(s.bundleId, s.docKey);
    if (openByDoc.get(route) === id) openByDoc.delete(route);
    if (activeId === id) activeId = null;
    // A few keys in a Save dialog or Spotlight is not a writing session: drop it
    // rather than let it clutter Recent. Anything certified is always kept, and
    // so is anything already part of a piece, whose certificate is scored from
    // the rhythm of every session in it.
    if (s.keystrokes < MIN_KEEP_KEYSTROKES && !s.cert && !s.pieceId) {
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

  // Over: idle past the limit, or — since a session never spans a calendar
  // day — open since another day and quiet for a minute (an author
  // mid-sentence at 00:00 isn't cut off).
  function isStale(id, t) {
    const s = summaries.get(id);
    const idle = t - s.lastKeyAt;
    return idle >= IDLE_MS || (dayKey(t) !== dayKey(s.startedAt) && idle >= DAY_CHANGE_GRACE_MS);
  }

  function closeIdle(nowMs = now()) {
    const closed = [];
    for (const id of [...live.keys()]) {
      if (isStale(id, nowMs)) { close(id, summaries.get(id).lastKeyAt); closed.push(id); }
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

  // The open session the next key typed in this app and document would go
  // to, or null when that key would start a new one.
  function sessionFor(bundleId, docKey = "", nowMs = now()) {
    const id = continuing(bundleId, docKey || "");
    return id && !isStale(id, nowMs) ? { ...summaries.get(id) } : null;
  }

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

  // A certificate is final once the ledger holds it. Writing on after
  // certifying and certifying again issues a new code for the new version; the
  // session keeps its earlier certificates (newest first) so a file stamped
  // with an older version still reads as this writer's.
  function setCert(id, cert) {
    const s = summaries.get(id);
    if (!s) return false;
    const earlier = s.cert && s.cert.code !== cert.code ? [s.cert, ...(s.certs || [])] : (s.certs || []);
    s.cert = cert;
    s.certs = earlier.slice(0, MAX_VERSIONS);
    s.code = cert.code;
    writeJsonAtomic(certFile(id), { ...cert, earlier: s.certs });
    markIndex();
    emit("sessions");
    return true;
  }

  // Tie a session to the piece of writing it belongs to (lib/pieces.js); null
  // unties it. Written through at once rather than on the index debounce: the
  // link is what lets a later certificate gather this session's rhythm.
  function link(id, pieceId) {
    const s = summaries.get(id);
    if (!s) return false;
    const next = pieceId || null;
    if (s.pieceId === next) return true;
    s.pieceId = next;
    writeIndex();
    emit("sessions");
    return true;
  }

  // The code the next certificate of this session will carry: the session's own
  // until it is certified, then a fresh one whenever the text has moved on.
  function codeFor(id, contentHash) {
    const s = summaries.get(id);
    if (!s) return null;
    if (!s.cert) return s.code || (genCode ? genCode() : null);
    if (contentHash && s.cert.contentHash === contentHash) return s.cert.code;
    return genCode ? genCode() : null;
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
        // Sessions recorded before documents were told apart: an unknown document, no piece.
        if (typeof s.docKey !== "string") s.docKey = "";
        if (typeof s.docLabel !== "string") s.docLabel = "";
        if (s.pieceId === undefined) s.pieceId = null;
        if (s.endedAt == null) {
          s.endedAt = s.lastKeyAt; indexDirtyAt = indexDirtyAt ?? 0;
          // …and the same rule close() applies: a few keys in a dialog is not a session.
          if ((s.keystrokes | 0) < MIN_KEEP_KEYSTROKES && !s.cert && !s.pieceId) { rmQuiet(eventsFile(s.id)); continue; }
        }
        summaries.set(s.id, s);
      }
    }
    prune(nowMs);
    if (indexDirtyAt !== null) writeIndex();
    emit("sessions");
    return summaries.size;
  }

  // Reconstruct summaries from sessions/events/*.jsonl (+ certs) when the
  // index is unreadable. Scores are recomputed lazily by get(). The trace
  // never names the document, so a rebuilt session's is unknown and its piece
  // link comes back from lib/pieces.js, which lists each piece's sessions.
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
      const cert = readJson(certFile(id));
      const s = {
        id, app: start?.payload?.app || "Unknown app", bundleId: start?.payload?.bundle_id || "",
        docKey: "", docLabel: "", pieceId: null,
        code: cert?.code || (genCode ? genCode() : null),
        startedAt: first.t, endedAt: last.t, lastKeyAt: last.t,
        keystrokes: 0, deletions: 0, pastes: 0, wordsEst: 0, activeMs: 0, score: null,
        cert: cert ? (({ earlier, ...c }) => c)(cert) : null,
        certs: Array.isArray(cert?.earlier) ? cert.earlier : [],
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
    list, get, active, sessionFor, eventsOf, setCert, codeFor, link,
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
