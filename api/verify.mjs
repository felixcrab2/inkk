// Public certificate lookup by code (Vercel serverless function).
//
// GET /api/verify?code=INKK-XXXX-XXXX-XXXX
//
// The reader's side of a certificate. The desktop companion notices a code in
// whatever is on screen (an email, a document's metadata, the pixels of a
// signature) and asks this route what the ledger holds for it; the website can
// use it too. It returns the same public fields as the verify_by_code RPC plus
// the certificate's sentence sketch and binding, which is what lets a reader's
// app check, on the reader's own machine, which sentences of the certified text
// are in front of them. The reader's text never comes here: only the code does.
//
// Exact-code lookup of one row, never a listing, with the service-role key (the
// table's RLS only lets owners read their rows). The response is built field by
// field from an allow-list, so user_id and anything added to the table later
// can never leak through it.
//
// text_sketch and binding are new columns (docs/backend-changes-2026-09.md).
// Until the migration has run, the lookup falls back to the older column set
// and answers with nulls for both, so deploying this route first is harmless.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, like /api/certify.

import { createClient } from "@supabase/supabase-js";
import { parseVerifyCode } from "../src/verify/code.js";

const BASE_COLUMNS = [
  "code", "title", "author_name", "author_username", "content_hash", "word_count",
  "human_score", "score_tier", "verified", "issued_at",
];
const NEW_COLUMNS = ["text_sketch", "binding"];

const RATE_LIMIT = 60;                 // lookups per IP per window
const RATE_WINDOW_MS = 60 * 1000;
const RATE_TABLE_MAX = 5000;           // distinct IPs remembered per instance before pruning
const MISSING_COLUMNS_TTL_MS = 10 * 60 * 1000; // after a fallback, skip the doomed full select this long
const SKETCH_ENTRY = /^[0-9a-f]{10}$/;
const SKETCH_MAX = 600;

function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  // The service key goes by several names across Supabase's dashboards and
  // Vercel's integration; any of them will do.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Postgres says 42703 for a column that isn't there; PostgREST says PGRST204
// (or names the column) when its schema cache doesn't know it yet.
export function isUnknownColumnError(error, columns) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`;
  return columns.some((c) => msg.includes(c));
}

// The caller's address as Vercel reports it. Vercel sets x-forwarded-for
// itself (it does not pass a client-supplied one through), so its first entry
// is the real client.
function clientIp(req) {
  const h = req.headers || {};
  const xff = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || String(h["x-real-ip"] || "").trim() || (req.socket && req.socket.remoteAddress) || "unknown";
}

function codeParam(req) {
  if (req.query && req.query.code != null) {
    return Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
  }
  try { return new URL(req.url || "", "http://localhost").searchParams.get("code"); } catch { return null; }
}

// Only well-formed sketch entries go out, so a bad row can never hand a reader
// something their comparison code would trip over.
function cleanSketch(v) {
  if (!Array.isArray(v)) return null;
  return v.filter((s) => typeof s === "string" && SKETCH_ENTRY.test(s)).slice(0, SKETCH_MAX);
}

function publicCert(row) {
  return {
    code: row.code,
    title: row.title ?? null,
    author_name: row.author_name ?? null,
    author_username: row.author_username ?? null,
    content_hash: row.content_hash ?? null,
    word_count: row.word_count ?? null,
    human_score: row.human_score ?? null,
    score_tier: row.score_tier ?? null,
    verified: !!row.verified,
    issued_at: row.issued_at ?? null,
    text_sketch: cleanSketch(row.text_sketch),
    binding: typeof row.binding === "string" ? row.binding : null,
  };
}

// Built as a factory so the tests can hand in a fake client and clock; the
// deployed route below uses the real ones. The rate table and the
// missing-column memo live per instance, which is all a warm serverless
// instance has. That is a speed bump against scraping, not a wall: codes carry
// 60 bits, so enumeration is hopeless anyway.
export function createVerifyHandler({ getClient = serviceClient, now = () => Date.now() } = {}) {
  const hits = new Map();              // ip -> { start, count }
  let newColumnsMissingUntil = 0;

  function limited(ip) {
    const t = now();
    if (hits.size > RATE_TABLE_MAX) {
      for (const [k, v] of hits) if (t - v.start >= RATE_WINDOW_MS) hits.delete(k);
      if (hits.size > RATE_TABLE_MAX) hits.clear();
    }
    const h = hits.get(ip);
    if (!h || t - h.start >= RATE_WINDOW_MS) { hits.set(ip, { start: t, count: 1 }); return 0; }
    h.count += 1;
    return h.count > RATE_LIMIT ? Math.max(1, Math.ceil((h.start + RATE_WINDOW_MS - t) / 1000)) : 0;
  }

  async function selectRow(svc, code) {
    const run = (cols) => svc.from("verifications").select(cols.join(", ")).eq("code", code).maybeSingle();
    if (now() >= newColumnsMissingUntil) {
      const full = await run([...BASE_COLUMNS, ...NEW_COLUMNS]);
      if (!full.error || !isUnknownColumnError(full.error, NEW_COLUMNS)) return full;
      newColumnsMissingUntil = now() + MISSING_COLUMNS_TTL_MS;
    }
    return run(BASE_COLUMNS);
  }

  return async function handler(req, res) {
    // Public, credential-free data: any page may read it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.setHeader("Cache-Control", "no-store");
      res.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const retryAfter = limited(clientIp(req));
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }

    const code = parseVerifyCode(codeParam(req));
    if (!code) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ ok: false, error: "bad_code" });
      return;
    }

    const svc = getClient();
    if (!svc) {
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ ok: false, error: "not_configured" });
      return;
    }

    let result;
    try { result = await selectRow(svc, code); } catch { result = { error: { message: "threw" } }; }
    if (result.error) {
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ ok: false, error: "lookup_failed" });
      return;
    }
    if (!result.data) {
      // Not cached: a code certified a moment ago must verify straight away.
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }

    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json({ ok: true, cert: publicCert(result.data) });
  };
}

export default createVerifyHandler();
