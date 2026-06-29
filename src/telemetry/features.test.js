import { extractFeatures } from "./features";

// Helpers ───────────────────────────────────────────────────────────────────
let ID = 0;
const ev = (overrides) => ({
  id: `e${ID++}`,
  user_id: "u",
  doc_id: "d",
  session_id: "s",
  kind: "input",
  key_class: "letter",
  input_type: "insertText",
  len_delta: 1,
  caret_pos: null,
  selection_len: 0,
  payload: null,
  ...overrides,
});

function humanTypingStream(n, baseT = 1_000_000, jitterMs = [80, 280]) {
  // Pseudo-random but reproducible jitter
  let t = baseT, caret = 0;
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const gap = jitterMs[0] + Math.floor(rand() * (jitterMs[1] - jitterMs[0]));
    t += gap;
    caret += 1;
    out.push(ev({ kind: "input", len_delta: 1, caret_pos: caret, t }));
    // Add keydown/keyup for dwell stats
    const dwell = 30 + Math.floor(rand() * 60);
    out.push(ev({ kind: "keydown", key_class: "letter", t: t - 1 }));
    out.push(ev({ kind: "keyup",   key_class: "letter", t: t - 1 + dwell }));
  }
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("extractFeatures", () => {
  test("empty input → zero feature vector", () => {
    const f = extractFeatures([], { words: 0 });
    expect(f.event_count).toBe(0);
    expect(f.iki.n).toBe(0);
    expect(f.paste_ratio).toBe(0);
    expect(f.deletion_ratio).toBe(0);
    expect(f.burst_count).toBe(0);
  });

  test("single paste of 200 chars → paste_ratio=1, no IKI", () => {
    const e = [ev({ kind: "paste", len_delta: 200, input_type: "insertFromPaste", t: 1_000_000 })];
    const f = extractFeatures(e, { words: 35 });
    expect(f.paste_events).toBe(1);
    expect(f.pasted_chars).toBe(200);
    expect(f.typed_chars).toBe(0);
    expect(f.paste_ratio).toBeCloseTo(1, 3);
    expect(f.iki.n).toBe(0);
    expect(f.deletion_ratio).toBe(0);
  });

  test("steady human typing 50 events → IKI n=49, positive CV, active time > 0", () => {
    const f = extractFeatures(humanTypingStream(50), { words: 10 });
    expect(f.typing_events).toBe(50);
    expect(f.iki.n).toBe(49);
    expect(f.iki.cv).toBeGreaterThan(0.1);
    expect(f.iki.mean).toBeGreaterThan(50);
    expect(f.iki.mean).toBeLessThan(500);
    expect(f.active_time_ms).toBeGreaterThan(0);
    expect(f.dwell.n).toBeGreaterThan(0);
    expect(f.dwell.std).toBeGreaterThan(0);
  });

  test("burst detection: 20 fast inputs → ≥1 burst", () => {
    let t = 1_000_000;
    const e = [];
    for (let i = 0; i < 20; i++) {
      t += 100; e.push(ev({ kind: "input", len_delta: 1, caret_pos: i, t }));
    }
    const f = extractFeatures(e, { words: 4 });
    expect(f.burst_count).toBeGreaterThanOrEqual(1);
    expect(f.burst_total_ms).toBeGreaterThan(0);
  });

  test("deletion ratio: 50 inputs + 5 deletes → ratio ~0.1", () => {
    const e = humanTypingStream(50);
    let t = e[e.length - 1].t;
    for (let i = 0; i < 5; i++) {
      t += 200;
      e.push(ev({ kind: "delete", input_type: "deleteContentBackward", len_delta: -1, caret_pos: 50 - i, t }));
    }
    const f = extractFeatures(e, { words: 10 });
    expect(f.deletion_events).toBe(5);
    expect(f.deletion_ratio).toBeCloseTo(0.1, 1);
  });

  test("typo correction detected within window", () => {
    const e = [
      ev({ kind: "input",  len_delta: 1,  caret_pos: 10, t: 1000 }),
      ev({ kind: "delete", len_delta: -1, caret_pos: 10, t: 1500, input_type: "deleteContentBackward" }),
    ];
    const f = extractFeatures(e, { words: 1 });
    expect(f.typo_corrections).toBe(1);
  });

  test("mid revision: caret jump back followed by delete", () => {
    const e = [
      ev({ kind: "input", len_delta: 1, caret_pos: 100, t: 1000 }),
      ev({ kind: "caret", caret_pos: 30, t: 2000 }),                        // jump back
      ev({ kind: "delete", len_delta: -1, caret_pos: 30, t: 2500, input_type: "deleteContentBackward" }),
    ];
    const f = extractFeatures(e, { words: 20 });
    expect(f.mid_revisions).toBeGreaterThanOrEqual(1);
  });

  test("pauses count by threshold", () => {
    let t = 1_000_000;
    const e = [];
    e.push(ev({ kind: "input", len_delta: 1, caret_pos: 0, t })); t += 600;
    e.push(ev({ kind: "input", len_delta: 1, caret_pos: 1, t })); t += 2500;
    e.push(ev({ kind: "input", len_delta: 1, caret_pos: 2, t })); t += 12_000;
    e.push(ev({ kind: "input", len_delta: 1, caret_pos: 3, t }));
    const f = extractFeatures(e, { words: 1 });
    expect(f.pause_count_500).toBe(3);
    expect(f.pause_count_2000).toBe(2);
    expect(f.pause_count_10000).toBe(1);
  });

  test("zero-variance typing (perfect cadence) → very low CV", () => {
    let t = 1_000_000;
    const e = [];
    for (let i = 0; i < 30; i++) {
      t += 200;
      e.push(ev({ kind: "input", len_delta: 1, caret_pos: i, t }));
    }
    const f = extractFeatures(e, { words: 6 });
    expect(f.iki.cv).toBeLessThan(0.05);
  });

  test("velocity ignores long idle gaps (left the tab open)", () => {
    // Two ~15s bursts of steady ~5 chars/sec typing, separated by a 1-hour
    // idle gap. Wall-clock span is ~1h; active writing span is only ~30s.
    let t = 1_000_000, caret = 0;
    const e = [];
    const burst = (n) => {
      for (let i = 0; i < n; i++) { t += 200; caret++; e.push(ev({ kind: "input", len_delta: 1, caret_pos: caret, t })); }
    };
    burst(75);                  // ~15s of typing
    t += 60 * 60 * 1000;        // step away for an hour
    burst(75);                  // ~15s more
    const f = extractFeatures(e, { words: 30 });
    // ~5 chars/sec = ~60 wpm; the idle hour must not crush this toward zero.
    expect(f.avg_wpm).toBeGreaterThan(40);
    // The whole session should not be sliced into dozens of near-empty windows.
    expect(f.velocity_series.length).toBeLessThanOrEqual(24);
  });
});
