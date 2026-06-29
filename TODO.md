## little things

[x] 1 nav stuff
  - add a way to view a list of only starred sections
  - sidebar should just have... a bunch of random jump buttons:
    - p3, p8, pre/aux, starred, read, unread, any not-hidden section/page
  - in addition to read/star, add "hide" (which should hide from prev/next, and sidebar unless toggled, and also make them not be chosen for random jump)
  - fix/remove these links [Go up to this section's line in the Full Table of Contents][Go to the Partial Guided Tour (in the Quick Start Guide)]
    - they currently don't work, but maybe also they aren't really needed here
  - change "The Map" to just Table of Contents

[x] 2 merge "working title through copyright"
  - move "canonical location" into this merge & linking guarantees as well
  - add a blob between copyright & canon that indicates "this is one such fork, created by [Malcolm Ocean](https://malcolmocean.com?utm...)"
  - I think add funding section to that part, might want to rephrase or something given this is a fork
  
[x] 3 poke around on the site and just notice things that are off on whatever level, and fix them. 
  - or tiny visual improvements, like things that should be centered or made larger/smaller, or extraneous things from mark's version that should be removed
  - or mobile stuff
  - eg aux pages currently have the title/main name duplicated, once with a colon, once without
  - for this, take screenshots of the before & afters, and present them all to me on a temporary not-committed html page
  - eg pages that just say "[This (super)section intentionally left blank. Scroll down for the contentful subsections!]"
    - should have sub-tables-of-contents on them
  - eg left sidebar should auto-scroll to show the active page (vertically-centered if possible)

[x] 4 auto/passive read state:
  - we also should be tracking a less-controllable/manual "read" state; maybe that's what we want for "read" anyway; something more 
  like "did you scroll to the bottom of this" or "if it was short no-scrolly page, did you stay on it for more than X seconds (where X 
  might be wordcount x 0.01 minutes). less "mark as read", more passively revealed"
  - "I think we should continue to offer the read 
  button, but it should also just auto-trigger when you scroll to the bottom of a page / have spent enough time on it. 
  - and something  like maybe tracking pages-in-progress, relatedly.
  - maybe we should even just like, track the user's current state, and clear it when they navigate away from that state
    - so suppose I open on my phone. I open up to some long page. I scroll partway down [state saves - that that's a page I'm partway through]
    - then that tab gets lost, or I open on my computer
    - and somewhere on some home etc page there's an "in-progress" section, that shows the %s
    - and if you open it up and like, scroll further, it updates, and if you get to the end it clears
    - or you can clear the in-progress state from the in-progress page with an x
    - I guess it should also store in-progress if you like... jump away via the sidebar or via a link mid-page?
 
[x] 5: tiny things:
  - [x] we should make a dice SECTION that just has an outer rounded border, then a die, then page/aux/p3/p8 buttons.
    - (for the sidebar top)
  - [x] gitignore /src/data if that's correct

[x] 6 in the header of a page, add a copy-as-markdown button. I'm thinking "[unicode copy symbol].md" as the button text, with more info on hover
  - "⧉.md" button in the section header; copies the section's markdown source with
    in-text links rewritten to absolute https://globway.top/... URLs. Works offline
    (md embedded per page). Hidden on the merged colophon (no single-source md).

## Herschel's wishlist

- [x] kb etc
  - [x] hotkeys for all major actions, switch focus between main text and sidebar, arrow keys/hjkl for sidebar section selection, left/right in the main bar should prolly go to next section. 
  - [x] relatedly, clicking on a link in the left sidebar should automatically focus the main text body, or this should at least be an option -- this can be done before kb stuff, should be basically trivial. maybe annoying if we want to establish user settings. I guess do this after the notes interface for a separate rp
  - done unconditionally (no settings yet): `<main tabindex=-1>` + focus on the next astro:page-load after a TOC row click
- [x] notes interface
  - [x] dark mode colors for highlight broken
  - [~] ui sucks in general, prolly just have claude design mess around etc
    - ongoing "rice" pass: paragraph-note outline/tint, fab icon (svg pencil) +
      bigger hover target, popup icon sizing, z-index fix so cards scroll under
      the header, page notes pinned to the bottom of the rail
  - [x] prolly notes should appear on the side on desktop, not sure on mobile.
    - anchored cards in a right-hand side rail on wide screens; stack inline on mobile
  - [x] support markdown in notes
    - full GFM via `marked` + DOMPurify sanitize (tables, task lists, code, etc.)
  - [x] C-enter in the text field to submit (⌘/Ctrl+Enter; Esc cancels)
  - [x] really should have some nice interface for kb navigation for writing notes, but this is maybe for later or something
	- [x] could just be like, you can jump focus by paragraph, and then can do a highlight + note on the paragraph. and then some way to jump to existing notes, or jump between each of the notes + page level note. likely shouldn't be modal, not sure what the binding should be.
	- [x] again prolly should wait until more stuff in place for hotkeys in general
  - [x] a way to basically explore all notes, like some interface to see where I have notes and sort of scroll through them, maybe showing the surrounding context, or at least just linking easily to the relevant page etc.
	- show enough context per entry to recognize it (quoted anchor text + a snippet
	  around it), or at minimum link straight to the section (ideally scroll to /
	  flash the anchor on arrival).
	- grouping/sorting: by section order, by recency; filter highlights vs notes vs
	  page notes; maybe starred-only. the "see everything I've marked up" home that
	  complements the per-section rail.
- [x] r/*/etc seem to be broken?
- [x] section title wraps poorly — the big serif h1 stacks into a tall narrow
  column next to the read/star/hide/.md controls. fix the wrapping / sizing /
  layout of the section header (not caused by the notes work). 
- [x] aux pages you can't C-click on the next aux practice. note this works fine for the regular sections
- [ ] font options, some slightly ricier fonts, variously nice and clean
- [ ] incremental reading stuff
  - I'm not sure I understand "actual" incremental reading, but probably something which surfaces old notes (your own notes and highlights) at some intervals



## Malcolm's wishlist

- [x] full text search, something like a C-k interface
  - ⌘K / Ctrl+K (or the 🔍 pill) opens a command-palette overlay over a MiniSearch
    index of everything (section bodies + aux + p3/p8). Index ships as
    public/search.json (gitignored), lazy-loaded + indexed on first open, kept out
    of the SW precache (runtime-cached after first use). See
    docs/plans/2026-06-26-full-text-search-design.md.

## Bugs

- [ ] Appendix 1 has a very long ul with no actual text content
