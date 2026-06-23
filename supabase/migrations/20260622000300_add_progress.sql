-- TODO #4 (passive read state): track how far a user has scrolled through a
-- section so partway-through reading survives across devices, and so an
-- "in progress" view can resume / show %s.
--
-- progress = max scroll fraction (0..1) ever reached on that section. Reaching
-- the end auto-sets read=true and clears progress back to 0, so an in-progress
-- row is exactly: progress in (0,1) AND not read. Additive + defaulted, so
-- existing rows and the client's upsert keep working unchanged (same pattern as
-- the `hidden` column in 20260622000200).
alter table public.section_state
  add column if not exists progress    real        not null default 0,
  add column if not exists progress_at timestamptz;
