// esbuild entry (see build.js) → lib/scoring.cjs.
//
// The main process scores sessions and fingerprints texts with the SAME code
// the website and api/certify.mjs use, so the live number in the popover is the
// number the certificate will carry, and a fingerprint made on the Mac matches
// one made in the browser. Those files are ESM; the main process is CommonJS,
// hence this bundle rather than a copy.

export { extractFeatures } from "../../src/telemetry/features.js";
export { computeScore, CONTRIBUTOR_DESC } from "../../src/telemetry/score.js";
export { normalizePlainText } from "../../src/verify/code.js";
export {
  canonicalText, sentences, sentenceKey, textFingerprint, textSketch, compareText,
  SKETCH_HEX, SKETCH_MAX,
} from "../../src/verify/sketch.js";
