-- Machado — database schema
-- Paste this whole file into the Supabase SQL Editor and hit Run.
-- Safe to re-run: every statement is guarded.

-- ---------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------
create table if not exists public.documents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null default 'Untitled',
  content    text not null default '',        -- the editor's HTML
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- the library page lists your docs newest-first
create index if not exists documents_user_updated_idx
  on public.documents (user_id, updated_at desc);

-- ---------------------------------------------------------------
-- preferences (font / theme / zoom / alignment, so they follow you)
-- ---------------------------------------------------------------
create table if not exists public.preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  font       text not null default 'Georgia',
  theme      text,                            -- null = follow the OS
  zoom       int  not null default 100,
  align      text not null default 'left',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Row Level Security — the database itself refuses to hand one user
-- another user's rows, no matter what the app code asks for.
-- ---------------------------------------------------------------
alter table public.documents   enable row level security;
alter table public.preferences enable row level security;

drop policy if exists "documents are private to their owner" on public.documents;
create policy "documents are private to their owner"
  on public.documents for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "preferences are private to their owner" on public.preferences;
create policy "preferences are private to their owner"
  on public.preferences for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- keep updated_at honest (the library sorts on it)
-- ---------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists documents_touch_updated_at on public.documents;
create trigger documents_touch_updated_at
  before update on public.documents
  for each row execute function public.touch_updated_at();

drop trigger if exists preferences_touch_updated_at on public.preferences;
create trigger preferences_touch_updated_at
  before update on public.preferences
  for each row execute function public.touch_updated_at();
