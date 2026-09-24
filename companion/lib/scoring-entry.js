// esbuild entry (see build.js) → lib/scoring.cjs.
//
// The main process scores sessions with the SAME extractFeatures/computeScore
// the website and api/certify.mjs use, so the live number in the popover is
// the number the certificate will carry. Those files are ESM; the main
// process is CommonJS, hence this one-line bundle rather than a copy.

export { extractFeatures } from "../../src/telemetry/features.js";
export { computeScore, CONTRIBUTOR_DESC } from "../../src/telemetry/score.js";
export { normalizePlainText } from "../../src/verify/code.js";
