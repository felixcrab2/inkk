// Server-side content moderation endpoint (Vercel serverless function).
//
// Runs on Vercel's servers, NOT in the browser, so the OpenAI key never ships
// to the client. The React app POSTs { text } here; we ask OpenAI's free
// Moderation model to classify it and return category scores + a verdict.
//
// Requires the OPENAI_API_KEY environment variable (set in `.env.local` for
// local dev and in the Vercel dashboard for production). If it's missing or
// OpenAI errors, we FAIL OPEN — returning ok:false so the caller treats the
// content as "not yet checked" rather than blocking the user.

const OPENAI_URL = "https://api.openai.com/v1/moderations";
const MODEL = "omni-moderation-latest";
const MAX_CHARS = 32000;       // generous cap to bound latency on very long pieces
const MAX_IMAGES = 8;          // cap images per request
const MAX_IMG_CHARS = 4000000; // ~3MB data URL; keeps us under Vercel's body limit

// Best-effort in-memory rate limit (per warm instance). Cross-instance limiting
// needs a shared store (Vercel KV / Upstash); this still blunts a single hot
// instance being hammered.
const RATE = new Map();
function rateOk(key, max = 40, windowMs = 60000) {
  const now = Date.now();
  const e = RATE.get(key);
  if (!e || now - e.ts > windowMs) { RATE.set(key, { count: 1, ts: now }); return true; }
  e.count += 1;
  return e.count <= max;
}

// Confirm the caller is a signed-in Inkk user, by checking their access token
// against Supabase. Returns the user id, null (reject), or "anon-skip" when the
// project env isn't wired up — so a missing config never silently breaks
// moderation (it just can't enforce auth there).
async function verifyUser(req) {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  if (!url || !anon) return "anon-skip";
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // Gate the endpoint behind a signed-in user so it can't be used as a free
  // moderation proxy or hammered to run up the OpenAI bill. The client fails
  // open on a non-200, so a rejected call never blocks publishing.
  const uid = await verifyUser(req);
  if (uid === null) { res.status(401).json({ ok: false, error: "Sign in required" }); return; }
  if (uid !== "anon-skip" && !rateOk(uid)) { res.status(429).json({ ok: false, error: "Too many requests" }); return; }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Not configured yet — fail open so publishing/commenting still works.
    res.status(200).json({ ok: false, error: "Moderation not configured" });
    return;
  }

  // req.body is auto-parsed for application/json, but be defensive.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const raw = (body && typeof body.text === "string") ? body.text : "";
  const text = raw.slice(0, MAX_CHARS).trim();

  // omni-moderation also scores images (sexual/violence/self-harm). Accept an
  // optional list of image URLs (data: or http) alongside the text.
  const imagesIn = Array.isArray(body && body.images) ? body.images : [];
  const images = imagesIn
    .filter(u => typeof u === "string" && (u.startsWith("data:image") || u.startsWith("http")))
    .filter(u => u.length <= MAX_IMG_CHARS)
    .slice(0, MAX_IMAGES);

  if (!text && images.length === 0) {
    res.status(200).json({ ok: true, flagged: false, categories: {}, scores: {} });
    return;
  }

  // Multimodal input (one combined verdict) when images are present; otherwise
  // a plain string. An array of {type} items returns a single merged result.
  const input = images.length
    ? [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map(url => ({ type: "image_url", image_url: { url } })),
      ]
    : text;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input }),
    });

    if (!r.ok) {
      res.status(200).json({ ok: false, error: `OpenAI ${r.status}` });
      return;
    }

    const data = await r.json();
    const result = data && data.results && data.results[0];
    if (!result) {
      res.status(200).json({ ok: false, error: "No moderation result" });
      return;
    }

    res.status(200).json({
      ok: true,
      flagged: !!result.flagged,
      categories: result.categories || {},
      scores: result.category_scores || {},
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: "Moderation request failed" });
  }
};
