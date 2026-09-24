// Run: node --test api/certify.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { createCertifyHandler, cleanSketch, cleanSignaturePng } from "./certify.mjs";

// A fake Supabase service client: just the calls the handler makes.
// rejectColumns: a database before the September migrations; rejectSignature:
// one that has the sketch and binding columns but not signature_png yet.
function fakeClient({ existing = null, docOwner = null, rejectColumns = false, rejectSignature = false } = {}) {
  const writes = [];
  const updates = [];
  const noSignatureColumn = rejectColumns || rejectSignature;
  const q = (table) => {
    const state = { table, cols: "", filters: {}, patch: null };
    const updateResult = () => {
      if (noSignatureColumn) return { data: null, error: { code: "42703", message: "column \"signature_png\" of relation \"verifications\" does not exist" } };
      updates.push({ patch: state.patch, filters: { ...state.filters } });
      const row = existing && existing.code === state.filters["eq:code"] ? existing : null;
      if (!row || row.user_id !== state.filters["eq:user_id"] || (state.filters["is:signature_png"] === null && row.signature_png)) return { data: [], error: null };
      Object.assign(row, state.patch);
      return { data: [{ code: row.code }], error: null };
    };
    const api = {
      select(cols) {
        if (state.patch) return Promise.resolve(updateResult());
        state.cols = cols; return api;
      },
      update(patch) { state.patch = patch; return api; },
      eq(k, v) { state.filters[`eq:${k}`] = v; return api; },
      is(k, v) { state.filters[`is:${k}`] = v; return api; },
      not(k, op, v) { state.filters[`not:${k}`] = `${op}.${v}`; return api; },
      order() { return api; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        if (table === "documents") return Promise.resolve({ data: docOwner ? { user_id: docOwner } : null, error: null });
        if (rejectColumns && state.cols.includes("text_sketch")) return Promise.resolve({ data: null, error: { code: "42703", message: "column text_sketch does not exist" } });
        if (state.cols === "signature_png") {
          const row = existing && existing.code === state.filters["eq:code"] && existing.user_id === state.filters["eq:user_id"] ? existing : null;
          return Promise.resolve({ data: row ? { signature_png: row.signature_png ?? null } : null, error: null });
        }
        return Promise.resolve({ data: existing, error: null });
      },
      upsert(row) {
        if (rejectColumns && ("text_sketch" in row || "binding" in row || "signature_png" in row)) return Promise.resolve({ error: { code: "PGRST204", message: "Could not find the 'binding' column" } });
        if (rejectSignature && "signature_png" in row) return Promise.resolve({ error: { code: "PGRST204", message: "Could not find the 'signature_png' column of 'verifications' in the schema cache" } });
        writes.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return api;
  };
  return { from: q, writes, updates };
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

// The first 33 bytes of a PNG, 262 x 54: the signature and the header chunk,
// which is all a picture is checked for.
function pngHead(width = 262, height = 54) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  return b;
}
const PNG64 = pngHead().toString("base64");
const CODE = "INKK-AAAA-BBBB-CCCC";
const HOSTED = "https://www.inkk.site/s/INKK-AAAA-BBBB-CCCC.png";

test("a signed name's picture is stored with its new certificate and linked", async () => {
  const svc = fakeClient();
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: CODE, contentHash: "h", sketch: SKETCH, source: "signature", signaturePng: PNG64, events });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.signatureUrl, HOSTED);
  assert.strictEqual(r.body.sketchStored, true);
  assert.strictEqual(svc.writes[0].signature_png, PNG64);
  // A data: URL is the same picture.
  const svc2 = fakeClient();
  const h2 = createCertifyHandler({ getClient: () => svc2, authenticate: async () => "u1" });
  const r2 = await call(h2, { docId: "d1", code: CODE, source: "signature", signaturePng: `data:image/png;base64,${PNG64}`, events });
  assert.strictEqual(r2.body.signatureUrl, HOSTED);
  assert.strictEqual(svc2.writes[0].signature_png, PNG64);
});

test("a picture is only taken from a signature, and only if it is one", async () => {
  const cases = [
    { source: "companion", signaturePng: PNG64 },
    { source: "signature", signaturePng: Buffer.from("GIF89a, not a signature, not a png at all").toString("base64") },
    { source: "signature", signaturePng: pngHead(1200, 900).toString("base64") },
    { source: "signature", signaturePng: Buffer.concat([pngHead(), Buffer.alloc(200 * 1024)]).toString("base64") },
    { source: "signature", signaturePng: 42 },
  ];
  for (const c of cases) {
    const svc = fakeClient();
    const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
    const r = await call(h, { docId: "d1", code: CODE, contentHash: "h", events, ...c });
    assert.strictEqual(r.body.ok, true);
    assert.ok(!("signatureUrl" in r.body));
    assert.ok(!("signature_png" in svc.writes[0]));
  }
});

test("a database without the picture column keeps the certificate and its sketch", async () => {
  const svc = fakeClient({ rejectSignature: true });
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: CODE, contentHash: "h", sketch: SKETCH, source: "signature", signaturePng: PNG64, events });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.sketchStored, true);
  assert.ok(!("signatureUrl" in r.body));
  assert.deepStrictEqual(svc.writes[0].text_sketch, SKETCH);
  assert.ok(!("signature_png" in svc.writes[0]));
  // And one before any September migration still gets its code.
  const old = fakeClient({ rejectColumns: true });
  const r2 = await call(createCertifyHandler({ getClient: () => old, authenticate: async () => "u1" }),
    { docId: "d1", code: CODE, contentHash: "h", sketch: SKETCH, source: "signature", signaturePng: PNG64, events });
  assert.strictEqual(r2.body.ok, true);
  assert.strictEqual(r2.body.sketchStored, false);
  assert.ok(!("signatureUrl" in r2.body));
});

test("your existing code gets its picture once; it is never replaced", async () => {
  const existing = { code: CODE, user_id: "u1", content_hash: "old", score_tier: "Strong", human_score: 70, verified: true, signature_png: null };
  const svc = fakeClient({ existing });
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: CODE, source: "signature", signaturePng: PNG64 });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.signatureUrl, HOSTED);
  assert.strictEqual(r.body.contentHash, "old");
  assert.strictEqual(existing.signature_png, PNG64);
  // Only where there is none, and only on the caller's own row.
  assert.deepStrictEqual(svc.updates[0].filters, { "eq:code": CODE, "eq:user_id": "u1", "is:signature_png": null });
  assert.strictEqual(svc.writes.length, 0);
  // The same picture again (a retry) still gets the link.
  const retry = await call(h, { docId: "d1", code: CODE, source: "signature", signaturePng: PNG64 });
  assert.strictEqual(retry.body.signatureUrl, HOSTED);
  assert.ok(!("signatureConflict" in retry.body));
  assert.strictEqual(existing.signature_png, PNG64);
});

test("a different picture for a code that has one gets no link, and hears why", async () => {
  // The same code signed again after the name or its face changed: the link
  // would show the old picture, so it is not given.
  const existing = { code: CODE, user_id: "u1", content_hash: "h", score_tier: "Strong", human_score: 70, verified: true, signature_png: PNG64 };
  const svc = fakeClient({ existing });
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const other = pngHead(300, 60).toString("base64");
  const r = await call(h, { docId: "d1", code: CODE, contentHash: "h", source: "signature", signaturePng: other });
  assert.strictEqual(r.body.ok, true);
  assert.ok(!("signatureUrl" in r.body));
  assert.strictEqual(r.body.signatureConflict, true);
  assert.strictEqual(existing.signature_png, PNG64);
  // The picture it already has, sent as a data: URL, is still its picture.
  const same = await call(h, { docId: "d1", code: CODE, contentHash: "h", source: "signature", signaturePng: `data:image/png;base64,${PNG64}` });
  assert.strictEqual(same.body.signatureUrl, HOSTED);
  assert.ok(!("signatureConflict" in same.body));
});

test("a code about to be abandoned for a stale fingerprint gets no picture", async () => {
  const existing = { code: CODE, user_id: "u1", content_hash: "old", score_tier: "Strong", human_score: 70, verified: true, signature_png: null };
  const svc = fakeClient({ existing });
  const h = createCertifyHandler({ getClient: () => svc, authenticate: async () => "u1" });
  const r = await call(h, { docId: "d1", code: CODE, contentHash: "new", source: "signature", signaturePng: PNG64 });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.contentHash, "old");
  assert.ok(!("signatureUrl" in r.body));
  assert.ok(!("signatureConflict" in r.body));
  assert.strictEqual(svc.updates.length, 0);
  assert.strictEqual(existing.signature_png, null);
  // The same fingerprint keeps the code, and the code takes the picture.
  const kept = await call(h, { docId: "d1", code: CODE, contentHash: "old", source: "signature", signaturePng: PNG64 });
  assert.strictEqual(kept.body.signatureUrl, HOSTED);
  assert.strictEqual(existing.signature_png, PNG64);
});

test("no picture on someone else's code, nor where the column is missing", async () => {
  const theirs = fakeClient({ existing: { code: CODE, user_id: "u2", content_hash: "old", signature_png: null } });
  const r = await call(createCertifyHandler({ getClient: () => theirs, authenticate: async () => "u1" }),
    { docId: "d1", code: CODE, source: "signature", signaturePng: PNG64 });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(theirs.updates.length, 0);
  const before = fakeClient({ existing: { code: CODE, user_id: "u1", content_hash: "old" }, rejectSignature: true });
  const r2 = await call(createCertifyHandler({ getClient: () => before, authenticate: async () => "u1" }),
    { docId: "d1", code: CODE, source: "signature", signaturePng: PNG64 });
  assert.strictEqual(r2.body.ok, true);
  assert.ok(!("signatureUrl" in r2.body));
});

test("pictures are cleaned, never rejected", () => {
  assert.strictEqual(cleanSignaturePng(PNG64), PNG64);
  assert.strictEqual(cleanSignaturePng(`data:image/png;base64,${PNG64}`), PNG64);
  assert.strictEqual(cleanSignaturePng("data:image/gif;base64,R0lGODlh"), null);
  assert.strictEqual(cleanSignaturePng(null), null);
});
