import { extractFeatures } from "./features";
import { computeScore } from "./score";

let ID = 0;
const ev = (o) => ({
  id: `s${ID++}`, user_id: "u", doc_id: "d", session_id: "s",
  kind: "input", key_class: "letter", input_type: "insertText",
  len_delta: 1, caret_pos: null, selection_len: 0, payload: null, ...o,
});

function humanTypingStream(n, base = 1_000_000, jitterMs = [80, 280]) {
  let t = base, caret = 0, seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const gap = jitterMs[0] + Math.floor(rand() * (jitterMs[1] - jitterMs[0]));
    t += gap; caret += 1;
    out.push(ev({ kind: "keydown", key_class: "letter", t: t - 1 }));
    out.push(ev({ kind: "input",   len_delta: 1, caret_pos: caret, t }));
    const dwell = 30 + Math.floor(rand() * 60);
    out.push(ev({ kind: "keyup",   key_class: "letter", t: t - 1 + dwell }));
  }
  return out;
}

describe("computeScore", () => {
  test("empty features → Faint, score 0", () => {
    const f = extractFeatures([], { words: 0 });
    const s = computeScore(f);
    expect(s.score).toBe(0);
    expect(s.tier).toBe("Faint");
    expect(s.confidence).toBeLessThan(0.1);
  });

  test("pure paste → low score, Faint or Developing", () => {
    const e = [ev({ kind: "paste", len_delta: 200, input_type: "insertFromPaste", t: 1_000_000 })];
    const f = extractFeatures(e, { words: 35 });
    const s = computeScore(f);
    expect(s.score).toBeLessThan(20);
    expect(["Faint", "Developing"]).toContain(s.tier);
    expect(s.penalty).toBeLessThan(0.5);   // hard paste penalty
  });

  test("natural typing of ~50 chars → Strong tier within window", () => {
    const e = humanTypingStream(50);
    // Sprinkle deletes (humans correct ~5%)
    let t = e[e.length - 1].t;
    for (let i = 0; i < 3; i++) {
      t += 220;
      e.push(ev({ kind: "delete", len_delta: -1, caret_pos: 50 - i, t, input_type: "deleteContentBackward" }));
    }
    const f = extractFeatures(e, { words: 10 });
    const s = computeScore(f);
    expect(s.confidence).toBeGreaterThan(0.4);
    expect(s.score).toBeGreaterThan(55);
    expect(["Strong", "Distinct"]).toContain(s.tier);
  });

  test("zero-variance fast typing (bot-like) → low score even with many events", () => {
    let t = 1_000_000;
    const e = [];
    for (let i = 0; i < 100; i++) {
      t += 200;
      e.push(ev({ kind: "input", len_delta: 1, caret_pos: i, t }));
    }
    const f = extractFeatures(e, { words: 20 });
    const s = computeScore(f);
    expect(s.subs.variance.value).toBeLessThan(0.2);
    expect(s.score).toBeLessThan(50);
  });

  test("paste-heavy with some human edits → significantly penalised", () => {
    // 90% pasted, 10% typed
    const e = [ev({ kind: "paste", len_delta: 1800, input_type: "insertFromPaste", t: 1_000_000 })];
    let t = 1_000_500;
    for (let i = 0; i < 20; i++) {
      t += 100 + (i % 5) * 30;
      e.push(ev({ kind: "input", len_delta: 1, caret_pos: 1800 + i, t }));
    }
    const f = extractFeatures(e, { words: 300 });
    const s = computeScore(f);
    expect(s.penalty).toBeLessThan(0.4);
    expect(s.score).toBeLessThan(35);
  });

  test("bursts contribute when typing in sustained runs", () => {
    const e = humanTypingStream(80);                 // long enough for a burst
    const f = extractFeatures(e, { words: 16 });
    const s = computeScore(f);
    expect(f.burst_count).toBeGreaterThanOrEqual(1);
    expect(s.subs.bursts.value).toBeGreaterThan(0);
  });

  test("contributors are ranked by contribution", () => {
    const e = humanTypingStream(60);
    const f = extractFeatures(e, { words: 12 });
    const s = computeScore(f);
    expect(s.contributors.length).toBeGreaterThan(0);
    for (let i = 1; i < s.contributors.length; i++) {
      expect(s.contributors[i - 1].contribution).toBeGreaterThanOrEqual(s.contributors[i].contribution);
    }
  });

  test("mobile-like stream (no keydown/keyup) still scores via IKI alone", () => {
    // Only `input` events, no key telemetry — typical of soft keyboards.
    let t = 1_000_000, caret = 0, seed = 11;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const e = [];
    for (let i = 0; i < 40; i++) {
      t += 90 + Math.floor(rand() * 260);
      caret += 1;
      e.push(ev({ kind: "input", len_delta: 1, caret_pos: caret, t }));
    }
    // a couple of natural deletes
    for (let i = 0; i < 2; i++) { t += 200; e.push(ev({ kind: "delete", len_delta: -1, caret_pos: caret - i, t, input_type: "deleteContentBackward" })); }
    const f = extractFeatures(e, { words: 8 });
    const s = computeScore(f);
    expect(f.dwell.n).toBe(0);
    expect(s.subs.variance.conf).toBeGreaterThan(0.5);
    expect(s.score).toBeGreaterThan(30);
  });

  test("growing window: score is monotone-ish (doesn't crash on early samples)", () => {
    const e = humanTypingStream(60);
    const stages = [5, 10, 20, 40, 60].map(n => {
      const sliced = e.filter(x => x.kind !== "input" ? true : x.caret_pos <= n);
      const f = extractFeatures(sliced, { words: Math.max(1, Math.floor(n / 5)) });
      return computeScore(f);
    });
    for (const s of stages) {
      expect(Number.isFinite(s.score)).toBe(true);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(["Faint", "Developing", "Strong", "Distinct"]).toContain(s.tier);
    }
  });
});
