# inkk companion (macOS)

A menu-bar app that records the **rhythm** of your typing system-wide — in Word,
Apple Notes, Substack, anywhere — and issues an `INKK-XXXX-XXXX-XXXX`
verification code, exactly like writing in the inkk editor. It captures timing
only; by construction it never sees the words you write.

This is the "proof of human that travels with the writer" surface. It reuses the
website's backend wholesale: the same `writing_event_batches` schema, the same
server-side scorer (`api/certify.mjs`), the same code/hash functions
(`src/verify/code.js`), the same `inkk.site/verify` page.

## How it works

```
uiohook keydown/keyup ─▶ capture.js (physical keys → inkk telemetry events)
                          ├─▶ writing_event_batches   (same table as the web app)
                          └─▶ /api/certify            (same server scorer) ─▶ code
```

- **capture.js** is the only genuinely new logic: it reconstructs the semantic
  `input`/`delete`/`paste` events (which the browser gives the web recorder via
  `beforeinput`) from raw key events, so the server scorer treats a companion
  session identically to a web session. It is pure and unit-tested
  (`node --test capture.test.js`), and the test scores its output through the
  real `src/telemetry/features.js`.
- **Content-free by default**: `capture.js` sets `key_char` to `null`. The
  scorer never reads the literal letters, so the companion captures rhythm and
  cannot reconstruct your text. At certify time you paste the finished text; it
  is hashed **on device** (`hashContent`) and only the hash is sent, binding the
  code to the words without uploading them.

## What survives outside the browser

Full fidelity: **IKI variance, dwell (real keydown/keyup), rhythm, pauses,
bursts, velocity, corrections, paste detection**. Degraded: **revisions** (caret
position is best-effort). The scorer's confidence-weighting already renormalises
around a thin signal, so this needs no change to the algorithm.

## Run it in development (no Apple account needed)

```bash
cd companion
npm install
cp .env.local.example .env.local     # then edit .env.local with your values
npm start
```

`.env.local` (gitignored) holds the config, set once:

- `REACT_APP_SUPABASE_URL` — Supabase ▸ Settings ▸ API ▸ Project URL
- `REACT_APP_SUPABASE_ANON_KEY` — the **publishable** (`sb_publishable_…`) key.
  NOT the secret key — this is a client app.
- `INKK_API_BASE` — defaults to `https://inkk.site` (where `/api/certify` lives).

macOS will prompt for **Accessibility** and **Input Monitoring** the first time
a session starts (System Settings ▸ Privacy & Security). Grant both to the dev
Electron binary. The tray icon (top-right menu bar) opens the popover.

Flow: sign in → *Start a writing session* → type in any app → *Finish & certify*
→ paste the finished text → **Get my code** → verify it at `inkk.site/verify`.

## Test

```bash
npm test          # node --test capture.test.js
```

## Ship a signed DMG (later — needs the Apple Developer Program, $99/yr)

```bash
export CSC_LINK=...            # Developer ID Application cert (.p12)
export CSC_KEY_PASSWORD=...
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
npm run dist                  # → dist/inkk-0.1.0.dmg, signed + notarized
```

`build/entitlements.mac.plist` already carries what the hardened runtime and the
native module need. There is **no App Store review** — notarization is Apple's
automated malware scan (minutes). The App Store is not an option anyway: its
sandbox forbids the global input monitoring this depends on (same reason
Grammarly Desktop ships outside the store).

## Status

Stage-1 prototype: capture + batching + certificate flow, runnable in dev. Not
yet wired: auto-update, onboarding for the permission prompts, a real tray icon,
Windows (UIA) parity. See the branch discussion for the roadmap.
