// HumanSignal indicator + breakdown panel.
// Kept aesthetically aligned with the Garamond/muted-tone editor.

import { useState } from "react";
import { CONTRIBUTOR_DESC } from "../telemetry/score";

export const TIERS = ["Faint", "Developing", "Strong", "Distinct"];

const clamp01 = (x) => Math.max(0, Math.min(1, x || 0));

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

// ─── Radar "fingerprint" ───────────────────────────────────────────────────
// The nine sub-signals plotted on a single polygon. This is the at-a-glance
// shape of how a piece was written; the contributor bars below give the detail.
const RADAR_ORDER = [
  "variance", "dwell", "rhythm", "velocity", "bursts",
  "engagement", "pauses", "revisions", "corrections",
];
const RADAR_LABELS = {
  variance: "Timing", dwell: "Contact", rhythm: "Rhythm", velocity: "Speed",
  bursts: "Bursts", engagement: "Thought", pauses: "Pauses",
  revisions: "Revision", corrections: "Edits",
};

function polar(cx, cy, r, ang) {
  return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
}

// Resolve the nine dims from the persisted vector, falling back to the
// contributor list for docs scored before `dims` was stored.
function buildDims(score) {
  if (Array.isArray(score.dims) && score.dims.length) {
    const byKey = {};
    score.dims.forEach(d => { byKey[d.key] = d; });
    return RADAR_ORDER.map(k => ({
      key: k, value: clamp01(byKey[k]?.value), conf: clamp01(byKey[k]?.conf),
    }));
  }
  const byKey = {};
  (score.contributors || []).forEach(c => { byKey[c.key] = c; });
  return RADAR_ORDER.map(k => ({
    key: k, value: clamp01(byKey[k]?.value), conf: clamp01(byKey[k]?.conf),
  }));
}

function RadarChart({ dims }) {
  const cx = 150, cy = 118, R = 74;
  const N = dims.length;
  const angOf = (i) => -Math.PI / 2 + i * ((2 * Math.PI) / N);
  const rings = [0.25, 0.5, 0.75, 1];

  const ringPath = (f) =>
    dims.map((_, i) => {
      const [x, y] = polar(cx, cy, R * f, angOf(i));
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ") + " Z";

  const dataPts = dims.map((d, i) => polar(cx, cy, R * d.value, angOf(i)));
  const dataPath =
    dataPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + " Z";

  return (
    <svg viewBox="0 0 300 246" className="hs-radar-svg" role="img" aria-label="Writing-process fingerprint">
      {rings.map((f, i) => (
        <path key={`r${i}`} d={ringPath(f)} fill="none" stroke="#e4e1db" strokeWidth="0.7" />
      ))}
      {dims.map((_, i) => {
        const [x, y] = polar(cx, cy, R, angOf(i));
        return <line key={`a${i}`} x1={cx} y1={cy} x2={x.toFixed(1)} y2={y.toFixed(1)} stroke="#e4e1db" strokeWidth="0.7" />;
      })}
      <path d={dataPath} fill="rgba(42,42,42,0.07)" stroke="#2a2a2a" strokeWidth="1.6" strokeLinejoin="round" />
      {dataPts.map((p, i) => (
        <circle key={`p${i}`} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="2.4"
          fill="#2a2a2a" opacity={(0.25 + 0.75 * dims[i].conf).toFixed(2)} />
      ))}
      {dims.map((d, i) => {
        const ang = angOf(i);
        const [lx, ly] = polar(cx, cy, R + 15, ang);
        const cos = Math.cos(ang);
        const anchor = Math.abs(cos) < 0.35 ? "middle" : (cos > 0 ? "start" : "end");
        return (
          <text key={`l${i}`} x={lx.toFixed(1)} y={(ly + 3).toFixed(1)} textAnchor={anchor} className="hs-radar-label">
            {d.label || RADAR_LABELS[d.key]}
          </text>
        );
      })}
    </svg>
  );
}

function VelocityChart({ series, peakWpm, avgWpm }) {
  if (!series || series.length < 2) {
    return <div className="hs-chart-empty">Keep writing. Velocity builds with more data.</div>;
  }
  const W = 440, H = 110;
  const PAD = { t: 12, r: 8, b: 22, l: 30 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const maxY = Math.max(peakWpm || 1, 10);
  const yOf = (v) => PAD.t + ph - Math.min(1, v / maxY) * ph;

  const pts = series.map(p => [PAD.l + p.pct * pw, yOf(p.wpm)]);

  const linePath = buildSmoothPath(pts);
  const areaPath = linePath
    + ` L ${pts[pts.length - 1][0].toFixed(1)},${(PAD.t + ph).toFixed(1)}`
    + ` L ${pts[0][0].toFixed(1)},${(PAD.t + ph).toFixed(1)} Z`;

  const yTicks = [0, Math.round(maxY / 2), maxY];
  const fmtTime = ms => {
    const m = Math.floor(ms / 60000);
    return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
  };

  // Peak marker.
  let peakIdx = 0;
  for (let i = 1; i < series.length; i++) if (series[i].wpm > series[peakIdx].wpm) peakIdx = i;
  const peak = pts[peakIdx];
  const avgY = avgWpm > 0 ? yOf(avgWpm) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hs-chart-svg" aria-hidden="true">
      <defs>
        <linearGradient id="hsVelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a2a2a" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#2a2a2a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {yTicks.map((v, i) => {
        const y = yOf(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y.toFixed(1)} x2={PAD.l + pw} y2={y.toFixed(1)} stroke="#e4e1db" strokeWidth="0.6" />
            <text x={PAD.l - 5} y={y + 3} textAnchor="end" className="hs-chart-label">{v}</text>
          </g>
        );
      })}
      <path d={areaPath} fill="url(#hsVelGrad)" />
      {avgY != null && (
        <g>
          <line x1={PAD.l} y1={avgY.toFixed(1)} x2={PAD.l + pw} y2={avgY.toFixed(1)}
            stroke="#a98a5c" strokeWidth="1" strokeDasharray="3 3" opacity="0.85" />
          <text x={PAD.l + pw} y={avgY - 4} textAnchor="end" className="hs-chart-label" fill="#a98a5c">avg {avgWpm}</text>
        </g>
      )}
      <path d={linePath} fill="none" stroke="#2a2a2a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="2.2" fill="#2a2a2a" opacity="0.4" />
      ))}
      <circle cx={peak[0].toFixed(1)} cy={peak[1].toFixed(1)} r="3.4" fill="#a98a5c" />
      <text x={peak[0].toFixed(1)} y={(peak[1] - 7).toFixed(1)} textAnchor="middle" className="hs-chart-label" fill="#7a6440">
        {series[peakIdx].wpm}
      </text>
      {[0, series.length - 1].map(i => (
        <text key={i} x={pts[i][0].toFixed(1)} y={H - 3}
          textAnchor={i === 0 ? "start" : "end"} className="hs-chart-label">
          {fmtTime(series[i].tMs)}
        </text>
      ))}
    </svg>
  );
}

// Pause distribution: micro-hesitations, thinking pauses, longer breaks.
function PauseChart({ micro, think, long }) {
  const rows = [
    { label: "Micro", sub: "0.5–2s hesitations", v: micro },
    { label: "Thinking", sub: "2–10s deliberation", v: think },
    { label: "Long", sub: "10s+ breaks", v: long },
  ];
  const max = Math.max(micro, think, long, 1);
  return (
    <div className="hs-pause-list">
      {rows.map(r => (
        <div key={r.label} className="hs-pause-row">
          <div className="hs-pause-label-block">
            <span className="hs-pause-label">{r.label}</span>
            <span className="hs-pause-sub">{r.sub}</span>
          </div>
          <div className="hs-pause-bar-wrap">
            <div className="hs-pause-bar-fill" style={{ width: `${Math.round((r.v / max) * 100)}%` }} />
          </div>
          <span className="hs-pause-val">{r.v}</span>
        </div>
      ))}
    </div>
  );
}

// Where the characters came from: typed vs pasted, plus deletion churn.
function CompositionBar({ typed, pasted, deleted }) {
  const total = typed + pasted;
  if (total <= 0) return null;
  const typedPct = Math.round((typed / total) * 100);
  const pastedPct = 100 - typedPct;
  const churnPct = typed > 0 ? Math.round((deleted / typed) * 100) : 0;
  return (
    <div className="hs-comp">
      <div className="hs-comp-bar">
        <div className="hs-comp-seg typed" style={{ width: `${typedPct}%` }} />
        <div className="hs-comp-seg pasted" style={{ width: `${pastedPct}%` }} />
      </div>
      <div className="hs-comp-legend">
        <span className="hs-comp-key"><span className="hs-comp-dot typed" />typed {typedPct}%</span>
        {pasted > 0 && <span className="hs-comp-key"><span className="hs-comp-dot pasted" />pasted {pastedPct}%</span>}
      </div>
      <div className="hs-comp-churn">
        {deleted > 0
          ? `${deleted.toLocaleString()} characters written then removed (${churnPct}% churn) — the visible trace of revising.`
          : "No deletions recorded yet."}
      </div>
    </div>
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

  const dims = buildDims(score).map(d => ({ ...d, label: RADAR_LABELS[d.key] }));
  // Show the fingerprint whenever there's any measurable signal. The panel only
  // opens once a score exists, so this is effectively always true; the polygon
  // is driven by the dimension *values*, and confidence only fades the vertices.
  const showRadar = dims.some(d => d.value > 0.02);

  const micro = score.pause_micro ?? Math.max(0, (score.pause_count_500 || 0) - (score.thinking_pauses || 0));
  const think = score.pause_think ?? (score.thinking_pauses || 0);
  const long_ = score.pause_long ?? 0;
  const hasPauses = (micro + think + long_) > 0;

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
              {showRadar
                ? <RadarChart dims={dims} />
                : <div className="hs-chart-empty">The fingerprint forms as a few signals become confident. Keep writing.</div>}
              {contributors.length === 0 && (
                <div className="hs-panel-empty">Keep writing. The signal builds with a little more typing.</div>
              )}
              {contributors.length > 0 && <div className="hs-section-label">Strongest signals</div>}
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
              <p className="hs-panel-blurb">Words per minute across the session. The gold line is your average; the dot marks your peak.</p>
              <VelocityChart series={score.velocity_series} peakWpm={score.peak_wpm} avgWpm={score.avg_wpm} />
              <div className="hs-stat-row">
                <StatChip label="avg speed" value={score.avg_wpm ? `${score.avg_wpm}` : "-"} sub="words / min" />
                <StatChip label="peak speed" value={score.peak_wpm ? `${score.peak_wpm}` : "-"} sub="words / min" />
                <StatChip label="active time" value={score.active_time_ms > 0 ? fmtMin(score.active_time_ms) : "-"} sub="hands on keys" />
              </div>
            </div>
          )}
          {tab === "Patterns" && (
            <div className="hs-tab-patterns">
              <p className="hs-panel-blurb">Behavioural fingerprint, what the process metadata shows.</p>

              <div className="hs-section-label">Pace of thought</div>
              {hasPauses
                ? <PauseChart micro={micro} think={think} long={long_} />
                : <div className="hs-chart-empty">Pauses appear here as your writing settles into a rhythm.</div>}

              <div className="hs-section-label">Where the words came from</div>
              {(score.typed_chars > 0 || score.pasted_chars > 0)
                ? <CompositionBar
                    typed={score.typed_chars || 0}
                    pasted={score.pasted_chars || 0}
                    deleted={score.deleted_chars || 0}
                  />
                : <div className="hs-chart-empty">Typed and pasted characters appear here as you write.</div>}

              <div className="hs-section-label">At a glance</div>
              <div className="hs-stat-row hs-stat-row-grid">
                <StatChip label="corrections" value={corrPer100} sub="per 100 words" />
                <StatChip label="revisions" value={score.mid_revisions ?? "-"} sub="returned to rework" />
                <StatChip label="thinking pauses" value={score.thinking_pauses ?? "-"} sub="2 to 10 s pauses" />
                <StatChip label="engagement" value={score.active_ratio > 0 ? `${Math.round(score.active_ratio * 100)}%` : "-"} sub="of session active" />
                <StatChip label="bursts" value={score.burst_count ?? "-"} sub="writing bursts" />
                <StatChip label="cadence" value={score.iki_median > 0 ? `${score.iki_median}` : "-"} sub="ms between keys" />
                <StatChip label="typed" value={(score.typed_chars || 0).toLocaleString()} sub="characters" />
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
