# CLAUDE.md

Interactive reading layer for Mark Lippmann's Global Wayfinding Meditation protocol.
Static Astro site → GitHub Pages at <https://globway.top>, with cross-device sync via
Supabase. `HUMAN.md` tracks the human-owned knobs (DNS, Supabase dashboard, secrets);
this file is for working in the code.

## Commands

- `npm run dev` — build content, then `astro dev` (localhost:4321).
- `npm run build` — content + `astro build` + service-worker build.
- `npm run content` — regenerate `src/data/*.json` from `protocol-source/` only.
- Deploy: push to `main` → GitHub Pages Action. Prod deploys from `main`; only push
  on an explicit ask (see memory `globway-deploy-workflow`).

## Content pipeline

The prose is vendored markdown in `protocol-source/` (synced from upstream via
`scripts/sync-upstream.sh`). `scripts/build-content.mjs` parses it into anchor-keyed
`src/data/sections.json` + `aliases.json`, consumed at build time through
`src/lib/content.ts`. Identity is **anchor-based** so it survives upstream edits — never
key off header text or position. Decks (the one-card-at-a-time pages) ship as separate
`public/*.json` (`aux.json`, `p3.json`, `p8.json`), fetched client-side.

Don't hand-edit `src/data/*.json` — they're generated. Change the source or the build script.

## Architecture

- **SPA nav**: Astro `<ViewTransitions>`. The sidebar, nav toggle, and backdrop are
  `transition:persist`, so they survive swaps and their listeners wire **once**.
- **`src/scripts/app.ts`** is the client entry. `once()` runs a single time (persistent
  wiring); `setupPage()` runs on every `astro:page-load` (initial + each swap) and
  re-inits per-page features behind a fresh `pageAbort` `AbortController` — pass
  `{ signal }` to per-page listeners so they tear down on navigation.
- **`keyboard.ts`** — declarative keymap; "where am I" is whatever has real focus
  (body / sidebar / notes), no mode machine. Full rationale:
  `docs/plans/2026-06-26-kb-navigation-architecture.md`. The `?` help overlay is
  **generated from the `TABLE`/`COMMANDS` keymap** — add or change a binding there
  (with its `COMMANDS` entry + `group`) and the help list updates itself. Never
  hand-maintain a separate shortcut list, and when you add a key, make sure it
  lands in the table so `?` stays in sync.
- **Decks** (`Presenter.astro` + `initDeck` in app.ts) — prev/next are real anchors
  with `?p=<key>` hrefs; a delegated click handler intercepts plain clicks for
  client-side paging but lets modified/middle clicks through (see below).
- **State/sync** (`lib/supabase.ts`) — `section_state` keys on any string, so deck
  cards, preamble-collapse (`preamble:<deck>`), etc. reuse the same read/star/hide
  toggle. Sync is last-write-wins; works signed-out (localStorage) and merges on
  sign-in / back-online.
- Internal links must be base-aware: use `import.meta.env.BASE_URL` (or `sectionHref`),
  and `@@BASE@@` placeholders inside generated HTML (resolved by `resolveBase`). The
  site can serve at `/` (custom domain) or `/<repo>` (project Pages).

## Conventions

- **Cross-platform interactions are our job even when unspecified.** The human won't
  always call out mac vs windows vs touch — make bindings and click handling do the
  sane thing on all three by default:
  - "Open elsewhere" clicks = ⌘-click (mac), Ctrl-click (win/linux), Shift-click (new
    window), middle-click (`e.button !== 0`). When a custom handler hijacks an anchor,
    bail on *all* of these and let the native href win — don't platform-switch to just
    one modifier. Mirror Astro's router check:
    `if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;`
  - Keyboard `mod` = ⌘ on mac, Ctrl elsewhere — resolved once in `keyboard.ts`; reuse
    that, don't hardcode a platform.
  - Mobile long-press fires `contextmenu`, not `click`, and uses the anchor's real
    href — so keep hrefs genuine (never leave a `#`) and don't `preventDefault` the
    context menu. A real href makes desktop modifier-click *and* mobile long-press
    both work for free.
- Support down to iPhone SE / 375px; don't bother below (memory `globway-mobile-floor`).
- Design docs live in `docs/plans/` — read the relevant one before reworking a
  subsystem (nav, search, notes/highlights, offline/PWA, keyboard).
