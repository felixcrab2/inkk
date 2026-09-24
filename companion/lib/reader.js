// inkk companion — reading the document in front, through macOS Accessibility.
//
// Two jobs, both on-device and both discarding the text as soon as they are
// done with it:
//
//   readFocusedText(bundleId)  the text of the focused editor in an app, read
//                              ONCE at certify time so the certificate can be
//                              bound to a fingerprint of the piece. Nothing is
//                              stored; only the SHA-256 leaves the Mac.
//   readVisibleText(bundleId)  the text a window is showing, so the receiver
//                              can notice an inkk code or seal link in an
//                              email or document the user has open. Only the
//                              code itself is looked up.
//
// Both go through osascript → System Events, which needs the Accessibility
// grant the keyboard hook already requires, plus a one-time Automation
// prompt for System Events. Failures return "" and the caller degrades.

"use strict";

const { execFile } = require("node:child_process");

const OPTS = { timeout: 3500, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
const MAX_CHARS = 400000;

function osa(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], OPTS, (err, out) => resolve(err ? "" : String(out || "")));
  });
}

const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The focused element's value in the given process; falls back to the first
// text area of its front window (Pages, TextEdit, Notes expose either).
async function readFocusedText(bundleId) {
  if (!bundleId) return "";
  const script = `
    tell application "System Events"
      set p to first process whose bundle identifier is ${q(bundleId)}
      tell p
        try
          set el to value of attribute "AXFocusedUIElement"
          set v to value of attribute "AXValue" of el
          if v is not missing value and (length of (v as text)) > 0 then return v as text
        end try
        try
          return value of attribute "AXValue" of text area 1 of window 1 as text
        end try
        try
          return value of attribute "AXValue" of text area 1 of scroll area 1 of window 1 as text
        end try
      end tell
    end tell
    return ""`;
  const out = await osa(script);
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) : out;
}

// Whatever text the front window shows: the focused element, the window
// title, and every static text in the window (message bodies in Mail and
// Outlook, most document views). Bounded by the osascript timeout.
async function readVisibleText(bundleId) {
  if (!bundleId) return "";
  const script = `
    tell application "System Events"
      set p to first process whose bundle identifier is ${q(bundleId)}
      set out to ""
      tell p
        try
          set out to out & (name of window 1) & linefeed
        end try
        try
          set el to value of attribute "AXFocusedUIElement"
          set v to value of attribute "AXValue" of el
          if v is not missing value then set out to out & (v as text) & linefeed
        end try
        try
          set out to out & ((value of every static text of window 1) as text) & linefeed
        end try
        try
          set out to out & ((value of attribute "AXValue" of every text area of window 1) as text)
        end try
      end tell
      return out
    end tell`;
  const out = await osa(script);
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) : out;
}

module.exports = { readFocusedText, readVisibleText };
