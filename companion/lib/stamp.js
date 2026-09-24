// inkk companion — the stamper.
//
// When a writer saves the document they have been writing, or exports it to
// PDF or Word, the piece is certified and its code goes into the file. Nobody
// presses anything: the file simply carries its seal wherever it is sent.
//
//   Saving     The front window's document is followed while its app has a
//              writing session. When the file changes on disk and then stays
//              still for a few seconds, its text is read and, if the words have
//              moved on since the last stamp, certified (a new code for a new
//              version) and stamped. A save that drops the stamp (some apps
//              rewrite the whole file) gets the same code back without a new
//              certificate.
//   Exporting  A PDF or Word file that appears anywhere in the home folder
//              (found through Spotlight, so no folder is watched) is compared
//              sentence by sentence with the texts certified in the last two
//              hours. A copy of one of them is stamped with its code; a close
//              variant is certified as a version of its own.
//
// Only fingerprints of certified texts are kept, in memory, never the words.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const QUIET_MS = 4000;               // a file this long unchanged has finished saving
const MIN_KEYSTROKES = 150;          // a session this long is writing, not a filename
const FOLLOW_MS = 30 * 60 * 1000;    // keep following a document this long after it was in front
const RECENT_MS = 2 * 60 * 60 * 1000;
const EXPORT_SCAN_MS = 10000;
const EXPORT_OVERLAP = 0.8;
const MAX_BYTES = 50 * 1024 * 1024;
const MIN_TEXT = 80;
const RECERT_MS = 3 * 60 * 1000;     // autosave can write every few seconds: at most one new version this often

function mdfindNew(seconds) {
  const q = `kMDItemFSCreationDate >= $time.now(-${seconds}) && (kMDItemContentType == "com.adobe.pdf" || kMDItemContentType == "org.openxmlformats.wordprocessingml.document")`;
  return new Promise((resolve) => {
    execFile("mdfind", ["-onlyin", os.homedir(), q], { timeout: 4000, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve(err ? [] : String(out).split("\n").filter(Boolean));
    });
  });
}

function createStamper({
  docmeta, helper, reader, scoring, sha,
  getFront, findSession, certifyText, onStamp = () => {},
  isEnabled = () => true, backupsDir = null, log = () => {}, now = Date.now, findNew = mdfindNew,
}) {
  const followed = new Map();   // path → { bundleId, sessionId, seenAt, mtime, size, stampedHash, code }
  const recent = [];            // { code, sessionId, contentHash, sketch, at }
  const handled = new Set();    // export paths already looked at
  let busy = false;
  let lastExportScan = 0;

  const skip = (p) => {
    const b = path.basename(p);
    return b.startsWith("~$") || b.startsWith(".") || p.includes("/Library/") || p.includes("/.Trash/");
  };

  function remember({ code, sessionId, contentHash, sketch }) {
    if (!code || !contentHash) return;
    const i = recent.findIndex((r) => r.code === code);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift({ code, sessionId, contentHash, sketch: sketch || [], at: now() });
    recent.length = Math.min(recent.length, 50);
  }

  async function frontDocument() {
    const front = getFront();
    if (!front || !front.bundleId) return null;
    const pid = await reader.pidOf(front.bundleId);
    let win = null;
    if (pid && helper && helper.available()) {
      const r = await helper.run(["ax-doc", String(pid)], { timeout: 2000 });
      if (r && !r.error) win = r;
    }
    const p = await reader.readDocumentPath(front, win || { title: front.title || "" });
    return p ? { path: p, bundleId: front.bundleId } : null;
  }

  async function stampWith(p, code, extra) {
    const r = await docmeta.writeStamp(p, { code }, { helper, backupsDir, now: now() });
    try { const st = fs.statSync(p); const f = followed.get(p); if (f) { f.mtime = st.mtimeMs; f.size = st.size; } } catch { /* gone */ }
    onStamp({ path: p, code, kinds: r.kinds, ok: r.ok, error: r.error, ...extra });
    return r;
  }

  // One followed document: has it been saved since we last looked?
  async function checkSaved(p, f) {
    let st;
    try { st = fs.statSync(p); } catch { followed.delete(p); return; }
    if (!st.isFile() || st.size > MAX_BYTES) return;
    const changed = st.mtimeMs !== f.mtime || st.size !== f.size;
    if (!changed && !f.pending) return;
    if (now() - st.mtimeMs < QUIET_MS) return;              // still being written
    f.mtime = st.mtimeMs; f.size = st.size; f.pending = false;
    const text = await docmeta.extractText(p, { helper });
    if (!text || text.trim().length < MIN_TEXT) return;
    const hash = await scoring.textFingerprint(text, sha);
    if (hash === f.stampedHash) {
      // Same words. Put the code back if the save dropped it.
      const s = await docmeta.readStamp(p, { helper });
      if (!s && f.code) await stampWith(p, f.code, { reason: "restored" });
      return;
    }
    if (f.lastCertAt && now() - f.lastCertAt < RECERT_MS) { f.pending = true; return; }
    const out = await certifyText({ sessionId: f.sessionId, text, source: "file", path: p });
    if (!out || !out.ok) { log(`stamp: certify failed for ${path.basename(p)}: ${out && out.error}`); return; }
    f.stampedHash = hash;
    f.code = out.cert.code;
    f.lastCertAt = now();
    await stampWith(p, out.cert.code, { reason: "saved", cert: out.cert });
  }

  async function scanExports() {
    lastExportScan = now();
    const live = recent.filter((r) => now() - r.at < RECENT_MS);
    if (!live.length) return;
    for (const p of await findNew(Math.ceil(EXPORT_SCAN_MS / 1000) * 3 + 30)) {
      if (handled.has(p) || skip(p) || followed.has(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_BYTES || now() - st.mtimeMs < QUIET_MS) continue;   // not finished yet: next scan
      handled.add(p);
      if (await docmeta.readStamp(p, { helper })) continue;
      const text = await docmeta.extractText(p, { helper });
      if (!text || text.trim().length < MIN_TEXT) continue;
      const hash = await scoring.textFingerprint(text, sha);
      const exact = live.find((r) => r.contentHash === hash);
      if (exact) { await stampWith(p, exact.code, { reason: "exported" }); continue; }
      const sketch = await scoring.textSketch(text, sha);
      if (!sketch.length) continue;
      const have = new Set(sketch);
      let best = null, bestRatio = 0;
      for (const r of live) {
        if (!r.sketch.length) continue;
        const ratio = r.sketch.filter((k) => have.has(k)).length / Math.max(r.sketch.length, sketch.length);
        if (ratio > bestRatio) { best = r; bestRatio = ratio; }
      }
      if (!best || bestRatio < EXPORT_OVERLAP) continue;
      const out = await certifyText({ sessionId: best.sessionId, text, source: "file", path: p });
      if (out && out.ok) await stampWith(p, out.cert.code, { reason: "exported", cert: out.cert });
    }
    if (handled.size > 2000) handled.clear();
  }

  async function tick() {
    if (busy || !isEnabled()) return;
    busy = true;
    try {
      const doc = await frontDocument();
      if (doc) {
        const session = findSession(doc.bundleId);
        if (session && session.keystrokes >= MIN_KEYSTROKES) {
          let f = followed.get(doc.path);
          if (!f) {
            let st = null;
            try { st = fs.statSync(doc.path); } catch { /* gone */ }
            // Start from the file as it is now; the next save is what gets stamped.
            f = { bundleId: doc.bundleId, sessionId: session.id, mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0, stampedHash: null, code: null };
            followed.set(doc.path, f);
          }
          f.sessionId = session.id;
          f.seenAt = now();
        }
      }
      for (const [p, f] of followed) {
        if (now() - f.seenAt > FOLLOW_MS) { followed.delete(p); continue; }
        await checkSaved(p, f);
      }
      if (now() - lastExportScan >= EXPORT_SCAN_MS) await scanExports();
    } catch (e) { log(`stamp: ${e.message}`); }
    finally { busy = false; }
  }

  return { tick, remember, followed: () => [...followed.keys()] };
}

module.exports = { createStamper, QUIET_MS, MIN_KEYSTROKES };
