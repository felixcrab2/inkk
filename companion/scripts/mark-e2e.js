// inkk companion — end-to-end check of the email pixel mark, in real Chromium.
//
// Run from companion/:   npx electron scripts/mark-e2e.js
//
// Renders the writer's name in EB Garamond 500 on a transparent canvas at 2x
// (as the signature renderer does), encodes a code into its ink with
// lib/mark.js, turns it back into a PNG through the canvas, then shows that
// PNG in an email-like page (grey body text, a blue link, a photo) at several
// sizes and as a recompressed JPEG. Each page is captured with
// webContents.capturePage() and decoded from the BGRA capture. Prints a
// pass/fail table and exits non-zero when a required row fails.
//
// Environment: MARK_NAME, MARK_CODE, MARK_SIZE (CSS px, default 30) change
// the main rows; MARK_E2E_DUMP=<dir> saves every capture and signature PNG.

"use strict";

const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mark = require("../lib/mark.js");

const ROOT = path.join(__dirname, "..");
const FONTS = {
  garamond: { file: "eb-garamond-latin-500-normal.woff2", family: "EB Garamond", weight: 500 },
  fell: { file: "im-fell-english-latin-400-normal.woff2", family: "IM Fell English", weight: 400 },
  sans: { file: null, family: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif", weight: 500 },
};
const NAME = process.env.MARK_NAME || "Felix Crabtree";
const CODE = process.env.MARK_CODE || "INKK-7F3A-9K2D-XQ4M";
const CSS_SIZE = Number(process.env.MARK_SIZE || 30);

// scale: captured pixels per bitmap pixel. Required rows fail the run; the
// rest are reported for information.
const ROWS = [
  { face: "garamond", scale: 1, required: true },
  { face: "garamond", scale: 0.5, required: true },
  { face: "garamond", scale: 1.5, required: true },
  { face: "garamond", scale: 1, jpeg: 0.8, required: true },
  { face: "garamond", scale: 2 },
  { face: "garamond", scale: 0.75 },
  { face: "garamond", scale: 1.5, jpeg: 0.8 },
  { face: "garamond", scale: 0.5, jpeg: 0.8 },
  { face: "garamond", scale: 1, layout: "headshot" },
  { face: "garamond", scale: 0.5, layout: "headshot" },
  { face: "garamond", scale: 1, code: "INKK-0000-0000-0000" },
  { face: "garamond", scale: 0.5, code: "INKK-ZZZZ-ZZZZ-ZZZZ" },
  { face: "garamond", scale: 1, name: "Ana Diaz", code: "INKK-M4QX-D2K9-A3F7" },
  { face: "garamond", scale: 0.5, name: "Ana Diaz", code: "INKK-M4QX-D2K9-A3F7" },
  { face: "fell", scale: 1 },
  { face: "fell", scale: 0.5 },
  { face: "sans", scale: 1 },
  { face: "sans", scale: 0.5 },
];

function fontFace(face) {
  const f = FONTS[face];
  if (!f.file) return "";
  const b64 = fs.readFileSync(path.join(ROOT, "renderer", "fonts", f.file)).toString("base64");
  return `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; src: url(data:font/woff2;base64,${b64}) format("woff2"); }`;
}

let pages = 0;
async function load(win, html) {
  const p = path.join(os.tmpdir(), `inkk-mark-e2e-${process.pid}-${pages++}.html`);
  fs.writeFileSync(p, html);
  try { await win.loadFile(p); } finally { fs.rmSync(p, { force: true }); }
}

// The name at 2x on a transparent canvas, as RGBA.
async function renderName(win, face, name, cssSize) {
  const f = FONTS[face];
  await load(win, `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace(face)}</style></head><body></body></html>`);
  return win.webContents.executeJavaScript(`(async () => {
    const font = "${f.weight} ${cssSize * 2}px ${f.family.replace(/"/g, "'")}";
    await document.fonts.load(font);
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = font;
    const m = probe.measureText(${JSON.stringify(name)});
    const pad = ${cssSize * 2} * 0.12;
    const w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + pad * 2);
    const h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + pad * 2);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(${JSON.stringify(name)}, pad + m.actualBoundingBoxLeft, pad + m.actualBoundingBoxAscent);
    return { width: w, height: h, data: Array.from(ctx.getImageData(0, 0, w, h).data), fontOk: document.fonts.check(font) };
  })()`);
}

// Encoded RGBA back through a canvas: the PNG the signature flow would ship.
async function toPng(win, img) {
  return win.webContents.executeJavaScript(`(() => {
    const c = document.createElement("canvas");
    c.width = ${img.width}; c.height = ${img.height};
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(${JSON.stringify(Array.from(img.data))}), ${img.width}, ${img.height}), 0, 0);
    return c.toDataURL("image/png");
  })()`);
}

async function toJpeg(win, pngUrl, quality) {
  return win.webContents.executeJavaScript(`(async () => {
    const im = new Image();
    im.src = ${JSON.stringify(pngUrl)};
    await im.decode();
    const c = document.createElement("canvas");
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0);
    return c.toDataURL("image/jpeg", ${quality});
  })()`);
}

// Encode at the requested size; a name with too little ink is drawn larger,
// which is what the signature flow does on "mark_too_small".
async function makeSignature(win, face, name, code) {
  for (let size = CSS_SIZE; size <= CSS_SIZE * 2; size = Math.round(size * 1.2)) {
    const raw = await renderName(win, face, name, size);
    const img = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
    try {
      const enc = mark.encodeMark(img, code);
      let mass = 0;
      for (let i = 3; i < img.data.length; i += 4) mass += img.data[i] / 255;
      return { png: await toPng(win, img), width: raw.width, height: raw.height, inkPixels: enc.inkPixels, mass: Math.round(mass), fontOk: raw.fontOk, size };
    } catch (e) {
      if (e.message !== "mark_too_small") throw e;
    }
  }
  throw new Error("mark_too_small even at twice the size");
}

const HEADSHOT = "background: radial-gradient(circle at 50% 38%, #c9a58a 0 18%, transparent 19%), radial-gradient(ellipse at 50% 95%, #2b3345 0 45%, transparent 46%), linear-gradient(160deg, #6d7f8f, #3a4350);";

function emailPage(sig, layout) {
  const img = `<img class="sig" src="${sig}" style="width:1px;height:1px">`;
  const block = layout === "headshot"
    ? `<table style="border-collapse:collapse;margin-top:14px"><tr><td style="padding:0 12px 0 0"><div style="width:64px;height:64px;border-radius:32px;${HEADSHOT}"></div></td><td style="padding:0">${img}<div style="color:#6e6e6e;font-size:13px">Editor, The Quarterly</div></td></tr></table>`
    : `${img}<p style="margin-top:14px;color:#6e6e6e;font-size:13px">Sent from my Mac</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: #fff; }
    body { font: 15px/1.5 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #222; padding: 28px 36px; }
    .meta { color: #6e6e6e; font-size: 13px; border-bottom: 1px solid #e6e6e6; padding-bottom: 10px; margin-bottom: 18px; }
    p { margin: 0 0 12px; max-width: 620px; }
    a { color: rgb(0, 0, 238); }
    .quote { color: #555; border-left: 2px solid #ccc; padding-left: 10px; }
    .photo { width: 180px; height: 110px; float: right; margin: 0 0 10px 16px;
      background: radial-gradient(circle at 30% 40%, #2b3a55, transparent 60%), radial-gradient(circle at 70% 60%, #6b3f2a, transparent 55%),
                  linear-gradient(135deg, #1d2b1f, #7c8a5a 50%, #29314a); }
    img.sig { display: block; margin-top: 14px; }
  </style></head><body>
    <div class="meta">From Felix Crabtree &nbsp; To Ana Diaz &nbsp; 24 Sep, 14:32</div>
    <div class="photo"></div>
    <p>Hi Ana,</p>
    <p>Thanks for sending the draft over. I read it twice this morning and made a few notes in the margin; the second section reads much better now that the example comes first.</p>
    <p>The figures are in the <a href="https://example.com/sheet">shared sheet</a>, and the older version is still in the folder if you want to compare.</p>
    <p class="quote">On Monday, Ana wrote: could you take a look before Thursday?</p>
    <p>Best,</p>
    ${block}
  </body></html>`;
}

async function capture(win) {
  await new Promise((r) => setTimeout(r, 150));
  const shot = await win.webContents.capturePage();
  const { width, height } = shot.getSize();
  return { width, height, data: shot.toBitmap() };
}

async function runRow(win, row, cache) {
  const name = row.name || NAME, code = row.code || CODE;
  const key = `${row.face}|${name}|${code}`;
  if (!cache[key]) cache[key] = await makeSignature(win, row.face, name, code);
  const sig = cache[key];
  const url = row.jpeg ? await toJpeg(win, sig.png, row.jpeg) : sig.png;
  await load(win, emailPage(url, row.layout));
  // Size the image so one bitmap pixel covers `scale` captured pixels.
  const dpr = (await capture(win)).width / win.getContentBounds().width;
  const cssW = (sig.width * row.scale) / dpr, cssH = (sig.height * row.scale) / dpr;
  await win.webContents.executeJavaScript(`(() => { const i = document.querySelector("img.sig"); i.style.width = "${cssW}px"; i.style.height = "${cssH}px"; return i.decode(); })()`);
  const shot = await capture(win);
  const t0 = Date.now();
  const found = mark.decodeMarks(shot, { format: "bgra" });
  const ms = Date.now() - t0;
  if (process.env.MARK_E2E_DUMP) {
    const dir = process.env.MARK_E2E_DUMP;
    fs.mkdirSync(dir, { recursive: true });
    const base = `${row.face}-${name}-${row.scale}x${row.jpeg ? "-jpeg" : ""}${row.layout ? `-${row.layout}` : ""}-${code}`.replace(/[^a-z0-9.]+/gi, "-");
    fs.writeFileSync(path.join(dir, `${base}.png`), nativeImage.createFromBitmap(shot.data, { width: shot.width, height: shot.height }).toPNG());
    fs.writeFileSync(path.join(dir, `signature-${row.face}-${name.replace(/\W+/g, "-")}.png`), Buffer.from(sig.png.split(",")[1], "base64"));
  }
  const hit = found.find((f) => f.code === code);
  const wrong = found.filter((f) => f.code !== code);
  return { ok: !!hit && !wrong.length, hit, wrong, ms, dpr, sig, shot: `${shot.width}x${shot.height}` };
}

async function main() {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const cache = {};
  const results = [];
  for (const row of ROWS) {
    const label = [row.face, row.name || "", `${row.scale}x`, row.jpeg ? `jpeg ${row.jpeg}` : "", row.layout || "", row.code ? row.code.slice(5) : ""].filter(Boolean).join(" ");
    try {
      results.push({ label, row, ...(await runRow(win, row, cache)) });
    } catch (e) {
      results.push({ label, row, ok: false, error: e.message || String(e) });
    }
  }
  // The same page with no mark must decode to nothing.
  await load(win, emailPage("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "headshot"));
  const empty = mark.decodeMarks(await capture(win), { format: "bgra" });

  const dpr = results.find((r) => r.dpr)?.dpr;
  console.log(`\nmark e2e  "${NAME}"  ${CODE}  ${CSS_SIZE}px CSS drawn at 2x  capture dpr ${dpr}\n`);
  const cols = ["row", "result", "bitmap", "css px", "ink px", "ink mass", "conf", "box (capture px)", "ms"];
  const table = results.map((r) => [
    r.label + (r.row.required ? "" : " (info)"),
    r.ok ? "pass" : "FAIL",
    r.sig ? `${r.sig.width}x${r.sig.height}` : "",
    r.sig ? String(r.sig.size) : "",
    r.sig ? String(r.sig.inkPixels) : "",
    r.sig ? String(r.sig.mass) : "",
    r.hit ? r.hit.confidence.toFixed(2) : "",
    r.hit ? `${r.hit.box.x},${r.hit.box.y} ${r.hit.box.w}x${r.hit.box.h}` : "",
    r.ms != null ? String(r.ms) : "",
  ].concat(r.error ? [`error: ${r.error}`] : r.wrong && r.wrong.length ? [`wrong: ${r.wrong.map((w) => w.code).join(",")}`] : []));
  const widths = cols.map((c, i) => Math.max(c.length, ...table.map((t) => t[i].length)));
  const fmt = (t) => t.map((c, i) => (i < widths.length ? c.padEnd(widths[i]) : c)).join("  ");
  console.log(fmt(cols));
  for (const t of table) console.log(fmt(t));
  console.log(`\nno-mark page: ${empty.length ? `FAIL (${empty.map((e) => e.code).join(",")})` : "pass (nothing found)"}`);
  const req = results.filter((r) => r.row.required);
  console.log(`required rows: ${req.filter((r) => r.ok).length}/${req.length} pass; all rows: ${results.filter((r) => r.ok).length}/${results.length}\n`);
  return req.some((r) => !r.ok) || empty.length > 0;
}

if (app.dock) app.dock.hide();
app.whenReady().then(async () => {
  let failed = true;
  try { failed = await main(); } catch (e) { console.error(e); }
  app.exit(failed ? 1 : 0);
});
