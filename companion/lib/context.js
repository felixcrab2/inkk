// inkk companion — which app, and which document, is in front?
//
// Every keystroke is attributed to the frontmost app and the document open in
// it, and that decides which session it belongs to and whether it is captured
// at all (ignored apps, unknown app). The native helper answers from
// NSWorkspace and Accessibility (`front-doc`, a few milliseconds, no Screen
// Recording). Without the helper we ask LaunchServices through `lsappinfo`,
// which knows the app but not the document:
//
//   lsappinfo front                                  → ASN:0x0-0xf00f:
//   lsappinfo info -only name -only bundleid <asn>   → "LSDisplayName"="Notes"
//                                                      "CFBundleIdentifier"="com.apple.Notes"
//
// A document is known by its file when the window says which file it shows,
// otherwise by its window title with the app's passing status taken off
// ("Essay — Edited" is still "Essay"). The key stays on this Mac.

"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const helper = require("./helper");

const POLL_MS = 750;
const EXEC_OPTS = { timeout: 1200, windowsHide: true };
const LABEL_MAX = 80;

function lsappinfo(args) {
  return new Promise((resolve) => {
    execFile("lsappinfo", args, EXEC_OPTS, (err, out) => resolve(err ? "" : String(out || "")));
  });
}

// Some apps register display names with bidi/format marks (WhatsApp ships a
// leading U+200E); invisible characters come off so labels and ignore lists match.
const clean = (t) => String(t || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim();
// Titles are what the writer named things, so the joiners stay: they hold
// emoji sequences together and are part of spelling in Persian and Indic
// scripts. Only the marks that never show come off.
const cleanTitle = (t) => String(t || "").replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim();

function parseInfo(text) {
  const name = /"LSDisplayName"="((?:[^"\\]|\\.)*)"/.exec(text);
  const bundle = /"CFBundleIdentifier"="((?:[^"\\]|\\.)*)"/.exec(text);
  if (!bundle || !bundle[1]) return null;
  return { name: clean((name && name[1]) || bundle[1]) || bundle[1], bundleId: bundle[1] };
}

// Resolve the front app once → { name, bundleId } | null.
async function readFrontApp() {
  const asn = (await lsappinfo(["front"])).trim();
  if (!asn.startsWith("ASN:")) return null;
  return parseInfo(await lsappinfo(["info", "-only", "name", "-only", "bundleid", asn]));
}

// The front app with its document when the helper can say, else the app alone.
async function readFront() {
  if (helper.available()) {
    const d = await helper.frontDoc();
    if (d && d.bundleId) return d;
  }
  return readFrontApp();
}

// What an app says about a document while it works on it, not what the
// document is called.
const STATUS_WORDS = "Edited|Locked|Saved|Saving(?:\\.\\.\\.|…)?|Moved|Renamed|Duplicated|Converted|Read[- ]Only|Compatibility Mode|AutoRecovered|Repaired|Saved to (?:my|this) Mac";
const STATUS_TAIL = new RegExp(`(?:\\s+[-–—]\\s+(?:${STATUS_WORDS})|\\s*\\((?:${STATUS_WORDS})\\)|\\s*\\[(?:${STATUS_WORDS})\\])$`, "i");
// Unread counts come and go while the same thing stays open. A web app puts
// one in front of its tab title ("(3) Messages"); a mailbox puts one after the
// folder, followed by the account or the mail service ("Inbox (12) -
// someone@example.com - Gmail"). Anywhere else a bracketed number is part of
// the name ("Budget (2025)", "Essay (2)") and stays: the title is the
// document's identity.
const COUNT_LEAD = /^\(\d[\d,.]*\+?\)\s+/;
const COUNT_INSIDE = /\s\(\d[\d,.]*\+?\)(?=\s[-–—]\s(?:[^\s@]+@[^\s@]+\.[^\s@]+|.*\b(?:Gmail|Outlook|Fastmail|Mail)$))/g;
// A leading "unsaved" dot.
const DIRTY_LEAD = /^[●•*]\s+/;

function normaliseTitle(title) {
  let t = cleanTitle(String(title || "").normalize("NFC")).replace(/\s+/g, " ");
  for (let prev = null; prev !== t;) {
    prev = t;
    t = t.replace(STATUS_TAIL, "").replace(DIRTY_LEAD, "").replace(COUNT_LEAD, "").trim();
  }
  return t.replace(COUNT_INSIDE, "").trim();
}

// A file URL → its POSIX path (NFC, no trailing slash for a package document),
// anything else → "".
function filePathOf(document) {
  const d = String(document || "");
  if (!/^file:/i.test(d)) return "";
  try {
    let p = fileURLToPath(d).normalize("NFC");
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p;
  } catch { return ""; }
}

function clip(s, max = LABEL_MAX) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : s;
}

// A raw answer → { name, bundleId, pid, title, document, docKey, docLabel }.
// Only a read that answered both title and document has seen the window ("" is
// an answer: no title, no file). One that could not (the app was too busy to
// reply in time, or only the app is known) keeps what was known about the same
// app a moment ago, so a slow moment never sends keys to a document of its own.
function describe(raw, prev = null) {
  if (!raw || !raw.bundleId) return null;
  const bundleId = String(raw.bundleId);
  const name = clean(raw.name) || bundleId;
  const pid = Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  const sees = typeof raw.title === "string" && typeof raw.document === "string";
  if (!sees && prev && prev.bundleId === bundleId) {
    return { ...prev, name, pid: pid ?? prev.pid, docLabel: prev.docKey ? prev.docLabel : clip(name) };
  }
  const title = typeof raw.title === "string" ? raw.title : "";
  const document = typeof raw.document === "string" ? raw.document : "";
  const file = filePathOf(document);
  const normal = normaliseTitle(title);
  const docKey = file ? `file:${file}` : normal ? `title:${normal}` : "";
  const docLabel = clip(file ? path.basename(file) : normal || name);
  return { name, bundleId, pid, title, document, docKey, docLabel };
}

// Poll the front app every POLL_MS. `onChange(front)` fires only when the app
// or the document in it actually changes; `current()` is the last known answer.
// `pollNow()` is for the "first key after a quiet spell" case, where the 750ms
// cadence may lag the switch that just happened.
function createContextPoller({ intervalMs = POLL_MS, onChange = null, read = readFront } = {}) {
  let current = null;
  let timer = null;
  let flight = null;             // the poll in progress, so a second caller waits for its answer

  function pollNow() {
    if (flight) return flight;
    flight = (async () => {
      try {
        const next = describe(await read(), current);
        const changed = (next?.bundleId || null) !== (current?.bundleId || null)
          || (next?.docKey || "") !== (current?.docKey || "");
        current = next;
        if (changed && onChange) onChange(current);
      } catch { /* keep the last answer */ }
      finally { flight = null; }
      return current;
    })();
    return flight;
  }

  return {
    start() { if (!timer) { pollNow(); timer = setInterval(pollNow, intervalMs); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    pollNow,
    current: () => current,
  };
}

module.exports = { createContextPoller, readFront, readFrontApp, parseInfo, describe, normaliseTitle, filePathOf, POLL_MS };
