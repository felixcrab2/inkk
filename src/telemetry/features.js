// Pure feature extraction from a telemetry event window.
// Inputs are arrays of event objects (see recorder.js shape).
// Output is a flat feature object consumed by score.js.
//
// All functions are side-effect-free and synchronous so they can be unit
// tested in plain Node.

const ACTIVE_GAP_MS    = 5000;       // gaps larger than this aren't counted as active typing
const IKI_CUTOFF_MS    = 3000;       // discard inter-key gaps larger than this from IKI stats
const BURST_GAP_MS     = 400;        // max IKI inside a burst
const BURST_MIN_MS     = 5000;       // a "burst" must span at least this much typing
const BURST_MIN_CHARS  = 8;          // ...or at least this many chars
const REV_CARET_JUMP   = 20;         // caret jump backward considered a revision intent
const REV_FOLLOWUP_MS  = 3000;       // edit must follow caret jump within this window
const TYPO_WINDOW_MS   = 1500;       // insert-then-delete pair window
const DWELL_MAX_MS     = 800;        // keyup later than this from keydown is ignored

// Prefer the monotonic hi-res clock for fine-grained timing (IKI, dwell);
// fall back to wall-clock `t` for events recorded before pt existed.
const ts = (e) => (typeof e.pt === "number" ? e.pt : e.t);

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: 0, std: 0, median: 0, iqr: 0, cv: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const median = quantile(sorted, 0.5);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const cv = mean > 0 ? std / mean : 0;
  return { n, mean, std, median, iqr, cv };
}

// Goodness-of-fit between observed pause distribution and a log-normal
// shape. Returns [0, 1] where 1 is a strong match. We use the simple test:
// log-transform pauses → check whether they're roughly bell-shaped via the
// |skewness| of the log distribution (low skew → log-normal-ish).
function logNormalShape(pauses) {
  if (pauses.length < 5) return 0;
  const logs = pauses.filter(p => p > 0).map(p => Math.log(p));
  if (logs.length < 5) return 0;
  const m = logs.reduce((s, v) => s + v, 0) / logs.length;
  const v = logs.reduce((s, x) => s + (x - m) ** 2, 0) / logs.length;
  if (v <= 0) return 0;
  const s = Math.sqrt(v);
  const skew = logs.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / logs.length;
  // bell-ish ~ |skew| <= 1; map smoothly.
  return Math.max(0, 1 - Math.min(1, Math.abs(skew)));
}

const VELOCITY_WINDOW_MS = 30_000;

function buildVelocitySeries(inputEvents, statsFunc) {
  if (!inputEvents.length) return { series: [], avg_wpm: 0, peak_wpm: 0, velocity_cv: 0 };
  const firstT = inputEvents[0].t;
  const lastT = inputEvents[inputEvents.length - 1].t;
  const span = lastT - firstT;
  if (span < 10_000) {
    const chars = inputEvents.reduce((s, e) => s + Math.max(0, e.len_delta || 0), 0);
    const wpm = span > 0 ? Math.round((chars / 5) / (span / 60000)) : 0;
    return { series: [{ tMs: 0, pct: 0.5, wpm }], avg_wpm: wpm, peak_wpm: wpm, velocity_cv: 0 };
  }
  const windowMs = Math.max(VELOCITY_WINDOW_MS, Math.ceil(span / 24));
  const numWindows = Math.ceil(span / windowMs);
  const wpmArr = [];
  const series = [];
  for (let i = 0; i < numWindows; i++) {
    const wStart = firstT + i * windowMs;
    const wEnd = wStart + windowMs;
    const chars = inputEvents
      .filter(e => e.t >= wStart && e.t < wEnd)
      .reduce((s, e) => s + Math.max(0, e.len_delta || 0), 0);
    const wpm = Math.round((chars / 5) / (windowMs / 60000));
    wpmArr.push(wpm);
    series.push({ tMs: i * windowMs, pct: numWindows > 1 ? i / (numWindows - 1) : 0, wpm });
  }
  const nonZero = wpmArr.filter(v => v > 0);
  const avg_wpm = nonZero.length ? Math.round(nonZero.reduce((s, v) => s + v, 0) / nonZero.length) : 0;
  const peak_wpm = wpmArr.length ? Math.max(...wpmArr) : 0;
  const st = statsFunc(wpmArr);
  return { series, avg_wpm, peak_wpm, velocity_cv: st.cv };
}

export function extractFeatures(events, { words = 0 } = {}) {
  const out = {
    event_count: events.length,
    words,
    first_t: 0, last_t: 0,
    total_time_ms: 0, active_time_ms: 0,

    typed_chars: 0,           // chars added via typing (not paste)
    deleted_chars: 0,
    pasted_chars: 0,
    typing_events: 0,
    deletion_events: 0,
    paste_events: 0,

    iki: { n: 0, median: 0, mean: 0, std: 0, iqr: 0, cv: 0 },
    dwell: { n: 0, mean: 0, std: 0 },
    pause_count_500: 0,
    pause_count_2000: 0,
    pause_count_10000: 0,
    pause_lognormal: 0,

    burst_count: 0,
    burst_total_ms: 0,

    mid_revisions: 0,
    typo_corrections: 0,

    paste_ratio: 0,
    deletion_ratio: 0,

    session_count: 0,

    velocity_series: [],
    avg_wpm: 0,
    peak_wpm: 0,
    velocity_cv: 0,
    thinking_pauses: 0,
    nav_events: 0,
    active_ratio: 0,
  };

  if (!events?.length) return out;

  const sorted = [...events].sort((a, b) => a.t - b.t);
  out.first_t = sorted[0].t;
  out.last_t  = sorted[sorted.length - 1].t;
  out.total_time_ms = Math.max(0, out.last_t - out.first_t);

  // ── counts ────────────────────────────────────────────────────────────────
  for (const e of sorted) {
    if (e.kind === "input")  { out.typing_events++;   out.typed_chars   += Math.max(0, e.len_delta || 0); }
    if (e.kind === "delete") { out.deletion_events++; out.deleted_chars += Math.max(0, -(e.len_delta || 0)); }
    if (e.kind === "paste")  { out.paste_events++;    out.pasted_chars  += Math.max(0, e.len_delta || 0); }
  }

  // ── IKI and active time ───────────────────────────────────────────────────
  const editEvents = sorted.filter(e => e.kind === "input" || e.kind === "delete");
  const ikis = [];
  const pauses = [];
  for (let i = 1; i < editEvents.length; i++) {
    const gap = ts(editEvents[i]) - ts(editEvents[i - 1]);
    if (gap <= 0) continue;
    if (gap < IKI_CUTOFF_MS) ikis.push(gap);
    if (gap >= 500)    out.pause_count_500++;
    if (gap >= 2000)   out.pause_count_2000++;
    if (gap >= 10_000) out.pause_count_10000++;
    if (gap >= 2000 && gap < 10000) out.thinking_pauses++;
    if (gap >= 500)    pauses.push(gap);
    if (gap < ACTIVE_GAP_MS) out.active_time_ms += gap;
  }
  out.iki = stats(ikis);
  out.pause_lognormal = logNormalShape(pauses);

  // ── Dwell time (keydown→keyup pairs by key_class) ─────────────────────────
  const downs = new Map();   // key_class → queue of keydown timestamps
  const dwells = [];
  for (const e of sorted) {
    if (e.kind === "keydown" && e.key_class) {
      if (!downs.has(e.key_class)) downs.set(e.key_class, []);
      downs.get(e.key_class).push(ts(e));
    } else if (e.kind === "keyup" && e.key_class && downs.get(e.key_class)?.length) {
      const t0 = downs.get(e.key_class).shift();
      const d = ts(e) - t0;
      if (d >= 0 && d <= DWELL_MAX_MS) dwells.push(d);
    }
  }
  out.dwell = (() => { const s = stats(dwells); return { n: s.n, mean: s.mean, std: s.std }; })();

  // ── Bursts ────────────────────────────────────────────────────────────────
  let burstStart = null, burstChars = 0;
  for (let i = 0; i < editEvents.length; i++) {
    const e = editEvents[i];
    const prev = editEvents[i - 1];
    const gap = prev ? (e.t - prev.t) : Infinity;
    if (gap <= BURST_GAP_MS) {
      if (burstStart === null) burstStart = prev.t;
      burstChars += Math.abs(e.len_delta || 0);
    } else {
      if (burstStart !== null) {
        const dur = prev.t - burstStart;
        if (dur >= BURST_MIN_MS || burstChars >= BURST_MIN_CHARS) {
          out.burst_count++;
          out.burst_total_ms += dur;
        }
      }
      burstStart = null; burstChars = 0;
    }
  }
  if (burstStart !== null && editEvents.length) {
    const dur = editEvents[editEvents.length - 1].t - burstStart;
    if (dur >= BURST_MIN_MS || burstChars >= BURST_MIN_CHARS) {
      out.burst_count++; out.burst_total_ms += dur;
    }
  }

  // ── Mid-stream revisions (caret jump back, then edit) ─────────────────────
  // Track running "tail" caret position implied by typing forward. A revision
  // is a caret event whose position is well behind the tail AND is followed
  // by an input/delete within REV_FOLLOWUP_MS.
  let tailCaret = null;
  let pendingJumpT = null, pendingJumpPos = null;
  for (const e of sorted) {
    if (e.kind === "input" && typeof e.caret_pos === "number") {
      if (tailCaret === null || e.caret_pos > tailCaret) tailCaret = e.caret_pos;
      if (pendingJumpT !== null && (e.t - pendingJumpT) <= REV_FOLLOWUP_MS) {
        if (typeof pendingJumpPos === "number" && Math.abs(e.caret_pos - pendingJumpPos) <= REV_CARET_JUMP) {
          out.mid_revisions++;
        }
      }
      pendingJumpT = null;
    } else if (e.kind === "delete" && typeof e.caret_pos === "number") {
      if (pendingJumpT !== null && (e.t - pendingJumpT) <= REV_FOLLOWUP_MS) {
        out.mid_revisions++;
      }
      pendingJumpT = null;
    } else if (e.kind === "caret" && typeof e.caret_pos === "number") {
      if (tailCaret !== null && (tailCaret - e.caret_pos) >= REV_CARET_JUMP) {
        pendingJumpT = e.t;
        pendingJumpPos = e.caret_pos;
      } else {
        pendingJumpT = null;
      }
    }
  }

  // ── Typo corrections: insert (+1) followed within window by delete near same caret ─
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.kind !== "input" || (a.len_delta || 0) !== 1) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if ((b.t - a.t) > TYPO_WINDOW_MS) break;
      if (b.kind === "delete" && Math.abs((b.len_delta || 0)) >= 1) {
        if (a.caret_pos == null || b.caret_pos == null
          || Math.abs((a.caret_pos + 1) - (b.caret_pos + Math.abs(b.len_delta || 1))) <= 2) {
          out.typo_corrections++;
          break;
        }
      }
    }
  }

  // ── Nav events ────────────────────────────────────────────────────────────
  out.nav_events = sorted.filter(e => e.kind === "keydown" && e.key_class === "nav").length;

  // ── Active ratio ──────────────────────────────────────────────────────────
  out.active_ratio = out.total_time_ms > 0 ? out.active_time_ms / out.total_time_ms : 0;

  // ── Ratios ────────────────────────────────────────────────────────────────
  const grossIn = out.typed_chars + out.pasted_chars;
  out.paste_ratio    = grossIn > 0 ? out.pasted_chars / grossIn : 0;
  out.deletion_ratio = out.typed_chars > 0 ? out.deleted_chars / out.typed_chars : 0;

  // ── Session count: activity clusters separated by > 10 min ──────────────
  const SESSION_BOUNDARY_MS = 10 * 60_000;
  if (editEvents.length > 0) {
    out.session_count = 1;
    for (let i = 1; i < editEvents.length; i++) {
      if (editEvents[i].t - editEvents[i - 1].t > SESSION_BOUNDARY_MS) out.session_count++;
    }
  }

  // ── Velocity series ───────────────────────────────────────────────────────
  const inputEvs = sorted.filter(e => e.kind === "input");
  const vel = buildVelocitySeries(inputEvs, stats);
  out.velocity_series = vel.series;
  out.avg_wpm = vel.avg_wpm;
  out.peak_wpm = vel.peak_wpm;
  out.velocity_cv = vel.velocity_cv;

  return out;
}

export const __test__ = { stats, logNormalShape };
