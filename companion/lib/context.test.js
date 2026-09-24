// Run: node --test lib/context.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createContextPoller, describe, normaliseTitle, filePathOf, parseInfo } = require("./context");

const front = (over = {}) => ({ pid: 501, bundleId: "com.apple.TextEdit", name: "TextEdit", title: "", document: "", ...over });

test("a window showing a file is known by the file", () => {
  const cur = describe(front({ title: "Essay.rtf — Edited", document: "file:///Users/someone/Documents/My%20Essay.rtf" }));
  assert.deepStrictEqual(cur, {
    name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 501,
    title: "Essay.rtf — Edited", document: "file:///Users/someone/Documents/My%20Essay.rtf",
    docKey: "file:/Users/someone/Documents/My Essay.rtf", docLabel: "My Essay.rtf",
  });
});

test("a package document keeps its name without the trailing slash, in NFC", () => {
  const cur = describe(front({ bundleId: "com.apple.iWork.Pages", name: "Pages", document: "file:///Users/someone/Cafe%CC%81%20notes.pages/" }));
  assert.strictEqual(cur.docKey, "file:/Users/someone/Café notes.pages");
  assert.strictEqual(cur.docLabel, "Café notes.pages");
  assert.strictEqual(filePathOf("https://docs.example.com/d/1"), "");
  assert.strictEqual(filePathOf(""), "");
});

test("otherwise by its title, without the app's passing status", () => {
  const key = (title) => describe(front({ title })).docKey;
  assert.strictEqual(key("Essay — Edited"), "title:Essay");
  assert.strictEqual(key("Essay - Edited"), "title:Essay");
  assert.strictEqual(key("Essay – Edited"), "title:Essay");
  assert.strictEqual(key("  Essay  "), "title:Essay");
  assert.strictEqual(key("Notes.txt — Locked"), "title:Notes.txt");
  assert.strictEqual(key("Report (Read-Only)"), "title:Report");
  assert.strictEqual(key("Report [Compatibility Mode]"), "title:Report");
  assert.strictEqual(key("Essay — Edited — Locked"), "title:Essay");
  assert.strictEqual(key("Self-Edited"), "title:Self-Edited", "only a separated status comes off");
  assert.strictEqual(key("Essay - Google Docs"), "title:Essay - Google Docs", "the app's name is part of the identity");
  assert.strictEqual(key("Essay – Microsoft Word"), "title:Essay – Microsoft Word");
  assert.strictEqual(key("Café"), "title:Café", "NFC");
  assert.strictEqual(key("\u200EWhatsApp"), "title:WhatsApp", "invisible marks come off");
});

test("unread counts and unsaved dots don't make a new document", () => {
  assert.strictEqual(normaliseTitle("Inbox (3) - someone@example.com - Mail"), normaliseTitle("Inbox (12) - someone@example.com - Mail"));
  assert.strictEqual(normaliseTitle("Inbox (3) - someone@example.com - Gmail"), "Inbox - someone@example.com - Gmail");
  assert.strictEqual(normaliseTitle("Inbox (1,204) – Fastmail"), "Inbox – Fastmail");
  assert.strictEqual(normaliseTitle("Inbox (7) - Outlook"), "Inbox - Outlook");
  assert.strictEqual(normaliseTitle("(4) Messages"), "Messages");
  assert.strictEqual(normaliseTitle("● chapter-two.md — novel"), "chapter-two.md — novel");
});

test("a bracketed number that is part of the name stays: two documents stay two", () => {
  const key = (title) => describe(front({ bundleId: "com.google.Chrome", name: "Google Chrome", title })).docKey;
  assert.strictEqual(key("Budget (2025) - Google Docs"), "title:Budget (2025) - Google Docs");
  assert.notStrictEqual(key("Budget (2025) - Google Docs"), key("Budget (2026) - Google Docs"));
  assert.notStrictEqual(key("Essay (1) - Google Docs"), key("Essay (2) - Google Docs"));
  assert.notStrictEqual(key("Chapter (3)"), key("Chapter (4)"));
  assert.strictEqual(normaliseTitle("Essay (2)"), "Essay (2)");
  assert.strictEqual(normaliseTitle("Chapter (3) — Edited"), "Chapter (3)");
  assert.strictEqual(normaliseTitle("Budget (2025) - Mail merge - Google Docs"), "Budget (2025) - Mail merge - Google Docs",
    "a mail word inside the name is not a mailbox");
  assert.strictEqual(describe(front({ title: "Budget (2025) - Google Docs" })).docLabel, "Budget (2025) - Google Docs");
});

test("joined emoji and joiners in a title hold together; invisible marks still come off", () => {
  const dev = "\u{1F469}\u200D\u{1F4BB} Dev notes - Google Docs";
  const cur = describe(front({ title: dev }));
  assert.strictEqual(cur.docLabel, dev);
  assert.strictEqual(cur.docKey, `title:${dev}`);
  assert.notStrictEqual(cur.docLabel, "\u{1F469}\u{1F4BB} Dev notes - Google Docs");
  const persian = "می\u200Cخواهم";
  assert.strictEqual(normaliseTitle(persian), persian, "ZWNJ is part of the spelling");
  assert.strictEqual(normaliseTitle(`\u200E${dev}\u200F`), dev);
  assert.strictEqual(normaliseTitle("Essay\u200B\u2060\uFEFF"), "Essay");
  assert.strictEqual(normaliseTitle("\u202AEssay\u202C"), "Essay");
  assert.strictEqual(parseInfo('"LSDisplayName"="\u200DApp"\n"CFBundleIdentifier"="com.example.app"').name, "App",
    "app names still lose every invisible mark");
});

test("the label: file name, else title, else the app; at most 80 characters", () => {
  assert.strictEqual(describe(front()).docKey, "");
  assert.strictEqual(describe(front()).docLabel, "TextEdit");
  const long = "A very long working title for a piece of writing that goes on and on past the edge of any label";
  const cur = describe(front({ title: long }));
  assert.strictEqual(cur.docKey, `title:${long}`, "the key keeps the whole title");
  assert.strictEqual(Array.from(cur.docLabel).length, 80);
  assert.ok(cur.docLabel.endsWith("…"));
  assert.ok(long.startsWith(cur.docLabel.slice(0, -1)));
  const emoji = describe(front({ title: "\u{1F58B}".repeat(100) })).docLabel;
  assert.strictEqual(Array.from(emoji).length, 80, "never splits a character");
});

test("no front app, or no bundle id: null", () => {
  assert.strictEqual(describe(null), null);
  assert.strictEqual(describe({ name: "x", bundleId: "" }), null);
});

test("current() has the full shape, from a read that knows the document", async () => {
  const p = createContextPoller({ read: async () => front({ title: "Essay — Edited" }) });
  await p.pollNow();
  assert.deepStrictEqual(Object.keys(p.current()).sort(), ["bundleId", "docKey", "docLabel", "document", "name", "pid", "title"]);
});

test("onChange fires when the app or the document changes, not when only the status does", async () => {
  const reads = [
    front({ title: "Essay" }),
    front({ title: "Essay — Edited" }),        // same document
    front({ title: "Letter" }),                // another document, same app
    front({ title: "Letter — Edited" }),
    front({ bundleId: "com.apple.Notes", name: "Notes", title: "Letter" }),   // another app
    front({ bundleId: "com.apple.Notes", name: "Notes", title: "Letter" }),
    null,
    null,
  ];
  const seen = [];
  const p = createContextPoller({ read: async () => reads.shift(), onChange: (cur) => seen.push(cur && `${cur.bundleId} ${cur.docKey}`) });
  for (let i = 0; i < 8; i++) await p.pollNow();
  assert.deepStrictEqual(seen, [
    "com.apple.TextEdit title:Essay",
    "com.apple.TextEdit title:Letter",
    "com.apple.Notes title:Letter",
    null,
  ]);
});

test("a read that can't see the document keeps the one known for the same app", async () => {
  const reads = [
    front({ title: "Essay", document: "file:///Users/someone/Essay.txt" }),
    { name: "TextEdit", bundleId: "com.apple.TextEdit" },            // the lsappinfo fallback
    { name: "Notes", bundleId: "com.apple.Notes" },                  // fallback, another app
  ];
  const seen = [];
  const p = createContextPoller({ read: async () => reads.shift(), onChange: (cur) => seen.push(cur.docKey) });
  await p.pollNow();
  await p.pollNow();
  assert.strictEqual(p.current().docKey, "file:/Users/someone/Essay.txt");
  assert.strictEqual(p.current().pid, 501);
  await p.pollNow();
  assert.deepStrictEqual(p.current(), { name: "Notes", bundleId: "com.apple.Notes", pid: null, title: "", document: "", docKey: "", docLabel: "Notes" });
  assert.deepStrictEqual(seen, ["file:/Users/someone/Essay.txt", ""]);
});

test("a window the helper couldn't ask in time (null) keeps the document; it is not a new one", async () => {
  const reads = [
    front({ bundleId: "com.google.Chrome", name: "Google Chrome", title: "Essay - Google Docs" }),
    front({ bundleId: "com.google.Chrome", name: "Google Chrome", title: null, document: null }),     // the app was busy
    front({ bundleId: "com.google.Chrome", name: "Google Chrome", title: "Essay - Google Docs" }),
    front({ bundleId: "com.google.Chrome", name: "Google Chrome", title: "Essay - Google Docs", document: null }), // half an answer
    front({ bundleId: "com.apple.Notes", name: "Notes", title: null, document: null }),               // busy, another app
  ];
  const seen = [];
  const p = createContextPoller({ read: async () => reads.shift(), onChange: (cur) => seen.push(`${cur.bundleId} ${cur.docKey}`) });
  await p.pollNow();
  await p.pollNow();
  assert.strictEqual(p.current().docKey, "title:Essay - Google Docs");
  assert.strictEqual(p.current().title, "Essay - Google Docs", "current() keeps strings");
  await p.pollNow();
  await p.pollNow();
  assert.strictEqual(p.current().docKey, "title:Essay - Google Docs");
  await p.pollNow();
  assert.deepStrictEqual(p.current(), { name: "Notes", bundleId: "com.apple.Notes", pid: 501, title: "", document: "", docKey: "", docLabel: "Notes" });
  assert.deepStrictEqual(seen, ["com.google.Chrome title:Essay - Google Docs", "com.apple.Notes "]);
});

test("without Accessibility the helper's empty title means an unknown document", async () => {
  const p = createContextPoller({ read: async () => front({ bundleId: "com.google.Chrome", name: "Google Chrome" }) });
  await p.pollNow();
  assert.strictEqual(p.current().docKey, "");
  assert.strictEqual(p.current().docLabel, "Google Chrome");
});

test("callers during a poll share it: one read, one answer", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = createContextPoller({ read: async () => { reads++; await gate; return front({ title: "Essay" }); } });
  const a = p.pollNow(), b = p.pollNow();
  assert.strictEqual(a, b);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(reads, 1);
  assert.strictEqual(ra, rb);
  assert.strictEqual(ra.docKey, "title:Essay");
  await p.pollNow();
  assert.strictEqual(reads, 2, "the next poll reads again");
});

test("a read that throws keeps the last answer", async () => {
  const reads = [async () => front({ title: "Essay" }), async () => { throw new Error("gone"); }];
  const p = createContextPoller({ read: () => reads.shift()() });
  await p.pollNow();
  await p.pollNow();
  assert.strictEqual(p.current().docKey, "title:Essay");
});

test("start polls at once and on the interval; stop ends it", async () => {
  let reads = 0;
  const p = createContextPoller({ intervalMs: 20, read: async () => { reads++; return front(); } });
  p.start();
  await new Promise((r) => setTimeout(r, 90));
  p.stop();
  const n = reads;
  assert.ok(n >= 3, `${n} reads`);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(reads, n);
});

test("lsappinfo output still parses", () => {
  assert.deepStrictEqual(parseInfo('"LSDisplayName"="\u200EWhatsApp"\n"CFBundleIdentifier"="net.whatsapp.WhatsApp"'),
    { name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp" });
  assert.strictEqual(parseInfo('"LSDisplayName"="Nothing"'), null);
});

test("the default read goes through the running helper and gives the same shape", { skip: !require("./helper").available() && "inkk-helper not built" }, async () => {
  const helper = require("./helper");
  const p = createContextPoller();
  const cur = await p.pollNow();
  helper.stop();
  assert.ok(cur, "an app is in front");
  assert.deepStrictEqual(Object.keys(cur).sort(), ["bundleId", "docKey", "docLabel", "document", "name", "pid", "title"]);
  assert.ok(Number.isInteger(cur.pid) && cur.pid > 0, "the pid comes from the helper");
  assert.strictEqual(typeof cur.docKey, "string");
  assert.ok(cur.docLabel.length > 0 && Array.from(cur.docLabel).length <= 80);
});
