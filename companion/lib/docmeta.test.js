// Run: node --test lib/docmeta.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const docmeta = require("./docmeta");
const zip = require("./zip");
const helper = require("./helper");

const CODE = "INKK-4B7N-R2XE-8KMT";
const TEXT = "The river ran low that summer, and the stones we had never seen came up out of the water like the backs of animals.\n\nWe walked on them to the far bank every evening, & nobody said a word about it.";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "inkk-doc-")); }

// A real Word document, written by macOS's own converter.
function makeDocx(dir) {
  const txt = path.join(dir, "essay.txt");
  fs.writeFileSync(txt, TEXT);
  execFileSync("/usr/bin/textutil", ["-convert", "docx", txt, "-output", path.join(dir, "essay.docx")]);
  return path.join(dir, "essay.docx");
}

test("Word: text comes out, the code goes in and reads back, nothing else changes", async () => {
  const dir = tmp();
  const file = makeDocx(dir);
  assert.strictEqual(docmeta.kindOf(file), "docx");
  const text = await docmeta.extractText(file);
  assert.match(text, /backs of animals\./);
  assert.match(text, /& nobody said/);
  assert.strictEqual(await docmeta.readStamp(file), null);

  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  const r = await docmeta.writeStamp(file, { code: CODE }, { backupsDir: path.join(dir, "backups") });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.kinds.sort(), ["docx", "xattr"]);
  assert.strictEqual(Math.round(fs.statSync(file).mtimeMs), Math.round(mtime), "modification time kept");
  assert.strictEqual(fs.readdirSync(path.join(dir, "backups")).length, 1);

  const s = await docmeta.readStamp(file);
  assert.strictEqual(s.code, CODE);
  execFileSync("/usr/bin/xattr", ["-d", "site.inkk.code", file]);
  assert.deepStrictEqual(await docmeta.readStamp(file), { code: CODE, seal: `https://www.inkk.site/v/${CODE}`, via: "docx" });

  // Every original part survives untouched; the file still converts.
  const a = zip.readZip(before), b = zip.readZip(fs.readFileSync(file));
  const names = new Set(b.entries.map((e) => e.name));
  for (const e of a.entries) assert.ok(names.has(e.name), e.name);
  execFileSync("unzip", ["-tq", file]);
  const round = execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", file]).toString();
  assert.match(round, /far bank every evening/);
  assert.strictEqual(await docmeta.extractText(file), text);
});

test("Word: stamping twice replaces the code rather than adding another", async () => {
  const dir = tmp();
  const file = makeDocx(dir);
  await docmeta.writeStamp(file, { code: CODE });
  await docmeta.writeStamp(file, { code: "INKK-0000-1111-2222" });
  const custom = zip.readZip(fs.readFileSync(file)).entries.find((e) => e.name === "docProps/custom.xml");
  const xml = zip.entryData(custom).toString();
  assert.strictEqual((xml.match(/name="inkk-code"/g) || []).length, 1);
  assert.strictEqual(docmeta.docxStamp(fs.readFileSync(file)), "INKK-0000-1111-2222");
});

test("a broken Word file is left exactly as it was", async () => {
  const dir = tmp();
  const file = path.join(dir, "broken.docx");
  fs.writeFileSync(file, "not a zip at all");
  const r = await docmeta.writeStamp(file, { code: CODE });
  assert.strictEqual(fs.readFileSync(file, "utf8"), "not a zip at all");
  assert.ok(!r.kinds.includes("docx"));
});

test("PDF: keywords carry the code", { skip: !helper.available() && "inkk-helper not built" }, async () => {
  const dir = tmp();
  const txt = path.join(dir, "t.txt");
  fs.writeFileSync(txt, TEXT);
  const pdf = path.join(dir, "essay.pdf");
  await helper.makePdf(txt, pdf);
  assert.match(await docmeta.extractText(pdf, { helper }), /backs of\s+animals/);
  const r = await docmeta.writeStamp(pdf, { code: CODE }, { helper });
  assert.ok(r.ok, r.error);
  execFileSync("/usr/bin/xattr", ["-c", pdf]);
  assert.deepStrictEqual(await docmeta.readStamp(pdf, { helper }), { code: CODE, seal: `https://www.inkk.site/v/${CODE}`, via: "pdf" });
});

test("plain text and RTF: text is read, the code rides in extended attributes", async () => {
  const dir = tmp();
  const md = path.join(dir, "note.md");
  fs.writeFileSync(md, TEXT);
  assert.strictEqual(await docmeta.extractText(md), TEXT);
  const r = await docmeta.writeStamp(md, { code: CODE });
  assert.deepStrictEqual(r.kinds, ["xattr"]);
  assert.strictEqual((await docmeta.readStamp(md)).via, "xattr");
  const rtf = path.join(dir, "note.rtf");
  execFileSync("/usr/bin/textutil", ["-convert", "rtf", md, "-output", rtf]);
  assert.match(await docmeta.extractText(rtf), /far bank/);
});

test("PNG: the website's page images carry the code in text chunks", async () => {
  const zlib = require("node:zlib");
  const { crc32 } = require("./zip");
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`inkk-code\0${CODE}`, "latin1")),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const file = path.join(tmp(), "page.png");
  fs.writeFileSync(file, png);
  assert.deepStrictEqual(await docmeta.readStamp(file), { code: CODE, seal: `https://www.inkk.site/v/${CODE}`, via: "png" });
});
