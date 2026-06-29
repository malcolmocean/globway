// Client runtime: auth (magic-link) + read/star state sync.
// Works in three modes transparently:
//   1. Supabase configured + signed in  -> synced across devices.
//   2. Supabase configured + signed out -> local only; prompts to sign in to sync.
//   3. Supabase not configured           -> local only (dev / pre-setup).
import { getSupabase, isConfigured } from '../lib/supabase';
import tocData from '../data/toc.json';
import { initAnnotations, pullAnnotations } from './annotations';
import { initKeyboard, setupKeyboardPage } from './keyboard';
import { initNotesView } from './notes-view';
import { initNoteArrival } from './note-arrival';
import { initSearch } from './search';
import { navigate } from 'astro:transitions/client';

type TocNode = { key: string; title: string; depth: number; children: TocNode[] };
type Entry = { read?: boolean; starred?: boolean; hidden?: boolean; progress?: number; updated_at: string };
type State = Record<string, Entry>;
type Filter = 'all' | 'starred' | 'read' | 'unread' | 'inprogress' | 'hidden';

// A section is "in progress" iff partway scrolled (0<progress<1) and not yet
// read/hidden. Reaching the end sets read + clears progress, so the two are
// mutually exclusive by construction.
function inProgress(e: Entry | undefined): boolean {
  const p = (e && e.progress) || 0;
  return p > 0 && p < 1 && !e!.read && !e!.hidden;
}

const LS_KEY = 'globway:state';
const FILTER_KEY = 'globway:filter';
const sb = getSupabase();

function loadLocal(): State {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveLocal(s: State) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

let state: State = loadLocal();

// ---- DOM application --------------------------------------------------------
function applyEntry(key: string) {
  const e = state[key] || {};
  document.querySelectorAll<HTMLElement>(`[data-key="${cssEscape(key)}"]`).forEach((el) => {
    const action = el.getAttribute('data-action');
    if (action === 'read') setPressed(el, !!e.read);
    if (action === 'star') setPressed(el, !!e.starred);
    if (action === 'hide') setPressed(el, !!e.hidden);
  });
  const rowSel = `[data-row-key="${cssEscape(key)}"], [data-subtoc-key="${cssEscape(key)}"]`;
  document.querySelectorAll<HTMLElement>(rowSel).forEach((row) => {
    row.classList.toggle('is-read', !!e.read);
    row.classList.toggle('is-starred', !!e.starred);
    row.classList.toggle('is-hidden', !!e.hidden);
    row.classList.toggle('is-inprogress', inProgress(e));
  });
}
function applyAll() {
  Object.keys(state).forEach(applyEntry);
  refreshProgress();
  renderInProgress();
  applyFilter(currentFilter());
  updatePager();
  document.querySelectorAll<HTMLElement>('[data-preamble]').forEach((r) => {
    if (r.dataset.preambleKey) applyPreamble(r);
  });
}
// Collapsible deck preamble. Collapsed state syncs via section_state under a
// synthetic `preamble:<deck>` key, reusing the `hidden` field as "collapsed".
function applyPreamble(region: HTMLElement) {
  const key = region.dataset.preambleKey!;
  const collapsed = !!(state[key] || {}).hidden;
  region.classList.toggle('collapsed', collapsed);
  const body = region.querySelector<HTMLElement>('[data-preamble-body]');
  if (body) body.hidden = collapsed;
  const btn = region.querySelector('.preamble-toggle');
  btn?.setAttribute('aria-expanded', String(!collapsed));
  const caret = region.querySelector('.caret');
  if (caret) caret.textContent = collapsed ? '▸' : '▾';
}
function setPressed(el: HTMLElement, on: boolean) {
  el.setAttribute('aria-pressed', String(on));
  el.classList.toggle('is-on', on);
}
function cssEscape(s: string) { return (window as any).CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

function refreshProgress() {
  const total = document.querySelectorAll('[data-row-key]').length;
  if (!total) return;
  const read = Object.values(state).filter((e) => e.read).length;
  document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => {
    el.textContent = `${read} read`;
  });
}

// ---- mutations --------------------------------------------------------------
/** The full row we upsert for one key (read/star/hide/progress + timestamps). */
function rowPayload(userId: string, key: string) {
  const e = state[key] || ({} as Entry);
  const prog = e.progress ?? 0;
  return {
    user_id: userId, section_key: key,
    read: !!e.read, starred: !!e.starred, hidden: !!e.hidden, progress: prog,
    read_at: e.read ? e.updated_at : null,
    progress_at: prog > 0 ? e.updated_at : null,
    updated_at: e.updated_at,
  };
}
async function syncRow(key: string) {
  if (!sb) return;
  const session = await getSession();
  if (!session) return;
  const { error } = await sb.from('section_state')
    .upsert(rowPayload(session.user.id, key), { onConflict: 'user_id,section_key' });
  if (error) console.warn('[globway] sync upsert failed:', error.message);
}

/** Reflect a single key's local mutation into all the affected DOM. */
function reflect(key: string) {
  applyEntry(key);
  refreshProgress();
  renderInProgress();
  applyFilter(currentFilter()); // (un)hiding / (un)reading changes what the filter shows
  updatePager();                // hiding shifts a page's prev/next neighbours
}

async function toggle(key: string, field: 'read' | 'starred' | 'hidden') {
  const cur = state[key] || { updated_at: '' };
  const next: Entry = { ...cur, [field]: !cur[field], updated_at: new Date().toISOString() };
  if (field === 'read' && next.read) next.progress = 0; // finishing clears in-progress
  state[key] = next;
  saveLocal(state);
  reflect(key);
  await syncRow(key);
}

/** Idempotent "mark read" used by passive auto-read (scroll-to-end / dwell). */
async function setRead(key: string) {
  const cur = state[key] || { updated_at: '' };
  if (cur.read) return;
  state[key] = { ...cur, read: true, progress: 0, updated_at: new Date().toISOString() };
  saveLocal(state);
  reflect(key);
  await syncRow(key);
}

/** Record max scroll depth (monotonic) for a section; debounce the remote sync. */
let progressTimer = 0;
function recordProgress(key: string, frac: number) {
  const cur = state[key] || { updated_at: '' };
  if (cur.read || cur.hidden) return;
  if ((cur.progress ?? 0) >= frac) return; // progress only ever grows
  state[key] = { ...cur, progress: frac, updated_at: new Date().toISOString() };
  saveLocal(state);
  applyEntry(key);
  renderInProgress();
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => { progressTimer = 0; syncRow(key); }, 1500);
}

/** Clear a section's in-progress state (the × in the home "Continue reading" panel). */
async function clearProgress(key: string) {
  const cur = state[key];
  if (!cur || !(cur.progress ?? 0)) return;
  state[key] = { ...cur, progress: 0, updated_at: new Date().toISOString() };
  saveLocal(state);
  reflect(key);
  await syncRow(key);
}

// ---- home "Continue reading" panel -----------------------------------------
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
/** Populate the home in-progress panel from state ∩ sidebar rows (title + href). */
function renderInProgress() {
  const panel = document.querySelector<HTMLElement>('[data-inprogress-panel]');
  if (!panel) return;
  const list = panel.querySelector<HTMLElement>('[data-inprogress-list]');
  if (!list) return;
  const meta = new Map(orderedRows().map((r) => [r.key, r]));
  const items = Object.entries(state)
    .filter(([k, e]) => inProgress(e) && meta.has(k))
    .map(([k, e]) => ({ ...meta.get(k)!, progress: e.progress!, starred: !!e.starred, at: e.updated_at || '' }))
    .sort((a, b) => b.at.localeCompare(a.at));
  // Mobile "Start reading" button (home only) shows iff there's nothing to resume.
  const startBtn = document.querySelector<HTMLElement>('[data-home-start]');
  if (!items.length) {
    panel.hidden = true; list.innerHTML = '';
    if (startBtn) startBtn.hidden = false;
    return;
  }
  panel.hidden = false;
  if (startBtn) startBtn.hidden = true;
  list.innerHTML = items.map((it) => {
    const pct = Math.max(1, Math.round(it.progress * 100));
    const title = escapeHtml(it.title);
    const star = it.starred ? `<span class="ip-star" aria-hidden="true">★</span> ` : '';
    return `<li class="ip-item">` +
      `<a class="ip-link" href="${escapeHtml(it.href)}">` +
        `<span class="ip-title">${star}${title}</span>` +
        `<span class="ip-bar"><span class="ip-fill" style="width:${pct}%"></span></span>` +
        `<span class="ip-pct">${pct}%</span>` +
      `</a>` +
      `<button type="button" class="ip-clear" data-clear-progress data-key="${escapeHtml(it.key)}" ` +
        `aria-label="Clear ${title} from in progress">×</button>` +
    `</li>`;
  }).join('');
}

// ---- filtering / random / pager --------------------------------------------
function currentFilter(): Filter {
  const f = localStorage.getItem(FILTER_KEY) as Filter | null;
  return f && ['all', 'starred', 'read', 'unread', 'inprogress', 'hidden'].includes(f) ? f : 'all';
}
function rowMatches(key: string, f: Filter): boolean {
  const e = state[key] || {};
  switch (f) {
    case 'starred': return !!e.starred;
    case 'read': return !!e.read;
    case 'unread': return !e.read && !e.hidden;
    case 'inprogress': return inProgress(e);
    case 'hidden': return !!e.hidden;
    case 'all': default: return !e.hidden;
  }
}
/** Filter every TOC row (sidebar + map) in place by the active filter. */
function applyFilter(f: Filter) {
  document.querySelectorAll<HTMLElement>('[data-row-key]').forEach((row) => {
    const key = row.getAttribute('data-row-key')!;
    row.classList.toggle('filtered-out', !rowMatches(key, f));
  });
  document.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === f)));
}
/** Unique [key -> href] of sidebar rows, in reading order. */
function orderedRows() {
  const seen = new Set<string>();
  const out: { key: string; title: string; href: string }[] = [];
  document.querySelectorAll<HTMLAnchorElement>('.sidebar a.row[data-row-key]').forEach((r) => {
    const key = r.getAttribute('data-row-key')!;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, title: r.querySelector('.t')?.textContent || key, href: r.href });
  });
  return out;
}
// A dice draw lands on an arbitrary section, so centring the sidebar on it (as a
// normal navigation does) would yank the dice buttons out from under the cursor on
// every roll. Flag random nav so setupPage() leaves the sidebar scroll alone.
let randomNav = false;
/** Random section drawn from the CURRENT filter view (page/starred/unread/…). */
function randomInView() {
  const f = currentFilter();
  const candidates = orderedRows().filter((r) => rowMatches(r.key, f));
  if (!candidates.length) return;
  const href = candidates[Math.floor(Math.random() * candidates.length)].href;
  randomNav = true;        // suppress scroll-to-current for this hop (see setupPage)
  navigate(href);          // client-router hop → dark cross-fade, no white reload flash
}
/** On a section page, recompute prev/next to skip hidden sections. */
function updatePager() {
  const pager = document.querySelector('.pager');
  if (!pager) return;
  const curKey = document.querySelector('.sidebar a.row.current')?.getAttribute('data-row-key');
  if (!curKey) return;
  const order = orderedRows();
  const idx = order.findIndex((o) => o.key === curKey);
  if (idx < 0) return;
  let p = idx - 1; while (p >= 0 && (state[order[p].key] || {}).hidden) p--;
  let n = idx + 1; while (n < order.length && (state[order[n].key] || {}).hidden) n++;
  setPagerLink(pager.querySelector('.prev'), p >= 0 ? order[p] : null, 'prev');
  setPagerLink(pager.querySelector('.next'), n < order.length ? order[n] : null, 'next');
}
function setPagerLink(el: Element | null, target: { title: string; href: string } | null, dir: 'prev' | 'next') {
  if (!el || !(el instanceof HTMLAnchorElement)) return; // boundary <span>, leave as-is
  if (!target) { el.hidden = true; return; }
  el.hidden = false;
  el.href = target.href;
  el.textContent = dir === 'prev' ? `← ${target.title}` : `${target.title} →`;
}

// ---- auth -------------------------------------------------------------------
async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

let pulling = false;
async function pullRemote() {
  if (!sb || pulling) return;
  const session = await getSession();
  if (!session) return;
  pulling = true;
  try {
    await pullRemoteInner(session);
  } finally {
    pulling = false;
  }
}

async function pullRemoteInner(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  if (!sb) return;
  const { data, error } = await sb.from('section_state').select('*');
  if (error) { console.warn('[globway] pull failed:', error.message); return; }
  const remote: State = {};
  for (const r of data || []) remote[r.section_key] = {
    read: r.read, starred: r.starred, hidden: r.hidden, progress: r.progress ?? 0,
    updated_at: r.updated_at || new Date(0).toISOString(),
  };
  // Merge: last-write-wins by updated_at. Push local-only/newer entries up.
  const upserts: any[] = [];
  for (const [key, le] of Object.entries(state)) {
    const re = remote[key];
    if (!re || (le.updated_at || '') > (re.updated_at || '')) {
      remote[key] = le;
      const prog = le.progress ?? 0;
      upserts.push({ user_id: session.user.id, section_key: key,
        read: !!le.read, starred: !!le.starred, hidden: !!le.hidden, progress: prog,
        read_at: le.read ? le.updated_at : null,
        progress_at: prog > 0 ? le.updated_at : null, updated_at: le.updated_at });
    }
  }
  if (upserts.length) await sb.from('section_state').upsert(upserts, { onConflict: 'user_id,section_key' });
  state = remote;
  saveLocal(state);
  applyAll();
  maybeRestoreScroll(); // remote may have a newer progress to resume from
}

let signinExpanded = false;

function renderAuth(session: any) {
  const signedIn = !!session;
  const signedOut = isConfigured && !signedIn;
  // Status text: only the email when signed in (the "sign in" button stands in for "signed out").
  document.querySelectorAll<HTMLElement>('[data-auth-status]').forEach((el) => {
    el.textContent = signedIn ? (session.user.email || 'signed in') : '';
    el.hidden = !signedIn;
  });
  document.querySelectorAll<HTMLElement>('[data-when="signed-in"]').forEach(
    (el) => (el.hidden = !signedIn));
  // Signed out collapses to a single "sign in" button; clicking it reveals the inline form.
  document.querySelectorAll<HTMLElement>('[data-signin-toggle]').forEach(
    (el) => (el.hidden = !(signedOut && !signinExpanded)));
  document.querySelectorAll<HTMLElement>('[data-auth-form]').forEach(
    (el) => (el.hidden = !(signedOut && signinExpanded)));
  document.querySelectorAll<HTMLElement>('[data-when="unconfigured"]').forEach(
    (el) => (el.hidden = isConfigured));
}

function wireAuth() {
  document.querySelectorAll<HTMLElement>('[data-signin-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      signinExpanded = true;
      renderAuth(null); // toggle only shows when signed out, so session is null
      (document.querySelector('[data-auth-form] input[type=email]') as HTMLInputElement | null)?.focus();
    }));
  document.querySelectorAll<HTMLFormElement>('[data-auth-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sb) return;
      const email = (form.querySelector('input[type=email]') as HTMLInputElement)?.value?.trim();
      const msg = form.querySelector('[data-auth-msg]') as HTMLElement | null;
      if (!email) return;
      const { error } = await sb.auth.signInWithOtp({
        email, options: { emailRedirectTo: window.location.href },
      });
      if (msg) msg.textContent = error ? `Error: ${error.message}` : 'Check your email for a magic link.';
    });
  });
  document.querySelectorAll<HTMLElement>('[data-signout]').forEach((btn) =>
    btn.addEventListener('click', async () => { await sb?.auth.signOut(); location.reload(); }));
}

// ---- wire controls ----------------------------------------------------------
function wireControls() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // read / star / hide toggles
    const el = target.closest<HTMLElement>('[data-action][data-key]');
    if (el) {
      const key = el.getAttribute('data-key')!;
      const action = el.getAttribute('data-action');
      if (action === 'read') toggle(key, 'read');
      if (action === 'star') toggle(key, 'starred');
      if (action === 'hide') toggle(key, 'hidden');
      return;
    }
    // filter pills
    const pill = target.closest<HTMLElement>('[data-filter]');
    if (pill) {
      const f = pill.getAttribute('data-filter') as Filter;
      localStorage.setItem(FILTER_KEY, f);
      applyFilter(f);
      return;
    }
    // collapsible deck preamble (collapsed state syncs)
    const pre = target.closest('[data-action="toggle-preamble"]');
    if (pre) {
      const region = pre.closest<HTMLElement>('[data-preamble]');
      const key = region?.dataset.preambleKey;
      if (region && key) { toggle(key, 'hidden'); applyPreamble(region); }
      return;
    }
    // copy the current section as markdown (links already absolute)
    const cp = target.closest<HTMLElement>('[data-action="copy-md"]');
    if (cp) { copyMd(cp); return; }
    // random section within the current filter view
    if (target.closest('[data-action="random-view"]')) { randomInView(); return; }
    // × clear an entry from the home "Continue reading" panel
    const clr = target.closest<HTMLElement>('[data-clear-progress][data-key]');
    if (clr) { clearProgress(clr.getAttribute('data-key')!); return; }
  });
}

// ---- copy section as markdown (TODO #6) ------------------------------------
// The section's markdown source is embedded in a hidden <template> on the page
// (links already rewritten to absolute globway URLs at build time). Show the
// button only when that md exists (the merged colophon has none).
function sectionMd(): string {
  return document.querySelector<HTMLElement>('[data-section-md]')?.textContent || '';
}
function syncCopyButton() {
  const has = !!sectionMd().trim();
  document.querySelectorAll<HTMLElement>('[data-action="copy-md"]').forEach((b) => { b.hidden = !has; });
}
let copyTimer = 0;
async function copyMd(btn: HTMLElement) {
  const md = sectionMd();
  if (!md) return;
  if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
  let msg = 'copied ✓';
  try { await navigator.clipboard.writeText(md); } catch { msg = 'copy failed'; }
  btn.innerHTML = msg;
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => { btn.innerHTML = btn.dataset.label!; }, 1400);
}

// ---- keyboard host actions --------------------------------------------------
// The keyboard layer's body bindings for r/*/b/m operate on the *current*
// section; resolve its key from the article element and reuse toggle()/copyMd().
function currentSectionKey(): string | null {
  return document.querySelector<HTMLElement>('[data-section-key]')?.dataset.sectionKey || null;
}
function toggleCurrent(field: 'read' | 'starred' | 'hidden') {
  const key = currentSectionKey();
  if (key) toggle(key, field);
}
function copyMdCurrent() {
  const btn = document.querySelector<HTMLElement>('[data-action="copy-md"]:not([hidden])');
  if (btn) copyMd(btn);
}

// ---- deck presenter (/aux, /p3, /p8) ---------------------------------------
// One shared presenter for any deck (a list of cards): fetch its JSON once, render
// one card by ?p=<key> (or ?r=1 for a random card), step with prev/next/random.
// read/star/hide reuse the global toggle (state syncs by key); the deck name comes
// from the page path so /aux?p=, /p3?p=, /p8?p= all work from one code path.
type DeckItem = { key: string; title: string; order: number; html: string };
async function initDeck(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>('[data-deck]');
  if (!root) return;
  const src = root.dataset.src!;                                 // e.g. "/p8.json"
  const basePrefix = src.replace(/[^/]+\.json$/, '');            // "/" or "/globway/"
  const deck = src.replace(/^.*\/([^/]+)\.json$/, '$1');         // "aux" | "p3" | "p8"
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const titleEl = $<HTMLElement>('[data-deck-title]');
  const bodyEl = $<HTMLElement>('[data-deck-body]');
  const controls = $<HTMLElement>('[data-deck-controls]');
  const countEl = $<HTMLElement>('[data-deck-count]');
  const prevEl = $<HTMLAnchorElement>('[data-deck-prev]');
  const nextEl = $<HTMLAnchorElement>('[data-deck-next]');

  let items: DeckItem[] = [];
  let byKey = new Map<string, DeckItem>();
  let deckPreamble = '';
  let showTitle = true; // aux: card name is a real heading. p3: title repeats the body.
  let bodyAsHeading = false; // p8: render the prompt itself as the (big) heading.
  try {
    const data = await (await fetch(src)).json();
    items = data.items || [];
    deckPreamble = data.preamble || '';
    showTitle = data.showTitle !== false;
    bodyAsHeading = !!data.bodyAsHeading;
    byKey = new Map(items.map((p) => [p.key, p]));
  } catch {
    titleEl.textContent = 'Could not load this list.';
    return;
  }
  if (!items.length) { titleEl.textContent = 'Nothing here.'; return; }

  // Optional collapsible preamble (instructions) at the top of the deck page.
  const preEl = root.querySelector<HTMLElement>('[data-preamble]');
  if (preEl && deckPreamble) {
    preEl.querySelector<HTMLElement>('[data-preamble-body]')!.innerHTML = deckPreamble.replaceAll('@@BASE@@', basePrefix);
    preEl.dataset.preambleKey = `preamble:${deck}`;
    preEl.hidden = false;
    applyPreamble(preEl);
  }

  const randomKey = () => items[Math.floor(Math.random() * items.length)].key;
  const deckHref = (key: string) => `${basePrefix}${deck}?p=${encodeURIComponent(key)}`;
  function setNav(el: HTMLAnchorElement, t: DeckItem | undefined, dir: 'prev' | 'next') {
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    el.href = deckHref(t.key);
    el.textContent = dir === 'prev' ? `← ${t.title}` : `${t.title} →`;
  }
  function render(key: string) {
    const p = byKey.get(key);
    if (!p) return;
    const bodyHtml = p.html.replaceAll('@@BASE@@', basePrefix);
    if (bodyAsHeading) {
      titleEl.hidden = false;
      titleEl.innerHTML = bodyHtml; // the prompt is the heading; no separate body
      bodyEl.innerHTML = '';
    } else {
      titleEl.textContent = showTitle ? p.title : '';
      titleEl.hidden = !showTitle;
      bodyEl.innerHTML = bodyHtml;
    }
    controls.hidden = false;
    controls.querySelectorAll<HTMLElement>('[data-action][data-key]').forEach((b) => b.setAttribute('data-key', key));
    applyEntry(key);
    countEl.textContent = `${p.order + 1} / ${items.length}`;
    setNav(prevEl, items[p.order - 1], 'prev');
    setNav(nextEl, items[p.order + 1], 'next');
    document.title = `${p.title} ༄ Global Wayfinding Meditation Manual`;
  }
  function go(key: string) {
    history.pushState({}, '', deckHref(key));
    render(key);
    window.scrollTo(0, 0);
  }
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const nav = t.closest<HTMLAnchorElement>('[data-deck-prev],[data-deck-next]');
    if (nav && !nav.hidden) {
      // Let modifier / middle clicks open the real ?p=<key> href natively (new
      // tab/window), same as a regular section link — only intercept a plain click.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      const k = new URL(nav.href).searchParams.get('p');
      if (k) go(k);
      return;
    }
    if (t.closest('[data-action="deck-random"]')) { e.preventDefault(); go(randomKey()); }
  }, { signal });
  window.addEventListener('popstate', () => render(startKey()), { signal });
  // ?r=1 → land on a random card (used by the navbar draw buttons); else ?p=<key>.
  function startKey() {
    const q = new URLSearchParams(location.search);
    if (q.get('r')) return randomKey();
    const p = q.get('p');
    return p && byKey.has(p) ? p : items[0].key;
  }
  const first = startKey();
  if (new URLSearchParams(location.search).get('r')) history.replaceState({}, '', deckHref(first));
  render(first);
}

// Build the sidebar TOC tree once, client-side, from the bundled toc.json — the
// same <ul class="tree"> markup Tree.astro used to server-render into every page.
// The container is transition:persist, so this survives navigations (built once).
// The interactive state layer keys off [data-row-key], agnostic to who built it.
function buildSidebarTree() {
  const nav = document.querySelector<HTMLElement>('.sidebar nav[data-toc]');
  if (!nav || nav.querySelector('ul.tree')) return; // missing, or already built
  const base = import.meta.env.BASE_URL;
  const b = base.endsWith('/') ? base : base + '/';
  const render = (nodes: TocNode[]): HTMLUListElement => {
    const ul = document.createElement('ul');
    ul.className = 'tree';
    for (const n of nodes) {
      const li = document.createElement('li');
      li.className = `depth-${n.depth}`;
      const a = document.createElement('a');
      a.className = 'row' + (n.children.length ? ' has-kids' : '');
      a.dataset.rowKey = n.key;
      a.href = `${b}s/${n.key}`;
      a.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="t"></span><span class="star" aria-hidden="true">★</span>';
      a.querySelector('.t')!.textContent = n.title || n.key;
      li.appendChild(a);
      if (n.children.length) li.appendChild(render(n.children));
      ul.appendChild(li);
    }
    return ul;
  };
  nav.appendChild(render(tocData as TocNode[]));
}

// Scroll the sidebar so the current page's row sits at the vertical centre — deep
// items are otherwise off-screen below the fold when you land on a page.
function scrollSidebarToCurrent() {
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const cur = document.querySelector<HTMLElement>('.sidebar a.row.current');
  if (!sidebar || !cur) return;
  const sRect = sidebar.getBoundingClientRect();
  const cRect = cur.getBoundingClientRect();
  sidebar.scrollTop += (cRect.top - sRect.top) - sidebar.clientHeight / 2 + cRect.height / 2;
}

// Sidebar parent rows are position:sticky so the current item's ancestors stack at
// the top like breadcrumbs while you scroll. Their stack offset (`top`) must be the
// summed height of their own ancestor rows — computed here because titles wrap to
// varying heights, so a fixed per-depth offset would overlap. Deeper rows get a
// lower z-index so they slide *under* their shallower (pinned) ancestors.
function computeStickyTops() {
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  if (!sidebar) return;
  sidebar.querySelectorAll<HTMLElement>('a.row.has-kids').forEach((row) => {
    let top = 0, depth = 0;
    let li = row.closest('li')?.parentElement?.closest('li') ?? null;
    while (li) {
      const arow = li.querySelector<HTMLElement>(':scope > a.row');
      if (arow) { top += arow.getBoundingClientRect().height; depth++; }
      li = li.parentElement?.closest('li') ?? null;
    }
    row.style.top = `${top}px`;
    row.style.zIndex = String(50 - depth);
  });
}

// A pinned parent casts a drop-shadow only while it's actually hiding content
// beneath it — i.e. its first child has scrolled up under it (so an older sibling
// of whatever's now on top is hidden). A parent sitting flush above its still-
// visible first child gets none. Recomputed on sidebar scroll (rAF-throttled).
function firstVisibleChildRow(parentRow: HTMLElement): HTMLElement | null {
  const ul = parentRow.closest('li')?.querySelector(':scope > ul');
  if (!ul) return null;
  for (const li of Array.from(ul.children)) {
    const a = li.querySelector<HTMLElement>(':scope > a.row');
    if (a && a.getClientRects().length) return a; // skip filtered-out (display:none) rows
  }
  return null;
}
function updateStickyShadows() {
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  if (!sidebar) return;
  sidebar.querySelectorAll<HTMLElement>('a.row.has-kids').forEach((row) => {
    const r = row.getBoundingClientRect();
    const li = row.closest('li')!.getBoundingClientRect();
    // Pinned right now = sticky is holding the row back (li scrolled above it) AND
    // its subtree still extends below (otherwise it has released and scrolled off).
    const pinned = li.top < r.top - 0.5 && li.bottom > r.bottom + 1;
    // First child is "hidden under" only once it's risen more than half a row above
    // the parent's bottom — a flush pinned child sits ~at r.bottom (tolerate rounding).
    const fc = firstVisibleChildRow(row);
    const hiding = !!fc && fc.getBoundingClientRect().top < r.bottom - r.height * 0.6;
    row.classList.toggle('pinned-shadow', pinned && hiding);
  });
}
let shadowRaf = 0;
function onSidebarScroll() {
  if (shadowRaf) return;
  shadowRaf = requestAnimationFrame(() => { shadowRaf = 0; updateStickyShadows(); });
}

// Mobile: the sidebar is an off-canvas drawer. A hamburger toggles it; tapping the
// backdrop, a TOC link, or Escape closes it.
function wireNav() {
  // Read document.body *live* on each call — the nav-toggle/backdrop persist across
  // ViewTransitions, but Astro swaps in a fresh <body> on navigation, so a captured
  // reference would go stale (toggling the old, detached body does nothing).
  const close = () => document.body.classList.remove('nav-open');
  const open = () => { document.body.classList.add('nav-open'); computeStickyTops(); scrollSidebarToCurrent(); updateStickyShadows(); };
  document.querySelectorAll<HTMLElement>('[data-nav-toggle]').forEach((b) =>
    b.addEventListener('click', () => (document.body.classList.contains('nav-open') ? close() : open())));
  document.querySelectorAll<HTMLElement>('[data-nav-backdrop]').forEach((b) =>
    b.addEventListener('click', close));
  document.querySelector('.sidebar nav[aria-label="Table of contents"]')
    ?.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a.row')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ---- passive read state (TODO #4) ------------------------------------------
// On a section page we (a) auto-mark "read" once you reach the end (scrollable
// pages) or dwell long enough (short / no-scroll pages), (b) remember how far you
// got so the home "Continue reading" panel can resume, and (c) auto-restore that
// scroll position on return. Scoped to /s/<key> pages (they carry data-section-key).
let trackKey: string | null = null;
let userScrolled = false;

function pageScrollMax() { return document.documentElement.scrollHeight - window.innerHeight; }
function isScrollable() { return pageScrollMax() > 24; } // 24px slop = "doesn't really scroll"
function topFraction() {
  const max = pageScrollMax();
  return max <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / max));
}
function reachedEnd() {
  return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 48;
}

// Auto-scroll back to where you left off — but never once the user has taken the
// wheel, or if there's a #hash, or the page is too short / already read. Safe to
// call repeatedly (recomputes from the live scrollHeight); it no-ops after input.
function maybeRestoreScroll() {
  if (userScrolled || !trackKey || location.hash) return;
  const e = state[trackKey] || {};
  if (e.read) { userScrolled = true; return; } // nothing to resume; stop trying
  const p = e.progress ?? 0;
  if (p < 0.05 || p > 0.95 || !isScrollable()) return;
  window.scrollTo({ top: p * pageScrollMax(), behavior: 'smooth' });
}

function initReadTracking(signal: AbortSignal) {
  // Reset per-page tracking state (this runs on every client-side navigation).
  trackKey = null;
  userScrolled = false;
  const host = document.querySelector<HTMLElement>('[data-section-key]');
  if (!host) return;                                   // not a section page
  // Own the scroll position: otherwise the browser restores its native position
  // (e.g. the bottom, after a refresh) and fights — or pre-empts — our resume.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  trackKey = host.dataset.sectionKey!;
  const wordcount = parseInt(host.dataset.wordcount || '0', 10) || 0;
  if ((state[trackKey] || {}).read) return;            // already read: nothing to track

  // Note genuine user input (not our own programmatic smooth-scroll), so
  // auto-restore never yanks someone who's already started reading.
  ['wheel', 'touchstart', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => { userScrolled = true; }, { once: true, passive: true, signal }));

  // Short, non-scrolling pages can't report scroll progress — mark read after a
  // dwell proportional to length (~0.3s/word, clamped 8–90s). The dwell counts
  // only *visible* time: it pauses while the tab is hidden/backgrounded so time
  // spent away doesn't quietly mark the page read.
  const dwellMs = Math.min(90000, Math.max(8000, Math.round(wordcount * 300)));
  let dwellLeft = dwellMs;   // visible ms still required before auto-read
  let dwellTimer = 0;
  let dwellSince = 0;        // performance.now() when the current visible run began
  const dwellEligible = () => !isScrollable() && !(state[trackKey!] || {}).read;
  const dwellResume = () => {
    if (dwellTimer || document.visibilityState !== 'visible' || !dwellEligible()) return;
    dwellSince = performance.now();
    dwellTimer = window.setTimeout(() => { dwellTimer = 0; setRead(trackKey!); }, dwellLeft);
  };
  const dwellPause = () => {
    if (!dwellTimer) return;
    clearTimeout(dwellTimer); dwellTimer = 0;
    dwellLeft = Math.max(0, dwellLeft - (performance.now() - dwellSince));
  };

  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!trackKey || (state[trackKey] || {}).read) return;
      if (!isScrollable()) return;
      if (reachedEnd()) setRead(trackKey);
      else recordProgress(trackKey, topFraction());
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true, signal });
  // A resize may flip scrollability (rotate / font reflow): re-evaluate the dwell.
  window.addEventListener('resize', () => { dwellPause(); dwellResume(); }, { signal });

  // Pause the dwell + flush any debounced progress write when the tab is hidden or
  // the page is navigated away; resume counting once it's visible again.
  const flush = () => { if (trackKey) syncRow(trackKey); };
  window.addEventListener('pagehide', () => { dwellPause(); flush(); }, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { dwellPause(); flush(); }
    else dwellResume();
  }, { signal });

  dwellResume();
  maybeRestoreScroll();
  // Re-try once fonts/layout settle — scrollHeight (hence the restore target) shifts.
  window.addEventListener('load', () => { dwellResume(); maybeRestoreScroll(); }, { signal });
}

// Register the offline service worker (generated at build time by
// scripts/build-sw.mjs). Guarded so dev (no sw.js) is a harmless no-op.
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const base = import.meta.env.BASE_URL;
  navigator.serviceWorker.register(base + 'sw.js').catch(() => {});
}

// The sidebar persists across client-side navigations, so its server-rendered
// `.current` highlight is frozen on whatever page first loaded. Move it to match
// the page now showing (section pages carry their canonical key on the article).
function highlightCurrent() {
  const cur = document.querySelector<HTMLElement>('[data-section-key]')?.dataset.sectionKey || null;
  document.querySelectorAll<HTMLElement>('.sidebar a.row.current').forEach((a) => a.classList.remove('current'));
  if (cur) document.querySelector<HTMLElement>(`.sidebar a.row[data-row-key="${cssEscape(cur)}"]`)?.classList.add('current');
}

// ---- boot lifecycle ---------------------------------------------------------
// With <ClientRouter /> only <main> swaps; the sidebar + top chrome persist. So
// one-time setup (listeners on persistent elements / document / window) runs once,
// while per-page work re-runs on every `astro:page-load`. Per-page listeners are
// bound to a fresh AbortController each navigation so they don't accumulate.
let pageAbort: AbortController | null = null;

function once() {
  buildSidebarTree();  // populate the persistent sidebar TOC from toc.json
  wireControls();   // delegated on document — persists
  wireAuth();       // AuthBar lives in the persistent sidebar
  wireNav();        // toggle/backdrop/sidebar persist; keydown on document
  // Keyboard navigation: two listeners on persistent elements (document + sidebar),
  // wired once. Body actions (r/*/b/m) drive the section state via these hosts.
  initKeyboard({ toggle: toggleCurrent, copyMd: copyMdCurrent });
  initSearch();        // ⌘K full-text palette (lazy-loads its index on first open)
  initNoteArrival();   // pre-hide the section across a ?note view-transition (loader)
  registerSW();
  document.querySelector('.sidebar')?.addEventListener('scroll', onSidebarScroll, { passive: true });
  window.addEventListener('resize', () => { computeStickyTops(); updateStickyShadows(); });
  window.addEventListener('load', () => { computeStickyTops(); updateStickyShadows(); }); // re-measure after fonts settle
  if (sb) {
    getSession().then((session) => { renderAuth(session); pullRemote(); pullAnnotations(); });
    sb.auth.onAuthStateChange((_evt, session) => { renderAuth(session); pullRemote(); pullAnnotations(); });
    // Back online after offline edits? Re-run the merge: pullRemote() pushes any
    // local-newer rows up (last-write-wins) and pulls remote changes down.
    window.addEventListener('online', () => { pullRemote(); pullAnnotations(); });
  } else {
    renderAuth(null);
  }
}

function setupPage() {
  pageAbort?.abort();                 // tear down the previous page's listeners
  pageAbort = new AbortController();
  highlightCurrent();
  syncCopyButton();
  applyAll();
  initReadTracking(pageAbort.signal);
  initAnnotations(pageAbort.signal);
  initNotesView(pageAbort.signal);
  initDeck(pageAbort.signal);
  computeStickyTops();
  // A normal navigation centres the current row; a dice draw leaves the sidebar
  // alone (see the scrollTop=0 below) so spamming the dice doesn't scroll the
  // buttons away under the cursor.
  if (!randomNav) scrollSidebarToCurrent();
  updateStickyShadows();
  setupKeyboardPage();   // drop focus off a clicked sidebar row; reseed roving tabindex
  // Pin the sidebar to the top on a dice draw. Must run AFTER setupKeyboardPage(),
  // whose setRoving() calls scrollIntoView() on the (random) current row and would
  // otherwise scroll the dice buttons out of view.
  if (randomNav) {
    randomNav = false;
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (sidebar) sidebar.scrollTop = 0;
  }
}

let booted = false;
// Blank the article column the instant a navigation starts (before the fetch), so the
// load reads as an immediate dark "loading" state; page-load clears it and the new
// section fades in. The class rides on <html>, which survives the swap. See the
// `.main` / `html.gw-navigating` rules in global.css.
document.addEventListener('astro:before-preparation', () => {
  document.documentElement.classList.add('gw-navigating');
});
// astro:page-load fires on the initial load AND after every client-side swap.
document.addEventListener('astro:page-load', () => {
  document.documentElement.classList.remove('gw-navigating');   // safety net
  if (!booted) { booted = true; once(); }
  setupPage();
});
// Leaving a section page client-side fires no `pagehide`; flush its progress here.
document.addEventListener('astro:before-swap', () => {
  if (trackKey) syncRow(trackKey);
  // Clear the pre-fetch blank now — after the OLD snapshot is captured (blank), before
  // the NEW one — so the new <main> snapshot holds real content for the VT to fade in.
  document.documentElement.classList.remove('gw-navigating');
});
