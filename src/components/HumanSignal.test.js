// Render checks for the Process Signal panel: confirms the new visualizations
// (radar fingerprint, enhanced velocity chart, pause distribution, composition)
// actually appear given a realistic score, and degrade gracefully on old data.

import { render, fireEvent } from "@testing-library/react";
import { HumanSignalPanel } from "./HumanSignal";

function richScore() {
  return {
    score: 78,
    tier: "Distinct",
    confidence: 0.9,
    contributors: [
      { key: "variance", label: "Keystroke variance", value: 0.8, conf: 0.9 },
      { key: "corrections", label: "In-line corrections", value: 0.6, conf: 0.8 },
      { key: "velocity", label: "Writing speed naturalness", value: 0.7, conf: 0.6 },
      { key: "engagement", label: "Cognitive engagement", value: 0.5, conf: 0.7 },
    ],
    dims: [
      { key: "variance", value: 0.8, conf: 0.9 },
      { key: "dwell", value: 0.6, conf: 0.7 },
      { key: "pauses", value: 0.5, conf: 0.6 },
      { key: "corrections", value: 0.6, conf: 0.8 },
      { key: "revisions", value: 0.4, conf: 0.5 },
      { key: "bursts", value: 0.55, conf: 0.6 },
      { key: "rhythm", value: 0.5, conf: 0.5 },
      { key: "velocity", value: 0.7, conf: 0.6 },
      { key: "engagement", value: 0.5, conf: 0.7 },
    ],
    paste_ratio: 0,
    velocity_series: [
      { tMs: 0, pct: 0, wpm: 30 },
      { tMs: 30000, pct: 0.5, wpm: 52 },
      { tMs: 60000, pct: 1, wpm: 41 },
    ],
    avg_wpm: 41,
    peak_wpm: 52,
    active_time_ms: 180000,
    thinking_pauses: 6,
    active_ratio: 0.7,
    typed_chars: 1200,
    pasted_chars: 80,
    deleted_chars: 140,
    pause_micro: 22,
    pause_think: 6,
    pause_long: 2,
    iki_median: 180,
    mid_revisions: 4,
    burst_count: 5,
    words: 240,
    typo_corrections: 9,
    session_count: 2,
  };
}

describe("HumanSignalPanel", () => {
  it("renders the radar fingerprint and contributor bars on the Signal tab", () => {
    const { container } = render(<HumanSignalPanel score={richScore()} onClose={() => {}} />);
    expect(container.querySelector(".hs-radar-svg")).not.toBeNull();
    expect(container.querySelectorAll(".hs-contrib-row").length).toBe(4);
  });

  it("renders the velocity chart with an average baseline", () => {
    const { container, getByRole } = render(<HumanSignalPanel score={richScore()} onClose={() => {}} />);
    fireEvent.click(getByRole("tab", { name: "Velocity" }));
    expect(container.querySelector(".hs-chart-svg")).not.toBeNull();
  });

  it("renders pause distribution and composition on the Patterns tab", () => {
    const { container, getByRole } = render(<HumanSignalPanel score={richScore()} onClose={() => {}} />);
    fireEvent.click(getByRole("tab", { name: "Patterns" }));
    expect(container.querySelectorAll(".hs-pause-row").length).toBe(3);
    expect(container.querySelector(".hs-comp-bar")).not.toBeNull();
  });

  it("still shows a radar for legacy scores that predate the dims vector", () => {
    const legacy = richScore();
    delete legacy.dims;          // old docs only have the contributor list
    const { container } = render(<HumanSignalPanel score={legacy} onClose={() => {}} />);
    expect(container.querySelector(".hs-radar-svg")).not.toBeNull();
  });
});
