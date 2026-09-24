// inkk companion — pieces: one piece of writing across any number of sessions.
//
// A session is one stretch of typing in one document. A piece is the writing
// itself: the essay started on Monday and picked up again on Thursday, the
// email drafted before lunch and finished after it. When the writer comes back
// to text inkk has already seen on this Mac, the new session continues that
// piece: it keeps the piece's code, and its certificate is scored from the
// rhythm of every session that wrote it.
//
// Recognising the text without keeping it. A piece is known by salted
// fingerprints of its sentences: HMAC-SHA256 under a secret that never leaves
// this Mac (main keeps it in the keychain), cut to 64 bits. The text in front
// is fingerprinted, compared with the pieces already seen, and dropped. The
// index holds hex, never words, and without the secret its fingerprints cannot
// even be tested against a guessed sentence.
//
// How a text is recognised, in order: the same file on disk; enough sentences
// in common with a known piece (sentences survive appending, reordering and
// editing elsewhere); the session it is being typed in, when the text in front
// has been cleared; otherwise it is a new piece. A known piece's fingerprints
// are refreshed from every read, so it follows its text as it changes.
//
// Pure Node (fs, crypto), no Electron: the clock, ids, codes and text functions
// are injected, so the whole thing unit-tests against a temp dir (see
// pieces.test.js).
//
// Layout under `dir`:
//   pieces/index.json   array of Piece (atomic write, mode 600)
//
// Besides its fingerprints, a piece keeps the ids of the sessions that wrote in
// it and, in `touched`, when each of them last did (ids and times, no text), so
// the piece a session belongs to is the same after a restart as before it.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomUUID } = require("node:crypto");

const KEY_HEX = 16;                  // 64-bit fingerprints: collisions among one writer's sentences never happen
const KEY_MIN = 16;                  // shorter sentence keys ("Thanks so much.") say nothing about which piece this is; same floor as a certificate's sketch
const KEYS_MAX = 600;                // …and the same cap
const MATCH_MIN_SHARED = 2;          // one sentence in common is a coincidence (a greeting, a stock phrase)…
const MATCH_MIN_RATIO = 0.5;         // …half the shorter text in common is the same piece
const RETENTION_DAYS = 60;           // same window as sessions: past it the rhythm a piece would be scored from is gone
const RETENTION_MAX = 400;
const MAX_VERSIONS = 20;             // earlier certificates kept per piece
const MAX_SESSIONS = 400;            // the sessions store never keeps more than this many anyway
const WRITE_DELAY_MS = 2000;         // routine updates reach disk this long after the last one
const DAY_MS = 24 * 60 * 60 * 1000;
const HEX_KEY = /^[0-9a-f]{16}$/;

// Where the shared text functions live in a built app. Loaded only when the
// caller does not pass its own, so tests can use the ESM source directly.
function defaultScoring() {
  try {
    return require("./scoring.cjs");
  } catch {
    throw new Error("pieces: lib/scoring.cjs is missing (run `node build.js` in companion/)");
  }
}

// Only an absolute path names a file; a window title never does.
function isFilePath(p) {
  return typeof p === "string" && p.length > 1 && p.startsWith("/");
}

// The overlap rule. `shared` sentences in common between a text of `a`
// fingerprints and a piece of `b`: at least two, covering at least half of the
// shorter of the two (so a paragraph read from a long document still finds
// it, and a long document still finds the paragraph it grew from); or both are
// a single sentence and it is the same one.
function overlapMatches(shared, a, b) {
  if (shared >= MATCH_MIN_SHARED && shared / Math.min(a, b) >= MATCH_MIN_RATIO) return true;
  return a === 1 && b === 1 && shared === 1;
}

// `touched` maps session ids to times. It has no prototype, so no session id
// (whatever a damaged index holds) can reach Object.prototype through it.
const timesOf = (from) => Object.assign(Object.create(null), from);

function copyPiece(p) {
  return {
    ...p,
    keys: [...p.keys],
    sessions: [...p.sessions],
    touched: timesOf(p.touched),
    cert: p.cert ? { ...p.cert } : null,
    certs: p.certs.map((c) => ({ ...c })),
  };
}

const str = (v) => (typeof v === "string" ? v : "");
const num = (v, d) => (Number.isFinite(v) ? v : d);

// A piece as read back from disk: only the known fields, the right types, and
// fingerprints that look like fingerprints. Anything else is dropped rather
// than trusted.
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const keys = [...new Set((Array.isArray(raw.keys) ? raw.keys : []).filter((k) => typeof k === "string" && HEX_KEY.test(k)))].slice(0, KEYS_MAX);
  const sessions = [...new Set((Array.isArray(raw.sessions) ? raw.sessions : []).filter((s) => typeof s === "string" && s))].slice(-MAX_SESSIONS);
  const createdAt = num(raw.createdAt, 0);
  const lastAt = num(raw.lastAt, createdAt);
  // A time for every listed session and for nothing else. A session with no
  // usable time gets the piece's lastAt, the latest it can have written in it.
  const rawTouched = raw.touched && typeof raw.touched === "object" ? raw.touched : {};
  const touched = Object.create(null);
  for (const s of sessions) touched[s] = Object.hasOwn(rawTouched, s) ? num(rawTouched[s], lastAt) : lastAt;
  const cert = raw.cert && typeof raw.cert === "object" && typeof raw.cert.code === "string" ? raw.cert : null;
  return {
    id: raw.id,
    code: typeof raw.code === "string" ? raw.code : (cert ? cert.code : null),
    app: str(raw.app), bundleId: str(raw.bundleId),
    docKey: str(raw.docKey), docLabel: str(raw.docLabel), docPath: isFilePath(raw.docPath) ? raw.docPath : "",
    keys, sessions, touched,
    createdAt, lastAt,
    cert,
    certs: (Array.isArray(raw.certs) ? raw.certs : []).filter((c) => c && typeof c === "object" && typeof c.code === "string").slice(0, MAX_VERSIONS),
  };
}

function createPieces({
  dir, secret, now = Date.now, genId = randomUUID, genCode = null, scoring = null, onChange = null,
  writeDelayMs = WRITE_DELAY_MS,
} = {}) {
  if (!dir) throw new Error("pieces: dir is required");
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new Error("pieces: secret must be a 32-byte Buffer");
  const textFns = scoring || defaultScoring();
  for (const fn of ["canonicalText", "sentences", "sentenceKey"]) {
    if (typeof textFns[fn] !== "function") throw new Error(`pieces: scoring.${fn} is missing`);
  }
  const salt = Buffer.from(secret);   // our own copy: the caller may wipe theirs

  const piecesDir = path.join(dir, "pieces");
  const indexFile = path.join(piecesDir, "index.json");

  const pieces = new Map();      // id → Piece
  const bySession = new Map();   // sessionId → id of the piece that session touched last (see touch())
  let dirty = false;
  let timer = null;

  const emit = () => { if (onChange) onChange("pieces"); };

  // ── fingerprints ──────────────────────────────────────────────────────────
  // The sentences of the text exactly as a certificate's sketch splits them,
  // each keyed under this Mac's secret. Order follows the text; duplicates are
  // dropped.
  function fingerprint(input) {
    const seen = new Set();
    const out = [];
    const canonical = textFns.canonicalText(typeof input === "string" ? input : "");
    for (const s of textFns.sentences(canonical)) {
      const k = textFns.sentenceKey(s);
      if (k.length < KEY_MIN || seen.has(k)) continue;
      seen.add(k);
      out.push(createHmac("sha256", salt).update(k, "utf8").digest("hex").slice(0, KEY_HEX));
      if (out.length >= KEYS_MAX) break;
    }
    return out;
  }

  // ── matching ──────────────────────────────────────────────────────────────
  function byPath(docPath, t) {
    let best = null;
    for (const p of pieces.values()) {
      if (p.docPath !== docPath || t - p.lastAt > RETENTION_DAYS * DAY_MS) continue;
      if (!best || p.lastAt > best.lastAt) best = p;
    }
    return best;
  }

  function byKeys(keys) {
    const mine = new Set(keys);
    let best = null, bestShared = 0;
    for (const p of pieces.values()) {
      if (!p.keys.length) continue;
      let shared = 0;
      for (const k of p.keys) if (mine.has(k)) shared++;
      if (!overlapMatches(shared, keys.length, p.keys.length)) continue;
      if (shared > bestShared || (shared === bestShared && p.lastAt > best.lastAt)) { best = p; bestShared = shared; }
    }
    return best;
  }

  // Which piece is the text in front, typed in session `sessionId`?
  //   → { pieceId, continued, via } | null
  // `continued` is true when the piece was already written in another session
  // (the writer has come back to it); `via` says how it was recognised: "file",
  // "text", "session" or "new". null when there is no sentence to go on yet and
  // nothing else says which piece this is. The text is fingerprinted and
  // forgotten; nothing of it is kept.
  function identify({ sessionId = null, bundleId, app, docKey, docLabel, docPath, text: body = "", code = null } = {}) {
    const t = now();
    const keys = fingerprint(body);
    const filePath = isFilePath(docPath) ? docPath.normalize("NFC") : "";
    [bundleId, app, docKey, docLabel] = [str(bundleId), str(app), str(docKey), str(docLabel)];

    let piece = null, via = null;
    if (filePath) { piece = byPath(filePath, t); via = "file"; }
    if (!piece && keys.length) { piece = byKeys(keys); via = "text"; }
    if (!piece && sessionId) { piece = pieces.get(bySession.get(sessionId)) || null; via = "session"; }

    if (!piece) {
      if (!keys.length) return null;
      piece = {
        id: genId(),
        code: code || (genCode ? genCode() : null),
        app: app || bundleId, bundleId,
        docKey, docLabel, docPath: filePath,
        keys, sessions: sessionId ? [sessionId] : [], touched: Object.create(null),
        createdAt: t, lastAt: t,
        cert: null, certs: [],
      };
      pieces.set(piece.id, piece);
      if (sessionId) touch(piece, sessionId, t);
      schedule();
      emit();
      return { pieceId: piece.id, continued: false, via: "new" };
    }

    const continued = piece.sessions.some((s) => s !== sessionId);
    let shown = false;   // something the popover displays has changed
    if (sessionId) {
      if (addSession(piece, sessionId)) shown = true;
      touch(piece, sessionId, t);
    }
    // The piece follows its text. A read that found no sentence (the document
    // was cleared, or could not be read) leaves the last fingerprints alone.
    if (keys.length) piece.keys = keys;
    const set = (field, value) => { if (value && piece[field] !== value) { piece[field] = value; shown = true; } };
    set("docPath", filePath);
    set("docKey", docKey);
    set("docLabel", docLabel);
    set("app", app);
    set("bundleId", bundleId);
    piece.lastAt = t;
    schedule();
    if (shown) emit();
    return { pieceId: piece.id, continued, via };
  }

  function addSession(piece, sessionId) {
    if (piece.sessions.includes(sessionId)) return false;
    piece.sessions.push(sessionId);
    while (piece.sessions.length > MAX_SESSIONS) {
      const gone = piece.sessions.shift();
      delete piece.touched[gone];
      if (bySession.get(gone) === piece.id) remap(gone);
    }
    return true;
  }

  // A session can have written in more than one piece (one app, a document
  // inkk could not tell apart from the next). It belongs to the one it touched
  // last: the piece that holds its latest time in `touched`. Those times are on
  // disk with the pieces, so load() rebuilds the same map by the same rule, and
  // a session belongs to the same piece after a restart as before it, whichever
  // pieces other sessions have touched since.
  const touchedAt = (p, sessionId) => num(p.touched[sessionId], p.lastAt);

  // Is `p` the piece `sessionId` touched after `q`? (Equal times, which only an
  // index missing some times can hold, go to the piece touched last by anyone.)
  function later(p, q, sessionId) {
    const a = touchedAt(p, sessionId), b = touchedAt(q, sessionId);
    return a > b || (a === b && p.lastAt > q.lastAt);
  }

  function remap(sessionId) {
    let best = null;
    for (const p of pieces.values()) {
      if (p.sessions.includes(sessionId) && (!best || later(p, best, sessionId))) best = p;
    }
    if (best) bySession.set(sessionId, best.id);
    else bySession.delete(sessionId);
  }

  // `sessionId` has just written in `piece` (which already lists it): record
  // when, and make it that session's piece. The time never falls below the one
  // on the session's piece until now, and is past it when the session moves, so
  // the order holds for two reads in one millisecond and for a clock set back.
  function touch(piece, sessionId, t) {
    const prev = pieces.get(bySession.get(sessionId));
    const floor = !prev ? t : touchedAt(prev, sessionId) + (prev === piece ? 0 : 1);
    piece.touched[sessionId] = Math.max(t, floor);
    bySession.set(sessionId, piece.id);
  }

  function attach(pieceId, sessionId) {
    const p = pieces.get(pieceId);
    if (!p || !sessionId) return false;
    const t = now();
    const added = addSession(p, sessionId);
    touch(p, sessionId, t);
    p.lastAt = t;
    schedule();
    if (added) emit();
    return true;
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  const get = (id) => (pieces.has(id) ? copyPiece(pieces.get(id)) : null);

  const list = () => [...pieces.values()].sort((a, b) => b.lastAt - a.lastAt).map(copyPiece);

  function pieceOf(sessionId) {
    const id = sessionId ? bySession.get(sessionId) : null;
    return id && pieces.has(id) ? copyPiece(pieces.get(id)) : null;
  }

  // ── certificates ──────────────────────────────────────────────────────────
  // As for a session: a certificate is final once the ledger holds it, and a
  // later version of the text gets a code of its own. Earlier certificates stay
  // with the piece (newest first), so a copy of an older version still reads as
  // this writer's.
  function setCert(pieceId, cert) {
    const p = pieces.get(pieceId);
    if (!p || !cert || typeof cert.code !== "string") return false;
    const earlier = p.cert && p.cert.code !== cert.code ? [p.cert, ...p.certs] : p.certs;
    p.cert = { ...cert };
    p.certs = earlier.slice(0, MAX_VERSIONS);
    p.code = cert.code;
    p.lastAt = now();
    dirty = true;
    flush();   // a certificate is never left waiting for a timer
    emit();
    return true;
  }

  // The code the piece's next certificate will carry: its own until it is
  // certified, then the same one for the same text, a fresh one once the text
  // has moved on.
  function codeFor(pieceId, contentHash) {
    const p = pieces.get(pieceId);
    if (!p) return null;
    if (!p.cert) return p.code || (genCode ? genCode() : null);
    if (contentHash && p.cert.contentHash === contentHash) return p.cert.code;
    return genCode ? genCode() : null;
  }

  // ── forgetting ────────────────────────────────────────────────────────────
  function drop(id) {
    const p = pieces.get(id);
    if (!p) return false;
    pieces.delete(id);
    for (const s of p.sessions) if (bySession.get(s) === id) remap(s);
    return true;
  }

  function remove(pieceId) {
    if (!drop(pieceId)) return false;
    dirty = true;
    flush();   // the writer asked for it to be gone: gone from disk now, too
    emit();
    return true;
  }

  // Retention: nothing untouched for RETENTION_DAYS; at most RETENTION_MAX
  // pieces, the newest, except that a certified piece inside the window is
  // never dropped to make room (it takes a place, and uncertified ones give
  // theirs up).
  function prune(nowMs = now()) {
    const cutoff = nowMs - RETENTION_DAYS * DAY_MS;
    const ordered = [...pieces.values()].sort((a, b) => b.lastAt - a.lastAt);
    const removed = [];
    let room = RETENTION_MAX - ordered.filter((p) => p.cert && p.lastAt >= cutoff).length;
    for (const p of ordered) {
      if (p.lastAt < cutoff) removed.push(p.id);
      else if (p.cert) continue;
      else if (room > 0) room--;
      else removed.push(p.id);
    }
    for (const id of removed) drop(id);
    if (removed.length) {
      dirty = true;
      flush();
      emit();
    }
    return removed;
  }

  // ── persistence ───────────────────────────────────────────────────────────
  // Routine updates (a new piece, fresher fingerprints, a later lastAt) are
  // written together a moment after the last one; losing them to a crash only
  // means a piece is recognised by its text again next time.
  function schedule() {
    dirty = true;
    if (writeDelayMs <= 0) { flush(); return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { flush(); } catch { /* the next update or flush() tries again */ }
    }, writeDelayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  // Everything to disk, now (quit, or a test wanting a deterministic state).
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      writeJsonAtomic(indexFile, list());
    } catch (e) {
      dirty = true;
      throw e;
    }
  }

  // Read what a previous run left behind. Pieces already in memory win over
  // their copy on disk.
  function load(nowMs = now()) {
    let arr = readJson(indexFile);
    if (!Array.isArray(arr) && fs.existsSync(indexFile)) {
      // A torn index (crash mid-write) is set aside, not overwritten: the
      // pieces in it are recognised again, as new ones, when their text is.
      try { fs.renameSync(indexFile, `${indexFile}.corrupt-${nowMs}`); } catch { /* ignore */ }
      arr = [];
    }
    for (const raw of arr || []) {
      const p = sanitize(raw);
      if (p && !pieces.has(p.id)) pieces.set(p.id, p);
    }
    bySession.clear();
    for (const p of pieces.values()) for (const s of p.sessions) {
      const cur = pieces.get(bySession.get(s));
      if (!cur || later(p, cur, s)) bySession.set(s, p.id);
    }
    prune(nowMs);
    emit();
    return pieces.size;
  }

  return {
    fingerprint, identify, attach,
    get, list, pieceOf,
    setCert, codeFor,
    remove, prune, load, flush,
    get size() { return pieces.size; },
  };
}

// ── small sync I/O helpers ───────────────────────────────────────────────────
// The index is readable by this user only: the fingerprints are useless without
// the keychain secret, but the document names and paths beside them are not.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);   // a leftover tmp file from a crash keeps its old mode otherwise
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

module.exports = {
  createPieces, overlapMatches,
  KEY_HEX, KEY_MIN, KEYS_MAX, RETENTION_DAYS, RETENTION_MAX, MAX_VERSIONS, MAX_SESSIONS,
};
