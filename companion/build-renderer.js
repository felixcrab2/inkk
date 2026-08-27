// Bundle the renderer (renderer/app.js → renderer/bundle.js) with esbuild.
// The renderer imports @supabase/supabase-js and, crucially, ../../src/verify/
// code.js — the SAME code/hash functions the website uses — so certificates are
// identical across surfaces. Supabase + API config is injected here from the
// environment (never committed).

"use strict";
const esbuild = require("esbuild");
const path = require("node:path");

const define = {
  __SUPA_URL__: JSON.stringify(process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL || ""),
  __SUPA_KEY__: JSON.stringify(process.env.REACT_APP_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ""),
  __API_BASE__: JSON.stringify(process.env.INKK_API_BASE || "https://inkk.site"),
};

esbuild.build({
  entryPoints: [path.join(__dirname, "renderer", "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outfile: path.join(__dirname, "renderer", "bundle.js"),
  define,
  logLevel: "info",
  watch: process.argv.includes("--watch"),
}).then(() => {
  if (!process.env.REACT_APP_SUPABASE_URL && !process.env.SUPABASE_URL) {
    console.warn("[companion] No Supabase env set — the app will show 'not configured'. See companion/README.md.");
  }
}).catch(() => process.exit(1));
