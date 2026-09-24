// inkk companion — signing an email.
//
// At the end of an email, where the writer would type their name, one
// keystroke (⌃⌥S) certifies what they have written and puts their name there
// instead: a picture of it, linked to its certificate, whose ink carries the
// code. The recipient sees a name and nothing else. inkk on the recipient's
// Mac sees the seal, through the link, the code hidden after the name in the
// picture's description (and in the plain-text part), or the pixels.
//
// The clipboard is used to insert it (the only way into every mail app), and
// is never read. Electron is handed in by the caller, so the payload can be
// built and tested in plain Node.

"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const zw = require("./zw");

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
// Clipboard HTML reaches some mail apps without its character set, and a
// zero-width character read in the wrong one turns into three visible ones;
// written as a character reference it survives any reading.
const escapeAttr = (s) => escapeHtml(s).replace(/[^\x20-\x7e]/gu, (c) => `&#x${c.codePointAt(0).toString(16).toUpperCase()};`);

// Web mail keeps only pictures it can fetch: Gmail drops a pasted data: image
// and sends the plain-text part instead. So in a browser, and in Outlook, the
// name is the copy of its picture kept with the certificate on inkk.site
// (/s/<code>.png). Apple Mail and the rest attach a pasted picture to the
// email itself, which is better there: nothing to fetch, nothing to go stale.
const HOSTED_IMAGE_APPS = new Set([
  "com.apple.Safari", "com.apple.SafariTechnologyPreview",
  "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta",
  "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
  "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
  "com.microsoft.Outlook",
]);
function usesHostedImage(bundleId) {
  return HOSTED_IMAGE_APPS.has(String(bundleId || ""));
}

// What goes on the clipboard: the picture for apps that take pictures, the
// linked picture for apps that take HTML, and for plain-text mail the name
// alone. Wherever the name is text (the plain-text part, the picture's
// description), its code follows it in zero-width characters; nothing visible
// is added. No title attribute: a hovering pointer would show it.
function clipboardPayload({ nativeImage, rendered, name, code, seal, imageUrl }) {
  const alt = `${name}${zw.encode(code)}`;
  const src = typeof imageUrl === "string" && /^https:\/\//.test(imageUrl) ? imageUrl : rendered.dataUrl;
  const html = `<a href="${escapeHtml(seal)}" style="text-decoration:none;border:0"><img src="${escapeHtml(src)}" width="${rendered.width}" height="${rendered.height}" alt="${escapeAttr(alt)}" style="border:0;display:inline-block;vertical-align:baseline"></a>`;
  const image = nativeImage.createFromDataURL(rendered.dataUrl);
  return { html, text: alt, image, alt };
}

function dispose() {
  if (renderer && !renderer.isDestroyed()) renderer.destroy();
  renderer = null;
  rendererReady = null;
}

module.exports = { fullName, renderName, clipboardPayload, usesHostedImage, dispose };
