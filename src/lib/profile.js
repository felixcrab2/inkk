import { supabase } from "../supabase";

// ─── Research contribution stats ───────────────────────────────────────────
export async function fetchMyContribution(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("my_writing_event_counts")
    .select("event_count, first_t, last_t")
    .maybeSingle();
  if (error) return null;
  return data || null;
}

export async function fetchProfile(userId) {
  if (!supabase || !userId) return null;
  const { data } = await supabase
    .from("profiles").select("id, username, display_name, research_opt_in, tos_accepted_at").eq("id", userId).maybeSingle();
  return data || null;
}

export async function upsertProfile(userId, username, displayName, { tosAccepted = false, tosVersion = null } = {}) {
  if (!supabase || !userId) return "Not signed in.";
  const row = { id: userId, username, display_name: displayName || null };
  if (tosAccepted) {
    row.research_opt_in = true;
    row.tos_accepted_at = new Date().toISOString();
    row.tos_version     = tosVersion;
  }
  const { error } = await supabase.from("profiles").upsert(row);
  return error ? error.message : null;
}

export async function fetchProfileByUsername(username) {
  if (!supabase || !username) return null;
  const { data } = await supabase
    .from("profiles").select("id, username, display_name")
    .eq("username", username).maybeSingle();
  return data || null;
}

// Build a valid, unused username from a free-form base (a Google display name,
// an email local-part, or a handle that was claimed between signup and
// confirmation). Sanitises to the allowed charset, pads to the 3-char minimum,
// and suffixes digits until the handle is free. Used so accounts that arrive
// without a chosen username (e.g. Google sign-in) are never blocked — the handle
// is editable afterwards from the Notes tab.
export async function generateUniqueUsername(base) {
  let root = (base || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
  if (root.length < 3) root = `${root}writer`.slice(0, 16);
  for (let i = 0; i < 10; i++) {
    const suffix = i === 0 ? "" : String(Math.floor(1000 + Math.random() * 9000));
    const candidate = `${root}${suffix}`.slice(0, 20);
    if (!(await fetchProfileByUsername(candidate))) return candidate;
  }
  return `${root}${Date.now().toString().slice(-6)}`.slice(0, 20);
}
