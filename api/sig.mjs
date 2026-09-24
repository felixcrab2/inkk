// The picture of a signed name (Vercel serverless function).
//
// GET /api/sig?code=INKK-XXXX-XXXX-XXXX, which is what
// https://www.inkk.site/s/INKK-XXXX-XXXX-XXXX.png becomes (vercel.json).
//
// When a writer signs an email with the desktop companion, their name goes in
// as a picture linked to its certificate. Web mail throws away a picture
// pasted into it as a data: URL (Gmail sends only the plain-text part), so for
// mail written in a browser the picture is kept with its certificate
// (verifications.signature_png, stored by /api/certify) and the email points
// here. Recipients' mail fetches it without signing in, often through a proxy
// (Gmail's), so it is public by code, exactly like the certificate it belongs
// to, and it never changes once stored: it may be cached for a year.
//
// One column of one row, by exact code, with the service-role key (the same
// env handling as /api/verify). Nothing else about the certificate comes out
// here, and only a real PNG of a signature's size is ever served, whatever the
// row holds.
//
// signature_png is a new column (docs/backend-changes-2026-09.md, section 11).
// Until it exists every code answers 404, and the companion falls back to
// pasting the picture itself.

import { createClient } from "@supabase/supabase-js";
import { parseVerifyCode } from "../src/verify/code.js";

export const SIGNATURE_MAX_BYTES = 200 * 1024;
const SIGNATURE_MAX_WIDTH = 4096;      // a long name at twice its size is well under this
const SIGNATURE_MAX_HEIGHT = 512;      // one line of type, not a photograph
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

// Where a certificate's signed-name picture is served. Always the www host,
// like every other inkk link.
export function signatureUrl(code) {
  return `https://www.inkk.site/s/${encodeURIComponent(code)}.png`;
}

// A signed name's picture, from base64, as bytes; null when it is not one: a
// PNG (its signature, then its header chunk first, as the format requires),
// at most 200 KB, and the shape of a line of type. Shared with /api/certify,
// which applies the same test before storing one.
export function signaturePngBytes(b64) {
  if (typeof b64 !== "string") return null;
  const s = b64.replace(/\s+/g, "");
  if (!s || s.length > Math.ceil(SIGNATURE_MAX_BYTES / 3) * 4 || !BASE64.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  if (buf.length < 33 || buf.length > SIGNATURE_MAX_BYTES) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) if (buf[i] !== PNG_MAGIC[i]) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > SIGNATURE_MAX_WIDTH || height > SIGNATURE_MAX_HEIGHT) return null;
  return buf;
}

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
function isUnknownColumnError(error) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.includes("signature_png");
}

// The code from the query, with the ".png" the public path ends in dropped
// should it come through.
function codeParam(req) {
  let v = null;
  if (req.query && req.query.code != null) {
    v = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
  } else {
    try { v = new URL(req.url || "", "http://localhost").searchParams.get("code"); } catch { v = null; }
  }
  return v == null ? null : String(v).replace(/\.png$/i, "");
}

// Built as a factory so the tests can hand in a fake client; the deployed
// route (the default export below) uses the real one. No rate limit, unlike
// /api/verify: the callers are mail apps and image proxies that many readers
// share, and a limit would blank a signature in someone's inbox.
export function createSigHandler({ getClient = serviceClient } = {}) {
  return async function handler(req, res) {
    // A picture anyone may show.
    res.setHeader("Access-Control-Allow-Origin", "*");
    const fail = (status, error) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(status).json({ ok: false, error });
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      fail(405, "method_not_allowed");
      return;
    }

    const code = parseVerifyCode(codeParam(req));
    if (!code) { fail(400, "bad_code"); return; }

    const svc = getClient();
    if (!svc) { fail(503, "not_configured"); return; }

    let result;
    try {
      result = await svc.from("verifications").select("signature_png").eq("code", code).maybeSingle();
    } catch {
      result = { error: { message: "threw" } };
    }
    // Before the migration there is no picture to find, which is a 404, not a failure.
    if (result.error && !isUnknownColumnError(result.error)) { fail(502, "lookup_failed"); return; }
    const png = !result.error && result.data ? signaturePngBytes(result.data.signature_png) : null;
    // Not cached: a picture stored a moment ago must show straight away.
    if (!png) { fail(404, "not_found"); return; }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(png.length));
    res.setHeader("Cache-Control", IMMUTABLE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200);
    if (req.method === "HEAD") res.end();
    else res.end(png);
  };
}

export default createSigHandler();
