// inkk companion — renderer.
//
// Receives telemetry events from the main process, batches them to the SAME
// writing_event_batches table the website uses, and runs the certificate flow
// against the SAME server function (api/certify.mjs). The code + content hash
// come from src/verify/code.js imported directly, so a companion certificate is
// indistinguishable from a website one — single source of truth.

import { createClient } from "@supabase/supabase-js";
import { makeVerifyCode, hashContent, normalizePlainText } from "../../src/verify/code.js";

// Injected by build-renderer.js (esbuild --define) from the environment.
const SUPA_URL = __SUPA_URL__;
const SUPA_KEY = __SUPA_KEY__;
const API_BASE = __API_BASE__;

const supa = (SUPA_URL && SUPA_KEY) ? createClient(SUPA_URL, SUPA_KEY) : null;

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  profile: null,
  docId: null,
  armed: false,
  events: [],        // full session trace (submitted inline at certify time)
  queue: [],         // pending sync to writing_event_batches
  keystrokes: 0,
};

// ── batching to writing_event_batches (mirrors src/telemetry/sync.js) ────────
const SYNC_PERIOD_MS = 5000;
async function drainQueue() {
  if (!supa || !state.user || state.queue.length === 0) return;
  const batch = state.queue.splice(0, 500);
  const ts = batch.map(e => Number(e.t) || 0);
  const row = {
    id: crypto.randomUUID(),
    schema_version: 2,
    user_id: state.user.id,
    event_count: batch.length,
    min_t: Math.min(...ts),
    max_t: Math.max(...ts),
    events: batch,
  };
  const { error } = await supa.from("writing_event_batches").upsert(row, { onConflict: "id", ignoreDuplicates: true });
  if (error) state.queue.unshift(...batch);   // put back, retry next tick
}
setInterval(drainQueue, SYNC_PERIOD_MS);

// ── events in from main ──────────────────────────────────────────────────────
window.companion.onEvents((evs) => {
  state.events.push(...evs);
  state.queue.push(...evs);
  for (const e of evs) if (e.kind === "input" || e.kind === "delete") state.keystrokes++;
  $("keystrokes").textContent = state.keystrokes.toLocaleString();
});
window.companion.onFrontApp((a) => { if (state.armed) $("recording-app").textContent = a || "…"; });
window.companion.onState((s) => { state.armed = s.armed; renderPhase(s.armed ? "recording" : "idle"); });
window.companion.onError((m) => { $("err").textContent = m; $("err").style.display = "block"; });

// ── auth ─────────────────────────────────────────────────────────────────────
async function signIn(email, password) {
  if (!supa) { $("err").textContent = "Companion not configured (missing Supabase keys)."; $("err").style.display = "block"; return; }
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) { $("signin-err").textContent = error.message; return; }
  state.user = data.user;
  const { data: prof } = await supa.from("profiles").select("username, display_name").eq("id", data.user.id).maybeSingle();
  state.profile = prof || null;
  $("who").textContent = prof?.display_name || prof?.username || data.user.email;
  renderPhase("idle");
}

// ── session ──────────────────────────────────────────────────────────────────
function armSession() {
  state.docId = crypto.randomUUID();
  state.events = [];
  state.queue = [];
  state.keystrokes = 0;
  $("keystrokes").textContent = "0";
  window.companion.start({ userId: state.user.id, docId: state.docId });
}
function endSession() { window.companion.stop(); }

// ── certify ──────────────────────────────────────────────────────────────────
async function certify(finalText) {
  await drainQueue();                       // best-effort: land the batches too
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
      docId: state.docId,
      code,
      contentHash,
      wordCount,
      title: $("title").value.trim() || null,
      authorName: state.profile?.display_name || state.profile?.username || null,
      authorUsername: state.profile?.username || null,
      events: state.events,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(out.error || "Certification failed");
  return out;   // { code, verified, tier, score }
}

// ── UI wiring ────────────────────────────────────────────────────────────────
function renderPhase(phase) {
  for (const p of ["signin", "idle", "recording", "certify", "result"]) {
    $(`phase-${p}`).style.display = (p === phase) ? "block" : "none";
  }
}

$("signin-btn").onclick = () => signIn($("email").value.trim(), $("password").value);
$("arm-btn").onclick = armSession;
$("stop-btn").onclick = () => { endSession(); renderPhase("certify"); };
$("certify-btn").onclick = async () => {
  $("certify-btn").disabled = true;
  $("certify-btn").textContent = "Certifying…";
  try {
    const out = await certify($("final-text").value);
    $("result-code").textContent = out.code;
    $("result-tier").textContent = out.verified ? `Human-verified · ${out.tier} (${out.score}/100)` : `Recorded · ${out.tier} (${out.score}/100)`;
    renderPhase("result");
  } catch (e) {
    $("certify-err").textContent = e.message;
    $("certify-err").style.display = "block";
  } finally {
    $("certify-btn").disabled = false;
    $("certify-btn").textContent = "Get my code";
  }
};
$("copy-btn").onclick = () => navigator.clipboard.writeText($("result-code").textContent);
$("again-btn").onclick = () => { $("title").value = ""; $("final-text").value = ""; renderPhase("idle"); };

window.companion.version().then(v => { $("version").textContent = "v" + v; });
renderPhase(supa ? "signin" : "signin");
