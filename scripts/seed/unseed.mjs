#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// unseed.mjs — remove EXACTLY what a previous seed run created, using the ledger
// at scripts/seed/.seed-ledger.json. It only deletes rows whose ids the ledger
// recorded, so it can never delete a real user's content.
//
//   node scripts/seed/unseed.mjs            # remove all seeded data
//   node scripts/seed/unseed.mjs --dry-run  # show what would be removed
//
// Order matters: comments/likes/follows/publications first, then the auth users
// (deleting the user cascades its profile + any remaining owned rows).
// ─────────────────────────────────────────────────────────────────────────────
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, ".seed-ledger.json");
const DRY = process.argv.includes("--dry-run");

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
if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (see README)."); process.exit(1); }
if (!existsSync(LEDGER)) { console.error("No ledger found — nothing to remove."); process.exit(0); }

const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const l = JSON.parse(await readFile(LEDGER, "utf8"));
  console.log(`\nUnseed${DRY ? " (DRY RUN)" : ""} — ledger from ${l.createdAt}`);
  console.log(`  ${l.comments.length} comments, ${l.likes.length} likes, ${l.follows.length} follows, ${l.publications.length} publications, ${l.users.length} users\n`);
  if (DRY) { console.log("Dry run — nothing removed."); return; }

  // comments
  if (l.comments.length) await del("comments", (q) => q.in("id", l.comments));
  // likes (composite key — delete per row)
  for (const [user_id, publication_id] of l.likes) await supa.from("likes").delete().eq("user_id", user_id).eq("publication_id", publication_id);
  // follows
  for (const [follower_id, following_id] of l.follows) await supa.from("follows").delete().eq("follower_id", follower_id).eq("following_id", following_id);
  // publications
  if (l.publications.length) await del("publications", (q) => q.in("id", l.publications));
  // documents (only present if the doc_id fallback was used)
  if (l.documents?.length) await del("documents", (q) => q.in("id", l.documents));
  // auth users (cascades profile + verifications etc.)
  for (const u of l.users) {
    const { error } = await supa.auth.admin.deleteUser(u.id);
    if (error) console.log(`  ✗ delete user @${u.username}: ${error.message}`);
  }
  console.log(`  removed ${l.users.length} users and their content.`);

  await unlink(LEDGER).catch(() => {});
  console.log("  ledger cleared.\nDone.");
}
async function del(table, build) {
  const { error } = await build(supa.from(table).delete());
  if (error) console.log(`  ✗ ${table}: ${error.message}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
