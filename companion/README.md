# inkk companion (macOS)

A menu-bar app that works in the background on both sides of a piece of writing.

**Writing.** It records the **rhythm** of your typing in any app (Word, Pages,
Mail, a browser, wherever you write), never the letters. Every writing session
has its `INKK-XXXX-XXXX-XXXX` code from the first keystroke. One click
certifies it; saving or exporting a document certifies it and writes the code
into the file; ⌃⌥S signs an email with your name, whose link, description and
ink all carry the code.

**Reading.** Whatever is in front is looked at, on your Mac, for an inkk code:
in its words, its links, its pictures' descriptions and its file's metadata.
A code that turns up is looked up in the ledger and checked against the text in
front, sentence by sentence, and the popover (and a quiet notification) says
what it found. **No account is needed to start.**

It reuses the website's backend wholesale: the same pure scorer and
fingerprints (`src/telemetry/*`, `src/verify/sketch.js`, bundled into
`lib/scoring.cjs`), the same certifier (`api/certify.mjs`), the same lookup
(`api/verify.mjs`) and the same certificate page at `www.inkk.site/v/<code>`.

## How it works

```
uiohook keys ─▶ capture.js ─▶ lib/sessions.js (one session per app, code from the first key)
                                   │
   Certify / save / ⌃⌥S ─▶ read the text (lib/reader.js, helper) ─▶ fingerprint + sentence sketch
                                   └─▶ lib/api.js ─▶ /api/certify ─▶ code in the ledger
                                          ├─▶ lib/stamp.js     code into the saved or exported file
                                          └─▶ lib/signature.js name picture + seal at the caret

front window ─▶ lib/receiver.js: text, links, image descriptions (helper ax-window)
                                 file metadata (lib/docmeta.js), pixels (lib/mark.js, optional)
             ─▶ lib/lookup.js (/api/verify) ─▶ compare with the text in front ─▶ popover + notification
```

- The global hook starts once Accessibility and Input Monitoring are granted.
  Every key is attributed to the frontmost app (`lsappinfo`), and a session
  opens on the first key in an app and closes after eight minutes of silence,
  on *End*, on quit, or at midnight.
- `capture.js` reconstructs the `input` / `delete` / `paste` events the browser
  gives the web recorder, so the server scores a companion session exactly like
  a web session.
- **Certify** reads the piece from the app it was written in, once, through
  Accessibility, fingerprints it on the Mac (a SHA-256 of the whole text and a
  short hash per sentence), discards it, and sends only those with the
  session's rhythm. The seal goes on the clipboard. A certificate is final:
  writing on and certifying again issues a new code for the new version.
- **Documents** (`lib/stamp.js`): while you write in an app, the document its
  front window has open is followed. When it is saved and stays still for four
  seconds, its text is read from the file; new words are certified (at most one
  new version every three minutes, however often the app autosaves) and the
  code is written into the file: extended attributes for any file, custom
  document properties for Word, keywords for PDF. New PDF and Word files in
  your home folder, found through Spotlight, that copy a text certified in the
  last two hours get its code too, so exports are covered. Word files are
  rewritten only after the new file is checked to hold every original part
  byte for byte; a copy of the original is kept for seven days.
- **Signing an email** (`lib/signature.js`, ⌃⌥S or *Sign an email*): certifies
  what you have written in the front app, draws your name (Settings,
  *Signature*) in Garamond, Fell or Sans, recolours its ink to carry the code,
  and pastes it at the caret as a picture linked to the certificate, with the
  code in its description and a plain-text fallback.
- **Receiving** (`lib/receiver.js`): on every change of window and then every
  few seconds for a minute (every 30 s after that), the front window is read
  through the native helper. A code found in it, or in the metadata of the
  file it has open, is looked up, and the certificate's sentence fingerprints
  are compared with the text in front. With *Read codes in pictures* on (off by
  default; needs Screen Recording), the window is also photographed, the
  picture is searched for a signed name's code and for codes in its words
  (Vision OCR), and deleted at once.

## Privacy model

- **Rhythm only.** `key_char` is always `null`; only the key class and the
  timing are recorded. The companion cannot reconstruct your text from it.
- **Paste** is an event with no length: the clipboard is never read. How much
  arrived by pasting is inferred at certify time from the finished text.
- **Text is read, fingerprinted and dropped**, on the Mac, at the moments
  above. Only fingerprints and codes leave it.
- **Password fields** are never seen (macOS secure input blocks the hook), and
  ignored apps (Terminal, iTerm, 1Password, Keychain Access, the login window by
  default) are neither recorded nor read. *Pause* stops everything.
- **Local first.** Sessions, events, certificates, the account and settings live
  in `~/Library/Application Support/inkk-companion/inkk/`.
- **No account needed.** The account lives in the main process
  (`lib/auth.js`, stored in `auth.json`, readable only by you). With no session
  it signs in anonymously, a random id with no email. If the project has
  anonymous sign-ins off, the popover asks for an inkk.site email and password
  once. The full policy is in `src/components/Legal.js`.

## Permissions

macOS asks for two things the first time; both are under *System Settings →
Privacy & Security*:

- **Accessibility**: the event hook, and reading the text in front.
- **Input Monitoring**: receiving keyboard events from other apps.
- **Screen Recording** (optional, only if you switch on *Read codes in
  pictures*): photographing the front window to read a code in a picture.

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

The renderer's Content-Security-Policy only allows connections to
`https://*.supabase.co` and `https://inkk.site`; a self-hosted Supabase URL
needs `companion/renderer/index.html` updated to match.

Server side, the Supabase project must have **anonymous sign-ins enabled**
(Authentication → Sign In / Providers → *Allow anonymous sign-ins*) for the
account-free certification flow — see `docs/backend-changes-2026-09.md`.

## Files

```
main.js               main process: hook, tray, popover, sessions, certify, receiver, stamper, signature
preload.js            window.inkk, the popover's only door to main
capture.js            physical keys → telemetry events (pure, tested)
helper/InkkHelper.swift  native helper: front window, Accessibility reading, OCR, PDF text/metadata
lib/api.js            requests to www.inkk.site; follows redirects only within inkk, keeping the sign-in
lib/auth.js           the account, held by main (anonymous first)
lib/sessions.js       session model, persistence, certificate versions
lib/reader.js         the text, links and document of the window in front
lib/receiver.js       noticing codes in what you read and checking them against the text
lib/lookup.js         the ledger lookup, cached
lib/docmeta.js        codes inside documents (xattr, Word, PDF, PNG) and their text
lib/zip.js            just enough ZIP to edit a Word file without touching the rest
lib/stamp.js          stamping saved and exported documents
lib/signature.js      signing an email; renderer/sign.html + sign.js draw the name
lib/mark.js           the code in a signed name's ink, and reading it back from a screenshot
lib/codes.js          codes, and finding them in text
lib/context.js        front-app detection via lsappinfo
lib/keymap.js         uiohook keycodes → DOM-style key names
lib/permissions.js    macOS permission status and prompts
lib/scoring.cjs       generated: CJS bundle of the shared scorer and fingerprints (do not edit)
lib/config.cjs        generated from .env.local (gitignored)
build.js              esbuild bundles + lib/*.cjs + the native helper
renderer/             the popover: index.html, styles.css, app.js
assets/               tray icons, app icon
scripts/              dev-install.sh, install-cert.sh, release.sh, mark-e2e.js
```

`npm test` runs every unit test. `npx electron scripts/mark-e2e.js` draws real
signed names, shows them at several sizes in an email-like page, photographs
the page and reads the codes back.
