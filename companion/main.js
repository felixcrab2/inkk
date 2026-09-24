// inkk companion — Electron main process.
//
// A menu-bar agent with two halves.
//
// Writing: it records the RHYTHM of typing in any app (never the letters) as
// per-app sessions, each with its inkk code from the first keystroke. One
// click certifies a session; saving or exporting a document certifies it and
// puts the code in the file (lib/stamp.js); ⌃⌥S signs an email with the
// writer's name, whose link, description and ink all carry the code
// (lib/signature.js).
//
// Reading: whatever is in front is looked at, on this Mac, for an inkk code
// (lib/receiver.js): in its words, its links, its pictures and the metadata of
// its file. A code that turns up is looked up and checked against the text in
// front, and the popover (and a quiet notification) says what it found.
//
// The account a certificate needs lives here too (lib/auth.js): anonymous by
// default, so nobody signs up to start, and held in one place so every part of
// the app agrees on whether you are signed in.

"use strict";

const { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, nativeImage, screen, shell, globalShortcut, Notification, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { randomUUID } = crypto;
const { performance } = require("node:perf_hooks");

const { createStore } = require("./lib/sessions");
const codes = require("./lib/codes");
const reader = require("./lib/reader");
const helper = require("./lib/helper");
const docmeta = require("./lib/docmeta");
const signature = require("./lib/signature");
const { createContextPoller } = require("./lib/context");
const permissions = require("./lib/permissions");
const { buildKeymap, modString } = require("./lib/keymap");
const { createApi } = require("./lib/api");
const { createAuth } = require("./lib/auth");
const { createLookup } = require("./lib/lookup");
const { createReceiver } = require("./lib/receiver");
const { createStamper } = require("./lib/stamp");

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

let mark = null;
try { mark = require("./lib/mark"); } catch { /* signed names are read by link and description only */ }

let createSupabase = null;
try { ({ createClient: createSupabase } = require("@supabase/supabase-js")); } catch (e) { startupErrors.push(`supabase-js unavailable: ${e.message}`); }

let config = {};
try { config = require("./lib/config.cjs"); } catch { /* defaults below */ }
const SUPABASE_CONFIGURED = !!(config.REACT_APP_SUPABASE_URL && config.REACT_APP_SUPABASE_ANON_KEY);
const sha = (x) => crypto.createHash("sha256").update(x, "utf8").digest("hex");
const sealUrl = (code) => `https://www.inkk.site/v/${code}`;

const SMOKE = process.argv.includes("--smoke");

// ── constants ────────────────────────────────────────────────────────────────
const WIN_W = 340, WIN_H = 420;          // the height follows the content (inkk:resize)
const PUSH_MIN_MS = 250;                 // state pushes ≤ 4/s
const PERM_POLL_MS = 2000;
const IDLE_CHECK_MS = 30 * 1000;
const TICK_MS = 1000;
const REPOLL_AFTER_QUIET_MS = 2000;      // first key after this long re-polls the front app
const HOUR_MS = 60 * 60 * 1000;
const MAX_CERTIFY_EVENTS = 60000;
const MAX_CERTIFY_BYTES = 4 * 1024 * 1024;   // Vercel rejects request bodies over 4.5 MB
const RECENT_SESSION_MS = 2 * HOUR_MS;       // a document saved this long after writing still counts
const NOTIFY_AGAIN_MS = 10 * 60 * 1000;      // one notification per code per app in this long
const PASTE_GUARD_MS = 600;                  // our own ⌘V is not the writer's
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
const settings = {
  onboarded: false, paused: null, launchAtLogin: false, ignoredApps: DEFAULT_IGNORED.slice(),
  receive: true,            // notice codes in what is in front
  notify: true,             // …and say so in a notification
  stampDocuments: true,     // put the code into saved and exported documents
  readPictures: false,      // also read signed names and codes in pictures (needs Screen Recording)
  signatureName: "",        // the name ⌃⌥S signs with ("" = the Mac account's full name)
  signatureFace: "garamond",
  signShortcut: "Control+Alt+S",
};
const BOOL_SETTINGS = ["receive", "notify", "stampDocuments", "readPictures"];
const FACES = ["garamond", "fell", "sans"];

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (typeof s.onboarded === "boolean") settings.onboarded = s.onboarded;
    if (typeof s.paused === "number" || s.paused === null) settings.paused = s.paused;
    if (typeof s.launchAtLogin === "boolean") settings.launchAtLogin = s.launchAtLogin;
    if (Array.isArray(s.ignoredApps)) settings.ignoredApps = s.ignoredApps.filter(x => typeof x === "string");
    for (const k of BOOL_SETTINGS) if (typeof s[k] === "boolean") settings[k] = s[k];
    if (typeof s.signatureName === "string") settings.signatureName = s.signatureName.slice(0, 80);
    if (FACES.includes(s.signatureFace)) settings.signatureFace = s.signatureFace;
    if (typeof s.signShortcut === "string" && s.signShortcut) settings.signShortcut = s.signShortcut;
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
let perms = { accessibility: "not determined", inputMonitoring: "not determined", screen: "not determined" };
let hookActive = false;
let hookStartFailed = false;
let needsRelaunch = false;
let grantedOnce = false;                 // both grants seen at some point this run
let lastKeyAt = 0;
let trayActive = null;
let lastOtherFront = null;               // most recent front app that isn't inkk (what "Ignore <app>" offers)
let blurHideAt = 0;
let holdOpenUntil = 0;
let holdTimer = null;
let pauseTimer = null;
let repoll = null;                       // in-flight front-app re-poll; keys queue behind it
let ignoreKeysUntil = 0;                 // our own synthetic ⌘V
let accountName = "";                    // the Mac account's full name, the signature's default
let authState = { signedIn: false, anonymous: false, email: null };
let authNeeded = false;                  // an automatic certificate needed a sign-in
let seal = null;                         // what the receiver found in front (lib/receiver.js)
let lastStamp = null;                    // the last document stamped
let signing = false;
let shortcutOk = false;
let api = null, auth = null, lookup = null, receiver = null, stamper = null;
const notified = new Map();              // `${code}|${bundleId}` → when
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
    auth: { ...authState, needed: authNeeded },
    settings: {
      receive: settings.receive, notify: settings.notify, stampDocuments: settings.stampDocuments,
      readPictures: settings.readPictures, signatureName: settings.signatureName || accountName,
      signatureFace: settings.signatureFace, signShortcut: settings.signShortcut,
    },
    shortcutOk,
    helper: helper.available(),
    seal: seal && { ...seal, mine: isMine(seal.code) },
    lastStamp,
    signing,
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
  if (k.at.t < ignoreKeysUntil) return;
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
// Modifier keys held right now (by keycode), so a synthetic paste can wait
// for the writer to let go of the shortcut that triggered it.
const MODIFIER_NAMES = ["Ctrl", "CtrlRight", "Alt", "AltRight", "Shift", "ShiftRight", "Meta", "MetaRight"];
const modifierCodes = new Set(MODIFIER_NAMES.map((n) => UiohookKey && UiohookKey[n]).filter((c) => c != null));
const modifiersDown = new Set();

function onKey(type, e) {
  if (modifierCodes.has(e.keycode)) {
    if (type === "keydown") modifiersDown.add(e.keycode); else modifiersDown.delete(e.keycode);
  }
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
  const changed = next.accessibility !== perms.accessibility || next.inputMonitoring !== perms.inputMonitoring || next.screen !== perms.screen;
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
// A native macOS popover: the system's vibrancy material, shadow and rounded
// corners, light or dark with the system. Its height follows its content.
function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, show: false, frame: false, backgroundColor: "#00000000",
    vibrancy: "popover", visualEffectState: "active", roundedCorners: true, hasShadow: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("blur", () => {
    if (win.webContents.isDevToolsOpened()) return;
    if (Date.now() < holdOpenUntil) {
      // An OS permission dialog took focus: stay put for now, but a window that
      // never regains focus gets no second blur, so finish the job when the hold ends.
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) { win.hide(); blurHideAt = Date.now(); }
      }, Math.max(0, holdOpenUntil - Date.now()) + 50);
      return;
    }
    win.hide();
    blurHideAt = Date.now();
  });
  win.on("focus", () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
  win.on("show", () => win.webContents.send("inkk:shown"));
  win.webContents.on("did-finish-load", () => { push("state"); push("sessions"); });
}

// Just below the menu-bar icon, centred on it, kept on screen.
function positionWindow() {
  const tb = tray.getBounds();
  const [w] = win.getSize();
  const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  let x = Math.round(tb.x + tb.width / 2 - w / 2);
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - w - 8);
  const y = Math.round(tb.y + tb.height + 4);
  win.setPosition(x, y, false);
}

function resizeWindow(h) {
  if (!win || !Number.isFinite(h)) return;
  const area = screen.getDisplayNearestPoint(win.getBounds()).workArea;
  const height = Math.max(120, Math.min(Math.ceil(h), area.height - 40));
  const [w, cur] = win.getSize();
  if (cur !== height) win.setSize(w, height, false);
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

async function refreshAuthState() {
  if (!auth) return;
  const next = await auth.state();
  const changed = JSON.stringify(next) !== JSON.stringify(authState);
  authState = next;
  if (next.signedIn && authNeeded) authNeeded = false;
  if (changed) push("state");
}

// A token for /api/certify: the account's, or a new anonymous one.
async function accessToken() {
  if (!auth || !auth.configured) return { error: "This build of inkk can't issue certificates." };
  const t = await auth.ensureToken();
  refreshAuthState();
  if (t.token) return { token: t.token };
  if (t.reason === "offline") return { error: "inkk.site can't be reached." };
  if (t.reason === "disabled") return { needsAuth: true, error: "Sign in to certify." };
  return { error: "Couldn't start an inkk account." };
}

// The most recent session in an app: the open one, or one that ended lately.
function sessionFor(bundleId) {
  if (!store || !bundleId) return null;
  const t = Date.now();
  return store.list().find((s) => s.bundleId === bundleId && (s.endedAt == null || t - s.lastKeyAt < RECENT_SESSION_MS)) || null;
}

function isMine(code) {
  if (!store || !code) return false;
  return store.list().some((s) => s.code === code || (s.cert && s.cert.code === code) || (s.certs || []).some((c) => c.code === code));
}

// Issue (or re-affirm) a certificate for a session, bound to `text` when there
// is enough of it and to the session otherwise. Every caller comes through
// here: the popover's Certify, a saved document, a signed email.
//   → { ok: true, cert } | { ok: false, error, needsAuth? }
async function issue({ sessionId, text, source = "companion", binding = null, filePath = null, authorName = null }) {
  const sess = sessionId && store.get(sessionId);
  if (!sess) return { ok: false, error: "That session is no longer here." };
  if (!scoring) return { ok: false, error: "This build of inkk is incomplete." };

  let contentHash, sketch = null, wordCount, charCount;
  const canonical = text ? scoring.canonicalText(text) : "";
  if (canonical.length >= 40) {
    contentHash = await scoring.textFingerprint(text, sha);
    sketch = await scoring.textSketch(text, sha);
    wordCount = canonical.split(/\s+/).filter(Boolean).length;
    charCount = canonical.length;
    binding = binding || "text";
  } else {
    contentHash = codes.sessionHash(sessionId);
    wordCount = sess.wordsEst | 0;
    binding = "session";
  }

  const t = await accessToken();
  if (!t.token) {
    if (t.needsAuth) { authNeeded = true; push("state"); }
    return { ok: false, error: t.error, needsAuth: !!t.needsAuth };
  }

  let events = store.eventsOf(sessionId).slice(-MAX_CERTIFY_EVENTS).map(slimEvent);
  const name = authorName || (await auth.authorName()) || null;
  const payloadFor = (code, evs) => ({
    docId: sessionId, code, contentHash, wordCount, charCount, sketch, binding, source,
    title: null, authorName: name, authorUsername: null, events: evs,
  });
  let code = store.codeFor(sessionId, contentHash);
  let payload = payloadFor(code, events);
  // Keep the most recent part of a very long trace; the score is computed from
  // what is sent, and the tail is the writing closest to the finished text.
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_CERTIFY_BYTES && events.length > 1000) {
    events = events.slice(Math.floor(events.length * 0.15));
    payload = payloadFor(code, events);
  }

  let r = await api.certify(payload, t.token);
  if (!r.ok && r.needsAuth && authState.anonymous) {
    // The anonymous account was refused (removed on the server): start a new one.
    await auth.signOut();
    const again = await accessToken();
    if (again.token) r = await api.certify(payload, again.token);
  }
  // The ledger already binds this code to other words (a copy of the session
  // log from before a reinstall, say): this version gets a code of its own.
  if (r.ok && r.result.contentHash && r.result.contentHash !== contentHash) {
    code = codes.makeCode();
    r = await api.certify(payloadFor(code, events), t.token);
  }
  if (!r.ok) {
    if (r.needsAuth) { authNeeded = true; refreshAuthState(); push("state"); }
    return r;
  }

  const out = r.result;
  const cert = {
    code: out.code || code, verified: !!out.verified, tier: out.tier || null,
    score: typeof out.score === "number" ? out.score : null,
    issuedAt: Date.now(), title: null, wordCount, binding, source,
    contentHash: out.contentHash || contentHash, sketchStored: !!out.sketchStored,
    ...(filePath ? { file: path.basename(filePath) } : {}),
  };
  store.setCert(sessionId, cert);
  authNeeded = false;
  stamper?.remember({ code: cert.code, sessionId, contentHash: cert.contentHash, sketch });
  lookup?.remember({
    code: cert.code, content_hash: cert.contentHash, text_sketch: sketch, verified: cert.verified,
    score_tier: cert.tier, human_score: cert.score, author_name: name, issued_at: new Date(cert.issuedAt).toISOString(), binding,
  });
  push("state");
  return { ok: true, cert };
}

// The popover's Certify: the piece is read from the app it was written in,
// right now, fingerprinted here and dropped.
async function certifySession(sessionId) {
  const sess = sessionId && store.get(sessionId);
  if (!sess) return { ok: false, error: "That session is no longer here." };
  const text = await reader.readFocusedText(sess.bundleId);
  return issue({ sessionId, text, source: "companion" });
}

// ── signing an email ─────────────────────────────────────────────────────────
function notify(title, body, { subtitle, onClick } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, subtitle, silent: true });
  n.on("click", () => (onClick ? onClick() : showWindow()));
  n.show();
}

// ⌃⌥S where the name goes: certify what has been written, then put the signed
// name at the caret. `target` is the app to sign in (the popover passes the
// app that was in front before it opened).
async function signHere(target) {
  if (signing) return;
  if (!uIOhook || !permissions.bothGranted(perms)) { showWindow(); return; }
  signing = true;
  push("state");
  try {
    const front = target || (await context.pollNow()) || context.current();
    if (!front || !front.bundleId || front.bundleId === OWN_BUNDLE_ID) return;
    const sess = sessionFor(front.bundleId);
    if (!sess) { notify("Nothing to sign yet", `Write in ${front.name || "this app"} first, then sign.`); return; }
    const text = await reader.readFocusedText(front.bundleId);
    const name = (settings.signatureName || accountName || "").trim();
    if (!name) { notify("Add your name", "Set the name you sign with in inkk's settings."); showWindow(); return; }
    const r = await issue({ sessionId: sess.id, text, source: "signature", binding: "text", authorName: name });
    if (!r.ok) {
      if (r.needsAuth) showWindow();
      else notify("Not signed", r.error || "The certificate couldn't be issued.");
      return;
    }
    const rendered = await signature.renderName({ BrowserWindow, dir: __dirname, name, code: r.cert.code, face: settings.signatureFace });
    const p = signature.clipboardPayload({ nativeImage, rendered, name, code: r.cert.code, seal: sealUrl(r.cert.code) });
    clipboard.write({ text: p.text, html: p.html, image: p.image });
    // Paste where the caret is, once the shortcut's keys are up (⌃⌥ held
    // down would turn ⌘V into another command). The keys we send are not the
    // writer's.
    for (let waited = 0; modifiersDown.size && waited < 2500; waited += 30) await new Promise((res) => setTimeout(res, 30));
    modifiersDown.clear();
    ignoreKeysUntil = Date.now() + PASTE_GUARD_MS;
    await new Promise((res) => setTimeout(res, 40));
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Meta]);
  } catch (e) {
    console.warn("[inkk] sign:", e.message);
    notify("Not signed", "Something went wrong drawing the name. Try again.");
  } finally {
    signing = false;
    push("state");
  }
}

function registerShortcut() {
  try { globalShortcut.unregisterAll(); } catch { /* none */ }
  shortcutOk = false;
  try { shortcutOk = globalShortcut.register(settings.signShortcut, () => { signHere(null); }); }
  catch { shortcutOk = false; }
}

// ── the receiver and the stamper ─────────────────────────────────────────────
function describeSeal(s) {
  const c = s.cert;
  const who = c.author_name || null;
  const when = c.issued_at ? new Date(c.issued_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null;
  const title = c.verified ? "Verified" : "Recorded";
  const subtitle = [who, when].filter(Boolean).join(", ") || undefined;
  const body = s.match.state === "match" ? `The text in ${s.app} matches its certificate.`
    : s.match.state === "partial" ? `Most of the text in ${s.app} matches its certificate.`
    : s.match.state === "differs" ? `The text in ${s.app} has changed since it was certified.`
    : `Certified${when ? ` ${when}` : ""}.`;
  return { title, subtitle, body };
}

function maybeNotify(s) {
  if (!s || !s.cert || !settings.notify || isMine(s.code)) return;
  if (win && win.isVisible()) return;
  const key = `${s.code}|${s.bundleId}`;
  const last = notified.get(key) || 0;
  if (Date.now() - last < NOTIFY_AGAIN_MS) return;
  notified.set(key, Date.now());
  const d = describeSeal(s);
  notify(d.title, d.body, { subtitle: d.subtitle });
}

function startReadingAndStamping() {
  receiver = createReceiver({
    helper, reader, docmeta, mark, lookup, scoring, sha,
    getFront: () => context.current(), ownBundleId: OWN_BUNDLE_ID,
    isIgnored: (b) => settings.ignoredApps.includes(b),
    isEnabled: () => settings.receive && !pausedUntil() && permissions.bothGranted(perms) && !!scoring,
    canReadPictures: () => settings.readPictures && perms.screen === "granted",
    onSeal: (next) => { seal = next; push("state"); maybeNotify(next); },
    log: (m) => console.warn("[inkk]", m),
  });
  stamper = createStamper({
    docmeta, helper, reader, scoring, sha,
    getFront: () => { const f = context.current(); return f && f.bundleId !== OWN_BUNDLE_ID ? f : null; },
    findSession: (bundleId) => sessionFor(bundleId),
    certifyText: ({ sessionId, text, path: filePath }) => issue({ sessionId, text, source: "file", binding: "file", filePath }),
    onStamp: (st) => { lastStamp = { path: st.path, name: path.basename(st.path), code: st.code, ok: st.ok, at: Date.now() }; push("state"); },
    isEnabled: () => settings.stampDocuments && !pausedUntil() && permissions.bothGranted(perms) && !!scoring,
    backupsDir: path.join(DATA_DIR, "backups"),
    log: (m) => console.warn("[inkk]", m),
  });
  // Seeds the export matcher with what was certified before this launch
  // (fingerprints only; the sketch of an older certificate isn't kept).
  for (const s of store.list()) if (s.cert && Date.now() - s.cert.issuedAt < RECENT_SESSION_MS) {
    stamper.remember({ code: s.cert.code, sessionId: s.id, contentHash: s.cert.contentHash, sketch: [] });
  }
  setInterval(() => { receiver.tick(); }, 1000);
  setInterval(() => { stamper.tick(); }, 2000);
}

// ── ipc ──────────────────────────────────────────────────────────────────────
function setSetting(key, value) {
  if (BOOL_SETTINGS.includes(key)) settings[key] = !!value;
  else if (key === "signatureName") settings.signatureName = String(value || "").trim().slice(0, 80);
  else if (key === "signatureFace" && FACES.includes(value)) settings.signatureFace = value;
  else return;
  saveSettings();
  if (key === "receive" && !settings.receive) { seal = null; receiver?.clear(); }
  if (key === "readPictures" && settings.readPictures && perms.screen !== "granted") {
    holdOpenUntil = Date.now() + PERMISSION_HOLD_MS;
    permissions.request("screen").then(() => pollPermissions());
  }
  push("state");
}

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`inkk:${name}`, (_e, ...args) => fn(...args));
  h("getState", () => getState());
  h("getSessions", () => store.list());
  h("getSession", (id) => store.get(id));
  h("endSession", (id) => { store.end(id || undefined); push("state"); push("sessions"); });
  h("deleteSession", (id) => { store.delete(id); push("state"); push("sessions"); });
  h("certify", (id) => certifySession(typeof id === "object" && id ? id.sessionId : id));
  h("sign", async () => {
    // The popover is in front; sign in the app that was in front before it.
    const target = lastOtherFront;
    win?.hide();
    app.hide();
    await new Promise((r) => setTimeout(r, 250));
    return signHere(target);
  });
  h("signIn", async (email, password) => { const r = await auth.signIn(email, password); await refreshAuthState(); if (r.ok) authNeeded = false; push("state"); return r; });
  h("signOut", async () => { await auth.signOut(); await refreshAuthState(); push("state"); });
  h("importSession", async (tokens) => { const ok = await auth.importSession(tokens); await refreshAuthState(); return ok; });
  h("requestPermission", async (kind) => {
    holdOpenUntil = Date.now() + PERMISSION_HOLD_MS;   // the OS dialog will take focus; don't hide on that blur
    const st = await permissions.request(kind); pollPermissions(); return st;
  });
  h("openPermissionSettings", (kind) => { holdOpenUntil = Date.now() + PERMISSION_HOLD_MS; return permissions.openSettings(kind); });
  h("setOnboarded", (v) => { settings.onboarded = !!v; saveSettings(); push("state"); });
  h("setPaused", (untilMs) => setPaused(untilMs));
  h("setLaunchAtLogin", (v) => setLaunchAtLogin(v));
  h("setSetting", (key, value) => setSetting(key, value));
  h("setReceive", (v) => setSetting("receive", v));
  h("setIgnoredApps", (list) => {
    settings.ignoredApps = [...new Set(list.filter(x => typeof x === "string" && x))];
    saveSettings(); push("state");
  });
  h("copyText", (t) => { clipboard.writeText(t); });
  h("openExternal", (url) => (/^https:\/\//.test(url) ? shell.openExternal(url) : undefined));
  h("revealFile", (p) => { if (typeof p === "string" && fs.existsSync(p)) shell.showItemInFolder(p); });
  h("previewSignature", async () => {
    const name = (settings.signatureName || accountName || "").trim();
    if (!name) return null;
    try { return await signature.renderName({ BrowserWindow, dir: __dirname, name, code: "INKK-0000-0000-0000", face: settings.signatureFace }); }
    catch { return null; }
  });
  ipcMain.on("inkk:resize", (_e, h) => resizeWindow(h));
  ipcMain.on("inkk:hide", () => win?.hide());
  ipcMain.on("inkk:quit", () => app.quit());
  ipcMain.on("inkk:relaunch", () => { app.relaunch(); app.quit(); });
}

// ── lifecycle ────────────────────────────────────────────────────────────────
process.on("uncaughtException", (e) => { console.error("[inkk] uncaught:", e); });

// `open -a inkk --args --probe` (a second launch) makes the running app look at
// the window in front once and write what it found to <userData>/inkk/probe.json:
// counts and codes only, never text. For checking a Mac's setup.
async function probe() {
  const f = await helper.frontWindow();
  const w = f ? await reader.readWindow(f) : null;
  if (receiver) await receiver.tick({ force: true });
  const out = {
    at: new Date().toISOString(), helper: helper.available(), permissions: perms,
    front: f && { bundleId: f.bundleId, id: f.id, titleChars: (f.title || "").length },
    window: w && { textChars: w.text.length, links: w.links.length, images: w.images.length, document: !!w.document,
      codes: codes.findCodes([w.title, w.text, ...w.links, ...w.images].join("\n")) },
    seal: seal && { code: seal.code, source: seal.source, found: !!seal.cert, match: seal.match },
    auth: { signedIn: authState.signedIn, anonymous: authState.anonymous }, shortcutOk,
  };
  // Can this build draw a signed name whose ink reads back as its code?
  try {
    const code = "INKK-4B7N-R2XE-8KMT";
    const r = await signature.renderName({ BrowserWindow, dir: __dirname, name: (settings.signatureName || accountName || "Ada Writer").trim(), code, face: settings.signatureFace });
    const img = nativeImage.createFromDataURL(r.dataUrl);
    const size = img.getSize();
    // As it shows in an email: over white paper.
    const px = img.toBitmap();
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * a + 255 * (1 - a));
      px[i + 3] = 255;
    }
    const found = mark ? mark.decodeMarks({ width: size.width, height: size.height, data: px }, { format: "bgra" }) : [];
    out.signature = { width: r.width, height: r.height, reads: found.some((f) => f.code === code) };
  } catch (e) { out.signature = { error: e.message }; }
  // Does a signed-in request reach /api/certify with its token intact? An
  // incomplete body is refused after the sign-in check and before anything is
  // written, so this proves the account works without issuing a certificate.
  if (auth && authState.signedIn) {
    const t = await auth.ensureToken();
    const r = t.token ? await api.certify({}, t.token) : { ok: false, error: t.reason };
    out.certifyReach = r.needsAuth ? "refused: sign-in not accepted" : r.error === "Missing docId or code" ? "ok: signed in and reached" : `unexpected: ${r.error}`;
  }
  try { fs.writeFileSync(path.join(DATA_DIR, "probe.json"), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--probe")) { probe(); return; }
    showWindow();
  });

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

    api = createApi({ base: config.INKK_API_BASE });
    auth = createAuth({
      url: config.REACT_APP_SUPABASE_URL, anonKey: config.REACT_APP_SUPABASE_ANON_KEY,
      file: path.join(DATA_DIR, "auth.json"), createClient: createSupabase,
      log: (m) => console.warn("[inkk]", m),
    });
    auth.onChange(() => refreshAuthState());
    refreshAuthState();
    lookup = createLookup({ api, supabaseUrl: config.REACT_APP_SUPABASE_URL, anonKey: config.REACT_APP_SUPABASE_ANON_KEY });
    signature.fullName().then((n) => { accountName = n; push("state"); });

    store = createStore({
      dir: DATA_DIR, now: Date.now, hrnow: () => performance.now(), genId: randomUUID, genCode: codes.makeCode, scoring,
      onChange: (what) => { push("state"); if (what === "sessions") push("sessions"); },
    });
    store.load();

    context = createContextPoller({ onChange: (cur) => {
      if (cur && cur.bundleId && cur.bundleId !== OWN_BUNDLE_ID) lastOtherFront = cur;
      push("state");
      receiver?.nudge();                           // a new window in front: look at it soon
    } });
    context.start();

    createWindow();
    tray = new Tray(trayImage(false));
    trayActive = false;
    tray.setToolTip("inkk");
    tray.on("click", toggleWindow);
    tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));
    nativeTheme.on("updated", () => push("state"));

    registerIpc();
    registerShortcut();
    pollPermissions();
    setInterval(pollPermissions, PERM_POLL_MS);
    setInterval(() => { if (store.tick()) push("state"); }, TICK_MS);
    startReadingAndStamping();
    setInterval(() => { if (store.closeIdle().length) { push("state"); push("sessions"); } }, IDLE_CHECK_MS);

    if (SMOKE) {
      // `electron . --smoke`: bring everything up, print State, leave.
      setTimeout(() => { process.stdout.write(JSON.stringify(getState()) + "\n"); app.quit(); }, 2500);
    }
  });
}

app.on("window-all-closed", (e) => e.preventDefault());   // stay alive in the tray
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch { /* none */ } });
app.on("before-quit", () => {
  try { store?.closeAll(); } catch (e) { console.warn("[inkk] flush on quit:", e.message); }
  stopHook();
  context?.stop();
  signature.dispose();
});
