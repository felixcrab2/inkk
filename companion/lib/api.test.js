// Run: node --test lib/api.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createApi, canonicalBase } = require("./api");

function res(status, { headers = {}, json } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => json };
}

test("the apex is rewritten to www", () => {
  assert.strictEqual(canonicalBase("https://inkk.site"), "https://www.inkk.site");
  assert.strictEqual(canonicalBase("https://inkk.site/"), "https://www.inkk.site");
  assert.strictEqual(canonicalBase("https://www.inkk.site"), "https://www.inkk.site");
  assert.strictEqual(canonicalBase("http://localhost:3000"), "http://localhost:3000");
});

test("certify keeps the token across an inkk.site redirect (the sign-in loop)", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, method: init.method, body: init.body, redirect: init.redirect });
    if (url.startsWith("http://localhost/")) return res(308, { headers: { location: "https://www.inkk.site/api/certify" } });
    return res(200, { headers: { "content-type": "application/json" }, json: { ok: true, code: "INKK-AAAA-BBBB-CCCC", tier: "Strong", score: 70, verified: true } });
  };
  const api = createApi({ base: "http://localhost", fetch });
  const out = await api.certify({ docId: "d", code: "INKK-AAAA-BBBB-CCCC" }, "tok");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].url, "https://www.inkk.site/api/certify");
  assert.strictEqual(calls[1].auth, "Bearer tok", "token re-sent to www");
  assert.strictEqual(calls[1].method, "POST");
  assert.strictEqual(calls[1].body, calls[0].body);
  assert.strictEqual(calls[0].redirect, "manual");
});

test("a redirect off inkk.site is refused and the token never travels there", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(url); return res(302, { headers: { location: "https://evil.example/steal" } }); };
  const out = await createApi({ fetch }).certify({}, "tok");
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(seen, ["https://www.inkk.site/api/certify"]);
});

test("401 means sign in; no token means sign in without a request", async () => {
  let n = 0;
  const fetch = async () => { n++; return res(401, { json: { ok: false, error: "Sign in required" } }); };
  const api = createApi({ fetch });
  assert.deepStrictEqual(await api.certify({}, null), { ok: false, error: "Sign in required", needsAuth: true });
  assert.strictEqual(n, 0);
  assert.strictEqual((await api.certify({}, "tok")).needsAuth, true);
});

test("verify: found, not found, route missing, offline", async () => {
  const cert = { code: "INKK-AAAA-BBBB-CCCC", verified: true };
  const json = (status, body) => async () => res(status, { headers: { "content-type": "application/json" }, json: body });
  assert.deepStrictEqual(await createApi({ fetch: json(200, { ok: true, cert }) }).verify("INKK-AAAA-BBBB-CCCC"), cert);
  assert.strictEqual(await createApi({ fetch: json(404, { ok: false, error: "not_found" }) }).verify("x"), null);
  assert.strictEqual(await createApi({ fetch: async () => res(404, { headers: { "content-type": "text/html" } }) }).verify("x"), undefined);
  assert.strictEqual(await createApi({ fetch: async () => { throw new TypeError("fetch failed"); } }).verify("x"), undefined);
});
