// inkk companion — physical-key → telemetry-event translation.
//
// The web recorder (src/telemetry/recorder.js) gets two streams from the
// browser: raw key events (keydown/keyup) AND semantic edit events (input/
// delete/paste, via `beforeinput`). Outside a browser there is no InputEvent,
// so this module RECONSTRUCTS the semantic stream from physical keys:
//
//   • a printable key press  → keydown + keyup (for dwell) AND an `input`
//     event len_delta +1 (for IKI / pauses / bursts / velocity)
//   • Backspace / Delete     → keydown + keyup AND a `delete` event -1
//   • ⌘V                     → a `paste` event len_delta +clipboardLen
//   • an arrow / nav key     → keydown + keyup AND a `caret` event
//
// The output objects are byte-for-byte the shape `extractFeatures` consumes
// (see the writing_event_batches rows), so the SAME server-side scorer judges
// companion sessions and web sessions identically — no fork of the algorithm.
//
// PRIVACY: content-free by default. `key_char` (the literal letters) is what
// would let anyone reconstruct the text; features.js/score.js never read it, so
// we drop it. The companion therefore captures the RHYTHM of writing and, by
// construction, cannot see WHAT was written. Flip CAPTURE_KEY_CHAR only if a
// future encoder needs digraph geometry and the consent covers it.
//
// Pure and dependency-free (no Electron, no uiohook) so it unit-tests in plain
// Node. The Electron main process maps uiohook keycodes to the `name` strings
// used here (DOM `e.key` convention) and feeds them in.

"use strict";

const SCHEMA_VERSION = 2;
const CAPTURE_KEY_CHAR = false; // see PRIVACY note above

// Mirror of recorder.js `classifyKey`, keyed on DOM-style names.
function classifyKey(name) {
  if (!name) return ["other", null];
  if (name === " " || name === "Space" || name === "Spacebar") return ["space", null];
  if (name === "Enter") return ["edit", null];
  if (name === "Backspace" || name === "Delete") return ["edit", null];
  if (name === "Tab") return ["edit", null];
  if (name === "Escape") return ["edit", null];
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(name)) return ["nav", null];
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(name)) return ["modifier", null];
  if (name.length === 1) {
    if (/[a-zA-Z]/.test(name)) return ["letter", name];
    if (/[0-9]/.test(name)) return ["digit", name];
    if (/\s/.test(name)) return ["space", null];
    return ["punct", name];
  }
  return ["other", null];
}

const PRINTABLE = new Set(["letter", "digit", "punct", "space"]);

// Create a capture session. `opts`:
//   userId, docId        identity stamped on every event
//   sessionId            uuid for this run (one "session_start")
//   genId()              → uuid v4 for each event id
//   now()                → wall-clock ms (Date.now)
//   hrnow()              → monotonic ms (performance.now) for `pt`
function createCapture({ userId, docId, sessionId, genId, now, hrnow }) {
  let seq = 0;
  let caret = 0;                 // running caret; best-effort outside the app
  const down = new Map();        // key_class → [names] pressed, for keyup pairing
  const events = [];

  function push(partial) {
    events.push({
      t: now(),
      id: genId(),
      pt: hrnow(),
      seq: seq++,
      kind: partial.kind,
      doc_id: docId,
      payload: partial.payload ?? null,
      user_id: userId,
      key_char: CAPTURE_KEY_CHAR ? (partial.key_char ?? null) : null,
      caret_pos: partial.caret_pos ?? null,
      key_class: partial.key_class ?? null,
      len_delta: partial.len_delta ?? null,
      input_type: partial.input_type ?? null,
      session_id: sessionId,
      selection_len: partial.selection_len ?? null,
      schema_version: SCHEMA_VERSION,
    });
  }

  function start(envPayload) {
    seq = 0;
    push({ kind: "session_start", payload: envPayload || null });
  }

  // `mods` is a recorder-style string of held modifiers, e.g. "M", "C", "MS".
  // A command chord (⌘/Ctrl/Alt held) is an action, not typed text, so it emits
  // the physical keydown/keyup (dwell still counts) but no input/delete. ⌘V is
  // surfaced separately by the caller via paste().
  function keydown(name, mods) {
    const [kc, ch] = classifyKey(name);
    down.set(kc, (down.get(kc) || []).concat(name));
    push({ kind: "keydown", key_class: kc, key_char: ch, payload: mods ? { mods } : null });

    const chord = !!mods && /[MCA]/.test(mods);   // Shift alone is normal typing
    if (chord) return;

    if (PRINTABLE.has(kc) || name === "Enter") {
      caret += 1;
      push({ kind: "input", len_delta: 1, caret_pos: caret, key_char: ch, input_type: "insertText" });
    } else if (name === "Backspace" || name === "Delete") {
      caret = Math.max(0, caret - 1);
      push({ kind: "delete", len_delta: -1, caret_pos: caret, input_type: "deleteContentBackward" });
    } else if (kc === "nav") {
      if (name === "ArrowLeft") caret = Math.max(0, caret - 1);
      else if (name === "ArrowRight") caret += 1;
      push({ kind: "caret", caret_pos: caret, selection_len: 0 });
    }
  }

  function keyup(name) {
    const [kc, ch] = classifyKey(name);
    const q = down.get(kc);
    if (q && q.length) q.shift();
    push({ kind: "keyup", key_class: kc, key_char: ch });
  }

  // A clipboard paste (⌘V). `len` = characters pasted (read from the clipboard
  // in the main process; the text itself never enters an event).
  function paste(len) {
    const n = Math.max(0, len | 0);
    caret += n;
    push({ kind: "paste", len_delta: n, caret_pos: caret, input_type: "insertFromPaste", payload: n ? { paste_len: n } : null });
  }

  function stop() {
    push({ kind: "session_end" });
  }

  return {
    start, keydown, keyup, paste, stop,
    get events() { return events; },
    drain() { return events.splice(0, events.length); },
    get caret() { return caret; },
  };
}

module.exports = { createCapture, classifyKey, SCHEMA_VERSION, CAPTURE_KEY_CHAR };
