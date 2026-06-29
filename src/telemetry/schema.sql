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
  add column if not exists score_features    jsonb;

-- 4. Writing sessions: REMOVED.
-- This table was never written by the client — sync.js only uploads
-- writing_events — so it only ever held zero rows. Per-session aggregates are
-- now derived on demand by the writing_session_features view (section 7b),
-- which can never drift from the event stream. Drop the dead table if present.
drop table if exists public.writing_sessions cascade;

-- 5. Writing events — append-only fine-grained event stream
-- Only synced when profile.research_opt_in = true (enforced client-side AND below).
create table if not exists public.writing_events (
  id             uuid primary key,
  schema_version smallint,                       -- recorder event-shape version (bumped when fields change)
  user_id        uuid not null references auth.users(id) on delete cascade,
  doc_id         uuid not null,
  session_id     uuid not null,
  seq            integer,                         -- monotonic order within a session (breaks same-ms ties)
  t              bigint not null,                 -- epoch ms client-side (wall clock — calendar alignment)
  pt             double precision,                -- monotonic hi-res ms (performance.now) — precise IKI / dwell
  kind           text not null,                  -- keydown|keyup|input|delete|paste|drop|caret|focus|blur|visibility|compose_start|compose_end|session_start|session_end|doc_switch
  key_class      text,                           -- letter|digit|punct|space|nav|edit|modifier|other
  key_char       text,                           -- literal key/inserted text (letters, digits, punct); null for non-character keys & deletes/pastes
  input_type     text,                           -- InputEvent.inputType
  len_delta      integer,                        -- chars added/removed
  caret_pos      integer,
  selection_len  integer,
  payload        jsonb,
  created_at     timestamptz not null default now()
);

-- New columns for deployments where writing_events already exists (idempotent).
alter table public.writing_events
  add column if not exists schema_version smallint,
  add column if not exists seq            integer,
  add column if not exists pt             double precision,
  add column if not exists key_char       text;

create index if not exists writing_events_user_doc_t_idx
  on public.writing_events(user_id, doc_id, t);
create index if not exists writing_events_session_idx
  on public.writing_events(session_id);

alter table public.writing_events enable row level security;

drop policy if exists "we_select_own" on public.writing_events;
create policy "we_select_own" on public.writing_events
  for select using (auth.uid() = user_id);

-- Server-side enforcement of opt-in: insert only allowed when caller is opted in.
drop policy if exists "we_insert_optin" on public.writing_events;
create policy "we_insert_optin" on public.writing_events
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.research_opt_in = true
    )
  );

drop policy if exists "we_delete_own" on public.writing_events;
create policy "we_delete_own" on public.writing_events
  for delete using (auth.uid() = user_id);

-- 6. RPC: delete all of caller's events (used by Profile → "Delete my research data")
create or replace function public.delete_my_writing_events()
returns void
language sql
security invoker
as $$
  delete from public.writing_events where user_id = auth.uid();
$$;

-- 7. View: aggregate per-user counts (used by Profile)
create or replace view public.my_writing_event_counts as
  select user_id,
         count(*) as event_count,
         min(t)   as first_t,
         max(t)   as last_t
  from public.writing_events
  where user_id = auth.uid()
  group by user_id;

-- 7b. View: per-session aggregates reconstructed from the event stream.
-- Replaces the old writing_sessions table (dropped in section 4): it derives
-- clean per-session labels straight from the raw stream, so it can never drift
-- from the events and needs no extra client writes.
create or replace view public.writing_session_features as
  select
    session_id,
    user_id,
    doc_id,
    min(t)                                                          as started_at,   -- epoch ms
    max(t)                                                          as ended_at,
    min(pt)                                                         as started_pt,   -- hi-res ms
    max(pt)                                                         as ended_pt,
    count(*)                                                        as event_count,
    count(*) filter (where kind = 'input')                         as typing_events,
    count(*) filter (where kind = 'delete')                        as deletion_events,
    count(*) filter (where kind = 'paste')                         as paste_events,
    count(*) filter (where kind = 'keydown')                       as keystrokes,
    coalesce(sum(len_delta)  filter (where kind = 'input'  and len_delta > 0), 0) as chars_added,
    coalesce(sum(-len_delta) filter (where kind = 'delete' and len_delta < 0), 0) as chars_deleted,
    coalesce(sum(len_delta)  filter (where kind = 'paste'  and len_delta > 0), 0) as chars_pasted,
    count(*) filter (where (payload->>'composing') = 'true')       as composed_events
  from public.writing_events
  where user_id = auth.uid()
  group by session_id, user_id, doc_id;

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
-- and superseded codes resolve with a null publication_id.
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
  left join public.publications p on p.verify_code = v.code
  where v.code = upper(btrim(p_code))
  limit 1;
$$;

grant execute on function public.verify_by_code(text) to anon, authenticated;

-- ── 11. Content moderation ─────────────────────────────────────────────────
-- Two layers, both feeding one review queue:
--   (a) Auto-triage: at publish/comment time the client calls /api/moderate
--       (OpenAI Moderation) and caches the verdict on the content row.
--   (b) Human reports: signed-in users flag content into the reports table.
-- NOTHING is auto-deleted. An admin reviews and sets moderation_status='removed';
-- the feed then hides it. Auto-flagged content stays visible until reviewed.

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
-- Status: 'pending' (never checked) | 'ok' | 'flagged' (auto or reported) |
-- 'removed' (admin-hidden). Existing rows default to 'pending'.
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
