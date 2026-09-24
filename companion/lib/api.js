// inkk companion — talking to inkk.site.
//
// Every request goes to the www host. The apex (inkk.site) answers with a 308
// to www, and fetch drops the Authorization header when it follows a redirect
// to another host, so a signed-in writer's certify arrived without its token,
// the server said "sign in required", and the popover asked them to sign in
// again although they already had. Redirects are therefore followed by hand,
// only to inkk's own hosts over https, re-sending the method, body and token.

"use strict";

const TRUSTED_HOSTS = new Set(["inkk.site", "www.inkk.site"]);
const MAX_REDIRECTS = 3;
const CERTIFY_TIMEOUT_MS = 25000;
const VERIFY_TIMEOUT_MS = 8000;

// "https://inkk.site/" → "https://www.inkk.site". Anything else (a preview
// deployment, localhost while developing) is left as it is.
function canonicalBase(base) {
  const raw = String(base || "https://www.inkk.site").trim().replace(/\/+$/, "");
  try {
    const u = new URL(raw);
    if (u.hostname === "inkk.site") u.hostname = "www.inkk.site";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "https://www.inkk.site";
  }
}

function createApi({ base, fetch: fetchImpl = globalThis.fetch } = {}) {
  const root = canonicalBase(base);

  async function request(path, { method = "GET", headers = {}, body, timeoutMs }) {
    let url = root + path;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, url);
      if (next.protocol !== "https:" || !TRUSTED_HOSTS.has(next.hostname)) throw new Error(`redirected off inkk.site (${next.hostname})`);
      url = next.toString();
    }
    throw new Error("too many redirects");
  }

  // → { ok: true, cert } | { ok: false, error, needsAuth? }
  async function certify(payload, token) {
    if (!token) return { ok: false, error: "Sign in required", needsAuth: true };
    let res;
    try {
      res = await request("/api/certify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        timeoutMs: CERTIFY_TIMEOUT_MS,
      });
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, error: timedOut ? "inkk.site didn't answer. Try again." : "inkk.site can't be reached." };
    }
    if (res.status === 401) return { ok: false, error: "Sign in required", needsAuth: true };
    let out = null;
    try { out = await res.json(); } catch { /* an HTML error page */ }
    if (!res.ok || !out || !out.ok) return { ok: false, error: (out && out.error) || `Certification failed (${res.status})` };
    return { ok: true, result: out };
  }

  // → the public certificate row, null when the ledger has no such code, or
  // undefined when the question couldn't be asked (offline, route missing).
  async function verify(code) {
    let res;
    try {
      res = await request(`/api/verify?code=${encodeURIComponent(code)}`, { timeoutMs: VERIFY_TIMEOUT_MS });
    } catch { return undefined; }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) return undefined;          // the route isn't deployed yet: an HTML 404
    let out = null;
    try { out = await res.json(); } catch { return undefined; }
    if (res.status === 404 && out && out.error === "not_found") return null;
    if (res.ok && out && out.ok && out.cert) return out.cert;
    return undefined;
  }

  return { base: root, certify, verify, request };
}

module.exports = { createApi, canonicalBase, TRUSTED_HOSTS };
