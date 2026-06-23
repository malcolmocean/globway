-- Globway — Supabase schema for v1 (run in the Supabase SQL editor).
-- Per-user reading state, isolated by Row-Level Security. The browser client
-- talks to these tables directly using the public anon key; RLS is what keeps
-- each user's data private (the anon key alone grants no row access).

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user (auto-created on signup via trigger below)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are self-readable" on public.profiles;
create policy "profiles are self-readable"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "profiles are self-writable" on public.profiles;
create policy "profiles are self-writable"
  on public.profiles for update using (auth.uid() = id);

-- create a profile row automatically when a new auth user is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- section_state: read / starred per (user, section anchor key)
-- section_key is Mark's stable anchor (slug or legacy numeric), NOT a page id,
-- so state survives both his edits and our restructuring.
-- ---------------------------------------------------------------------------
create table if not exists public.section_state (
  user_id     uuid not null references auth.users (id) on delete cascade,
  section_key text not null,
  read        boolean not null default false,
  starred     boolean not null default false,
  hidden      boolean not null default false,
  read_at     timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (user_id, section_key)
);

alter table public.section_state enable row level security;

drop policy if exists "section_state is self-owned" on public.section_state;
create policy "section_state is self-owned"
  on public.section_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists section_state_user_idx on public.section_state (user_id);

-- ---------------------------------------------------------------------------
-- Table privileges. RLS filters ROWS, but the role still needs table GRANTs.
-- Only `authenticated` (signed-in users) gets access; `anon` gets nothing, so
-- reading state requires being logged in. Per-user isolation is enforced by the
-- RLS policies above (auth.uid() = user_id).
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.section_state to authenticated;
grant select, update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- (Deferred, here for reference — not used by v1)
-- notes:       per-section freeform notes
-- timer_logs:  "try this for N minutes" practice sessions
-- Both scoped by section_key + user_id with identical RLS.
-- ---------------------------------------------------------------------------
