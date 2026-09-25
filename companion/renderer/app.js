// inkk companion — the popover.
//
// One state object, one render() that rebuilds the page from template
// literals, and event delegation on the root. Everything the page knows comes
// through window.inkk (preload.js): main owns the keyboard hook, the sessions,
// the account, the certificates and the receiver. This side only shows them.

const SITE = "https://www.inkk.site";

/* ═══ State ══════════════════════════════════════════════════════════════ */

const state = {
  screen: "home",          // setup | home | session | settings | signin
  app: null,               // State pushed by main
  sessions: [],            // SessionSummary[], newest first
  pieces: [],              // pieces of writing, each across its sittings, newest first
  sessionId: null,
  detail: null,
  confirmDelete: false,
  busy: null,              // id of the session being certified
  flash: null,             // { id, text } a short confirmation under a code
  error: null,             // { id, text }
  pending: null,           // session to certify once signed in
  signin: { email: "", password: "", busy: false, error: null },
  asked: {},               // permissions already requested this launch
  recordsOpen: false,
  sigPreview: null,
};

/* ═══ Helpers ════════════════════════════════════════════════════════════ */

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const fmtNum = (n) => Number(n || 0).toLocaleString("en-GB");
const MIN = 60000;

function fmtDuration(ms) {
  const m = Math.round((ms || 0) / MIN);
  if (m < 1) return "under a minute";
  if (m === 1) return "1 minute";
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60), r = m % 60;
  const hs = h === 1 ? "1 hour" : `${h} hours`;
  return r ? `${hs} ${r} min` : hs;
}
const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
function when(ts) {
  const d = Date.now() - ts;
  if (d < MIN) return "Now";
  if (d < 60 * MIN) return `${Math.round(d / MIN)} min ago`;
  if (ts >= startOfDay(Date.now())) return `Today, ${clock(ts)}`;
  if (ts >= startOfDay(Date.now()) - 86400000) return "Yesterday";
  const t = new Date(ts);
  const year = t.getFullYear() === new Date().getFullYear() ? "" : ` ${t.getFullYear()}`;
  return `${DAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()].slice(0, 3)}${year}`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

const granted = (s) => !!s && s.permissions?.accessibility === "granted" && s.permissions?.inputMonitoring === "granted";
const paused = (s) => !!(s?.paused && s.paused > Date.now());
const needsSetup = (s) => !s || !s.onboarded || !granted(s);
const verifiedTier = (t) => t === "Strong" || t === "Distinct";
const scoreText = (sc) => (sc && sc.tier ? `${sc.tier}, ${sc.score}` : "");
const sealLine = (code) => `inkk. inkk.site/v/${code}`;
const shortcutLabel = (acc) => String(acc || "").replace(/Control\+/g, "⌃").replace(/Alt\+|Option\+/g, "⌥").replace(/Shift\+/g, "⇧").replace(/(Command|Cmd|CommandOrControl)\+/g, "⌘");

const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  back: svg(`<path d="M15 5l-7 7 7 7"/>`),
};

/* ═══ Pieces ═════════════════════════════════════════════════════════════ */

function status(s) {
  if (!s) return "";
  if (!granted(s)) return "Needs permission";
  if (s.needsRelaunch || !s.hookActive) return "Not recording";
  if (paused(s)) return `Paused until ${clock(s.paused)}`;
  if (s.signing) return "Signing";
  if (s.active) return `Writing in ${s.active.app}`;
  return "Listening";
}

function header({ back = false, title = "" } = {}) {
  const left = back
    ? `<span class="hd-title"><button class="icon-btn" data-action="back" aria-label="Back">${ICON.back}</button>${esc(title)}</span>`
    : `<span class="mark">inkk.</span>`;
  const right = back ? "" : `<span class="hd-right"><span>${esc(status(state.app))}</span><button class="icon-btn" data-action="go" data-screen="settings" aria-label="Settings">${ICON.gear}</button></span>`;
  return `<header class="hd">${left}${right}</header><div class="sep"></div>`;
}

// The code, and what can be done with it. A code is there from the first
// keystroke; Certify binds it and puts the seal on the clipboard.
function codeBlock(x, meta = [], kind = "session") {
  const cert = x.cert;
  const busy = state.busy === x.id;
  const flash = state.flash && state.flash.id === x.id ? state.flash.text : null;
  const err = state.error && state.error.id === x.id ? state.error.text : null;
  const code = (cert && cert.code) || x.code;
  if (!code) return "";
  const note = flash || err || (cert ? certNote(cert) : null);
  const buttons = cert
    ? `<button class="b p" data-action="copy-seal" data-id="${esc(x.id)}" data-code="${esc(cert.code)}">Copy seal</button>
       <button class="b" data-action="certify" data-id="${esc(x.id)}" data-kind="${kind}"${busy ? " disabled" : ""}>${busy ? "Certifying" : "Certify again"}</button>
       <button class="b" data-action="open" data-url="${SITE}/v/${esc(cert.code)}">Open</button>`
    : `<button class="b p" data-action="certify" data-id="${esc(x.id)}" data-kind="${kind}"${busy ? " disabled" : ""}>${busy ? "Certifying" : "Certify"}</button>`;
  const lines = (Array.isArray(meta) ? meta : [meta]).filter(Boolean);
  return `<div class="code${cert ? "" : " pending"}">${esc(code)}</div>
    ${lines.map((m) => `<div class="meta">${esc(m)}</div>`).join("")}
    ${note ? `<div class="meta">${esc(note)}</div>` : ""}
    <div class="btns">${buttons}${x.endedAt == null && x.id === state.app?.active?.id ? `<button class="b" data-action="end" data-id="${esc(x.id)}">End</button>` : ""}</div>`;
}

function certNote(cert) {
  const v = cert.verified || verifiedTier(cert.tier);
  const what = cert.binding === "session" ? "the session" : cert.file ? cert.file : cert.source === "signature" ? "the email" : "the text";
  return `${v ? "Verified" : "Recorded"}, bound to ${what}`;
}

// The piece being written. When it was started in an earlier sitting, it says
// so: the code and the counts are the whole piece's.
function activeSection(a) {
  const title = (a.piece && a.piece.label) || a.docLabel || a.app;
  const lines = [`${fmtNum(a.keystrokes)} keystrokes in ${fmtDuration(a.activeMs)}`];
  if (a.piece && a.piece.sessions > 1) lines.push(`Continued from ${sinceLabel(a.piece.startedAt)}`);
  return `<section class="sec">
    <div class="line"><span class="big">${esc(title)}</span><span class="meta">${esc(scoreText(a.score))}</span></div>
    ${codeBlock(a, lines)}
  </section>`;
}

function sinceLabel(ts) {
  const w = when(ts);
  return /^(Now|\d+ min ago)$/.test(w) ? "earlier today" : w.replace(/^Today, /, "today at ");
}

function idleSection(s) {
  if (s && granted(s) && (s.needsRelaunch || !s.hookActive)) {
    return `<section class="sec"><div class="big">Not recording</div>
      <div class="meta gap">${esc(s.error ? "The keyboard hook didn't start." : "Relaunching inkk usually fixes this.")}</div>
      <div class="btns"><button class="b p" data-action="relaunch">Relaunch</button></div></section>`;
  }
  if (paused(s)) {
    return `<section class="sec"><div class="big">Paused</div>
      <div class="meta gap">Nothing is recorded until ${clock(s.paused)}.</div>
      <div class="btns"><button class="b" data-action="resume">Resume</button></div></section>`;
  }
  return `<section class="sec"><div class="big">Nothing being written</div>
    <div class="meta gap">Start typing anywhere and a code appears here.</div></section>`;
}

// What the receiver found in the window in front.
function sealSection(seal) {
  if (!seal) return "";
  const c = seal.cert;
  const where = seal.source === "file" && seal.path ? seal.path.split("/").pop() : seal.app;
  if (!c) {
    return `<div class="sep"></div><section class="sec"><div class="lab">In ${esc(where)}</div>
      <div class="big">${seal.offline ? "Couldn't check this code" : "Not in the ledger"}</div>
      <div class="meta gap">${esc(seal.code)}</div></section>`;
  }
  const v = !!c.verified;
  const match = seal.match?.state === "match" ? "The text matches"
    : seal.match?.state === "partial" ? `${Math.round((seal.match.ratio || 0) * 100)}% of the text matches`
    : seal.match?.state === "differs" ? "The text has changed since it was certified" : null;
  const by = [c.author_name || c.author_username, longDate(c.issued_at)].filter(Boolean).join(", ");
  return `<div class="sep"></div><section class="sec">
    <div class="lab">In ${esc(where)}</div>
    <div class="line"><span class="big">${v ? "Verified" : "Recorded"}${seal.mine ? `<span class="meta">&nbsp;&nbsp;Yours</span>` : ""}</span><span class="meta">${esc(scoreText({ tier: c.score_tier, score: c.human_score }))}</span></div>
    ${by ? `<div class="meta gap">${esc(by)}</div>` : ""}
    ${match ? `<div class="meta">${esc(match)}</div>` : ""}
    <div class="btns"><button class="b" data-action="open" data-url="${SITE}/v/${esc(seal.code)}">Open certificate</button></div>
  </section>`;
}

function signInSection() {
  const a = state.app?.auth;
  if (!a || !a.needed || a.signedIn && !a.anonymous) return "";
  return `<div class="sep"></div><section class="sec"><div class="big">Sign in to certify</div>
    <div class="meta gap">Certificates are kept in inkk's ledger under your account.</div>
    <div class="btns"><button class="b p" data-action="go" data-screen="signin">Sign in</button></div></section>`;
}

function stampSection(st) {
  if (!st || !st.ok || Date.now() - st.at > 30 * MIN) return "";
  return `<div class="sep"></div><section class="sec tight"><div class="lab">Documents</div></section>
    <button class="row" data-action="reveal" data-path="${esc(st.path)}"><span class="n">${esc(st.name)}</span><span class="r">Code added&nbsp;&nbsp;${esc(when(st.at))}</span></button><div class="list-end"></div>`;
}

// Pieces of writing, and any sitting that never became one (too little text
// to recognise), newest first.
function recentSection() {
  const active = state.app?.active;
  const activePiece = active?.piece?.id;
  const items = [
    ...state.pieces.filter((p) => p.id !== activePiece).map((p) => ({ screen: "piece", id: p.id, label: p.label, lastAt: p.lastAt, cert: p.cert })),
    ...state.sessions.filter((x) => !x.pieceId && x.id !== active?.id).map((x) => ({ screen: "session", id: x.id, label: x.docLabel || x.app, lastAt: x.lastKeyAt, cert: x.cert })),
  ].sort((a, b) => b.lastAt - a.lastAt).slice(0, 6);
  if (!items.length) return "";
  return `<div class="sep"></div><section class="sec tight"><div class="lab">Recent</div></section>
    ${items.map((x) => `<button class="row" data-action="go" data-screen="${x.screen}" data-id="${esc(x.id)}">
      <span class="n">${esc(x.label)}</span>
      <span class="r">${x.cert ? `<b>${(x.cert.verified || verifiedTier(x.cert.tier)) ? "Verified" : "Recorded"}</b>` : ""}${esc(when(x.lastAt))}</span>
    </button>`).join("")}<div class="list-end"></div>`;
}

function footer(s) {
  const sign = s?.shortcutOk ? `<button data-action="sign">Sign an email<kbd>${esc(shortcutLabel(s.settings?.signShortcut))}</kbd></button>` : `<button data-action="sign">Sign an email</button>`;
  const pause = paused(s) ? `<button data-action="resume">Resume</button>` : `<button data-action="pause">Pause</button>`;
  return `<div class="sep"></div><footer class="foot">${sign}${pause}</footer>`;
}

/* ═══ Screens ════════════════════════════════════════════════════════════ */

function permRow(kind, name, why, st) {
  let right;
  const asked = !!state.asked[kind];
  if (st === "granted") right = `<span class="on">On</span>`;
  else if (st === "restricted" || (asked && st === "denied")) right = `<button class="b" data-action="perm-settings" data-kind="${kind}">Open Settings</button>`;
  else right = `<button class="b p" data-action="perm-request" data-kind="${kind}">Allow</button>`;
  return `<div class="perm"><div><div>${name}</div><div class="sub">${why}</div></div>${right}</div>`;
}

function screenSetup() {
  const s = state.app;
  const p = s?.permissions || {};
  const ready = granted(s);
  const stuck = Object.keys(state.asked).some((k) => p[k] && p[k] !== "granted");
  return `<header class="hd"><span class="mark">inkk.</span></header><div class="sep"></div>
    <section class="sec">
      <div class="big">Set up inkk</div>
      <div class="meta gap">inkk times your typing, never the letters, so what you write can prove a person wrote it.</div>
      <div style="margin-top:8px">
        ${permRow("accessibility", "Accessibility", "To work alongside your other apps", p.accessibility)}
        ${permRow("inputMonitoring", "Input Monitoring", "To time each key press", p.inputMonitoring)}
      </div>
      ${stuck ? `<div class="meta">If macOS didn't ask, switch inkk on in System Settings.</div>` : ""}
      ${ready ? `<div class="btns"><button class="b p wide" data-action="${s.needsRelaunch ? "relaunch" : "start"}">${s.needsRelaunch ? "Relaunch inkk" : "Start"}</button></div>` : ""}
    </section>
    <div class="sep"></div>
    <footer class="foot"><span>No account needed</span><span><button data-action="open" data-url="${SITE}/terms">Terms</button>&nbsp;&nbsp;&nbsp;<button data-action="open" data-url="${SITE}/privacy">Privacy</button></span></footer>`;
}

function signErrorSection(s) {
  if (!s || !s.signError) return "";
  return `<section class="sec"><div class="big">Not signed</div><div class="meta gap">${esc(s.signError)}</div></section><div class="sep"></div>`;
}

function screenHome() {
  const s = state.app;
  return header()
    + signErrorSection(s)
    + (s?.active ? activeSection(s.active) : idleSection(s))
    + signInSection()
    + sealSection(s?.seal)
    + stampSection(s?.lastStamp)
    + recentSection()
    + footer(s);
}

function screenSession() {
  const d = state.detail;
  if (!d) return header({ back: true, title: "" }) + `<section class="sec"><div class="meta">${state.detailMissing ? "This session is no longer here." : ""}</div></section>`;
  const f = d.full || {};
  const end = d.endedAt ? clock(d.endedAt) : "now";
  const rows = [
    ["Started", `${when(d.startedAt)}${d.endedAt ? `, until ${end}` : ""}`],
    ["Writing time", fmtDuration(d.activeMs)],
    ["Keystrokes", fmtNum(d.keystrokes)],
    ["Words, about", fmtNum(d.wordsEst)],
    ["Pauses to think", fmtNum(f.thinking_pauses)],
    ["Corrections", fmtNum(f.typo_corrections)],
  ];
  return header({ back: true, title: d.app })
    + `<section class="sec">
      <div class="line"><span class="big">${esc(d.score?.tier || "No signal yet")}</span><span class="meta">${d.score ? `${esc(d.score.score)} of 100` : ""}</span></div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    </section><div class="sep"></div>
    <section class="sec">${codeBlock(d)}</section>
    <div class="sep"></div>
    <footer class="foot">${state.confirmDelete
      ? `<span>Delete this session and its code?</span><span><button data-action="delete-confirm" data-id="${esc(d.id)}">Delete</button>&nbsp;&nbsp;&nbsp;<button data-action="delete-cancel">Keep</button></span>`
      : `<button data-action="delete-ask">Delete session</button><span></span>`}</footer>`;
}

function screenPiece() {
  const d = state.detail;
  if (!d) return header({ back: true, title: "" }) + `<section class="sec"><div class="meta">${state.detailMissing ? "This piece is no longer here." : ""}</div></section>`;
  const f = d.full || {};
  const rows = [
    ["App", d.app],
    ["Started", when(d.startedAt)],
    ["Last written", when(d.lastAt)],
    ["Sittings", fmtNum(d.sessions)],
    ["Writing time", fmtDuration(d.activeMs)],
    ["Keystrokes", fmtNum(d.keystrokes)],
    ["Words, about", fmtNum(d.wordsEst)],
    ["Pauses to think", fmtNum(f.thinking_pauses)],
    ["Corrections", fmtNum(f.typo_corrections)],
  ];
  return header({ back: true, title: d.label })
    + `<section class="sec">
      <div class="line"><span class="big">${esc(d.score?.tier || "No signal yet")}</span><span class="meta">${d.score ? `${esc(d.score.score)} of 100` : ""}</span></div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    </section><div class="sep"></div>
    <section class="sec">${codeBlock(d, [], "piece")}</section>
    <div class="sep"></div>
    <footer class="foot">${state.confirmDelete
      ? `<span>Delete this piece and its record?</span><span><button data-action="delete-confirm" data-id="${esc(d.id)}" data-kind="piece">Delete</button>&nbsp;&nbsp;&nbsp;<button data-action="delete-cancel">Keep</button></span>`
      : `<button data-action="delete-ask">Delete piece</button><span></span>`}</footer>`;
}

function screenSignIn() {
  const c = state.signin;
  return header({ back: true, title: "Sign in" })
    + `<form class="sec" data-action="sign-in">
      <div class="meta">Use your inkk.site account.</div>
      <div class="fields">
        <input class="field" type="email" placeholder="Email" autocomplete="username" data-field="email" value="${esc(c.email)}" />
        <input class="field" type="password" placeholder="Password" autocomplete="current-password" data-field="password" value="${esc(c.password)}" />
      </div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ""}
      <div class="btns"><button class="b p wide" type="submit"${c.busy ? " disabled" : ""}>${c.busy ? "Signing in" : state.pending ? "Sign in and certify" : "Sign in"}</button></div>
    </form><div class="sep"></div>
    <footer class="foot"><button data-action="open" data-url="${SITE}/signin">Create an account</button><button data-action="open" data-url="${SITE}/signin?reset=1">Forgot password</button></footer>`;
}

function sw(key, on, label) {
  return `<button class="sw" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${esc(label)}" data-action="toggle" data-key="${key}"></button>`;
}

function screenSettings() {
  const s = state.app || {};
  const st = s.settings || {};
  const a = s.auth || {};
  const screenOk = s.permissions?.screen === "granted";
  const front = s.frontApp && s.frontApp.bundleId !== "site.inkk.companion" && s.frontApp.bundleId !== "com.github.Electron" ? s.frontApp : null;
  const ignored = s.ignoredApps || [];
  const faces = [["garamond", "Garamond"], ["fell", "Fell"], ["sans", "Sans"]];
  const account = !a.signedIn ? "Not signed in" : a.anonymous ? "Anonymous" : a.email || "Signed in";
  return header({ back: true, title: "Settings" })
    + `<section class="sec">
      <div class="set"><div>Open at login</div>${sw("launchAtLogin", s.launchAtLogin, "Open at login")}</div>
      <div class="set"><div>Check codes in what I read</div>${sw("receive", st.receive, "Check codes in what I read")}</div>
      <div class="set"><div>Notify me when one is found</div>${sw("notify", st.notify, "Notify me")}</div>
      <div class="set"><div>Add codes to saved documents</div>${sw("stampDocuments", st.stampDocuments, "Add codes to saved documents")}</div>
      <div class="set"><div><div>Read codes in pictures</div><div class="sub">${st.readPictures && !screenOk ? "Needs Screen Recording in System Settings" : "Signed names and screenshots"}</div></div>${st.readPictures && !screenOk ? `<button class="b" data-action="perm-settings" data-kind="screen">Open Settings</button>` : sw("readPictures", st.readPictures, "Read codes in pictures")}</div>
    </section><div class="sep"></div>
    <section class="sec">
      <div class="line"><span class="lab" style="margin:0">Signature</span><span class="meta">${s.shortcutOk ? esc(shortcutLabel(st.signShortcut)) : ""}</span></div>
      <div class="fields"><input class="field" type="text" placeholder="Your name" data-field="signatureName" value="${esc(st.signatureName || "")}" /></div>
      <div class="line" style="margin-top:8px"><span class="seg">${faces.map(([k, l]) => `<button data-action="face" data-face="${k}" aria-pressed="${st.signatureFace === k}">${l}</button>`).join("")}</span></div>
      <div class="sig">${state.sigPreview ? `<img src="${state.sigPreview.dataUrl}" width="${state.sigPreview.width}" height="${state.sigPreview.height}" alt="">` : ""}</div>
    </section><div class="sep"></div>
    <section class="sec">
      <div class="lab">Ignored apps</div>
      ${ignored.filter((id) => id !== "site.inkk.companion").map((id) => `<div class="set"><div>${esc(appName(id) || id)}</div><button class="t" data-action="unignore" data-id="${esc(id)}">Remove</button></div>`).join("")}
      ${front && !ignored.includes(front.bundleId) ? `<div class="btns"><button class="b" data-action="ignore-front">Ignore ${esc(front.name)}</button></div>` : ""}
    </section><div class="sep"></div>
    <section class="sec">
      <div class="set"><div><div>Account</div><div class="sub">${esc(account)}</div></div>${a.signedIn && !a.anonymous ? `<button class="t" data-action="sign-out">Sign out</button>` : `<button class="t" data-action="go" data-screen="signin">Sign in</button>`}</div>
      <div class="set"><button class="t" style="text-align:left" data-action="records">What inkk records</button><span></span></div>
      ${state.recordsOpen ? `<p class="prose">The timing of each key press and whether it was a letter, a space, a deletion or a paste, never which letter. Password fields never reach inkk. Sessions stay on this Mac. Certifying reads the text in front once, here, and sends only its fingerprints with the session's timing. Checking codes reads what is in front, here, and sends only a code it finds.</p>` : ""}
    </section><div class="sep"></div>
    <footer class="foot"><span>Version ${esc(s.version || "")}</span><button data-action="quit">Quit inkk</button></footer>`;
}

const KNOWN_APPS = {
  "site.inkk.companion": "inkk", "com.apple.Terminal": "Terminal", "com.googlecode.iterm2": "iTerm",
  "com.1password.1password": "1Password", "com.apple.keychainaccess": "Keychain Access", "com.apple.loginwindow": "Login window",
};
function appName(id) {
  if (KNOWN_APPS[id]) return KNOWN_APPS[id];
  const s = state.sessions.find((x) => x.bundleId === id);
  if (s) return s.app;
  if (state.app?.frontApp?.bundleId === id) return state.app.frontApp.name;
  return null;
}

/* ═══ Render ═════════════════════════════════════════════════════════════ */

const root = document.getElementById("root");
const SCREENS = { setup: screenSetup, home: screenHome, session: screenSession, piece: screenPiece, settings: screenSettings, signin: screenSignIn };

function render() {
  const active = document.activeElement;
  const keep = active && root.contains(active) && active.dataset.field
    ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd } : null;
  root.innerHTML = (SCREENS[state.screen] || screenHome)();
  if (keep) {
    const el = root.querySelector(`[data-field="${keep.field}"]`);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ } }
  }
  fit();
}

// The window is exactly as tall as what it shows.
let lastHeight = 0;
function fit() {
  const h = Math.ceil(root.scrollHeight);
  if (h !== lastHeight) { lastHeight = h; window.inkk.resize?.(h); }
}

async function go(screen, id = null) {
  state.screen = screen;
  state.confirmDelete = false;
  if (screen === "session" || screen === "piece") {
    state.sessionId = id; state.detail = null; state.detailMissing = false;
    render();
    const d = screen === "piece" ? await window.inkk.getPiece(id) : await window.inkk.getSession(id);
    if (state.screen !== screen || state.sessionId !== id) return;
    if (d) state.detail = d; else state.detailMissing = true;
  }
  if (screen === "settings") loadPreview();
  if (screen === "signin") { state.signin.error = null; }
  root.scrollTop = 0;
  render();
  if (screen === "signin") root.querySelector('[data-field="email"]')?.focus();
}

function home() { go(needsSetup(state.app) ? "setup" : "home"); }

async function loadPreview() {
  state.sigPreview = await window.inkk.previewSignature?.();
  if (state.screen === "settings") render();
}

/* ═══ Actions ════════════════════════════════════════════════════════════ */

let flashTimer = null;
function flash(id, text) {
  state.flash = { id, text };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { state.flash = null; render(); }, 2200);
}

async function certify(id, kind = "session") {
  if (!id || state.busy) return;
  state.busy = id; state.error = null; render();
  try {
    const r = kind === "piece" ? await window.inkk.certifyPiece(id) : await window.inkk.certify(id);
    if (r?.ok) {
      await window.inkk.copyText(sealLine(r.cert.code));
      flash(id, "Certified. The seal is copied.");
    } else if (r?.needsAuth) {
      state.pending = id;
      state.busy = null;
      return go("signin");
    } else {
      state.error = { id, text: r?.error || "Certifying didn't work. Try again." };
    }
  } finally {
    state.busy = null;
    if (state.screen === "session" && state.sessionId === id) state.detail = await window.inkk.getSession(id);
    if (state.screen === "piece" && state.sessionId === id) state.detail = await window.inkk.getPiece(id);
    render();
  }
}

async function signIn() {
  const c = state.signin;
  if (!c.email.trim() || !c.password) { c.error = "Enter your email and password."; return render(); }
  c.busy = true; c.error = null; render();
  const r = await window.inkk.signIn(c.email.trim(), c.password);
  c.busy = false;
  if (!r?.ok) { c.error = r?.error || "Signing in didn't work."; return render(); }
  c.password = "";
  const pending = state.pending;
  state.pending = null;
  state.app = await window.inkk.getState();
  if (pending) { await go(state.detail && state.detail.id === pending ? "session" : "home", pending); return certify(pending); }
  home();
}

let nameTimer = null;
const ACTIONS = {
  go: (el) => go(el.dataset.screen, el.dataset.id || null),
  back: () => { state.pending = null; home(); },
  open: (el) => window.inkk.openExternal(el.dataset.url),
  reveal: (el) => window.inkk.revealFile(el.dataset.path),
  certify: (el) => certify(el.dataset.id, el.dataset.kind),
  "copy-seal": async (el) => { await window.inkk.copyText(sealLine(el.dataset.code)); flash(el.dataset.id, "Seal copied"); render(); },
  sign: () => window.inkk.sign(),
  end: (el) => window.inkk.endSession(el.dataset.id),
  pause: () => window.inkk.setPaused(Date.now() + 60 * MIN),
  resume: () => window.inkk.setPaused(null),
  relaunch: () => window.inkk.relaunch(),
  start: async () => { await window.inkk.setOnboarded(true); state.app = await window.inkk.getState(); home(); },
  "perm-request": async (el) => {
    const kind = el.dataset.kind;
    await window.inkk.requestPermission(kind);
    state.asked[kind] = true;
    state.app = await window.inkk.getState();
    render();
  },
  "perm-settings": (el) => window.inkk.openPermissionSettings(el.dataset.kind),
  toggle: (el) => {
    const key = el.dataset.key;
    const on = el.getAttribute("aria-checked") !== "true";
    if (key === "launchAtLogin") return window.inkk.setLaunchAtLogin(on);
    return window.inkk.setSetting(key, on);
  },
  face: async (el) => { await window.inkk.setSetting("signatureFace", el.dataset.face); loadPreview(); },
  "ignore-front": () => {
    const f = state.app?.frontApp; if (!f) return;
    const list = state.app.ignoredApps || [];
    if (!list.includes(f.bundleId)) window.inkk.setIgnoredApps([...list, f.bundleId]);
  },
  unignore: (el) => window.inkk.setIgnoredApps((state.app?.ignoredApps || []).filter((x) => x !== el.dataset.id)),
  records: () => { state.recordsOpen = !state.recordsOpen; render(); },
  "sign-out": () => window.inkk.signOut(),
  quit: () => window.inkk.quit(),
  "delete-ask": () => { state.confirmDelete = true; render(); },
  "delete-cancel": () => { state.confirmDelete = false; render(); },
  "delete-confirm": async (el) => {
    if (el.dataset.kind === "piece") await window.inkk.deletePiece(el.dataset.id);
    else await window.inkk.deleteSession(el.dataset.id);
    home();
  },
};

root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "FORM" || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});

root.addEventListener("submit", (e) => {
  if (e.target.closest("form[data-action='sign-in']")) { e.preventDefault(); signIn(); }
});

root.addEventListener("input", (e) => {
  const f = e.target.dataset?.field;
  if (!f) return;
  if (f === "email" || f === "password") { state.signin[f] = e.target.value; return; }
  if (f === "signatureName") {
    clearTimeout(nameTimer);
    const v = e.target.value;
    nameTimer = setTimeout(async () => { await window.inkk.setSetting("signatureName", v); loadPreview(); }, 400);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.screen === "home" || state.screen === "setup") window.inkk.hide();
  else { state.pending = null; home(); }
});

/* ═══ Boot ═══════════════════════════════════════════════════════════════ */

// Before the account moved into the app itself, the popover kept its own
// session in this page's storage. Hand it over once, so nobody signs in twice.
async function handOverOldSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k || "")) continue;
      const v = JSON.parse(localStorage.getItem(k) || "null");
      const s = v && (v.currentSession || v);
      if (s && s.access_token && s.refresh_token) await window.inkk.importSession({ access_token: s.access_token, refresh_token: s.refresh_token });
      localStorage.removeItem(k);
      return;
    }
  } catch { /* nothing to hand over */ }
}

(async function boot() {
  if (!window.inkk) { root.innerHTML = `<section class="sec">This page needs the inkk app.</section>`; return; }
  const [s, list, ps] = await Promise.all([window.inkk.getState(), window.inkk.getSessions(), window.inkk.getPieces?.() ?? []]);
  state.pieces = ps || [];
  state.app = s;
  state.sessions = list || [];
  handOverOldSession();

  window.inkk.onState((next) => {
    const wasSetup = needsSetup(state.app);
    state.app = next;
    if (state.screen === "setup" && !needsSetup(next)) return home();
    if (state.screen === "home" && needsSetup(next) && !wasSetup) return go("setup");
    if (state.screen === "signin" || (state.screen === "settings" && root.contains(document.activeElement) && document.activeElement.dataset.field)) return;
    render();
  });
  window.inkk.onPieces?.((l) => { state.pieces = l || []; });
  window.inkk.onSessions(async (l) => {
    state.sessions = l || [];
    if (state.screen === "session" && state.sessionId) {
      const d = await window.inkk.getSession(state.sessionId);
      if (state.screen === "session" && d) state.detail = d;
    }
    if (state.screen === "piece" && state.sessionId) {
      const d = await window.inkk.getPiece(state.sessionId);
      if (state.screen === "piece" && d) state.detail = d;
    }
    if (state.screen !== "signin" && state.screen !== "settings") render();
  });
  window.inkk.onShown(async () => {
    const [ns, nl, np] = await Promise.all([window.inkk.getState(), window.inkk.getSessions(), window.inkk.getPieces?.() ?? []]);
    state.app = ns; state.sessions = nl || []; state.pieces = np || [];
    if (state.screen === "session" || state.screen === "piece" || state.screen === "settings" || state.screen === "signin") render();
    else home();
  });
  setInterval(() => { if (state.screen === "setup") window.inkk.getState().then((n) => { state.app = n; if (!needsSetup(n)) home(); else render(); }); }, 1500);
  home();
})();
