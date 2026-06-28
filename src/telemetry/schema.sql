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

-- 4. Writing sessions — one row per continuous writing session
create table if not exists public.writing_sessions (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  doc_id        uuid not null,
  started_at    bigint not null,             -- epoch ms
  ended_at      bigint,                      -- epoch ms (null while open)
  event_count   integer not null default 0,
  chars_added   integer not null default 0,
  chars_deleted integer not null default 0,
  keystrokes    integer not null default 0,
  pastes        integer not null default 0,
  features      jsonb,
  score         smallint,
  created_at    timestamptz not null default now()
);
create index if not exists writing_sessions_user_doc_idx
  on public.writing_sessions(user_id, doc_id, started_at desc);

alter table public.writing_sessions enable row level security;

drop policy if exists "ws_select_own" on public.writing_sessions;
create policy "ws_select_own" on public.writing_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "ws_insert_own" on public.writing_sessions;
create policy "ws_insert_own" on public.writing_sessions
  for insert with check (auth.uid() = user_id);

drop policy if exists "ws_update_own" on public.writing_sessions;
create policy "ws_update_own" on public.writing_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "ws_delete_own" on public.writing_sessions;
create policy "ws_delete_own" on public.writing_sessions
  for delete using (auth.uid() = user_id);

-- 5. Writing events — append-only fine-grained event stream
-- Only synced when profile.research_opt_in = true (enforced client-side AND below).
create table if not exists public.writing_events (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  doc_id        uuid not null,
  session_id    uuid not null,
  t             bigint not null,                -- epoch ms client-side
  kind          text not null,                  -- keydown|keyup|input|delete|paste|drop|caret|focus|blur|visibility|session_start|session_end|doc_switch
  key_class     text,                           -- letter|digit|punct|space|nav|edit|modifier|other  (raw key NEVER stored for letter/digit)
  input_type    text,                           -- InputEvent.inputType
  len_delta     integer,                        -- chars added/removed
  caret_pos     integer,
  selection_len integer,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

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
  delete from public.writing_sessions where user_id = auth.uid();
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
-- An immutable ledger: one row per published version. It stores only metadata
-- and a content hash — never a copy of the text and never the keystroke
-- process — so the full audit trail of every version stays tiny. Editing a
-- piece and re-publishing issues a NEW code; old codes keep verifying the
-- older text via their stored hash. (The keystroke stream lives in
-- writing_events, gated by opt-in; the certificate never duplicates it.)

-- "Current" pointer on the publication for quick display / lookup.
alter table public.publications
  add column if not exists verify_code  text,
  add column if not exists content_hash text;
create unique index if not exists publications_verify_code_idx
  on public.publications(verify_code) where verify_code is not null;

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
  select v.code, v.publication_id, v.title, v.author_name, v.author_username,
         v.content_hash, v.word_count, v.human_score, v.score_tier, v.verified, v.issued_at
  from public.verifications v
  where v.code = upper(btrim(p_code))
  limit 1;
$$;

grant execute on function public.verify_by_code(text) to anon, authenticated;
