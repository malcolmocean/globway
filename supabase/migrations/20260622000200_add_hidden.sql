-- TODO #1 (nav): a third per-section state alongside read/starred. A hidden
-- section drops out of prev/next, the sidebar tree (unless the Hidden filter is
-- on), and random-jump candidates. Additive + defaulted, so existing rows and the
-- client's upsert keep working unchanged.
alter table public.section_state
  add column if not exists hidden boolean not null default false;
