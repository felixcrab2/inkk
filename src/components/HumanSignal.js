// HumanSignal indicator + breakdown panel.
// Kept aesthetically aligned with the Garamond/muted-tone editor.

import { useState } from "react";
import { CONTRIBUTOR_DESC } from "../telemetry/score";

export const TIERS = ["Faint", "Developing", "Strong", "Distinct"];

function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
}

function dotsRow(tier, size = "sm") {
  const filled = tierIndex(tier) + 1;
  return (
    <span className={`hs-dots hs-dots-${size}`} aria-hidden="true">
      {TIERS.map((_, i) => (
        <span key={i} className={`hs-dot ${i < filled ? "on" : "off"}`} />
      ))}
    </span>
  );
}

function buildSmoothPath(pts) {
  if (pts.length < 2) return pts.length === 1 ? `M ${pts[0][0]},${pts[0][1]}` : "";
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function VelocityChart({ series, peakWpm }) {
  if (!series || series.length < 2) {
    return <div className="hs-chart-empty">Keep writing. Velocity builds with more data.</div>;
  }
  const W = 440, H = 100;
  const PAD = { t: 8, r: 8, b: 22, l: 30 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const maxY = Math.max(peakWpm || 1, 10);

  const pts = series.map(p => [
    PAD.l + p.pct * pw,
    PAD.t + ph - Math.min(1, p.wpm / maxY) * ph,
  ]);

  const linePath = buildSmoothPath(pts);
  const areaPath = linePath
    + ` L ${pts[pts.length - 1][0].toFixed(1)},${(PAD.t + ph).toFixed(1)}`
    + ` L ${pts[0][0].toFixed(1)},${(PAD.t + ph).toFixed(1)} Z`;

  const yTicks = [0, Math.round(maxY / 2), maxY];
  const fmtTime = ms => {
    const m = Math.floor(ms / 60000);
    return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hs-chart-svg" aria-hidden="true">
      <defs>
        <linearGradient id="hsVelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a2a2a" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#2a2a2a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((v, i) => {
        const y = PAD.t + ph - (v / maxY) * ph;
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y.toFixed(1)} x2={PAD.l + pw} y2={y.toFixed(1)} stroke="#e4e1db" strokeWidth="0.6" />
            <text x={PAD.l - 5} y={y + 3} textAnchor="end" className="hs-chart-label">{v}</text>
          </g>
        );
      })}
      <path d={areaPath} fill="url(#hsVelGrad)" />
      <path d={linePath} fill="none" stroke="#2a2a2a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="2.2" fill="#2a2a2a" opacity="0.45" />
      ))}
      {[0, series.length - 1].map(i => (
        <text key={i} x={pts[i][0].toFixed(1)} y={H - 3}
          textAnchor={i === 0 ? "start" : "end"} className="hs-chart-label">
          {fmtTime(series[i].tMs)}
        </text>
      ))}
    </svg>
  );
}

function StatChip({ label, value, sub }) {
  return (
    <div className="hs-stat-chip">
      <div className="hs-stat-val">{value}</div>
      <div className="hs-stat-label">{label}</div>
      {sub && <div className="hs-stat-sub">{sub}</div>}
    </div>
  );
}

const TABS = ["Signal", "Velocity", "Patterns", "Method"];

export function HumanSignalPanel({ score, onClose }) {
  const [tab, setTab] = useState("Signal");
  if (!score) return null;

  const contributors = score.contributors || [];
  const fmtPct = v => Math.round(v * 100);
  const fmtMin = ms => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };
  const words = score.words || 0;
  const corrPer100 = words > 0
    ? Math.round(((score.typo_corrections || 0) / words) * 100)
    : 0;

  return (
    <div className="hs-panel-backdrop" onClick={onClose}>
      <div className="hs-panel-modal" onClick={e => e.stopPropagation()}>
        <div className="hs-panel-header">
          <span className="hs-panel-title">◇ Process Signal</span>
          <button className="hs-panel-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="hs-panel-hero">
          <div className="hs-panel-score-block">
            <span className="hs-panel-score-num">{score.score ?? "-"}</span>
            <span className="hs-panel-score-denom">/100</span>
          </div>
          <div className="hs-panel-tier-block">
            {dotsRow(score.tier, "lg")}
            <span className="hs-panel-tier-label">{score.tier}</span>
          </div>
        </div>
        <div className="hs-tabs" role="tablist">
          {TABS.map(t => (
            <button key={t} role="tab" className={`hs-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="hs-tab-body">
          {tab === "Signal" && (
            <div className="hs-tab-signal">
              <p className="hs-panel-blurb">
                Built from rhythm, pauses, corrections, and revision behaviour, not the words themselves.
              </p>
              {contributors.length === 0 && (
                <div className="hs-panel-empty">Keep writing. The signal builds with a little more typing.</div>
              )}
              {contributors.map(c => (
                <div key={c.key} className="hs-contrib-row">
                  <div className="hs-contrib-label-block">
                    <span className="hs-contrib-label">{c.label}</span>
                    <span className="hs-contrib-desc">{CONTRIBUTOR_DESC?.[c.key] || ""}</span>
                  </div>
                  <div className="hs-contrib-bar-wrap">
                    <div className="hs-contrib-bar-fill" style={{ width: `${fmtPct(c.value)}%` }} />
                  </div>
                  <span className="hs-contrib-val">{fmtPct(c.value)}</span>
                </div>
              ))}
              {score.paste_ratio > 0.2 && (
                <p className="hs-panel-warn">
                  {Math.round(score.paste_ratio * 100)}% of content was pasted, score reduced accordingly.
                </p>
              )}
            </div>
          )}
          {tab === "Velocity" && (
            <div className="hs-tab-velocity">
              <p className="hs-panel-blurb">Words per minute, in 30-second windows across the session.</p>
              <VelocityChart series={score.velocity_series} peakWpm={score.peak_wpm} />
              <div className="hs-stat-row">
                <StatChip label="avg speed" value={score.avg_wpm ? `${score.avg_wpm} wpm` : "-"} />
                <StatChip label="peak speed" value={score.peak_wpm ? `${score.peak_wpm} wpm` : "-"} />
                <StatChip label="active time" value={score.active_time_ms > 0 ? fmtMin(score.active_time_ms) : "-"} />
              </div>
            </div>
          )}
          {tab === "Patterns" && (
            <div className="hs-tab-patterns">
              <p className="hs-panel-blurb">Behavioural fingerprint, what the process metadata shows.</p>
              <div className="hs-stat-row hs-stat-row-grid">
                <StatChip label="corrections" value={corrPer100} sub="per 100 words" />
                <StatChip label="revisions" value={score.mid_revisions ?? "-"} sub="returned to rework" />
                <StatChip label="thinking pauses" value={score.thinking_pauses ?? "-"} sub="2 to 10 s pauses" />
                <StatChip label="engagement" value={score.active_ratio > 0 ? `${Math.round(score.active_ratio * 100)}%` : "-"} sub="of session active" />
                <StatChip label="bursts" value={score.burst_count ?? "-"} sub="writing bursts" />
                <StatChip label="typed" value={score.typed_chars || 0} sub="characters" />
                <StatChip label="sessions" value={score.session_count || 1} sub="visits to this doc" />
              </div>
            </div>
          )}
          {tab === "Method" && (
            <div className="hs-tab-method">
              <p className="hs-method-lead">
                inkk measures nine dimensions of your writing process. None of them involve reading your words.
              </p>
              <div className="hs-method-list">
                <div className="hs-method-item">
                  <span className="hs-method-name">Keystroke timing variance</span>
                  <span className="hs-method-body">The gaps between keystrokes are measured in milliseconds. Human writers have a naturally uneven rhythm that changes with the difficulty of what they are composing.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Key contact duration</span>
                  <span className="hs-method-body">How long each key is physically held down. People vary this unconsciously depending on the character and the moment; the distribution is a stable biometric signature.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Pause distribution</span>
                  <span className="hs-method-body">Pauses in human writing follow a log-normal distribution, mostly short hesitations, with occasional long stops for thought. Flat or absent pause distributions are a known marker of generated text.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">In-line corrections</span>
                  <span className="hs-method-body">The rate of deletions and immediate self-corrections. Real writers fix things as they go; the absence of any corrections, or an unusually high rate, both carry information.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Mid-stream revisions</span>
                  <span className="hs-method-body">Moving the cursor backward to rework an earlier sentence, then continuing forward. This non-linear movement is a strong indicator of engaged authorship.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Writing burst patterns</span>
                  <span className="hs-method-body">Sustained episodes of uninterrupted typing (flow states) followed by pauses. The shape and frequency of these bursts reflects the cognitive structure of composition.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Combined rhythm signature</span>
                  <span className="hs-method-body">An interaction term: when keystroke variance and key-contact variance appear together, they reinforce each other. Neither alone is sufficient; both together are hard to fake simultaneously.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Writing speed naturalness</span>
                  <span className="hs-method-body">Words per minute measured in rolling windows across the session. Human writing accelerates and decelerates as ideas come and go; a constant typing speed is uncharacteristic of human composition.</span>
                </div>
                <div className="hs-method-item">
                  <span className="hs-method-name">Cognitive engagement</span>
                  <span className="hs-method-body">Pauses of two to ten seconds, long enough to suggest genuine thought, short enough to remain part of active composition. Their presence, frequency, and distribution tell us something about the effort behind the text.</span>
                </div>
              </div>
              <p className="hs-method-footer">
                The exact weighting of these signals is not published. This is intentional: the score is only meaningful if it cannot be trivially gamed.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function HumanSignalLine({ score, words, saving, online, signedIn, published, hasContent, onClick }) {
  const hasScore = !!score?.tier && (score.confidence ?? 0) > 0.05;
  const status = saving
    ? (signedIn && online ? "saving…" : "saving locally…")
    : (!signedIn ? "saved on this device" : (!online ? "offline, saved locally, will sync" : "saved"));
  return (
    <button id="hs-line" className="hs-line" onClick={hasScore ? onClick : undefined} type="button" disabled={!hasScore}>
      {hasScore && (
        <span className="hs-line-row">
          <span className="hs-line-label">Process</span>
          {dotsRow(score.tier)}
          <span className="hs-line-tier">{score.tier}</span>
        </span>
      )}
      <span className="hs-line-sub">
        <span className={`hs-status-dot ${saving ? "saving" : (online ? "ok" : "off")}`} aria-hidden="true" />
        {hasContent ? `${words}w · ` : ""}
        {status}
        {published && <span className="hs-line-pub"> · published</span>}
      </span>
    </button>
  );
}

// Public-facing badge — kept intentionally quiet. No tier dots, no number,
// just a small mark so readers know inkk captured the writing. Reads
// "human-verified" only when the signal is strong enough to earn it; otherwise
// the quieter "process recorded". The full process view lives behind a
// dedicated reader-side toggle.
const VERIFIED_TIERS = new Set(["Strong", "Distinct"]);

export function HumanSignalBadge({ score }) {
  if (!score) return null;
  const verified = VERIFIED_TIERS.has(score.tier);
  return (
    <span
      className={`hs-badge${verified ? " hs-badge-verified" : ""}`}
      title={verified ? "Human-verified in inkk. Strong writing-process signal" : "Written with inkk. Process metadata recorded"}
    >
      <span className="hs-badge-mark" aria-hidden="true">◇</span>
      <span className="hs-badge-text">{verified ? "human-verified" : "process recorded"}</span>
    </span>
  );
}

// Convenience hook to wire the panel open/close locally.
export function useHumanSignalPanel() {
  const [open, setOpen] = useState(false);
  return { open, openPanel: () => setOpen(true), closePanel: () => setOpen(false) };
}
