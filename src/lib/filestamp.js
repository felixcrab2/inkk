// What a file says about itself: its inkk code (from its metadata, or a seal in
// its words) and its text, so the Certify page can check a document a reader
// drops on it. Everything happens in the browser; nothing is uploaded.

import { readZip } from "./zip";
import { readTextChunks } from "./png";
import { parseVerifyCode } from "../verify/code";

const CODE_RE = /INKK[-\s]?[0-9A-Za-z]{4}[-\s]?[0-9A-Za-z]{4}[-\s]?[0-9A-Za-z]{4}/i;
const firstCode = (s) => { const m = CODE_RE.exec(String(s || "")); return m ? parseVerifyCode(m[0]) : null; };

const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

function docxText(xml) {
  const body = xml.replace(/<w:tab\/>/g, "\t").replace(/<w:(br|cr)\b[^>]*\/>/g, "\n");
  const paras = [];
  for (const p of body.split(/<\/w:p>/)) {
    let t = "";
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|(\t)|(\n)/g;
    let m;
    while ((m = re.exec(p))) t += m[1] != null ? decodeXml(m[1]) : (m[2] || m[3]);
    if (t.trim()) paras.push(t);
  }
  return paras.join("\n");
}

// → { kind, code, text } (code or text may be null)
export async function readFile(file) {
  const name = (file.name || "").toLowerCase();
  const buf = await file.arrayBuffer();
  const dec = new TextDecoder();
  if (name.endsWith(".docx")) {
    const z = readZip(buf);
    const read = async (n) => (z.has(n) ? dec.decode(await z.get(n)()) : "");
    const custom = await read("docProps/custom.xml");
    const m = /name="inkk-code"[^>]*>\s*<vt:lpwstr>([^<]*)</.exec(custom);
    const text = docxText(await read("word/document.xml"));
    return { kind: "Word document", code: (m && parseVerifyCode(decodeXml(m[1]))) || firstCode(await read("docProps/core.xml")) || firstCode(text), text };
  }
  if (name.endsWith(".pdf")) {
    // The Info dictionary and XMP are plain text inside the file.
    const raw = new TextDecoder("latin1").decode(new Uint8Array(buf));
    const kw = /inkk:\s*(INKK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/i.exec(raw);
    return { kind: "PDF", code: kw ? parseVerifyCode(kw[1]) : firstCode(raw), text: null };
  }
  if (name.endsWith(".png")) {
    const t = readTextChunks(new Uint8Array(buf));
    return { kind: "image", code: parseVerifyCode(t["inkk-code"]) || firstCode(t.Keywords), text: null };
  }
  const text = dec.decode(buf);
  const plain = name.endsWith(".html") || name.endsWith(".htm") ? text.replace(/<[^>]*>/g, " ") : text;
  return { kind: "text", code: firstCode(plain), text: plain };
}
