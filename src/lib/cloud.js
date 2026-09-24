import { supabase } from "../supabase";

// The cloud copy of a note lives in the `documents` table. `title` is a recent
// column (docs/backend-changes-2026-09.md §5); until it exists on a given
// project we fall back to the older column list, so an un-migrated database
// still syncs everything except titles.
const COLS_WITH_TITLE = "id, title, content, updated_at, total_writing_secs, revision_count, keystrokes, deletions, pastes, human_score, score_tier, score_features, verify_code, content_hash";
const COLS_LEGACY     = "id, content, updated_at, total_writing_secs, revision_count, keystrokes, deletions, pastes, human_score, score_tier, score_features, verify_code, content_hash";
let titleColumn = true;
const missingTitle = (error) => !!error && /title/i.test(error.message || "") && /column|schema/i.test(error.message || "");

function rowToDoc(r) {
  return {
    id: r.id,
    title: r.title ?? "",
    content: r.content,
    updatedAt: new Date(r.updated_at).getTime(),
    writingTimeSecs: r.total_writing_secs ?? 0,
    revisionCount: r.revision_count ?? 0,
    keystrokes: r.keystrokes ?? 0,
    deletions: r.deletions ?? 0,
    pastes: r.pastes ?? 0,
    humanScore: r.human_score,
    scoreTier: r.score_tier,
    scoreFeatures: r.score_features || null,
    verifyCode: r.verify_code ?? null,
    contentHash: r.content_hash ?? null,
  };
}

export async function fetchCloudDocs() {
  if (!supabase) return [];
  let { data, error } = await supabase.from("documents").select(titleColumn ? COLS_WITH_TITLE : COLS_LEGACY);
  if (missingTitle(error)) {
    titleColumn = false;
    ({ data, error } = await supabase.from("documents").select(COLS_LEGACY));
  }
  if (error || !data) return [];
  return data.map(rowToDoc);
}

// A note may live on another device: pull it down
// before editing rather than silently showing whatever draft was already open.
export async function fetchCloudDoc(docId) {
  if (!supabase) return null;
  let { data: r, error } = await supabase
    .from("documents").select(titleColumn ? COLS_WITH_TITLE : COLS_LEGACY).eq("id", docId).maybeSingle();
  if (missingTitle(error)) {
    titleColumn = false;
    ({ data: r } = await supabase.from("documents").select(COLS_LEGACY).eq("id", docId).maybeSingle());
  }
  return r ? rowToDoc(r) : null;
}

// Upsert the WHOLE note. Callers must pass a complete doc object (not a
// partial {id, content}), because every column is written and a partial would
// zero the metrics and null the certificate on the cloud copy.
export async function pushDocToCloud(doc, userId) {
  if (!supabase || !userId) return;
  const row = {
    id: doc.id, user_id: userId,
    content: doc.content,
    updated_at: new Date(doc.updatedAt).toISOString(),
    total_writing_secs: doc.writingTimeSecs || 0,
    revision_count:     doc.revisionCount  || 0,
    keystrokes:         doc.keystrokes     || 0,
    deletions:          doc.deletions      || 0,
    pastes:             doc.pastes         || 0,
    human_score:        doc.humanScore     ?? null,
    score_tier:         doc.scoreTier      ?? null,
    score_features:     doc.scoreFeatures  ?? null,
    verify_code:        doc.verifyCode     ?? null,
    content_hash:       doc.contentHash    ?? null,
  };
  if (titleColumn) row.title = doc.title ?? "";
  const { error } = await supabase.from("documents").upsert(row);
  if (missingTitle(error)) {
    titleColumn = false;
    delete row.title;
    await supabase.from("documents").upsert(row);
  }
}

export async function deleteDocFromCloud(docId) {
  if (!supabase) return;
  await supabase.from("documents").delete().eq("id", docId);
}

// Newest copy wins per note. A cloud copy without a title (older rows, or a
// database that hasn't grown the column yet) never erases a title this device
// already knows.
export function mergeDocs(local, cloud) {
  const map = new Map();
  for (const doc of local) map.set(doc.id, doc);
  for (const doc of cloud) {
    const existing = map.get(doc.id);
    if (!existing) { map.set(doc.id, doc); continue; }
    if (doc.updatedAt > existing.updatedAt) {
      map.set(doc.id, (!doc.title && existing.title) ? { ...doc, title: existing.title } : doc);
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
