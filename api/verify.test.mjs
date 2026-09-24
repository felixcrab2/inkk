// Run: node --test api/verify.test.mjs
// The route against a fake Supabase client: no network, no env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerifyHandler } from "./verify.mjs";

const ROW = {
  code: "INKK-7F3A-9K2D-XQ4M", title: "Morning", author_name: "Ada", author_username: "ada",
  content_hash: "ab".repeat(32), word_count: 38, human_score: 71, score_tier: "Strong", verified: true,
  issued_at: "2026-09-24T10:00:00Z", user_id: "11111111-2222-3333-4444-555555555555", doc_id: "d1",
  text_sketch: ["0123456789", "abcdefabcd", "NOT-HEX!!!"], binding: "text",
};

// A PostgREST-shaped client: from().select().eq().maybeSingle(). `hasNewColumns`
// false makes any select naming text_sketch/binding fail the way Postgres does.
function fakeClient({ rows = [ROW], hasNewColumns = true, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, cols: "", filters: {} };
      const b = {
        select(cols) { q.cols = cols; return b; },
        eq(k, v) { q.filters[k] = v; return b; },
        async maybeSingle() {
          calls.push({ ...q });
          if (fail) return { data: null, error: fail };
          if (!hasNewColumns && /text_sketch|binding/.test(q.cols)) {
            return { data: null, error: { code: "42703", message: "column verifications.text_sketch does not exist" } };
          }
          const row = rows.find((r) => r.code === q.filters.code);
          if (!row) return { data: null, error: null };
          const picked = {};
          for (const c of q.cols.split(",").map((s) => s.trim())) picked[c] = row[c];
          return { data: picked, error: null };
        },
      };
      return b;
    },
  };
}

function call(handler, { method = "GET", code, ip = "1.2.3.4", url } = {}) {
  const req = {
    method,
    url: url || `/api/verify${code != null ? `?code=${encodeURIComponent(code)}` : ""}`,
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  };
  if (!url && code != null) req.query = { code };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(n) { this.statusCode = n; return this; },
      json(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
    };
    handler(req, res);
  });
}

test("a code that can't be read is a 400", async () => {
  const h = createVerifyHandler({ getClient: () => fakeClient() });
  for (const code of ["", "INKK-123", "hello", undefined]) {
    const r = await call(h, { code });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: "bad_code" });
  }
});

test("only GET is served", async () => {
  const h = createVerifyHandler({ getClient: () => fakeClient() });
  const r = await call(h, { method: "POST", code: ROW.code });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "GET");
});

test("an unknown code is a 404 that is not cached", async () => {
  const h = createVerifyHandler({ getClient: () => fakeClient() });
  const r = await call(h, { code: "INKK-AAAA-BBBB-CCCC" });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { ok: false, error: "not_found" });
  assert.equal(r.headers["cache-control"], "no-store");
});

test("a found code returns the public fields only, never user_id", async () => {
  const client = fakeClient();
  const h = createVerifyHandler({ getClient: () => client });
  // Lower case, spaces and Crockford look-alikes normalise like the website's parser.
  const r = await call(h, { code: "inkk 7f3a 9k2d xq4m" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=60");
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(r.body.cert).sort(), [
    "author_name", "author_username", "binding", "code", "content_hash", "human_score",
    "issued_at", "score_tier", "text_sketch", "title", "verified", "word_count",
  ]);
  assert.equal(r.body.cert.code, ROW.code);
  assert.deepEqual(r.body.cert.text_sketch, ["0123456789", "abcdefabcd"]);
  assert.equal(r.body.cert.binding, "text");
  assert.ok(!JSON.stringify(r.body).includes(ROW.user_id));
  // It never asked the database for user_id either.
  assert.ok(client.calls.every((c) => !/user_id|doc_id|\*/.test(c.cols)));
  // Also reads the code from the raw URL when Vercel's query helper is absent.
  const r2 = await call(h, { url: `/api/verify?code=${ROW.code}` });
  assert.equal(r2.status, 200);
});

test("before the migration the lookup falls back and answers with nulls", async () => {
  const client = fakeClient({ hasNewColumns: false });
  const h = createVerifyHandler({ getClient: () => client });
  const r = await call(h, { code: ROW.code });
  assert.equal(r.status, 200);
  assert.equal(r.body.cert.text_sketch, null);
  assert.equal(r.body.cert.binding, null);
  assert.equal(r.body.cert.verified, true);
  assert.equal(client.calls.length, 2);
  // The fallback is remembered: the next lookup goes straight to the old columns.
  await call(h, { code: ROW.code, ip: "5.6.7.8" });
  assert.equal(client.calls.length, 3);
});

test("a database failure is a 502, not a 404", async () => {
  const h = createVerifyHandler({ getClient: () => fakeClient({ fail: { code: "08006", message: "connection failure" } }) });
  const r = await call(h, { code: ROW.code });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { ok: false, error: "lookup_failed" });
});

test("missing configuration is a 503", async () => {
  const h = createVerifyHandler({ getClient: () => null });
  const r = await call(h, { code: ROW.code });
  assert.equal(r.status, 503);
});

test("60 lookups a minute per address, then 429 until the window passes", async () => {
  let t = 1_000_000;
  const h = createVerifyHandler({ getClient: () => fakeClient(), now: () => t });
  for (let i = 0; i < 60; i++) assert.equal((await call(h, { code: ROW.code })).status, 200);
  const blocked = await call(h, { code: ROW.code });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "rate_limited");
  assert.equal(blocked.headers["retry-after"], "60");
  // Another address is unaffected.
  assert.equal((await call(h, { code: ROW.code, ip: "9.9.9.9" })).status, 200);
  t += 60_000;
  assert.equal((await call(h, { code: ROW.code })).status, 200);
});
