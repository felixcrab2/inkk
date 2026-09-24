// inkk companion — reading what is on screen, through macOS Accessibility.
//
// Three jobs, all on this Mac, and the text is dropped as soon as each is done:
//
//   readFocusedText(bundleId)  the piece being written, read once at certify
//                              time so the certificate can hold a fingerprint
//                              of it. Only the fingerprint leaves the Mac.
//   readWindow(front)          everything the front window shows: its text, its
//                              link addresses and its image descriptions, so an
//                              inkk code or seal is noticed wherever it appears
//                              (an email, a message, a web page, a signature).
//   readDocumentPath(front)    the file behind the front window, so the code in
//                              its metadata can be read and its text checked.
//
// The native helper does the reading when it is built (fast, and it sees links
// and images); otherwise osascript and System Events do what they can.

"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const helper = require("./helper");

const OPTS = { timeout: 3500, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
const MAX_CHARS = 400000;
const clip = (s) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s);

function exec(cmd, args, opts = OPTS) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, out) => resolve(err ? "" : String(out || "")));
  });
}
const osa = (script) => exec("osascript", ["-e", script]);
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function pidOf(bundleId) {
  const out = await exec("lsappinfo", ["info", "-only", "pid", bundleId], { timeout: 1200 });
  const m = /"pid"=(\d+)/.exec(out);
  return m ? +m[1] : null;
}

async function readFocusedText(bundleId) {
  if (!bundleId) return "";
  if (helper.available()) {
    const pid = await pidOf(bundleId);
    const r = pid ? await helper.run(["ax-focused", String(pid)], { timeout: 4000 }) : null;
    if (r && typeof r.text === "string" && r.text.trim()) return clip(r.text);
  }
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
  return clip(await osa(script));
}

// → { title, document, text, links: [], images: [] }
async function readWindow(front) {
  const empty = { title: "", document: "", text: "", links: [], images: [] };
  if (!front || !front.bundleId) return empty;
  if (helper.available()) {
    const pid = front.pid || (await pidOf(front.bundleId));
    const r = pid ? await helper.run(["ax-window", String(pid)], { timeout: 4000 }) : null;
    if (r && !r.error) {
      return { title: r.title || "", document: r.document || "", text: clip(r.text || ""), links: r.links || [], images: r.images || [] };
    }
  }
  const script = `
    tell application "System Events"
      set p to first process whose bundle identifier is ${q(front.bundleId)}
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
  return { ...empty, text: clip(await osa(script)) };
}

// The legacy entry point: the window's text only.
async function readVisibleText(bundleId) {
  const w = await readWindow({ bundleId });
  return [w.title, w.text, ...w.links, ...w.images].join("\n");
}

const DOC_EXT = /\.(docx|pdf|pages|rtf|rtfd|doc|odt|txt|md|markdown|html?)$/i;

// A window's document: its AXDocument when the app publishes one, else a file
// whose name matches the window title that was changed in the last two days.
async function readDocumentPath(front, win) {
  const doc = win && win.document;
  if (doc && doc.startsWith("file://")) {
    try {
      const p = decodeURIComponent(new URL(doc).pathname);
      if (fs.existsSync(p)) return p;
    } catch { /* not a file URL */ }
  }
  const title = String((win && win.title) || (front && front.title) || "").replace(/\s+[-—–]\s+(Edited|Locked|Saved|Word|Pages|Preview)$/i, "").trim();
  if (!title || title.length < 3 || /^(Untitled|Document\d*|Inbox|New Message)\b/i.test(title)) return null;
  const base = title.replace(/["\\*]/g, "");
  const query = DOC_EXT.test(base)
    ? `kMDItemFSName == "${base}"c && kMDItemContentModificationDate >= $time.today(-2)`
    : `kMDItemFSName == "${base}.*"c && kMDItemContentModificationDate >= $time.today(-2)`;
  const out = await exec("mdfind", ["-onlyin", require("node:os").homedir(), query], { timeout: 2500, maxBuffer: 1024 * 1024 });
  const hits = out.split("\n").filter((p) => p && DOC_EXT.test(p) && !path.basename(p).startsWith("~$"));
  if (!hits.length) return null;
  hits.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; } });
  return hits[0];
}

module.exports = { readFocusedText, readVisibleText, readWindow, readDocumentPath, pidOf };
