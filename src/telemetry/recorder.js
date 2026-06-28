// Telemetry recorder: captures keydown/keyup/input/paste/selection/focus events
// from the contenteditable editor, records the key identity (letters, digits and
// punctuation) alongside precise timing so the encoder can model keyboard-geometry
// effects (e.g. faster digraphs for keys that sit closer together), tags them with
// the current session_id, and pushes them into both an in-memory ring (for live
// feature extraction) and the IndexedDB queue (for offline-safe persistence and
// optional cloud sync). Key capture is disclosed in the Privacy Policy.

import * as store from "./store";

const SCHEMA_VERSION = 2;                // bump whenever the event shape changes
const SESSION_GAP_MS = 60_000;           // inactivity that ends a session
const MEMORY_LIMIT   = 8000;             // events kept in memory for features
const FLUSH_MS       = 4000;             // periodic flush to IndexedDB
const FLUSH_AT       = 80;               // flush when N events buffered
const SELECTION_HZ   = 20;               // sample selectionchange at 20 Hz (caret/drag only — typing is NOT throttled; every key is captured)

function uuid() {
  try { return crypto.randomUUID(); } catch { return "_" + Math.random().toString(36).slice(2) + Date.now(); }
}

// High-resolution, monotonic time in ms (sub-millisecond where the browser
// allows it). Unlike Date.now() this never jumps on NTP sync / sleep / wake,
// so inter-keystroke and dwell deltas derived from it are clean. We store it
// *alongside* the wall-clock `t` (which we still need to align sessions to a
// real calendar). Returns null in environments without `performance`.
function nowPerf() {
  try {
    const p = (typeof performance !== "undefined" && performance.now) ? performance.now() : null;
    return p == null ? null : Math.round(p * 1000) / 1000;
  } catch { return null; }
}

function classifyKey(key) {
  if (!key) return ["other", null];
  if (key === " " || key === "Spacebar" || key === "Space") return ["space", null];
  if (key === "Enter") return ["edit", null];
  if (key === "Backspace" || key === "Delete") return ["edit", null];
  if (key === "Tab") return ["edit", null];
  if (key === "Escape") return ["edit", null];
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(key)) return ["nav", null];
  if (["Shift","Control","Alt","Meta","CapsLock"].includes(key)) return ["modifier", null];
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key))    return ["letter", key];       // key identity stored (digraph geometry)
    if (/[0-9]/.test(key))       return ["digit",  key];
    if (/[\s]/.test(key))        return ["space",  null];
    // Punctuation / symbol.
    return ["punct", key];
  }
  return ["other", null];
}

// Device / environment context recorded once per session (on session_start).
// These are confounds the encoder needs to control for: input modality, OS,
// language, time zone (→ local time-of-day / circadian effects), and viewport
// (→ device class). Disclosed in the Privacy Policy (see components/Legal.js)
// and deliberately coarse — no raw User-Agent string, no precise geolocation.
function envContext() {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const ctx = {
      touch_capable:  (nav.maxTouchPoints || 0) > 0,
      pointer_coarse: (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) || false,
      platform:       nav.userAgentData?.platform || nav.platform || null,
      locale:         (nav.languages && nav.languages[0]) || nav.language || null,
    };
    try { ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch {}
    try {
      if (typeof window !== "undefined") {
        ctx.viewport_w = window.innerWidth  || null;
        ctx.viewport_h = window.innerHeight || null;
        ctx.dpr        = window.devicePixelRatio || null;
      }
    } catch {}
    return ctx;
  } catch {
    return null;
  }
}

function getCaretInfo() {
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { caret: null, selLen: 0 };
    const r = sel.getRangeAt(0);
    // Offset within container — useful for caret-jump detection. We don't
    // store node identity, just an integer that monotonically reflects position.
    const range = document.createRange();
    range.selectNodeContents(r.startContainer.ownerDocument.body);
    range.setEnd(r.startContainer, r.startOffset);
    const caret = range.toString().length;
    const selLen = sel.isCollapsed ? 0 : r.toString().length;
    return { caret, selLen };
  } catch {
    return { caret: null, selLen: 0 };
  }
}

export function createRecorder({ getContext, onUpdate }) {
  // ── state ──────────────────────────────────────────────────────────────────
  let editor = null;
  let memory = [];                       // in-memory ring of events
  let pending = [];                      // not-yet-persisted to IndexedDB
  let sessionId = null;
  let sessionStartedAt = 0;
  let seq = 0;                           // per-session monotonic event index
  let composing = false;                 // inside an IME composition (key→text is indirect)
  let lastActivityT = 0;
  let lastDocId = null;
  let lastUserId = null;
  let lastSelEmitT = 0;
  let flushTimer = null;
  let attached = false;
  let detached = false;
  // After a paste event, the app converts to plain text via execCommand which
  // re-emits as a `beforeinput insertText` of the same length. Suppress it so
  // we don't double-count those characters as typing.
  let pasteSuppressLen = 0;
  let pasteSuppressUntil = 0;

  function ctx() {
    const c = getContext?.() || {};
    return { userId: c.userId || null, docId: c.docId || null, optedIn: !!c.optedIn };
  }

  function nowMs() { return Date.now(); }

  function maybeRollSession(t) {
    const { docId, userId } = ctx();
    const gap = lastActivityT ? (t - lastActivityT) : Infinity;
    const docChanged = lastDocId && docId && lastDocId !== docId;
    const userChanged = lastUserId !== userId;
    if (!sessionId || gap >= SESSION_GAP_MS || docChanged || userChanged) {
      if (sessionId) {
        // Tag session_end with the *previous* doc/user, then roll.
        push({ kind: "session_end", t: lastActivityT || t, _doc: lastDocId, _user: lastUserId }, true);
      }
      sessionId = uuid();
      sessionStartedAt = t;
      seq = 0;                           // restart the ordering index for the new session
      lastDocId = docId;
      lastUserId = userId;
      // Stamp one-time environment context on the session opener so the encoder
      // can control for input modality (a hard confound: touch / IME / speech
      // produce very different keystroke dynamics from a physical keyboard).
      push({ kind: "session_start", t, payload: envContext() }, true);
    }
  }

  function push(partial, rollGuard = false) {
    const { userId, docId } = ctx();
    const useDocId  = partial._doc  ?? docId;
    const useUserId = partial._user ?? userId;
    if (!useDocId) return;
    const t = partial.t || nowMs();
    if (!rollGuard) maybeRollSession(t);
    const ev = {
      id: uuid(),
      schema_version: SCHEMA_VERSION,
      user_id: useUserId,
      doc_id: useDocId,
      session_id: sessionId,
      seq: seq++,                          // deterministic within-session ordering (breaks same-ms ties)
      t,                                   // wall-clock epoch ms (calendar alignment)
      pt: partial.pt ?? nowPerf(),         // monotonic hi-res ms (precise IKI / dwell)
      kind: partial.kind,
      key_class: partial.key_class ?? null,
      key_char: partial.key_char ?? null,
      input_type: partial.input_type ?? null,
      len_delta: partial.len_delta ?? null,
      caret_pos: partial.caret_pos ?? null,
      selection_len: partial.selection_len ?? null,
      payload: partial.payload ?? null,
    };
    memory.push(ev);
    if (memory.length > MEMORY_LIMIT) memory.splice(0, memory.length - MEMORY_LIMIT);
    pending.push(ev);
    if (partial.kind !== "session_start" && partial.kind !== "session_end") {
      lastActivityT = t;
    }
    if (pending.length >= FLUSH_AT) flushSoon(0);
    onUpdate?.();
  }

  function flushSoon(delay = FLUSH_MS) {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (batch.length) await store.enqueue(batch);
    }, delay);
  }

  // ── handlers ───────────────────────────────────────────────────────────────
  function onKeyDown(e) {
    const [kc, ch] = classifyKey(e.key);
    push({
      kind: "keydown",
      key_class: kc,
      key_char: ch,                        // literal key for letters/digits/punct; null otherwise
      payload: e.shiftKey || e.metaKey || e.ctrlKey || e.altKey
        ? { mods: [e.shiftKey && "S", e.ctrlKey && "C", e.altKey && "A", e.metaKey && "M"].filter(Boolean).join("") }
        : null,
    });
  }
  function onKeyUp(e) {
    const [kc, ch] = classifyKey(e.key);
    push({ kind: "keyup", key_class: kc, key_char: ch });
  }
  function onBeforeInput(e) {
    const { caret, selLen } = getCaretInfo();
    const it = e.inputType || null;
    const isDelete  = it && it.startsWith("delete");
    const isPasteIt = it === "insertFromPaste" || it === "insertFromDrop";
    const text = (e.data ?? "") || "";
    // Suppress the synthetic insertText that follows an app-intercepted paste.
    if (it === "insertText" && pasteSuppressLen > 0 && nowMs() <= pasteSuppressUntil) {
      if (text.length === pasteSuppressLen || (text.length >= 4 && Math.abs(text.length - pasteSuppressLen) <= 1)) {
        pasteSuppressLen = 0; pasteSuppressUntil = 0;
        return;
      }
    }
    const len = isDelete ? -Math.max(1, selLen || 1) : text.length;
    let payload = null;
    if (isPasteIt && text.length) payload = { paste_len: text.length };
    // Mark text produced via IME composition (CJK, mobile autocorrect/swipe):
    // here keystroke→character is indirect, so per-key timing is not a clean
    // keystroke-dynamics signal and the encoder should treat it separately.
    if (composing) payload = { ...(payload || {}), composing: true };
    push({
      kind: isPasteIt ? "paste" : (isDelete ? "delete" : "input"),
      input_type: it,
      len_delta: len,
      caret_pos: caret,
      selection_len: selLen,
      // Inserted text for typed/IME input (handles mobile/autocorrect where
      // keydown carries no usable key). Pasted text is not duplicated here.
      key_char: (!isPasteIt && !isDelete && text) ? text : null,
      payload,
    });
  }
  function onCompositionStart() {
    composing = true;
    push({ kind: "compose_start" });
  }
  function onCompositionEnd(e) {
    const len = (e?.data ?? "").length;
    composing = false;
    push({ kind: "compose_end", len_delta: len, payload: len ? { composed_len: len } : null });
  }
  function onPaste(e) {
    const text = e.clipboardData?.getData("text/plain") || "";
    const { caret } = getCaretInfo();
    if (text.length) {
      pasteSuppressLen   = text.length;
      pasteSuppressUntil = nowMs() + 200;
    }
    push({
      kind: "paste",
      input_type: "insertFromPaste",
      len_delta: text.length,
      caret_pos: caret,
      payload: { paste_len: text.length },
    });
  }
  function onDrop() {
    const { caret } = getCaretInfo();
    push({ kind: "drop", caret_pos: caret });
  }
  function onSelectionChange() {
    const t = nowMs();
    if (t - lastSelEmitT < (1000 / SELECTION_HZ)) return;
    lastSelEmitT = t;
    // only emit if selection is inside our editor
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor) return;
    if (!editor.contains(sel.anchorNode)) return;
    const { caret, selLen } = getCaretInfo();
    push({ kind: "caret", caret_pos: caret, selection_len: selLen, t });
  }
  function onFocus() { push({ kind: "focus" }); }
  function onBlur()  { push({ kind: "blur" });  flushSoon(0); }
  function onVisibility() {
    push({ kind: "visibility", payload: { hidden: document.hidden } });
    if (document.hidden) flushSoon(0);
  }
  function onBeforeUnload() { flushSoon(0); }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  function attach(el) {
    if (attached || detached) return;
    editor = el;
    if (!editor) return;
    editor.addEventListener("keydown", onKeyDown);
    editor.addEventListener("keyup", onKeyUp);
    editor.addEventListener("beforeinput", onBeforeInput);
    editor.addEventListener("compositionstart", onCompositionStart);
    editor.addEventListener("compositionend", onCompositionEnd);
    editor.addEventListener("paste", onPaste);
    editor.addEventListener("drop", onDrop);
    editor.addEventListener("focus", onFocus);
    editor.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    attached = true;
  }

  function detach() {
    if (!attached || detached) return;
    detached = true;
    if (editor) {
      editor.removeEventListener("keydown", onKeyDown);
      editor.removeEventListener("keyup", onKeyUp);
      editor.removeEventListener("beforeinput", onBeforeInput);
      editor.removeEventListener("compositionstart", onCompositionStart);
      editor.removeEventListener("compositionend", onCompositionEnd);
      editor.removeEventListener("paste", onPaste);
      editor.removeEventListener("drop", onDrop);
      editor.removeEventListener("focus", onFocus);
      editor.removeEventListener("blur", onBlur);
    }
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", onBeforeUnload);
    flushSoon(0);
    attached = false;
  }

  function recordDocSwitch(newDocId) {
    if (sessionId && lastDocId) {
      push({ kind: "session_end", t: nowMs(), _doc: lastDocId, _user: lastUserId }, true);
      sessionId = null;
    }
    if (lastDocId) {
      push({ kind: "doc_switch", payload: { from: lastDocId, to: newDocId }, _doc: lastDocId, _user: lastUserId }, true);
    }
    lastDocId = newDocId;
  }

  function recordUserChange(newUserId) {
    if (sessionId && lastDocId) {
      push({ kind: "session_end", t: nowMs(), _doc: lastDocId, _user: lastUserId }, true);
      sessionId = null;
    }
    lastUserId = newUserId;
  }

  function snapshot(docId) {
    if (!docId) return { events: [], sessionId, startedAt: sessionStartedAt };
    return {
      events: memory.filter(e => e.doc_id === docId),
      sessionId,
      startedAt: sessionStartedAt,
    };
  }

  function getPending() { return [...pending]; }

  return {
    attach, detach,
    snapshot,
    recordDocSwitch,
    recordUserChange,
    flushNow: () => flushSoon(0),
    getPending,
    _memory: () => memory,                  // exposed for tests only
  };
}
