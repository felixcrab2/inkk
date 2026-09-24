// Run: node --test api/sig.test.mjs
// The route against a fake Supabase client: no network, no env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createSigHandler, signaturePngBytes, signatureUrl, SIGNATURE_MAX_BYTES } from "./sig.mjs";

// A real PNG, white, of the given size (and padded with an ancillary chunk to
// reach a given length when asked).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makePng(width, height, { pad = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0;     // 8-bit greyscale
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(pad ? [chunk("tEXt", Buffer.alloc(pad, 0x61))] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CODE = "INKK-7F3A-9K2D-XQ4M";
const PNG = makePng(262, 54);

function fakeClient({ rows = { [CODE]: { signature_png: PNG.toString("base64") } }, hasColumn = true, fail = null } = {}) {
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
          if (!hasColumn) return { data: null, error: { code: "42703", message: "column verifications.signature_png does not exist" } };
          const row = rows[q.filters.code];
          return { data: row ? { signature_png: row.signature_png ?? null } : null, error: null };
        },
      };
      return b;
    },
  };
}

function call(handler, { method = "GET", code, url } = {}) {
  const req = { method, url: url || `/api/sig?code=${encodeURIComponent(code ?? "")}`, headers: {} };
  if (!url && code != null) req.query = { code };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(n) { this.statusCode = n; return this; },
      json(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
      end(buf) { resolve({ status: this.statusCode, headers: this.headers, bytes: buf }); },
    };
    handler(req, res);
  });
}

test("a stored picture is served as a PNG, public and cached for good", async () => {
  const client = fakeClient();
  const h = createSigHandler({ getClient: () => client });
  const r = await call(h, { code: CODE });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["content-length"], String(PNG.length));
  assert.ok(Buffer.isBuffer(r.bytes) && r.bytes.equals(PNG));
  // One column of one row, by the exact code.
  assert.deepEqual(client.calls, [{ table: "verifications", cols: "signature_png", filters: { code: CODE } }]);
});

test("the public path's code arrives however it is written", async () => {
  const h = createSigHandler({ getClient: () => fakeClient() });
  // As the rewrite passes it, with the extension should it come through, and
  // with typing slips the website's parser forgives.
  assert.equal((await call(h, { code: `${CODE}.png` })).status, 200);
  assert.equal((await call(h, { code: "inkk-7f3a-9k2d-xq4m" })).status, 200);
  // Without Vercel's query helper.
  assert.equal((await call(h, { url: `/api/sig?code=${CODE}` })).status, 200);
});

test("HEAD answers the headers without the bytes", async () => {
  const h = createSigHandler({ getClient: () => fakeClient() });
  const r = await call(h, { method: "HEAD", code: CODE });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.bytes, undefined);
});

test("no picture is a 404 that is not cached", async () => {
  const rows = { [CODE]: { signature_png: null }, "INKK-0000-0000-0000": { signature_png: Buffer.from("not a png").toString("base64") } };
  const h = createSigHandler({ getClient: () => fakeClient({ rows }) });
  for (const code of [CODE, "INKK-AAAA-BBBB-CCCC", "INKK-0000-0000-0000"]) {
    const r = await call(h, { code });
    assert.equal(r.status, 404, code);
    assert.deepEqual(r.body, { ok: false, error: "not_found" });
    assert.equal(r.headers["cache-control"], "no-store");
  }
  // Before the migration there is no column, so no picture: 404, not an error.
  const before = createSigHandler({ getClient: () => fakeClient({ hasColumn: false }) });
  assert.equal((await call(before, { code: CODE })).status, 404);
});

test("bad codes, other methods, missing configuration and database failures", async () => {
  const h = createSigHandler({ getClient: () => fakeClient() });
  for (const code of ["", "INKK-123", "hello", undefined]) assert.equal((await call(h, { code })).status, 400);
  const post = await call(h, { method: "POST", code: CODE });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal((await call(createSigHandler({ getClient: () => null }), { code: CODE })).status, 503);
  const down = createSigHandler({ getClient: () => fakeClient({ fail: { code: "08006", message: "connection failure" } }) });
  const r = await call(down, { code: CODE });
  assert.equal(r.status, 502);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("only a PNG of a signature's size counts as a signature", () => {
  assert.ok(signaturePngBytes(PNG.toString("base64")).equals(PNG));
  assert.equal(signaturePngBytes(null), null);
  assert.equal(signaturePngBytes(""), null);
  assert.equal(signaturePngBytes("not base64!"), null);
  assert.equal(signaturePngBytes(Buffer.from("GIF89a and then some bytes to pass the length").toString("base64")), null);
  // A PNG whose first chunk is not its header is not a PNG.
  const noHeader = Buffer.from(PNG);
  noHeader.write("tEXt", 12, "latin1");
  assert.equal(signaturePngBytes(noHeader.toString("base64")), null);
  // A photograph's shape, or no size at all.
  assert.equal(signaturePngBytes(makePng(800, 600).toString("base64")), null);
  assert.equal(signaturePngBytes(makePng(5000, 40).toString("base64")), null);
  const empty = Buffer.from(PNG);
  empty.writeUInt32BE(0, 16);
  assert.equal(signaturePngBytes(empty.toString("base64")), null);
  // 200 KB, and not a byte more.
  const atLimit = makePng(10, 10, { pad: SIGNATURE_MAX_BYTES - makePng(10, 10).length - 12 });
  assert.equal(atLimit.length, SIGNATURE_MAX_BYTES);
  assert.ok(signaturePngBytes(atLimit.toString("base64")));
  const over = makePng(10, 10, { pad: SIGNATURE_MAX_BYTES - makePng(10, 10).length - 11 });
  assert.equal(signaturePngBytes(over.toString("base64")), null);
});

test("the public address of a signature", () => {
  assert.equal(signatureUrl(CODE), "https://www.inkk.site/s/INKK-7F3A-9K2D-XQ4M.png");
});
