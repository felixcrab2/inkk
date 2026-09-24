/**
 * @jest-environment node
 */
// The website's Word export: a real .docx that macOS can open, carrying the
// code where the desktop companion and the Certify page look for it.
import { docxOf } from "./docx";
import { readZip } from "./zip";
import { withTextChunks, readTextChunks } from "./png";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Node has the web's Blob, Response and TextEncoder; the export also needs a
// DOM to read the editor's HTML.
const { JSDOM } = require("jsdom");
for (const k of ["Blob", "Response", "TextEncoder", "TextDecoder", "atob"]) if (!global[k]) global[k] = require("buffer")[k] || require("util")[k] || globalThis[k];
global.document = new JSDOM("").window.document;

const CODE = "INKK-4B7N-R2XE-8KMT";
const SEAL = `https://www.inkk.site/v/${CODE}`;

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test("a note becomes a Word document with its code in the custom properties", async () => {
  const blob = docxOf({ title: "On slow mornings", html: "<div>The kettle takes its <b>time</b> &amp; so do I.</div><div><br></div><div>Then <i>tea</i>.</div>", author: "Ada", code: CODE, seal: SEAL });
  const bytes = await bytesOf(blob);
  const z = readZip(bytes);
  const read = async (n) => new TextDecoder().decode(await z.get(n)());
  expect(await read("docProps/custom.xml")).toContain(`<vt:lpwstr>${CODE}</vt:lpwstr>`);
  expect(await read("docProps/core.xml")).toContain(`inkk:${CODE}`);
  const doc = await read("word/document.xml");
  expect(doc).toContain("<w:b/>");
  expect(doc).toContain("&amp; so do I.");

  if (process.platform === "darwin") {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inkk-docx-")), "note.docx");
    fs.writeFileSync(file, Buffer.from(bytes));
    const text = execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", file]).toString();
    expect(text).toContain("On slow mornings");
    expect(text).toContain("The kettle takes its time & so do I.");
    const docmeta = require("../../companion/lib/docmeta");
    expect(docmeta.docxStamp(fs.readFileSync(file))).toBe(CODE);
  }
});

test("an exported page image carries the code in its text chunks", async () => {
  // The smallest valid PNG: 1×1, one IDAT.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const out = await withTextChunks(new Blob([png]), { "inkk-code": CODE, "inkk-seal": SEAL });
  const t = readTextChunks(await bytesOf(out));
  expect(t["inkk-code"]).toBe(CODE);
  expect(t["inkk-seal"]).toBe(SEAL);
});
