// inkk companion — which app is in front?
//
// Every keystroke is attributed to the frontmost app, and that is what decides
// which session it belongs to and whether it is captured at all (ignored apps,
// unknown app). We ask LaunchServices directly via `lsappinfo`: it needs no
// permission, no Apple Events entitlement and no osascript round-trip.
//
//   lsappinfo front                                  → ASN:0x0-0xf00f:
//   lsappinfo info -only name -only bundleid <asn>   → "LSDisplayName"="Notes"
//                                                      "CFBundleIdentifier"="com.apple.Notes"

"use strict";

const { execFile } = require("node:child_process");

const POLL_MS = 750;
const EXEC_OPTS = { timeout: 1200, windowsHide: true };

function lsappinfo(args) {
  return new Promise((resolve) => {
    execFile("lsappinfo", args, EXEC_OPTS, (err, out) => resolve(err ? "" : String(out || "")));
  });
}

function parseInfo(text) {
  const name = /"LSDisplayName"="((?:[^"\\]|\\.)*)"/.exec(text);
  const bundle = /"CFBundleIdentifier"="((?:[^"\\]|\\.)*)"/.exec(text);
  if (!bundle || !bundle[1]) return null;
  // Some apps register display names with bidi/format marks (WhatsApp ships a
  // leading U+200E); strip invisible characters so labels and ignore lists match.
  const clean = (t) => t.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim();
  return { name: clean((name && name[1]) || bundle[1]) || bundle[1], bundleId: bundle[1] };
}

// Resolve the front app once → { name, bundleId } | null.
async function readFrontApp() {
  const asn = (await lsappinfo(["front"])).trim();
  if (!asn.startsWith("ASN:")) return null;
  return parseInfo(await lsappinfo(["info", "-only", "name", "-only", "bundleid", asn]));
}

// Poll the front app every POLL_MS. `onChange(app)` fires only when the bundle
// id actually changes; `current()` is the last known answer. `pollNow()` is for
// the "first key after a quiet spell" case, where the 750ms cadence may lag the
// app switch that just happened.
function createContextPoller({ intervalMs = POLL_MS, onChange = null, read = readFrontApp } = {}) {
  let current = null;
  let timer = null;
  let flight = null;             // the poll in progress, so a second caller waits for its answer

  function pollNow() {
    if (flight) return flight;
    flight = (async () => {
      try {
        const next = await read();
        const changed = (next?.bundleId || null) !== (current?.bundleId || null);
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

module.exports = { createContextPoller, readFrontApp, parseInfo, POLL_MS };
