// Notes — an index of your writing.
//
// The writer's face for the titles, the system face for everything else, and
// as little else as possible: a heading, the list, a quiet footer. Notes live
// on this device; an account adds sync, certification and the study controls.

import { useEffect, useState } from "react";
import { PrivacyModal, TermsModal } from "../components/Legal";
import { stripHtml, docTitle, wordCount } from "../lib/docs";
import { fetchMyContribution, upsertProfile, generateUniqueUsername } from "../lib/profile";
import { flushNow as syncFlushNow } from "../telemetry/sync";
import { countForUser as countLocalEvents } from "../telemetry/store";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Today, 14:32", "Yesterday", "21 Sep", "21 Sep 2025".
function whenLabel(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return `Today, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff === 1) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

export function NotesView({
  user, profile, docs,
  onSignIn, onCreateAccount, onSignOut,
  onOpenDoc, onNewDoc, onDeleteDoc, onDownloadDoc, onCertifyDoc, onToast,
  researchOptIn, onToggleOptIn, onDownloadData, onDeleteData, onAboutResearch,
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
    <div id="profile-container" className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>Notes</h1>
          <button className="text-btn" onClick={onNewDoc}>New note</button>
        </header>

        {notes.length === 0 ? (
          <p className="page-empty">No notes yet. <button className="text-btn is-ink" onClick={onNewDoc}>Start writing</button></p>
        ) : (
          <ol className="note-list">
            {notes.map((d) => {
              const title = stripHtml(d.title || "") || docTitle(d.content);
              const wc = wordCount(d.content);
              const confirming = confirmDeleteId === d.id;
              return (
                <li key={d.id} className={`note-row${confirming ? " is-confirming" : ""}`}>
                  <button className="note-open" onClick={() => onOpenDoc(d.id)}>
                    <span className="note-title">{title || "Untitled"}</span>
                    <span className="note-meta">{wc.toLocaleString()} {wc === 1 ? "word" : "words"}{d.verifyCode ? <span className="note-cert">Certified</span> : null}</span>
                  </button>
                  <span className="note-when">{whenLabel(d.updatedAt)}</span>
                  {!confirming ? (
                    <span className="note-actions">
                      {d.verifyCode
                        ? <button className="text-btn" onClick={() => { navigator.clipboard?.writeText(d.verifyCode); onToast?.("Code copied"); }}>Copy code</button>
                        : (wc > 0 && <button className="text-btn" onClick={() => onCertifyDoc(d.id)}>Certify</button>)}
                      {wc > 0 && <button className="text-btn" onClick={() => onDownloadDoc(d.id)}>Download</button>}
                      <button className="text-btn" onClick={() => setConfirmDeleteId(d.id)}>Delete</button>
                    </span>
                  ) : (
                    <span className="note-actions is-shown">
                      <span className="note-confirm">Delete this note?</span>
                      <button className="text-btn" onClick={() => setConfirmDeleteId(null)}>Keep</button>
                      <button className="text-btn is-ink" onClick={() => { onDeleteDoc(d.id); setConfirmDeleteId(null); }}>Delete</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <footer className="page-foot">
          {!user ? (
            <div className="foot-row">
              <button className="text-btn" onClick={onSignIn}>Sign in to keep notes on every device</button>
            </div>
          ) : (
            <>
              <div className="foot-row">
                <button className="text-btn is-ink" onClick={startEdit}>{name}</button>
                <button className="text-btn" onClick={onChangePassword}>Change password</button>
                <button className="text-btn" onClick={onSignOut}>Sign out</button>
              </div>
              <div className="foot-row">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!researchOptIn}
                    disabled={optBusy}
                    onChange={async (e) => { setOptBusy(true); await onToggleOptIn(e.target.checked); setOptBusy(false); }}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span>Share my writing rhythm with the study</span>
                </label>
                <button className="text-btn" onClick={onAboutResearch}>About the study</button>
              </div>
              {researchOptIn && contributed > 0 && (
                <div className="foot-row">
                  <span className="foot-quiet">{contributed.toLocaleString()} events shared{pendingLocal > 0 ? ", uploading" : ""}</span>
                  <button className="text-btn" onClick={onDownloadData}>Download my data</button>
                  {!confirmData
                    ? <button className="text-btn" onClick={() => setConfirmData(true)}>Delete my data</button>
                    : <>
                        <span className="foot-quiet">Delete everything shared?</span>
                        <button className="text-btn" onClick={() => setConfirmData(false)}>Keep</button>
                        <button className="text-btn is-ink" disabled={dataBusy} onClick={async () => { setDataBusy(true); await onDeleteData(); setDataBusy(false); setConfirmData(false); }}>
                          {dataBusy ? "Deleting" : "Delete"}
                        </button>
                      </>}
                </div>
              )}
            </>
          )}
          <div className="foot-row">
            <button className="text-btn" onClick={() => setShowPrivacy(true)}>Privacy</button>
            <button className="text-btn" onClick={() => setShowTerms(true)}>Terms</button>
            <a className="text-btn" href="mailto:hello@inkk.site?subject=Hello%20inkk">hello@inkk.site</a>
          </div>
        </footer>
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => { if (!saving) setEditing(false); }}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); saveEdit(); }}>
            <div className="modal-head"><h2>Your name</h2></div>
            <input
              className="field"
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Name"
              maxLength={50}
              autoFocus
            />
            <p className="modal-note">Shown on your downloads and certificates.</p>
            {editError && <p className="modal-error">{editError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving" : "Save"}</button>
            </div>
          </form>
        </div>
      )}

      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
      {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
    </div>
  );
}
