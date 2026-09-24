// inkk companion — the native helper (helper/InkkHelper.swift) and the window
// camera.
//
// The helper answers one question per run and prints JSON. It is built by
// build.js into build/inkk-helper and shipped inside the app's Resources. When
// it is missing (a build without Xcode tools) every call answers null and the
// companion simply does without pictures and PDFs.

"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function helperPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "inkk-helper"));
  candidates.push(path.join(__dirname, "..", "build", "inkk-helper"));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

const BIN = helperPath();
const available = () => !!BIN;

function run(args, { timeout = 8000 } = {}) {
  if (!BIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(BIN, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(out))); } catch { resolve(null); }
    });
  });
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

module.exports = { run, available, frontWindow, ocr, pdfText, pdfReadMeta, pdfStamp, makePdf, captureWindow, loadImage, discard, BIN };
