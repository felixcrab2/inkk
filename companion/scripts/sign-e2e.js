// End to end check of signing an email, run with `npx electron scripts/sign-e2e.js`:
// draw the name through the app's own renderer (renderer/sign.html), write the
// clipboard exactly as ⌃⌥S does, paste into a Chromium rich editor and a plain
// text field, photograph the pasted name as it is displayed, and read the code
// back from its pixels. The clipboard's text is put back afterwards.

"use strict";

const { app, BrowserWindow, clipboard, ClipboardItem, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const signature = require("../lib/signature");
const mark = require("../lib/mark");
const zw = require("../lib/zw");
const codes = require("../lib/codes");

const NAME = process.env.SIGN_NAME || "Felix Crabtree";
const CODE = process.env.SIGN_CODE || "INKK-4B7N-R2XE-8KMT";
const FACE = process.env.SIGN_FACE || "garamond";
const DIR = path.join(__dirname, "..");

async function page(html) {
  const file = path.join(os.tmpdir(), `inkk-sign-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><body style="margin:24px;background:#fff;font:14px Arial">${html}</body>`);
  const w = new BrowserWindow({ width: 700, height: 260, show: false, webPreferences: { sandbox: true } });
  await w.loadFile(file);
  return { w, file };
}

async function pasteInto(kind) {
  const { w, file } = await page(kind === "rich"
    ? `<div id="e" contenteditable style="min-height:120px;outline:none">Thanks for reading,<br></div>`
    : `<textarea id="e" style="width:600px;height:120px">Thanks for reading,\n</textarea>`);
  await w.webContents.executeJavaScript(`(() => { const e = document.getElementById("e"); e.focus();
    if (e.tagName === "TEXTAREA") { e.selectionStart = e.selectionEnd = e.value.length; }
    else { const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true; })()`);
  w.webContents.paste();
  await new Promise((r) => setTimeout(r, 1200));
  const got = await w.webContents.executeJavaScript(`(() => { const e = document.getElementById("e");
    if (e.tagName === "TEXTAREA") return { text: e.value };
    const img = e.querySelector("img");
    return { text: e.innerText, img: img && { src: img.getAttribute("src").slice(0, 40), width: img.width, height: img.height, alt: img.getAttribute("alt") } }; })()`);
  let pixels = [];
  if (kind === "rich") {
    await w.webContents.executeJavaScript(`new Promise((r) => { const i = document.querySelector("img"); if (!i || i.complete) r(); else i.onload = r; })`);
    const shot = await w.webContents.capturePage();
    const size = shot.getSize();
    pixels = mark.decodeMarks({ width: size.width, height: size.height, data: shot.toBitmap() }, { format: "bgra" }).map((m) => m.code);
  }
  w.destroy();
  fs.rmSync(file, { force: true });
  return { visible: zw.strip(got.text || "").trim(), hidden: codes.findCodes([got.text || "", got.img ? got.img.alt : ""].join("\n")), img: got.img, pixels };
}

app.whenReady().then(async () => {
  const saved = await clipboard.readText();
  let ok = true;
  try {
    const rendered = await signature.renderName({ BrowserWindow, dir: DIR, name: NAME, code: CODE, face: FACE });
    const p = signature.clipboardPayload({ nativeImage, rendered, name: NAME, code: CODE, seal: `https://www.inkk.site/v/${CODE}` });
    await signature.writeToClipboard({ clipboard, ClipboardItem }, p);
    const types = (await clipboard.read()).flatMap((i) => i.types).filter((t) => !t.startsWith("electron "));
    const rich = await pasteInto("rich");
    const plain = await pasteInto("plain");
    const rows = [
      ["clipboard formats", types.join(", "), ["text/plain", "text/html", "image/png"].every((t) => types.includes(t))],
      ["rich: a picture pasted", rich.img ? `${rich.img.width}x${rich.img.height}` : "none", !!rich.img],
      ["rich: code hidden in its description", rich.hidden.join(" ") || "none", rich.hidden.includes(CODE)],
      ["rich: code read from the displayed pixels", rich.pixels.join(" ") || "none", rich.pixels.includes(CODE)],
      ["plain: shows the name only", JSON.stringify(plain.visible.split("\n").pop()), plain.visible.endsWith(NAME)],
      ["plain: code hidden in the text", plain.hidden.join(" ") || "none", plain.hidden.includes(CODE)],
    ];
    for (const [what, got, pass] of rows) {
      if (!pass) ok = false;
      console.log(`${pass ? "pass" : "FAIL"}  ${what.padEnd(44)} ${got}`);
    }
  } catch (e) {
    ok = false;
    console.log("FAIL ", e.stack);
  } finally {
    await clipboard.writeText(saved);
    signature.dispose();
  }
  app.exit(ok ? 0 : 1);
});
