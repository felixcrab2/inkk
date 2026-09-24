# Backend changes — September 2026

What to run in Supabase and Vercel after the social layer was removed from
inkk and the desktop companion became account-free. Work through the numbered
steps in order: steps 1 and 2 must happen before any of the optional drops in
step 4, because `verify_by_code` and `verifications.publication_id` both point
at `publications`.

Every SQL block below is idempotent, so re-running one is harmless. Run them in
the Supabase dashboard: **SQL Editor → New query**, paste, **Run**. The editor
runs as `postgres`, which bypasses RLS and the lock triggers, so nothing here
needs the service-role key.

**Before you start:** take a backup. Dashboard → **Database → Backups** (or a
`pg_dump` if you have the connection string). The base tables `profiles`,
`documents` and `publications` were created in the dashboard and have no DDL in
the repo, so the backup is the only record of their exact shape.

---

## 1. Recreate `verify_by_code` without the publications join

The Certify page looks certificates up through this RPC, logged in or not. The
old version LEFT JOINed `publications` (to offer a "Read the piece" link) and
filtered on `publications.moderation_status`; both are going away. The return
shape is unchanged — `publication_id` is still there, always null — so the
deployed client keeps working during the migration.

`create or replace` refuses to change a function's return type, so this drops
first. There is a moment between the two statements where a lookup would fail;
run the two statements together as one query and nobody will hit it.

```sql
drop function if exists public.verify_by_code(text);
create function public.verify_by_code(p_code text)
returns table (
  code text, publication_id uuid, title text, author_name text,
  author_username text, content_hash text, word_count integer,
  human_score smallint, score_tier text, verified boolean, issued_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select v.code, null::uuid as publication_id, v.title, v.author_name, v.author_username,
         v.content_hash, v.word_count, v.human_score, v.score_tier, v.verified, v.issued_at
  from public.verifications v
  where v.code = upper(btrim(p_code))
  limit 1;
$$;

grant execute on function public.verify_by_code(text) to anon, authenticated;
```

Check it with a real code from your ledger:

```sql
select code, verified, score_tier, publication_id from public.verify_by_code('INKK-XXXX-XXXX-XXXX');
```

## 2. Drop `verifications.publication_id`

The column was a "current pointer" back to the feed post. `api/certify.mjs` no
longer writes it, nothing reads it, and its foreign key would block dropping
`publications` in step 4.

```sql
drop index if exists public.verifications_pub_idx;
alter table public.verifications drop constraint if exists verifications_publication_id_fkey;
alter table public.verifications drop column if exists publication_id;
```

If the constraint was created under a different name, find it with:

```sql
select conname from pg_constraint
where conrelid = 'public.verifications'::regclass and contype = 'f';
```

and drop that name instead. `drop column` also drops any FK on the column, so
the middle statement is belt-and-braces.

## 3. Enable anonymous sign-ins (for the companion)

The desktop companion issues certificates without asking the writer to create
an account. It does that by calling `supabase.auth.signInAnonymously()` just
before `/api/certify`, which gives it a real session and a real `auth.uid()`.

Dashboard → **Authentication → Sign In / Providers** → under *User signups*
turn on **Allow anonymous sign-ins** → **Save**.

Optional, recommended: on the same page set a rate limit for anonymous
sign-ins (Authentication → Rate Limits → *Anonymous users*), e.g. 30 per hour
per IP. The companion signs in once and keeps the session, so a low limit is
fine.

**Why RLS keeps working for anonymous users.** An anonymous user is a normal
row in `auth.users` (no email, no password) and its JWT carries
`role: authenticated` plus `is_anonymous: true`. So:

- `auth.uid()` returns their id, and every policy in `schema.sql` is written as
  `auth.uid() = user_id` / `auth.uid() = id` — none of them mention a role, so
  they apply to anonymous users unchanged.
- `verifications.user_id not null references auth.users(id)` is satisfied.
- The lock trigger in `schema.sql` §9 still forces `human_score` / `verified`
  for anyone on the `authenticated` role, so an anonymous session can no more
  forge a certificate than a full account can. `/api/certify` (service role)
  stays the only writer of a verified row.
- If you ever want to keep anonymous users *out* of a table, gate the policy
  on `(auth.jwt() ->> 'is_anonymous')::boolean is not true`. Nothing in inkk
  needs that today.

**The companion upserts a `profiles` row.** After the silent sign-in, the
companion writes `{ id, username: 'writer_' + first 6 hex of the uid,
display_name: null, research_opt_in: true, tos_accepted_at: now(), tos_version }`
so that the account looks like every other account to the rest of the schema.
That needs the `profiles` insert policy to be `with check (auth.uid() = id)` —
which is how it was created in the dashboard for the web sign-up flow. Confirm:

```sql
select policyname, cmd, with_check from pg_policies
where schemaname = 'public' and tablename = 'profiles';
```

If `profiles.username` has a unique index (it should), `writer_` + six hex
characters of a uuid is unique enough in practice. The profile row is
best-effort: if the upsert fails (a collision, a policy mismatch) the companion
logs it and the certificate is still issued — nothing in certification depends
on the profile row existing.

**Housekeeping.** Anonymous users accumulate one row per companion install
that ever certified. They are cheap, and deleting one deletes its certificates
(`on delete cascade`), so leave them alone unless you want to prune installs
that never certified anything:

```sql
-- anonymous users older than 30 days who own no certificate. Their profiles
-- rows (the companion creates one per install) go first, then the users.
delete from public.profiles p
using auth.users u
where p.id = u.id and u.is_anonymous
  and u.created_at < now() - interval '30 days'
  and not exists (select 1 from public.verifications v where v.user_id = u.id);
delete from auth.users u
where u.is_anonymous
  and u.created_at < now() - interval '30 days'
  and not exists (select 1 from public.verifications v where v.user_id = u.id);
```

## 4. Optional cleanup: remove the social tables and moderation machinery

Nothing in the app reads any of this any more. Leaving it in place costs a few
rows and some confusion; dropping it is irreversible without the backup from
step 0. Do steps 1 and 2 first.

### 4a. Triggers and policies that reference the social tables

```sql
drop trigger  if exists lock_publication_score on public.publications;
drop function if exists public.lock_publication_score();

drop policy if exists "pub_admin_update"      on public.publications;
drop policy if exists "comments_admin_update" on public.comments;
```

### 4b. Tables

`cascade` removes each table's own indexes, policies and dependent FKs.
`follows` was created by hand in the dashboard (it has no DDL in the repo) and
may not exist; `if exists` covers that.

```sql
drop table if exists public.reports      cascade;
drop table if exists public.comments     cascade;
drop table if exists public.likes        cascade;
drop table if exists public.follows      cascade;
drop table if exists public.publications cascade;
```

### 4c. Admin machinery on `profiles`

```sql
drop trigger  if exists lock_is_admin on public.profiles;
drop function if exists public.lock_is_admin();
drop function if exists public.is_admin();
alter table public.profiles drop column if exists is_admin;
```

### 4d. Profile columns the product no longer shows

`bio` was added by the seed pipeline; `avatar_data` held uploaded profile
pictures as base64 (the app now only ever renders the drop-cap default). Both
are safe to drop. If you would rather keep the uploaded pictures around, skip
the second line.

```sql
alter table public.profiles drop column if exists bio;
alter table public.profiles drop column if exists avatar_data;
```

### 4e. Seeded personas

If you ever ran `npm run seed` (the script and its ledger are gone from the
repo), the persona accounts it created are still in **Authentication → Users**
with emails on the `SEED_EMAIL_DOMAIN` you configured. Delete them there; their
publications are already gone with 4b.

### 4f. Vercel: remove `OPENAI_API_KEY`

`api/moderate.js` (the OpenAI Moderation proxy) has been deleted, so the key
is dead weight and a liability. Vercel → your project → **Settings →
Environment Variables** → `OPENAI_API_KEY` → **Remove** (each environment it
was set in). Then revoke the key itself at platform.openai.com → API keys.

The env vars that must stay are listed in the root README.

## 5. Add `documents.title`

The Notes page shows a title per note and the web Certify tab sends it on the
certificate. It was previously derived from the first line at publish time.

```sql
alter table public.documents add column if not exists title text;
```

## 6. Run `src/telemetry/schema.sql` end to end

It is idempotent and now matches the post-migration shape exactly (it also
contains steps 1 and 5, so running it is a cheap way to confirm nothing was
missed). Paste the whole file into the SQL editor and run it. It should finish
with no errors; the only destructive statements in it are the drops of the
long-dead `writing_sessions` / `writing_events` objects, which were emptied in
the packed-storage migration.

## 7. Smoke test

- **Verify, logged out.** Open `https://inkk.site/v/INKK-XXXX-XXXX-XXXX` in a
  private window with a real code. The certificate should render.
- **Certify from the web.** Sign in, write a few lines, certify. The new row
  appears in `verifications` with `verified` set by the server.
- **Certify from the companion, no account.** On a Mac with the companion
  installed and signed out, type a paragraph anywhere, open the popover,
  *Certify this piece*, paste the text, *Get my code*. There should be no
  sign-in prompt. Afterwards:

  ```sql
  select u.id, u.is_anonymous, p.username, v.code, v.verified
  from auth.users u
  join public.profiles p on p.id = u.id
  left join public.verifications v on v.user_id = u.id
  where u.is_anonymous
  order by u.created_at desc limit 5;
  ```

  shows the anonymous user, its `writer_xxxxxx` profile, and the code.
- **Anonymous sign-ins disabled** (to check the fallback): turn the toggle
  from step 3 off, repeat the companion flow; it should show the inline
  email/password sign-in instead of failing silently. Turn it back on.
