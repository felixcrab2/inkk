// inkk companion — renderer.
//
// The main process auto-detects when you're writing (Notes, Word, Substack…)
// and streams telemetry events here. This side: restores your sign-in, batches
// events to the SAME writing_event_batches table, and runs the certificate flow
// against the SAME server function (api/certify.mjs) with the SAME code/hash
// functions (src/verify/code.js) — one source of truth across web + desktop.

import { createClient } from "@supabase/supabase-js";
import { makeVerifyCode, hashContent, normalizePlainText } from "../../src/verify/code.js";

const SUPA_URL = __SUPA_URL__;
const SUPA_KEY = __SUPA_KEY__;
const API_BASE = __API_BASE__;
const supa = (SUPA_URL && SUPA_KEY) ? createClient(SUPA_URL, SUPA_KEY) : null;

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  profile: null,
  docId: null,
  events: [],        // current session's trace (submitted inline at certify)
  queue: [],         // pending sync to writing_event_batches
  keystrokes: 0,
  armed: false,
};

// ── batch sync (mirrors src/telemetry/sync.js) ───────────────────────────────
async function drainQueue() {
  if (!supa || !state.user || state.queue.length === 0) return;
  const batch = state.queue.splice(0, 500);
  const ts = batch.map(e => Number(e.t) || 0);
  const row = {
    id: crypto.randomUUID(), schema_version: 2, user_id: state.user.id,
    event_count: batch.length, min_t: Math.min(...ts), max_t: Math.max(...ts), events: batch,
  };
  const { error } = await supa.from("writing_event_batches").upsert(row, { onConflict: "id", ignoreDuplicates: true });
  if (error) state.queue.unshift(...batch);
}
setInterval(drainQueue, 5000);

// ── events streamed from main ────────────────────────────────────────────────
window.companion.onEvents((evs) => {
  for (const e of evs) {
    if (e.kind === "session_start") {           // a fresh auto-armed session
      state.events = []; state.docId = e.doc_id; state.keystrokes = 0;
    }
    state.events.push(e);
    state.queue.push(e);
    if (e.kind === "input" || e.kind === "delete") state.keystrokes++;
  }
  $("keystrokes").textContent = state.keystrokes.toLocaleString();
});

window.companion.onState((s) => {
  state.armed = s.armed;
  if (!state.user) { renderPhase("signin"); return; }
  $("watch-app").textContent = s.app || "…";
  $("watch-status").textContent = s.writing ? "a writing app — just type" : "not a writing app";
  $("watch-status").className = "watch-status " + (s.writing ? "on" : "off");
  $("recording-app").textContent = s.app || "…";
  // Don't yank the user out of the certify/result screens with background state.
  const p = currentPhase();
  if (p === "certify" || p === "result") return;
  renderPhase(s.armed ? "recording" : "watching");
});

window.companion.onError((m) => { $("err").textContent = m; $("err").style.display = "block"; });

// ── auth (restored on launch; enables auto-arm) ──────────────────────────────
async function useSession(session) {
  if (!session?.user) return false;
  state.user = session.user;
  const { data: prof } = await supa.from("profiles").select("username, display_name").eq("id", session.user.id).maybeSingle();
  state.profile = prof || null;
  $("who").textContent = prof?.display_name || prof?.username || session.user.email;
  await window.companion.auth(session.user.id);   // let main auto-arm
  renderPhase("watching");
  return true;
}

async function signIn(email, password) {
  if (!supa) { showErr("Companion not configured (missing Supabase keys)."); return; }
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) { $("signin-err").textContent = error.message; return; }
  await useSession(data.session);
}

// ── certify ──────────────────────────────────────────────────────────────────
async function certify(finalText) {
  await drainQueue();
  const text = normalizePlainText(finalText);
  const wordCount = text ? text.split(" ").filter(Boolean).length : 0;
  const contentHash = await hashContent(finalText);
  const code = makeVerifyCode();
  const { data: sess } = await supa.auth.getSession();
  const token = sess?.session?.access_token;
  const res = await fetch(`${API_BASE}/api/certify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      docId: state.docId, code, contentHash, wordCount,
      title: $("title").value.trim() || null,
      authorName: state.profile?.display_name || state.profile?.username || null,
      authorUsername: state.profile?.username || null,
      events: state.events,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(out.error || "Certification failed");
  return out;
}

// ── UI ────────────────────────────────────────────────────────────────────────
const PHASES = ["signin", "watching", "recording", "certify", "result"];
function currentPhase() { return PHASES.find(p => $(`phase-${p}`).style.display !== "none"); }
function renderPhase(phase) { for (const p of PHASES) $(`phase-${p}`).style.display = (p === phase) ? "block" : "none"; }
function showErr(m) { $("err").textContent = m; $("err").style.display = "block"; }

$("signin-btn").onclick = () => signIn($("email").value.trim(), $("password").value);
$("finish-btn").onclick = async () => { await window.companion.end(); renderPhase("certify"); };
$("certify-btn").onclick = async () => {
  $("certify-btn").disabled = true; $("certify-btn").textContent = "Certifying…";
  try {
    const out = await certify($("final-text").value);
    $("result-code").textContent = out.code;
    $("result-tier").textContent = out.verified ? `Human-verified · ${out.tier} (${out.score}/100)` : `Recorded · ${out.tier} (${out.score}/100)`;
    renderPhase("result");
  } catch (e) { $("certify-err").textContent = e.message; $("certify-err").style.display = "block"; }
  finally { $("certify-btn").disabled = false; $("certify-btn").textContent = "Get my code"; }
};
$("copy-btn").onclick = () => navigator.clipboard.writeText($("result-code").textContent);
$("again-btn").onclick = () => { $("title").value = ""; $("final-text").value = ""; renderPhase(state.armed ? "recording" : "watching"); };

window.companion.version().then(v => { $("version").textContent = "v" + v; });

// Restore an existing sign-in on launch so auto-arm works without re-login.
(async () => {
  if (!supa) { renderPhase("signin"); return; }
  const { data } = await supa.auth.getSession();
  if (!(await useSession(data.session))) renderPhase("signin");
})();
