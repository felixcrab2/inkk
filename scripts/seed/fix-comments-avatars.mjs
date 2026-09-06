// One-off: replace the generic comment pool with curated per-piece comments,
// and give personas their avatars. Reads posts.json as the source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync("scripts/seed/.env","utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const LEDGER = "scripts/seed/.seed-ledger.json";
const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const posts = JSON.parse(readFileSync("scripts/seed/posts.json", "utf8"));

// 1 ── purge the interchangeable one-liners, from BOTH seed generations
const POOL = [
  "Read this twice. The second time was better.","That last line has been following me around all day.",
  "Quietly devastating.","The restraint here is the whole thing.","Saving this to reread on the train tomorrow.",
  "I don't know how you do so much with so little.","Felt this one in my chest.","Perfect for a grey morning.",
  "More of this, please.","The rhythm of it.","Sent it straight to my sister.","Beautiful, and a little cruel.",
  "Underlined half of it in my head.","Came back to this twice today.","Something about the ending I can't shake.",
  "You can hear the room go quiet.","This is the kind of thing I started reading here for.","Read it out loud. Worth it.",
  "The small details are doing all the work.","Didn't expect that turn.",
];
const { data: junk } = await svc.from("comments").select("id").in("body", POOL);
if (junk?.length) {
  await svc.from("comments").delete().in("id", junk.map(j => j.id));
  const gone = new Set(junk.map(j => j.id));
  ledger.comments = (ledger.comments || []).filter(id => !gone.has(id));
  console.log(`✓ deleted ${junk.length} generic pool comments (all generations)`);
}

// 2 ── curated comments from posts.json
const uid = new Map(ledger.users.map(u => [u.username, u.id]));
let added = 0;
for (const piece of posts.pieces) {
  if (!piece.comments?.length) continue;
  const { data: pub } = await svc.from("publications")
    .select("id, user_id, published_at").eq("author_username", piece.author_username)
    .eq("title", piece.title).maybeSingle();
  if (!pub) { console.log(`  ~ no pub for "${piece.title}"`); continue; }
  for (const c of piece.comments) {
    const author = uid.get(c.by);
    if (!author || author === pub.user_id) continue;
    const { data: dup } = await svc.from("comments").select("id")
      .eq("publication_id", pub.id).eq("user_id", author).eq("body", c.body).maybeSingle();
    if (dup) continue;
    const id = randomUUID();
    const created = new Date(Math.min(Date.now() - 30*60e3,
      new Date(pub.published_at).getTime() + (2 + Math.random()*70) * 3600e3)).toISOString();
    let { error } = await svc.from("comments").insert({ id, user_id: author, publication_id: pub.id, body: c.body, created_at: created, moderation_status: "ok" });
    if (error && /column/i.test(error.message || ""))
      ({ error } = await svc.from("comments").insert({ id, user_id: author, publication_id: pub.id, body: c.body, created_at: created }));
    if (error) { console.log(`  ✗ "${piece.title}": ${error.message}`); continue; }
    ledger.comments.push(id); added++;
  }
}
console.log(`✓ ${added} curated comments inserted`);

// 3 ── avatars
let av = 0;
for (const per of posts.personas) {
  if (!per.avatar || !uid.get(per.username)) continue;
  const { error } = await svc.from("profiles").update({ avatar_data: per.avatar }).eq("id", uid.get(per.username));
  if (!error) av++;
}
console.log(`✓ ${av} avatars set`);
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
console.log("✓ ledger updated");
