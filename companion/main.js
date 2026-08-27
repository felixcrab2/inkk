// inkk companion — Electron main process.
//
// Owns the global keyboard hook (uiohook-napi), the menu-bar tray, and the
// session lifecycle. Capture happens ONLY while a session is armed, and only
// the rhythm is read — never the text. Finished telemetry events (the exact
// writing_event_batches shape) are streamed to the renderer, which batches them
// to Supabase and runs the certificate flow.
//
// Requires macOS Accessibility + Input Monitoring permission (granted by the
// user in System Settings the first time the hook starts). Nothing here talks
// to Apple; there is no review.

"use strict";

const { app, Tray, BrowserWindow, ipcMain, clipboard, nativeImage, screen, Notification } = require("electron");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createCapture } = require("./capture");

let uIOhook = null, UiohookKey = null;
try { ({ uIOhook, UiohookKey } = require("uiohook-napi")); }
catch (e) { console.warn("[companion] uiohook-napi unavailable:", e.message); }

let tray = null;
let win = null;
let cap = null;
let hooked = false;
let frontApp = "";
let frontWriting = false;      // is the front context a writing app/site?
let currentUser = null;        // set by the renderer once signed in (enables auto-arm)
let noticed = false;           // "certifying…" notice shown for the current session

// ── uiohook keycode → DOM-style key name ─────────────────────────────────────
// Built from UiohookKey so it tracks the library's numeric constants. The names
// match what capture.classifyKey expects (recorder.js `e.key` convention).
const NAME_BY_CODE = (() => {
  const map = new Map();
  if (!UiohookKey) return map;
  const put = (prop, name) => { if (UiohookKey[prop] != null) map.set(UiohookKey[prop], name); };
  for (let c = 65; c <= 90; c++) put(String.fromCharCode(c), String.fromCharCode(c + 32)); // A→a…Z→z
  for (let d = 0; d <= 9; d++) put(String(d), String(d));
  const pairs = {
    Space: "Space", Enter: "Enter", Backspace: "Backspace", Delete: "Delete",
    Tab: "Tab", Escape: "Escape", CapsLock: "CapsLock",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    Shift: "Shift", ShiftRight: "Shift", Ctrl: "Control", CtrlRight: "Control",
    Alt: "Alt", AltRight: "Alt", Meta: "Meta", MetaRight: "Meta",
    Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
    Minus: "-", Equal: "=", Backslash: "\\", LeftBracket: "[", RightBracket: "]", Backquote: "`",
  };
  for (const [prop, name] of Object.entries(pairs)) put(prop, name);
  return map;
})();

function modString(e) {
  return [e.shiftKey && "S", e.ctrlKey && "C", e.altKey && "A", e.metaKey && "M"].filter(Boolean).join("");
}

// ── writing-context detection ────────────────────────────────────────────────
// Native writing apps by process name, plus browser tabs on known writing
// sites. When the front context is "writing" AND the user is signed in, a
// session auto-arms — no manual start, no naming the piece. Capture is gated to
// writing contexts, so nothing typed elsewhere is ever recorded.
const WRITING_APPS = new Set([
  "Notes", "Microsoft Word", "Pages", "TextEdit", "Scrivener", "Ulysses",
  "iA Writer", "Bear", "Obsidian", "Craft", "Notion",
]);
const BROWSERS = new Set(["Safari", "Google Chrome", "Arc", "Microsoft Edge", "Brave Browser"]);
const WRITING_SITES = ["substack.com", "docs.google.com", "medium.com", "notion.so", "ghost.io", "wordpress.com"];
// Never treat the companion or its dev launcher as a writing context.
const IGNORE_APPS = new Set(["Electron", "Conductor", "inkk", "Terminal", "iTerm2"]);

function osa(script, cb) {
  execFile("osascript", ["-e", script], { timeout: 1400 }, (err, out) => cb(err ? "" : (out || "").trim()));
}

function browserTabURL(browser, cb) {
  const q = browser === "Safari"
    ? 'tell application "Safari" to get URL of current tab of front window'
    : `tell application "${browser}" to get URL of active tab of front window`;
  osa(q, cb);
}

// Resolve the current front context → { app, writing, label }.
function detectContext(cb) {
  osa('tell application "System Events" to name of first application process whose frontmost is true', (name) => {
    if (!name || IGNORE_APPS.has(name)) return cb({ app: name, writing: false, label: name || "…" });
    if (WRITING_APPS.has(name)) return cb({ app: name, writing: true, label: name });
    if (BROWSERS.has(name)) {
      return browserTabURL(name, (url) => {
        const site = WRITING_SITES.find(s => url.includes(s));
        cb({ app: name, writing: !!site, label: site ? site.replace(/\.(com|org|io|so)$/, "") : name });
      });
    }
    cb({ app: name, writing: false, label: name });
  });
}

function stateSnapshot() {
  return { signedIn: !!currentUser, armed: !!cap, writing: frontWriting, app: frontApp };
}

// Poll the front context ~every 1.5s. Auto-arms on entering a writing context;
// the session persists across app switches (so tabbing away and back is one
// piece) and capture simply pauses when the front app isn't a writing one.
function pollContext() {
  detectContext((ctx) => {
    frontApp = ctx.label;
    frontWriting = ctx.writing;
    if (ctx.writing && currentUser && !cap) autoArm(ctx.label);
    win?.webContents.send("companion:state", stateSnapshot());
  });
}

function autoArm(label) {
  if (!uIOhook) { win?.webContents.send("companion:error", "Keyboard capture unavailable. Reinstall the app."); return; }
  cap = createCapture({
    userId: currentUser, docId: randomUUID(), sessionId: randomUUID(),
    genId: randomUUID, now: Date.now, hrnow: () => performance.now(),
  });
  cap.start({ platform: process.platform, app: label, companion: app.getVersion() });
  flush();
  if (!hooked) {
    uIOhook.on("keydown", onDown);
    uIOhook.on("keyup", onUp);
    uIOhook.start();
    hooked = true;
  }
  if (!noticed) {
    noticed = true;
    try { new Notification({ title: "inkk", body: `Certifying your writing in ${label}…`, silent: true }).show(); } catch {}
  }
}

// Called by the renderer when the user hits "Finish & certify" — ends the
// current session (the hook stays alive so the next writing context auto-arms
// a fresh one).
function endSession() {
  if (!cap) return;
  cap.stop();
  flush();
  cap = null;
  noticed = false;
  win?.webContents.send("companion:state", stateSnapshot());
}

function flush() {
  if (!cap) return;
  const evs = cap.drain();
  if (evs.length) win?.webContents.send("companion:events", evs);
}

function onDown(e) {
  if (!cap || !frontWriting) return;        // gated: only record inside writing contexts
  const name = NAME_BY_CODE.get(e.keycode);
  if (!name) return;
  const mods = modString(e);
  if ((e.metaKey || e.ctrlKey) && name === "v") {
    cap.keydown(name, mods);
    let len = 0;
    try { len = (clipboard.readText() || "").length; } catch {}
    cap.paste(len);
  } else {
    cap.keydown(name, mods);
  }
  flush();
}

function onUp(e) {
  if (!cap || !frontWriting) return;
  const name = NAME_BY_CODE.get(e.keycode);
  if (!name) return;
  cap.keyup(name);
  flush();
}

// ── tray + popover window ────────────────────────────────────────────────────
function trayIcon() {
  // "inkk." in EB Garamond as a macOS template image — macOS recolours it to
  // match the menu bar (white on dark), like the native icons. Electron loads
  // the @2x variant automatically on Retina.
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", "iconTemplate.png"));
  img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createFromNamedImage("NSApplicationIcon") : img;
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); return; }
  const tb = tray.getBounds();
  const wb = win.getBounds();
  const dsp = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
  x = Math.min(Math.max(x, dsp.x + 8), dsp.x + dsp.width - wb.width - 8);
  win.setPosition(x, Math.round(tb.y + tb.height + 4), false);
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 360, height: 540, show: false, frame: false, resizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("blur", () => { if (!win.webContents.isDevToolsOpened()) win.hide(); });
}

process.on("uncaughtException", (e) => { console.error("[companion] uncaught:", e); });

app.whenReady().then(() => {
  // Accessory policy = a true menu-bar-only agent: no dock icon, not in
  // Cmd-Tab, and showing the popover doesn't activate/steal focus to another
  // app (this is what stops the "pulled back to the launcher" behaviour).
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.dock?.hide();

  createWindow();
  tray = new Tray(trayIcon());
  tray.setToolTip("inkk — verify your writing");
  tray.on("click", toggleWindow);

  // Watch the front context continuously (drives auto-arm).
  pollContext();
  setInterval(pollContext, 1500);

  // The renderer tells us who's signed in (restored on launch), which is what
  // enables auto-arm without a manual start.
  ipcMain.handle("companion:auth", (_e, userId) => { currentUser = userId || null; if (!currentUser) endSession(); return true; });
  ipcMain.handle("companion:end", () => { endSession(); return true; });
  ipcMain.handle("companion:state", () => stateSnapshot());
  ipcMain.handle("companion:version", () => app.getVersion());
});

app.on("window-all-closed", (e) => e.preventDefault()); // stay alive in the tray
app.on("before-quit", endSession);
