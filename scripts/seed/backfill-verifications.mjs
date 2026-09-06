import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync("scripts/seed/.env","utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const LEDGER = "scripts/seed/.seed-ledger.json";
const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const { data: pubs, error } = await svc.from("publications")
  .select("id, user_id, title, author_name, author_username, content, verify_code, content_hash, human_score, score_tier")
  .in("id", ledger.publications);
if (error) { console.error("fetch:", error.message); process.exit(1); }
const wc = (h) => ((h||"").replace(/<[^>]+>/g," ").match(/\S+/g)||[]).length;
const VER = new Set(["Strong","Distinct"]);
let ok = 0;
ledger.verifications = ledger.verifications || [];
for (const p of pubs) {
  if (!p.verify_code) continue;
  const row = {
    code: p.verify_code, user_id: p.user_id, title: p.title,
    author_name: p.author_name, author_username: p.author_username,
    content_hash: p.content_hash, word_count: wc(p.content),
    human_score: p.human_score, score_tier: p.score_tier, verified: VER.has(p.score_tier),
  };
  let { error: e } = await svc.from("verifications").upsert(row, { onConflict: "code", ignoreDuplicates: true });
  if (e && /doc_id/i.test(e.message)) {
    ({ error: e } = await svc.from("verifications").upsert({ ...row, doc_id: crypto.randomUUID() }, { onConflict: "code", ignoreDuplicates: true }));
  }
  if (e) { console.log("✗", p.title, e.message); continue; }
  if (!ledger.verifications.includes(p.verify_code)) ledger.verifications.push(p.verify_code);
  ok++;
}
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
console.log(`✓ ${ok}/${pubs.length} verification rows written; ledger updated`);
