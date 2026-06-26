# Globway — keyboard navigation architecture

**Date:** 2026-06-26
**Status:** design (no implementation yet).

## Brief: what we're building and why it's shaped this way

Globway is getting keyboard navigation: focus and move by paragraph in the
article, drive read/star/hide/markdown/notes from the home row, navigate the
sidebar TOC, step through your own highlights and notes, and see every binding in
a help overlay. There are three "places" keys can land — the **article body**,
the **sidebar**, and **modals / text fields** — and the central problem is
routing a keystroke to the right one without ever firing a shortcut while you're
typing a note or while a dialog is up.

**The approach: lean on the browser's own focus and the DOM tree, not on a
bespoke state machine.** Concretely:

- We **don't focus the article at all.** Reading state = focus resting on
  `<body>` (the default). That gives us **native scrolling for free** (arrows,
  Space, PgDn, Home/End all just work) and a single `document`-level listener that
  catches the navigation keys. "Being in the body" is simply "nothing special is
  focused."
- The **sidebar** is the one place we take real focus (a row), because we want
  native `⌘/Ctrl+Enter` "open in new tab" and screen-reader semantics on the
  links. One listener on the sidebar root handles its keys.
- **Modals and text fields own their own keys natively** — a focused textarea
  receives typing; a modal traps focus and runs its own handler. The two nav
  listeners each open with a **one-line guard** (`if the event target is an input
  / textarea / contenteditable / dialog, do nothing`) so a shortcut never fires
  while you're typing or while a dialog is up.

**What we deliberately did *not* build, and why.** *Provenance note for
collaborators:* the heavier machinery described in this subsection — the central
dispatcher, the focus-mode state variable, the push/pop overlay stack, the
per-keystroke `activeContext()` resolver — originated in **Claude's (the AI
assistant's) initial drafts**, not from the human collaborator. The simpler
native-focus design that the rest of this document settles on was **driven by the
human collaborator**, who pushed back across several rounds specifically to strip
that complexity out. It's recorded here as a rejected alternative, not as anyone's
endorsed proposal. With that said — the assistant's first drafts had a central
dispatcher with an explicit focus-mode variable, an overlay/context *stack* that
components pushed/popped, and a per-keystroke `activeContext()` resolver. We threw
all of that out:

- A **push/pop stack is a discipline-based contract** — every modal/editor close
  path must remember to pop, and focus can leave a field a dozen ways (click out,
  Tab, programmatic blur, navigation, an error mid-handler). Miss one pop and
  global keys stay wrongly suppressed. State that has to be *maintained in
  parallel* to the truth will desync.
- A **mode variable** (`main` vs everything) is redundant: the browser already
  tracks where focus is. The only mode that *can't* be read from focus is "am I in
  the sidebar," and even that is just "is a sidebar row the active element" — so we
  keep no mode variable at all and read `document.activeElement` / the event
  target when we need to.
- Relying on **event bubbling + `stopPropagation`** in each component (the other
  obvious option) is exactly the "fragile if focus ends up on a weird descendant"
  failure flagged in the original notes: every owning widget must remember to stop
  every key it doesn't handle. The `closest()` guard on the two listeners is the
  centralized, can't-forget version of the same idea — it matches any descendant
  at any depth and needs zero cooperation from the widgets.

So the **only state we keep is two remembered cursors**: which sidebar row you
were on (so `s` returns you there), and which paragraph the body's *virtual* focus
sits on. Everything else is derived from real focus at the moment a key is
pressed. The result is less machinery, native scrolling, and robustness to stray
focus — at the cost of two small, explicit contracts (the editable/dialog guard,
and "leave focus on body when nothing else owns it") that are documented below and
live in exactly two places.

The trade we're accepting: this couples us to the browser's focus model rather
than abstracting over it. For an app this size — a static reading site with a
sidebar, a few modals, and one text editor — that's the right call; an
abstraction layer would be cost with no buyer. If the app ever grew many
independent focus regions, we'd revisit (see [Forward
compatibility](#forward-compatibility)).

## What we inherit (current architecture)

- **No-framework imperative islands.** Behaviour lives in plain Astro `<script>`
  modules (`app.ts`, `annotations.ts`); state is module-level singletons; the DOM
  is manipulated directly. The keyboard layer follows the same house style.
- **`<ClientRouter>` lifecycle.** Only `<main>` swaps on navigation; the sidebar
  and top chrome persist (`transition:persist`). `app.ts` already splits setup
  into `once()` (persistent listeners) and `setupPage()` (per-page, rebound to a
  fresh `AbortController` each `astro:page-load`). The **document listener and the
  sidebar listener are wired once** (`once()`); the body's per-page virtual-focus
  cursor resets each `astro:page-load`.
- **Body blocks are already tagged.** `tagBlocks()` in `annotations.ts` marks the
  eligible blocks (top-level `p/h1–6/blockquote/pre` + first-level `li`) with
  `data-block-id`. The body's virtual focus reuses *exactly this set*, so
  paragraph-focus and paragraph-annotation share one block model.
- **Scroll-offset helper exists.** `headerBottom()` already computes the bottom of
  the sticky `.section-head`; "scroll a focused block into view" reuses it so the
  paragraph never hides under the header.
- **Annotation state is centralized.** `activeId` / `editingId`, `anchoredFor()`,
  `setActive()`, `ensureVisible()`, `addParaNote()`, `addParaHighlight()`,
  `addPageNote()`, `addHighlight()` already exist. Keyboard actions drive *these*,
  not a parallel path (see [Coupling](#coupling-the-annotation-command-surface)).
- **Sidebar is a real anchor tree.** Rows are `<a class="row" data-row-key>` built
  by `buildSidebarTree()`, nested in `ul.tree > li`. Real anchors give real focus,
  native open-in-new-tab, and roving-tabindex for free.
- **Existing focus touch we change:** today a sidebar-row click sets
  `focusMainOnLoad` and calls `main.focus()` on the next page-load. We **remove**
  that — after a sidebar navigation we simply leave focus on `<body>` (reading
  state). `<main tabindex="-1">` becomes dead and can be dropped.

## Core design

### 1. Two listeners, routed by real focus

```
focus on <body> (default)  ──keydown bubbles──▶  document listener   → body bindings
focus on a sidebar row     ──keydown bubbles──▶  sidebar-root listener → sidebar bindings
focus in a textarea/modal  ──the field/dialog handles it natively; the guard below
                              makes the nav listeners ignore it
```

Each nav listener opens with the same guard so it never steals a keystroke meant
for typing or a dialog:

```ts
function navGuardBail(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement).closest(
    'input, textarea, [contenteditable], [role="dialog"]');
}
```

- **`document` listener** (bubble phase) — runs the body bindings. Bails via the
  guard. **Never `preventDefault`s scroll keys** (`↑ ↓ PgUp PgDn Home End`, and
  `←/→` which stay unbound on purpose), so native scrolling is untouched.
- **Sidebar-root listener** (bubble phase, on the persistent `.sidebar nav`) — runs
  the sidebar bindings. Bails via the guard (the AuthBar email input lives inside
  the sidebar — without the guard, typing `j` there would navigate). It
  `stopPropagation`s only the keys it *handles*, so global keys like `?` still
  bubble through to `document` and work from the sidebar too.

"Where am I" is never stored — it's whatever has focus. The only mode that isn't
trivially visible (the article body) is the *absence* of special focus, served by
the `document` listener.

### 2. Focus lifecycle & the two contracts

Two small, explicit rules carry the whole system:

1. **The editable/dialog guard** (above) — the only thing that makes typing and
   modals safe. Two call sites, robust to any descendant via `closest()`.
2. **Leave focus on body when nothing else owns it.** We never call `main.focus()`
   and keep no return-to-main handler. When a textarea or modal closes, the
   browser drops focus to `<body>` on its own — which *is* reading state. The one
   place we act: after a sidebar navigation, ensure focus isn't left on the
   (persisted) clicked row — blur it back to body so you land in the article ready
   to read/scroll.

**Modal focus return** is handled per-modal by its opener, not globally:

- An editor-spawned modal (the discard-confirm dialog) returns focus to the
  **textarea** on "keep editing" (the existing `prevFocus.focus()` already does
  this), and on "discard" lets the editor tear down so focus falls to **body**.
- Any other modal (e.g. the `?` help overlay) lets focus fall to **body** on close.
  Opened from the sidebar, this means you return to reading state, not the row —
  acceptable, since the remembered row persists and `s` takes you back.

No modal needs to register/deregister anything. The guard makes it inert to
shortcuts while it's up (it carries `role="dialog"`); closing it removes it from
the DOM and focus falls through naturally.

### 3. Two deliberately different focus paradigms

| | Article body | Sidebar |
|---|---|---|
| Mode-level focus | **None** — focus rests on `<body>` | **Real** — roving `tabindex`, `.focus()` on the `<a>` row |
| Cursor | **Virtual** — a `.kb-focus` *class* on a block; no DOM focus, no tab-stop | the focused row itself |
| Why | paragraphs shouldn't be tab-stops; native scroll needs focus *off* a sub-element; we just need a visible cursor + scroll | native `⌘/Ctrl+Enter` open-in-new-tab + screen-reader semantics |

So the body has *two* layers: real focus on `<body>` (so the `document` listener
hears keys and scroll is native) and a *virtual* paragraph cursor (a class)
managed by the body bindings.

### 4. The keymap table (source of truth for dispatch *and* help)

A lightweight declarative table — **not** a command palette / remapping / loadable
keymap system (over-built for this app today), but enough that the help overlay
and platform display are *generated*, never hand-maintained in parallel.

```ts
type Mod = 'mod' | 'alt' | 'shift' | 'ctrl' | 'meta';  // 'mod' = ⌘ on mac, Ctrl elsewhere
type Scope = 'body' | 'sidebar';                        // which listener owns it

interface Command { id: string; title: string; run: () => void; }
interface Binding {
  keys: string;            // e.g. 'j', 'alt+j', 'mod+ArrowDown', '?'
  command: string;         // Command.id
  scope: Scope;
  when?: () => boolean;    // extra guard (e.g. "a block is focused")
  group: string;           // section heading in the help overlay
}
```

- **Logical `mod`** resolves to ⌘ (mac) or Ctrl (win/linux) at *both* match time
  and render time, so `alt+j` / `mod+ArrowDown` work and *display* correctly
  cross-platform from one table. Consistent with the existing `e.metaKey ||
  e.ctrlKey` save check.
- **Multiple bindings per command** (`alt+j` *and* `mod+ArrowDown` → `note.next`;
  `j` *and* `ArrowDown` → sidebar down). The help overlay shows both.
- Each listener dispatches the subset of the table with its `scope`. The whole
  help overlay is `render(table)` grouped by `group` — **drift-proof**.

Help overlay trigger: **`?`** (Shift+/), the near-universal convention. It opens
as a `role="dialog"` overlay, so the guard makes everything beneath inert and its
own handler closes it on `Esc`. It works from body or sidebar (the sidebar
listener doesn't eat `?`).

### 5. Virtual focus in the article body

Focusable units = the `data-block-id` blocks. Navigation (`j`/`k`):

- **First `j`/`k` with no cursor** → focus the **first block in the viewport whose
  top is at/below the header bottom and that isn't visible only by a sliver**
  (require a minimum visible height so we don't grab a paragraph barely peeking in
  at the bottom edge). Both `j` and `k` seed this initially.
  - **Edge — one huge straddling paragraph:** if the only candidate is a single
    block taller than the viewport straddling top *and* bottom, focus it anyway.
- **Subsequent `j`/`k`** → move to next/previous block, scroll its top to just
  under the header (`headerBottom()`), `behavior:'smooth'`.
  - **Huge block:** if a focused block is taller than the viewport, `j` aligns the
    *next* block's top under the header; we don't scroll *within* a block. "Pick
    something sane."
- The `.kb-focus` cursor is purely visual (CSS: a left border / faint tint).
- If you scroll away (native) and hit `j`, the "no cursor / cursor off-screen →
  re-seed from viewport" rule re-grabs the first visible block.

The cursor does not follow scrolling; it only moves on `j`/`k`.

### 6. Body action commands

All operate on the **current section** (read/star/hide/markdown/page-note) or the
**virtually-focused block** (highlight/note), calling the *existing* functions:

| Key | Command | Maps to |
|---|---|---|
| `j` / `k` | focus next / prev block | virtual-focus engine (§5) |
| `h` | highlight | live selection → `addHighlight(false)`; else focused block → `addParaHighlight(block)`. Leaves the cursor where it was. |
| `n` | note | live selection → `addHighlight(true)`; else focused block → `addParaNote(block)`. Focuses the new textarea. |
| `r` | toggle read | `toggle(key,'read')` |
| `*` | toggle star | `toggle(key,'starred')` |
| `b` | toggle hide | `toggle(key,'hidden')` |
| `m` | copy as markdown | `copyMd(...)` |
| `p` | new page note | `addPageNote()` (focuses its editor) |
| `s` | focus sidebar | `.focus()` the remembered row |
| `alt+j`/`alt+k`, `mod+↓`/`mod+↑` | next / prev highlight-or-note | traversal (§7) |
| `Esc` | dismiss (laddered) | §8 |
| `?` | bindings help | open help overlay |

`h`/`n` resolving *selection vs focused-block*: a live text selection means "act
on the selection" (text highlight/note); no selection but a focused paragraph
means "act on the paragraph." Both reuse existing code paths. (The mouse popups —
selection popup, ¶ fab, mark menu — are mouse-only; the keyboard path bypasses
them.)

### 7. Note / highlight traversal (`alt+j/k`, `mod+↑/↓`)

- **Navigable set is broader than the carded set.** `anchoredFor()` excludes bare
  highlights (no comment → no rail card); traversal includes them — bare
  highlight, commented highlight, paragraph highlight, paragraph note alike. So
  traversal uses its own ordered list (shared sort, looser filter).
- **Two-level ordering.** Primary: text position. Secondary, when a paragraph
  carries both a paragraph-level mark and text-selection highlights inside it: the
  **paragraph-level mark sorts above** the selection highlights it contains
  (selection highlights are "lower"). A small comparator in one place.

Landing on a mark = `setActive(id)` + `ensureVisible(id)` (existing) — scrolls its
rail card into the band and activates it. It does **not** open the editor.

### 8. The `Esc` ladder

`Esc` resolves top-down; first applicable rung wins and stops:

1. A modal/overlay open (handled by *its* own handler, since it owns focus) → close it.
2. Note editor open → cancel (existing `requestCancel`, which may itself raise the
   discard modal).
3. Active note card (`activeId`, not editing) → `setActive(null)`.
4. A just-made / selected text highlight still selected → clear the browser
   selection / deactivate it.
5. Virtual cursor present → drop `.kb-focus`.

Rungs 3–5 are the `document` listener's `Esc` handler; rungs 1–2 are owned by the
focused dialog/editor (so they never reach `document` — the guard / their own
`stopPropagation`). The existing mobile-nav `Esc` (close drawer) slots in as
another rung when the drawer is open.

### 9. Sidebar navigation

Entered with `s` (focus the remembered row) or by clicking/tabbing a row. Real
roving-tabindex on `.row`. **Initial target is the current page's row; the focused
row is then remembered for the session** — leave with `s`/`Esc`, come back with
`s`, land where you were (not back on the current page).

| Key | Action |
|---|---|
| `j`/`k`, `↓`/`↑` | move focus down / up the visible rows |
| `h`/`l`, `←`/`→` | up / down the **tree**: `h` → parent; `l` → child. **Remember the child you were on** so `h` then `l` returns to the same row. |
| `Enter` | navigate to the focused section (native anchor) |
| `mod+Enter` / `mod+click` | open in new tab (native, from real focus) |
| `PgUp/PgDn`, `Home/End` | **just scroll** the sidebar natively (the row's scrollable ancestor) — no focus change |
| `s` / `Esc` | return focus to body (reading state); remembered row kept |

`hjkl` and the arrow keys are **parallel bindings** — the table lists both; help
shows both. The tree-remember needs a tiny per-parent "last child visited" map in
module state, beside the remembered row. Filtered-out rows (`display:none` from
the TOC filter) are skipped, as `firstVisibleChildRow()` already does.

### 10. Platform handling

Detect mac vs win/linux once (`navigator.userAgentData?.platform ??
navigator.platform`). The table stores the **logical** `mod`; both the matcher and
the help renderer resolve it: mac → `⌘ ⌥ ⇧ Ctrl`; win/linux → `Ctrl Alt Shift`.
So `alt+j` renders `⌥J` / `Alt+J` and `mod+Enter` renders `⌘↵` / `Ctrl+Enter` from
one source. One resolver, two call sites, no per-binding platform forks.

## Coupling: the annotation command surface

`annotations.ts` today exports only `initAnnotations` / `pullAnnotations`. Keyboard
actions must drive the **same** state, so it grows a small imperative surface
consumed by the keyboard module, e.g.:

```ts
focusBlock(dir: 'next'|'prev'|'first-visible'): void
highlightFocused(): void          // h, no selection
noteFocused(): void               // n, no selection
nextMark(): void / prevMark(): void
clearActiveOrCursor(): boolean    // one rung of the Esc ladder; "did something?"
hasCursor(): boolean
```

Accepted coupling, not a new controller: the state these touch (`activeId`,
`editingId`, `anchorEl`, the block set, `narrow`) already lives in
`annotations.ts` as module singletons, so the functions belong next to it. The
keyboard module owns the two listeners, the table, and the help/sidebar; it calls
*into* annotations for body actions. `app.ts` similarly exposes `toggle` /
`copyMd` for `r`/`*`/`b`/`m`.

## Scope boundary

- **Section pages (`/s/<key>`) first.** Virtual focus + body actions need the
  tagged-block article. The home/map page gets sidebar nav + `?` help but no body
  cursor. Decks (`/aux,/p3,/p8`) are client-rendered cards with no annotation
  layer today — keyboard support there is a later addition, not this pass.
- **No user-remappable keys, no command palette, no persisted keymap** in v1. The
  table is shaped to allow them later; none are built.

## Build order

1. **Keymap table + matcher + platform/`mod` resolver.** The shared core both
   listeners read from.
2. **`document` listener** (body scope) with the editable/dialog guard; wire in
   `once()`. Prove the guard + native scroll first with a couple of trivial
   bindings.
3. **Help overlay** generated from the table, grouped, platform-rendered; `?`
   opens it as a `role="dialog"`. (Exercises the table end-to-end early.)
4. **Sidebar listener** (sidebar scope): roving tabindex, `j/k/h/l` + arrows,
   remembered row + per-parent last-child map, `s`/`Esc` ↔ body; remove the old
   `focusMainOnLoad`/`main.focus()` path (leave focus on body after sidebar nav).
5. **Virtual focus engine** (`setupPage()`): first-visible-block seeding (sliver +
   huge-straddle edges), `j/k` move+scroll, `.kb-focus` CSS, reset on navigation.
6. **Body action commands** wired to the annotation/section surface; `h`/`n`
   selection-vs-block resolution.
7. **Note traversal** `alt+j/k` / `mod+↑↓`: broader navigable set + two-level
   comparator → `setActive` + `ensureVisible`.
8. **Esc ladder** unified across editor/modal (owned) + active note + selection +
   virtual cursor + mobile-nav drawer.
9. **Verify**: every binding from the help overlay; **no shortcut fires while
   typing a note or with a dialog up** (incl. the AuthBar email field); native
   scroll intact in the body; sidebar remember-position across a body↔sidebar↔body
   round trip; cursor survives scroll re-seeding; mac + win/linux glyphs.

## Forward compatibility

- The **keymap table** is the substrate for a future command palette (fuzzy over
  `Command.title`) and user-remapping (persist overrides to localStorage, like all
  other state) — additive, no rewrite.
- **Decks** become annotatable/navigable by giving their client-rendered card the
  same `data-block-id` tagging + reusing the body bindings; the `document` listener
  and table don't change.
- A **settings store** (e.g. a later "auto-focus body vs not" preference, or the
  `TODO.md` "auto-focus on sidebar click" toggle) shares one prefs object; nothing
  here blocks it.
- **If the app ever grew many independent focus regions** (the thing that would
  strain "lean on native focus"), the seam to introduce is a small per-region
  listener following the same two-contract pattern — still no central mode machine
  until genuinely warranted.
- **Untouched**: anchoring/sync, rail layout, read/progress tracking — the keyboard
  layer is a driver on top of them.

## Open edge cases (decide in implementation, all "pick something sane")

- Block taller than viewport: `j` aligns the *next* block under the header; no
  intra-block scrolling.
- Virtual cursor + a re-render (remote pull): `data-block-id` is regenerated each
  render — re-resolve the cursor by position, or re-seed from viewport if it's gone.
- `h`/`n` with a selection spanning a non-tagged region: fall back to the
  selection path (already robust via `getSelectionContext`).
- Sidebar `l` on a leaf row (no children): no-op.
- A focused in-article link (after Tab) + `j`: bubbles to `document`, not eaten by
  the guard (a link isn't editable), so body nav still works — intended.
