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
const MAX_CHARS = 32000; // generous cap to bound latency on very long pieces

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

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

  if (!text) {
    res.status(200).json({ ok: true, flagged: false, categories: {}, scores: {} });
    return;
  }

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input: text }),
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
