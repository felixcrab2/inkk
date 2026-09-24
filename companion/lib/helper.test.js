// Run: node --test lib/helper.test.js
//
// The client is tested against a stand-in helper written in Node (so every
// failure can be staged), then against the real build/inkk-helper when it has
// been built. Only made-up text is used; the real helper is asked about the app
// in front, and only the shape of its answer is checked.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, execFile } = require("node:child_process");
const { createHelper, helperPath } = require("./helper");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inkk-helper-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(20); }
  return false;
}

// ── a stand-in helper ───────────────────────────────────────────────────────

function makeFake({ serve = true, front = null } = {}) {
  const file = path.join(tmp(), "fake-helper");
  const frontDoc = front || { pid: 42, bundleId: "com.example.Writer", name: "Writer", title: "Essay — Edited", document: "file:///tmp/Essay.txt" };
  fs.writeFileSync(file, `#!${process.execPath}
"use strict";
const [, , cmd, ...args] = process.argv;
const SERVE = ${JSON.stringify(serve)};
const FRONT = ${JSON.stringify(frontDoc)};
if (cmd === "serve") {
  if (!SERVE) { process.stderr.write("unknown command serve\\n"); process.exit(1); }
  const rl = require("node:readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const { id, cmd, args } = JSON.parse(line);
    const reply = (o) => process.stdout.write(JSON.stringify({ id, ...o }) + "\\n");
    switch (cmd) {
      case "echo": return reply({ ok: true, result: { served: true, pid: process.pid, args } });
      case "slow": return setTimeout(() => reply({ ok: true, result: { slow: true } }), +args[0]);
      case "fail": return reply({ ok: false, error: "nope" });
      case "never": return;
      case "die": return process.exit(3);
      case "big": return reply({ ok: true, result: { text: "é".repeat(+args[0]) } });
      case "front-doc": return reply({ ok: true, result: FRONT });
      default: return reply({ ok: false, error: "unknown command " + cmd });
    }
  });
  rl.on("close", () => process.exit(0));
} else if (cmd === "die" || cmd === "fail") {
  process.exit(1);
} else if (cmd === "front-doc") {
  process.stdout.write(JSON.stringify(FRONT));
} else {
  process.stdout.write(JSON.stringify({ oneShot: true, cmd, args }));
}
`, { mode: 0o755 });
  return file;
}

function counting(bin, opts = {}) {
  const spawns = [];
  const h = createHelper({ bin, spawnImpl: (...a) => { const c = spawn(...a); spawns.push(c); return c; }, ...opts });
  return { h, spawns };
}

test("questions go to one running helper; answers find their question by id", async () => {
  const { h, spawns } = counting(makeFake());
  const order = [];
  const slow = h.run(["slow", "150"]).then((r) => { order.push("slow"); return r; });
  const fast = h.run(["echo", "a", 7]).then((r) => { order.push("echo"); return r; });
  const [s, e] = await Promise.all([slow, fast]);
  assert.deepStrictEqual(s, { slow: true });
  assert.strictEqual(e.served, true);
  assert.deepStrictEqual(e.args, ["a", "7"], "a raw argv array, stringified as before");
  assert.deepStrictEqual(order, ["echo", "slow"]);
  const again = await h.run(["echo"]);
  assert.strictEqual(again.pid, e.pid);
  assert.strictEqual(h.servePid(), e.pid);
  assert.strictEqual(spawns.length, 1);
  h.stop();
});

test("an error answer is null, like a failed one-shot run", async () => {
  const { h } = counting(makeFake());
  assert.strictEqual(await h.run(["fail"]), null);
  assert.strictEqual(await h.run([]), null);
  assert.strictEqual((await h.run(["echo"])).served, true);
  h.stop();
});

test("a question past its timeout is null and the helper keeps serving", async () => {
  const { h, spawns } = counting(makeFake());
  const t = Date.now();
  assert.strictEqual(await h.run(["never"], { timeout: 80 }), null);
  assert.ok(Date.now() - t < 1000);
  assert.strictEqual((await h.run(["echo"])).served, true);
  assert.strictEqual(spawns.length, 1);
  h.stop();
});

test("a helper that exits is replaced, and what it owed is asked again one-shot", async () => {
  const { h, spawns } = counting(makeFake());
  const first = (await h.run(["echo"])).pid;
  const owed = h.run(["slow", "2000"]);
  assert.strictEqual(await h.run(["die"]), null);
  assert.deepStrictEqual(await owed, { oneShot: true, cmd: "slow", args: ["2000"] });
  const next = await h.run(["echo"]);
  assert.strictEqual(next.served, true);
  assert.notStrictEqual(next.pid, first);
  assert.strictEqual(spawns.length, 2);
  assert.ok(await until(() => !alive(first)));
  h.stop();
});

test("a helper without serve: every question runs it once, and serve isn't retried for a while", async () => {
  const { h, spawns } = counting(makeFake({ serve: false }));
  assert.deepStrictEqual(await h.run(["echo", "a"]), { oneShot: true, cmd: "echo", args: ["a"] });
  assert.deepStrictEqual(await h.run(["echo", "b"]), { oneShot: true, cmd: "echo", args: ["b"] });
  assert.strictEqual(spawns.length, 1);
  assert.strictEqual(h.servePid(), null);
});

test("serve can be tried again after the back-off", async () => {
  let t = 0;
  const { h, spawns } = counting(makeFake({ serve: false }), { backoffMs: 1000, now: () => t });
  await h.run(["echo"]);
  t = 500; await h.run(["echo"]);
  assert.strictEqual(spawns.length, 1);
  t = 1500; await h.run(["echo"]);
  assert.strictEqual(spawns.length, 2);
});

test("a stuck helper is replaced once its question is long overdue", async () => {
  const { h, spawns } = counting(makeFake(), { stuckMs: () => 100 });
  const first = (await h.run(["echo"])).pid;
  assert.strictEqual(await h.run(["never"], { timeout: 50 }), null);
  assert.ok(await until(() => !alive(first)), "the stuck helper was killed");
  const next = await h.run(["echo"]);
  assert.strictEqual(next.served, true);
  assert.notStrictEqual(next.pid, first);
  assert.strictEqual(spawns.length, 2);
  h.stop();
});

test("a long answer arrives whole, however the pipe splits it", async () => {
  const { h } = counting(makeFake());
  const r = await h.run(["big", "3000000"]);
  assert.strictEqual(r.text.length, 3000000);
  assert.ok(/^é+$/.test(r.text));
  h.stop();
});

test("stop lets the helper finish and exit", async () => {
  const { h } = counting(makeFake());
  const pid = (await h.run(["echo"])).pid;
  h.stop();
  assert.ok(await until(() => !alive(pid)));
  assert.strictEqual((await h.run(["echo"])).served, true, "the next question starts a fresh one");
  h.stop();
});

test("no helper at all: everything answers null", async () => {
  const h = createHelper({ bin: null });
  assert.strictEqual(h.available(), false);
  assert.strictEqual(await h.run(["front-doc"]), null);
  assert.strictEqual(await h.frontDoc(), null);
  assert.deepStrictEqual(await h.ocr("/nowhere.png"), []);
  assert.deepStrictEqual(await h.pdfStamp("/nowhere.pdf", { code: "X", seal: "Y" }), { ok: false, error: "helper unavailable" });
});

test("frontDoc: the front app and its document, or null", async () => {
  const { h } = counting(makeFake());
  assert.deepStrictEqual(await h.frontDoc(),
    { pid: 42, bundleId: "com.example.Writer", name: "Writer", title: "Essay — Edited", document: "file:///tmp/Essay.txt" });
  h.stop();
  const none = counting(makeFake({ front: { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: "", document: "" } })).h;
  assert.deepStrictEqual(await none.frontDoc(), { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: "", document: "" },
    "no window, no title, no file: empty strings");
  none.stop();
  const busy = counting(makeFake({ front: { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: null, document: null } })).h;
  assert.deepStrictEqual(await busy.frontDoc(), { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: null, document: null },
    "a window that couldn't be asked stays unknown, not empty");
  busy.stop();
  const bare = counting(makeFake({ front: { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: 7 } })).h;
  assert.deepStrictEqual(await bare.frontDoc(), { pid: 9, bundleId: "com.example.Notes", name: "Notes", title: null, document: null },
    "anything that isn't text is unknown too");
  bare.stop();
  const refused = counting(makeFake({ front: { error: "not trusted" } })).h;
  assert.strictEqual(await refused.frontDoc(), null);
  refused.stop();
  const oneShot = counting(makeFake({ serve: false })).h;
  assert.strictEqual((await oneShot.frontDoc()).bundleId, "com.example.Writer", "one-shot answers the same");
});

// ── the real helper ─────────────────────────────────────────────────────────

// A binary that knows front-doc was built from this source, so it serves too.
const BIN = helperPath();
function isCurrentBuild() {
  if (!BIN) return false;
  try { JSON.parse(require("node:child_process").execFileSync(BIN, ["front-doc"], { timeout: 5000 })); return true; } catch { return false; }
}
const REAL = isCurrentBuild() ? false : "build/inkk-helper (with serve) not built";

function oneShot(args) {
  return new Promise((resolve) => execFile(BIN, args, { timeout: 15000 }, (err, out) => {
    if (err) return resolve(null);
    try { resolve(JSON.parse(String(out))); } catch { resolve(null); }
  }));
}

// A blank PNG, large enough that reading it takes Vision a moment.
function blankPng(file, w, h) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h, 255);
  for (let y = 0; y < h; y++) raw[y * row] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// The raw protocol, straight to the binary.
function rawServe() {
  const c = spawn(BIN, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
  const answers = [];
  const waiters = [];
  let buf = "";
  c.stdout.setEncoding("utf8");
  c.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const msg = { ...JSON.parse(buf.slice(0, i)), at: performance.now() };
      buf = buf.slice(i + 1);
      answers.push(msg);
      for (const w of waiters.splice(0)) w();
    }
  });
  const exited = new Promise((r) => c.on("exit", (code) => r(code)));
  const send = (o) => c.stdin.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
  const count = async (n, ms = 20000) => {
    const end = Date.now() + ms;
    while (answers.length < n && Date.now() < end) await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    return answers;
  };
  return { c, send, count, answers, exited };
}

test("real helper, serve: every request gets exactly one answer, then stdin closing ends it", { skip: REAL }, async () => {
  const dir = tmp();
  const txt = path.join(dir, "t.txt");
  fs.writeFileSync(txt, "A made-up line about herons crossing the estuary at dusk.");
  const s = rawServe();
  s.send({ id: 1, cmd: "front-doc", args: [] });
  s.send("not json");
  s.send({ id: "two", cmd: "no-such-command", args: [] });
  s.send({ id: 3, cmd: "pdf-text" });
  s.send({ id: 4, cmd: "pdf-text", args: [path.join(dir, "missing.pdf")] });
  s.send({ id: 5, cmd: "make-pdf", args: [txt, path.join(dir, "t.pdf")] });
  s.send({ id: 6, cmd: "pdf-text", args: [path.join(dir, "t.pdf")] });
  s.send({ id: 7, cmd: "ax-doc", args: [process.pid] });
  const answers = await s.count(8);
  s.c.stdin.end();
  assert.strictEqual(await s.exited, 0);
  const byId = new Map(answers.map((a) => [a.id, a]));
  assert.strictEqual(answers.length, 8);
  assert.strictEqual(byId.size, 8);
  assert.deepStrictEqual(byId.get(null), { id: null, ok: false, error: "bad request", at: byId.get(null).at });
  assert.strictEqual(byId.get("two").ok, false);
  assert.match(byId.get("two").error, /unknown command/);
  assert.strictEqual(byId.get(3).ok, false);
  assert.strictEqual(byId.get(4).ok, false);
  assert.strictEqual(byId.get(4).error, "unreadable pdf");
  assert.deepStrictEqual(byId.get(5).result, { ok: true });
  assert.match(byId.get(6).result.text, /herons crossing/);
  assert.strictEqual(byId.get(1).ok, true);
  const seven = byId.get(7).result;
  assert.ok(seven.error === "not trusted" || seven.error === "no window", "Node has no window of its own");
});

test("real helper: front-doc answers the shape the poll needs, in a few milliseconds", { skip: REAL }, async () => {
  const h = createHelper({ bin: BIN });
  const trusted = (await h.run(["ax-doc", String(process.pid)]))?.error !== "not trusted";
  const first = await h.frontDoc();
  assert.ok(first, "an app is in front");
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const d = await h.frontDoc();
    times.push(performance.now() - t);
    assert.deepStrictEqual(Object.keys(d).sort(), ["bundleId", "document", "name", "pid", "title"]);
    assert.ok(Number.isInteger(d.pid) && d.pid > 0);
    for (const k of ["bundleId", "name"]) assert.strictEqual(typeof d[k], "string");
    // A window too busy to answer gives null for both, never for one alone.
    assert.ok((typeof d.title === "string" && typeof d.document === "string") || (d.title === null && d.document === null),
      `title ${typeof d.title}, document ${typeof d.document}`);
    if (!trusted) { assert.strictEqual(d.title, ""); assert.strictEqual(d.document, ""); }
  }
  times.sort((a, b) => a - b);
  const median = times[10];
  assert.ok(median < 50, `median ${median.toFixed(1)} ms`);
  const same = await oneShot(["front-doc"]);
  assert.deepStrictEqual(Object.keys(same).sort(), ["bundleId", "document", "name", "pid", "title"], "one-shot answers the same shape");
  h.stop();
});

test("real helper: a picture being read doesn't hold up the front-doc poll", { skip: REAL }, async () => {
  const dir = tmp();
  const png = path.join(dir, "blank.png");
  blankPng(png, 3000, 3000);
  const s = rawServe();
  s.send({ id: "ocr", cmd: "ocr", args: [png] });
  s.send({ id: "front", cmd: "front-doc", args: [] });
  const answers = await s.count(2);
  s.c.stdin.end();
  await s.exited;
  const ocr = answers.find((a) => a.id === "ocr"), front = answers.find((a) => a.id === "front");
  assert.deepStrictEqual(ocr.result, [], "nothing to read in a blank picture");
  assert.strictEqual(front.ok, true);
  assert.ok(front.at < ocr.at, "front-doc answered while the picture was still being read");
});

test("real helper: the PDF commands answer the same through serve as one-shot", { skip: REAL }, async () => {
  const dir = tmp();
  const txt = path.join(dir, "t.txt");
  fs.writeFileSync(txt, "The lantern keeper counted seven herons.\n\nShe wrote each one down in the margin.");
  const pdf = path.join(dir, "t.pdf");
  const h = createHelper({ bin: BIN });
  assert.deepStrictEqual(await h.makePdf(txt, pdf), { ok: true });
  assert.deepStrictEqual(await h.run(["pdf-text", pdf]), await oneShot(["pdf-text", pdf]));
  assert.deepStrictEqual(await h.pdfReadMeta(pdf), await oneShot(["pdf-meta", pdf]));
  assert.match(await h.pdfText(pdf), /seven herons/);
  const code = "INKK-4B7N-R2XE-8KMT";
  assert.deepStrictEqual(await h.pdfStamp(pdf, { code, seal: `https://www.inkk.site/v/${code}` }), { ok: true });
  const meta = await h.pdfReadMeta(pdf);
  assert.ok(meta.keywords.includes(`inkk:${code}`));
  assert.deepStrictEqual(meta, await oneShot(["pdf-meta", pdf]));
  assert.strictEqual(await h.pdfText(path.join(dir, "missing.pdf")), null);
  assert.deepStrictEqual(await h.ocr(path.join(dir, "missing.png")), []);
  h.stop();
});

test("real helper: reading a window without the Accessibility grant says so, quickly", { skip: REAL }, async () => {
  const h = createHelper({ bin: BIN });
  for (const cmd of ["ax-window", "ax-focused", "ax-doc"]) {
    const t = performance.now();
    const r = await h.run([cmd, String(process.pid)], { timeout: 4000 });
    assert.ok(r && (r.error === "not trusted" || r.error === "no window" || typeof r.text === "string"), cmd);
    if (r.error === "not trusted") assert.ok(performance.now() - t < 500, `${cmd} answered at once`);
  }
  h.stop();
});
