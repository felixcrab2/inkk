// Run: node --test api/certify.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { createCertifyHandler, cleanSketch } from "./certify.mjs";

// A fake Supabase service client: just the calls the handler makes.
function fakeClient({ existing = null, docOwner = null, rejectColumns = false } = {}) {
  const writes = [];
  const q = (table) => {
    const state = { table, cols: "" };
    const api = {
      select(cols) { state.cols = cols; return api; },
      eq() { return api; },
      order() { return api; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        if (table === "documents") return Promise.resolve({ data: docOwner ? { user_id: docOwner } : null, error: null });
        if (rejectColumns && state.cols.includes("text_sketch")) return Promise.resolve({ data: null, error: { code: "42703", message: "column text_sketch does not exist" } });
        return Promise.resolve({ data: existing, error: null });
      },
      upsert(row) {
        if (rejectColumns && ("text_sketch" in row || "binding" in row)) return Promise.resolve({ error: { code: "PGRST204", message: "Could not find the 'binding' column" } });
        writes.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };
  return { from: q, writes };
}

function call(handler, body, { auth = true } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    handler({ method: "POST", headers: auth ? { authorization: "Bearer t" } : {}, body }, res);
  });
}

const SKETCH = ["0123456789", "abcdefabcd"];
const events = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, doc_id: "d1", t: 1000 + i * 180, kind: i % 2 ? "keyup" : "keydown", key_class: "letter" }));

test("no sign-in, no certificate", async () => {
  const h = createCertifyHandler({ getClient: () => fakeClient(), authenticate: async () => null });
  const r = await call(h, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC" }, { auth: false });
  assert.strictEqual(r.status, 401);
});

test("a new code is scored and stored with its sketch and binding", async () => {
  const svc = fakeClient();
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC", contentHash: "h", wordCount: 10, sketch: [...SKETCH, "bad", SKETCH[0]], source: "companion", binding: "text", events });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.sketchStored, true);
  assert.deepStrictEqual(svc.writes[0].text_sketch, SKETCH);
  assert.strictEqual(svc.writes[0].binding, "text");
  assert.strictEqual(svc.writes[0].user_id, "u1");
  assert.strictEqual(typeof svc.writes[0].human_score, "number");
});

test("a database without the new columns still gets the certificate", async () => {
  const svc = fakeClient({ rejectColumns: true });
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC", contentHash: "h", sketch: SKETCH, events });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.sketchStored, false);
  assert.ok(!("text_sketch" in svc.writes[0]));
});

test("someone else's code is refused; your own keeps its original fingerprint", async () => {
  const theirs = createCertifyHandler({ getClient: () => fakeClient({ existing: { user_id: "u2", content_hash: "old" } }), authenticate: async () => "u1" });
  assert.strictEqual((await call(theirs, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC", contentHash: "new" })).status, 403);
  const mine = createCertifyHandler({ getClient: () => fakeClient({ existing: { user_id: "u1", content_hash: "old", score_tier: "Strong", human_score: 70, verified: true } }), authenticate: async () => "u1" });
  const r = await call(mine, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC", contentHash: "new" });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.contentHash, "old");
  assert.strictEqual(r.body.verified, true);
});

test("without the service key the route says so instead of failing silently", async () => {
  const h = createCertifyHandler({ getClient: () => null, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: "INKK-AAAA-BBBB-CCCC" });
  assert.deepStrictEqual(r.body, { ok: false, error: "Certification not configured" });
});

test("sketches are cleaned, never rejected", () => {
  assert.strictEqual(cleanSketch("x"), null);
  assert.deepStrictEqual(cleanSketch(["0123456789", "0123456789", "XYZ"]), ["0123456789"]);
});
