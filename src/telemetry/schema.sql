-- ─── Inkk telemetry / human-signal schema ──────────────────────────────────
-- Idempotent. Safe to run on an existing database with documents/profiles.
-- Run as service-role / SQL editor in Supabase.
--
-- 2026-09-24: the social layer (feed, likes, comments, follows, reports,
-- moderation, admin) was removed from the product. This script no longer
-- creates any of it, and verify_by_code no longer joins publications. To
-- migrate a database that already has those objects, follow
-- docs/backend-changes-2026-09.md (it also enables anonymous sign-ins for the
-- desktop companion). Running this script on a not-yet-migrated database is
-- still safe: it only ever adds, never drops, the objects it doesn't own.

-- 1. Profile: research opt-in (default ON; users explicitly opt in via T&C at signup
--    and may opt out from Notes). tos_accepted_at records when they agreed.
--    The desktop companion upserts a row here for anonymous users too, so the
--    "insert own row" policy on profiles must use auth.uid() = id (not a role check).
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

-- 2. Documents: a title (the Notes page shows it; the companion has no documents
--    row, its title lives on the certificate only) plus cached process metrics.
alter table public.documents
  add column if not exists title             text,
  add column if not exists total_writing_secs real     not null default 0,
  add column if not exists keystrokes        integer  not null default 0,
  add column if not exists deletions         integer  not null default 0,
  add column if not exists pastes            integer  not null default 0,
  add column if not exists revision_count    integer  not null default 0,
  add column if not exists human_score       smallint,
  add column if not exists score_tier        text,
  add column if not exists score_features    jsonb;

-- 3. Writing sessions: REMOVED.
-- This table was never written by the client — sync.js only uploads
-- writing_events — so it only ever held zero rows. Per-session aggregates are
-- now derived on demand by the writing_session_features view (section 6b),
-- which can never drift from the event stream. Drop the dead table if present.
drop table if exists public.writing_sessions cascade;

-- 4. Writing events — PACKED storage.
-- Previously one row PER raw event (keydown/keyup/input/caret/…). At 3–4 events
-- per character, plus three indexes, those tiny rows were ~90% Postgres tuple +
-- index overhead and filled the 500 MB free tier fast. We now store ONE row per
-- upload batch (≤500 events) as a single TOAST-compressed JSONB array, with the
-- batch's event count and time span denormalised onto columns for the Notes
-- page. Storage drops ~5–10×. Feature extraction is UNAFFECTED: it runs
-- client-side from the in-memory ring / IndexedDB and never reads these rows
-- back. The raw per-event corpus is preserved verbatim inside `events`, and the
-- "Download my data" export re-expands it to the exact pre-packing shape.
-- Only synced when profile.research_opt_in = true (enforced client-side AND RLS).
-- The companion does not upload here: its events travel only inside a
-- /api/certify request, which scores them and does not store them.

-- Drop the old one-row-per-event table and its dependent views. DESTRUCTIVE:
-- export any raw rows you still want (Notes → Download my data) first.
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

-- 5. RPC: delete all of caller's events (used by Notes → "Delete my data")
create or replace function public.delete_my_writing_events()
returns void
language sql
security invoker
as $$
  delete from public.writing_event_batches where user_id = auth.uid();
$$;

-- 6. View: aggregate per-user counts (used by the Notes research section). Sums
-- the packed batches, so the displayed total is identical to the old per-row count(*).
create or replace view public.my_writing_event_counts as
  select user_id,
         coalesce(sum(event_count), 0)::bigint as event_count,
         min(min_t)                            as first_t,
         max(max_t)                            as last_t
  from public.writing_event_batches
  where user_id = auth.uid()
  group by user_id;

-- 6b. View: per-session aggregates reconstructed from the packed event stream.
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

-- ── 7. Verification certificates ───────────────────────────────────────────
-- An immutable ledger: one row per certified version. It stores only metadata
-- and a content hash — never a copy of the text and never the keystroke
-- process — so the full audit trail of every version stays tiny. Editing a
-- piece and re-certifying issues a NEW code; old codes keep verifying the
-- older text via their stored hash. (The web editor's keystroke stream lives in
-- writing_event_batches, gated by opt-in; the certificate never duplicates it.)
--
-- Rows are written by /api/certify with the service-role key. user_id may be
-- an ANONYMOUS Supabase user: the companion signs in anonymously so a writer
-- can get a code without creating an account (see docs/backend-changes-2026-09.md
-- for the dashboard toggle). Anonymous users carry the `authenticated` role, so
-- every auth.uid() policy below applies to them unchanged.

-- "Current" pointer on the document, so the Notes page can show a piece's code.
alter table public.documents
  add column if not exists verify_code  text,
  add column if not exists content_hash text;

create table if not exists public.verifications (
  code            text primary key,                 -- INKK-XXXX-XXXX-XXXX
  doc_id          uuid,                             -- documents.id on the web; a per-session uuid from the companion (no row)
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

-- September 2026: one short fingerprint per sentence (src/verify/sketch.js), so
-- a reader's copy can be checked sentence by sentence without the text being
-- stored, and what the certificate is bound to ('text' | 'session' | 'file').
-- Written only by /api/certify, which writes without them on a database that
-- doesn't have them yet.
alter table public.verifications add column if not exists text_sketch text[];
alter table public.verifications add column if not exists binding text;

-- September 2026: the picture of a signed name (base64 PNG, at most 200 KB),
-- for names signed in web mail, which drops pictures pasted into it. Served to
-- anyone with the code at https://www.inkk.site/s/<code>.png by /api/sig, so it
-- is public by code exactly like the certificate itself (it shows the name the
-- writer signed with, nothing more). /api/certify writes it once per code and
-- never replaces it; /api/sig serves only a real PNG of a signature's size,
-- whatever a row holds. Never returned by /api/verify or verify_by_code.
alter table public.verifications add column if not exists signature_png text;

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

-- ── 8. Public verify-by-code ───────────────────────────────────────────────
-- Returns one certificate by exact code, for anyone (readers checking an
-- exported PDF or a pasted seal are usually logged out). Exact match only.
-- publication_id is kept in the return shape for the existing client and is
-- always null: there is no feed any more, so a code never maps to a public page.
-- (drop + create rather than `create or replace` so a signature change never
-- fails with "cannot change return type".)
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

-- ── 9. Lock the human-signal score against client forgery ───────────────────
-- human_score / score_tier / verified ARE the "human-verified" claim. The
-- "write your own row" RLS policies are row-level, not column-level — so
-- without this a signed-in user can POST
--   { human_score: 100, score_tier: 'Distinct', verified: true }
-- straight through the public API and mint a verified certificate without
-- writing a single word. (No need to read score.js or forge any telemetry: the
-- score is just a number the client hands us, and the table trusts it.) A
-- column-level REVOKE can't fix it: a table-level UPDATE grant still covers the
-- column.
--
-- So we force these columns for the public API roles (anon / authenticated):
-- on INSERT they are nulled / set false, on UPDATE they are pinned to their old
-- value. They can therefore be set ONLY by a trusted writer — the service_role
-- key used by /api/certify, which recomputes the score server-side from the raw
-- event stream. The SQL editor (postgres) and service_role are unaffected.
--
-- IMPORTANT: deploy this together with the /api/certify route. On its own it
-- makes EVERY new certificate come out unverified, because the client fallback
-- write is the only other thing that writes a score.

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

-- Only the trust-bearing columns are locked. documents.score_features stays
-- client-written on purpose: it's the cosmetic radar/breakdown the human-signal
-- panel renders, not the "verified" claim. The headline (human_score /
-- score_tier on the certificate) is server-authoritative.
