-- ─── Inkk telemetry / human-signal schema ──────────────────────────────────
-- Idempotent. Safe to run on an existing database with documents/publications/profiles.
-- Run as service-role / SQL editor in Supabase.

-- 1. Profile: research opt-in (default ON; users explicitly opt in via T&C at signup
--    and may opt out from Settings). tos_accepted_at records when they agreed.
alter table public.profiles
  add column if not exists research_opt_in boolean not null default true,
  add column if not exists tos_accepted_at timestamptz,
  add column if not exists tos_version     text;

-- Re-assert the default for environments where the column was created earlier
-- with `default false`. Existing rows are untouched.
alter table public.profiles alter column research_opt_in set default true;

-- Optional: opt-in existing accounts that have already accepted no T&C version yet.
-- Uncomment for dev / single-user testing.
-- update public.profiles set research_opt_in = true where tos_accepted_at is null;

-- 2. Documents: cached process-level metrics
alter table public.documents
  add column if not exists total_writing_secs real     not null default 0,
  add column if not exists keystrokes        integer  not null default 0,
  add column if not exists deletions         integer  not null default 0,
  add column if not exists pastes            integer  not null default 0,
  add column if not exists revision_count    integer  not null default 0,
  add column if not exists human_score       smallint,
  add column if not exists score_tier        text,
  add column if not exists score_features    jsonb;

-- 3. Publications: snapshot the same metrics at publish time
alter table public.publications
  add column if not exists keystrokes        integer,
  add column if not exists deletions         integer,
  add column if not exists pastes            integer,
  add column if not exists human_score       smallint,
  add column if not exists score_tier        text,
  add column if not exists score_features    jsonb,
  -- Per-piece render options chosen at publish time (default off = plain look).
  add column if not exists render_justify    boolean not null default false,
  add column if not exists render_indent     boolean not null default false;

-- 4. Writing sessions: REMOVED.
-- This table was never written by the client — sync.js only uploads
-- writing_events — so it only ever held zero rows. Per-session aggregates are
-- now derived on demand by the writing_session_features view (section 7b),
-- which can never drift from the event stream. Drop the dead table if present.
drop table if exists public.writing_sessions cascade;

-- 5. Writing events — PACKED storage.
-- Previously one row PER raw event (keydown/keyup/input/caret/…). At 3–4 events
-- per character, plus three indexes, those tiny rows were ~90% Postgres tuple +
-- index overhead and filled the 500 MB free tier fast. We now store ONE row per
-- upload batch (≤500 events) as a single TOAST-compressed JSONB array, with the
-- batch's event count and time span denormalised onto columns for the profile
-- view. Storage drops ~5–10×. Feature extraction is UNAFFECTED: it runs
-- client-side from the in-memory ring / IndexedDB and never reads these rows
-- back. The raw per-event corpus is preserved verbatim inside `events`, and the
-- "Download my data" export re-expands it to the exact pre-packing shape.
-- Only synced when profile.research_opt_in = true (enforced client-side AND RLS).

-- Drop the old one-row-per-event table and its dependent views. DESTRUCTIVE:
-- export any raw rows you still want (Profile → Download my data) first.
drop view  if exists public.writing_session_features;
drop view  if exists public.my_writing_event_counts;
drop table if exists public.writing_events cascade;

create table if not exists public.writing_event_batches (
  id             uuid primary key,               -- = first event's id → idempotent re-upload on retry
  schema_version smallint,                        -- recorder event-shape version (bumped when fields change)
  user_id        uuid not null references auth.users(id) on delete cascade,
  event_count    integer not null,               -- number of events packed into `events`
  min_t          bigint  not null,               -- epoch ms of earliest event in the batch
  max_t          bigint  not null,               -- epoch ms of latest event in the batch
  events         jsonb   not null,               -- [{id,doc_id,session_id,seq,t,pt,kind,key_class,key_char,input_type,len_delta,caret_pos,selection_len,payload}, …]
  created_at     timestamptz not null default now()
);

create index if not exists writing_event_batches_user_t_idx
  on public.writing_event_batches(user_id, min_t);

alter table public.writing_event_batches enable row level security;

drop policy if exists "web_select_own" on public.writing_event_batches;
create policy "web_select_own" on public.writing_event_batches
  for select using (auth.uid() = user_id);

-- Server-side enforcement of opt-in: insert only allowed when caller is opted in.
drop policy if exists "web_insert_optin" on public.writing_event_batches;
create policy "web_insert_optin" on public.writing_event_batches
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.research_opt_in = true
    )
  );

drop policy if exists "web_delete_own" on public.writing_event_batches;
create policy "web_delete_own" on public.writing_event_batches
  for delete using (auth.uid() = user_id);

-- 6. RPC: delete all of caller's events (used by Profile → "Delete my research data")
create or replace function public.delete_my_writing_events()
returns void
language sql
security invoker
as $$
  delete from public.writing_event_batches where user_id = auth.uid();
$$;

-- 7. View: aggregate per-user counts (used by Profile). Sums the packed batches,
-- so the displayed total is identical to the old per-row count(*).
create or replace view public.my_writing_event_counts as
  select user_id,
         coalesce(sum(event_count), 0)::bigint as event_count,
         min(min_t)                            as first_t,
         max(max_t)                            as last_t
  from public.writing_event_batches
  where user_id = auth.uid()
  group by user_id;

-- 7b. View: per-session aggregates reconstructed from the packed event stream.
-- Unpacks each batch's `events` array (jsonb_array_elements) and re-groups by
-- session, so it derives clean per-session labels straight from the raw stream
-- and can never drift from the events. Currently unused by the app — kept for
-- offline research SQL; safe to drop if you never query it.
create or replace view public.writing_session_features as
  select
    (e.value->>'session_id')::uuid                                  as session_id,
    b.user_id,
    (e.value->>'doc_id')::uuid                                      as doc_id,
    min((e.value->>'t')::bigint)                                    as started_at,   -- epoch ms
    max((e.value->>'t')::bigint)                                    as ended_at,
    min((e.value->>'pt')::double precision)                         as started_pt,   -- hi-res ms
    max((e.value->>'pt')::double precision)                         as ended_pt,
    count(*)                                                        as event_count,
    count(*) filter (where e.value->>'kind' = 'input')             as typing_events,
    count(*) filter (where e.value->>'kind' = 'delete')            as deletion_events,
    count(*) filter (where e.value->>'kind' = 'paste')             as paste_events,
    count(*) filter (where e.value->>'kind' = 'keydown')           as keystrokes,
    coalesce(sum((e.value->>'len_delta')::int)  filter (where e.value->>'kind' = 'input'  and (e.value->>'len_delta')::int > 0), 0) as chars_added,
    coalesce(sum(-(e.value->>'len_delta')::int) filter (where e.value->>'kind' = 'delete' and (e.value->>'len_delta')::int < 0), 0) as chars_deleted,
    coalesce(sum((e.value->>'len_delta')::int)  filter (where e.value->>'kind' = 'paste'  and (e.value->>'len_delta')::int > 0), 0) as chars_pasted,
    count(*) filter (where (e.value#>>'{payload,composing}') = 'true') as composed_events
  from public.writing_event_batches b
  cross join lateral jsonb_array_elements(b.events) as e
  where b.user_id = auth.uid()
  group by (e.value->>'session_id')::uuid, b.user_id, (e.value->>'doc_id')::uuid;

-- ── 8. Likes ─────────────────────────────────────────────────────────────
-- Anyone signed in sees like counts; users insert/delete their own row.
create table if not exists public.likes (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.publications(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, publication_id)
);
create index if not exists likes_pub_idx on public.likes(publication_id);

alter table public.likes enable row level security;
drop policy if exists "likes_select_all"  on public.likes;
create policy "likes_select_all"  on public.likes for select using (true);
drop policy if exists "likes_insert_own"  on public.likes;
create policy "likes_insert_own"  on public.likes for insert with check (auth.uid() = user_id);
drop policy if exists "likes_delete_own"  on public.likes;
create policy "likes_delete_own"  on public.likes for delete using (auth.uid() = user_id);

-- ── 9. Comments ──────────────────────────────────────────────────────────
create table if not exists public.comments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.publications(id) on delete cascade,
  body           text not null check (length(body) between 1 and 2000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz
);
create index if not exists comments_pub_idx on public.comments(publication_id, created_at);

alter table public.comments enable row level security;
drop policy if exists "comments_select_all"  on public.comments;
create policy "comments_select_all"  on public.comments for select using (true);
drop policy if exists "comments_insert_own"  on public.comments;
create policy "comments_insert_own"  on public.comments for insert with check (auth.uid() = user_id);
drop policy if exists "comments_update_own"  on public.comments;
create policy "comments_update_own"  on public.comments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "comments_delete_own"  on public.comments;
create policy "comments_delete_own"  on public.comments for delete using (auth.uid() = user_id);

-- ── 10. Verification certificates ──────────────────────────────────────────
-- An immutable ledger: one row per certified version. It stores only metadata
-- and a content hash — never a copy of the text and never the keystroke
-- process — so the full audit trail of every version stays tiny. Editing a
-- piece and re-certifying issues a NEW code; old codes keep verifying the
-- older text via their stored hash. (The keystroke stream lives in
-- writing_events, gated by opt-in; the certificate never duplicates it.)
--
-- A certificate is independent of publishing: a document can be certified to
-- get a code WITHOUT a public feed post. Whether a code currently maps to a
-- live publication is derived (verify_by_code joins publications below).

-- "Current" pointer on the publication for quick display / lookup.
alter table public.publications
  add column if not exists verify_code  text,
  add column if not exists content_hash text;
create unique index if not exists publications_verify_code_idx
  on public.publications(verify_code) where verify_code is not null;

-- Same pointer on the document, so a piece can carry a code before (or without)
-- ever being published.
alter table public.documents
  add column if not exists verify_code  text,
  add column if not exists content_hash text;

create table if not exists public.verifications (
  code            text primary key,                 -- INKK-XXXX-XXXX-XXXX
  publication_id  uuid references public.publications(id) on delete set null,
  doc_id          uuid,
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text,
  author_name     text,
  author_username text,
  content_hash    text not null,                    -- sha-256 of normalised text
  word_count      integer,
  human_score     smallint,
  score_tier      text,
  verified        boolean not null default false,   -- score_tier in (Strong, Distinct)
  issued_at       timestamptz not null default now()
);
create index if not exists verifications_doc_idx on public.verifications(doc_id, issued_at desc);
create index if not exists verifications_pub_idx on public.verifications(publication_id);

alter table public.verifications enable row level security;

-- Owners can see/insert/delete their own certificate rows. Public verification
-- goes through the security-definer RPC below (exact-code lookup only — the
-- table itself can't be listed/enumerated).
drop policy if exists "ver_select_own" on public.verifications;
create policy "ver_select_own" on public.verifications
  for select using (auth.uid() = user_id);

drop policy if exists "ver_insert_own" on public.verifications;
create policy "ver_insert_own" on public.verifications
  for insert with check (auth.uid() = user_id);

drop policy if exists "ver_delete_own" on public.verifications;
create policy "ver_delete_own" on public.verifications
  for delete using (auth.uid() = user_id);

-- Public verify-by-code: returns one certificate by exact code, for anyone
-- (readers checking an exported PDF are usually logged out). Exact match only.
-- publication_id is DERIVED by joining publications on the (current) verify_code,
-- so a code maps to a live piece only while it's the published version — private
-- and superseded codes resolve with a null publication_id. The join also skips
-- 'flagged' (held for review) and 'removed' (taken down) pieces, so a pasted
-- code can never surface a "Read the piece" link to content that isn't public.
create or replace function public.verify_by_code(p_code text)
returns table (
  code text, publication_id uuid, title text, author_name text,
  author_username text, content_hash text, word_count integer,
  human_score smallint, score_tier text, verified boolean, issued_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select v.code, p.id as publication_id, v.title, v.author_name, v.author_username,
         v.content_hash, v.word_count, v.human_score, v.score_tier, v.verified, v.issued_at
  from public.verifications v
  left join public.publications p
    on p.verify_code = v.code
   and p.moderation_status not in ('flagged','removed')
  where v.code = upper(btrim(p_code))
  limit 1;
$$;

grant execute on function public.verify_by_code(text) to anon, authenticated;

-- ── 11. Content moderation ─────────────────────────────────────────────────
-- Two layers, both feeding one review queue:
--   (a) Auto-triage: at publish/comment time the client calls /api/moderate
--       (OpenAI Moderation) and caches the verdict on the content row.
--   (b) Human reports: signed-in users flag content into the reports table.
-- NOTHING is auto-deleted. Auto-flagged content is HELD: it lands in the review
-- queue and is hidden from every public surface (feed, search, profiles, and the
-- read-by-code path), but the author still sees it on their own page and is not
-- told it's under review. An admin then either releases it (status='ok') or
-- takes it down (status='removed'); a removed piece also leaves the author's
-- page and can't be reached by its inkk code.

-- 11a. Admin flag on profiles (set true by hand for moderators):
--      update public.profiles set is_admin = true where username = '<you>';
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Security-definer helper so RLS policies can check admin without recursing
-- into profiles' own policies.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;
grant execute on function public.is_admin() to authenticated;

-- 11b. Moderation cache on the content rows.
-- Status: 'pending' (never checked) | 'ok' | 'flagged' (auto-flagged, held for
-- review — hidden from public surfaces but not from the author) | 'removed'
-- (admin takedown — hidden from everyone). Existing rows default to 'pending'.
alter table public.publications
  add column if not exists moderation_status     text not null default 'pending',
  add column if not exists moderation_scores     jsonb,
  add column if not exists moderation_checked_at timestamptz;
alter table public.comments
  add column if not exists moderation_status     text not null default 'pending',
  add column if not exists moderation_scores     jsonb,
  add column if not exists moderation_checked_at timestamptz;

-- 11c. Admins may update (hide) anyone's content. Authors keep updating their
-- own rows via existing "own" policies — that's also how each author's client
-- writes the auto-triage verdict for their own piece/comment. RLS permissive
-- policies are OR'd, so this only adds admin reach.
drop policy if exists "pub_admin_update" on public.publications;
create policy "pub_admin_update" on public.publications
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "comments_admin_update" on public.comments;
create policy "comments_admin_update" on public.comments
  for update using (public.is_admin()) with check (public.is_admin());

-- 11d. Human reports.
create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid references public.profiles(id) on delete set null,
  target_type    text not null check (target_type in ('publication','comment','profile')),
  target_id      uuid not null,
  target_user_id uuid,                              -- author of the reported content (denormalised)
  reason         text not null check (reason in
                   ('spam','harassment','hate','sexual','violence','self_harm','illegal','other')),
  note           text check (note is null or length(note) <= 1000),
  status         text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid references public.profiles(id) on delete set null
);
create index if not exists reports_status_idx on public.reports(status, created_at desc);
create index if not exists reports_target_idx on public.reports(target_type, target_id);
-- One report per user per target (re-reporting just updates the reason/note).
-- NULLs are distinct in Postgres, so anonymised (reporter_id=null) rows are fine.
create unique index if not exists reports_one_per_user_target
  on public.reports(reporter_id, target_type, target_id);

alter table public.reports enable row level security;

-- Signed-in users file reports as themselves and can see their own.
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
  for insert with check (auth.uid() = reporter_id);
drop policy if exists "reports_select_own" on public.reports;
create policy "reports_select_own" on public.reports
  for select using (auth.uid() = reporter_id);

-- Admins see and action every report.
drop policy if exists "reports_select_admin" on public.reports;
create policy "reports_select_admin" on public.reports
  for select using (public.is_admin());
drop policy if exists "reports_update_admin" on public.reports;
create policy "reports_update_admin" on public.reports
  for update using (public.is_admin()) with check (public.is_admin());

-- ── 12. Lock is_admin against privilege escalation ──────────────────────────
-- is_admin lives on the profiles row, and the "update your own profile" RLS
-- policy is row-level, not column-level — so without this a signed-in user could
-- POST is_admin = true on their own row through the public API and become an
-- admin (which unlocks the admin moderation/report policies above). A
-- column-level REVOKE can't fix it: a table-level UPDATE grant still covers the
-- column. So instead we force the value — requests from the public API roles
-- (anon / authenticated) can never set or change it. The SQL editor (postgres)
-- and service_role are unaffected, so real admins are still granted by hand:
--   update public.profiles set is_admin = true where username = '<you>';
create or replace function public.lock_is_admin()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.is_admin := false;
    elsif new.is_admin is distinct from old.is_admin then
      new.is_admin := old.is_admin;          -- silently ignore attempts to change it
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_is_admin on public.profiles;
create trigger lock_is_admin
  before insert or update on public.profiles
  for each row execute function public.lock_is_admin();

-- ── 13. Lock the human-signal score against client forgery ──────────────────
-- human_score / score_tier / verified ARE the "human-verified" claim. Exactly
-- like is_admin (section 12), the "write your own row" RLS policies are
-- row-level, not column-level — so without this a signed-in user can POST
--   { human_score: 100, score_tier: 'Distinct', verified: true }
-- straight through the public API and mint a verified certificate without
-- writing a single word. (No need to read score.js or forge any telemetry: the
-- score is just a number the client hands us, and the table trusts it.)
--
-- So we force these columns for the public API roles (anon / authenticated):
-- on INSERT they are nulled / set false, on UPDATE they are pinned to their old
-- value. They can therefore be set ONLY by a trusted writer — the service_role
-- key used by /api/certify, which recomputes the score server-side from the raw
-- event stream. The SQL editor (postgres) and service_role are unaffected.
--
-- IMPORTANT: deploy this together with the /api/certify route + the client
-- switch. On its own it makes EVERY new certificate come out unverified, because
-- today the client is the only thing that writes a score.

create or replace function public.lock_verification_score()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.human_score := null;
      new.score_tier  := null;
      new.verified    := false;
    else
      new.human_score := old.human_score;     -- silently ignore attempts to change them
      new.score_tier  := old.score_tier;
      new.verified    := old.verified;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_verification_score on public.verifications;
create trigger lock_verification_score
  before insert or update on public.verifications
  for each row execute function public.lock_verification_score();

-- Only the trust-bearing columns are locked. score_features stays client-written
-- on purpose: it's the cosmetic radar/breakdown the reader panel renders, not the
-- "verified" claim. The headline (human_score / score_tier) is server-authoritative;
-- a forged radar can't dress up a piece whose tier the server set to 'Developing'.
create or replace function public.lock_publication_score()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.human_score := null;
      new.score_tier  := null;
    else
      new.human_score := old.human_score;
      new.score_tier  := old.score_tier;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_publication_score on public.publications;
create trigger lock_publication_score
  before insert or update on public.publications
  for each row execute function public.lock_publication_score();
