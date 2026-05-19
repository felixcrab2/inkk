// Drains IndexedDB writing_events queue → Supabase, batched, in the background.
// Only runs when (signed in) AND (research_opt_in = true) AND (online).
// Honours RLS: writing_events insert is also gated server-side by opt-in.

import * as store from "./store";

const BATCH = 500;
const PERIOD_MS = 12_000;

let timer = null;
let busy = false;
let getCtx = null;
let supabase = null;

async function drainOnce() {
  if (busy) return;
  busy = true;
  try {
    const { userId, optedIn } = getCtx?.() || {};
    if (!userId || !optedIn || !navigator.onLine || !supabase) return;

    const batch = await store.drain(userId, BATCH);
    if (!batch.length) return;

    // Strip local-only fields just in case (no schema mismatch).
    const rows = batch.map(({ id, user_id, doc_id, session_id, t, kind, key_class, input_type, len_delta, caret_pos, selection_len, payload }) =>
      ({ id, user_id, doc_id, session_id, t, kind, key_class, input_type, len_delta, caret_pos, selection_len, payload }));

    const { error } = await supabase.from("writing_events").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (!error) {
      await store.remove(batch.map(b => b.id));
    } else {
      // Common case: opt-in revoked → RLS rejects. Drop these so we don't loop.
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("row-level") || msg.includes("permission") || msg.includes("policy")) {
        await store.remove(batch.map(b => b.id));
      }
    }
  } catch {
    /* swallow: try again on next tick */
  } finally {
    busy = false;
  }
}

export function startSync({ supabase: sb, getContext }) {
  if (timer) return;
  supabase = sb;
  getCtx   = getContext;
  // run once promptly, then on a timer
  drainOnce();
  timer = setInterval(drainOnce, PERIOD_MS);
  window.addEventListener("online", drainOnce);
}

export function stopSync() {
  if (timer) { clearInterval(timer); timer = null; }
  window.removeEventListener("online", drainOnce);
}

export function flushNow() { drainOnce(); }

// Update profile.research_opt_in
export async function setResearchOptIn(sb, userId, optIn) {
  if (!sb || !userId) return "Not signed in.";
  const { error } = await sb.from("profiles").update({ research_opt_in: !!optIn }).eq("id", userId);
  return error?.message || null;
}

// Read the current opt-in flag
export async function getResearchOptIn(sb, userId) {
  if (!sb || !userId) return false;
  const { data } = await sb.from("profiles").select("research_opt_in").eq("id", userId).maybeSingle();
  return !!data?.research_opt_in;
}

// "Delete my research data" → server-side RPC
export async function deleteMyEvents(sb) {
  if (!sb) return "Not signed in.";
  const { error } = await sb.rpc("delete_my_writing_events");
  return error?.message || null;
}

// "Download my data" — pulls a snapshot from the cloud (researcher's events).
export async function dumpMyEvents(sb, userId) {
  if (!sb || !userId) return [];
  const { data } = await sb
    .from("writing_events")
    .select("*")
    .order("t", { ascending: true })
    .limit(50_000);
  return data || [];
}
