// Verification view — paste a code, confirm a piece's human-signal certificate.
//
// The code is a lookup handle: we ask inkk's ledger (a security-definer RPC, so
// this works for logged-out readers checking an exported PDF) and report what
// inkk recorded. Optionally, a reader can paste the text they're holding and we
// confirm its fingerprint matches the certified original — without inkk ever
// storing a copy of the text.

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { parseVerifyCode, hashContent } from "../verify/code";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

function Certificate({ cert, onOpenPiece }) {
  const [sample, setSample]   = useState("");
  const [match, setMatch]     = useState(null);   // null | "match" | "differ" | "unavailable"
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
        <span className="verify-cert-diamond" aria-hidden="true">◇</span>
        <span className="verify-cert-status">
          {verified ? "Human-verified" : "Recorded in inkk"}
        </span>
      </div>
      <p className="verify-cert-lead">
        {verified
          ? "inkk recorded a strong human writing process for this piece — the rhythm, pauses and revisions of a person writing by hand."
          : "This piece was written in inkk, but its human signal didn’t reach the verified threshold."}
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

      {cert.publication_id && (
        <button className="verify-read-btn" onClick={() => onOpenPiece(cert.publication_id)}>
          Read the piece →
        </button>
      )}

      <details className="verify-match">
        <summary>Have a copy of the text? Check it matches.</summary>
        <p className="verify-match-hint">
          Paste the body text you’re holding. We compare its fingerprint to the certified
          original — nothing you paste is stored or sent.
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
        {!checking && match === "differ" && <p className="verify-match-result no">This text differs from the certified original — it may have been edited.</p>}
        {!checking && match === "unavailable" && <p className="verify-match-result no">Couldn’t compute a fingerprint in this browser.</p>}
      </details>
    </div>
  );
}

export function VerifyView({ initialCode = "", onOpenPiece, onBrowse }) {
  const [input, setInput]   = useState(initialCode);
  const [status, setStatus] = useState("idle"); // idle|loading|found|notfound|invalid|offline|error
  const [cert, setCert]     = useState(null);

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
    if (initialCode && parseVerifyCode(initialCode)) lookup(initialCode);
  }, [initialCode, lookup]);

  const submit = (e) => { e.preventDefault(); lookup(input); };

  return (
    <div id="verify-view">
      <div id="verify-inner">
        <div className="verify-masthead">
          <span className="verify-eyebrow">Authenticity</span>
          <h1 className="verify-title">Verify a piece</h1>
          <p className="verify-sub">
            Every piece written in inkk carries a code. Paste it below to see what inkk
            recorded about how it was written.
          </p>
        </div>

        <form className="verify-form" onSubmit={submit}>
          <input
            className="verify-input"
            placeholder="INKK-XXXX-XXXX-XXXX"
            value={input}
            onChange={e => setInput(e.target.value)}
            autoFocus
            spellCheck={false}
            autoCapitalize="characters"
          />
          <button className="verify-submit" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "…" : "Verify"}
          </button>
        </form>

        {status === "invalid" && <p className="verify-msg verify-msg-warn">That doesn’t look like an inkk code. It should read like <span className="mono">INKK-XXXX-XXXX-XXXX</span>.</p>}
        {status === "notfound" && <p className="verify-msg verify-msg-warn">No certificate matches that code. Check for a typo, or the piece may have been removed.</p>}
        {status === "offline" && <p className="verify-msg verify-msg-warn">Verification needs a connection to inkk.</p>}
        {status === "error" && <p className="verify-msg verify-msg-warn">Something went wrong looking that up. Try again in a moment.</p>}

        {status === "found" && cert && <Certificate cert={cert} onOpenPiece={onOpenPiece} />}

        <div className="verify-foot">
          <button className="verify-link" onClick={onBrowse}>← Back to inkk</button>
        </div>
      </div>
    </div>
  );
}
