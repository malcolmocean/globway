// "Opening a note" loader. Deep-linking a note (/s/<key>?note=<id>) makes the
// section scroll to and anchor that note — a small settle we'd rather not show. So
// we pre-hide the incoming section content across the view transition, run a quick
// top progress bar while positioning the note *instantly* underneath, then reveal
// the content already on the note and sweep the bar out. A deliberate ~1s "fake
// loading" beat instead of a visible jump.

const MIN_MS = 850;          // keep the loader up at least this long (deliberate feel)
let barEl: HTMLElement | null = null;
let startedAt = 0;

function getMain(): HTMLElement | null { return document.querySelector<HTMLElement>('main.main'); }

// Wired once (app.ts). Pre-hides the *incoming* section content when navigating to
// a note, so the view-transition swap never flashes the un-scrolled top before we
// position it. (SPA navigations only; a cold load is handled in noteArrivalBegin.)
export function initNoteArrival() {
  document.addEventListener('astro:before-swap', (e: any) => {
    try {
      if (!new URL(e.to, location.href).searchParams.has('note')) return;
      const m = e.newDocument?.querySelector('main.main') as HTMLElement | null;
      if (m) m.style.opacity = '0';
    } catch {}
  });
}

// Begin the loader on the section page (on ?note arrival): hide the content (covers
// the cold-load case the before-swap hook can't reach) and start the bar sweep.
export function noteArrivalBegin() {
  const m = getMain();
  if (m) m.style.opacity = '0';
  startedAt = performance.now();
  if (!barEl) {
    barEl = document.createElement('div');
    barEl.className = 'note-loadbar';
    document.body.appendChild(barEl);
  }
  barEl.classList.remove('is-done');
  void barEl.offsetWidth;            // restart the width transition
  barEl.classList.add('is-loading');
}

// Finish: once the note is positioned, reveal the content and sweep the bar out,
// honoring the minimum visible duration. `beforeReveal` runs while still hidden
// (re-position after layout settles) so the reveal lands exactly on the note.
export function noteArrivalEnd(beforeReveal?: () => void) {
  const wait = Math.max(0, MIN_MS - (performance.now() - startedAt));
  window.setTimeout(() => {
    beforeReveal?.();
    requestAnimationFrame(() => {
      const m = getMain();
      if (m) {
        m.style.transition = 'opacity .3s ease';
        m.style.opacity = '1';
        window.setTimeout(() => { m.style.transition = ''; m.style.opacity = ''; }, 320);
      }
    });
    if (barEl) {
      const el = barEl;
      el.classList.add('is-done');   // fill to 100% then fade out (CSS)
      window.setTimeout(() => { el.remove(); if (barEl === el) barEl = null; }, 500);
    }
  }, wait);
}
