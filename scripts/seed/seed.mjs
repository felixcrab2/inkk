#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// seed.mjs — load the prepared public-domain content into Supabase as if a small
// community of writers had been using Inkk for a few months. Creates auth users
// + profiles (the "personas"), publishes their pieces, and seeds a believable
// amount of engagement (follows / likes / comments) so the feed feels lived-in.
//
//   node scripts/seed/seed.mjs               # full seed
//   node scripts/seed/seed.mjs --dry-run     # print the plan, write nothing
//   node scripts/seed/seed.mjs --no-comments # skip generated reader comments
//   node scripts/seed/seed.mjs --no-engagement   # publications only
//   node scripts/seed/seed.mjs --limit 5     # only first N pieces (smoke test)
//
// Needs a service-role key (admin). NEVER commit it. See README.md.
//
// IMPORTANT: seeded pieces are published WITH NO verification certificate
// (verify_code / human_score / score_tier left null) — they were not written in
// the editor, so they must not claim the human-writing proof. They simply appear
// in the feed as ordinary posts. Don't change that.
//
// Safe + idempotent: every row it creates is recorded in .seed-ledger.json, and
// it never attaches content to a username that already exists but wasn't created
// by a previous seed run. Re-running tops up missing rows. `unseed.mjs` removes
// exactly what the ledger records — it can't touch real users' data.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, ".seed-ledger.json");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY = has("--dry-run");
const NO_COMMENTS = has("--no-comments");
const NO_ENGAGEMENT = has("--no-engagement");
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

// ── env (no dotenv dependency: parse scripts/seed/.env then repo-root .env) ────
function loadEnv() {
  for (const p of [join(HERE, ".env"), join(HERE, "..", "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN || "seed.inkk.invalid";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing credentials.\n" +
    "  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service-role, NOT the anon key).\n" +
    "  Put them in scripts/seed/.env — see scripts/seed/.env.example.\n");
  process.exit(1);
}

// ── deterministic RNG so re-runs pick the same engagement (idempotent) ─────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x494e4b4b);   // "INKK"
const rand = () => rng();
const randInt = (a, b) => { b = Math.max(a, b); return a + Math.floor(rand() * (b - a + 1)); };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function sample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}
const wordCount = (html) => ((html || "").replace(/<[^>]+>/g, " ").match(/\S+/g) || []).length;

// Short, generic reader reactions — the one bit of written-by-us text. Kept
// vague enough to fit any literary piece and varied enough not to read as a bot.
// Disable entirely with --no-comments.
const COMMENT_POOL = [
  "Read this twice. The second time was better.",
  "That last line has been following me around all day.",
  "Quietly devastating.",
  "The restraint here is the whole thing.",
  "Saving this to reread on the train tomorrow.",
  "I don't know how you do so much with so little.",
  "Felt this one in my chest.",
  "Perfect for a grey morning.",
  "More of this, please.",
  "The rhythm of it.",
  "Sent it straight to my sister.",
  "Beautiful, and a little cruel.",
  "Underlined half of it in my head.",
  "Came back to this twice today.",
  "Something about the ending I can't shake.",
  "You can hear the room go quiet.",
  "This is the kind of thing I started reading here for.",
  "Read it out loud. Worth it.",
  "The small details are doing all the work.",
  "Didn't expect that turn.",
];

// ── ledger ────────────────────────────────────────────────────────────────────
function emptyLedger() {
  return { createdAt: new Date().toISOString(), users: [], publications: [], documents: [], follows: [], likes: [], comments: [] };
}
function loadLedger() {
  if (existsSync(LEDGER)) { try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch {} }
  return emptyLedger();
}
async function saveLedger(l) { if (!DRY) await writeFile(LEDGER, JSON.stringify(l, null, 2)); }

// ── timestamps: spread over the last ~7 days, biased toward recent ────────────
const DAY = 86400_000;
function spreadTimestamp() {
  const days = (rand() ** 1.3) * 6.6 + 0.15;                   // last ~7 days, weighted recent
  const jitter = (rand() * 12) * 3600_000;                      // vary the hour of day
  return new Date(Date.now() - days * DAY - jitter).toISOString();
}
function afterBy(iso, maxDays) {
  const base = new Date(iso).getTime();
  const t = Math.min(Date.now() - 3600_000, base + rand() * maxDays * DAY + 1800_000);
  return new Date(t).toISOString();
}

const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const posts = JSON.parse(await readFile(join(HERE, "posts.json"), "utf8"));
  const personas = posts.personas;
  let pieces = posts.pieces.map((p) => ({
    ...p,
    author_name: personas.find((x) => x.username === p.author_username)?.display_name || p.author_username,
    words: wordCount(p.content),
  }));
  if (Number.isFinite(LIMIT)) pieces = pieces.slice(0, LIMIT);

  console.log(`\nInkk seed${DRY ? "  (DRY RUN — nothing will be written)" : ""}`);
  console.log(`  ${personas.length} personas, ${pieces.length} pieces`);
  console.log(`  target: ${SUPABASE_URL}\n`);

  const ledger = loadLedger();
  const ownedUserIds = new Set(ledger.users.map((u) => u.id));

  // ── 1. personas → auth users + profiles ─────────────────────────────────────
  const idByUsername = new Map();
  for (const p of personas) {
    const existing = await findProfile(p.username);
    if (existing) {
      if (!ownedUserIds.has(existing.id)) {
        console.log(`  ~ @${p.username} already exists and was not seeded by us — skipping (won't touch a real account)`);
        idByUsername.set(p.username, { id: existing.id, foreign: true });
        continue;
      }
      idByUsername.set(p.username, { id: existing.id });
      console.log(`  = @${p.username} (existing seed user)`);
      continue;
    }
    if (DRY) { console.log(`  + @${p.username}  (would create user + profile)`); idByUsername.set(p.username, { id: `dry-${p.username}` }); continue; }

    const email = `${p.username}@${EMAIL_DOMAIN}`;
    const password = randomBytes(18).toString("base64url");
    const { data, error } = await supa.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { seed: true, persona: p.username },
    });
    if (error || !data?.user) { console.log(`  ✗ @${p.username}: ${error?.message || "no user returned"}`); continue; }
    const id = data.user.id;
    const profile = { id, username: p.username, research_opt_in: false };
    if (p.display_name) profile.display_name = p.display_name;
    if (p.bio) profile.bio = p.bio;
    let { error: pe } = await supa.from("profiles").upsert(profile, { onConflict: "id" });
    if (pe && /column/i.test(pe.message || "") && "bio" in profile) {
      delete profile.bio;
      ({ error: pe } = await supa.from("profiles").upsert(profile, { onConflict: "id" }));
    }
    if (pe) { console.log(`  ✗ profile @${p.username}: ${pe.message}`); continue; }
    ledger.users.push({ username: p.username, id, email, password });
    ownedUserIds.add(id);
    idByUsername.set(p.username, { id });
    console.log(`  + @${p.username}`);
  }
  await saveLedger(ledger);

  // ── 2. pieces → publications (no certificate) ───────────────────────────────
  const pubByKey = new Map();          // piece -> { id, ts, userId }
  const freshPubs = [];                // only pubs created in THIS run (for comments)
  let published = 0, skipped = 0;
  if (!ledger.documents) ledger.documents = [];
  for (const piece of pieces) {
    const u = idByUsername.get(piece.author_username);
    if (!u || u.foreign) { skipped++; continue; }
    const ts = spreadTimestamp();

    const existing = await findPublication(u.id, piece.title);
    if (existing) { pubByKey.set(piece, { id: existing.id, ts: existing.published_at || ts, userId: u.id }); continue; }
    if (DRY) { console.log(`  · "${piece.title}" → @${piece.author_username}`); const rec = { id: `dry-${published}`, ts, userId: u.id }; pubByKey.set(piece, rec); freshPubs.push(rec); published++; continue; }

    const id = randomUUID();
    const payload = {
      id, user_id: u.id, title: piece.title, content: piece.content,
      author_name: piece.author_name, author_username: piece.author_username,
      published_at: ts,
      writing_time_seconds: Math.round(piece.words * (1.7 + rand() * 1.6)),
      revision_count: randInt(1, 6),
      author_note: piece.note || null,
      moderation_status: "ok",
      render_justify: false, render_indent: false,
      // verify_code / content_hash / human_score / score_tier left NULL → no cert.
    };
    let error = await insertPub(payload);
    if (error && /column/i.test(error.message || "")) {
      const { author_note, moderation_status, render_justify, render_indent, ...bare } = payload;
      error = await insertPub(bare);
    }
    if (error && /doc_id|not[- ]null|null value/i.test(error.message || "")) {
      // This instance's publications table requires a backing document — make one.
      const docId = await createDocument(ledger, u.id, piece, ts);
      if (docId) error = await insertPub({ ...payload, doc_id: docId });
    }
    if (error) { console.log(`  ✗ publish "${piece.title}": ${error.message}`); continue; }
    ledger.publications.push(id);
    const rec = { id, ts, userId: u.id };
    pubByKey.set(piece, rec); freshPubs.push(rec);
    published++;
  }
  await saveLedger(ledger);
  console.log(`\n  published ${published}${skipped ? `, skipped ${skipped} (no/foreign user)` : ""}`);

  if (NO_ENGAGEMENT) { await finish(ledger); return; }

  const realPersonas = personas.map((p) => idByUsername.get(p.username)).filter((x) => x && !x.foreign);
  const ids = realPersonas.map((x) => x.id);
  const pubs = [...pubByKey.values()];

  // ── 3. follows ──────────────────────────────────────────────────────────────
  let follows = 0;
  for (const me of ids) {
    const others = ids.filter((x) => x !== me);
    for (const other of sample(others, randInt(3, Math.min(8, others.length)))) {
      if (DRY) { follows++; continue; }
      const { error } = await supa.from("follows").insert({ follower_id: me, following_id: other });
      if (error && !/duplicate|unique/i.test(error.message || "")) continue;
      if (!error) { ledger.follows.push([me, other]); follows++; }
    }
  }
  await saveLedger(ledger);

  // ── 4. likes (weighted: most pieces modest, a few popular) ──────────────────
  let likes = 0;
  for (const pub of pubs) {
    const base = randInt(1, 9);
    const popular = rand() < 0.18 ? randInt(15, Math.min(48, ids.length - 1)) : 0;
    const n = Math.min(Math.max(base, popular), ids.length - 1);
    const likers = sample(ids.filter((x) => x !== pub.userId), n);
    for (const liker of likers) {
      if (DRY) { likes++; continue; }
      const { error } = await supa.from("likes").insert({ user_id: liker, publication_id: pub.id, created_at: afterBy(pub.ts, 6) });
      if (!error) { ledger.likes.push([liker, pub.id]); likes++; }
    }
  }
  await saveLedger(ledger);

  // ── 5. comments (skippable) ─────────────────────────────────────────────────
  let comments = 0;
  if (!NO_COMMENTS) {
    for (const pub of freshPubs) {                          // only new pubs — comments can't dedupe on re-run
      if (rand() > 0.38) continue;                          // ~38% of pieces get any comments
      const commenters = sample(ids.filter((x) => x !== pub.userId), randInt(1, 3));
      const used = new Set();
      for (const cid of commenters) {
        let body = pick(COMMENT_POOL); let guard = 0;
        while (used.has(body) && guard++ < 6) body = pick(COMMENT_POOL);
        used.add(body);
        if (DRY) { comments++; continue; }
        const id = randomUUID();
        const { error } = await supa.from("comments").insert({
          id, user_id: cid, publication_id: pub.id, body, created_at: afterBy(pub.ts, 5), moderation_status: "ok",
        });
        if (error && /column/i.test(error.message || "")) {
          const { error: e2 } = await supa.from("comments").insert({ id, user_id: cid, publication_id: pub.id, body, created_at: afterBy(pub.ts, 25) });
          if (e2) continue;
        } else if (error) continue;
        ledger.comments.push(id); comments++;
      }
    }
  }
  await saveLedger(ledger);

  console.log(`  follows ${follows}, likes ${likes}, comments ${comments}`);
  await finish(ledger);
}

async function finish(ledger) {
  await saveLedger(ledger);
  console.log(`\n${DRY ? "Dry run complete — no changes made." : "Done."}`);
  if (!DRY) {
    console.log(`  ledger: scripts/seed/.seed-ledger.json`);
    console.log(`  undo:   npm run seed:undo`);
  }
}

async function insertPub(payload) {
  const { error } = await supa.from("publications").insert(payload);
  return error || null;
}

// Only used if this instance's publications.doc_id is NOT NULL (the schema we saw
// has it nullable, so this is a safety net).
async function createDocument(ledger, userId, piece, ts) {
  const id = randomUUID();
  let { error } = await supa.from("documents").insert({ id, user_id: userId, title: piece.title, content: piece.content, updated_at: ts });
  if (error && /column/i.test(error.message || "")) ({ error } = await supa.from("documents").insert({ id, user_id: userId, content: piece.content }));
  if (error) { console.log(`    (document fallback failed: ${error.message})`); return null; }
  ledger.documents.push(id);
  return id;
}

// ── lookups ───────────────────────────────────────────────────────────────────
async function findProfile(username) {
  if (DRY) return null;   // dry-run is fully offline
  const { data } = await supa.from("profiles").select("id").eq("username", username).maybeSingle();
  return data || null;
}
async function findPublication(userId, title) {
  if (DRY) return null;   // dry-run is fully offline
  const { data } = await supa.from("publications").select("id, published_at").eq("user_id", userId).eq("title", title).maybeSingle();
  return data || null;
}

main().catch((e) => { console.error(e); process.exit(1); });
