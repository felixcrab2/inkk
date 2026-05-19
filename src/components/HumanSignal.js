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

// Tiny live indicator that lives below the editor.
export function HumanSignalLine({ score, words, saveStatus, onClick }) {
  if (!score) return null;
  return (
    <button id="hs-line" className="hs-line" onClick={onClick} type="button">
      <span className="hs-line-row">
        <span className="hs-line-label">Human Signal —</span>
        {dotsRow(score.tier)}
        <span className="hs-line-tier">{score.tier}</span>
      </span>
      <span className="hs-line-sub">
        {Number.isFinite(score.score) && score.confidence > 0.05 ? `${score.score} · ` : ""}
        {words}w · {saveStatus === "saving" ? "saving…" : "saved"}
      </span>
    </button>
  );
}

// Tiny badge used in feed / profile / reading meta lines.
export function HumanSignalBadge({ score }) {
  if (!score || !score.tier) return null;
  return (
    <span className="hs-badge" title={`Process score ${score.score}/100 — ${score.tier}`}>
      {dotsRow(score.tier)}
      <span className="hs-badge-text">Human Signal · {score.tier}</span>
    </span>
  );
}

// Slide-up panel showing the breakdown of contributors.
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
          A measurement of the writing process — not the words themselves. Built from how the text was typed: rhythm, pauses, corrections, revisions.
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
