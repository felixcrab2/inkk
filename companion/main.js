// inkk companion — Electron main process.
//
// A menu-bar agent that runs in the background and records the RHYTHM of
// typing in any app — never the letters — as per-app writing sessions with a
// live human-signal score, and certifies a session on request (an INKK code
// from /api/certify). No account is needed to record; the renderer only asks
// for one at the certify step.
//
// Pieces:  lib/permissions.js (the two macOS grants) → uiohook global hook →
// lib/keymap.js (scancode → key name) → lib/sessions.js (per-app sessions,
// scoring, persistence). lib/context.js tells us which app is in front so a
// key can be attributed. The popover is a frameless BrowserWindow under the
// tray icon, driven entirely by State/Sessions pushes over the `window.inkk`
// bridge in preload.js.

"use strict";

const { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, nativeImage, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const { createStore } = require("./lib/sessions");
const { createContextPoller } = require("./lib/context");
const permissions = require("./lib/permissions");
const { buildKeymap, modString } = require("./lib/keymap");

// Native + generated modules are optional at runtime: a missing one is
// reported in State.error rather than crashing the agent at login.
const startupErrors = [];
let uIOhook = null, UiohookKey = null;
try { ({ uIOhook, UiohookKey } = require("uiohook-napi")); }
catch (e) { startupErrors.push(`uiohook-napi unavailable: ${e.message}`); }
if (permissions.loadError) startupErrors.push(permissions.loadError);

let scoring = null;
try { scoring = require("./lib/scoring.cjs"); }
catch (e) { startupErrors.push(`lib/scoring.cjs missing (run npm run build): ${e.message}`); }

let config = {};
try { config = require("./lib/config.cjs"); } catch { /* defaults below */ }
const API_BASE = (config.INKK_API_BASE || "https://inkk.site").replace(/\/+$/, "");
const SUPABASE_CONFIGURED = !!(config.REACT_APP_SUPABASE_URL && config.REACT_APP_SUPABASE_ANON_KEY);

const SMOKE = process.argv.includes("--smoke");

// ── constants ────────────────────────────────────────────────────────────────
const WIN_W = 364, WIN_H = 600;          // 340×576 sheet + 12px shadow margin
const PUSH_MIN_MS = 250;                 // state pushes ≤ 4/s
const PERM_POLL_MS = 2000;
const IDLE_CHECK_MS = 30 * 1000;
const TICK_MS = 1000;
const REPOLL_AFTER_QUIET_MS = 2000;      // first key after this long re-polls the front app
const HOUR_MS = 60 * 60 * 1000;
const MAX_CERTIFY_EVENTS = 60000;
const MAX_CERTIFY_BYTES = 4 * 1024 * 1024;   // Vercel rejects request bodies over 4.5 MB
const CERTIFY_TIMEOUT_MS = 25000;
const PERMISSION_HOLD_MS = 20000;            // keep the popover up while an OS permission dialog is showing
const BLUR_CLICK_GUARD_MS = 400;             // a tray click first blurs the popover; don't re-open on that click
// The companion never records itself (typing into the certify box, say).
const OWN_BUNDLE_ID = app.isPackaged ? "site.inkk.companion" : "com.github.Electron";
const DEFAULT_IGNORED = [
  "site.inkk.companion", "com.apple.Terminal", "com.googlecode.iterm2",
  "com.1password.1password", "com.apple.keychainaccess", "com.apple.loginwindow",
];

// ── settings (userData/inkk/settings.json) ───────────────────────────────────
const DATA_DIR = path.join(app.getPath("userData"), "inkk");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const settings = { onboarded: false, paused: null, launchAtLogin: false, ignoredApps: DEFAULT_IGNORED.slice() };

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (typeof s.onboarded === "boolean") settings.onboarded = s.onboarded;
    if (typeof s.paused === "number" || s.paused === null) settings.paused = s.paused;
    if (typeof s.launchAtLogin === "boolean") settings.launchAtLogin = s.launchAtLogin;
    if (Array.isArray(s.ignoredApps)) settings.ignoredApps = s.ignoredApps.filter(x => typeof x === "string");
  } catch { /* first run */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) { console.warn("[inkk] settings not saved:", e.message); }
}

// Paused until a moment in the future, else null (an expired pause reads as null).
const pausedUntil = () => (settings.paused && settings.paused > Date.now() ? settings.paused : null);

// ── runtime state ────────────────────────────────────────────────────────────
let tray = null;
let win = null;
let store = null;
let context = null;
let perms = { accessibility: "not determined", inputMonitoring: "not determined" };
let hookActive = false;
let hookStartFailed = false;
let needsRelaunch = false;
let grantedOnce = false;                 // both grants seen at some point this run
let lastKeyAt = 0;
let trayActive = null;
let lastOtherFront = null;               // most recent front app that isn't inkk (what "Ignore <app>" offers)
let blurHideAt = 0;
let holdOpenUntil = 0;
let pauseTimer = null;
let repoll = null;                       // in-flight front-app re-poll; keys queue behind it
const keyQueue = [];
const KEYMAP = buildKeymap(UiohookKey);

// ── State (the renderer's single source of truth) ────────────────────────────
function getState() {
  return {
    version: app.getVersion(),
    onboarded: settings.onboarded,
    permissions: { ...perms },
    hookActive,
    needsRelaunch,
    paused: pausedUntil(),
    launchAtLogin: settings.launchAtLogin,
    ignoredApps: settings.ignoredApps.slice(),
    frontApp: lastOtherFront,
    active: store ? store.active() : null,
    supabaseConfigured: SUPABASE_CONFIGURED,
    ...(startupErrors.length ? { error: startupErrors.join("; ") } : {}),
  };
}

// Pushes are coalesced: many keystrokes → at most four State pushes a second.
const pending = { state: false, sessions: false };
let pushTimer = null;
function push(what) {
  pending[what] = true;
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!win || win.isDestroyed()) return;
    if (pending.state) { pending.state = false; win.webContents.send("inkk:state", getState()); }
    if (pending.sessions) { pending.sessions = false; win.webContents.send("inkk:sessions", store.list()); }
    refreshTray();
  }, PUSH_MIN_MS);
}

// ── capture gate ─────────────────────────────────────────────────────────────
// A key is captured only when: not paused, the front app is known, and it is
// not on the ignore list. macOS secure input (password fields) never reaches
// the hook at all, so there is nothing to gate there.
function captureTarget() {
  if (pausedUntil()) return null;
  const front = context.current();
  if (!front || !front.bundleId) return null;
  if (front.bundleId !== OWN_BUNDLE_ID) lastOtherFront = front;
  if (front.bundleId === OWN_BUNDLE_ID) return null;
  if (settings.ignoredApps.includes(front.bundleId)) return null;
  return front;
}

// Route one physical key to the store, stamped with the time it was pressed.
function routeKey(k) {
  const front = captureTarget();
  if (!front) return;
  const name = KEYMAP.get(k.keycode);
  if (!name) return;
  const base = { bundleId: front.bundleId, app: front.name, name, at: k.at };
  if (k.type === "keydown") {
    const mods = modString(k);
    store.keyEvent({ ...base, type: "keydown", mods });
    // A paste: recorded as an event with no length — the pasteboard is never
    // read (that would raise a macOS privacy alert on every ⌘V). How much text
    // arrived by pasting is inferred from the finished text at certify time.
    if ((k.metaKey || k.ctrlKey) && name === "v") store.keyEvent({ ...base, type: "paste", len: 0 });
  } else {
    store.keyEvent({ ...base, type: "keyup" });
  }
}

// The 750ms poll can lag an app switch that happened during a quiet spell. The
// first key after such a spell re-polls the front app and every key that
// arrives meanwhile waits (with its own timestamp) so it lands in the right
// session rather than the previous app's.
function onKey(type, e) {
  const t = Date.now();
  const k = { type, keycode: e.keycode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
              at: { t, pt: performance.now() } };
  const quiet = type === "keydown" && t - lastKeyAt >= REPOLL_AFTER_QUIET_MS;
  if (type === "keydown") lastKeyAt = t;
  if (repoll) { keyQueue.push(k); return; }
  if (quiet) {
    keyQueue.push(k);
    repoll = context.pollNow().catch(() => null).then(() => {
      repoll = null;
      const queued = keyQueue.splice(0, keyQueue.length);
      for (const q of queued) routeKey(q);
    });
    return;
  }
  routeKey(k);
}
const onKeyDown = (e) => onKey("keydown", e);
const onKeyUp = (e) => onKey("keyup", e);

// ── the global hook ──────────────────────────────────────────────────────────
// Started only once BOTH grants are in place (starting earlier would trigger
// the OS prompts at a moment the renderer isn't explaining them). If macOS
// grants the permissions after a start already failed, the tap that failed is
// bound to the old TCC state and a relaunch is the reliable fix — that is what
// `needsRelaunch` tells the renderer.
let hookListenersBound = false;
function startHook() {
  if (!uIOhook || hookActive) return;
  try {
    if (!hookListenersBound) {
      uIOhook.on("keydown", onKeyDown);
      uIOhook.on("keyup", onKeyUp);
      hookListenersBound = true;
    }
    uIOhook.start();
    hookActive = true;
    hookStartFailed = false;
  } catch (e) {
    hookStartFailed = true;
    needsRelaunch = true;
    startupErrors.push(`keyboard hook failed to start: ${e.message}`);
  }
  push("state");
}

function stopHook() {
  if (!uIOhook || !hookActive) return;
  try { uIOhook.stop(); } catch { /* already stopped */ }
  hookActive = false;
}

function pollPermissions() {
  const next = permissions.status();
  const changed = next.accessibility !== perms.accessibility || next.inputMonitoring !== perms.inputMonitoring;
  perms = next;
  const granted = permissions.bothGranted(perms);
  if (granted && !grantedOnce) {
    grantedOnce = true;
    if (hookStartFailed) needsRelaunch = true;      // granted AFTER a blocked start
  }
  if (granted && !hookActive && !hookStartFailed) startHook();
  else if (granted && changed && hookActive) { stopHook(); startHook(); }   // regrant: cycle once
  if (changed) push("state");
}

// ── tray ─────────────────────────────────────────────────────────────────────
function trayImage(active) {
  // "inkk." as a macOS template image — recoloured by the system to match the
  // menu bar. The active variant adds a dot after the period while a session
  // is live. Electron picks the @2x file on Retina.
  const file = active ? "iconTemplateActive.png" : "iconTemplate.png";
  const img = nativeImage.createFromPath(path.join(__dirname, "assets", file));
  img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createFromNamedImage("NSApplicationIcon") : img;
}

function refreshTray() {
  if (!tray) return;
  const active = !!store.active();
  if (active === trayActive) return;
  trayActive = active;
  tray.setImage(trayImage(active));
}

function trayMenu() {
  const paused = !!pausedUntil();
  return Menu.buildFromTemplate([
    { label: "Open inkk", click: () => showWindow() },
    paused
      ? { label: "Resume", click: () => setPaused(null) }
      : { label: "Pause for an hour", click: () => setPaused(Date.now() + HOUR_MS) },
    { label: "Launch at login", type: "checkbox", checked: settings.launchAtLogin, click: (item) => setLaunchAtLogin(item.checked) },
    { type: "separator" },
    { label: "Quit inkk", click: () => app.quit() },
  ]);
}

// ── popover ──────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("blur", () => {
    if (win.webContents.isDevToolsOpened()) return;
    if (Date.now() < holdOpenUntil) return;       // an OS permission dialog took focus; stay put
    win.hide();
    blurHideAt = Date.now();
  });
  win.on("show", () => win.webContents.send("inkk:shown"));
  win.webContents.on("did-finish-load", () => { push("state"); push("sessions"); });
}

// Centre the window on the tray icon, just below the menu bar, clamped to the
// work area (the renderer draws the arrow at the top centre).
function positionWindow() {
  const tb = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  let x = Math.round(tb.x + tb.width / 2 - WIN_W / 2);
  x = Math.min(Math.max(x, area.x), area.x + area.width - WIN_W);
  const y = Math.round(tb.y + tb.height);
  win.setPosition(x, y, false);
}

function showWindow() {
  if (!win) return;
  positionWindow();
  // Show, then explicitly claim focus for THIS app. Without the steal an
  // accessory app's popover can leave macOS to activate whichever app was
  // previously frontmost, yanking the user into an unrelated window.
  win.showInactive();
  app.focus({ steal: true });
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); return; }
  // Clicking the menu-bar icon while the popover is open blurs it first (it
  // hides), then this click arrives: that click meant "close", not "reopen".
  if (Date.now() - blurHideAt < BLUR_CLICK_GUARD_MS) return;
  showWindow();
}

// ── settings actions (shared by ipc and the tray menu) ───────────────────────
function setPaused(untilMs) {
  settings.paused = typeof untilMs === "number" && untilMs > Date.now() ? untilMs : null;
  saveSettings();
  schedulePauseExpiry();
  push("state");
}

// When a pause runs out, say so without waiting for the next keystroke.
function schedulePauseExpiry() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  const until = pausedUntil();
  if (!until) return;
  pauseTimer = setTimeout(() => { pauseTimer = null; push("state"); }, until - Date.now() + 50);
}

function setLaunchAtLogin(v) {
  settings.launchAtLogin = !!v;
  try { app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); } catch (e) { console.warn("[inkk] login item:", e.message); }
  saveSettings();
  push("state");
}

// ── certify ──────────────────────────────────────────────────────────────────
// The HTTPS POST lives here (no CORS, no token in the page beyond the call).
// The session's whole trace goes up; the server re-scores it with the same
// extractFeatures/computeScore and writes the ledger row.
// The scorer reads only these fields (see src/telemetry/features.js); the
// rest of the event is dropped from the wire, nulls included, which keeps a
// long session's trace under the request-size limit.
function slimEvent(e) {
  const o = { id: e.id, doc_id: e.doc_id, t: e.t, kind: e.kind };
  if (typeof e.pt === "number") o.pt = Math.round(e.pt * 10) / 10;
  if (e.key_class != null) o.key_class = e.key_class;
  if (e.len_delta != null) o.len_delta = e.len_delta;
  if (e.caret_pos != null) o.caret_pos = e.caret_pos;
  if (e.kind === "session_start" && e.payload) o.payload = e.payload;
  return o;
}

async function certify(input) {
  const { sessionId, text, title, accessToken, authorName, code, contentHash, wordCount, charCount } = input || {};
  void text;                                          // the words never leave the renderer
  if (!sessionId || !store.get(sessionId)) return { ok: false, error: "Session not found" };
  if (!code || !contentHash) return { ok: false, error: "Missing code or content hash" };
  if (!accessToken) return { ok: false, error: "Sign in required", needsAuth: true };

  let events = store.eventsOf(sessionId).slice(-MAX_CERTIFY_EVENTS).map(slimEvent);
  const bodyFor = (evs) => JSON.stringify({
    docId: sessionId, code, contentHash, wordCount: wordCount | 0, charCount: charCount | 0,
    title: title || null, authorName: authorName || null, authorUsername: null, events: evs,
  });
  let body = bodyFor(events);
  // Keep the most recent part of a very long trace; the score is computed from
  // what is sent, and the tail is the writing closest to the finished text.
  while (Buffer.byteLength(body) > MAX_CERTIFY_BYTES && events.length > 1000) {
    events = events.slice(Math.floor(events.length * 0.15));
    body = bodyFor(events);
  }
  let res;
  try {
    res = await fetch(`${API_BASE}/api/certify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body,
      signal: AbortSignal.timeout(CERTIFY_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timedOut ? "inkk.site didn't answer — try again." : `Could not reach ${API_BASE}: ${e.message}` };
  }
  if (res.status === 401) return { ok: false, error: "Sign in required", needsAuth: true };
  let out = null;
  try { out = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || !out || !out.ok) return { ok: false, error: (out && out.error) || `Certification failed (${res.status})` };

  const cert = {
    code: out.code || code, verified: !!out.verified, tier: out.tier || null,
    score: typeof out.score === "number" ? out.score : null,
    issuedAt: Date.now(), title: title || null, wordCount: wordCount | 0,
    contentHash: out.contentHash || contentHash,
  };
  store.setCert(sessionId, cert);
  return { ok: true, cert };
}

// ── ipc ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`inkk:${name}`, (_e, ...args) => fn(...args));
  h("getState", () => getState());
  h("getSessions", () => store.list());
  h("getSession", (id) => store.get(id));
  h("endSession", (id) => { store.end(id || undefined); push("state"); push("sessions"); });
  h("deleteSession", (id) => { store.delete(id); push("state"); push("sessions"); });
  h("certify", (input) => certify(input));
  h("requestPermission", async (kind) => {
    holdOpenUntil = Date.now() + PERMISSION_HOLD_MS;   // the OS dialog will take focus; don't hide on that blur
    const st = await permissions.request(kind); pollPermissions(); return st;
  });
  h("openPermissionSettings", (kind) => { holdOpenUntil = Date.now() + PERMISSION_HOLD_MS; return permissions.openSettings(kind); });
  h("setOnboarded", (v) => { settings.onboarded = !!v; saveSettings(); push("state"); });
  h("setPaused", (untilMs) => setPaused(untilMs));
  h("setLaunchAtLogin", (v) => setLaunchAtLogin(v));
  h("setIgnoredApps", (list) => {
    settings.ignoredApps = [...new Set(list.filter(x => typeof x === "string" && x))];
    saveSettings(); push("state");
  });
  h("copyText", (t) => { clipboard.writeText(t); });
  h("openExternal", (url) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
  ipcMain.on("inkk:hide", () => win?.hide());
  ipcMain.on("inkk:quit", () => app.quit());
  ipcMain.on("inkk:relaunch", () => { app.relaunch(); app.quit(); });
}

// ── lifecycle ────────────────────────────────────────────────────────────────
process.on("uncaughtException", (e) => { console.error("[inkk] uncaught:", e); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    // Accessory policy = a true menu-bar-only agent: no dock icon, not in
    // Cmd-Tab, and showing the popover doesn't activate another app.
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    app.dock?.hide();

    loadSettings();
    // The system is the truth for launch-at-login (the user may have removed
    // inkk from Login Items in System Settings); adopt its answer.
    try {
      const sys = !!app.getLoginItemSettings().openAtLogin;
      if (sys !== settings.launchAtLogin) { settings.launchAtLogin = sys; saveSettings(); }
    } catch { /* ignore */ }
    schedulePauseExpiry();

    store = createStore({
      dir: DATA_DIR, now: Date.now, hrnow: () => performance.now(), genId: randomUUID, scoring,
      onChange: (what) => { push("state"); if (what === "sessions") push("sessions"); },
    });
    store.load();

    context = createContextPoller({ onChange: (cur) => {
      if (cur && cur.bundleId && cur.bundleId !== OWN_BUNDLE_ID) lastOtherFront = cur;
      push("state");
    } });
    context.start();

    createWindow();
    tray = new Tray(trayImage(false));
    trayActive = false;
    tray.setToolTip("inkk");
    tray.on("click", toggleWindow);
    tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));

    registerIpc();
    pollPermissions();
    setInterval(pollPermissions, PERM_POLL_MS);
    setInterval(() => { if (store.tick()) push("state"); }, TICK_MS);
    setInterval(() => { if (store.closeIdle().length) { push("state"); push("sessions"); } }, IDLE_CHECK_MS);

    if (SMOKE) {
      // `electron . --smoke`: bring everything up, print State, leave.
      setTimeout(() => { process.stdout.write(JSON.stringify(getState()) + "\n"); app.quit(); }, 1500);
    }
  });
}

app.on("window-all-closed", (e) => e.preventDefault());   // stay alive in the tray
app.on("before-quit", () => {
  try { store?.closeAll(); } catch (e) { console.warn("[inkk] flush on quit:", e.message); }
  stopHook();
  context?.stop();
});
