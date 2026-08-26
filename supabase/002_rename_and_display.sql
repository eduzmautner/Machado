-- Machado — migration 002
-- Paste into the Supabase SQL Editor and hit Run. Safe to re-run.

-- A document normally titles itself from its first line. Once you rename
-- one by hand, that has to stick — otherwise the next keystroke in the
-- editor would silently overwrite the name you chose.
alter table public.documents
  add column if not exists title_manual boolean not null default false;

-- "Show excerpts" in Library settings, kept with your other preferences
-- so it follows you between machines.
alter table public.preferences
  add column if not exists show_excerpts boolean not null default true;
