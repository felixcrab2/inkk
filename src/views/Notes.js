// Notes — an index of your writing.
//
// One serif for the words, one sans for the furniture, and as little furniture
// as possible: a heading, the list, and a quiet footer. Notes live on this
// device; an account only adds sync, certification and the research controls.

import { useEffect, useState } from "react";
import { DropCapAvatar } from "../components/DropCapAvatar";
import { PrivacyModal, TermsModal } from "../components/Legal";
import { stripHtml, docTitle, wordCount } from "../lib/docs";
import { fetchMyContribution, upsertProfile, generateUniqueUsername } from "../lib/profile";
import { flushNow as syncFlushNow } from "../telemetry/sync";
import { countForUser as countLocalEvents } from "../telemetry/store";

// "Today", "Yesterday", "12 March", "12 March 2025".
function whenLabel(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

export function NotesView({
  user, profile, docs, activeId, dropCapImages,
  onSignIn, onCreateAccount, onSignOut,
  onOpenDoc, onNewDoc, onDeleteDoc, onDownloadDoc, onCertifyDoc, onOpenVerify,
  researchOptIn, onToggleOptIn, onDownloadData, onDeleteData,
  onChangePassword, onProfileUpdate,
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmData, setConfirmData]   = useState(false);
  const [optBusy, setOptBusy]           = useState(false);
  const [dataBusy, setDataBusy]         = useState(false);
  const [showPrivacy, setShowPrivacy]   = useState(false);
  const [showTerms, setShowTerms]       = useState(false);
  const [contribution, setContribution] = useState(null);
  const [pendingLocal, setPendingLocal] = useState(0);
  const [editing, setEditing]           = useState(false);
  const [editName, setEditName]         = useState("");
  const [saving, setSaving]             = useState(false);
  const [editError, setEditError]       = useState("");

  // Research contribution: synced total plus what is still queued here, so a
  // stalled upload is visible instead of looking like a frozen number.
  useEffect(() => {
    if (!user || !researchOptIn) { setContribution(null); setPendingLocal(0); return; }
    let alive = true;
    const refresh = async () => {
      try { syncFlushNow?.(); } catch {}
      const [contrib, pending] = await Promise.all([fetchMyContribution(user.id), countLocalEvents(user.id)]);
      if (!alive) return;
      if (contrib) setContribution(contrib);
      setPendingLocal(pending || 0);
    };
    refresh();
    const id = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [user, researchOptIn]);

  const notes = (docs || [])
    .filter(d => stripHtml(d.content).trim().length > 0 || stripHtml(d.title || "").trim().length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const name = profile?.display_name || profile?.username || user?.email?.split("@")[0] || "";
  const initial = (profile?.username?.[0] || user?.email?.[0] || "i");

  const startEdit = () => { setEditName(profile?.display_name || ""); setEditError(""); setEditing(true); };
  const saveEdit = async () => {
    const newName = editName.trim();
    setSaving(true); setEditError("");
    const handle = profile?.username || await generateUniqueUsername(user.email?.split("@")[0] || "writer");
    const err = await upsertProfile(user.id, handle, newName || null);
    setSaving(false);
    if (err) { setEditError(err); return; }
    onProfileUpdate?.({ ...profile, username: handle, display_name: newName || null });
    setEditing(false);
  };

  const contributed = (Number(contribution?.event_count) || 0) + pendingLocal;

  return (
    <div id="profile-container" className="nt">
      <div className="nt-inner">
        <header className="nt-head">
          <div className="nt-headline">
            <h1 className="nt-title">Notes</h1>
            <button className="nt-new" onClick={onNewDoc}>New note</button>
          </div>
          {user && (
            <button className="nt-who" onClick={startEdit} title="Change your name">
              <DropCapAvatar letter={initial} dropCapImages={dropCapImages} size={30} />
              <span className="nt-who-name">{name}</span>
            </button>
          )}
        </header>

        {notes.length === 0 ? (
          <p className="nt-empty">Nothing here yet. <button className="nt-link" onClick={onNewDoc}>Start writing</button></p>
        ) : (
          <ol className="nt-list">
            {notes.map((d) => {
              const title = stripHtml(d.title || "") || docTitle(d.content);
              const wc = wordCount(d.content);
              const confirming = confirmDeleteId === d.id;
              return (
                <li key={d.id} className={`nt-row${d.id === activeId ? " is-open" : ""}`}>
                  <button className="nt-open" onClick={() => onOpenDoc(d.id)}>
                    <span className="nt-row-title">{title || "Untitled"}</span>
                    <span className="nt-row-meta">
                      {whenLabel(d.updatedAt)} · {wc.toLocaleString()} {wc === 1 ? "word" : "words"}
                      {d.verifyCode && <> · <span className="nt-certified">certified</span></>}
                    </span>
                  </button>
                  {!confirming ? (
                    <span className="nt-row-actions">
                      {d.verifyCode
                        ? <button className="nt-act" onClick={() => onOpenVerify?.(d.verifyCode)}>Code</button>
                        : (wc > 0 && <button className="nt-act" onClick={() => onCertifyDoc(d.id)}>Certify</button>)}
                      {wc > 0 && <button className="nt-act" onClick={() => onDownloadDoc(d.id)}>Download</button>}
                      <button className="nt-act" onClick={() => setConfirmDeleteId(d.id)}>Delete</button>
                    </span>
                  ) : (
                    <span className="nt-row-actions is-confirm">
                      <span className="nt-confirm-q">Delete this note?</span>
                      <button className="nt-act" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                      <button className="nt-act is-danger" onClick={() => { onDeleteDoc(d.id); setConfirmDeleteId(null); }}>Delete</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <footer className="nt-foot">
          {!user ? (
            <p className="nt-foot-line">
              Notes stay on this device. <button className="nt-link" onClick={onSignIn}>Sign in</button> to keep them across devices and to certify them,
              or <button className="nt-link" onClick={onCreateAccount || onSignIn}>create an account</button>.
            </p>
          ) : (
            <>
              <div className="nt-research">
                <label className="nt-switch">
                  <input
                    type="checkbox"
                    checked={!!researchOptIn}
                    disabled={optBusy}
                    onChange={async (e) => { setOptBusy(true); await onToggleOptIn(e.target.checked); setOptBusy(false); }}
                  />
                  <span className="nt-switch-track" aria-hidden="true"><span className="nt-switch-thumb" /></span>
                  <span className="nt-switch-label">
                    {researchOptIn ? "Sharing your writing rhythm with the study" : "Not sharing your writing rhythm with the study"}
                  </span>
                </label>
                {researchOptIn && contributed > 0 && (
                  <p className="nt-foot-line nt-research-count">
                    {contributed.toLocaleString()} events contributed{pendingLocal > 0 ? ", uploading" : ""}.
                    {" "}<button className="nt-link" onClick={onDownloadData}>Download my data</button>
                    {" · "}
                    {!confirmData
                      ? <button className="nt-link" onClick={() => setConfirmData(true)}>Delete my data</button>
                      : <>
                          <span>Delete everything captured?</span>{" "}
                          <button className="nt-link" onClick={() => setConfirmData(false)}>Keep</button>{" · "}
                          <button className="nt-link is-danger" disabled={dataBusy} onClick={async () => { setDataBusy(true); await onDeleteData(); setDataBusy(false); setConfirmData(false); }}>
                            {dataBusy ? "Deleting…" : "Delete"}
                          </button>
                        </>}
                  </p>
                )}
              </div>
              <p className="nt-foot-line nt-account">
                <button className="nt-link" onClick={onChangePassword}>Change password</button>
                {" · "}
                <button className="nt-link" onClick={onSignOut}>Sign out</button>
              </p>
            </>
          )}
          <p className="nt-foot-line nt-legal">
            <button className="nt-link" onClick={() => setShowPrivacy(true)}>Privacy</button>
            {" · "}
            <button className="nt-link" onClick={() => setShowTerms(true)}>Terms</button>
            {" · "}
            <a className="nt-link" href="mailto:hello@inkk.site?subject=Hello%20inkk">hello@inkk.site</a>
          </p>
        </footer>
      </div>

      {editing && (
        <div className="pe-overlay" onClick={() => { if (!saving) setEditing(false); }}>
          <div className="pe-modal" onClick={e => e.stopPropagation()}>
            <h2 className="pe-title">Your name</h2>
            <p className="pe-body">The byline on downloaded pages and the author on certificates.</p>
            <label className="pe-field">
              <input
                className="pe-input"
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                placeholder="How you'd like to be credited"
                maxLength={50}
                autoFocus
              />
            </label>
            {profile?.username && <p className="pe-body">Your handle stays @{profile.username}.</p>}
            {editError && <p className="pe-error">{editError}</p>}
            <div className="pe-actions">
              <button className="pe-btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              <button className="pe-btn pe-btn-primary" onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
      {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
    </div>
  );
}
