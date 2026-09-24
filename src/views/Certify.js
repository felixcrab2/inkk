// Certify — the right-hand tab.
//
// Two halves. The top is the note you are writing: its code, its signal, and
// whether its words are still the ones certified. The bottom is for readers:
// a code, or a document dropped on the page, is looked up in the ledger and
// the text is checked against the certificate, sentence by sentence, in this
// browser. Nothing a reader pastes or drops leaves their machine; only the
// code is looked up.

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../supabase";
import { parseVerifyCode, sha256hex, sealUrl } from "../verify/code";
import { compareText } from "../verify/sketch";
import { readFile } from "../lib/filestamp";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// The public certificate for a code: the /api/verify route, or the database
// function behind it where the route isn't deployed yet.
async function fetchCert(code) {
  try {
    const res = await fetch(`/api/verify?code=${encodeURIComponent(code)}`);
    if ((res.headers.get("content-type") || "").includes("json")) {
      const out = await res.json();
      if (res.ok && out.ok) return { cert: out.cert };
      if (res.status === 404 && out.error === "not_found") return { cert: null };
    }
  } catch { /* fall through */ }
  if (!supabase) return { error: "offline" };
  const { data, error } = await supabase.rpc("verify_by_code", { p_code: code });
  if (error) return { error: "error" };
  const row = Array.isArray(data) ? data[0] : data;
  return { cert: row || null };
}

function matchLine(m) {
  if (!m) return null;
  if (m.state === "match") return "The text matches the certificate.";
  if (m.state === "partial") return `${Math.round((m.ratio || 0) * 100)}% of the certified sentences are here unchanged.`;
  if (m.state === "differs") return "The text doesn't match the certificate.";
  return "This certificate can't be compared with text.";
}

function Certificate({ cert, text, onText, fileName }) {
  const [match, setMatch] = useState(null);

  useEffect(() => {
    if (!text || !text.trim()) { setMatch(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const m = await compareText({ contentHash: cert.content_hash, sketch: cert.text_sketch }, text, sha256hex);
        if (live) setMatch(m);
      } catch { if (live) setMatch({ state: "unknown" }); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [text, cert.content_hash, cert.text_sketch]);

  const verified = !!cert.verified;
  return (
    <section className="cert">
      <dl className="facts">
        <dt>Status</dt><dd className="strong">{verified ? "Verified" : "Recorded"}</dd>
        {cert.score_tier && (<><dt>Signal</dt><dd>{cert.score_tier}{cert.human_score != null ? `, ${cert.human_score}` : ""}</dd></>)}
        {cert.title && (<><dt>Title</dt><dd className="writer">{cert.title}</dd></>)}
        {(cert.author_name || cert.author_username) && (<><dt>Author</dt><dd>{cert.author_name || `@${cert.author_username}`}</dd></>)}
        <dt>Certified</dt><dd>{fmtDate(cert.issued_at)}</dd>
        {cert.word_count ? (<><dt>Length</dt><dd>{cert.word_count.toLocaleString()} words</dd></>) : null}
        <dt>Code</dt><dd className="mono">{cert.code}</dd>
      </dl>
      <p className="cert-about">
        {verified
          ? "inkk recorded a person writing this: the rhythm, pauses and corrections of someone typing."
          : "inkk recorded this being written, though its writing signal stayed below the verified level."}
      </p>
      <div className="check-text">
        <label className="label" htmlFor="check-text">{fileName ? `Text of ${fileName}` : "Check the text"}</label>
        <textarea
          id="check-text"
          className="field"
          placeholder="Paste the text you received"
          value={text}
          onChange={e => onText(e.target.value)}
          rows={4}
        />
        {match && <p className={`check-result${match.state === "match" ? " strong" : ""}`}>{matchLine(match)}</p>}
      </div>
    </section>
  );
}

function NoteSection({ note, user, certifying, onCertify, onSignIn, onWrite, onToast }) {
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => onToast?.(`${what} copied`));
  if (!note) {
    return (
      <section className="note-cert">
        <p className="page-empty">Nothing to certify yet. <button className="text-btn is-ink" onClick={onWrite}>Write something</button></p>
      </section>
    );
  }
  const current = note.verifyCode && !note.stale;
  return (
    <section className="note-cert">
      <dl className="facts">
        <dt>Note</dt><dd className="writer">{note.title || "Untitled"}</dd>
        {current && (<><dt>Code</dt><dd className="code">{note.verifyCode}</dd></>)}
        {current && (<><dt>Signal</dt><dd>{note.verifiedTier ? "Verified" : "Recorded"}{note.humanScore != null ? `, ${note.humanScore}` : ""}</dd></>)}
        <dt>{current ? "Bound to" : "Length"}</dt><dd>{note.words.toLocaleString()} {note.words === 1 ? "word" : "words"}</dd>
        {note.verifyCode && note.stale && (<><dt>Status</dt><dd>Changed since it was certified</dd></>)}
      </dl>
      <div className="actions">
        {current ? (
          <>
            <button className="btn btn-primary" onClick={() => copy(note.verifyCode, "Code")}>Copy code</button>
            <button className="btn" onClick={() => copy(`inkk. ${sealUrl(note.verifyCode).replace("https://", "")}`, "Seal")}>Copy seal</button>
          </>
        ) : user ? (
          <button className="btn btn-primary" onClick={onCertify} disabled={certifying}>{certifying ? "Certifying" : note.verifyCode ? "Certify again" : "Certify"}</button>
        ) : (
          <button className="btn btn-primary" onClick={onSignIn}>Sign in to certify</button>
        )}
      </div>
    </section>
  );
}

export function CertifyView({ initialCode = "", onStatus, user, note, certifying, onCertify, onSignIn, onWrite, onToast }) {
  const [input, setInput]   = useState(initialCode);
  const [status, setStatus] = useState("idle"); // idle | loading | found | notfound | invalid | nocode | offline | error
  const [cert, setCert]     = useState(null);
  const [text, setText]     = useState("");
  const [fileName, setFileName] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  const lookup = useCallback(async (raw) => {
    const code = parseVerifyCode(raw);
    if (!code) { setStatus("invalid"); setCert(null); return; }
    setStatus("loading"); setCert(null);
    const r = await fetchCert(code);
    if (r.error) { setStatus(r.error); return; }
    if (!r.cert) { setStatus("notfound"); return; }
    setCert(r.cert); setStatus("found");
  }, []);

  useEffect(() => {
    if (initialCode && parseVerifyCode(initialCode)) { setInput(initialCode); lookup(initialCode); }
  }, [initialCode, lookup]);

  const takeFile = useCallback(async (file) => {
    if (!file) return;
    setFileName(file.name);
    try {
      const r = await readFile(file);
      setText(r.text || "");
      if (r.code) { setInput(r.code); lookup(r.code); }
      else { setCert(null); setStatus("nocode"); }
    } catch {
      setCert(null); setStatus("nocode");
    }
  }, [lookup]);

  const submit = (e) => { e.preventDefault(); setFileName(null); lookup(input); };

  return (
    <div
      id="verify-view"
      className={`page${dragging ? " is-dropping" : ""}`}
      onDragOver={e => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); takeFile(e.dataTransfer?.files?.[0]); }}
    >
      <div className="page-inner">
        <header className="page-head"><h1>Certify</h1></header>

        {!initialCode && (
          <NoteSection note={note} user={user} certifying={certifying} onCertify={onCertify} onSignIn={onSignIn} onWrite={onWrite} onToast={onToast} />
        )}

        <section className="lookup">
          <h2>Check a code</h2>
          <form className="lookup-form" onSubmit={submit}>
            <input
              className="field"
              placeholder="INKK-XXXX-XXXX-XXXX"
              value={input}
              onChange={e => setInput(e.target.value)}
              spellCheck={false}
              autoCapitalize="characters"
              aria-label="Certificate code"
            />
            <button className="btn" type="submit" disabled={status === "loading"}>{status === "loading" ? "Checking" : "Check"}</button>
          </form>
          <p className="lookup-hint">
            Or drop a document here. <button className="text-btn" onClick={() => fileRef.current?.click()}>Choose a file</button>
            <input ref={fileRef} type="file" hidden accept=".docx,.pdf,.png,.txt,.md,.html,.htm" onChange={e => takeFile(e.target.files?.[0])} />
          </p>

          {status === "invalid"  && <p className="msg">That isn't an inkk code. Codes look like INKK-7F3A-9K2D-XQ4M.</p>}
          {status === "notfound" && <p className="msg">No certificate has that code.</p>}
          {status === "nocode"   && <p className="msg">{fileName ? `${fileName} doesn't carry an inkk code.` : "No inkk code found."}</p>}
          {status === "offline"  && <p className="msg">Checking needs a connection.</p>}
          {status === "error"    && <p className="msg">The ledger didn't answer. Try again in a moment.</p>}
        </section>

        {status === "found" && cert && <Certificate cert={cert} text={text} onText={setText} fileName={fileName} />}

        {initialCode && note && (
          <NoteSection note={note} user={user} certifying={certifying} onCertify={onCertify} onSignIn={onSignIn} onWrite={onWrite} onToast={onToast} />
        )}
      </div>
    </div>
  );
}
