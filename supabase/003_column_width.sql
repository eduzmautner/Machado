-- Machado — migration 003
-- Paste into the Supabase SQL Editor and hit Run. Safe to re-run.

-- Edit > Column Width. Stored with the other preferences so the width you
-- write at follows you between machines, like font, theme and zoom.
alter table public.preferences
  add column if not exists column_width text not null default 'Narrow';
