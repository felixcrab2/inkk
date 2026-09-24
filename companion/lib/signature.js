// inkk companion — signing an email.
//
// At the end of an email, where the writer would type their name, one
// keystroke (⌃⌥S) certifies what they have written and puts their name there
// instead: a picture of it, linked to its certificate, whose ink carries the
// code. The recipient sees a name. inkk on the recipient's Mac sees the seal,
// through the link, the picture's description or, failing both, its pixels.
//
// The clipboard is used to insert it (the only way into every mail app), and
// is never read.

"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");

let renderer = null;             // the hidden window that draws names
let rendererReady = null;

function fullName() {
  return new Promise((resolve) => {
    execFile("/usr/bin/id", ["-F"], { timeout: 1500 }, (err, out) => resolve(err ? "" : String(out).trim()));
  });
}

function ensureRenderer(BrowserWindow, dir) {
  if (renderer && !renderer.isDestroyed()) return rendererReady;
  renderer = new BrowserWindow({
    show: false, width: 800, height: 200, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  rendererReady = renderer.loadFile(path.join(dir, "renderer", "sign.html")).then(() => renderer);
  return rendererReady;
}

async function renderName({ BrowserWindow, dir, name, code, face }) {
  const win = await ensureRenderer(BrowserWindow, dir);
  const args = JSON.stringify({ name, code, face });
  return win.webContents.executeJavaScript(`window.inkkSign(${args})`, true);
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What goes on the clipboard: the picture for apps that take pictures, the
// linked picture for apps that take HTML, and the name with its seal for
// plain-text mail.
function clipboardPayload({ nativeImage, rendered, name, code, seal }) {
  const alt = `${name}, inkk. ${code}`;
  const html = `<a href="${escapeHtml(seal)}" style="text-decoration:none;border:0"><img src="${rendered.dataUrl}" width="${rendered.width}" height="${rendered.height}" alt="${escapeHtml(alt)}" title="${escapeHtml(`inkk. ${code}`)}" style="border:0;display:inline-block;vertical-align:baseline"></a>`;
  const text = `${name}\ninkk. ${seal.replace(/^https:\/\//, "")}`;
  const image = nativeImage.createFromDataURL(rendered.dataUrl);
  return { html, text, image, alt };
}

function dispose() {
  if (renderer && !renderer.isDestroyed()) renderer.destroy();
  renderer = null;
  rendererReady = null;
}

module.exports = { fullName, renderName, clipboardPayload, dispose };
