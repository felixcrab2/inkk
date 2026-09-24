# inkk companion (macOS)

A menu-bar app that sits in the background and records the **rhythm** of your
typing in any app — Word, Apple Notes, a browser, wherever you write — so that a
finished piece can carry an `INKK-XXXX-XXXX-XXXX` code, exactly as if it had
been written in the inkk editor. It never records the letters. It keeps a local
log of writing sessions with a live Human Signal score, and can certify any
session on demand. **No account is needed to start.**

It reuses the website's backend wholesale: the same pure scorer
(`src/telemetry/features.js` + `score.js`, bundled into `lib/scoring.cjs`), the
same code and hash functions (`src/verify/code.js`), the same server-side
certifier (`api/certify.mjs`), and the same verify page at `inkk.site/v/<code>`.

## How it works

```
uiohook keydown/keyup ─▶ capture.js (physical keys → inkk telemetry events, key_char = null)
                          ├─▶ lib/sessions.js   one open session per front app, persisted locally
                          ├─▶ lib/scoring.cjs   live score, recomputed while you type
                          └─▶ /api/certify      on "Certify this piece" ─▶ INKK code
```

- The global hook starts once Accessibility and Input Monitoring are granted
  and runs for the app's life. Every key is attributed to the frontmost app
  (`lsappinfo`, no extra permission), and a session opens on the first key in
  an app and closes after eight minutes of silence, on *End session*, on quit,
  or at midnight.
- `capture.js` reconstructs the semantic `input` / `delete` / `paste` events the
  browser gives the web recorder for free, so the server scorer treats a
  companion session identically to a web session. It is pure and unit-tested.
- Certifying: you paste the finished text into the popover. It is hashed **on
  your Mac** and only the hash, the title, the word count and that session's
  rhythm events are sent. The server recomputes the score, writes one ledger
  row, and hands back the code.

## Privacy model

- **Rhythm only.** `key_char` is always `null`; only the key *class* (letter,
  digit, punctuation, space, edit, nav, modifier) and the timing are recorded.
  The scorer never reads letters, so the companion cannot reconstruct your text.
- **Paste** is recorded as an event with no length: the clipboard is never read
  (a background app reading it would trip macOS's pasteboard privacy alert).
  How much text arrived by pasting is inferred at certify time from the length
  of the text you paste into the certify box versus what was typed.
- **Password fields** are never seen: macOS enables secure input for them, which
  blocks the hook entirely.
- **Ignored apps** (Terminal, iTerm, 1Password, Keychain Access, the login
  window and the companion itself by default; add your own in Settings) are
  never recorded. *Pause for an hour* stops everything.
- **Local first.** Sessions, events and certificates live in
  `~/Library/Application Support/inkk-companion/inkk/` (`settings.json`,
  `sessions/index.json`, `sessions/events/<id>.jsonl`, `sessions/certs/<id>.json`).
  Nothing leaves the Mac until you certify, and then only that one session.
  Sessions older than 60 days (or beyond the most recent 400) are pruned on
  launch.
- **No account needed.** Certification signs in to Supabase anonymously and
  silently — a random id, no email. Certificates need an owner in the ledger,
  so this is the smallest possible identity. If the project has anonymous
  sign-ins disabled, the popover offers an email/password sign-in at that step
  and only there. The full policy is in `src/components/Legal.js`.

## Permissions

macOS asks for two things the first time; both are under *System Settings →
Privacy & Security*:

- **Accessibility** — required by the event hook to observe key events.
- **Input Monitoring** — required to receive keyboard events from other apps.

The Welcome screen walks through them and re-checks every 1.5 s; after
granting Input Monitoring macOS usually needs the app relaunched, and the
screen offers *Relaunch inkk* when that is the case. Grants are tied to the
app's code signature, which is why the install scripts below matter.

## Run it in development

```bash
cd companion
npm install
cp .env.local.example .env.local     # Supabase URL + publishable key, INKK_API_BASE
npm start                            # build.js (renderer + lib/scoring.cjs), then Electron
npm run dev                          # same, with --inspect
npm test                             # node --test: capture.js and lib/sessions.js
```

`.env.local` (gitignored) is read at build time by `build.js`, which bakes the
values into the renderer bundle and into `lib/config.cjs` for the main process:

- `REACT_APP_SUPABASE_URL` — Supabase → Settings → API → Project URL
- `REACT_APP_SUPABASE_ANON_KEY` — the **publishable** (`sb_publishable_…`) key,
  never the secret key; this is a client app
- `INKK_API_BASE` — where `/api/certify` lives; defaults to `https://inkk.site`

`npm start` runs the unsigned Electron binary from `node_modules`. macOS treats
each rebuild of an unsigned app as a new app and revokes its permission grants,
and Gatekeeper may refuse to open it at all — a "**Electron.app** was not opened
because it contains malware … moved to Trash" notice is Gatekeeper reacting to
an unsigned or quarantined dev binary, not an actual infection. Either
right-click → Open the binary once, or (better) use the install script below so
the app has a stable signature.

## Install a signed dev build

```bash
./scripts/dev-install.sh
```

builds the app, signs it with your **Apple Development** identity (the one
created when the iOS app was first provisioned), copies it to
`/Applications/inkk.app` and launches it. Because the identity is stable, the
Accessibility and Input Monitoring grants persist across rebuilds. The bundle
id is `site.inkk.companion` and must stay that way — TCC grants are keyed on it.

## Release (signed + notarized DMG)

Public distribution requires a **Developer ID Application** certificate from
the Apple Developer Program. The certificate signing request and its private key
are already generated in `~/.inkk-signing/` (`devid.csr`, `devid.key`):

```bash
# once: developer.apple.com → Certificates → + → Developer ID Application,
# upload ~/.inkk-signing/devid.csr, download the .cer, then:
npm run install-cert                 # scripts/install-cert.sh pairs the .cer with devid.key

cp .env.signing.example .env.signing # APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD
npm run release                      # scripts/release.sh → dist/inkk-<version>.dmg, notarized
```

Notarization is Apple's automated malware scan (a few minutes, no review). The
App Store is not an option: its sandbox forbids the global input monitoring the
companion depends on. `package.json` leaves notarization off for ordinary
builds; `release.sh` turns it on.

Server side, the Supabase project must have **anonymous sign-ins enabled**
(Authentication → Sign In / Providers → *Allow anonymous sign-ins*) for the
account-free certification flow — see `docs/backend-changes-2026-09.md`.

## Files

```
main.js               main process: hook, tray, popover window, sessions, certify (HTTPS POST)
preload.js            exposes window.inkk to the renderer (the contract in the spec)
capture.js            physical keys → telemetry events (pure, tested)
lib/sessions.js       session model + persistence
lib/context.js        front-app detection via lsappinfo
lib/keymap.js         uiohook keycodes → DOM-style key names
lib/permissions.js    node-mac-permissions + systemPreferences wrappers
lib/scoring.cjs       generated: CJS bundle of the shared scorer (do not edit)
lib/config.cjs        generated from .env.local (gitignored)
build.js              esbuild: renderer bundle + lib/scoring.cjs + lib/config.cjs
renderer/             the popover UI: index.html, styles.css, app.js, fonts/
assets/               tray icons (idle + active), app icon
scripts/              dev-install.sh, install-cert.sh, release.sh
```
