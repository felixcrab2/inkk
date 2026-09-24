// inkk companion — uiohook keycode → DOM-style key name.
//
// capture.js speaks the web recorder's `e.key` convention ("a", "Space",
// "Backspace", "ArrowLeft"…). uiohook reports numeric scancodes. The map is
// built from UiohookKey so it tracks the library's constants, and it is
// deliberately layout-agnostic: a letter key is a letter for rhythm purposes
// whatever the keyboard layout, and no letter is ever written down anyway.

"use strict";

function buildKeymap(UiohookKey) {
  const map = new Map();
  if (!UiohookKey) return map;
  const put = (prop, name) => { if (UiohookKey[prop] != null) map.set(UiohookKey[prop], name); };
  for (let c = 65; c <= 90; c++) put(String.fromCharCode(c), String.fromCharCode(c + 32)); // A→a … Z→z
  for (let d = 0; d <= 9; d++) put(String(d), String(d));
  const pairs = {
    Space: "Space", Enter: "Enter", Backspace: "Backspace", Delete: "Delete",
    Tab: "Tab", Escape: "Escape", CapsLock: "CapsLock",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    Shift: "Shift", ShiftRight: "Shift", Ctrl: "Control", CtrlRight: "Control",
    Alt: "Alt", AltRight: "Alt", Meta: "Meta", MetaRight: "Meta",
    Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
    Minus: "-", Equal: "=", Backslash: "\\", Backquote: "`",
    BracketLeft: "[", BracketRight: "]", LeftBracket: "[", RightBracket: "]",   // both spellings, whichever the lib exports
    NumpadEnter: "Enter", NumpadDecimal: ".", NumpadAdd: "+", NumpadSubtract: "-",
    NumpadMultiply: "*", NumpadDivide: "/", Insert: "Insert",
  };
  for (let d = 0; d <= 9; d++) put(`Numpad${d}`, String(d));
  for (const [prop, name] of Object.entries(pairs)) put(prop, name);
  return map;
}

// recorder-style modifier string, e.g. "M", "C", "MS". Shift alone is typing.
function modString(e) {
  return [e.shiftKey && "S", e.ctrlKey && "C", e.altKey && "A", e.metaKey && "M"].filter(Boolean).join("");
}

module.exports = { buildKeymap, modString };
