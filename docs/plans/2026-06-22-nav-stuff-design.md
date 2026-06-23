# Nav stuff — design (TODO #1)

A cluster of navigation improvements. All client-side over the existing
anchor-keyed state model; one additive DB migration.

## Sub-items

1. **Filter views** — see only Starred / Read / Unread / Hidden sections.
2. **Sidebar quick-jump bar** — filter pills + landmark jumps (`pre/aux`, `p3`,
   `p8`) + a 🎲 random jump to any not-hidden section.
3. **Hide** — a third per-section state alongside read/star. A hidden section is
   dropped from prev/next, from the sidebar tree (unless the Hidden filter is on),
   and from random-jump candidates.
4. **Remove broken in-content links** — the `[Go up to this section's line in the
   Full Table of Contents][Go to the Partial Guided Tour …]` blocks. They point at
   anchors from Mark's single-page doc that don't exist in Globway's per-section
   model. Stripped at build time (vendored source untouched).
5. **Rename** "The Map" → "Table of Contents".

## Key realization: the sidebar tree is the client-side source of truth

`Base.astro` renders the full TOC `Tree` (all 340 sections, depth-first =
reading order) in the sidebar on *every* page. Each row is
`<a class="row" data-row-key=… href=…>` with its title in `.t`. So the ordered
key+title+href list is already in the DOM everywhere — no `nav.json` needed.

- **Filtering**: toggle a `filtered-out` class on rows that don't match the active
  filter. Indentation is per-row `depth-N` padding (not nested-`ul` margins), so
  survivors keep correct indent and read as a clean flat list.
- **Random**: pick a random row whose key isn't hidden; navigate to its `href`.
- **Prev/next skip-hidden**: on a section page, walk the sidebar rows in order,
  skip hidden, recompute the prev/next the pager should point at, rewrite it.

Filtering selects rows document-wide by `[data-row-key]`, so on the Table of
Contents page the same pills also filter the big map tree.

## State model

`Entry = { read?, starred?, hidden?, updated_at }`. `toggle()` is already generic
over the field — extend the union to include `'hidden'`. `applyEntry` adds an
`is-hidden` class. `pullRemote`/upsert include `hidden`.

Migration `…_add_hidden.sql`:
`alter table public.section_state add column if not exists hidden boolean not null default false;`

## Filter semantics

- **All** (default): everything except hidden.
- **Starred / Read**: rows with that flag.
- **Unread**: not read and not hidden.
- **Hidden**: only hidden (so you can un-hide).

Active filter persists in `localStorage` across navigation. Default All.

## Landmark targets

`pre/aux → preliminary-auxiliary-practices`, `p3 → p3`, `p8 → p8` (real keys).
Data-driven array in the nav-bar component for easy editing.

## Files

- `scripts/build-content.mjs` — strip broken link blocks in `postProcess`; rebuild.
- `supabase/migrations/*_add_hidden.sql` + `schema.sql` — `hidden` column.
- `src/components/SectionControls.astro` — Hide button.
- `src/components/NavBar.astro` (new) — pills + landmark + random buttons.
- `src/layouts/Base.astro` — mount NavBar above the Tree.
- `src/scripts/app.ts` — hidden state, filtering, random, prev/next skip.
- `src/pages/index.astro` — rename to Table of Contents.
- `src/styles/global.css` — nav bar, `is-hidden`, `filtered-out`, hide button.
