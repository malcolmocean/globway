# Globway — page-level notes & text highlights

**Date:** 2026-06-25
**Status:** v1 implemented (migration, build hashes, anchoring, UI, sync).

## Purpose

Add the first slice of note-taking to Globway: **page-level notes** (a comment
attached to a whole section) and **highlight notes** (Kindle-style: select text,
highlight it, optionally attach a comment). The two kinds are stored together and
shown together in one UI, but are visually distinguishable.

This is deliberately the *first* slice. Later note-shaped ideas — incremental
reading that resurfaces old notes, "random note", an LLM Q&A over a section,
practice timers — are **designed-for but out of scope here**. The data model and
identity choices below are picked so those don't require a rewrite (see
[Forward compatibility](#forward-compatibility)).

The dominant constraint: **Mark edits the source constantly** (often weeks of
heavy editing on a single section, but in aggregate his behaviour is
append-heavy). Notes must stay sane across his edits — never silently jump to the
wrong place, never get lost, and never spam the reader with false "stale"
warnings.

## What we inherit (current architecture)

- All user state is keyed to **Mark's stable anchor IDs** (`section_key`), not
  prose/page numbers — the spine of the whole project (`README.md`,
  `docs/plans/2026-06-22-globway-interactive-protocol-design.md`).
- `scripts/build-content.mjs` slices the concatenated source into per-section
  HTML keyed by anchor → `src/data/sections.json`, `aliases.json`, `toc.json`.
- Reading state lives in one Supabase table, `section_state`, one row per
  `(user_id, section_key)`, with **localStorage-first optimistic writes** and a
  **last-write-wins** merge on `updated_at` (`src/scripts/app.ts`,
  `supabase/schema.sql`, `supabase/migrations/`). RLS isolates each user.
- `section_state` is **append-only in practice** — rows are only ever upserted,
  never deleted. There is no delete-sync machinery yet.
- `aliasToCanonical` already maps every legacy/renamed anchor to its current
  canonical key (and the front-matter merge folds absorbed sections in as
  aliases) — i.e. renames/merges are already a solved lookup.

## Core design

### Anchoring a highlight (the hard part)

A highlight points at a *range of text inside* a section, and that text can
change. We store **three selectors and use them as cross-checks**, not as a
single brittle pointer. This is the W3C Web Annotation / Hypothesis approach:

1. **`quote`** — the exact selected text.
2. **`prefix` / `suffix`** — ~32 chars of surrounding context on each side.
3. **`text_position`** — character offset into the section's *normalized
   plaintext* (whitespace collapsed, Unicode NFC).

All matching runs against the section's **normalized rendered plaintext**, never
against HTML or markdown — so markdown-it re-render churn and tag changes never
disturb anchoring. The runtime walks `.content`'s text nodes to build that
plaintext, resolves a range, then maps it back onto DOM text nodes and wraps the
range in `<mark>` segments.

**Re-anchoring on load:**

1. Find all occurrences of `quote` in the current plaintext.
2. Exactly one → done.
3. Several (the "I highlighted two duplicated tokens" case) → `prefix`/`suffix`
   almost always disambiguates; if context still ties, `text_position` picks the
   nearest occurrence. The only genuinely unrecoverable case is *identical text +
   identical surrounding context + a large positional shift*, which is vanishingly
   rare and still degrades safely (see [Failure modes](#failure-modes)) — never a
   silent wrong placement.
4. Zero exact matches → one **fuzzy pass** (approximate string match within the
   section). A single good-enough match (high similarity threshold) re-anchors and
   **silently updates the stored `quote`** to the new text — small edits
   self-heal instead of accumulating as orphans. Otherwise → orphan.

Rejected alternative: anchoring relative to Mark's in-text `<span id>` anchors —
they're sparse (mostly section heads), useless mid-paragraph.

### Staleness: hash fast-path, local per-highlight

The hash is stored **per annotation** (the section-content hash it was last
verified against) and is **purely an optimization** — the quote is always the
source of truth, so nothing correctness-bearing rides on the hash.

On load, for each annotation in the current section:

- annotation's `section_hash` == section's current hash → **trust it, skip all
  work.** The common case, since Mark mostly isn't touching that section.
- hashes differ → run the quote/context/position resolve above. On success,
  **re-stamp the annotation's `section_hash`** in the DB; next load is fast again.

Because the hash is advisory, doing the re-stamp client-side is safe: a failed
offline write, a two-device race, or a hand-edited row only costs a cheap
re-search next load. There is no shared state to corrupt.

Staleness is therefore **local to each highlight**: a highlight is "healthy" iff
*its own* quote still resolves, regardless of edits elsewhere in the section. This
is the key sanity property — Mark fixing a typo in paragraph 5 never flags your
highlight in paragraph 2. (Contrast: gating staleness on a whole-section hash
would cause an alert storm on every edit. We explicitly do not do that.)

### Failure modes

Ordered by likelihood. The floor everywhere is: **never silently misplace, never
lose a note.**

| Failure | Handling |
|---|---|
| Edit elsewhere in section (incl. appends) | Free — position-independent re-search; hash fast-path keeps it cheap. |
| Small edit *to* the highlighted phrase | Fuzzy pass re-anchors and self-heals the stored `quote`. |
| Section **renamed / merged** | Resolve `section_key` through `aliasToCanonical` before render → note follows to the survivor page automatically. (Also retroactively fixes the same latent gap in read/star state.) |
| Section **deleted entirely** (Mark's soft guarantee says he won't) | Note becomes "homeless" but stays fully readable from its **`title_snapshot` + `quote` + `body`** in the global notes view. Never lost. |
| Highlight truly unresolvable (quote gone / moved off-page) | **Orphan**, not deleted. Shown in the page's notes list as *"on the text: '…quote…' — [your comment]"*, flagged detached. An orphaned highlight is structurally a page-note that carries a remembered quote — so it reuses the page-note display; no new UI surface. |
| Same note edited on two devices | Last-write-wins by `updated_at`, same as all existing state. |
| Note **deleted** on one device | Soft-delete tombstone (`deleted=true`) so a pull from another device can't resurrect it. **New machinery** vs. today's append-only `section_state`. |
| Selection spans paragraphs / list items | quote + offsets work on the flattened plaintext; re-wrapping produces multiple `<mark>` segments. |

**Worst-case verdict:** a highlight degrades into a readable note-with-a-quote.
That's acceptable and it's cheap, because it reuses the page-notes UI we're
already building.

**Optional, low-cost (include unless we want a leaner v1):** a **"realign"**
button on an orphan → "select where this goes now" reuses the *create-highlight*
code path but updates the existing row's anchor fields. The schema supports this
natively, so including or dropping it carries **no tech debt either way**.

**Deferred:** cross-section relocation (if a highlight's text moved to a *new
sibling* section after a split, a global quote-search could offer "this seems to
live in [X] now — move it?"). More expensive (search every section); the orphan
floor already catches it. Not in v1.

## Data model — the migration

One additive, idempotent migration, same pattern as the existing four. A single
**`annotations`** table holds both kinds (`kind in ('note','highlight')`); the
implementation-level choice of one-vs-two tables is irrelevant to the UI, and one
flat, independently-queryable table is exactly what "random note" / "resurface
old notes" want later.

```sql
-- supabase/migrations/<ts>_add_annotations.sql
create table if not exists public.annotations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  section_key    text not null,          -- canonical anchor at creation; resolved through aliases on read
  kind           text not null check (kind in ('note','highlight')),
  body           text,                   -- comment text; null = bare highlight
  -- anchor (all null for page-level notes):
  quote          text,
  prefix         text,
  suffix         text,
  text_position  integer,                -- offset into normalized plaintext (tiebreaker/hint)
  color          text,
  -- staleness + self-description:
  section_hash   text,                   -- section content hash last verified against (advisory fast-path)
  title_snapshot text,                   -- section title at creation, so deleted-section notes stay readable
  orphaned       boolean not null default false,  -- cached: could not be re-anchored at last visit (advisory)
  -- sync:
  deleted        boolean not null default false,  -- soft-delete tombstone
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
```

Notes on columns:

- `orphaned` is a **cached advisory** flag updated when the client visits a
  section and re-checks; it lets the global notes view list "needs attention"
  without re-resolving every section. It may lag (acceptable).
- `section_hash` is per-annotation and advisory (see staleness above).
- We keep page-level notes as ordinary rows with all anchor columns null. There
  may be **many** per section (page-notes and highlights alike) — no
  one-note-per-page constraint.

## Build step change

One small addition to `scripts/build-content.mjs`: emit a **content hash per
section** (hash of the normalized plaintext) into `sections.json`, and a tiny
`key → hash` map (e.g. fold into `toc.json` or a new `hashes.json`) bundled
client-side. The per-section hash powers the fast-path; the bundled map lets the
(future) global notes view show cheap "section changed since your note" hints
without shipping every section's plaintext. Low coupling — everything else is
client + the table.

## Client architecture

Plain Astro `<script>` islands, consistent with the no-framework house style in
`src/scripts/app.ts`. Roughly:

- **Selection → popover:** on text selection within `.content`, show a small
  popover: Highlight (with color), Add note. Creating captures
  `quote/prefix/suffix/text_position/section_hash/title_snapshot`.
- **Rendering marks:** after a section renders (and after a remote pull),
  re-anchor each highlight and wrap ranges in `<mark>`; clicking a mark
  opens/edits its comment.
- **Notes panel:** a per-section panel listing this page's annotations —
  page-notes and highlight-comments **together but visually distinguished**
  (highlights show their quote; page-notes don't). Orphans appear here flagged.
- **Page-note affordance:** a way to add a section-level note that isn't tied to
  any selection.
- **Global notes view (designed-for, minimal or deferred in v1):** aggregates
  annotations across sections; the home for homeless/orphaned notes and the seam
  for later "random note" / resurfacing.

### Sync

Same shape as existing state, with two differences forced by multi-row +
deletable data:

- localStorage-first; key e.g. `globway:annotations`, keyed by `id`.
- Pull/merge **per `id`, last-write-wins on `updated_at`**.
- **Tombstones:** deletes set `deleted=true` and sync like any update; the client
  hides tombstoned rows. (Tombstone purging can come much later; not needed for
  correctness.)
- Resolve `section_key` through `aliasToCanonical` when grouping/rendering, so
  renamed/merged sections keep their notes.

## Scope boundary

Highlights in v1 are for **`/s/<key>` section pages only**. The decks (`/aux`,
`/p3`, `/p8`) render client-side from fetched JSON and swap cards in place —
highlightable in principle but a different beast; deferred deliberately.
Page-level *notes* could extend to decks later since they're just key-scoped.

## Testing

The full Supabase local stack (`supabase start`) does **not** run in the web
session's network policy (`api.supabase.com` and Docker's blob CDN are both
egress-blocked). We don't need it. The migration is validated with a
**Docker-free local harness** (verified working 2026-06-25):

1. apt-installed Postgres 16, throwaway cluster.
2. A minimal **Supabase shim**: `auth.users` table, `auth.uid()` reading a
   per-session GUC (`request.jwt.claim.sub`), and the `anon` / `authenticated`
   roles.
3. Run every migration in `supabase/migrations/` in order → must apply cleanly.
4. Exercise RLS: `begin; set local role authenticated; set local
   "request.jwt.claim.sub" = '<uuid>';` then assert a user sees only their own
   rows and that a cross-user insert is rejected by `WITH CHECK`.

This covers exactly where Supabase-migration bugs live — **DDL validity + RLS
correctness**. It does **not** cover GoTrue magic-link, PostgREST request
shaping, or the browser round-trip; those need a real `supabase start` (a more
permissive environment) or a test against the live project, and are out of scope
for validating this PR. The migration is additive + idempotent, so Malcolm
applies it with `supabase db push` with low risk.

## v1 scope (the build order)

1. Migration: `annotations` table + RLS + grants + index. Validate via the local
   harness above.
2. Build: per-section content hash into `sections.json` (+ bundled hash map).
3. Client: anchoring module (resolve quote/context/position; fuzzy self-heal;
   DOM `<mark>` wrapping) for `/s/<key>` pages.
4. Client: selection popover (highlight + color, add note) and mark editing.
5. Client: per-section notes panel (page-notes + highlight-comments together,
   distinguished; orphans flagged).
6. Sync: localStorage-first, per-id LWW, tombstones, alias-follow on read.
7. (Optional) orphan **realign** affordance.
8. Verify end-to-end locally (read/star regression check, notes survive a
   simulated source edit, orphan falls back to readable note).

## Forward compatibility

Chosen so later ideas don't force a rewrite:

- **Flat, queryable `annotations` table + stable anchor keys** → "random note",
  incremental-reading resurfacing, and a global notes view are straightforward
  reads.
- **Self-describing rows** (`title_snapshot`, `quote`) → notes survive section
  deletion and power an aggregate view independent of current content.
- **`kind` discriminator** → adding future annotation kinds is additive.
- **Per-annotation hash + alias-follow** → robust to Mark's editing without
  per-feature special-casing.
- Untouched: LLM section Q&A and practice timers are orthogonal and unaffected.
