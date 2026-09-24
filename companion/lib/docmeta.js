// inkk companion — codes inside documents.
//
// When a writer saves or exports a piece, its inkk code goes into the file
// itself, where it travels with the file: attached to an email, dropped in a
// shared folder, uploaded. When a reader opens a file, the code comes back out
// and the file's text is checked against the certificate.
//
// Where the code is kept (every place that applies):
//   any file   extended attributes site.inkk.code and site.inkk.seal (these
//              stay on this Mac and survive AirDrop, not email)
//   .docx      custom document properties inkk-code and inkk-seal, which Word,
//              Pages and Google Docs keep when they save the file again
//   .pdf       the Keywords field: "inkk:<CODE>" and the seal link
//   .png       text chunks inkk-code and inkk-seal (the website's page images)
// Reading tries them in that order.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const zip = require("./zip");

const CODE_RE = /INKK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/;
const MAX_BYTES = 50 * 1024 * 1024;
const BACKUP_DAYS = 7;

const KINDS = {
  ".docx": "docx", ".pdf": "pdf", ".rtf": "rtf", ".rtfd": "rtf", ".doc": "doc", ".odt": "odt",
  ".html": "html", ".htm": "html", ".txt": "txt", ".md": "md", ".markdown": "md", ".pages": "pages", ".png": "png",
};
const kindOf = (file) => KINDS[path.extname(String(file || "")).toLowerCase()] || null;

function run(cmd, args, { timeout = 8000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
    if (input != null) { child.stdin.end(input); }
  });
}

const decodeXml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, "&");
const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Paragraphs of a Word document's body, as plain text.
function docxText(buf) {
  const z = zip.readZip(buf);
  const doc = z.entries.find((e) => e.name === "word/document.xml");
  if (!doc) return null;
  const xml = zip.entryData(doc).toString("utf8");
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

async function extractText(file, { helper } = {}) {
  const kind = kindOf(file);
  try {
    if (!kind || fs.statSync(file).size > MAX_BYTES) return null;
    if (kind === "txt" || kind === "md") return fs.readFileSync(file, "utf8");
    if (kind === "docx") return docxText(fs.readFileSync(file));
    if (kind === "pdf") return helper && helper.available() ? helper.pdfText(file) : null;
    if (kind === "rtf" || kind === "doc" || kind === "odt" || kind === "html") return run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file]);
  } catch { /* unreadable: no text */ }
  return null;
}

// ── extended attributes ─────────────────────────────────────────────────────
async function readXattr(file) {
  const out = await run("/usr/bin/xattr", ["-p", "site.inkk.code", file], { timeout: 3000 });
  const m = out && CODE_RE.exec(out);
  return m ? m[0] : null;
}
async function writeXattr(file, code, seal) {
  const a = await run("/usr/bin/xattr", ["-w", "site.inkk.code", code, file], { timeout: 3000 });
  const b = await run("/usr/bin/xattr", ["-w", "site.inkk.seal", seal, file], { timeout: 3000 });
  return a !== null && b !== null;
}

// ── Word ────────────────────────────────────────────────────────────────────
const CUSTOM_PART = "docProps/custom.xml";
const CUSTOM_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const CUSTOM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";

function docxStamp(buf) {
  const z = zip.readZip(buf);
  const part = z.entries.find((e) => e.name === CUSTOM_PART);
  if (!part) return null;
  const xml = zip.entryData(part).toString("utf8");
  const m = /<property\b[^>]*\bname="inkk-code"[^>]*>\s*<vt:lpwstr>([^<]*)<\/vt:lpwstr>/.exec(xml);
  const code = m && CODE_RE.exec(decodeXml(m[1]));
  return code ? code[0] : null;
}

function withInkkProps(xml, code, seal) {
  const props = (pid0) => [["inkk-code", code], ["inkk-seal", seal]]
    .map(([n, v], i) => `<property fmtid="${FMTID}" pid="${pid0 + i}" name="${n}"><vt:lpwstr>${escapeXml(v)}</vt:lpwstr></property>`).join("");
  if (!xml) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${props(2)}</Properties>`;
  }
  const kept = xml.replace(/<property\b[^>]*\bname="inkk-(?:code|seal)"[^>]*>[\s\S]*?<\/property>/g, "");
  const pids = [...kept.matchAll(/\bpid="(\d+)"/g)].map((m) => +m[1]);
  const next = Math.max(1, ...pids) + 1;
  if (/<Properties\b[^>]*\/>/.test(kept)) return kept.replace(/<Properties\b([^>]*)\/>/, `<Properties$1>${props(next)}</Properties>`);
  return kept.replace(/<\/Properties>\s*$/, `${props(next)}</Properties>`);
}

// → a new .docx buffer carrying the code, or throws.
function docxWithStamp(buf, code, seal) {
  const z = zip.readZip(buf);
  const byName = new Map(z.entries.map((e) => [e.name, e]));
  const types = byName.get("[Content_Types].xml");
  const rels = byName.get("_rels/.rels");
  if (!types || !rels || !byName.has("word/document.xml")) throw new Error("not a Word document");
  const replace = new Map();
  const add = [];

  const custom = byName.get(CUSTOM_PART);
  const customXml = withInkkProps(custom ? zip.entryData(custom).toString("utf8") : null, code, seal);
  if (custom) replace.set(CUSTOM_PART, Buffer.from(customXml, "utf8"));
  else add.push({ name: CUSTOM_PART, data: Buffer.from(customXml, "utf8") });

  const typesXml = zip.entryData(types).toString("utf8");
  if (!typesXml.includes('PartName="/docProps/custom.xml"')) {
    replace.set("[Content_Types].xml", Buffer.from(typesXml.replace(/<\/Types>\s*$/, `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_TYPE}"/></Types>`), "utf8"));
  }
  const relsXml = zip.entryData(rels).toString("utf8");
  if (!relsXml.includes(CUSTOM_REL)) {
    const ids = new Set([...relsXml.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
    let n = 1;
    while (ids.has(`rIdInkk${n}`)) n++;
    replace.set("_rels/.rels", Buffer.from(relsXml.replace(/<\/Relationships>\s*$/, `<Relationship Id="rIdInkk${n}" Type="${CUSTOM_REL}" Target="docProps/custom.xml"/></Relationships>`), "utf8"));
  }
  const out = zip.writeZip(z, { replace, add });

  // The new file must hold every original part, byte for byte, apart from the
  // ones changed on purpose, and must read back with the code.
  const check = zip.readZip(out);
  const after = new Map(check.entries.map((e) => [e.name, e]));
  for (const e of z.entries) {
    const a = after.get(e.name);
    if (!a) throw new Error(`lost ${e.name}`);
    if (!replace.has(e.name) && !zip.entryData(a).equals(zip.entryData(e))) throw new Error(`changed ${e.name}`);
  }
  if (docxStamp(out) !== code) throw new Error("stamp did not read back");
  return out;
}

// ── PDF ─────────────────────────────────────────────────────────────────────
async function pdfStamp(file, helper) {
  if (!helper || !helper.available()) return null;
  const meta = await helper.pdfReadMeta(file);
  const words = meta && Array.isArray(meta.keywords) ? meta.keywords.join(" ") : "";
  const m = /inkk:\s*(INKK-[0-9A-Z-]{14})/i.exec(words) || CODE_RE.exec(words);
  const code = m && CODE_RE.exec(m[1] || m[0]);
  return code ? code[0] : null;
}

// ── PNG ─────────────────────────────────────────────────────────────────────
function pngTextChunks(buf) {
  const out = {};
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out;
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (type === "tEXt") {
      const data = buf.toString("latin1", p + 8, p + 8 + len);
      const i = data.indexOf("\0");
      if (i > 0) out[data.slice(0, i)] = data.slice(i + 1);
    }
    if (type === "IEND" || type === "IDAT" && Object.keys(out).length) break;
    p += 12 + len;
  }
  return out;
}

// ── reading and writing ─────────────────────────────────────────────────────
const sealOf = (code) => `https://www.inkk.site/v/${code}`;

// → { code, seal, via } | null
async function readStamp(file, { helper } = {}) {
  try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
  const x = await readXattr(file);
  if (x) return { code: x, seal: sealOf(x), via: "xattr" };
  const kind = kindOf(file);
  try {
    if (kind === "docx" && fs.statSync(file).size <= MAX_BYTES) {
      const c = docxStamp(fs.readFileSync(file));
      if (c) return { code: c, seal: sealOf(c), via: "docx" };
    }
    if (kind === "pdf") {
      const c = await pdfStamp(file, helper);
      if (c) return { code: c, seal: sealOf(c), via: "pdf" };
    }
    if (kind === "png" && fs.statSync(file).size <= MAX_BYTES) {
      const t = pngTextChunks(fs.readFileSync(file));
      const m = CODE_RE.exec(t["inkk-code"] || t.Keywords || "");
      if (m) return { code: m[0], seal: sealOf(m[0]), via: "png" };
    }
  } catch { /* unreadable: no stamp */ }
  return null;
}

function keepBackup(file, backupsDir, now) {
  if (!backupsDir) return;
  try {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    for (const n of fs.readdirSync(backupsDir)) {
      const p = path.join(backupsDir, n);
      if (now - fs.statSync(p).mtimeMs > BACKUP_DAYS * 86400000) fs.rmSync(p, { force: true });
    }
    fs.copyFileSync(file, path.join(backupsDir, `${now}-${path.basename(file)}`));
  } catch { /* a missing backup never blocks the stamp; the write below is verified */ }
}

// → { ok, kinds: ["xattr","docx"|"pdf"], error? }
async function writeStamp(file, { code, seal = sealOf(code) }, { helper, backupsDir, now = Date.now() } = {}) {
  const kinds = [];
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, kinds, error: "missing" }; }
  if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, kinds, error: "unsupported" };
  const kind = kindOf(file);
  let error;
  try {
    if (kind === "docx") {
      const before = fs.readFileSync(file);
      if (docxStamp(before) !== code) {
        const next = docxWithStamp(before, code, seal);
        keepBackup(file, backupsDir, now);
        // Written into the same file (same inode), so an app holding it open
        // keeps pointing at it; its modification time is put back so the app
        // doesn't think someone else edited it.
        fs.writeFileSync(file, next);
        fs.utimesSync(file, stat.atime, stat.mtime);
        if (docxStamp(fs.readFileSync(file)) !== code) throw new Error("stamp did not read back");
      }
      kinds.push("docx");
    } else if (kind === "pdf" && helper && helper.available()) {
      if ((await pdfStamp(file, helper)) !== code) {
        keepBackup(file, backupsDir, now);
        const r = await helper.pdfStamp(file, { code, seal });
        if (!r.ok) throw new Error(r.error || "pdf stamp failed");
      }
      kinds.push("pdf");
    }
  } catch (e) { error = e.message; }
  if (await writeXattr(file, code, seal)) kinds.push("xattr");
  return { ok: kinds.length > 0 && !error, kinds, ...(error ? { error } : {}) };
}

module.exports = { kindOf, extractText, readStamp, writeStamp, docxText, docxStamp, docxWithStamp, pngTextChunks, sealOf, CODE_RE };
