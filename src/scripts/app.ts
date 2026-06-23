// Client runtime: auth (magic-link) + read/star state sync.
// Works in three modes transparently:
//   1. Supabase configured + signed in  -> synced across devices.
//   2. Supabase configured + signed out -> local only; prompts to sign in to sync.
//   3. Supabase not configured           -> local only (dev / pre-setup).
import { getSupabase, isConfigured } from '../lib/supabase';

type Entry = { read?: boolean; starred?: boolean; hidden?: boolean; updated_at: string };
type State = Record<string, Entry>;
type Filter = 'all' | 'starred' | 'read' | 'unread' | 'hidden';

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
  document.querySelectorAll<HTMLElement>(`[data-row-key="${cssEscape(key)}"]`).forEach((row) => {
    row.classList.toggle('is-read', !!e.read);
    row.classList.toggle('is-starred', !!e.starred);
    row.classList.toggle('is-hidden', !!e.hidden);
  });
}
function applyAll() {
  Object.keys(state).forEach(applyEntry);
  refreshProgress();
  applyFilter(currentFilter());
  updatePager();
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
async function toggle(key: string, field: 'read' | 'starred' | 'hidden') {
  const cur = state[key] || { updated_at: '' };
  const next: Entry = { ...cur, [field]: !cur[field], updated_at: new Date().toISOString() };
  state[key] = next;
  saveLocal(state);
  applyEntry(key);
  refreshProgress();
  applyFilter(currentFilter()); // (un)hiding / (un)reading changes what the filter shows
  updatePager();                // hiding shifts a page's prev/next neighbours
  if (sb && (await getSession())) {
    const { error } = await sb.from('section_state').upsert(
      { user_id: (await getSession())!.user.id, section_key: key,
        read: !!next.read, starred: !!next.starred, hidden: !!next.hidden,
        read_at: next.read ? next.updated_at : null, updated_at: next.updated_at },
      { onConflict: 'user_id,section_key' }
    );
    if (error) console.warn('[globway] sync upsert failed:', error.message);
  }
}

// ---- filtering / random / pager --------------------------------------------
function currentFilter(): Filter {
  const f = localStorage.getItem(FILTER_KEY) as Filter | null;
  return f && ['all', 'starred', 'read', 'unread', 'hidden'].includes(f) ? f : 'all';
}
function rowMatches(key: string, f: Filter): boolean {
  const e = state[key] || {};
  switch (f) {
    case 'starred': return !!e.starred;
    case 'read': return !!e.read;
    case 'unread': return !e.read && !e.hidden;
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
function randomJump() {
  const candidates = orderedRows().filter((r) => !(state[r.key] || {}).hidden);
  if (!candidates.length) return;
  location.href = candidates[Math.floor(Math.random() * candidates.length)].href;
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

async function pullRemote() {
  if (!sb) return;
  const session = await getSession();
  if (!session) return;
  const { data, error } = await sb.from('section_state').select('*');
  if (error) { console.warn('[globway] pull failed:', error.message); return; }
  const remote: State = {};
  for (const r of data || []) remote[r.section_key] = {
    read: r.read, starred: r.starred, hidden: r.hidden,
    updated_at: r.updated_at || new Date(0).toISOString(),
  };
  // Merge: last-write-wins by updated_at. Push local-only/newer entries up.
  const upserts: any[] = [];
  for (const [key, le] of Object.entries(state)) {
    const re = remote[key];
    if (!re || (le.updated_at || '') > (re.updated_at || '')) {
      remote[key] = le;
      upserts.push({ user_id: session.user.id, section_key: key,
        read: !!le.read, starred: !!le.starred, hidden: !!le.hidden,
        read_at: le.read ? le.updated_at : null, updated_at: le.updated_at });
    }
  }
  if (upserts.length) await sb.from('section_state').upsert(upserts, { onConflict: 'user_id,section_key' });
  state = remote;
  saveLocal(state);
  applyAll();
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
    // random not-hidden section
    if (target.closest('[data-action="random-jump"]')) randomJump();
  });
}

// ---- aux practice presenter (/aux?p=<key>) ---------------------------------
// Renders one of the 959 preliminary/auxiliary practices at a time from the
// fetched-once /aux.json. read/star/hide reuse the global toggle (state syncs by
// key); prev/next/random step through practice order in place.
type AuxPractice = { key: string; title: string; order: number; html: string };
async function initAux() {
  const root = document.querySelector<HTMLElement>('[data-aux]');
  if (!root) return;
  const src = root.dataset.src || 'aux.json';
  const basePrefix = src.replace(/aux\.json$/, ''); // e.g. "/" or "/globway/"
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const titleEl = $<HTMLElement>('[data-aux-title]');
  const bodyEl = $<HTMLElement>('[data-aux-body]');
  const controls = $<HTMLElement>('[data-aux-controls]');
  const countEl = $<HTMLElement>('[data-aux-count]');
  const prevEl = $<HTMLAnchorElement>('[data-aux-prev]');
  const nextEl = $<HTMLAnchorElement>('[data-aux-next]');

  let practices: AuxPractice[] = [];
  let byKeyAux = new Map<string, AuxPractice>();
  try {
    const data = await (await fetch(src)).json();
    practices = data.practices || [];
    byKeyAux = new Map(practices.map((p) => [p.key, p]));
  } catch {
    titleEl.textContent = 'Could not load practices.';
    return;
  }
  if (!practices.length) { titleEl.textContent = 'No practices found.'; return; }

  const paramKey = () => {
    const p = new URLSearchParams(location.search).get('p');
    return p && byKeyAux.has(p) ? p : practices[0].key;
  };
  const auxHref = (key: string) => `${basePrefix}aux?p=${encodeURIComponent(key)}`;
  function setNav(el: HTMLAnchorElement, t: AuxPractice | undefined, dir: 'prev' | 'next') {
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    el.href = auxHref(t.key);
    el.textContent = dir === 'prev' ? `← ${t.title}` : `${t.title} →`;
  }
  function render(key: string) {
    const p = byKeyAux.get(key);
    if (!p) return;
    titleEl.textContent = p.title;
    bodyEl.innerHTML = p.html.replaceAll('@@BASE@@', basePrefix);
    controls.hidden = false;
    controls.querySelectorAll<HTMLElement>('[data-action][data-key]').forEach((b) => b.setAttribute('data-key', key));
    applyEntry(key);
    countEl.textContent = `${p.order + 1} / ${practices.length}`;
    setNav(prevEl, practices[p.order - 1], 'prev');
    setNav(nextEl, practices[p.order + 1], 'next');
    document.title = `${p.title} — Globway`;
  }
  function go(key: string) {
    history.pushState({}, '', auxHref(key));
    render(key);
    window.scrollTo(0, 0);
  }
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const nav = t.closest<HTMLAnchorElement>('[data-aux-prev],[data-aux-next]');
    if (nav && !nav.hidden) {
      e.preventDefault();
      const k = new URL(nav.href).searchParams.get('p');
      if (k) go(k);
      return;
    }
    if (t.closest('[data-action="aux-random"]')) {
      e.preventDefault();
      go(practices[Math.floor(Math.random() * practices.length)].key);
    }
  });
  window.addEventListener('popstate', () => render(paramKey()));
  render(paramKey());
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  wireControls();
  wireAuth();
  applyAll();
  initAux();
  if (sb) {
    const session = await getSession();
    renderAuth(session);
    await pullRemote();
    sb.auth.onAuthStateChange((_evt, session) => { renderAuth(session); pullRemote(); });
  } else {
    renderAuth(null);
  }
}
document.addEventListener('DOMContentLoaded', boot);
