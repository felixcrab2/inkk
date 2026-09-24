// Run: node --test lib/lookup.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createLookup } = require("./lookup");

test("asks /api/verify once, caches, and falls back to the database function", async () => {
  let t = 0, apiCalls = 0, rpcCalls = 0;
  const api = { verify: async (code) => { apiCalls++; return code === "A" ? { code: "A" } : code === "B" ? null : undefined; } };
  const fetch = async () => { rpcCalls++; return { ok: true, json: async () => [{ code: "C" }] }; };
  const l = createLookup({ api, supabaseUrl: "https://x", anonKey: "k", fetch, now: () => t });
  assert.deepStrictEqual(await l.get("A"), { code: "A" });
  assert.deepStrictEqual(await l.get("A"), { code: "A" });
  assert.strictEqual(apiCalls, 1);
  assert.strictEqual(await l.get("B"), null);
  t += 61 * 1000;
  assert.strictEqual(await l.get("B"), null);
  assert.strictEqual(apiCalls, 3, "a missing code is asked about again after a minute");
  assert.deepStrictEqual(await l.get("C"), { code: "C" });
  assert.strictEqual(rpcCalls, 1);
});

test("concurrent asks share one request", async () => {
  let calls = 0;
  const api = { verify: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { code: "A" }; } };
  const l = createLookup({ api });
  await Promise.all([l.get("A"), l.get("A"), l.get("A")]);
  assert.strictEqual(calls, 1);
});
