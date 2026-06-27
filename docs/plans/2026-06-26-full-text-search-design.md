# Globway — full-text search (⌘K) architecture

**Date:** 2026-06-26
**Status:** implemented (branch `claude/full-text-search-*`, off the kb-navigation branch).

## Brief: what we're building and why it's shaped this way

Malcolm's wishlist asks for "full text search, something like a ⌘K interface." So:
a command-palette overlay, opened with ⌘K / Ctrl+K (or a 🔍 pill in the sidebar),
that searches **everything** — the 333 protocol sections' full body text, the 959
auxiliary practices, and the p3/p8 prompt cards — and lets you jump to any hit
with the keyboard.

The one real design tension is **cost**. Genuine full-text search needs the
tokens somewhere, and the corpus is ~2.67 MB of plaintext (≈ **919 KB gzipped**,
2041 records). The decisions below are all about not making everyone pay that.

## The shape

### 1. Build-time index — one static asset, html stripped to plaintext

`scripts/build-content.mjs` already emits derived JSON (sections, decks, toc,
hashes). We add a sixth output, `public/search.json`: one record per searchable
item, `{ id, t, key, title, sub, text }`, where `text` is the html stripped to
whitespace-collapsed plaintext and `t`/`key` let the client route to
`/s/<key>`, `/aux?p=<key>`, or `/p3|p8?p=<key>`. Reuses the same `byKeySection`
map and `decks` already built in that script, so it's a handful of lines.

Like the other generated JSON it's **gitignored** (regenerated each build), so it
adds nothing to the repo.

### 2. Cost: on-demand, not precached

The service worker's strategy is *precache everything* (~10 MB gzip — all 587
pages + assets — so the whole manual works offline). Dropping a 919 KB index into
that install batch would tax every first visit, and it's partly **redundant** with
the section HTML the SW already caches.

So `search.json` is the one asset deliberately **excluded** from the precache
(`EXCLUDE` set in `scripts/build-sw.mjs`). Instead:

- The client **lazy-fetches and indexes it on the first ⌘K only.** Someone who
  never searches never downloads it, and the MiniSearch indexing CPU/memory is
  likewise never spent.
- The SW's normal runtime fetch handler caches it on that first real fetch, so
  search keeps working offline *after* you've used it once.

We considered a two-tier scheme (ship a ~51 KB titles-only index eagerly, defer
bodies) but full-text is the actual ask, and on-demand + gzip + runtime-cache
already makes the single full file cheap. If size ever bites, the titles-only
tier is the lever to add.

### 3. Engine — MiniSearch, built lazily in the browser

`src/scripts/search.ts` fetches `search.json` once, builds a `MiniSearch` index
over `title` + `text`, and keeps a `docsById` map as the **single** copy of each
record (no `storeFields`, so the body text isn't duplicated into the index).
Search runs with `{ boost: { title: 4 }, prefix: true, fuzzy: 0.2, combineWith:
'AND' }` — prefix + light fuzz, title-weighted, so it feels like a real search
with a fast "jump to that section" on top. Results show title + a ~200-char
snippet windowed around the first matched term, with matches `<mark>`-ed (the
corpus is plaintext, so highlight markup is built by hand-escaping — safe).

### 4. UI + keyboard — reuses the existing overlay idiom

The overlay mirrors the `?` help overlay in `keyboard.ts`: a `role="dialog"` that
**owns its own keys** (its keydown `stopPropagation`s, and `.search-overlay` is in
the nav-guard selector), closes on Escape / backdrop / `astro:before-swap`.
Inside: ↑↓ (and Ctrl-n/p) move, Enter opens via the SPA router (`navigate`),
⌘/Ctrl+Enter opens in a new tab, mouse hover/click work too.

`⌘K` is added to the declarative keymap `TABLE` (new "Search" group, body + notes
scopes, so it appears in the generated help overlay) plus a sidebar-wide
special-case alongside `?` (the sidebar listener otherwise only acts on a focused
row). `initSearch()` is wired once from `app.ts`'s `once()`; the 🔍 pill in
`NavBar.astro` is a delegated `[data-action="open-search"]` click.

## Files touched

- `scripts/build-content.mjs` — emit `public/search.json`.
- `scripts/build-sw.mjs` — exclude `search.json` from the precache.
- `.gitignore` — ignore `public/search.json`.
- `src/scripts/search.ts` — **new**: lazy index, overlay, query/snippet/nav.
- `src/scripts/keyboard.ts` — `search.open` command + `mod+k` bindings + sidebar case.
- `src/scripts/app.ts` — `initSearch()` in `once()`.
- `src/components/NavBar.astro` — 🔍 search pill.
- `src/styles/global.css` — `.search-overlay` styles (mirrors `.kbd-help`).
- `package.json` — `minisearch` dependency.

## Trade-offs / future levers

- **919 KB on first search.** Acceptable given on-demand + gzip + runtime cache.
  Lever if needed: ship a titles-only tier eagerly, fetch bodies in the
  background.
- **⌘K won't fire while a text field is focused** (the nav guard bails on
  inputs), so opening the palette from inside the note editor needs a click on
  the pill. Consistent with the kb architecture; revisit if it chafes.
- **No offline search until first use** (by design — it's excluded from the
  precache). The trade we're making for a lean install.
