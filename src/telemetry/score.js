// Pure function: features → { score, tier, contributors, confidence }.
//
// Design notes:
//  • Each sub-signal returns a value in [0,1] AND a confidence in [0,1].
//  • The aggregate is a confidence-weighted weighted mean, multiplied by a
//    paste penalty (so heavy pasting can't be hidden by piling on words).
//  • Confidence ramps fast: ~30s of natural typing is enough to feel "strong".
//  • The score is *process-only* — it never reads doc content, just the
//    feature vector. Short, normally-typed pieces score well.

const WEIGHTS = {
  variance:    0.28,
  dwell:       0.16,
  pauses:      0.10,
  corrections: 0.20,
  revisions:   0.10,
  bursts:      0.06,
  rhythm:      0.10,   // dwell + IKI interaction
};

const sigmoid = (x, k = 1) => 1 / (1 + Math.exp(-k * x));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function subVariance(f) {
  const cv = f.iki?.cv || 0;
  const n  = f.iki?.n  || 0;
  // CV ≈ 0 → pasted / mechanical. CV ≥ 0.4 → human-typical. Center at 0.30.
  const value = sigmoid(cv - 0.30, 5);
  const conf  = clamp01(n / 18);
  return { value, conf, raw: cv };
}

function subDwell(f) {
  const std = f.dwell?.std || 0;
  const n   = f.dwell?.n   || 0;
  // Real humans have dwell-time spread of ~20-80ms std. Zero = no hardware kb.
  const value = sigmoid(std - 12, 0.18);
  const conf  = clamp01(n / 10);
  return { value, conf, raw: std };
}

function subPauses(f) {
  const value = clamp01(f.pause_lognormal || 0);
  const conf  = clamp01((f.pause_count_500 || 0) / 4);
  return { value, conf, raw: value };
}

function subCorrections(f) {
  // Deletion ratio: humans typically 3-15% of typed chars. Zero deletes = pasted-then-published.
  const dr = clamp01((f.deletion_ratio || 0) / 0.05);
  // Typo-correction events normalised against typing volume.
  const words = Math.max(f.words || 0, 1);
  const tcRate = (f.typo_corrections || 0) / Math.max(words / 30, 1);
  const tc = clamp01(tcRate);
  const value = clamp01(0.6 * dr + 0.4 * tc);
  const conf  = clamp01(((f.deletion_events || 0) + (f.typo_corrections || 0)) / 3);
  return { value, conf, raw: f.deletion_ratio };
}

function subRevisions(f) {
  const words = Math.max(f.words || 0, 30);
  const value = clamp01((f.mid_revisions || 0) * 30 / words);
  const conf  = clamp01(words / 60);
  return { value, conf, raw: f.mid_revisions };
}

function subBursts(f) {
  const words = Math.max(f.words || 0, 30);
  const value = clamp01((f.burst_count || 0) / (words / 50));
  const conf  = clamp01((f.total_time_ms || 0) / 15_000);
  return { value, conf, raw: f.burst_count };
}

function subRhythm(f) {
  // Interaction signal: humans show *both* IKI variance and dwell variance.
  // Pasting produces neither. This guards against trivial spoofing of one axis.
  const cv = f.iki?.cv || 0;
  const dw = f.dwell?.std || 0;
  const both = clamp01(cv / 0.5) * clamp01(dw / 30);
  const conf = Math.min(clamp01((f.iki?.n || 0) / 18), clamp01((f.dwell?.n || 0) / 10));
  return { value: both, conf, raw: { cv, dw } };
}

function pastePenalty(f) {
  // Paste up to 20% of content is normal (quotes, links). Beyond that, scale.
  const p = f.paste_ratio || 0;
  if (p <= 0.2) return 1;
  if (p >= 0.95) return 0.05;
  // Smooth: 1 at 0.2, 0.4 at 0.6, 0.1 at 0.9
  return clamp01(1 - (p - 0.2) / 0.6);
}

const CONTRIBUTOR_LABELS = {
  variance:    "Typing rhythm varies",
  dwell:       "Keypress timing varies",
  pauses:      "Natural pause distribution",
  corrections: "Real edits and corrections",
  revisions:   "Going back to rework lines",
  bursts:      "Bursts of sustained writing",
  rhythm:      "Combined rhythm signature",
};

export function computeScore(features) {
  const subs = {
    variance:    subVariance(features),
    dwell:       subDwell(features),
    pauses:      subPauses(features),
    corrections: subCorrections(features),
    revisions:   subRevisions(features),
    bursts:      subBursts(features),
    rhythm:      subRhythm(features),
  };

  // weighted mean of confident sub-scores
  let num = 0, den = 0;
  for (const k of Object.keys(WEIGHTS)) {
    const w = WEIGHTS[k];
    const { value, conf } = subs[k];
    num += w * conf * value;
    den += w * conf;
  }
  const base = den > 0 ? num / den : 0;
  const penalty = pastePenalty(features);
  const raw = base * penalty;
  const score = Math.round(raw * 100);

  // overall confidence: how much total weight has fired
  const maxDen = Object.values(WEIGHTS).reduce((s, v) => s + v, 0);
  const confidence = clamp01(den / maxDen);

  let tier;
  if (confidence < 0.15)    tier = "Faint";
  else if (raw < 0.40)      tier = "Developing";
  else if (raw < 0.70)      tier = "Strong";
  else                      tier = "Distinct";

  // contributors: subs ranked by w * conf * value (positive contribution)
  const contributors = Object.entries(subs)
    .map(([k, s]) => ({
      key: k,
      label: CONTRIBUTOR_LABELS[k],
      value: s.value,
      conf:  s.conf,
      contribution: WEIGHTS[k] * s.conf * s.value,
    }))
    .filter(c => c.conf > 0.05)
    .sort((a, b) => b.contribution - a.contribution);

  return {
    score, tier, confidence,
    penalty, base,
    subs,
    contributors,
    paste_ratio: features.paste_ratio || 0,
  };
}

export const __test__ = { subs: { subVariance, subDwell, subPauses, subCorrections, subRevisions, subBursts, subRhythm }, pastePenalty, WEIGHTS };
