#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build-content.mjs — turn the public-domain works in works.json into clean HTML
// ready for the Inkk feed. Fetches each text from Project Gutenberg, strips the
// boilerplate, segments collections into individual pieces, and writes
// content.json. No database access — this only prepares content.
//
//   node scripts/seed/build-content.mjs            # build everything
//   node scripts/seed/build-content.mjs --inspect 8092   # dump heading lines of one id
//
// Requires Node 18+ (global fetch).
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STRIP_START = /\*\*\*\s*START OF TH(?:E|IS) PROJECT GUTENBERG.*?\*\*\*/s;
const STRIP_END   = /\*\*\*\s*END OF TH(?:E|IS) PROJECT GUTENBERG/s;

// ── fetch ────────────────────────────────────────────────────────────────────
async function fetchGutenberg(id) {
  const urls = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) return await r.text();
    } catch { /* try next */ }
  }
  throw new Error(`could not fetch text for id ${id}`);
}

function stripBoilerplate(raw) {
  let t = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const s = t.search(STRIP_START);
  if (s >= 0) t = t.slice(s).replace(STRIP_START, "");
  const e = t.search(STRIP_END);
  if (e >= 0) t = t.slice(0, e);
  return t.trim();
}

// ── helpers ──────────────────────────────────────────────────────────────────
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A line that looks like a section heading: short, blank line before & after.
function isHeadingLine(lines, i) {
  const ln = lines[i].trim();
  if (!ln || ln.length > 60 || !/[A-Za-z]/.test(ln)) return false;
  const prevBlank = i === 0 || lines[i - 1].trim() === "";
  const nextBlank = i + 1 >= lines.length || lines[i + 1].trim() === "";
  return prevBlank && nextBlank;
}

// Convert a block of source lines (one piece) into clean paragraph HTML.
function linesToHtml(blockLines) {
  // Split into paragraphs on blank lines.
  const paras = [];
  let cur = [];
  for (const raw of blockLines) {
    const ln = raw.trim();
    if (!ln) { if (cur.length) { paras.push(cur); cur = []; } continue; }
    cur.push(ln);
  }
  if (cur.length) paras.push(cur);

  const out = [];
  for (const p of paras) {
    let text = p.join(" ");
    // Drop standalone dividers / sub-section markers / illustrations.
    if (/^[IVXLC]+\.?$/.test(text)) continue;                 // lone roman numeral (II)
    if (/^[*•\s]+$/.test(text)) continue;                     // * * *
    if (/^\[[^\]]*\]$/.test(text)) continue;                  // [Illustration]
    if (/^(THE END|FINIS|L'ENVOY|L’ENVOY)\.?$/i.test(text)) continue;
    if (/^(produced by|transcrib|this ebook|end of)/i.test(text)) continue;
    // Inline cleanups.
    text = text.replace(/\[[^\]]*\]/g, "");                   // inline [1], [Picture: ..]
    text = escapeHtml(text);
    text = text.replace(/_([^_]+)_/g, "<em>$1</em>");         // Gutenberg _italics_
    text = text.replace(/\s+/g, " ").trim();
    if (text) out.push(`<p>${text}</p>`);
  }
  return out.join("\n");
}

function wordCount(html) {
  return (html.replace(/<[^>]+>/g, " ").trim().match(/\S+/g) || []).length;
}

// Split text into blank-line-delimited paragraphs, preserving each paragraph's
// original source lines (so they can be re-wrapped by linesToHtml).
function splitParagraphs(text) {
  const paras = [];
  let cur = [];
  for (const ln of text.split("\n")) {
    if (ln.trim() === "") { if (cur.length) { paras.push(cur); cur = []; } }
    else cur.push(ln);
  }
  if (cur.length) paras.push(cur);
  return paras.map((lines) => ({ lines, text: lines.join(" ").trim() }));
}

// True for a paragraph that is title-page / edition / divider noise rather than
// body prose. Deliberately conservative so it never eats a real opening line.
function isFrontMatterPara(text) {
  const n = norm(text);
  const wc = (text.match(/\S+/g) || []).length;
  if (!n) return true;
  if (/^by\b/i.test(text.trim())) return true;                       // "By <author>"
  if (text.trim() === text.trim().toUpperCase() && wc < 12) return true; // SHORT CAPS line
  if (/^[ivxlc]+$/.test(n)) return true;                             // lone roman numeral
  if (/^(contents|preface|dedication|illustration|edition|the millennium|produced by|transcrib|copyright|first published)/.test(n)) return true;
  return false;
}

// Remove a standalone work's front matter. The body begins right after the last
// "By <author>" line in the opening block; any remaining edition/divider noise is
// then trimmed. Returns the cleaned source lines.
function dropFrontMatter(text, author = "") {
  const paras = splitParagraphs(text);
  const authorKey = norm(author);
  const isByline = (t) => /^by\b/i.test(t) || (authorKey && norm(t) === authorKey);
  let start = 0;
  const limit = Math.min(8, paras.length);
  for (let i = 0; i < limit; i++) if (isByline(paras[i].text)) start = i + 1;
  while (start < paras.length && isFrontMatterPara(paras[start].text)) start++;
  return paras.slice(start).flatMap((p) => p.lines.concat([""]));
}

// ── segmentation ─────────────────────────────────────────────────────────────
// Find, for an ordered list of section titles, the body line index where each
// section begins. A title can appear twice (Contents + body); we choose the
// occurrence that is followed by prose, not by another title.
function locateSections(lines, titles) {
  const titleSet = new Set(titles.map(norm));
  const headings = [];
  for (let i = 0; i < lines.length; i++) if (isHeadingLine(lines, i)) headings.push(i);

  function nextNonBlank(after) {
    for (let j = after + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j].trim();
    return "";
  }

  const found = {};
  for (const t of titles) {
    const key = norm(t);
    const hits = headings.filter((i) => norm(lines[i]) === key);
    if (!hits.length) { found[t] = -1; continue; }
    // Prefer the occurrence whose following content is prose (not another title).
    const body = hits.find((i) => !titleSet.has(norm(nextNonBlank(i))));
    found[t] = body !== undefined ? body : hits[hits.length - 1];
  }
  return found;
}

// Roman-numeral collections (e.g. "II. A Piece of Chalk"): every heading line of
// that shape is a boundary; we return them in order with their titles.
function locateRomanSections(lines) {
  const re = /^[IVXLC]+\.\s+(.+)$/;
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingLine(lines, i)) continue;
    const m = lines[i].trim().match(re);
    if (m) sections.push({ index: i, title: m[1].trim() });
  }
  return sections;
}

// ── build one collection ─────────────────────────────────────────────────────
async function buildCollection(col) {
  const raw = stripBoilerplate(await fetchGutenberg(col.id));
  const lines = raw.split("\n");
  const out = [];

  if (col.autosplit === "roman") {
    const sections = locateRomanSections(lines);
    const boundaries = sections.map((s) => s.index).concat(lines.length);
    for (const pick of col.publish) {
      const idx = sections.findIndex((s) => norm(s.title) === norm(pick.title));
      if (idx < 0) { out.push({ ok: false, pick, reason: "title not found" }); continue; }
      const start = sections[idx].index + 1;            // skip the heading line
      const end = boundaries[idx + 1];
      const html = linesToHtml(lines.slice(start, end));
      out.push({ ok: true, pick, title: sections[idx].title, html, words: wordCount(html) });
    }
    return out;
  }

  // Explicit-title collections.
  const at = locateSections(lines, col.titles);
  const ordered = col.titles.map((t) => ({ title: t, index: at[t] })).filter((s) => s.index >= 0).sort((a, b) => a.index - b.index);
  for (const pick of col.publish) {
    const pos = ordered.findIndex((s) => norm(s.title) === norm(pick.title));
    if (pos < 0) { out.push({ ok: false, pick, reason: "title not located in body" }); continue; }
    const start = ordered[pos].index + 1;
    const end = pos + 1 < ordered.length ? ordered[pos + 1].index : lines.length;
    const html = linesToHtml(lines.slice(start, end));
    out.push({ ok: true, pick, title: pick.title, html, words: wordCount(html) });
  }
  return out;
}

async function buildStandalone(w) {
  const raw = stripBoilerplate(await fetchGutenberg(w.id));
  const lines = dropFrontMatter(raw, w.author);   // pass author so the byline never leaks into the body
  const html = linesToHtml(lines);
  return { ok: true, title: w.title, html, words: wordCount(html) };
}

// ── titleCase for display (matches the brand's understated look) ─────────────
function displayTitle(t) {
  // Keep ALL-CAPS source titles from shouting in the feed.
  if (t === t.toUpperCase()) {
    return t.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
            .replace(/\b(A|An|And|As|At|But|By|For|If|In|Of|On|Or|The|To)\b/g, (m) => m.toLowerCase())
            .replace(/^([a-z])/, (m, c) => c.toUpperCase());
  }
  return t;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function inspect(id) {
  const raw = stripBoilerplate(await fetchGutenberg(id));
  const lines = raw.split("\n");
  console.log(`#${id}: ${wordCount(raw)} words`);
  for (let i = 0; i < lines.length; i++) {
    if (isHeadingLine(lines, i)) console.log(`  L${String(i).padStart(5)}  ${lines[i].trim()}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--inspect") return inspect(args[1]);

  const manifest = JSON.parse(await readFile(join(HERE, "works.json"), "utf8"));
  const personaByName = new Map(manifest.personas.map((p) => [p.username, p]));
  const pieces = [];
  const report = [];

  for (const w of manifest.standalone) {
    try {
      const r = await buildStandalone(w);
      pieces.push(makePiece(r.title, r.html, r.words, w.persona, w.author, w.kind, w.id, personaByName));
      report.push(`[ok   ] ${String(r.words).padStart(5)}w  ${w.persona.padEnd(14)} ${r.title}`);
    } catch (e) {
      report.push(`[FAIL ] standalone ${w.title}: ${e.message}`);
    }
  }

  for (const col of manifest.collections) {
    let results;
    try { results = await buildCollection(col); }
    catch (e) { report.push(`[FAIL ] collection ${col.source}: ${e.message}`); continue; }
    for (const r of results) {
      if (!r.ok) { report.push(`[MISS ] ${col.source} / ${r.pick.title}: ${r.reason}`); continue; }
      const title = displayTitle(r.title);
      pieces.push(makePiece(title, r.html, r.words, r.pick.persona, col.author, col.kind, col.id, personaByName));
      report.push(`[ok   ] ${String(r.words).padStart(5)}w  ${r.pick.persona.padEnd(14)} ${title}  (${col.source})`);
    }
  }

  await writeFile(join(HERE, "content.json"),
    JSON.stringify({ generatedFrom: "Project Gutenberg (public domain)", pieces }, null, 2));

  console.log(report.join("\n"));
  const ok = pieces.length;
  const short = pieces.filter((p) => p.words < 400).length;
  const long = pieces.filter((p) => p.words > 7000).length;
  console.log(`\n${ok} pieces written to content.json` +
    (short ? `  (${short} under 400 words — check)` : "") +
    (long ? `  (${long} over 7000 words — check)` : ""));
}

function makePiece(title, html, words, persona, sourceAuthor, kind, sourceId, personaByName) {
  const p = personaByName.get(persona);
  if (!p) throw new Error(`unknown persona "${persona}"`);
  return {
    persona,
    author_name: p.display_name || p.username,
    author_username: p.username,
    title,
    kind,
    content: html,
    words,
    source: { gutenberg_id: sourceId, original_author: sourceAuthor },
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
