# inkk

inkk is a writing tool that can prove a piece was typed by a person. While you
write, it records the *rhythm* of your typing — the timing of every key, pause,
deletion and paste — and turns it into a Human Signal score. When a piece is
finished you can certify it: the server recomputes the score from the raw
keystroke trace and issues an `INKK-XXXX-XXXX-XXXX` code bound to a SHA-256
fingerprint of the text. Anyone with the code can verify it at
`inkk.site/v/<code>`, logged in or not, and see the score without ever seeing
the text.

There are two surfaces. The website (`inkk.site`) is a plain editor with local
notes, optional cloud sync when signed in, PDF/PNG download, the certify and
verify pages, and an opt-in research study of the writing process. The desktop
companion is a macOS menu-bar app that does the same for writing in *any* app —
Word, Apple Notes, a browser — recording rhythm only (never the letters) and
certifying a session with no account required. There is no feed, no social
layer, and no content moderation; those were removed in September 2026 and
live on the `bank/social-version-2026-09` branch.

## Repo layout

```
src/                    React app (Create React App)
  App.js                the editor shell: state, routing, the editor itself
  views/                Notes.js (your notes + account), Certify.js (certify + verify a code)
  lib/                  docs, text, format, cloud (drafts sync), certify, profile, routes, fullscreen
  components/           AuthModal, Backdrop, DownloadModal, DropCapAvatar, HumanSignal, Landing, Legal, Toasts, …
  styles/               index.css imports the split stylesheets in cascade order
  telemetry/            recorder.js (DOM → events), store.js (IndexedDB queue),
                        sync.js (opt-in upload), features.js + score.js (pure
                        scorer, shared with the server and the companion),
                        schema.sql (the only DDL in the repo; idempotent)
  verify/               code.js (INKK code + content hash), token.js (INKK2, unwired)
  styles/               the website CSS, split by surface; index.css imports them
api/certify.mjs         Vercel serverless function: the only writer of a verified
                        certificate (service-role key, recomputes the score)
companion/              the macOS companion (Electron) — see companion/README.md
public/                 static assets: backdrops, drop_caps (default avatars), icons
docs/                   this file's neighbours, listed at the bottom
email-templates/        Supabase Auth email templates (pasted into the dashboard)
ios/, capacitor.config.json
                        Capacitor shell; kept building, not actively worked on
scripts/                one-off asset generators (backdrops, a PDF render test); the
                        carousel generators live on branch bank/social-version-2026-09
```

## Run it

Web, at the repo root:

```bash
npm install
npm start                 # http://localhost:3000
npm run build             # production build → build/ (not committed)
npm test                  # react-scripts test
npm run test:token        # node --test src/verify/token.test.mjs
```

Without a `.env.local` the editor runs local-only: notes stay in the browser,
sign-in, sync and certify are hidden.

Companion:

```bash
cd companion
npm install
cp .env.local.example .env.local      # Supabase URL + publishable key
npm start                             # builds the renderer + scoring bundle, launches Electron
npm test                              # every companion unit test
./scripts/dev-install.sh              # signed dev build into /Applications
```

## Environment variables

Web (`.env.local` at the repo root, all `REACT_APP_*` are baked into the bundle):

| Name | Where | Purpose |
| --- | --- | --- |
| `REACT_APP_SUPABASE_URL` | web, companion | Supabase project URL |
| `REACT_APP_SUPABASE_ANON_KEY` | web, companion | the **publishable** (anon) key, never the secret one |
| `REACT_APP_GOOGLE_CLIENT_ID` | web | Google sign-in button; optional |

Server (`api/certify.mjs`; set in Vercel → Settings → Environment Variables):

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | falls back to `REACT_APP_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | validates the caller's access token; falls back to `REACT_APP_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | writes the ledger row and the locked score columns, and reads one certificate for `/api/verify`. Server-only (`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_KEY` also work). Without it certifying says "Certification not configured". |

Companion (`companion/.env.local`, injected at build time): the two Supabase
values above plus `INKK_API_BASE` (default `https://inkk.site`). Release
signing uses `companion/.env.signing` — see `companion/README.md`.

## Deploy

The website deploys on Vercel from `main`. `vercel.json` rewrites every
non-`/api/` path to `index.html` (routing is client-side) and sets the CSP;
`api/certify.mjs` is picked up as a serverless function automatically. The
`build/` directory is gitignored — Vercel builds from source.

The database is a Supabase project. `src/telemetry/schema.sql` is idempotent
and can be run in the SQL editor at any time; one-off migrations are written up
under `docs/`. Anonymous sign-ins must be enabled in Supabase Auth for the
companion's account-free certification.

## Docs

- [`docs/backend-changes-2026-09.md`](docs/backend-changes-2026-09.md) — the
  SQL and dashboard steps for the September 2026 refactor (verify_by_code,
  anonymous sign-ins, optional drops of the social tables).
- [`docs/inkk2-spec.md`](docs/inkk2-spec.md) — the self-verifying INKK2 token
  format (implemented in `src/verify/token.js`, not yet wired).
- [`docs/inkk-human-score.tex`](docs/inkk-human-score.tex) — how the Human
  Signal score is computed.
- [`docs/mobile.md`](docs/mobile.md) — the iPhone shell; no longer an active
  focus.
- [`companion/README.md`](companion/README.md) — the macOS companion.
