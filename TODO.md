# little things

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

[ ] 6 in the header of a page, add a copy-as-markdown button. I'm thinking "[unicode copy symbol].md" as the button text, with more info on hover

