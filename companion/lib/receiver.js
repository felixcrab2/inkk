// inkk companion — the receiver.
//
// While you read, inkk notices. Whatever window is in front (an email, a
// message thread, a document, a web page) is looked at on this Mac for an inkk
// code, in the places a code can travel:
//
//   text     a code or seal link typed or pasted into the words
//   link     a seal link behind a word or a picture (a signed email's name)
//   image    a picture's description (the signed name carries its code there)
//   file     the metadata of the document the window has open
//   mark     the pixels of a signed name, when reading pictures is switched on
//   ocr      words inside a picture, when reading pictures is switched on
//
// A code that turns up is looked up in the ledger (only the code is sent) and
// the certificate is checked against the text actually in front of you: the
// file's text for a document, the window's text otherwise. The result is the
// seal the popover shows and the notification that says so.

"use strict";

const codes = require("./codes");

const SETTLE_MS = 700;           // let a newly focused window draw before reading it
const FAST_MS = 5000;            // look again this often for the first minute…
const FAST_FOR_MS = 60000;
const SLOW_MS = 30000;           // …then this often
const SPARSE_TEXT = 200;         // below this much text, a picture probably holds the words
const MAX_CODES = 3;             // certificates checked per window

function createReceiver({
  helper, reader, docmeta, mark = null, lookup, scoring, sha,
  getFront, ownBundleId = null, isIgnored = () => false, isEnabled = () => true, canReadPictures = () => false,
  onSeal = () => {}, log = () => {}, now = Date.now,
}) {
  let seal = null;
  let windowKey = null;          // what "the same window" means: app + window id + title
  let windowSince = 0;
  let nextAt = 0;
  let busy = false;
  let lastPictureKey = null;     // the window content last photographed, so an unchanged window isn't captured again
  let lastPicture = null;        // …and what that capture found

  const set = (next) => {
    const same = (a, b) => (!a && !b) || (a && b && a.code === b.code && a.bundleId === b.bundleId
      && (a.match && a.match.state) === (b.match && b.match.state) && !!a.cert === !!b.cert);
    if (same(seal, next)) { if (seal && next) seal.seenAt = next.seenAt; return; }
    seal = next;
    onSeal(seal);
  };

  async function front() {
    const w = helper && helper.available() ? await helper.frontWindow() : null;
    const app = getFront ? getFront() : null;
    if (w && w.bundleId) return { ...w, name: (app && app.bundleId === w.bundleId && app.name) || w.owner };
    return app ? { bundleId: app.bundleId, name: app.name, title: "" } : null;
  }

  function codesIn(win) {
    const out = [];
    const add = (list, source) => { for (const code of list) if (!out.some((c) => c.code === code)) out.push({ code, source }); };
    add(codes.findCodes(win.links.join("\n")), "link");
    add(codes.findCodes(win.images.join("\n")), "image");
    add(codes.findCodes(`${win.title}\n${win.text}`), "text");
    return out;
  }

  async function lookAtPictures(f, win, pictureKey) {
    if (!canReadPictures() || !helper || !helper.available() || !f.id) return [];
    if (pictureKey === lastPictureKey && lastPicture) return lastPicture;
    const shot = await helper.captureWindow(f.id);
    if (!shot) return [];
    const found = [];
    try {
      if (mark) {
        const img = helper.loadImage(shot);
        if (img) for (const m of mark.decodeMarks(img, { format: img.format })) found.push({ code: m.code, source: "mark" });
      }
      if (!found.length && win.text.length < SPARSE_TEXT) {
        const lines = await helper.ocr(shot);
        const text = lines.map((l) => l.text).join("\n");
        for (const code of codes.findCodes(text)) found.push({ code, source: "ocr", text });
      }
    } catch (e) { log(`pictures: ${e.message}`); }
    finally { helper.discard(shot); }
    lastPictureKey = pictureKey;
    lastPicture = found;
    return found;
  }

  async function check(candidate, observed, isFile) {
    const cert = await lookup.get(candidate.code);
    if (cert === undefined) return { ...candidate, cert: undefined, match: { state: "unknown", ratio: null } };
    if (!cert) return { ...candidate, cert: null, match: { state: "unknown", ratio: null } };
    let match = { state: "unknown", ratio: null };
    try {
      match = await scoring.compareText({ contentHash: cert.content_hash, sketch: cert.text_sketch }, observed, sha);
    } catch { /* leave unknown */ }
    // A whole window (an inbox, a thread) never hashes like the piece alone, so
    // without sentence fingerprints to compare it says nothing either way.
    if (!isFile && match.state === "differs" && !(Array.isArray(cert.text_sketch) && cert.text_sketch.length)) match = { state: "unknown", ratio: null };
    return { ...candidate, cert, match };
  }

  const rank = (r) => (r.cert ? 4 : r.cert === undefined ? 1 : 0) + (r.match.state === "match" ? 3 : r.match.state === "partial" ? 2 : 0);

  async function scan() {
    const f = await front();
    if (!f || !f.bundleId) return;
    if (f.bundleId === ownBundleId) return;              // the popover itself: keep showing what was behind it
    if (isIgnored(f.bundleId)) { set(null); return; }
    const key = `${f.bundleId}|${f.id || ""}|${f.title || ""}`;
    if (key !== windowKey) { windowKey = key; windowSince = now(); }

    const win = await reader.readWindow(f);
    const found = codesIn(win);
    let observed = win.text;
    let isFile = false;
    let docPath = null;

    // The document behind the window, when there is one.
    if (docmeta) {
      docPath = await reader.readDocumentPath(f, win);
      if (docPath) {
        const stamp = await docmeta.readStamp(docPath, { helper });
        if (stamp) {
          const text = await docmeta.extractText(docPath, { helper });
          found.unshift({ code: stamp.code, source: "file", path: docPath });
          if (text) { observed = text; isFile = true; }
        }
      }
    }

    if (!found.length) {
      const pictureKey = `${key}|${win.text.length}|${win.links.length}|${win.images.length}`;
      for (const p of await lookAtPictures(f, win, pictureKey)) found.push(p);
    }

    if (!found.length) { set(null); return; }
    const results = [];
    for (const c of found.slice(0, MAX_CODES)) {
      const text = c.source === "file" ? observed : c.source === "ocr" && c.text ? `${win.text}\n${c.text}` : win.text;
      results.push(await check(c, text, c.source === "file" && isFile));
    }
    results.sort((a, b) => rank(b) - rank(a));
    const best = results[0];
    set({
      code: best.code, source: best.source, app: f.name || f.owner || "", bundleId: f.bundleId,
      path: best.path || null, cert: best.cert === undefined ? null : best.cert,
      offline: best.cert === undefined, match: best.match, others: Math.max(0, found.length - 1), seenAt: now(),
    });
  }

  // Called often by main; decides for itself whether it's time to look.
  async function tick({ force = false } = {}) {
    if (busy) return;
    if (!isEnabled()) { set(null); return; }
    const t = now();
    if (!force && t < nextAt) return;
    busy = true;
    try { await scan(); }
    catch (e) { log(`receiver: ${e.message}`); }
    finally {
      busy = false;
      nextAt = now() + (now() - windowSince < FAST_FOR_MS ? FAST_MS : SLOW_MS);
    }
  }

  // The front app changed: look soon, then often for a minute.
  function nudge() {
    windowSince = now();
    nextAt = now() + SETTLE_MS;
  }

  return { tick, nudge, current: () => seal, clear: () => set(null) };
}

module.exports = { createReceiver };
