import { useCallback, useEffect, useRef, useState } from "react";

export function LandingScreen({ onDone }) {
  // Choreography: type "Write Human" slowly → the full stop lands and blinks
  // three times → the headline glides up into the document-title position
  // (the overlay turning transparent so the editor appears around it) → it
  // deletes itself backwards → the caret is handed to the body, blinking,
  // waiting for the visitor's own words.
  const FULL = "Write Human";
  const [display, setDisplay] = useState("");
  const [dotOn, setDotOn]     = useState(false);
  const [blink, setBlink]     = useState(0);
  const [phase, setPhase]     = useState("type");  // type | blink | rise | del
  const [rise, setRise]       = useState(null);    // { dy, scale } once measured
  const [bgReady, setBgReady] = useState(false);
  const headRef = useRef(null);

  // Same rule as the main backdrop: the plate only fades in once its pixels
  // are decoded, so a slow first load can never pop.
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.src = "/backdrops/jerome.webp";
    (img.decode ? img.decode() : Promise.resolve())
      .catch(() => {})
      .then(() => { if (live) setBgReady(true); });
    return () => { live = false; };
  }, []);

  const finish = useCallback(() => {
    localStorage.setItem("inkk_visited", "1");
    onDone();
  }, [onDone]);

  // Glide the headline from centre screen onto the editor's title line.
  // The editor is already mounted beneath the overlay, so the real title
  // input can be measured; scale matches its type size.
  const startRise = useCallback(() => {
    const head  = headRef.current;
    const title = document.getElementById("title-input");
    if (head && title) {
      const hr = head.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      const scale = parseFloat(getComputedStyle(title).fontSize) / parseFloat(getComputedStyle(head).fontSize) || 0.55;
      setRise({ dy: (tr.top + tr.height / 2) - (hr.top + hr.height / 2), scale });
    } else {
      setRise({ dy: -Math.round(window.innerHeight * 0.26), scale: 0.55 });
    }
    setPhase("rise");
  }, []);

  // While the headline occupies the title line, hide the real title's
  // placeholder underneath it (it returns when the overlay unmounts).
  useEffect(() => {
    const on = phase === "rise" || phase === "del";
    document.body.classList.toggle("landing-handoff", on);
    return () => document.body.classList.remove("landing-handoff");
  }, [phase]);

  useEffect(() => {
    let t;
    if (phase === "type") {
      if (display.length < FULL.length) {
        t = setTimeout(() => setDisplay(FULL.slice(0, display.length + 1)), 115);
      } else if (!dotOn) {
        t = setTimeout(() => setDotOn(true), 260);        // the full stop lands
      } else {
        t = setTimeout(() => { setBlink(0); setPhase("blink"); }, 340);
      }
    } else if (phase === "blink") {
      // Toggle the full stop: off-on three times, ending lit.
      if (blink < 6) t = setTimeout(() => { setDotOn(d => !d); setBlink(b => b + 1); }, 320);
      else           t = setTimeout(startRise, 420);
    } else if (phase === "rise") {
      t = setTimeout(() => setPhase("del"), 1080);        // transform runs 1s
    } else if (phase === "del") {
      if (dotOn)               t = setTimeout(() => setDotOn(false), 200);
      else if (display.length) t = setTimeout(() => setDisplay(d => d.slice(0, -1)), 65);
      else                     t = setTimeout(finish, 220);
    }
    return () => clearTimeout(t);
  }, [phase, display, dotOn, blink, startRise, finish]);

  const handoff = phase === "rise" || phase === "del";
  const cursorOn = phase === "type" || phase === "del";

  return (
    <div id="landing" className={handoff ? "handoff" : ""} onClick={finish}>
      <div id="landing-backdrop" className={bgReady && !handoff ? "on" : ""} style={{ backgroundImage: "url(/backdrops/jerome.webp)" }} />
      <div id="landing-inner">
        <div
          id="landing-headline"
          ref={headRef}
          style={rise ? { transform: `translateY(${rise.dy}px) scale(${rise.scale})` } : undefined}
        >
          {display}
          <span id="landing-dot" style={{ opacity: dotOn ? 1 : 0 }}>.</span>
          {cursorOn && <span id="landing-cursor" />}
        </div>
      </div>
    </div>
  );
}

// ─── HumanSignalModal ─────────────────────────────────────────────────────────
