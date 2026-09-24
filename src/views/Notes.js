// Notes — your writing, in one place.
//
// Every note lives on this device (localStorage) and, once you sign in, in your
// account too so it follows you between devices. Signed-out writers see exactly
// the same list; an account only adds sync, certification and the research
// controls. This page replaced the old social profile: no followers, no
// published list, no avatar upload — a default drop-cap initial is the picture.

import { useEffect, useState } from "react";
import { DropCapAvatar } from "../components/DropCapAvatar";
import { PrivacyModal, TermsModal } from "../components/Legal";
import { stripHtml, docTitle, wordCount } from "../lib/docs";
import { formatDate, formatJoined, formatWritingTime } from "../lib/format";
import { fetchMyContribution, upsertProfile, generateUniqueUsername } from "../lib/profile";
import { flushNow as syncFlushNow } from "../telemetry/sync";
import { countForUser as countLocalEvents } from "../telemetry/store";

export function NotesView({
  user, profile, docs, activeId, streak, dropCapImages,
  onSignIn, onCreateAccount, onSignOut,
  onOpenDoc, onNewDoc, onDeleteDoc, onDownloadDoc, onCertifyDoc, onOpenVerify,
  researchOptIn, onToggleOptIn, onDownloadData, onDeleteData,
  onChangePassword, onProfileUpdate, onToast,
}) {
  const [optBusy, setOptBusy]         = useState(false);
  const [delBusy, setDelBusy]         = useState(false);
  const [confirmDel, setConfirmDel]   = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms]     = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [copiedCode, setCopiedCode]   = useState(null);
  const [contribution, setContribution] = useState(null);
  const [pendingLocal, setPendingLocal] = useState(0);
  const [editing, setEditing]         = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [saving, setSaving]           = useState(false);
  const [editError, setEditError]     = useState("");

  const copyCode = (code) => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(c => (c === code ? null : c)), 1800);
    });
  };

  // Research contribution: the synced total plus what is still queued on this
  // device, so recording is visible immediately and a stalled upload is
  // obvious instead of looking like a frozen number.
  useEffect(() => {
    if (!user || !researchOptIn) { setContribution(null); setPendingLocal(0); return; }
    let alive = true;
    const refresh = async () => {
      try { syncFlushNow?.(); } catch {}
      const [contrib, pending] = await Promise.all([
        fetchMyContribution(user.id),
        countLocalEvents(user.id),
      ]);
      if (!alive) return;
      if (contrib) setContribution(contrib);
      setPendingLocal(pending || 0);
    };
    refresh();
    const id = setInterval(refresh, 4000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", refresh);
    };
  }, [user, researchOptIn]);

  const notes = (docs || [])
    .filter(d => stripHtml(d.content).trim().length > 0 || stripHtml(d.title || "").trim().length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const totalWords = notes.reduce((sum, d) => sum + wordCount(d.content), 0);
  const certified  = notes.filter(d => d.verifyCode).length;

  const avatarLetter = (profile?.username?.[0] || user?.email?.[0] || "i");
  const heading = user
    ? (profile?.display_name || (profile?.username ? `@${profile.username}` : user.email))
    : "Your notes";

  const startEdit = () => {
    setEditUsername(profile?.username || "");
    setEditDisplayName(profile?.display_name || "");
    setEditError("");
    setEditing(true);
  };

  // Only the display name is editable here: it is the byline on downloaded
  // pages and the author name on certificates. The handle stays as it was
  // set at sign-up (it is part of every certificate already issued).
  const saveEdit = async () => {
    const newDisplayName = editDisplayName.trim();
    setSaving(true);
    setEditError("");
    const handle = profile?.username || await generateUniqueUsername(user.email?.split("@")[0] || "writer");
    const err = await upsertProfile(user.id, handle, newDisplayName || null);
    setSaving(false);
    if (err) { setEditError(err); return; }
    onProfileUpdate?.({ ...profile, username: handle, display_name: newDisplayName || null });
    setEditing(false);
  };

  return (
    <div id="profile-container" className="notes-view">
      <header id="profile-header">
        <div id="profile-head-row">
          <div id="profile-avatar-wrap">
            <DropCapAvatar letter={avatarLetter} dropCapImages={dropCapImages} size={64} />
          </div>
          <div id="profile-identity">
            <h1 id="profile-username">{heading}</h1>
            {user && profile?.display_name && profile?.username && (
              <div id="profile-displayname">@{profile.username}</div>
            )}
            {user
              ? (user.created_at && <div id="profile-joined">Member since {formatJoined(user.created_at)}</div>)
              : <div id="profile-joined">Kept on this device</div>}
          </div>
          {user && <button className="profile-edit-btn" onClick={startEdit}>Edit name</button>}
        </div>

        <div id="profile-stats">
          <div className="stat-fig">
            <span className="stat-fig-num">{notes.length}</span>
            <span className="stat-fig-label">{notes.length === 1 ? "Note" : "Notes"}</span>
          </div>
          <div className="stat-fig">
            <span className="stat-fig-num">{totalWords.toLocaleString()}</span>
            <span className="stat-fig-label">Words</span>
          </div>
          {certified > 0 && (
            <div className="stat-fig">
              <span className="stat-fig-num">{certified}</span>
              <span className="stat-fig-label">Certified</span>
            </div>
          )}
          {streak > 0 && (
            <div className="stat-fig">
              <span className="stat-fig-num">{streak}</span>
              <span className="stat-fig-label">Day streak</span>
            </div>
          )}
        </div>
      </header>

      {editing && (
        <div className="pe-overlay" onClick={() => { if (!saving) { setEditing(false); setEditError(""); } }}>
          <div className="pe-modal" onClick={e => e.stopPropagation()}>
            <h2 className="pe-title">Your name</h2>
            <p className="pe-body">It appears on your certificates and as the byline of downloaded pages.</p>
            <label className="pe-field">
              <span className="pe-label">Name</span>
              <input
                className="pe-input"
                type="text"
                value={editDisplayName}
                onChange={e => setEditDisplayName(e.target.value)}
                placeholder="How you'd like to be credited"
                maxLength={50}
                autoFocus
              />
            </label>
            {editUsername && <p className="pe-body">Your handle stays @{editUsername}.</p>}
            {editError && <p className="pe-error">{editError}</p>}
            <div className="pe-actions">
              <button className="pe-btn" onClick={() => { setEditing(false); setEditError(""); }} disabled={saving}>Cancel</button>
              <button className="pe-btn pe-btn-primary" onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {!user && (
        <div className="notes-signin-card">
          <p className="notes-signin-text">
            Notes stay on this device. Sign in to keep them across devices and to certify them.
          </p>
          <div className="notes-signin-actions">
            <button className="profile-cta" onClick={onSignIn}>Sign in</button>
            <button className="profile-cta-ghost" onClick={onCreateAccount || onSignIn}>Create account</button>
          </div>
        </div>
      )}

      <section className="profile-section">
        <div className="profile-section-head">
          <h2 className="profile-section-label">Notes<span className="section-count">{notes.length}</span></h2>
          <button className="section-action" onClick={onNewDoc}>New note</button>
        </div>
        <p className="profile-section-sub">Saved as you type. Only you can see them.</p>

        <div className="profile-list">
          {notes.length === 0 && (
            <p className="notes-empty">Nothing here yet. <button className="notes-empty-link" onClick={onNewDoc}>Start writing →</button></p>
          )}
          {notes.map((d, idx) => {
            const title = stripHtml(d.title || "") || docTitle(d.content);
            const wc = wordCount(d.content);
            const confirming = confirmDeleteId === d.id;
            const isActive = d.id === activeId;
            return (
              <article
                key={d.id}
                className={`profile-article-card${isActive ? " is-active" : ""}`}
                style={{ "--card-index": idx }}
                onClick={() => !confirming && onOpenDoc(d.id)}
              >
                <div className="pac-main">
                  <span className="pac-title">{title || "Untitled"}</span>
                  <span className="pac-meta">
                    {wc} {wc === 1 ? "word" : "words"} · {formatDate(new Date(d.updatedAt).toISOString())}
                    {d.writingTimeSecs > 60 && ` · ${formatWritingTime(d.writingTimeSecs)} writing`}
                  </span>
                  {d.verifyCode && (
                    <div className="pac-code" onClick={e => e.stopPropagation()}>
                      <span className="pac-code-mark" aria-hidden="true">◇</span>
                      <button className="pac-code-val" title="Copy verification code" onClick={() => copyCode(d.verifyCode)}>
                        {d.verifyCode}
                        <span className="pac-code-copied">{copiedCode === d.verifyCode ? "copied" : "copy"}</span>
                      </button>
                      <button className="pac-code-link" onClick={() => onOpenVerify?.(d.verifyCode)}>Verify →</button>
                    </div>
                  )}
                </div>
                {!confirming ? (
                  <div className="pac-actions" onClick={e => e.stopPropagation()}>
                    {!d.verifyCode && wc > 0 && (
                      <button className="pac-btn" onClick={() => onCertifyDoc(d.id)}>Certify</button>
                    )}
                    {wc > 0 && (
                      <button className="pac-btn" onClick={() => onDownloadDoc(d.id)}>Download</button>
                    )}
                    <button className="pac-btn pac-btn-danger" onClick={() => setConfirmDeleteId(d.id)}>Delete</button>
                  </div>
                ) : (
                  <div className="pac-confirm" onClick={e => e.stopPropagation()}>
                    <button className="pac-btn" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                    <button className="pac-btn pac-btn-danger" onClick={() => { onDeleteDoc(d.id); setConfirmDeleteId(null); }}>Delete</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {user && (
        <section id="research-section">
          <div className="profile-section-head">
            <h2 className="profile-section-label">Research</h2>
          </div>
          <p id="research-blurb">
            When you write in inkk, the rhythm of your typing (pauses, revisions, bursts) is captured as part of a study into what distinguishes human writing from machine-generated text. You can turn this off at any time.
          </p>

          {researchOptIn && ((Number(contribution?.event_count) || 0) + pendingLocal) > 0 && (() => {
            const synced = Number(contribution?.event_count) || 0;
            const total = synced + pendingLocal;
            return (
              <div id="contribution-card">
                <div id="contribution-num">{total.toLocaleString()}</div>
                <div id="contribution-label">events contributed to the inkk writing study</div>
                <div id="contribution-status" className={pendingLocal > 0 ? "syncing" : "synced"}>
                  {pendingLocal > 0
                    ? <><span className="research-pulse" aria-hidden="true" />{pendingLocal.toLocaleString()} events studied, uploading…</>
                    : "all events uploaded"}
                </div>
                {contribution?.first_t && (
                  <div id="contribution-since">since {formatDate(new Date(Number(contribution.first_t)).toISOString())}</div>
                )}
              </div>
            );
          })()}

          <label className="research-toggle">
            <input
              type="checkbox"
              checked={!!researchOptIn}
              disabled={optBusy}
              onChange={async (e) => {
                setOptBusy(true);
                await onToggleOptIn(e.target.checked);
                setOptBusy(false);
              }}
            />
            <span className="research-toggle-track" aria-hidden="true"><span className="research-toggle-thumb" /></span>
            <span className="research-toggle-label">{researchOptIn ? "Sharing on" : "Sharing off"}</span>
          </label>

          {researchOptIn && (
            <div id="research-controls">
              <button className="text-btn" onClick={onDownloadData}>Download my data</button>
              {!confirmDel ? (
                <button className="text-btn text-btn-danger" onClick={() => setConfirmDel(true)}>Delete my data</button>
              ) : (
                <div className="research-confirm">
                  <span>Delete all your captured writing-process data?</span>
                  <button className="text-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                  <button
                    className="text-btn text-btn-danger"
                    disabled={delBusy}
                    onClick={async () => { setDelBusy(true); await onDeleteData(); setDelBusy(false); setConfirmDel(false); }}
                  >{delBusy ? "Deleting…" : "Yes, delete"}</button>
                </div>
              )}
            </div>
          )}

          <div id="research-legal-links">
            <button type="button" className="tos-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
            <span className="research-legal-dot">·</span>
            <button type="button" className="tos-link" onClick={() => setShowTerms(true)}>Terms</button>
          </div>
        </section>
      )}

      <div id="account-footer">
        {user && (<>
          <button className="account-link" onClick={onChangePassword}>Change password</button>
          <span className="account-dot">·</span>
        </>)}
        <a className="account-link" href="mailto:hello@inkk.site?subject=Hello%20inkk">Contact</a>
        {!user && (<>
          <span className="account-dot">·</span>
          <button className="account-link" onClick={() => setShowPrivacy(true)}>Privacy</button>
          <span className="account-dot">·</span>
          <button className="account-link" onClick={() => setShowTerms(true)}>Terms</button>
        </>)}
        {user && (<>
          <span className="account-dot">·</span>
          <button className="account-link account-signout" onClick={onSignOut}>Sign out</button>
        </>)}
      </div>

      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
      {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
    </div>
  );
}
