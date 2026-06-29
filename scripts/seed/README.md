# Inkk seed

Populate a fresh Inkk instance with a small, believable community so the feed
isn't empty on day one — real public-domain writing, attributed to a handful of
fictional "personas," with a realistic amount of follows / likes / comments.

## What it is (and isn't)

- **Real human writing, not AI slop.** Every piece is public-domain literature
  (essays, short stories) pulled from [Project Gutenberg](https://www.gutenberg.org):
  Charles Lamb, Robert Louis Stevenson, G.K. Chesterton, Katherine Mansfield,
  James Joyce, O. Henry, Ambrose Bierce, and others. We favour *shorter, lesser-known*
  pieces so the feed reads like a community, not a "greatest hits."
- **No fake certificates.** Inkk's verification system (`verify_code`,
  `human_score`, `score_tier`) is a *publicly checkable* proof that a human wrote
  a piece in the editor. Seeded pieces were **not** written in the editor, so they
  are published with all of those fields left `null` — they appear as ordinary
  posts with **no certificate badge**. This keeps the verification system honest.
  Do not "give" seeded content certificates.
- **Attribution caveat.** Pieces are posted under persona usernames, not the
  original authors. That's legal (public domain), but a reader who recognises a
  famous text under a fictional handle might notice. Mitigation: we lean on
  lesser-known works. If you'd rather be fully transparent, you can present this
  as a curated "from the public domain" lane instead — ask and we'll adjust.

## Files

| File | What |
|------|------|
| `works.json` | The manifest: personas + which public-domain works to use. **Edit this** to add/remove content or personas. |
| `build-content.mjs` | Fetches the works from Gutenberg, cleans them, splits collections into pieces → `content.json`. No DB access. |
| `content.json` | Generated, ready-to-load content. Safe to commit (it's all public domain). |
| `seed.mjs` | Loads `content.json` into Supabase: creates users + profiles, publishes pieces, seeds engagement. |
| `unseed.mjs` | Removes exactly what `seed.mjs` created (via `.seed-ledger.json`). |
| `.env.example` | Template for your Supabase credentials. |
| `.seed-ledger.json` | Generated record of everything seeded, so `unseed` can undo it. Gitignored. |

## Prerequisites

1. **Node 18+** (for built-in `fetch`).
2. The database schema must be migrated — run `src/telemetry/schema.sql` in the
   Supabase SQL editor if you haven't (it creates `likes`, `comments`, etc.).
   The `follows` table must also exist (the app uses it).
3. Your Supabase **service-role key** (Dashboard → Project Settings → API).
   This is an admin secret — it can create users and bypass row-level security.

## Run it

```bash
# 1. credentials (from repo root)
cp scripts/seed/.env.example scripts/seed/.env
#    then edit scripts/seed/.env and paste your SUPABASE_URL + SERVICE_ROLE key

# 2. (optional) rebuild the content from Gutenberg — content.json already ships built
node scripts/seed/build-content.mjs        # or: npm run seed:build

# 3. preview the plan without writing anything
node scripts/seed/seed.mjs --dry-run       # or: npm run seed:dry

# 4. seed for real
node scripts/seed/seed.mjs                  # or: npm run seed

# 5. undo everything if you want a clean slate
node scripts/seed/unseed.mjs                # or: npm run seed:undo
```

Useful flags on `seed.mjs`: `--no-comments` (skip the generated reader
comments — the only written-by-us text), `--no-engagement` (publications only),
`--limit N` (only the first N pieces, for a smoke test).

## Safety

- **Idempotent.** Re-running tops up missing rows; it won't duplicate.
- **Never touches real users.** If a persona username already exists but wasn't
  created by a prior seed run, that persona is skipped — no content is attached
  to an account we didn't make.
- **Reversible.** `unseed.mjs` deletes only the ids recorded in the ledger.
- The persona accounts use throwaway passwords (stored in the ledger) and an
  undeliverable email domain by default.

## Customising

Edit `works.json`:
- **personas** — add `{ "username", "display_name", "bio" }`. (Note: the
  `profiles` table has no bio column today, so `bio` is currently just a note for
  you; wire it up if/when a bio column is added.)
- **standalone** — a single short work: `{ "id" (Gutenberg id), "title", "author", "kind", "persona" }`.
- **collections** — a book to split into pieces: list its `titles` in order and a
  `publish` array choosing which pieces go to which persona. Use
  `node scripts/seed/build-content.mjs --inspect <id>` to dump a book's heading
  lines so you can copy exact titles.

Then `npm run seed:build` to regenerate `content.json`, and `npm run seed`.
