# Globway

An interactive reading layer for Mark Lippmann's **Global Wayfinding Meditation**
manual (source: [`meditationstuff/protocol_1`](https://github.com/meditationstuff/protocol_1),
published at [meditationbook.page](https://meditationbook.page)).

The original is deep but long, repetitive, and easy to get lost in. Globway
re-renders it as a navigable map of small pages so you can see the whole shape,
track what you've **read**, **star** sections, and (soon) take notes, run practice
timers, and ask an LLM about sections — synced across phone and computer.

## How it works

- **`protocol-source/`** — vendored copy of Mark's markdown (provenance in
  `UPSTREAM_COMMIT.txt`). Refresh with `scripts/sync-upstream.sh`.
- **`scripts/build-content.mjs`** — parses the TOC (which carries the real
  hierarchy) and slices the body at each anchor into `src/data/sections.json`
  (+ `aliases.json`). Everything is keyed by Mark's stable anchor IDs, so reading
  state and deep links survive both his edits and our restructuring.
- **Astro** static site: a **Map** home (`/`), one page per leaf section
  (`/s/<anchor>`), a sidebar, prev/next, and redirect pages for legacy anchors.
- **Supabase** (Postgres + magic-link auth) for cross-device sync, called directly
  from the static client with Row-Level Security. Without it, the app runs in
  localStorage-only mode.

See [`docs/plans/2026-06-22-globway-interactive-protocol-design.md`](docs/plans/2026-06-22-globway-interactive-protocol-design.md)
for the full design.

## Develop

```bash
npm install
npm run dev        # builds content + starts Astro at http://localhost:4321
npm run build      # static site into dist/
```

Copy `.env.example` → `.env.local` and fill in Supabase keys to test sync locally
(optional — it works without).

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml` (build → GitHub Pages).
Supabase keys and base path come from repo **Variables**. See
[`HUMAN.md`](HUMAN.md) for the one-time setup steps.

## Credit

All protocol content is by "meditationstuff" (Mark Lippmann) and collaborators.
This is a lightly-transformed, structurally-rearranged edition per the source's
terms; it links back to the canonical document and may lag it.
