-- Adds the two columns the bio + author-note features need.
-- Idempotent. Run once in the Supabase SQL editor (or append to schema.sql).

-- Profile bio: a short "who I am / what I write about" blurb.
alter table public.profiles
  add column if not exists bio text;

-- Per-piece author's note: a little context shown at the top of a published piece.
alter table public.publications
  add column if not exists author_note text;
