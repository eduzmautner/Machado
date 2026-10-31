-- Machado — migration 004
-- Paste into the Supabase SQL Editor and hit Run. Safe to re-run.

-- Settings > Library display > Typeface. 'serif' is Georgia, 'sans' is
-- Inter, 'mono' is Courier New. Stored with the other preferences so the
-- Library looks the same on every machine.
alter table public.preferences
  add column if not exists entry_font text not null default 'serif';
