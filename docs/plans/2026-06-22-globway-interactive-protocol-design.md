# Globway — an interactive reading layer for Mark Lippmann's meditation protocol

**Date:** 2026-06-22
**Status:** Design validated; v1 in progress

## Purpose

Mark Lippmann's "Global Wayfinding Meditation" manual (source:
`meditationstuff/protocol_1`, published at meditationbook.page) is long,
repetitive, and structurally messy — easy to get lost in, hard to return to.
This project re-renders it as a navigable, interactive document so a reader can:

- See the shape of the whole thing and where they are in it.
- Track what they've **read**, **star** sections, and (later) mark **revisit**.
- (Later) take per-section notes; run a "try this for N minutes" timer with a log;
  get nudged toward a random preliminary/auxiliary practice; ask an LLM about sections.
- Sync all of this across phone + computer.

Audience: eventually Mark's community / public. Multi-user from day one; licensing
is permissive (he allows lightly-transformed, structurally-rearranged forks that
link back).

## Core constraints & insights

1. **Anchor IDs are the stable spine.** Nearly every section carries a human slug
   anchor (`<a id="quick-start-guide">`) and often a legacy numeric one
   (`<span id="177q">`). Mark guarantees old numeric anchors never rot. These are the
   one identifier stable across *both* his rewrites and our restructuring — so we key
   **all** user state and deep links to anchors, never to prose or page numbers.

2. **The hierarchy lives in the TOC, not the headers.** Body `#` headers are flat
   (~319 level-1 headers in `index.md`). The real outline is the Table of Contents:
   a nested markdown list where tab-indent = depth and each entry
   (`<a id="12h" href="#preliminary-and-introductory-things">…`) links to a section's
   slug anchor. Our build derives structure from the TOC and joins it to body content
   by anchor.

3. **The build is trivial to reproduce.** `m.sh` just runs
   `pandoc -f commonmark+autolink_bare_uris` over a fixed file list into one HTML, then
   prepends `header.html`. We parse the same inputs ourselves.

## Content strategy — layered git fork

We hand-edit freely (agent-assisted, low opportunity cost) but stay robust to Mark's
~weekly updates and able to contribute fixes upstream, via disciplined branch layering:

- **`upstream`** — mirror of `meditationstuff/protocol_1`. Pulled when Mark pushes.
- **`upstreamable`** — branched off `upstream`. *Only* changes Mark might accept
  (typo fixes, broken-markdown cleanup, chat-copypaste artifacts). Each a tidy commit →
  a PR to Mark is `git cherry-pick` of these. Rebases cleanly onto `upstream`.
- **`site`** (our main) — branched off `upstreamable`. Everything website: build
  pipeline, structural curation, Astro app.

**Update flow:** pull `upstream` → rebase `upstreamable` onto it (small, near-trivial)
→ rebase `site` onto that. Conflicts only where Mark touched the exact lines we
restructured; agent-assisted resolution from the diff is cheap.

For v1 the upstream `.md` is **vendored** under `protocol-source/` (with
`UPSTREAM_COMMIT.txt` recording provenance) and `scripts/sync-upstream.sh` documents
the pull. Full three-branch setup can be formalized later; identity stays anchor-keyed
throughout so it doesn't matter for correctness.

## Architecture

Static Astro site on GitHub Pages + Supabase (Postgres) called **directly** from the
client. No backend server. Row-Level Security isolates each user's data.

### Build step (`scripts/build-content.mjs`, pre-Astro)

1. Concatenate `protocol-source/*.md` in `m.sh` order; render to HTML (markdown-it,
   `html:true`, linkify — approximates pandoc commonmark+autolink).
2. Parse the TOC list → ordered tree `{ key, title, depth, children, target_anchor }`.
3. Slice rendered HTML at every TOC-target anchor (document order ≈ TOC order); the span
   between consecutive anchors is that node's body. Collect each section's anchor ids,
   word count, source file, and a `kind` tag (main / auxiliary / appendix / etc.).
4. Emit `src/data/sections.json` (tree + per-section html + metadata) and
   `src/data/aliases.json` (`canonical_key → [all anchor aliases]`).

Canonical key per section = slug anchor if present, else the numeric legacy anchor.

### Frontend (Astro, fully static)

- **Map** (`/`): full TOC tree, indented; each row shows title · wordcount · read/star
  state by color. The orientation device + home screen.
- **Section page** (`/s/[key]`): one page per **leaf TOC entry** (tiny pages — a
  deliberate departure from the monolith). Sidebar (condensed Map) + content +
  prev/next in TOC order + a per-section controls bar.
- **Alias resolution**: non-canonical aliases get tiny static redirect pages to the
  canonical `/s/[key]`, honoring stable deep links.
- **Islands** = plain Astro `<script>` (no UI framework): an **auth widget**
  (magic-link) and a **section controls** bar (Read / Star) that upserts to Supabase
  with optimistic localStorage.

### Data model (Supabase / Postgres)

```
profiles      (id = auth.uid, created_at, display_name?)
section_state (user_id, section_key, read bool, starred bool,
               read_at, updated_at)            -- PK (user_id, section_key)
-- later: notes, timer_logs (both section_key-scoped)
```

RLS on every table: `user_id = auth.uid()`. Auth: Supabase magic-link email only
(no Google). Cross-device sync is automatic (same account).

A generated `section_key → aliases` map means if Mark renames an anchor we add the new
alias and old state still resolves — never orphaned.

## v1 scope (the core loop)

1. Repo + vendored source + `build-content.mjs` → `sections.json` + `aliases.json`.
2. Astro: Map home, sidebar, page-per-leaf, prev/next, alias redirects.
3. Two islands: magic-link auth + Read/Star controls.
4. Supabase: `profiles`, `section_state`, RLS.
5. Deploy to the user's GitHub Pages via Actions (build → `gh-pages`).
6. Verify: sign in on two devices, mark read/star, see it sync.

## Deferred (designed-for, not built in v1)

Per-section notes; "try this for N min" timer + log (Insight-Timer-but-not-obnoxious);
LLM section Q&A; random preliminary/auxiliary-practice nudges and other special pages;
sub-tweet-length leaf fusion with siblings; Google auth; public multi-user polish;
formal three-branch upstream automation.
