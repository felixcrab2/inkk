// inkk companion — renderer.
//
// One small state object, one render() that rebuilds the popover from template
// literals, and event delegation on the root. Everything the page knows about
// the outside world comes through window.inkk (see preload.js and the
// contract in the spec): main owns the keyboard hook, the session log and the
// certify POST; this side owns the screens and the Supabase sign-in that a
// certificate needs.
//
// The code and content-hash helpers are the SAME modules the website uses
// (src/verify/code.js), so a code minted here verifies exactly like one minted
// in the editor.

import { createClient } from "@supabase/supabase-js";
import { makeVerifyCode, hashContent, normalizePlainText, isVerifiedTier } from "../../src/verify/code.js";
import { TOS_VERSION } from "../../src/components/Legal.js";

// Injected by esbuild --define at build time (companion/build.js).
const SUPA_URL = __SUPA_URL__;
const SUPA_KEY = __SUPA_KEY__;
const API_BASE = __API_BASE__;

const SITE = "https://inkk.site";

/* ═══ State ══════════════════════════════════════════════════════════════ */

const state = {
  screen: "home",          // welcome | home | session | certify | result | settings
  prev: null,              // { screen, id } to return to from a sub-screen
  app: null,               // State pushed by main
  sessions: [],            // SessionSummary[], newest first
  sessionId: null,         // session the detail / certify / result screens are about
  detail: null,            // SessionDetail for the session screen (null while loading)
  detailMissing: false,
  confirmDelete: false,
  certify: {               // the certify form, kept here so re-renders never lose typing
    text: "", title: "", busy: false, error: null, code: null,
    needsAuth: false, authEnter: false, email: "", password: "", authBusy: false, authError: null,
  },
  result: null,            // Cert shown on the result screen
  user: null,              // Supabase user, if any
  recordsOpen: false,      // "What inkk records" disclosure in Settings
  copied: null,            // which copy button just fired ("code" | "seal" | "panel")
  permTried: {},           // grants we have already asked macOS for this launch
};

const supa = (SUPA_URL && SUPA_KEY) ? createClient(SUPA_URL, SUPA_KEY) : null;

/* ═══ Helpers ════════════════════════════════════════════════════════════ */

// Everything that goes into a template literal from outside (app names,
// session titles, error messages, emails) passes through here.
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const TIERS = ["Faint", "Developing", "Strong", "Distinct"];
const tierIndex = (t) => Math.max(0, TIERS.indexOf(t));
const fmtNum = (n) => Number(n || 0).toLocaleString("en-GB");
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

const MIN = 60000;
function fmtDuration(ms) {
  const m = Math.round((ms || 0) / MIN);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
function fmtRelative(ts) {
  const d = Date.now() - ts;
  if (d < MIN) return "just now";
  if (d < 60 * MIN) return `${Math.round(d / MIN)} min ago`;
  if (d < 6 * 60 * MIN) return `${Math.round(d / (60 * MIN))} h ago`;
  if (ts >= startOfDay(Date.now()) - 24 * 60 * MIN) return fmtClock(ts);   // today / yesterday: the clock is enough
  return `${fmtDate(ts)} · ${fmtClock(ts)}`;
}
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayGroup(ts) {
  const today = startOfDay(Date.now());
  if (ts >= today) return "Today";
  if (ts >= today - 24 * 60 * MIN) return "Yesterday";
  return "Earlier";
}
const permsGranted = (s) =>
  !!s && s.permissions?.accessibility === "granted" && s.permissions?.inputMonitoring === "granted";
const isPaused = (s) => !!(s?.paused && s.paused > Date.now());
const needsWelcome = (s) => !s || !s.onboarded || !permsGranted(s);

/* ═══ Icons (inline SVG, 1.5px stroke, currentColor) ═════════════════════ */

const svg = (d, extra = "") =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICON = {
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  back: svg(`<path d="M15 5l-7 7 7 7"/>`),
  tick: svg(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`),
  copy: svg(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>`),
  external: svg(`<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>`),
  close: svg(`<path d="M6 6l12 12M18 6L6 18"/>`),
  chevron: svg(`<path d="M6 9l6 6 6-6"/>`),
};

/* ═══ Supabase: sign-in, profile row, token ══════════════════════════════ */

// The companion needs no account to record. A certificate does (it lives in
// inkk's ledger), so the first attempt is a silent anonymous sign-in; only if
// the project has that disabled does the inline email form appear.
async function ensureProfile(user) {
  if (!supa || !user) return;
  const row = {
    id: user.id,
    username: "writer_" + String(user.id).replace(/-/g, "").slice(0, 6),
    display_name: null,
    research_opt_in: true,
    tos_accepted_at: new Date().toISOString(),
    tos_version: TOS_VERSION,
  };
  const { error } = await supa.from("profiles").upsert(row, { onConflict: "id", ignoreDuplicates: true });
  if (error) console.warn("profiles upsert:", error.message);
}

async function restoreUser() {
  if (!supa) return null;
  try {
    const { data } = await supa.auth.getSession();
    state.user = data?.session?.user || null;
  } catch { state.user = null; }
  return state.user;
}

// Returns an access token, signing in anonymously if there is no session.
// Returns null when that is not possible (no client, anonymous disabled).
// Returns { token } or { token: null, reason: "disabled" | "offline" | "error", message }.
// Only "disabled" (the project doesn't allow anonymous sign-ins) means an
// account is needed; anything else is a connection problem to retry.
async function getAccessToken() {
  if (!supa) return { token: null, reason: "disabled" };
  try {
    const { data } = await supa.auth.getSession();
    if (data?.session?.access_token) { state.user = data.session.user; return { token: data.session.access_token }; }
    const r = await supa.auth.signInAnonymously();
    if (r.error || !r.data?.session) {
      const msg = String(r.error?.message || "");
      const disabled = /anonymous/i.test(msg) && /disabled|not enabled|not allowed/i.test(msg);
      return { token: null, reason: disabled ? "disabled" : "error", message: msg };
    }
    state.user = r.data.session.user;
    await ensureProfile(state.user);
    return { token: r.data.session.access_token };
  } catch (e) {
    return { token: null, reason: "offline", message: e?.message || "" };
  }
}

async function getAuthorName() {
  if (!supa || !state.user || state.user.is_anonymous) return null;
  try {
    const { data } = await supa.from("profiles").select("display_name").eq("id", state.user.id).maybeSingle();
    return data?.display_name || null;
  } catch { return null; }
}

async function signInWithPassword(email, password) {
  if (!supa) throw new Error("This build has no account service configured.");
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  state.user = data.session?.user || null;
  await ensureProfile(state.user);
}

async function signOut() {
  if (!supa) return;
  try { await supa.auth.signOut(); } catch {}
  state.user = null;
}

/* ═══ Screens ════════════════════════════════════════════════════════════ */

function dots(tier) {
  const on = tierIndex(tier) + 1;
  return `<span class="dots" aria-hidden="true">${TIERS.map((_, i) => `<span class="dot${i < on ? " on" : ""}"></span>`).join("")}</span>`;
}
function scoreBlock(score) {
  if (!score) return `<div class="score"><span class="score-num faint">–</span><span class="score-tier faint">No signal yet</span></div>`;
  return `<div class="score" aria-label="Human signal ${esc(score.score)} out of 100, ${esc(score.tier)}">
    <span class="score-num">${esc(score.score)}</span><span class="score-denom">/100</span>
    <span class="score-tier">${esc(score.tier)}</span>${dots(score.tier)}
  </div>`;
}

function statusPill(s) {
  let cls = "", text = "Listening";
  if (!s) { text = "Starting"; }
  else if (!permsGranted(s)) { cls = "is-blocked"; text = "Needs permission"; }
  else if (s.needsRelaunch || !s.hookActive) { cls = "is-blocked"; text = s.needsRelaunch ? "Relaunch needed" : "Not recording"; }
  else if (isPaused(s)) { cls = "is-paused"; text = "Paused"; }
  else if (s.active) { cls = "is-live"; text = `Writing in ${s.active.app}`; }
  return `<span id="status-pill" class="status-pill ${cls}"><span class="status-dot"></span><span class="status-pill-label">${esc(text)}</span></span>`;
}

function topbar() {
  const sub = state.screen !== "home" && state.screen !== "welcome";
  const left = sub
    ? `<button class="icon-btn" data-action="back" aria-label="Back">${ICON.back}</button>`
    : `<span class="wordmark">inkk.</span>`;
  const gear = state.screen === "settings" ? "" :
    `<button class="icon-btn" data-action="go" data-screen="settings" aria-label="Settings">${ICON.gear}</button>`;
  return `<div class="topbar"><div class="topbar-left">${left}</div><div class="topbar-right">${statusPill(state.app)}${gear}</div></div>`;
}

/* ── 1. Welcome / permissions ──────────────────────────────────────────── */

// macOS reports Input Monitoring as "denied" for an app it has simply never
// asked about, so "denied" alone can't mean the prompt is spent. First offer
// "Turn on" (which triggers the prompt when it is still available); once we
// have asked and the grant still isn't there, the switch lives in System
// Settings and that is the only useful button.
function permRow(kind, name, why, status) {
  let right;
  const tried = !!state.permTried[kind];
  if (status === "granted") right = `<span class="perm-state">${ICON.tick}On</span>`;
  else if (status === "restricted" || (tried && status === "denied"))
    right = `<button class="btn btn-secondary btn-sm" data-action="perm-settings" data-kind="${kind}">Open Settings</button>`;
  else right = `<button class="btn btn-primary btn-sm" data-action="perm-request" data-kind="${kind}">Turn on</button>`;
  const hint = (tried && status !== "granted")
    ? `<div class="perm-hint">If macOS didn't ask, turn it on in System Settings and come back.</div>` : "";
  return `<div class="perm-row"><div class="perm-text"><div class="perm-name">${name}</div><div class="perm-why">${why}</div>${hint}</div>${right}</div>`;
}

function screenWelcome() {
  const s = state.app;
  const p = s?.permissions || {};
  const both = permsGranted(s);
  const cta = !both ? "" : s.needsRelaunch
    ? `<button class="btn btn-primary btn-block" data-action="relaunch">Relaunch inkk</button>`
    : `<button class="btn btn-primary btn-block" data-action="start">Start</button>`;
  return `<div class="view">
    <h1 class="h1">Proof you wrote it, from anywhere.</h1>
    <p class="lead">inkk records the rhythm of your typing — never the letters — so any piece you write on this Mac can carry a human-verified code. It runs quietly in the menu bar.</p>
    <div class="panel perm-list">
      ${permRow("accessibility", "Accessibility", "Lets the timing hook run alongside other apps.", p.accessibility)}
      ${permRow("inputMonitoring", "Input Monitoring", "To time key presses in any app. Letters are never read.", p.inputMonitoring)}
    </div>
    ${cta ? `<div class="welcome-actions">${cta}</div>` : ""}
    <p class="note welcome-foot">No account needed. By continuing you agree to the <button class="link-btn" data-action="open" data-url="${SITE}/terms">Terms</button> and <button class="link-btn" data-action="open" data-url="${SITE}/privacy">Privacy Policy</button>.</p>
  </div>`;
}

/* ── 2. Home ───────────────────────────────────────────────────────────── */

// What the scorer is noticing, in plain words (keys from score.js).
const NOTICE = {
  variance: "Varied pace", dwell: "Natural key rhythm", pauses: "Pauses to think", corrections: "Fixes as it goes",
  revisions: "Goes back to revise", bursts: "Writes in bursts", rhythm: "Natural rhythm", velocity: "Speed ebbs and flows",
  engagement: "Stays engaged",
};
function liveSheet(a) {
  const sc = a.score;
  const notice = sc?.contributors?.length
    ? sc.contributors.slice(0, 2).map((c) => NOTICE[c.key] || c.label).join(" · ")
    : "Keep writing — the signal builds with a little more typing.";
  return `<div class="panel">
    <div class="live-head"><span class="h2">${esc(a.app)}</span><span class="live-tag">· live</span></div>
    ${scoreBlock(sc)}
    <p class="meta live-stats">${fmtNum(a.keystrokes)} keystrokes · ${fmtDuration(a.activeMs)} · ~${fmtNum(a.wordsEst)} words</p>
    <p class="meta live-notice">${esc(notice)}</p>
    <div class="actions">
      <button class="btn btn-primary" data-action="go" data-screen="certify" data-id="${esc(a.id)}">Certify this piece</button>
      <button class="btn-text" data-action="end-session" data-id="${esc(a.id)}">End session</button>
    </div>
  </div>`;
}

function idleSheet(s) {
  if (isPaused(s)) {
    return `<div class="panel">
      <div class="idle-title">Paused until ${fmtClock(s.paused)}.</div>
      <p class="lead">Nothing is being recorded. Resume when you're ready to write.</p>
      <div class="actions"><button class="btn btn-secondary" data-action="resume">Resume</button></div>
    </div>`;
  }
  if (s && permsGranted(s) && (s.needsRelaunch || !s.hookActive)) {
    return `<div class="panel">
      <div class="idle-title">Not recording yet.</div>
      <p class="lead">${esc(s.error || "The keyboard hook didn't start.")} Relaunching usually fixes it.</p>
      <div class="actions"><button class="btn btn-primary" data-action="relaunch">Relaunch inkk</button></div>
    </div>`;
  }
  return `<div class="panel">
    <div class="idle-title">Start typing anywhere.</div>
    <p class="lead">inkk will notice and start a session. Only the rhythm is recorded.</p>
  </div>`;
}

function sessionRow(x) {
  const meta = `${fmtRelative(x.lastKeyAt)} · ${fmtDuration(x.activeMs)} · ${fmtNum(x.keystrokes)} keys`;
  const cert = x.cert ? `<span class="chip">${ICON.tick}certified</span>` : "";
  const tier = x.score?.tier || "";
  return `<button class="row" data-action="go" data-screen="session" data-id="${esc(x.id)}">
    <span class="row-main"><span class="row-title"><span>${esc(x.app)}</span>${cert}</span><span class="row-meta">${esc(meta)}</span></span>
    <span class="row-side">${dots(tier)}<span class="row-tier">${esc(tier)}</span></span>
  </button>`;
}

function recentList() {
  const activeId = state.app?.active?.id;
  const past = state.sessions.filter((x) => x.id !== activeId);
  if (!past.length) return `<div class="empty">Nothing yet.</div>`;
  const groups = [];
  for (const x of past) {
    const g = dayGroup(x.lastKeyAt);
    const last = groups[groups.length - 1];
    if (last && last.name === g) last.items.push(x); else groups.push({ name: g, items: [x] });
  }
  return `<div class="recent">${groups.map((g) =>
    `<div class="recent-group"><div class="label">${g.name}</div>${g.items.map(sessionRow).join("")}</div>`).join("")}</div>`;
}

function screenHome() {
  const s = state.app;
  return `<div class="view">
    ${s?.active ? liveSheet(s.active) : idleSheet(s)}
    <div class="section"><div class="label">Recent</div>${recentList()}</div>
  </div>`;
}

/* ── 3. Session detail ─────────────────────────────────────────────────── */

function certPanel(cert, id) {
  const verified = cert.verified || isVerifiedTier(cert.tier);
  const copied = state.copied === "panel";
  return `<div class="tonal cert-panel">
    <div class="cert-panel-label${verified ? " is-verified" : ""}">${ICON.tick}${verified ? "Human-verified" : "Recorded"} · ${esc(cert.tier)} ${esc(cert.score)}/100</div>
    <div class="code-line">${esc(cert.code)}</div>
    <div class="cert-actions">
      <button class="btn-text" data-action="copy" data-what="panel" data-text="${esc(cert.code)}">${ICON.copy}${copied ? "Copied" : "Copy"}</button>
      <button class="btn-text" data-action="open" data-url="${SITE}/v/${esc(cert.code)}">${ICON.external}Open verification</button>
    </div>
  </div>`;
}

function screenSession() {
  const d = state.detail;
  if (state.detailMissing) return `<div class="view"><p class="lead">That session is gone.</p></div>`;
  if (!d) return `<div class="view"><p class="meta">Loading…</p></div>`;
  const f = d.full || {};
  const live = state.app?.active?.id === d.id;
  const when = `${fmtDate(d.startedAt)} · ${fmtClock(d.startedAt)}${d.endedAt ? `–${fmtClock(d.endedAt)}` : ""}`;
  const contribs = (d.score?.contributors || []).slice(0, 4);
  const stats = [
    ["Writing time", fmtDuration(d.activeMs)],
    ["Keystrokes", fmtNum(d.keystrokes)],
    ["Pauses to think", fmtNum(f.thinking_pauses)],
    ["Corrections", fmtNum(f.typo_corrections)],
  ];
  return `<div class="view">
    <div class="detail-head">
      <div class="h2">${esc(d.app)}${live ? ` <span class="live-tag">· live</span>` : ""}</div>
      <p class="meta">${esc(when)}</p>
    </div>
    ${scoreBlock(d.score)}
    <div class="stat-grid">${stats.map(([l, v]) =>
      `<div class="stat-chip"><div class="stat-val">${esc(v)}</div><div class="stat-label">${l}</div></div>`).join("")}</div>
    ${contribs.length ? `<div class="section"><div class="label">Signals</div><div class="signals">${contribs.map((c) =>
      `<div class="signal"><span class="signal-label">${esc(c.label)}</span><span class="signal-val">${Math.round(clamp01(c.value) * 100)}</span>
       <div class="bar"><div class="bar-fill" style="width:${Math.round(clamp01(c.value) * 100)}%"></div></div></div>`).join("")}</div></div>` : ""}
    ${d.cert ? certPanel(d.cert, d.id)
      : `<div class="actions-col"><button class="btn btn-primary btn-block" data-action="go" data-screen="certify" data-id="${esc(d.id)}">Certify this piece</button></div>`}
    <div class="foot-actions">${state.confirmDelete
      ? `<div class="confirm"><span>Delete this session?</span><button class="btn-text is-danger" data-action="delete-confirm" data-id="${esc(d.id)}">Delete</button><button class="btn-text" data-action="delete-cancel">Keep</button></div>`
      : `<button class="btn-text is-danger" data-action="delete-ask">Delete session</button>`}</div>
  </div>`;
}

/* ── 4. Certify ────────────────────────────────────────────────────────── */

function authStep() {
  const c = state.certify;
  const enter = c.authEnter ? " is-entering" : "";
  c.authEnter = false;
  return `<form class="auth-step panel-in${enter}" data-action="sign-in">
    <p class="note">Certificates live in inkk's ledger, so this step needs an account.</p>
    <div class="field-stack">
      <input class="field" type="email" name="email" placeholder="Email" autocomplete="username" data-field="email" value="${esc(c.email)}" />
      <input class="field" type="password" name="password" placeholder="Password" autocomplete="current-password" data-field="password" value="${esc(c.password)}" />
    </div>
    ${c.authError ? `<p class="err">${esc(c.authError)}</p>` : ""}
    <div class="actions-col" style="margin-top:12px">
      <button class="btn btn-primary btn-block" type="submit"${c.authBusy ? " disabled" : ""}>${c.authBusy ? "Signing in…" : "Sign in"}</button>
    </div>
    <p class="note auth-foot"><button class="link-btn" type="button" data-action="open" data-url="${SITE}">Create an account at inkk.site</button></p>
  </form>`;
}

// The session a certify screen is about: the one it was opened for, else the live one.
function certifySession() {
  return state.sessions.find((x) => x.id === state.sessionId) || state.app?.active || null;
}

function screenCertify() {
  const c = state.certify;
  const sess = certifySession();
  return `<div class="view">
    <div class="h2">Certify${sess ? ` · ${esc(sess.app)}` : ""}</div>
    <p class="lead" style="margin-top:6px">Paste the finished text. It's fingerprinted on this Mac and only the fingerprint travels — inkk never stores your words.</p>
    <div class="certify-form field-stack">
      <textarea class="field" rows="7" placeholder="The finished piece" data-field="text" aria-label="Finished text">${esc(c.text)}</textarea>
      <input class="field" type="text" placeholder="Title (optional)" data-field="title" aria-label="Title" value="${esc(c.title)}" />
    </div>
    ${c.error ? `<p class="err">${esc(c.error)}</p>` : ""}
    ${c.needsAuth ? authStep() : `<div class="actions-col">
      <button class="btn btn-primary btn-block" data-action="certify"${c.busy || !c.text.trim() ? " disabled" : ""}>${c.busy ? "Fingerprinting…" : "Get my code"}</button>
    </div>`}
  </div>`;
}

/* ── 4b. Result ────────────────────────────────────────────────────────── */

function screenResult() {
  const cert = state.result;
  if (!cert) return `<div class="view"><p class="lead">No certificate to show.</p></div>`;
  const verified = cert.verified || isVerifiedTier(cert.tier);
  const seal = `inkk. ${cert.code} · inkk.site/v/${cert.code}`;
  return `<div class="view result panel-in">
    <div class="label">Your code</div>
    <div class="code">${esc(cert.code)}</div>
    <div class="result-state">
      ${verified ? `<span class="rubric">${ICON.tick}Human-verified</span>` : `<span>Recorded</span>`}
      <span class="meta">·</span>
      <span>${esc(cert.tier)} ${esc(cert.score)}<span class="meta">/100</span></span>
    </div>
    ${cert.title ? `<p class="meta" style="margin-top:6px">${esc(cert.title)} · ${fmtNum(cert.wordCount)} words</p>` : ""}
    <div class="result-buttons">
      <button class="btn btn-primary btn-block" data-action="copy" data-what="code" data-text="${esc(cert.code)}">${state.copied === "code" ? "Copied" : "Copy code"}</button>
      <button class="btn btn-secondary btn-block" data-action="copy" data-what="seal" data-text="${esc(seal)}">${state.copied === "seal" ? "Copied" : "Copy seal"}</button>
      <button class="btn-text" data-action="open" data-url="${SITE}/v/${esc(cert.code)}">${ICON.external}Open verification</button>
    </div>
    <p class="note" style="margin-top:18px;text-align:center">Paste it wherever the piece goes.</p>
  </div>`;
}

/* ── 5. Settings ───────────────────────────────────────────────────────── */

const KNOWN_APPS = {
  "site.inkk.companion": "inkk",
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "com.1password.1password": "1Password",
  "com.apple.keychainaccess": "Keychain Access",
  "com.apple.loginwindow": "Login window",
};
function appName(bundleId) {
  if (KNOWN_APPS[bundleId]) return KNOWN_APPS[bundleId];
  const s = state.sessions.find((x) => x.bundleId === bundleId);
  if (s) return s.app;
  if (state.app?.frontApp?.bundleId === bundleId) return state.app.frontApp.name;
  return null;
}

function screenSettings() {
  const s = state.app || {};
  const paused = isPaused(s);
  const SELF = new Set(["site.inkk.companion", "com.github.Electron"]);
  const front = s.frontApp && !SELF.has(s.frontApp.bundleId) ? s.frontApp : null;
  const ignored = s.ignoredApps || [];
  const canIgnore = !!front && !ignored.includes(front.bundleId);
  const u = state.user;
  const account = !u ? "Not signed in" : u.is_anonymous ? "Anonymous account" : (u.email || "Signed in");
  return `<div class="view">
    <div class="h2">Settings</div>
    <div class="section">
      <div class="setting">
        <div class="setting-text"><div class="setting-name">Launch at login</div></div>
        <button class="switch" role="switch" aria-checked="${s.launchAtLogin ? "true" : "false"}" aria-label="Launch at login" data-action="toggle-login"></button>
      </div>
      <div class="setting">
        <div class="setting-text"><div class="setting-name">${paused ? `Paused until ${fmtClock(s.paused)}` : "Pause recording"}</div>
          <div class="setting-sub">${paused ? "Nothing is recorded until then." : "Take an hour off. Sessions resume on their own."}</div></div>
        ${paused
          ? `<button class="btn btn-secondary btn-sm" data-action="resume">Resume</button>`
          : `<button class="btn btn-secondary btn-sm" data-action="pause">Pause for an hour</button>`}
      </div>
    </div>
    <div class="section">
      <div class="label">Ignored apps</div>
      <div class="ignored">${ignored.map((id) => {
        const name = appName(id);
        return `<div class="ignored-row"><div class="ignored-name">${name ? esc(name) : `<span class="ignored-id">${esc(id)}</span>`}${name ? ` <span class="ignored-id">${esc(id)}</span>` : ""}</div>
          <button class="icon-btn" data-action="unignore" data-id="${esc(id)}" aria-label="Stop ignoring ${esc(name || id)}">${ICON.close}</button></div>`;
      }).join("") || `<div class="empty">None.</div>`}</div>
      ${front ? `<div class="actions" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" data-action="ignore-front"${canIgnore ? "" : " disabled"}>${canIgnore ? `Ignore ${esc(front.name)}` : `${esc(front.name)} is ignored`}</button>
      </div>` : `<div class="note" style="margin-top:8px">Open this while another app is in front to add it here.</div>`}
    </div>
    <div class="section">
      <button class="disclosure" data-action="toggle-records" aria-expanded="${state.recordsOpen ? "true" : "false"}"><span>What inkk records</span>${ICON.chevron}</button>
      ${state.recordsOpen ? `<div class="disclosure-body note">inkk records the timing of key presses — when a key goes down and comes up, and whether it was a letter, a space, a deletion or a paste — never which letter. Password fields use macOS secure input and never reach inkk. Sessions stay on this Mac. When you certify a piece, only that session's timing profile and a fingerprint of the text leave it.</div>` : ""}
    </div>
    <div class="section">
      <div class="label">Account</div>
      <div class="setting" style="padding-top:0">
        <div class="setting-text"><div class="setting-name">${esc(account)}</div>
          ${!u ? `<div class="setting-sub">Certifying signs you in when it needs to.</div>`
            : u.is_anonymous ? `<div class="setting-sub">Its certificates are tied to this Mac.</div>` : ""}</div>
        ${u && !u.is_anonymous ? `<button class="btn-text" data-action="sign-out">Sign out</button>` : ""}
      </div>
    </div>
    ${s.needsRelaunch || (permsGranted(s) && !s.hookActive) ? `<div class="section">
      <div class="label">Trouble</div>
      <div class="setting" style="padding-top:0">
        <div class="setting-text"><div class="setting-sub">${esc(s.error || "The keyboard hook isn't running.")}</div></div>
        <button class="btn btn-secondary btn-sm" data-action="relaunch">Relaunch inkk</button>
      </div>
    </div>` : ""}
    <div class="settings-foot">
      <span class="meta">inkk companion ${esc(s.version || "")}</span>
      <button class="btn-text is-danger" data-action="quit">Quit inkk</button>
    </div>
  </div>`;
}

/* ═══ Render ═════════════════════════════════════════════════════════════ */

const root = document.getElementById("root");
const SCREENS = {
  welcome: screenWelcome, home: screenHome, session: screenSession,
  certify: screenCertify, result: screenResult, settings: screenSettings,
};

// Full rebuild. Field values live in state so they survive; focus and caret
// are put back by hand so typing across a re-render feels seamless. The
// entrance animation is only attached when the screen itself changed — main
// pushes State up to four times a second while someone types, and a live
// sheet that rose and faded on every push would never sit still.
let renderedScreen = null;
function render() {
  const active = document.activeElement;
  const keep = !active || !root.contains(active) ? null
    : active.dataset.field ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
    : active.dataset.action ? { action: active.dataset.action, id: active.dataset.id, screen: active.dataset.screen, kind: active.dataset.kind, what: active.dataset.what, url: active.dataset.url }
    : null;
  const scrollY = root.scrollTop;
  const entering = state.screen !== renderedScreen;
  renderedScreen = state.screen;
  root.innerHTML = topbar() + (SCREENS[state.screen] || screenHome)();
  if (entering) root.querySelectorAll(".view, .panel-in").forEach((el) => el.classList.add("is-entering"));
  root.scrollTop = scrollY;
  if (keep?.field) {
    const el = root.querySelector(`[data-field="${keep.field}"]`);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.start, keep.end); } catch {} }
  } else if (keep?.action) {
    // A keyboard user on a row or button keeps their place across state pushes.
    const q = (k, v) => (v ? `[data-${k}="${CSS.escape(v)}"]` : "");
    const sel = q("action", keep.action) + q("id", keep.id) + q("screen", keep.screen) + q("kind", keep.kind) + q("what", keep.what) + q("url", keep.url);
    const el = root.querySelector(sel);
    if (el) el.focus({ preventScroll: true });
  }
}

// The cheap path for state pushes while someone is typing: only the pill.
function renderPill() {
  const el = document.getElementById("status-pill");
  if (el) el.outerHTML = statusPill(state.app);
}

/* ═══ Navigation ═════════════════════════════════════════════════════════ */

let settingHash = false;
function setHash(h) {
  settingHash = true;
  if (location.hash !== h) location.hash = h; else settingHash = false;
}

async function go(screen, id = null, opts = {}) {
  const cur = { screen: state.screen, id: state.sessionId };
  if (screen !== state.screen || id !== state.sessionId) state.prev = opts.prev === undefined ? cur : opts.prev;
  state.screen = screen;
  state.copied = null;
  state.confirmDelete = false;
  if (screen === "session") { state.sessionId = id; state.detail = null; state.detailMissing = false; }
  if (screen === "certify") {
    if (id !== state.certify.forId) resetCertify();
    state.certify.forId = id;
    state.sessionId = id;
  }
  const hash = "#" + screen + (id && (screen === "session" || screen === "certify") ? "/" + id : "");
  setHash(hash);
  root.scrollTop = 0;
  render();
  if (screen === "welcome") startWelcomePoll(); else stopWelcomePoll();
  if (screen === "session" && id) {
    const d = await window.inkk.getSession(id);
    if (state.screen !== "session" || state.sessionId !== id) return;
    if (d) state.detail = d; else state.detailMissing = true;
    render();
  }
}

function goBack() {
  const p = state.prev;
  state.prev = null;
  if (!p || p.screen === state.screen || p.screen === "welcome") return go(needsWelcome(state.app) ? "welcome" : "home", null, { prev: null });
  go(p.screen, p.id, { prev: null });
}

function resetCertify() {
  state.certify = { forId: null, text: "", title: "", busy: false, error: null, code: null,
    needsAuth: false, authEnter: false, email: "", password: "", authBusy: false, authError: null };
}

// #welcome, #home, #session/<id>, #certify/<id>, #result[/<id>], #settings
async function routeFromHash() {
  const m = /^#([a-z]+)(?:\/(.+))?$/.exec(location.hash || "");
  if (!m) return go(needsWelcome(state.app) ? "welcome" : "home", null, { prev: null });
  const [, screen, id] = m;
  if (needsWelcome(state.app)) return go("welcome", null, { prev: null });   // no hash skips onboarding
  if (screen === "result") {
    if (id) {
      const s = state.sessions.find((x) => x.id === id) || await window.inkk.getSession(id);
      if (s?.cert) { state.result = s.cert; state.sessionId = id; }
    }
    return go(state.result ? "result" : "home", null, { prev: { screen: "home", id: null } });
  }
  if (screen === "certify") return go("certify", id || state.app?.active?.id || null, { prev: { screen: "home", id: null } });
  if (screen === "session") return go("session", id || null, { prev: { screen: "home", id: null } });
  if (SCREENS[screen]) return go(screen, null, { prev: { screen: "home", id: null } });
  go("home", null, { prev: null });
}

let welcomeTimer = null;
function startWelcomePoll() {
  if (welcomeTimer) return;
  welcomeTimer = setInterval(async () => {
    if (state.screen !== "welcome") return stopWelcomePoll();
    const s = await window.inkk.getState();
    const changed = JSON.stringify(s?.permissions) !== JSON.stringify(state.app?.permissions)
      || s?.needsRelaunch !== state.app?.needsRelaunch;
    state.app = s;
    if (changed) render(); else renderPill();
  }, 1500);
}
function stopWelcomePoll() { if (welcomeTimer) { clearInterval(welcomeTimer); welcomeTimer = null; } }

/* ═══ Actions ════════════════════════════════════════════════════════════ */

async function runCertify() {
  const c = state.certify;
  const text = c.text.trim();
  if (!text) { c.error = "Paste the finished text first."; render(); return; }
  const sessionId = certifySession()?.id || null;
  if (!sessionId) { c.error = "There is no session to certify."; render(); return; }
  c.busy = true; c.error = null; render();
  try {
    const normalized = normalizePlainText(text);
    const wordCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;
    const contentHash = await hashContent(text);
    if (!contentHash) throw new Error("Couldn't fingerprint the text on this Mac.");
    // Keep one code across an auth retry so the ledger never sees two.
    const code = c.code || (c.code = makeVerifyCode());
    const auth = await getAccessToken();
    if (!auth.token && auth.reason === "offline") {
      c.error = "inkk.site can't be reached right now — check your connection and try again.";
      return;
    }
    const accessToken = auth.token;
    const charCount = normalized.length;
    const authorName = await getAuthorName();
    const res = await window.inkk.certify({
      sessionId, text, title: c.title.trim() || null, accessToken, authorName, code, contentHash, wordCount, charCount,
    });
    if (res?.ok) {
      state.result = res.cert;
      resetCertify();
      go("result", null, { prev: { screen: "session", id: sessionId } });
      return;
    }
    if (res?.needsAuth) {
      if (!supa) c.error = "Certifying needs an account, and this build has no account service configured.";
      else { c.needsAuth = true; c.authEnter = true; }
    } else {
      c.error = res?.error || "Certification failed.";
    }
  } catch (e) {
    c.error = e?.message || "Certification failed.";
  } finally {
    c.busy = false;
    if (state.screen === "certify") render();
  }
}

async function runSignIn() {
  const c = state.certify;
  if (!c.email.trim() || !c.password) { c.authError = "Email and password, please."; render(); return; }
  c.authBusy = true; c.authError = null; render();
  try {
    await signInWithPassword(c.email.trim(), c.password);
    c.needsAuth = false; c.password = "";
    c.authBusy = false;
    await runCertify();
  } catch (e) {
    c.authBusy = false;
    c.authError = e?.message || "Sign-in failed.";
    render();
  }
}

let copiedTimer = null;
async function copy(what, text) {
  try { await window.inkk.copyText(text); } catch {}
  state.copied = what; render();
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { if (state.copied === what) { state.copied = null; render(); } }, 1400);
}

const ACTIONS = {
  go: (el) => go(el.dataset.screen, el.dataset.id || null),
  back: () => goBack(),
  open: (el) => window.inkk.openExternal(el.dataset.url),
  copy: (el) => copy(el.dataset.what, el.dataset.text),
  "perm-request": async (el) => {
    const kind = el.dataset.kind;
    await window.inkk.requestPermission(kind);
    state.permTried[kind] = true;
    state.app = await window.inkk.getState();
    render();
  },
  "perm-settings": (el) => window.inkk.openPermissionSettings(el.dataset.kind),
  relaunch: () => window.inkk.relaunch(),
  start: async () => { await window.inkk.setOnboarded(true); state.app = await window.inkk.getState(); go("home", null, { prev: null }); },
  "end-session": async (el) => { await window.inkk.endSession(el.dataset.id); },
  resume: () => window.inkk.setPaused(null),
  pause: () => window.inkk.setPaused(Date.now() + 60 * MIN),
  "toggle-login": () => window.inkk.setLaunchAtLogin(!state.app?.launchAtLogin),
  "ignore-front": () => {
    const f = state.app?.frontApp; if (!f) return;
    const list = state.app.ignoredApps || [];
    if (!list.includes(f.bundleId)) window.inkk.setIgnoredApps([...list, f.bundleId]);
  },
  unignore: (el) => window.inkk.setIgnoredApps((state.app?.ignoredApps || []).filter((x) => x !== el.dataset.id)),
  "toggle-records": () => { state.recordsOpen = !state.recordsOpen; render(); },
  "sign-out": async () => { await signOut(); render(); },
  quit: () => window.inkk.quit(),
  certify: () => runCertify(),
  "delete-ask": () => { state.confirmDelete = true; render(); },
  "delete-cancel": () => { state.confirmDelete = false; render(); },
  "delete-confirm": async (el) => { await window.inkk.deleteSession(el.dataset.id); go("home", null, { prev: null }); },
};

root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "FORM" || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el); }
});

root.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-action]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.action === "sign-in") runSignIn();
});

// Text fields write straight into state; the certify button's enabled state
// follows the text, so that one re-renders (focus is preserved).
root.addEventListener("input", (e) => {
  const f = e.target.dataset?.field;
  if (!f) return;
  const c = state.certify;
  c[f] = e.target.value;
  if (f === "text") {
    const btn = root.querySelector('[data-action="certify"]');
    if (btn) btn.disabled = c.busy || !c.text.trim();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.screen === "home" || state.screen === "welcome") window.inkk.hide();
  else goBack();
});

window.addEventListener("hashchange", () => {
  if (settingHash) { settingHash = false; return; }
  routeFromHash();
});

/* ═══ Boot ═══════════════════════════════════════════════════════════════ */

(async function boot() {
  if (!window.inkk) {
    root.innerHTML = `<p class="lead">This page needs the inkk companion.</p>`;
    return;
  }
  const [s, list] = await Promise.all([window.inkk.getState(), window.inkk.getSessions()]);
  state.app = s;
  state.sessions = list || [];
  restoreUser().then(() => { if (state.screen === "settings") render(); });

  window.inkk.onState((next) => {
    state.app = next;
    if (state.screen === "certify" || state.screen === "result") renderPill();
    else if (state.screen === "welcome") render();
    else if (state.screen === "home" && needsWelcome(next)) go("welcome", null, { prev: null });
    else render();
  });
  window.inkk.onSessions((list) => {
    state.sessions = list || [];
    if (state.screen === "session" && state.sessionId) {
      // The summary row changed (live score, cert); refresh the detail quietly.
      window.inkk.getSession(state.sessionId).then((d) => {
        if (state.screen !== "session" || !d) return;
        state.detail = d; render();
      });
    } else if (state.screen === "home" || state.screen === "settings") render();
  });
  window.inkk.onShown(async () => {
    const [ns, nl] = await Promise.all([window.inkk.getState(), window.inkk.getSessions()]);
    state.app = ns; state.sessions = nl || [];
    if (state.screen === "certify" || state.screen === "result") renderPill(); else render();
  });

  if (location.hash) await routeFromHash();
  else go(needsWelcome(s) ? "welcome" : "home", null, { prev: null });
})();
