// Certify — the right-hand tab.
//
// Two halves. The top is about the note you are writing: certify it, see its
// code, notice when the text has drifted from what was certified. The bottom
// is for readers: paste any inkk code and see what the ledger recorded. The
// lookup is a security-definer RPC, so it works for logged-out readers checking
// an exported PDF. Optionally a reader pastes the text they are holding and we
// confirm its fingerprint matches — without inkk ever storing a copy.

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { parseVerifyCode, hashContent } from "../verify/code";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

function Certificate({ cert }) {
  const [sample, setSample]     = useState("");
  const [match, setMatch]       = useState(null);   // null | "match" | "differ" | "unavailable"
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const text = sample.trim();
    if (!text) { setMatch(null); return; }
    let live = true;
    setChecking(true);
    hashContent(text).then(h => {
      if (!live) return;
      setChecking(false);
      if (!h || !cert.content_hash) setMatch("unavailable");
      else setMatch(h === cert.content_hash ? "match" : "differ");
    });
    return () => { live = false; };
  }, [sample, cert.content_hash]);

  const verified = !!cert.verified;

  return (
    <div className="verify-cert">
      <div className={`verify-cert-mark ${verified ? "is-verified" : ""}`}>
        <span className="verify-cert-status">
          {verified ? "Human-verified" : "Recorded in inkk"}
        </span>
      </div>
      <p className="verify-cert-lead">
        {verified
          ? "inkk recorded a strong human writing process for this piece. The rhythm, pauses and revisions were those of a person typing by hand."
          : "This piece was written with inkk, but its human signal didn’t reach the verified threshold."}
      </p>

      <dl className="verify-cert-fields">
        {cert.title && (<><dt>Title</dt><dd>{cert.title}</dd></>)}
        {cert.author_name && (<><dt>Author</dt><dd>{cert.author_name}{cert.author_username ? ` · @${cert.author_username}` : ""}</dd></>)}
        <dt>Certified</dt><dd>{fmtDate(cert.issued_at)}</dd>
        <dt>Human signal</dt>
        <dd>
          <span className="verify-cert-tier">{cert.score_tier || "—"}</span>
          {cert.human_score != null && <span className="verify-cert-score">{cert.human_score}<span className="verify-cert-score-denom">/100</span></span>}
        </dd>
        {cert.word_count != null && (<><dt>Length</dt><dd>{cert.word_count.toLocaleString()} words</dd></>)}
        <dt>Code</dt><dd className="verify-cert-code">{cert.code}</dd>
      </dl>

      <p className="verify-cert-private">
        The certificate binds one exact text. Check it matches your copy below.
      </p>

      <details className="verify-match">
        <summary>Have a copy of the text? Check it matches.</summary>
        <p className="verify-match-hint">
          Paste the body of text here. We compare it to the certified original. Nothing
          you paste is ever stored or shared.
        </p>
        <textarea
          className="verify-match-input"
          placeholder="Paste the text…"
          value={sample}
          onChange={e => setSample(e.target.value)}
          rows={5}
        />
        {checking && <p className="verify-match-result checking">checking…</p>}
        {!checking && match === "match"  && <p className="verify-match-result ok">✓ This text matches the certified original.</p>}
        {!checking && match === "differ" && <p className="verify-match-result no">This text differs from the certified original. It may have been edited.</p>}
        {!checking && match === "unavailable" && <p className="verify-match-result no">Couldn’t compute a fingerprint in this browser.</p>}
      </details>
    </div>
  );
}

// The active note's certification card. `note` is null when there is nothing
// to certify (no words yet); otherwise { id, title, words, verifyCode,
// verifiedTier, scoreTier, humanScore, stale }.
function NoteCard({ note, user, certifying, onCertify, onSignIn, onWrite, onLookup, onToast }) {
  const [copied, setCopied] = useState(false);
  const copy = (code) => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      onToast?.("Code copied.");
      setTimeout(() => setCopied(false), 1800);
    });
  };

  if (!note) {
    return (
      <section className="cert-note-card cert-note-empty">
        <span className="cert-note-label">This note</span>
        <p className="cert-note-text">Write something first, then come back here to certify it.</p>
        <button className="cert-note-btn" onClick={onWrite}>Write →</button>
      </section>
    );
  }

  const hasCode = !!note.verifyCode;
  const current = hasCode && !note.stale;

  return (
    <section className={`cert-note-card${current ? " is-certified" : ""}`}>
      <div className="cert-note-head">
        <span className="cert-note-label">This note</span>
        <span className="cert-note-title">{note.title || "Untitled"}</span>
        <span className="cert-note-meta">{note.words.toLocaleString()} {note.words === 1 ? "word" : "words"}</span>
      </div>

      {current && (
        <>
          <div className="cert-note-status">
            <span className={`cert-note-tier${note.verifiedTier ? " is-verified" : ""}`}>
              {note.verifiedTier ? "Human-verified" : "Certified"}
            </span>
            {note.scoreTier && (
              <span className="cert-note-score">
                {note.scoreTier}{note.humanScore != null ? ` · ${note.humanScore}/100` : ""}
              </span>
            )}
          </div>
          <button className="cert-note-code" title="Copy code" onClick={() => copy(note.verifyCode)}>
            {note.verifyCode}
            <span className="cert-note-copied">{copied ? "copied" : "copy"}</span>
          </button>
          <p className="cert-note-text">
            Paste the code wherever the piece goes. Anyone can check it here, and it stays private until you share it.
          </p>
          <div className="cert-note-actions">
            <button className="cert-note-btn" onClick={() => onLookup(note.verifyCode)}>Check this code</button>
            <button className="cert-note-btn cert-note-btn-ghost" onClick={onCertify} disabled={certifying}>
              {certifying ? "Certifying…" : "Re-certify"}
            </button>
          </div>
        </>
      )}

      {hasCode && note.stale && (
        <>
          <p className="cert-note-text">
            The text has changed since it was certified. Certify again to bind the current words to a fresh code.
          </p>
          <div className="cert-note-actions">
            <button className="cert-note-btn" onClick={onCertify} disabled={certifying}>
              {certifying ? "Certifying…" : "Re-certify"}
            </button>
            <button className="cert-note-btn cert-note-btn-ghost" onClick={() => onLookup(note.verifyCode)}>Old code</button>
          </div>
        </>
      )}

      {!hasCode && (
        <>
          <p className="cert-note-text">
            Not certified yet. A certificate records the rhythm of how this note was written and binds it to a code readers can check.
          </p>
          <div className="cert-note-actions">
            {user ? (
              <button className="cert-note-btn" onClick={onCertify} disabled={certifying}>
                {certifying ? "Certifying…" : "Certify this note"}
              </button>
            ) : (
              <>
                <button className="cert-note-btn" onClick={onSignIn}>Sign in to certify</button>
                <span className="cert-note-hint">Certificates live in inkk’s ledger, so this needs an account.</span>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function CertifyView({ initialCode = "", onStatus, user, note, certifying, onCertify, onSignIn, onWrite, onToast }) {
  const [input, setInput]   = useState(initialCode);
  const [status, setStatus] = useState("idle"); // idle|loading|found|notfound|invalid|offline|error
  const [cert, setCert]     = useState(null);

  // Let the shell react to the view's state (the backdrop wraps the intro
  // box in a ring until a certificate expands the page).
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  const lookup = useCallback(async (raw) => {
    const code = parseVerifyCode(raw);
    if (!code) { setStatus("invalid"); setCert(null); return; }
    if (!supabase) { setStatus("offline"); setCert(null); return; }
    setStatus("loading"); setCert(null);
    const { data, error } = await supabase.rpc("verify_by_code", { p_code: code });
    if (error) { setStatus("error"); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { setStatus("notfound"); return; }
    setCert(row); setStatus("found");
  }, []);

  // Auto-lookup when arriving via a /v/<code> deep link (e.g. from a PDF).
  useEffect(() => {
    if (initialCode && parseVerifyCode(initialCode)) { setInput(initialCode); lookup(initialCode); }
  }, [initialCode, lookup]);

  const lookupAndScroll = useCallback((code) => {
    setInput(code);
    lookup(code);
    // Bring the certificate into view once it renders.
    setTimeout(() => document.querySelector(".verify-cert")?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }, [lookup]);

  const submit = (e) => { e.preventDefault(); lookup(input); };

  return (
    <div id="verify-view" className="certify-view">
      <div id="verify-inner">
        <div className="verify-masthead">
          <span className="verify-eyebrow">Authenticity</span>
          <h1 className="verify-title">Certify</h1>
          <p className="verify-sub">
            A certificate proves a piece was written by hand: the rhythm, pauses and
            revisions of a person typing. inkk keeps only a fingerprint of the text, never the words.
          </p>
        </div>

        {/* A reader arriving from a PDF or a shared code (/v/<code>) wants the
            certificate, not a card about a note they never wrote: the lookup
            leads and the writer's card waits below it. In-app, the note comes first. */}
        {!initialCode && (
          <NoteCard
            note={note}
            user={user}
            certifying={certifying}
            onCertify={onCertify}
            onSignIn={onSignIn}
            onWrite={onWrite}
            onLookup={lookupAndScroll}
            onToast={onToast}
          />
        )}

        <div className="verify-section-label">Verify a code</div>
        <form className="verify-form" onSubmit={submit}>
          <input
            className="verify-input"
            placeholder="INKK-XXXX-XXXX-XXXX"
            value={input}
            onChange={e => setInput(e.target.value)}
            spellCheck={false}
            autoCapitalize="characters"
            aria-label="Verification code"
          />
          <button className="verify-submit" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "…" : "Verify"}
          </button>
        </form>

        {status === "invalid" && <p className="verify-msg verify-msg-warn">That doesn’t look like an inkk code. It should read like <span className="mono">INKK-XXXX-XXXX-XXXX</span>.</p>}
        {status === "notfound" && <p className="verify-msg verify-msg-warn">No certificate matches that code. Check for a typo.</p>}
        {status === "offline" && <p className="verify-msg verify-msg-warn">Verification needs a connection to inkk.</p>}
        {status === "error" && <p className="verify-msg verify-msg-warn">Something went wrong looking that up. Try again in a moment.</p>}

        {status === "found" && cert && <Certificate cert={cert} />}

        {initialCode && note && (
          <div className="cert-note-after">
            <NoteCard
              note={note}
              user={user}
              certifying={certifying}
              onCertify={onCertify}
              onSignIn={onSignIn}
              onWrite={onWrite}
              onLookup={lookupAndScroll}
              onToast={onToast}
            />
          </div>
        )}
      </div>
    </div>
  );
}
