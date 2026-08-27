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

const { app, Tray, BrowserWindow, ipcMain, clipboard, nativeImage, screen } = require("electron");
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
let frontAppTimer = null;

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

// ── front-most app (for the "recording in …" label; needs Accessibility) ─────
function pollFrontApp() {
  execFile("osascript", ["-e", 'tell application "System Events" to name of first application process whose frontmost is true'],
    { timeout: 1500 }, (err, stdout) => {
      if (!err) {
        const name = (stdout || "").trim();
        if (name && name !== frontApp) {
          frontApp = name;
          win?.webContents.send("companion:frontapp", frontApp);
        }
      }
    });
}

// ── session control ──────────────────────────────────────────────────────────
function startSession(ctx) {
  if (!uIOhook) { win?.webContents.send("companion:error", "Keyboard capture unavailable. Reinstall the app."); return; }
  cap = createCapture({
    userId: ctx.userId,
    docId: ctx.docId,
    sessionId: randomUUID(),
    genId: randomUUID,
    now: Date.now,
    hrnow: () => performance.now(),
  });
  pollFrontApp();
  cap.start({ platform: process.platform, app: frontApp, companion: app.getVersion() });
  flush();

  if (!hooked) {
    uIOhook.on("keydown", onDown);
    uIOhook.on("keyup", onUp);
    uIOhook.start();
    hooked = true;
  }
  frontAppTimer = setInterval(pollFrontApp, 2000);
  win?.webContents.send("companion:state", { armed: true, app: frontApp });
}

function stopSession() {
  if (!cap) return;
  cap.stop();
  flush();
  if (hooked) { uIOhook.stop(); uIOhook.removeAllListeners("keydown"); uIOhook.removeAllListeners("keyup"); hooked = false; }
  clearInterval(frontAppTimer); frontAppTimer = null;
  cap = null;
  win?.webContents.send("companion:state", { armed: false });
}

function flush() {
  if (!cap) return;
  const evs = cap.drain();
  if (evs.length) win?.webContents.send("companion:events", evs);
}

function onDown(e) {
  if (!cap) return;
  const name = NAME_BY_CODE.get(e.keycode);
  if (!name) return;                       // unmapped key: ignore
  const mods = modString(e);
  // ⌘V / Ctrl+V: a paste. Read the clipboard LENGTH only — the text never
  // enters an event.
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
  if (!cap) return;
  const name = NAME_BY_CODE.get(e.keycode);
  if (!name) return;
  cap.keyup(name);
  flush();
}

// ── tray + popover window ────────────────────────────────────────────────────
function trayIcon() {
  // A simple template dot; replaced by a real asset before shipping.
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAWklEQVR4nO3QMQ0AIAwEwYf/oiEBQ8IEd8pXt2Zmdj3Y5oB7wLcAAAAASUVORK5CYII="
  );
  img.setTemplateImage(true);
  return img;
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

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();  // menu-bar app, no dock icon
  createWindow();
  tray = new Tray(trayIcon());
  tray.setToolTip("inkk — verify your writing");
  tray.on("click", toggleWindow);

  ipcMain.handle("companion:start", (_e, ctx) => { startSession(ctx); return true; });
  ipcMain.handle("companion:stop", () => { stopSession(); return true; });
  ipcMain.handle("companion:version", () => app.getVersion());
});

app.on("window-all-closed", (e) => e.preventDefault()); // stay alive in the tray
app.on("before-quit", stopSession);
