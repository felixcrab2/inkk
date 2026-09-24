// inkk companion — asking the ledger about a code.
//
// Only the code is sent. A found certificate is kept for ten minutes and a
// missing one for a minute, so a code on screen isn't looked up every few
// seconds. The public /api/verify route answers first; while it isn't
// deployed, the verify_by_code function in the database answers instead.

"use strict";

const FOUND_MS = 10 * 60 * 1000;
const MISSING_MS = 60 * 1000;

function createLookup({ api, supabaseUrl, anonKey, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new Map();          // code → { cert, at }
  const flights = new Map();        // code → Promise

  async function viaRpc(code) {
    if (!supabaseUrl || !anonKey) return undefined;
    try {
      const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/verify_by_code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ p_code: code }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return undefined;
      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row && row.code ? row : null;
    } catch { return undefined; }
  }

  // → certificate | null (no such code) | undefined (couldn't ask)
  async function get(code) {
    const hit = cache.get(code);
    if (hit && now() - hit.at < (hit.cert ? FOUND_MS : MISSING_MS)) return hit.cert;
    if (flights.has(code)) return flights.get(code);
    const flight = (async () => {
      let cert = api ? await api.verify(code) : undefined;
      if (cert === undefined) cert = await viaRpc(code);
      if (cert !== undefined) cache.set(code, { cert, at: now() });
      return cert;
    })().finally(() => flights.delete(code));
    flights.set(code, flight);
    return flight;
  }

  // A certificate this Mac just issued is known without asking.
  function remember(cert) { if (cert && cert.code) cache.set(cert.code, { cert, at: now() }); }

  return { get, remember };
}

module.exports = { createLookup };
