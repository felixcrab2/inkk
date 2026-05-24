// HumanSignal indicator + breakdown panel.
// Kept aesthetically aligned with the Garamond/muted-tone editor.

import { useState } from "react";

export const TIERS = ["Faint", "Developing", "Strong", "Distinct"];

function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
}

function dotsRow(tier) {
  const filled = tierIndex(tier) + 1;     // 1-4 dots
  return (
    <span className="hs-dots" aria-hidden="true">
      {TIERS.map((_, i) => (
        <span key={i} className={`hs-dot ${i < filled ? "on" : "off"}`} />
      ))}
    </span>
  );
}

function saveStatusText({ saving, online, signedIn }) {
  if (saving) return signedIn && online ? "saving…" : "saving locally…";
  if (!signedIn)     return "saved on this device";
  if (!online)       return "offline — saved locally, will sync";
  return "saved";
}

// Tiny live indicator below the editor. Shows the writer's Process tier
// (private), word count, save status, and published status.
export function HumanSignalLine({ score, words, saving, online, signedIn, published, hasContent, onClick }) {
  const status = saveStatusText({ saving, online, signedIn });
  const hasScore = !!score?.tier && (score.confidence ?? 0) > 0.05;
  return (
    <button id="hs-line" className="hs-line" onClick={hasScore ? onClick : undefined} type="button" disabled={!hasScore}>
      {hasScore && (
        <span className="hs-line-row">
          <span className="hs-line-label">Process —</span>
          {dotsRow(score.tier)}
          <span className="hs-line-tier">{score.tier}</span>
        </span>
      )}
      <span className="hs-line-sub">
        <span className={`hs-status-dot ${saving ? "saving" : (online ? "ok" : "off")}`} aria-hidden="true" />
        {hasContent ? `${words}w · ` : ""}
        {status}
        {published && <span className="hs-line-pub">· published</span>}
      </span>
    </button>
  );
}

// Public-facing badge — kept intentionally quiet. No tier dots, no number,
// just a small "process recorded" mark so readers know inkk captured the
// writing. The full process view lives behind a dedicated reader-side toggle.
export function HumanSignalBadge({ score }) {
  if (!score) return null;
  return (
    <span className="hs-badge" title="Written with inkk — process metadata recorded">
      <span className="hs-badge-mark" aria-hidden="true">◇</span>
      <span className="hs-badge-text">process recorded</span>
    </span>
  );
}

// Slide-up panel showing the breakdown of contributors (writer's own view).
export function HumanSignalPanel({ score, onClose }) {
  if (!score) return null;
  const contributors = score.contributors || [];
  const fmtPct = (v) => `${Math.round(v * 100)}`;
  return (
    <div className="hs-panel-backdrop" onClick={onClose}>
      <div className="hs-panel" onClick={e => e.stopPropagation()}>
        <button className="hs-panel-close" onClick={onClose} aria-label="Close">×</button>
        <div className="hs-panel-head">
          <div className="hs-panel-tier-row">
            {dotsRow(score.tier)}
            <span className="hs-panel-tier">{score.tier}</span>
          </div>
          <div className="hs-panel-score">{score.score} / 100</div>
        </div>
        <p className="hs-panel-blurb">
          A reading of how this piece was made — rhythm, pauses, corrections, revisions. Built from process metadata only; the words themselves are never analysed.
        </p>

        <div className="hs-panel-list">
          {contributors.length === 0 && (
            <div className="hs-panel-empty">Keep writing — the signal builds with a little more typing.</div>
          )}
          {contributors.map(c => (
            <div key={c.key} className="hs-panel-row">
              <div className="hs-panel-row-label">{c.label}</div>
              <div className="hs-panel-row-bar">
                <div className="hs-panel-row-bar-fill" style={{ width: `${fmtPct(c.value)}%` }} />
              </div>
              <div className="hs-panel-row-val">{fmtPct(c.value)}</div>
            </div>
          ))}
        </div>

        {score.paste_ratio > 0.2 && (
          <p className="hs-panel-warn">Large pastes detected ({Math.round(score.paste_ratio * 100)}% of content) — the score is reduced because much of the writing wasn't typed here.</p>
        )}
      </div>
    </div>
  );
}

// Convenience hook to wire the panel open/close locally.
export function useHumanSignalPanel() {
  const [open, setOpen] = useState(false);
  return { open, openPanel: () => setOpen(true), closePanel: () => setOpen(false) };
}
