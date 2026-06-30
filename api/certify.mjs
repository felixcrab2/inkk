// Server-side certificate issuance (Vercel serverless function).
//
// THE TRUST ANCHOR. The browser must never be the authority on a piece's human-
// signal score: the verifications/publications RLS policies only check row
// ownership, so a signed-in user could otherwise POST { human_score: 100,
// verified: true } straight to the table and mint a fake certificate without
// writing a word (no need to read score.js or forge any telemetry). So the score
// is computed HERE, on the server, and written with the service-role key. Section
// 13 of schema.sql locks those columns so this route is the only thing that can
// set them.
//
// The number is recomputed with the SAME pure functions the editor uses
// (src/telemetry/features.js + score.js — imported, never duplicated), so a
// certified piece scores exactly as the writer saw it. The keystroke trace is
// reassembled from (a) the events the client submits — its in-memory ring plus
// its IndexedDB queue, which is the complete trace for someone who never syncs —
// unioned by event id with (b) the user's synced cloud batches.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only env; never shipped
// to the browser). If they're missing the route fails soft (ok:false) and the
// client falls back to its previous write, so a misconfig can never block
// publishing.

import { createClient } from "@supabase/supabase-js";
import { extractFeatures } from "../src/telemetry/features.js";
import { computeScore } from "../src/telemetry/score.js";

const VERIFIED_TIERS = new Set(["Strong", "Distinct"]);
const MAX_CLIENT_EVENTS = 60000;   // bound per-request work
const MAX_CLOUD_BATCHES = 150;     // bound the best-effort cloud backfill

function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Confirm the caller is a signed-in inkk user from their access token. Returns
// the user id, or null to reject.
async function verifyUser(req) {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch { return null; }
}

// Pull a doc's synced events back out of the user's packed cloud batches. Best
// effort + bounded: the client-submitted trace is the primary source; this just
// backfills the case where events were synced and pruned from the device.
async function cloudEventsForDoc(svc, userId, docId) {
  try {
    const { data, error } = await svc
      .from("writing_event_batches")
      .select("events")
      .eq("user_id", userId)
      .order("max_t", { ascending: false })
      .limit(MAX_CLOUD_BATCHES);
    if (error || !Array.isArray(data)) return [];
    const out = [];
    for (const b of data) {
      if (!Array.isArray(b.events)) continue;
      for (const e of b.events) if (e && e.doc_id === docId) out.push(e);
    }
    return out;
  } catch { return []; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

  const uid = await verifyUser(req);
  if (!uid) { res.status(401).json({ ok: false, error: "Sign in required" }); return; }

  const svc = serviceClient();
  if (!svc) { res.status(200).json({ ok: false, error: "Certification not configured" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const docId = typeof body.docId === "string" ? body.docId : null;
  const code  = typeof body.code  === "string" ? body.code  : null;
  if (!docId || !code) { res.status(400).json({ ok: false, error: "Missing docId or code" }); return; }

  const contentHash = typeof body.contentHash === "string" ? body.contentHash : null;
  const wordCount = Number.isFinite(body.wordCount) ? body.wordCount : 0;
  const title = typeof body.title === "string" ? body.title : null;
  const authorName = typeof body.authorName === "string" ? body.authorName : null;
  const authorUsername = typeof body.authorUsername === "string" ? body.authorUsername : null;
  const clientEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_CLIENT_EVENTS) : [];

  // The caller must own the document they're certifying.
  try {
    const { data: docRow, error: docErr } = await svc
      .from("documents").select("user_id").eq("id", docId).maybeSingle();
    if (docErr) { res.status(200).json({ ok: false, error: "Lookup failed" }); return; }
    if (docRow && docRow.user_id && docRow.user_id !== uid) {
      res.status(403).json({ ok: false, error: "Not your document" }); return;
    }
  } catch { res.status(200).json({ ok: false, error: "Lookup failed" }); return; }

  // A code already in the ledger keeps its original verdict (the ledger is an
  // immutable, append-only record). Otherwise recompute from the reassembled trace.
  let humanScore = null, scoreTier = null, verified = false;
  try {
    const { data: existing } = await svc
      .from("verifications").select("human_score, score_tier, verified").eq("code", code).maybeSingle();

    if (existing) {
      humanScore = existing.human_score;
      scoreTier  = existing.score_tier;
      verified   = !!existing.verified;
    } else {
      const byId = new Map();
      for (const e of clientEvents) if (e && e.id) byId.set(e.id, e);
      for (const e of await cloudEventsForDoc(svc, uid, docId)) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
      const events = [...byId.values()]
        .filter(e => e.doc_id === docId)
        .sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));

      const score = computeScore(extractFeatures(events, { words: wordCount }));
      humanScore = score.score;
      scoreTier  = score.tier;
      verified   = VERIFIED_TIERS.has(score.tier);

      // ignoreDuplicates → idempotent if two publishes race the same new code.
      await svc.from("verifications").upsert({
        code, doc_id: docId, user_id: uid,
        title, author_name: authorName, author_username: authorUsername,
        content_hash: contentHash, word_count: wordCount,
        human_score: humanScore, score_tier: scoreTier, verified,
      }, { onConflict: "code", ignoreDuplicates: true });
    }
  } catch {
    res.status(200).json({ ok: false, error: "Scoring failed" }); return;
  }

  // Stamp the live publication (if this doc is on the feed) with the authoritative
  // score. No-op row count when the piece isn't published.
  try {
    await svc.from("publications")
      .update({ human_score: humanScore, score_tier: scoreTier })
      .eq("doc_id", docId).eq("user_id", uid);
  } catch { /* non-fatal: the ledger row is the source of truth */ }

  res.status(200).json({ ok: true, code, verified, tier: scoreTier, score: humanScore, contentHash });
}
