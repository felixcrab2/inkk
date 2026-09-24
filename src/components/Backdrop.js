import { useEffect, useRef, useState } from "react";

// ─── Engraving backdrop ───────────────────────────────────────────────────────
// A pool of faded public-domain plates, some at more than one framing. The
// plate advances (randomly, never repeating itself) each time the backdrop
// reappears or the view changes, so the site never shows the same wall twice
// in a row.
export const BACKDROP_PLATES = [
  // Dürer (Christie's photographs of the plates)
  { img: "jerome",        pos: "center 28%" }, // St Jerome writing in his study
  { img: "jerome",        pos: "center 68%" }, // …the lion at his feet
  { img: "melencolia",    pos: "center 24%" }, // Melencolia I
  { img: "four-horsemen", pos: "center 35%" }, // The Four Horsemen of the Apocalypse
  { img: "four-horsemen", pos: "28% center" },
  { img: "prodigal-son",  pos: "center 42%" }, // The Prodigal Son
  { img: "st-eustace",    pos: "center 45%" }, // Saint Eustace, the knight and his horse
  { img: "whore-babylon", pos: "center 38%" }, // The Whore of Babylon
  { img: "rhinoceros",    pos: "center 45%" }, // The Rhinoceros
  { img: "rhinoceros",    pos: "80% center" },
  // the Flammarion engraving (high-res scan)
  { img: "flammarion",    pos: "center 30%" },
  { img: "flammarion",    pos: "24% 22%" },
  // cosmos (Merian) and destillatio (van der Straet) are cut: their source
  // scans are softer than the Christie's photographs and read muddy keyed.
];

// A note keeps one plate for life: hash its id into the pool, so
// the reading view always frames a piece with the same engraving.
export const BACKDROP_IMGS = [...new Set(BACKDROP_PLATES.map(p => p.img))];

export function imgForPub(id) {
  let h = 0;
  for (const c of String(id || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BACKDROP_IMGS[h % BACKDROP_IMGS.length];
}

// How long the backdrop takes to clear before the plate is swapped on a
// view change. Must match the .bd-veil transition-duration in App.css.
export const BACKDROP_VEIL_MS = 700;

export function Backdrop({ view, hidden, override, ringed }) {
  const [shown, setShown]   = useState(() => BACKDROP_PLATES[Math.floor(Math.random() * BACKDROP_PLATES.length)]);
  const [ready, setReady]   = useState(false);  // first plate decoded — nothing shows before this
  const [veiled, setVeiled] = useState(false);
  const prevRef  = useRef({ view, hidden: true });
  const shownRef = useRef(shown);
  const genRef   = useRef(0);
  const timerRef = useRef(null);
  const oimg = override ? override.img : null;
  shownRef.current = shown;

  useEffect(() => {
    const prev = prevRef.current;
    const appearing = !hidden && prev.hidden;
    const switched  = !hidden && !prev.hidden && view !== prev.view;
    prevRef.current = { view, hidden };
    if (!appearing && !switched) return;

    // Pick the next plate: the override wins; otherwise random, no repeat.
    let next;
    if (oimg) {
      next = { img: oimg, pos: "center 30%" };
    } else {
      next = BACKDROP_PLATES[Math.floor(Math.random() * BACKDROP_PLATES.length)];
      if (next === shownRef.current) next = BACKDROP_PLATES[(BACKDROP_PLATES.indexOf(next) + 1) % BACKDROP_PLATES.length];
    }

    // Never point the layer at an image that isn't ready: a plate whose data
    // arrives mid-transition pops in at the layer's current opacity instead
    // of fading from clear. Preload and decode first — the swap waits for
    // BOTH the pixels and (on view changes) the exhale, so a slow network
    // just means the wall stays clear a moment longer, never a pop.
    const gen = ++genRef.current;
    const img = new Image();
    img.src = `/backdrops/${next.img}.webp`;
    const decoded = (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
    let waited = Promise.resolve();
    if (switched) {
      setVeiled(true);
      waited = new Promise(res => {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(res, BACKDROP_VEIL_MS);
      });
    }
    Promise.all([decoded, waited]).then(() => {
      if (genRef.current !== gen) return;   // a newer change took over
      setShown(next);
      setVeiled(false);
      setReady(true);
    });
  }, [view, hidden, oimg]);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div
      id="backdrop"
      data-view={view}
      className={(hidden || veiled || !ready ? "" : "bd-on") + (veiled ? " bd-veil" : "") + (ringed ? " bd-ring" : "")}
      style={{
        backgroundImage: `url(/backdrops/${shown.img}.webp)`,
        backgroundPosition: shown.pos,
      }}
    />
  );
}
