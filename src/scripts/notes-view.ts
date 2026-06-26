// ===========================================================================
// ALL-NOTES VIEW (/notes)
//
// A cross-section digest of every annotation you've made, grouped by section in
// reading order. Each note is shown beneath the paragraph it lives in:
//   - paragraph notes already store the whole block as their quote — free.
//   - highlights store only a short quote + ±32 chars of context, so to show the
//     *full* surrounding paragraph we fetch the already-built static section page
//     (the very HTML a normal visit loads — hence service-worker-precached and
//     offline-ready), pull its top-level blocks' text, and find the one that
//     contains the quote. Until/unless that resolves we fall back to the stored
//     prefix/quote/suffix snippet, so a note always renders something instantly.
//   - page notes have no anchor, so we show the section's opening paragraphs as a
//     preview (clearly marked as a snippet) and link out to read the rest.
//
// Edits/deletes reuse annotations.ts's CRUD, which mutates the same in-memory
// store the section pages read — so a change here is reflected when you next open
// the section, and vice-versa.
// ===========================================================================
import {
  type Annotation,
  getAllAnnotations,
  updateAnnotation,
  deleteAnnotation,
  md,
  normalizePlaintext,
  resolveKey,
} from './annotations';

// Lean section metadata (key -> title / reading order), injected by notes.astro
// at build time so we can group + order without bundling the 5.6MB content file.
type SectionMeta = { title: string; order: number; depth: number };
let sectionMeta: Record<string, SectionMeta> = {};

let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let editingId: string | null = null;       // note whose editor is open
let confirmDeleteId: string | null = null;  // note showing the inline delete confirm

// ---- section paragraph cache ------------------------------------------------
// canonical key -> its top-level block texts (fetched once from the static page).
// undefined entry = not yet fetched/in flight.
const blockCache: Record<string, string[]> = {};
const inFlight: Record<string, Promise<void>> = {};

function baseUrl(): string {
  const b = import.meta.env.BASE_URL;
  return b.endsWith('/') ? b : b + '/';
}
function sectionHref(canon: string): string { return `${baseUrl()}s/${canon}`; }

// Extract the same top-level blocks the annotation engine tags (top-level
// p/hN/blockquote/pre + first-level list items), as normalized plaintext — so a
// stored quote (which is a normalized block text, or a substring of one) matches.
function extractBlocks(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.querySelector('[data-annot-body]');
  if (!body) return [];
  const blocks: string[] = [];
  const push = (el: Element) => {
    const t = normalizePlaintext(el.textContent || '');
    if (t) blocks.push(t);
  };
  Array.from(body.children).forEach(child => {
    const t = child.tagName;
    if (t === 'UL' || t === 'OL') Array.from(child.children).forEach(push);
    else if (/^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(t)) push(child);
  });
  return blocks;
}

// Fetch a section's blocks if we haven't already; on success, refresh any cards
// of that section so their context upgrades from snippet -> full paragraph.
function ensureBlocks(canon: string) {
  if (canon in blockCache || canon in inFlight) return;
  inFlight[canon] = fetch(sectionHref(canon))
    .then(r => (r.ok ? r.text() : ''))
    .then(html => { blockCache[canon] = extractBlocks(html); })
    .catch(() => { blockCache[canon] = []; })
    .finally(() => { delete inFlight[canon]; fillSection(canon); });
}

// ---- small helpers ----------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function titleFor(canon: string): string {
  return sectionMeta[canon]?.title || canon;
}
function orderFor(canon: string): number {
  return sectionMeta[canon]?.order ?? Number.MAX_SAFE_INTEGER;
}
// Escape `text` and wrap the first occurrence of `quote` in a highlight mark.
function markQuote(text: string, quote: string): string {
  if (!quote) return escapeHtml(text);
  const i = text.indexOf(quote);
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i))
    + `<mark class="hl">${escapeHtml(quote)}</mark>`
    + escapeHtml(text.slice(i + quote.length));
}

// ---- context (the surrounding paragraph) ------------------------------------
// Stored-only snippet for a highlight: …prefix «quote» suffix…
function storedSnippet(a: Annotation): string {
  const q = normalizePlaintext(a.quote || '');
  const pre = a.prefix ? '…' + a.prefix : '';
  const suf = a.suffix ? a.suffix + '…' : '';
  return escapeHtml(pre) + `<mark class="hl">${escapeHtml(q)}</mark>` + escapeHtml(suf);
}

// The surrounding paragraph for an *anchored* note (highlight or para).
function contextHtml(a: Annotation): string {
  const blocks = blockCache[resolveKey(a.section_key)];
  if (a.kind === 'para') {
    // The quote IS the full block.
    return `<p class="note-para">${escapeHtml(a.quote || '')}</p>`;
  }
  // highlight
  const q = normalizePlaintext(a.quote || '');
  const block = blocks && q ? blocks.find(b => b.includes(q)) : undefined;
  if (block) return `<p class="note-para">${markQuote(block, q)}</p>`;
  return `<p class="note-para">${storedSnippet(a)}</p>`;     // fallback / pre-fetch
}

// The section's opening text, shown ONCE above a section's page-level notes as
// shared context. Styled as a faded excerpt (see CSS) so it reads as a peek into
// the section rather than a note — no label needed.
function excerptHtml(canon: string): string {
  const blocks = blockCache[canon];
  if (!blocks) return `<span class="is-loading">Loading…</span>`;
  if (!blocks.length) return '';
  let preview = blocks.slice(0, 2).join(' ');
  if (preview.length > 300) preview = preview.slice(0, 300).replace(/\s+\S*$/, '') + ' …';
  else preview += ' …';
  return escapeHtml(preview);
}

// ---- per-note card ----------------------------------------------------------
// A title (tooltip) for the kind icon — the word itself is noise in the list, but
// keep it available on hover / for screen readers.
function kindLabel(a: Annotation): string {
  if (a.kind === 'para') return 'paragraph note';
  if (a.kind === 'highlight') return a.body == null ? 'highlight' : 'highlight + note';
  return 'page note';
}

// Quiet 16px line icons (stroke = currentColor; colored per kind in CSS).
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"`
  + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const KIND_ICON: Record<Annotation['kind'], string> = {
  // highlighter (marks text)
  highlight: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  // pilcrow (a whole paragraph)
  para: svg('<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>'),
  // sticky note (a note about the page)
  note: svg('<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/>'),
};

// Shared bits ----------------------------------------------------------------
function editorHtml(a: Annotation): string {
  return `<textarea class="note-edit" data-editor="${a.id}" `
    + `placeholder="Write a note… Markdown supported">${escapeHtml(a.body || '')}</textarea>`
    + `<div class="note-edit-actions">`
    + `<button type="button" class="pill" data-save="${a.id}">Save</button>`
    + `<button type="button" class="pill" data-cancel="${a.id}">Cancel</button></div>`;
}
function actionsHtml(a: Annotation): string {
  return confirmDeleteId === a.id
    ? `<span class="note-confirm">Delete?`
      + ` <button type="button" class="pill note-del-yes" data-del-confirm="${a.id}">Delete</button>`
      + ` <button type="button" class="pill" data-del-cancel="${a.id}">Keep</button></span>`
    : `<button type="button" class="note-icon" data-edit="${a.id}" title="Edit">✎</button>`
      + `<button type="button" class="note-icon note-del" data-del="${a.id}" title="Delete">×</button>`;
}
function bodyHtml(a: Annotation): string {
  if (editingId === a.id) return editorHtml(a);
  if (a.body != null && a.body.trim()) return `<div class="note-body ann-md">${md(a.body)}</div>`;
  return '';   // bare mark: the marked paragraph above is the whole content
}

// An anchored note (highlight / paragraph): its own surrounding paragraph + body.
function buildCard(a: Annotation, canon: string): HTMLElement {
  const card = document.createElement('article');
  card.className = `note note--${a.kind}`
    + (a.orphaned ? ' is-detached' : '')
    + (editingId === a.id ? ' is-editing' : '');
  card.dataset.noteId = a.id;
  const detached = a.orphaned
    ? `<div class="note-detached">detached — the text this was anchored to has changed</div>` : '';
  card.innerHTML =
    `<div class="note-ctx">${detached}${contextHtml(a)}</div>`
    + bodyHtml(a)
    + `<div class="note-foot">`
    + `<span class="note-kind" title="${kindLabel(a)}" aria-label="${kindLabel(a)}">${KIND_ICON[a.kind]}</span>`
    + `<span class="note-foot-right">`
    + `<a class="note-open" href="${sectionHref(canon)}">open in section →</a>`
    + `<span class="note-actions">${actionsHtml(a)}</span>`
    + `</span></div>`;
  return card;
}

// A page-level note: no anchor, so it shows just its body + minimal actions. The
// shared section excerpt above the page-notes block provides the context, once.
function buildPageNote(a: Annotation): HTMLElement {
  const card = document.createElement('article');
  card.className = 'note-pagenote' + (editingId === a.id ? ' is-editing' : '');
  card.dataset.noteId = a.id;
  card.innerHTML =
    bodyHtml(a)
    + `<div class="note-pageact"><span class="note-actions">${actionsHtml(a)}</span></div>`;
  return card;
}

// ---- grouping + render ------------------------------------------------------
// Within a section: anchored notes by reading position, page notes last
// (matching the section rail's page-notes-as-a-panel layout).
function inSectionOrder(a: Annotation, b: Annotation): number {
  const pa = a.kind === 'note' ? Number.MAX_SAFE_INTEGER : (a.text_position ?? 0);
  const pb = b.kind === 'note' ? Number.MAX_SAFE_INTEGER : (b.text_position ?? 0);
  if (pa !== pb) return pa - pb;
  return a.created_at.localeCompare(b.created_at);
}

function groupBySection(anns: Annotation[]): { canon: string; notes: Annotation[] }[] {
  const groups = new Map<string, Annotation[]>();
  for (const a of anns) {
    const canon = resolveKey(a.section_key);
    let arr = groups.get(canon);
    if (!arr) groups.set(canon, (arr = []));
    arr.push(a);
  }
  return [...groups.entries()]
    .map(([canon, notes]) => ({ canon, notes: notes.sort(inSectionOrder) }))
    .sort((x, y) => orderFor(x.canon) - orderFor(y.canon));
}

function render() {
  if (!listEl) return;
  const anns = getAllAnnotations();
  if (countEl) {
    const n = anns.length;
    countEl.textContent = n ? `${n} note${n === 1 ? '' : 's'} across ${new Set(anns.map(a => resolveKey(a.section_key))).size} section${new Set(anns.map(a => resolveKey(a.section_key))).size === 1 ? '' : 's'}` : '';
  }

  if (!anns.length) {
    listEl.innerHTML =
      `<div class="notes-empty">`
      + `<p>You haven't written any notes yet.</p>`
      + `<p class="notes-empty-how">While reading, <strong>select text</strong> to highlight or note it, `
      + `or hover a paragraph and use the <strong>✎</strong> button. Your notes — and where they live — show up here.</p>`
      + `<p><a class="pill jump" href="${baseUrl()}">← back to the manual</a></p>`
      + `</div>`;
    return;
  }

  listEl.innerHTML = '';
  for (const { canon, notes } of groupBySection(anns)) {
    const anchored = notes.filter(n => n.kind !== 'note');
    const pageNotes = notes.filter(n => n.kind === 'note');
    // Fetch this section's text if anything needs it: a highlight to upgrade to its
    // full paragraph, or page notes to show the shared section excerpt.
    if (anchored.some(n => n.kind === 'highlight') || pageNotes.length) ensureBlocks(canon);

    const group = document.createElement('section');
    group.className = 'note-group';
    group.dataset.section = canon;
    group.innerHTML =
      `<h2 class="note-group-h"><a href="${sectionHref(canon)}">${escapeHtml(titleFor(canon))}</a>`
      + `<span class="note-group-count">${notes.length}</span></h2>`;

    const inner = document.createElement('div');
    inner.className = 'note-group-list';
    anchored.forEach(n => inner.appendChild(buildCard(n, canon)));

    if (pageNotes.length) {
      const block = document.createElement('div');
      block.className = 'note-pageblock';
      block.innerHTML =
        `<a class="note-excerpt" data-excerpt href="${sectionHref(canon)}" title="Open this section">`
        + `<span class="note-excerpt-text">${excerptHtml(canon)}</span>`
        + `<span class="note-excerpt-open">open →</span></a>`;
      pageNotes.forEach(n => block.appendChild(buildPageNote(n)));
      inner.appendChild(block);
    }

    group.appendChild(inner);
    listEl.appendChild(group);
  }

  if (editingId) {
    const id = editingId;
    const ta = listEl.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`);
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
      ta.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(id); }
        else if (e.key === 'Escape') { e.preventDefault(); editingId = null; render(); }
      });
    }
  }
}

// Re-render just the context paragraphs of one section after its text loads —
// avoids rebuilding the whole list (and losing an open editor) on each fetch.
function fillSection(canon: string) {
  if (!listEl) return;
  const group = listEl.querySelector(`.note-group[data-section="${CSS.escape(canon)}"]`);
  if (!group) return;
  const byId: Record<string, Annotation> = {};
  for (const a of getAllAnnotations()) if (resolveKey(a.section_key) === canon) byId[a.id] = a;
  group.querySelectorAll<HTMLElement>('.note[data-note-id]').forEach(card => {
    const a = byId[card.dataset.noteId!];
    const ctx = card.querySelector('.note-ctx');
    if (!a || !ctx) return;
    const detached = a.orphaned
      ? `<div class="note-detached">detached — the text this was anchored to has changed</div>` : '';
    ctx.innerHTML = detached + contextHtml(a);
  });
  const exc = group.querySelector('[data-excerpt] .note-excerpt-text');
  if (exc) exc.innerHTML = excerptHtml(canon);
}

// ---- edit / delete ----------------------------------------------------------
function save(id: string) {
  if (!listEl) return;
  const ta = listEl.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`);
  const val = ta ? ta.value : '';
  const a = getAllAnnotations().find(x => x.id === id);
  editingId = null;
  if (!a) { render(); return; }
  if (val.trim()) {
    updateAnnotation(id, { body: val });
  } else if (a.kind === 'note') {
    deleteAnnotation(id);                 // an emptied page note is gone
  } else {
    updateAnnotation(id, { body: null }); // highlight/para revert to a bare mark
  }
  render();
}

function onClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const ed = t.closest<HTMLElement>('[data-edit]');
  if (ed) { editingId = ed.dataset.edit!; confirmDeleteId = null; render(); return; }
  const sv = t.closest<HTMLElement>('[data-save]');
  if (sv) { save(sv.dataset.save!); return; }
  const cn = t.closest<HTMLElement>('[data-cancel]');
  if (cn) { editingId = null; render(); return; }
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) { confirmDeleteId = del.dataset.del!; render(); return; }
  const dc = t.closest<HTMLElement>('[data-del-confirm]');
  if (dc) { confirmDeleteId = null; deleteAnnotation(dc.dataset.delConfirm!); render(); return; }
  const dx = t.closest<HTMLElement>('[data-del-cancel]');
  if (dx) { confirmDeleteId = null; render(); return; }
}

// ---- init -------------------------------------------------------------------
export function initNotesView(signal: AbortSignal) {
  const host = document.querySelector<HTMLElement>('[data-notes-view]');
  if (!host) return;
  listEl = host.querySelector<HTMLElement>('[data-notes-list]');
  countEl = host.querySelector<HTMLElement>('[data-notes-count]');
  if (!listEl) return;

  const metaEl = host.querySelector<HTMLElement>('[data-notes-meta]');
  if (metaEl) { try { sectionMeta = JSON.parse(metaEl.textContent || '{}'); } catch { sectionMeta = {}; } }

  editingId = null;
  confirmDeleteId = null;
  host.addEventListener('click', onClick as EventListener, { signal });
  // A late Supabase pull (sign-in / back online) replaces the store — re-render so
  // synced notes from other devices appear without a manual reload.
  document.addEventListener('globway:annotations-pulled', render, { signal });

  render();

  signal.addEventListener('abort', () => {
    listEl = null; countEl = null;
    editingId = null; confirmDeleteId = null;
  });
}
