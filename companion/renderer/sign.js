// inkk companion — drawing a signed name.
//
// The writer's name is set in their face at twice the size it will be shown,
// and its ink is given the certificate's code (lib/mark.js): a pattern of warm
// and cool near-blacks no eye separates from plain black, which inkk on the
// reader's Mac can read back from the screen. Runs in a hidden window; main
// calls window.inkkSign() and gets a PNG back.

import { encodeMark } from "../lib/mark.js";

const FACES = {
  garamond: { family: '"EB Garamond"', weight: 500, size: 26 },
  fell: { family: '"IM Fell English"', weight: 400, size: 26 },
  sans: { family: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif', weight: 500, size: 22 },
};
const SCALE = 2;
const INK = "#141414";

async function draw(name, face, size) {
  const f = FACES[face] || FACES.garamond;
  const font = `${f.weight} ${size * SCALE}px ${f.family}`;
  try { await document.fonts.load(font, name); } catch { /* falls back to the system face */ }
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const m = probe.measureText(name);
  const padX = Math.round(size * SCALE * 0.12);
  const ascent = Math.ceil(m.fontBoundingBoxAscent || size * SCALE * 0.9);
  const descent = Math.ceil(m.fontBoundingBoxDescent || size * SCALE * 0.3);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(m.width) + padX * 2;
  canvas.height = ascent + descent;
  // An even pixel size keeps the picture sharp at half size on a Retina screen.
  canvas.width += canvas.width % 2;
  canvas.height += canvas.height % 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = font;
  ctx.fillStyle = INK;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, padX, ascent);
  return { canvas, ctx };
}

window.inkkSign = async function inkkSign({ name, code, face = "garamond" }) {
  const base = (FACES[face] || FACES.garamond).size;
  // A very short name may not have ink enough for the whole code; set it larger.
  for (const size of [base, base * 1.3, base * 1.7, base * 2.2]) {
    const { canvas, ctx } = await draw(name, face, size);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    try {
      encodeMark(img, code);
    } catch (e) {
      if (e && e.message === "mark_too_small") continue;
      throw e;
    }
    ctx.putImageData(img, 0, 0);
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width / SCALE, height: canvas.height / SCALE };
  }
  throw new Error("name_too_short");
};
