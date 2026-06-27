// ⌘K full-text search. A MiniSearch index over every searchable item — the
// protocol sections (full body text), the auxiliary practices, and the p3/p8
// prompt cards — built lazily from /search.json the *first* time the palette
// opens (the asset isn't precached; see scripts/build-sw.mjs). The overlay
// mirrors the help-overlay idiom in keyboard.ts: role="dialog", owns its own
// keys, closes on Escape / backdrop / navigation. See
// docs/plans/2026-06-26-full-text-search-design.md.
import MiniSearch from 'minisearch';
import { navigate } from 'astro:transitions/client';

interface Doc { id: string; t: string; key: string; title: string; sub: string; text: string; }

const BASE = (() => { const b = import.meta.env.BASE_URL; return b.endsWith('/') ? b : b + '/'; })();

function hrefFor(d: Doc): string {
  const k = encodeURIComponent(d.key);
  switch (d.t) {
    case 'aux': return `${BASE}aux?p=${k}`;
    case 'p3':  return `${BASE}p3?p=${k}`;
    case 'p8':  return `${BASE}p8?p=${k}`;
    default:    return `${BASE}s/${k}`;
  }
}

// ---- lazy index -------------------------------------------------------------
// Built once on first open and kept for the page's lifetime. `docsById` is the
// single copy of each record (so MiniSearch stores no duplicate text); the
// renderer reads title/sub/text from it by id.
let mini: MiniSearch<Doc> | null = null;
let docsById: Map<string, Doc> | null = null;
let loading: Promise<void> | null = null;

function ensureIndex(): Promise<void> {
  if (mini) return Promise.resolve();
  if (!loading) loading = (async () => {
    const res = await fetch(`${BASE}search.json`);
    const data = await res.json();
    const docs: Doc[] = data.docs || [];
    docsById = new Map(docs.map((d) => [d.id, d]));
    const m = new MiniSearch<Doc>({ idField: 'id', fields: ['title', 'text'] });
    m.addAll(docs);
    mini = m;
  })().catch((e) => { loading = null; throw e; });   // allow a retry on failure
  return loading;
}

// ---- overlay ----------------------------------------------------------------
let overlay: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let hits: { doc: Doc; terms: string[] }[] = [];
let sel = 0;
let debounce = 0;

export function openSearch() {
  if (overlay) { inputEl?.focus(); return; }
  overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.innerHTML =
    `<div class="search-box" role="dialog" aria-modal="true" aria-label="Search the manual">`
    + `<div class="search-head"><span class="search-ic" aria-hidden="true">🔍</span>`
    + `<input type="text" class="search-input" placeholder="Search the manual…" `
    + `autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" `
    + `aria-label="Search the manual" aria-controls="search-results" role="combobox" aria-expanded="true" /></div>`
    + `<ul class="search-results" id="search-results" role="listbox"></ul>`
    + `<div class="search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>`
    + `<span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`
    + `</div>`;
  document.body.appendChild(overlay);
  inputEl = overlay.querySelector('.search-input');
  listEl = overlay.querySelector('.search-results');

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSearch(); });
  overlay.addEventListener('keydown', onOverlayKey);
  inputEl!.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(runQuery, 110);
  });
  listEl!.addEventListener('mousemove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (li && +li.dataset.i! !== sel) { sel = +li.dataset.i!; paintSel(false); }
  });
  listEl!.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (li) { sel = +li.dataset.i!; activate((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey); }
  });

  render('');
  inputEl!.focus();
  // Kick off the (possibly slow) first load; re-run once it lands if mid-typing.
  ensureIndex().then(() => { if (overlay && inputEl?.value.trim()) runQuery(); })
    .catch(() => { if (overlay) render(inputEl?.value.trim() || ''); });
}

export function closeSearch() {
  if (!overlay) return;
  overlay.remove();
  overlay = inputEl = listEl = null;
  hits = []; sel = 0;
  clearTimeout(debounce);
}

function onOverlayKey(e: KeyboardEvent) {
  e.stopPropagation();                                  // own every key while open
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); closeSearch(); return; }
  if ((k === 'k' || k === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeSearch(); return; }
  if (k === 'ArrowDown' || (e.ctrlKey && (k === 'n' || k === 'j'))) { e.preventDefault(); move(1); return; }
  if (k === 'ArrowUp'   || (e.ctrlKey && (k === 'p' || k === 'k'))) { e.preventDefault(); move(-1); return; }
  if (k === 'Enter') { e.preventDefault(); activate(e.metaKey || e.ctrlKey); return; }
}

// ---- query + render ---------------------------------------------------------
function runQuery() {
  const q = inputEl?.value.trim() || '';
  if (!q || !mini || !docsById) { hits = []; render(q); return; }
  const raw = mini.search(q, { boost: { title: 4 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' });
  hits = raw.slice(0, 40)
    .map((r) => ({ doc: docsById!.get(r.id)!, terms: r.terms as string[] }))
    .filter((h) => h.doc);
  sel = 0;
  render(q);
}

function render(q: string) {
  if (!listEl) return;
  if (!q) {
    listEl.innerHTML = `<li class="search-empty">${mini ? 'Type to search the manual.' : 'Type to search…'}</li>`;
    return;
  }
  if (!mini) { listEl.innerHTML = `<li class="search-empty">Loading the search index…</li>`; return; }
  if (!hits.length) { listEl.innerHTML = `<li class="search-empty">No matches for “${escapeHtml(q)}”.</li>`; return; }
  listEl.innerHTML = hits.map(({ doc, terms }, i) =>
    `<li class="search-hit${i === sel ? ' is-sel' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}">`
    + `<div class="sh-title">${highlight(doc.title || doc.key, terms)}</div>`
    + `<div class="sh-snip">${snippet(doc.text, terms)}</div>`
    + `<div class="sh-sub">${escapeHtml(doc.sub || '')}</div>`
    + `</li>`).join('');
}

function move(d: number) {
  if (!hits.length) return;
  sel = (sel + d + hits.length) % hits.length;
  paintSel(true);
}
function paintSel(scroll: boolean) {
  if (!listEl) return;
  listEl.querySelectorAll<HTMLElement>('.search-hit').forEach((el, i) => {
    const on = i === sel;
    el.classList.toggle('is-sel', on);
    el.setAttribute('aria-selected', String(on));
    if (on && scroll) el.scrollIntoView({ block: 'nearest' });
  });
}

function activate(newTab: boolean) {
  const h = hits[sel];
  if (!h) return;
  const href = hrefFor(h.doc);
  closeSearch();
  if (newTab) window.open(href, '_blank', 'noopener');
  else navigate(href);
}

// ---- snippet + highlight ----------------------------------------------------
// A ~200-char window of the body around the first matched term, with every
// matched term wrapped in <mark>. Everything is escaped (the corpus is
// plaintext) so building markup by hand here is safe.
function snippet(text: string, terms: string[]): string {
  if (!text) return '';
  let at = -1;
  const lc = text.toLowerCase();
  for (const t of terms) {
    const i = lc.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 60);
  let s = text.slice(start, start + 200);
  if (start > 0) s = '…' + s;
  if (start + 200 < text.length) s += '…';
  return highlight(s, terms);
}

function highlight(text: string, terms: string[]): string {
  const uniq = [...new Set(terms.map((t) => t.toLowerCase()))].filter(Boolean);
  if (!uniq.length) return escapeHtml(text);
  const re = new RegExp('(' + uniq.map(escapeRe).join('|') + ')', 'gi');
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;       // guard against zero-length matches
  }
  return out + escapeHtml(text.slice(last));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---- wiring -----------------------------------------------------------------
// Wired once from app.ts. The visible entry point (the NavBar's 🔍 pill) is a
// delegated click; ⌘K is dispatched by the keyboard layer (keyboard.ts).
export function initSearch() {
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-action="open-search"]')) openSearch();
  });
  document.addEventListener('astro:before-swap', closeSearch);  // overlay lives on a swapped <body>
}
