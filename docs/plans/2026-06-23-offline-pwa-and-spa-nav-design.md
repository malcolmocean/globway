# Offline PWA + persistent-sidebar SPA navigation

Date: 2026-06-23

## Goals

1. **Offline / installable (PWA).** The whole static site works with no network and
   can be installed to a home screen. *(Done — see "Stage 0" below.)*
2. **No sidebar reload on navigation.** Clicking a link in the table-of-contents
   should not re-fetch, re-render, flash, or re-scroll the sidebar.
3. **Stop baking the tree into every page.** The 333-row TOC tree is byte-identical
   across all 587 section pages (~88% of each ~110 KB page). Render it once,
   client-side, so pages shrink ~5× (and the precache with them).
4. **Copy-as-markdown button** (TODO #6): a `⧉.md` control in the section header
   that copies the section's markdown source, with cross-links rewritten to
   absolute `https://globway.top/s/<key>` URLs, working offline.

## Key architectural decisions

- **Section bodies stay server-rendered per page.** This preserves SEO,
  deep-linking, no-JS rendering, instant first paint, and avoids shipping the 3 MB
  `sections.json` to the browser. Only the *tree* is redundant, so only the tree
  moves client-side.
- **Markdown is the build-time source; both artifacts derive from it.**
  `build-content.mjs` already does `md.render(bodyMd)`. We keep `bodyMd` instead of
  discarding it: HTML for display, markdown for the copy button. No runtime
  markdown→html (would need markdown-it + alias map in the browser + lose SEO) and
  no html→md round-trip.

## Stage 0 — PWA (done)

- `public/manifest.webmanifest` + icons derived from `gwhf.jpg` (192, 512, maskable).
- `scripts/build-sw.mjs` (run after `astro build`) walks `dist/`, precaches every
  file (601 URLs ≈ 8 MB gzipped over the wire), and stamps a content-hash cache
  version. Cache-first with background refresh; cross-origin (Supabase) passes
  through to network; navigations fall back to the cached shell when offline.
- `Base.astro` links the manifest + registers the SW. `app.ts` re-runs
  `pullRemote()` on `window 'online'` — offline edits already persist to
  localStorage, and `pullRemote()`'s existing last-write-wins merge pushes them up
  on reconnect. Verified: with the dev server killed, never-visited sections,
  deck JSON, and localStorage writes all work.

## Stage 1 — ClientRouter + persistent sidebar + init lifecycle

- Add `<ClientRouter />` (`astro:transitions`, core — no dependency) to `Base.astro`.
- Wrap `<aside class="sidebar">` in `transition:persist` so it renders once and
  survives every navigation (no reload, scroll kept).
- Split `app.ts boot()` into:
  - **once** (first load only): SW registration, sidebar build (Stage 2),
    Supabase session + `pullRemote`, `online` listener, sidebar scroll listener.
  - **per-page** (`astro:page-load`): `applyAll`, read-tracking, deck init, sticky
    tops, scroll-to-current, and moving the `.current` highlight to the new URL.
- The module script (`import '../scripts/app.ts'`) runs once; all per-page work
  hangs off `astro:page-load` rather than `DOMContentLoaded`.

## Stage 2 — tree → `toc.json`, stripped from pages

- `build-content.mjs` emits a lightweight `toc.json` (key, title, depth, nesting,
  href — no bodies), bundled into the shared client JS.
- `Base.astro` renders an empty `<nav data-toc transition:persist>`; the client
  builds the same `<ul class="tree">` markup `Tree.astro` produced, once, on first
  load (guarded against rebuild). The existing state layer
  (`querySelectorAll('[data-row-key]')`) is agnostic to who built the rows.
- Net: section pages ~110 KB → ~15–20 KB; precache transfer ~8 MB → ~2–3 MB.

## Stage 3 — copy-as-markdown

- `build-content.mjs` keeps `bodyMd` per section and produces a copy-ready md with
  `#anchor`/cross-section links rewritten to absolute `https://globway.top/s/<key>`
  (reusing `aliasToCanonical` / `auxSlugToKey`), plus the same dead-nav cleanup.
- Each section page embeds its md in a hidden `<template data-section-md>` (travels
  with the page, precached for free). A `⧉.md` button in `SectionControls`/header
  copies it via the clipboard API, with a hover tooltip.
- Colophon (merged front-matter) is the one special section; its md is synthesized
  from its parts or the button is omitted there.

## Verification per stage

Build, run `astro preview`, drive Chrome: confirm (1) nav swaps without sidebar
reload, (2) page sizes dropped + tree builds + state markers apply, (3) copy button
yields absolute-link md — each also re-checked offline (server killed).
