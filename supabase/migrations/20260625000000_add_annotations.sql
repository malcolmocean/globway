-- Notes & highlights: one table for both page-level notes (kind='note') and
-- text highlights (kind='highlight'). Anchor fields are null for page-notes.
-- Soft-delete tombstones enable multi-device sync without resurrection.
create table if not exists public.annotations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  section_key    text not null,
  kind           text not null check (kind in ('note','highlight')),
  body           text,
  quote          text,
  prefix         text,
  suffix         text,
  text_position  integer,
  color          text,
  section_hash   text,
  title_snapshot text,
  orphaned       boolean not null default false,
  deleted        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.annotations enable row level security;

drop policy if exists "annotations are self-owned" on public.annotations;
create policy "annotations are self-owned"
  on public.annotations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists annotations_user_section_idx
  on public.annotations (user_id, section_key);

grant select, insert, update, delete on public.annotations to authenticated;
