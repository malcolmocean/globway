-- Paragraph-level notes: a third annotation kind ('para') that anchors a comment
-- to a whole block (paragraph / heading / list item / blockquote). It reuses the
-- existing quote/prefix/suffix/text_position anchor columns — the quote is the
-- block's normalized text — so no new columns are needed, only a looser check.
-- Additive + idempotent, same pattern as the other migrations.
alter table public.annotations
  drop constraint if exists annotations_kind_check;

alter table public.annotations
  add constraint annotations_kind_check
  check (kind in ('note', 'highlight', 'para'));
