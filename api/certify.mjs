// Server-side certificate issuance (Vercel serverless function).
//
// THE TRUST ANCHOR. The client must never be the authority on a piece's human-
// signal score: the verifications RLS policy only checks row ownership, so a
// signed-in user could otherwise POST { human_score: 100, verified: true }
// straight to the table and mint a fake certificate without writing a word (no
// need to read score.js or forge any telemetry). So the score is computed HERE,
// on the server, and written with the service-role key. Section 9 of
// schema.sql locks those columns so this route is the only thing that can set
// them.
//
// The number is recomputed with the SAME pure functions the editor uses
// (src/telemetry/features.js + score.js — imported, never duplicated), so a
// certified piece scores exactly as the writer saw it. The keystroke trace is
// reassembled from (a) the events the client submits — its in-memory ring plus
// its IndexedDB queue, which is the complete trace for someone who never syncs —
// unioned by event id with (b) the user's synced cloud batches.
//
// Two callers send the same body: the web editor's Certify tab and the desktop
// companion. The companion signs in anonymously before calling, so `uid` may be
// an anonymous Supabase user and authorName / authorUsername are often null —
// both are optional. The ledger row is all that is written; the submitted
// events are used for scoring and are not stored by this route.
//
// Besides the whole-text fingerprint, a caller may send a sketch: one short
// fingerprint per sentence (src/verify/sketch.js). It is stored with the row so
// a reader's app can later tell which sentences of the certified text are in
// front of it, unchanged, without the text ever leaving either machine. The
// sketch and the binding live in columns added in September 2026; on a database
// that doesn't have them yet the row is written without them rather than the
// certificate failing (docs/backend-changes-2026-09.md).
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only env; never shipped
// to the browser). If they're missing the route fails soft (ok:false) so a
// misconfig never blocks the writer — they keep their draft, they just don't
// get a verified code.

import { createClient } from "@supabase/supabase-js";
import { extractFeatures } from "../src/telemetry/features.js";
import { computeScore } from "../src/telemetry/score.js";

const VERIFIED_TIERS = new Set(["Strong", "Distinct"]);
const MAX_CLIENT_EVENTS = 60000;   // bound per-request work
const MAX_CLOUD_BATCHES = 150;     // bound the best-effort cloud backfill
const SKETCH_ENTRY = /^[0-9a-f]{10}$/;
const SKETCH_MAX = 600;            // same cap as src/verify/sketch.js
const BINDINGS = new Set(["text", "session", "file"]);
const SOURCES = new Set(["web", "companion", "file", "signature"]);
const NEW_COLUMNS = ["text_sketch", "binding"];

function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  // The service key goes by several names across Supabase's dashboards and
  // Vercel's integration; any of them will do.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Confirm the caller is a signed-in inkk user (email, Google or anonymous) from
// their access token. Returns the user id, or null to reject.
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

// Keep only well-formed sentence fingerprints, in order, without repeats.
// Anything else is dropped rather than rejected: a sketch only ever adds to a
// certificate, so a bad one must never cost the writer their code.
export function cleanSketch(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  const out = [];
  for (const s of v) {
    if (typeof s !== "string" || !SKETCH_ENTRY.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= SKETCH_MAX) break;
  }
  return out.length ? out : null;
}

// What the certificate is bound to. Callers say so; when an older caller
// doesn't, a file or signature certificate is still obviously about its text
// (or its file), and anything else stays unstated.
function bindingOf(body) {
  if (BINDINGS.has(body.binding)) return body.binding;
  const source = SOURCES.has(body.source) ? body.source : null;
  if (source === "file") return "file";
  if (source === "signature") return "text";
  return null;
}

// Postgres says 42703 for a column that isn't there; PostgREST says PGRST204
// (or names the column) when its schema cache doesn't know it yet.
function isUnknownColumnError(error) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`;
  return NEW_COLUMNS.some((c) => msg.includes(c));
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

// Built as a factory so the tests can hand in a fake client and caller; the
// deployed route (the default export below) uses the real ones.
export function createCertifyHandler({ getClient = serviceClient, authenticate = verifyUser } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

    const uid = await authenticate(req);
    if (!uid) { res.status(401).json({ ok: false, error: "Sign in required" }); return; }

    const svc = getClient();
    if (!svc) { res.status(200).json({ ok: false, error: "Certification not configured" }); return; }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const docId = typeof body.docId === "string" ? body.docId : null;
    const code  = typeof body.code  === "string" ? body.code  : null;
    if (!docId || !code) { res.status(400).json({ ok: false, error: "Missing docId or code" }); return; }

    const contentHash = typeof body.contentHash === "string" ? body.contentHash : null;
    const wordCount = Number.isFinite(body.wordCount) ? body.wordCount : 0;
    // Length of the finished text: lets the scorer count text that was never
    // typed as pasted (the companion cannot measure pastes directly).
    const charCount = Number.isFinite(body.charCount) && body.charCount > 0 ? body.charCount : null;
    const title = typeof body.title === "string" ? body.title : null;
    // Optional: the companion sends null for both (an anonymous user has no name).
    const authorName = typeof body.authorName === "string" ? body.authorName : null;
    const authorUsername = typeof body.authorUsername === "string" ? body.authorUsername : null;
    const clientEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_CLIENT_EVENTS) : [];
    const sketch = cleanSketch(body.sketch);
    const binding = bindingOf(body);

    // The caller must own the document they're certifying. A missing documents
    // row passes: the companion certifies sessions that only exist on the Mac.
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
    let humanScore = null, scoreTier = null, verified = false, storedHash = null, sketchStored = false;
    try {
      const existingCols = "human_score, score_tier, verified, user_id, content_hash";
      let found = await svc
        .from("verifications").select(`${existingCols}, text_sketch`).eq("code", code).maybeSingle();
      if (found.error && isUnknownColumnError(found.error)) {
        found = await svc.from("verifications").select(existingCols).eq("code", code).maybeSingle();
      }
      const existing = found.data;

      if (existing) {
        // A code is its owner's: anyone else asking about it gets nothing back.
        if (existing.user_id && existing.user_id !== uid) { res.status(403).json({ ok: false, error: "Not your certificate" }); return; }
        humanScore = existing.human_score;
        scoreTier  = existing.score_tier;
        verified   = !!existing.verified;
        storedHash = existing.content_hash || null;
        sketchStored = Array.isArray(existing.text_sketch) && existing.text_sketch.length > 0;
      } else {
        const byId = new Map();
        for (const e of clientEvents) if (e && e.id) byId.set(e.id, e);
        for (const e of await cloudEventsForDoc(svc, uid, docId)) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
        const events = [...byId.values()]
          .filter(e => e.doc_id === docId)
          .sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));

        const score = computeScore(extractFeatures(events, { words: wordCount, chars: charCount }));
        humanScore = score.score;
        scoreTier  = score.tier;
        verified   = VERIFIED_TIERS.has(score.tier);

        // ignoreDuplicates → idempotent if two certifications race the same new code.
        const row = {
          code, doc_id: docId, user_id: uid,
          title, author_name: authorName, author_username: authorUsername,
          content_hash: contentHash, word_count: wordCount,
          human_score: humanScore, score_tier: scoreTier, verified,
        };
        const write = (r) => svc.from("verifications").upsert(r, { onConflict: "code", ignoreDuplicates: true });
        let { error: writeErr } = await write({ ...row, text_sketch: sketch, binding });
        if (writeErr && isUnknownColumnError(writeErr)) {
          ({ error: writeErr } = await write(row));
        } else if (!writeErr) {
          sketchStored = !!sketch;
        }
        // A code the ledger doesn't hold would never verify: say so, rather than
        // hand the writer a dead code.
        if (writeErr) { res.status(200).json({ ok: false, error: "Could not record the certificate" }); return; }
      }
    } catch {
      res.status(200).json({ ok: false, error: "Scoring failed" }); return;
    }

    res.status(200).json({ ok: true, code, verified, tier: scoreTier, score: humanScore, contentHash: storedHash || contentHash, sketchStored });
  };
}

export default createCertifyHandler();
