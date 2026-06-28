// End-to-end test: dispatch synthetic events at a contenteditable host,
// pull the recorder snapshot, run features+score, verify the result.

import { createRecorder } from "./recorder";
import { extractFeatures } from "./features";
import { computeScore } from "./score";

function setupHost() {
  const host = document.createElement("div");
  host.contentEditable = "true";
  document.body.appendChild(host);
  return host;
}

function fireKey(host, key, t) {
  host.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  // beforeinput with inputType=insertText carrying the typed character
  const bi = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: key,
    bubbles: true,
    cancelable: true,
  });
  host.dispatchEvent(bi);
  host.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

function fireDelete(host) {
  host.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  const bi = new InputEvent("beforeinput", {
    inputType: "deleteContentBackward",
    bubbles: true,
    cancelable: true,
  });
  host.dispatchEvent(bi);
  host.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
}

describe("recorder ↔ features ↔ score (integration)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  test("typed events flow into a non-trivial score", () => {
    jest.useFakeTimers();
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);

    // Type 40 chars with jittered timing.
    let now = 1_000_000;
    const _now = Date.now;
    Date.now = () => now;
    try {
      let seed = 13;
      const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let i = 0; i < 40; i++) {
        now += 80 + Math.floor(rand() * 200);
        fireKey(host, "a", now);
      }
      // Sprinkle 3 deletes
      for (let i = 0; i < 3; i++) {
        now += 220 + Math.floor(rand() * 80);
        fireDelete(host);
      }
    } finally {
      Date.now = _now;
    }

    const { events } = rec.snapshot("d1");
    expect(events.length).toBeGreaterThan(0);
    const inputs   = events.filter(e => e.kind === "input").length;
    const deletes  = events.filter(e => e.kind === "delete").length;
    const sessions = events.filter(e => e.kind === "session_start").length;
    expect(inputs).toBe(40);
    expect(deletes).toBe(3);
    expect(sessions).toBeGreaterThanOrEqual(1);

    const features = extractFeatures(events, { words: 8 });
    const score    = computeScore(features);
    expect(score.confidence).toBeGreaterThan(0.4);
    expect(score.score).toBeGreaterThan(40);
    rec.detach();
  });

  test("letter keys are recorded with key_class='letter' and the literal key in key_char", () => {
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);
    fireKey(host, "h", 1_000_000);
    fireKey(host, "i", 1_000_120);
    const { events } = rec.snapshot("d1");
    const keydowns = events.filter(e => e.kind === "keydown");
    expect(keydowns.length).toBe(2);
    for (const kd of keydowns) expect(kd.key_class).toBe("letter");
    // the key identity is now captured (needed for digraph geometry)
    expect(keydowns.map(k => k.key_char)).toEqual(["h", "i"]);
    // and the inserted text shows up on the corresponding input events too
    const inputs = events.filter(e => e.kind === "input");
    expect(inputs.map(i => i.key_char)).toEqual(["h", "i"]);
    rec.detach();
  });

  test("paste followed by app-converted insertText is not double-counted", () => {
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);

    // Native paste of 50-char string. JSDOM lacks DataTransfer, so mock clipboardData.
    const text = "x".repeat(50);
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (type) => (type === "text/plain" ? text : "") },
    });
    host.dispatchEvent(ev);

    // The app then preventDefaults paste and inserts via execCommand → beforeinput insertText
    host.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
    }));

    const { events } = rec.snapshot("d1");
    const pastes = events.filter(e => e.kind === "paste");
    const inputs = events.filter(e => e.kind === "input");
    expect(pastes.length).toBe(1);
    expect(pastes[0].len_delta).toBe(50);
    // The synthetic insertText should NOT have been recorded as input
    expect(inputs.length).toBe(0);
    rec.detach();
  });

  test("detach removes listeners — events after detach are ignored", () => {
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);
    fireKey(host, "a", 1_000_000);
    const before = rec.snapshot("d1").events.length;
    rec.detach();
    fireKey(host, "b", 1_000_200);
    const after = rec.snapshot("d1").events.length;
    expect(after).toBe(before);
  });

  test("every event carries schema_version, a monotonic per-session seq, and hi-res pt", () => {
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);
    fireKey(host, "a", 1_000_000);
    fireKey(host, "b", 1_000_120);
    const { events } = rec.snapshot("d1");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.schema_version).toBe(2);
      expect(typeof e.seq).toBe("number");
      expect(typeof e.pt).toBe("number");
    }
    // seq starts at 0 on session_start and increases by 1 with no gaps
    const seqs = events.map(e => e.seq);
    expect(seqs[0]).toBe(0);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    rec.detach();
  });

  test("IME composition is recorded and composed input is flagged", () => {
    const host = setupHost();
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId: "d1", optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);
    host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    host.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertCompositionText", data: "字", bubbles: true, cancelable: true,
    }));
    host.dispatchEvent(new CompositionEvent("compositionend", { data: "字", bubbles: true }));

    const { events } = rec.snapshot("d1");
    expect(events.some(e => e.kind === "compose_start")).toBe(true);
    expect(events.some(e => e.kind === "compose_end")).toBe(true);
    const composedInput = events.find(e => e.kind === "input");
    expect(composedInput?.payload?.composing).toBe(true);
    rec.detach();
  });

  test("doc switch closes session and tags subsequent events with the new doc id", () => {
    const host = setupHost();
    let docId = "d1";
    const rec = createRecorder({
      getContext: () => ({ userId: "u1", docId, optedIn: false }),
      onUpdate: () => {},
    });
    rec.attach(host);
    fireKey(host, "a", 1_000_000);
    fireKey(host, "b", 1_000_120);

    rec.recordDocSwitch("d2");
    docId = "d2";   // simulate App.js updating its ref

    fireKey(host, "c", 1_000_300);
    const allEvents = rec._memory();
    const d1Inputs = allEvents.filter(e => e.doc_id === "d1" && e.kind === "input").length;
    const d2Inputs = allEvents.filter(e => e.doc_id === "d2" && e.kind === "input").length;
    expect(d1Inputs).toBe(2);
    expect(d2Inputs).toBe(1);
    const sessionEnds = allEvents.filter(e => e.kind === "session_end" && e.doc_id === "d1").length;
    expect(sessionEnds).toBeGreaterThanOrEqual(1);
    rec.detach();
  });
});
