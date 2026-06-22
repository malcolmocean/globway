-- Table privileges for the authenticated role. RLS filters rows; the role still
-- needs table-level GRANTs. anon intentionally gets nothing (sync requires login).
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.section_state to authenticated;
grant select, update on public.profiles to authenticated;
