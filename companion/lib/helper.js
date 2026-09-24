// inkk companion — the native helper (helper/InkkHelper.swift) and the window
// camera.
//
// The helper is built by build.js into build/inkk-helper and shipped inside the
// app's Resources. One copy of it stays running (`inkk-helper serve`) and
// answers every question over its stdin and stdout, so asking which document is
// in front every 750 ms costs a message, not a process. If that copy can't be
// started (an older build without `serve`), each question runs the helper once,
// as before. When the helper is missing altogether (a build without Xcode
// tools) every call answers null and the companion simply does without
// pictures, PDFs and document names.

"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function helperPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "inkk-helper"));
  candidates.push(path.join(__dirname, "..", "build", "inkk-helper"));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

const DEFAULT_TIMEOUT_MS = 8000;
const FRONT_DOC_TIMEOUT_MS = 1500;
const RETRY_MIN_MS = 250;          // less time than this left: a request lost with its helper is not asked again
const MAX_BUFFER = 32 * 1024 * 1024;

// `bin`: the helper's path. `serve: false` runs it once per question.
// `backoffMs`: after `serve` fails to start, questions run one-shot for this
// long before it is tried again. `stuckMs(timeout)`: how long an unanswered
// question may go on past its own timeout before the helper is taken to be
// stuck and replaced.
function createHelper({
  bin = helperPath(), serve = true, backoffMs = 30000,
  stuckMs = (timeout) => Math.max(5000, timeout),
  spawnImpl = spawn, execFileImpl = execFile, now = Date.now,
} = {}) {
  let child = null;                // the running `serve` process
  let nextId = 1;
  const pending = new Map();       // id → request, until its answer or its helper is gone
  let serveOffUntil = 0;

  function oneShot(args, timeout) {
    return new Promise((resolve) => {
      execFileImpl(bin, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(String(out))); } catch { resolve(null); }
      });
    });
  }

  function startServe() {
    let c;
    try {
      c = spawnImpl(bin, ["serve"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      serveOffUntil = now() + backoffMs;
      return null;
    }
    if (!c || !c.stdin || !c.stdout) {
      try { c && c.kill("SIGKILL"); } catch { /* never ran */ }
      serveOffUntil = now() + backoffMs;
      return null;
    }
    c.answered = false;
    c.gone = false;
    let partial = [];
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk) => {
      let start = 0;
      let i;
      while ((i = chunk.indexOf("\n", start)) !== -1) {
        partial.push(chunk.slice(start, i));
        const line = partial.join("");
        partial = [];
        start = i + 1;
        onLine(c, line);
      }
      if (start < chunk.length) partial.push(chunk.slice(start));
    });
    c.stdin.on("error", () => { /* it has gone; the exit handler takes over */ });
    c.on("error", () => onGone(c));
    c.on("close", () => onGone(c));
    // A helper waiting for questions must not keep a script (or a test) alive.
    c.unref();
    c.stdin.unref?.();
    c.stdout.unref?.();
    return c;
  }

  function onLine(c, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    c.answered = true;
    const req = msg && pending.get(msg.id);
    if (!req || req.child !== c) return;
    pending.delete(msg.id);
    clearTimeout(req.timer);
    if (!req.done) { req.done = true; req.resolve(msg.ok ? (msg.result ?? null) : null); }
  }

  // The helper exited, crashed, was replaced or never started. What it still
  // owed is asked again once, one-shot, within what is left of each timeout.
  function onGone(c) {
    if (c.gone) return;
    c.gone = true;
    if (child === c) child = null;
    if (!c.answered && !c.replaced) serveOffUntil = now() + backoffMs;
    for (const [id, req] of pending) {
      if (req.child !== c) continue;
      pending.delete(id);
      clearTimeout(req.timer);
      if (req.done) continue;
      req.done = true;
      const left = req.deadline - now();
      req.resolve(left >= RETRY_MIN_MS ? oneShot(req.argv, left) : null);
    }
  }

  function replace(c) {
    if (c.gone) return;
    c.replaced = true;
    if (child === c) child = null;
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }

  function ensureServe() {
    if (!serve || !bin) return null;
    if (child && !child.gone) return child;
    if (now() < serveOffUntil) return null;
    child = startServe();
    return child;
  }

  // The caller hears null once its timeout passes. The helper still owes the
  // answer; if it never comes, the helper is stuck and a fresh one takes over.
  function expire(req) {
    if (!req.done) { req.done = true; req.resolve(null); }
    req.timer = setTimeout(() => {
      if (pending.get(req.id) === req) { pending.delete(req.id); replace(req.child); }
    }, stuckMs(req.timeout));
    req.timer.unref?.();
  }

  // `args` is the helper's argv: a command and its arguments, all strings.
  function run(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!bin || !Array.isArray(args) || !args.length) return Promise.resolve(null);
    const argv = args.map(String);
    const c = ensureServe();
    if (!c) return oneShot(argv, timeout);
    return new Promise((resolve) => {
      const id = nextId++;
      const req = { id, argv, timeout, child: c, resolve, done: false, deadline: now() + timeout, timer: null };
      req.timer = setTimeout(() => expire(req), timeout);
      pending.set(id, req);
      try {
        c.stdin.write(JSON.stringify({ id, cmd: argv[0], args: argv.slice(1) }) + "\n");
      } catch {
        onGone(c);
      }
    });
  }

  // Lets the helper finish what it was asked and exit.
  function stop() {
    const c = child;
    child = null;
    if (c && !c.gone) { c.replaced = true; try { c.stdin.end(); } catch { /* gone */ } }
  }

  const str = (v) => (typeof v === "string" ? v : "");
  const strOrNull = (v) => (typeof v === "string" ? v : null);

  // The app in front and its window → { pid, bundleId, name, title, document }
  // or null. Title and document are "" when there is nothing to read (no
  // Accessibility, no window, no file) and null when the window could not be
  // asked just then (the app was busy): the poll then keeps the document it
  // knew rather than taking a moment's silence for a new one. `document` is a
  // file URL when the window shows a file.
  async function frontDoc() {
    const r = await run(["front-doc"], { timeout: FRONT_DOC_TIMEOUT_MS });
    if (!r || typeof r !== "object" || Array.isArray(r) || r.error) return null;
    if (!str(r.bundleId) && !str(r.name)) return null;
    return {
      pid: Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null,
      bundleId: str(r.bundleId), name: str(r.name), title: strOrNull(r.title), document: strOrNull(r.document),
    };
  }

  const frontWindow = () => run(["front-window"], { timeout: 2000 });
  async function ocr(file) { const r = await run(["ocr", file], { timeout: 15000 }); return Array.isArray(r) ? r : []; }
  async function pdfText(file) { const r = await run(["pdf-text", file], { timeout: 15000 }); return r && typeof r.text === "string" ? r.text : null; }
  const pdfReadMeta = (file) => run(["pdf-meta", file]);
  async function pdfStamp(file, { code, seal }) {
    const r = await run(["pdf-stamp", file, code, seal], { timeout: 30000 });
    return r || { ok: false, error: "helper unavailable" };
  }
  const makePdf = (textFile, out) => run(["make-pdf", textFile, out]);

  return {
    run, stop, available: () => !!bin, BIN: bin,
    frontDoc, frontWindow, ocr, pdfText, pdfReadMeta, pdfStamp, makePdf,
    servePid: () => (child && !child.gone ? child.pid : null),
  };
}

// A picture of one window, without its shadow, as a PNG in a private temp
// folder. The caller deletes it as soon as it has looked. Needs Screen
// Recording; without it screencapture produces nothing useful, so the caller
// checks the permission first.
const SHOTS = path.join(os.tmpdir(), "inkk-shots");
function captureWindow(id) {
  return new Promise((resolve) => {
    if (!Number.isInteger(id)) return resolve(null);
    try { fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 }); } catch { return resolve(null); }
    const file = path.join(SHOTS, `w${id}-${process.pid}-${Date.now()}.png`);
    execFile("/usr/sbin/screencapture", ["-x", "-o", "-t", "png", "-l", String(id), file], { timeout: 5000 }, (err) => {
      if (err) { try { fs.unlinkSync(file); } catch { /* none */ } return resolve(null); }
      resolve(fs.existsSync(file) ? file : null);
    });
  });
}

// PNG → { width, height, data, format }. Electron's nativeImage gives BGRA on
// macOS; the mark decoder takes either order.
function loadImage(file) {
  let nativeImage = null;
  try { ({ nativeImage } = require("electron")); } catch { /* plain Node */ }
  if (!nativeImage) return null;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize(1);
  const data = img.toBitmap({ scaleFactor: 1 });
  if (!data || data.length !== width * height * 4) {
    // A @2x capture reports its point size; the bitmap is at pixel size.
    const px = Math.round(Math.sqrt(data.length / 4 / (width * height)));
    return { width: width * px, height: height * px, data, format: "bgra" };
  }
  return { width, height, data, format: "bgra" };
}

function discard(file) { if (file) fs.unlink(file, () => {}); }

// The companion's one helper.
const shared = createHelper();

module.exports = {
  run: shared.run, available: shared.available, BIN: shared.BIN, stop: shared.stop,
  frontDoc: shared.frontDoc, frontWindow: shared.frontWindow, ocr: shared.ocr, pdfText: shared.pdfText,
  pdfReadMeta: shared.pdfReadMeta, pdfStamp: shared.pdfStamp, makePdf: shared.makePdf,
  captureWindow, loadImage, discard, createHelper, helperPath,
};
