// Drains the IndexedDB telemetry queue → Supabase, packed into batch rows, in
// the background. Only runs when (signed in) AND (research_opt_in = true) AND
// (online). Honours RLS: writing_event_batches insert is also gated server-side
// by opt-in.

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

    // Pack the whole batch into ONE row: a JSONB array of events plus a count
    // and time span. ~5–10× less storage than one row per event (no per-row
    // tuple + 3 index entries × thousands of tiny rows). Strip local-only fields
    // so the stored corpus matches the documented event shape exactly.
    const events = batch.map(({ id, schema_version, user_id, doc_id, session_id, seq, t, pt, kind, key_class, key_char, input_type, len_delta, caret_pos, selection_len, payload }) =>
      ({ id, schema_version, user_id, doc_id, session_id, seq, t, pt, kind, key_class, key_char, input_type, len_delta, caret_pos, selection_len, payload }));

    let minT = Infinity, maxT = -Infinity;
    for (const e of events) {
      const t = Number(e.t);
      if (Number.isFinite(t)) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    }
    if (!Number.isFinite(minT)) { minT = 0; maxT = 0; }

    const row = {
      id: events[0].id,                       // deterministic → idempotent if a retry re-drains the same batch
      schema_version: events[0].schema_version ?? null,
      user_id: userId,
      event_count: events.length,
      min_t: minT,
      max_t: maxT,
      events,
    };

    const { error } = await supabase.from("writing_event_batches").upsert(row, { onConflict: "id", ignoreDuplicates: true });
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

// "Download my data" — pulls a snapshot from the cloud and re-expands the packed
// batches back into a flat, time-ordered list of raw events (the same shape the
// recorder produced), so the exported corpus is identical to the pre-packing
// format. Paginates through all batches (no 50k cap).
export async function dumpMyEvents(sb, userId) {
  if (!sb || !userId) return [];
  const out = [];
  const PAGE = 1000;                              // batches per request
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("writing_event_batches")
      .select("events")
      .order("min_t", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    for (const b of data) if (Array.isArray(b.events)) out.push(...b.events);
    if (data.length < PAGE) break;
  }
  out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  return out;
}
