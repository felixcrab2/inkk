import { supabase } from "../supabase";
import { makeVerifyCode, hashContent, isVerifiedTier, normalizePlainText } from "../verify/code";
import { wordCount } from "../lib/docs";

// Ask the server-side /api/certify endpoint to recompute the human-signal score
// from the doc's keystroke trace and write the certificate. The browser is NOT
// trusted to assert its own score (the columns are locked in schema.sql §9), so
// this is the only path that yields a *verified* certificate. Returns the
// server's verdict, or null when the route is unavailable — the caller then
// falls back to the legacy direct write (unverified once the lock is applied).
export async function certifyViaServer({ docId, code, events, contentHash, wordCount: wc, charCount, title, authorName, authorUsername }) {
  if (!supabase) return null;
  try {
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    if (!token) return null;
    const res = await fetch("/api/certify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ docId, code, events: events || [], contentHash, wordCount: wc, charCount, title, authorName, authorUsername }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.ok !== false) ? data : null;
  } catch { return null; }
}

// Fallback for when /api/certify is unreachable: the previous client-side write.
// Pre-migration this still records the client's score; once schema.sql §9 is
// applied the score/verified columns are forced null/false on a client insert,
// so a route outage degrades to an UNVERIFIED certificate rather than a forgeable
// one. Idempotent (the ledger row for a code is immutable).
export async function writeCertFallback({ code, doc, user, title, authorName, authorUsername, contentHash }) {
  const verified = isVerifiedTier(doc.scoreTier);
  const { error } = await supabase.from("verifications").upsert({
    code, doc_id: doc.id, user_id: user.id,
    title: title ?? null, author_name: authorName ?? null, author_username: authorUsername || null,
    content_hash: contentHash, word_count: wordCount(doc.content),
    human_score: doc.humanScore ?? null, score_tier: doc.scoreTier ?? null, verified,
  }, { onConflict: "code", ignoreDuplicates: true });
  return { error, verified };
}

// Ensure the document's current text has a certificate, minting one if needed.
// This is the verification primitive. Returns
// { code, verified, contentHash, isNew } (code null when hashing is unavailable).
//
// The code is bound to the text: if the doc already carries a code for this
// exact hash we reuse it; otherwise we mint a fresh one and append an immutable
// row to the ledger, so old codes keep verifying the older text.
// Shared certificate write: ask /api/certify to (re)compute the score from the
// keystroke trace and write the ledger row + stamp the live publication, with the
// legacy client write as the offline fallback. The caller passes the already-
// resolved code (reused or freshly minted) and content hash.
export async function issueCert({ doc, user, code, reuse, events, contentHash, title, authorName, authorUsername }) {
  // The server recomputes the score and writes the ledger row — the browser never
  // gets to assert its own number.
  const server = await certifyViaServer({
    docId: doc.id, code, events, contentHash,
    wordCount: wordCount(doc.content), charCount: normalizePlainText(doc.content).length, title, authorName, authorUsername,
  });
  if (server) {
    return { code, verified: !!server.verified, contentHash, isNew: !reuse };
  }
  // Route unavailable. A reused code's ledger row already exists; for a new one,
  // fall back to the legacy direct write (forced unverified once §9 is applied).
  if (reuse) {
    return { code, verified: isVerifiedTier(doc.scoreTier), contentHash, isNew: false };
  }
  const { error, verified } = await writeCertFallback({ code, doc, user, title, authorName, authorUsername, contentHash });
  if (error) return { code: doc.verifyCode || null, verified: isVerifiedTier(doc.scoreTier), contentHash: doc.contentHash || null, isNew: false, error: error.message };
  return { code, verified, contentHash, isNew: true };
}

export async function ensureCertificate(doc, user, { title, authorName, authorUsername }, events) {
  const contentHash = await hashContent(doc.content);
  if (!contentHash) {
    // No Web Crypto (e.g. insecure context) — can't bind a certificate.
    return { code: doc.verifyCode || null, verified: isVerifiedTier(doc.scoreTier), contentHash: doc.contentHash || null, isNew: false };
  }
  // Unchanged text reuses its existing code; new/changed text mints a fresh one.
  const reuse = !!(doc.verifyCode && doc.contentHash && doc.contentHash === contentHash);
  const code = reuse ? doc.verifyCode : makeVerifyCode();
  return issueCert({ doc, user, code, reuse, events, contentHash, title, authorName, authorUsername });
}


// ─── Profiles ─────────────────────────────────────────────────────────────────
