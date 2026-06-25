import { getSupabase } from '../lib/supabase';
import aliasData from '../data/aliases.json';
import hashData from '../data/hashes.json';

const aliasToCanonical: Record<string, string> = aliasData.aliasToCanonical;
const sectionHashes: Record<string, string> = hashData as Record<string, string>;

type Annotation = {
  id: string;
  section_key: string;
  kind: 'note' | 'highlight';
  body: string | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  text_position: number | null;
  color: string | null;
  section_hash: string | null;
  title_snapshot: string | null;
  orphaned: boolean;
  deleted: boolean;
  created_at: string;
  updated_at: string;
};

const LS_KEY = 'globway:annotations';
const sb = getSupabase();

function loadLocal(): Record<string, Annotation> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveLocal(s: Record<string, Annotation>) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

let annotations: Record<string, Annotation> = loadLocal();

function resolveKey(key: string): string {
  return aliasToCanonical[key] || key;
}

function forSection(key: string): Annotation[] {
  const canon = resolveKey(key);
  return Object.values(annotations)
    .filter(a => !a.deleted && resolveKey(a.section_key) === canon)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'highlight' ? -1 : 1;
      if (a.kind === 'highlight' && b.kind === 'highlight') {
        return (a.text_position ?? 0) - (b.text_position ?? 0);
      }
      return a.created_at.localeCompare(b.created_at);
    });
}

// ---- plaintext normalization ------------------------------------------------
function normalizePlaintext(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function extractPlaintext(container: Element): string {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let text = '';
  while (walker.nextNode()) text += walker.currentNode.textContent;
  return normalizePlaintext(text);
}

// ---- anchoring --------------------------------------------------------------
type AnchorResult = { range: Range; updated?: Partial<Annotation> } | null;

function anchorHighlight(annotation: Annotation, container: Element): AnchorResult {
  if (!annotation.quote) return null;
  const plain = extractPlaintext(container);
  const quote = annotation.quote;

  const indices: number[] = [];
  let pos = 0;
  while (true) {
    const idx = plain.indexOf(quote, pos);
    if (idx < 0) break;
    indices.push(idx);
    pos = idx + 1;
  }

  if (indices.length === 1) {
    return rangeFromOffset(container, indices[0], quote.length);
  }

  if (indices.length > 1) {
    const scored = indices.map(idx => {
      let score = 0;
      if (annotation.prefix) {
        const before = plain.slice(Math.max(0, idx - annotation.prefix.length), idx);
        if (before.endsWith(annotation.prefix)) score += 10;
        else if (before.includes(annotation.prefix)) score += 5;
      }
      if (annotation.suffix) {
        const after = plain.slice(idx + quote.length, idx + quote.length + annotation.suffix.length);
        if (after.startsWith(annotation.suffix)) score += 10;
        else if (after.includes(annotation.suffix)) score += 5;
      }
      if (annotation.text_position != null) {
        score -= Math.abs(idx - annotation.text_position) * 0.001;
      }
      return { idx, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return rangeFromOffset(container, scored[0].idx, quote.length);
  }

  // zero matches — fuzzy pass
  const fuzzyResult = fuzzyFind(plain, quote);
  if (fuzzyResult) {
    const updated: Partial<Annotation> = {
      quote: plain.slice(fuzzyResult.start, fuzzyResult.start + fuzzyResult.length),
    };
    return { ...rangeFromOffset(container, fuzzyResult.start, fuzzyResult.length)!, updated };
  }

  return null;
}

function fuzzyFind(haystack: string, needle: string): { start: number; length: number } | null {
  if (needle.length < 8) return null;
  const words = needle.split(/\s+/);
  if (words.length < 3) return null;

  let bestScore = 0;
  let bestStart = -1;
  let bestLen = 0;
  const windowSize = Math.ceil(needle.length * 1.5);

  for (let i = 0; i <= haystack.length - Math.floor(needle.length * 0.5); i++) {
    const window = haystack.slice(i, i + windowSize);
    let matched = 0;
    for (const w of words) {
      if (window.includes(w)) matched++;
    }
    const score = matched / words.length;
    if (score > bestScore && score >= 0.7) {
      bestScore = score;
      bestStart = i;
      bestLen = Math.min(windowSize, haystack.length - i);
    }
  }

  if (bestStart < 0) return null;

  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  const sub = haystack.slice(bestStart, bestStart + bestLen);
  const fIdx = sub.indexOf(firstWord);
  const lIdx = sub.lastIndexOf(lastWord);
  if (fIdx >= 0 && lIdx >= 0 && lIdx + lastWord.length > fIdx) {
    return { start: bestStart + fIdx, length: lIdx + lastWord.length - fIdx };
  }

  return { start: bestStart, length: bestLen };
}

function rangeFromOffset(container: Element, offset: number, length: number): AnchorResult {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const raw = node.textContent || '';
    const normalized = raw.normalize('NFC');
    const trimmedParts: { nStart: number; nLen: number; rStart: number; rLen: number }[] = [];

    let ni = 0, ri = 0;
    while (ni < normalized.length) {
      if (/\s/.test(normalized[ni])) {
        let wsEnd = ni + 1;
        let rwsEnd = ri + 1;
        while (wsEnd < normalized.length && /\s/.test(normalized[wsEnd])) { wsEnd++; rwsEnd++; }
        while (rwsEnd < raw.length && /\s/.test(raw[rwsEnd])) rwsEnd++;
        trimmedParts.push({ nStart: ni, nLen: 1, rStart: ri, rLen: rwsEnd - ri });
        ni = wsEnd;
        ri = rwsEnd;
      } else {
        trimmedParts.push({ nStart: ni, nLen: 1, rStart: ri, rLen: 1 });
        ni++;
        ri++;
      }
    }

    const nodeNormLen = trimmedParts.length;
    const prevPos = pos;

    if (pos > 0 || prevPos > 0) {
      // account for whitespace between nodes collapsed to a single space
    }

    for (let i = 0; i < trimmedParts.length; i++) {
      const globalIdx = prevPos + i;
      if (!startNode && globalIdx >= offset) {
        startNode = node;
        startOff = trimmedParts[i].rStart;
      }
      if (globalIdx >= offset + length - 1) {
        endNode = node;
        endOff = trimmedParts[i].rStart + trimmedParts[i].rLen;
        break;
      }
    }
    pos = prevPos + nodeNormLen;
    if (endNode) break;
  }

  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, Math.min(endOff, (endNode.textContent || '').length));
    return { range };
  } catch {
    return null;
  }
}

// ---- DOM highlight rendering ------------------------------------------------
function clearMarks(container: Element) {
  container.querySelectorAll('mark[data-ann-id]').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function renderHighlights(container: Element, sectionKey: string) {
  clearMarks(container);
  const anns = forSection(sectionKey).filter(a => a.kind === 'highlight');
  const currentHash = sectionHashes[resolveKey(sectionKey)];
  const updates: { id: string; changes: Partial<Annotation> }[] = [];

  for (const ann of anns) {
    if (currentHash && ann.section_hash === currentHash && !ann.orphaned) {
      const result = anchorHighlight(ann, container);
      if (result) {
        wrapRange(result.range, ann);
        continue;
      }
    }

    const result = anchorHighlight(ann, container);
    if (result) {
      wrapRange(result.range, ann);
      const changes: Partial<Annotation> = { section_hash: currentHash, orphaned: false };
      if (result.updated) Object.assign(changes, result.updated);
      if (ann.orphaned || ann.section_hash !== currentHash || result.updated) {
        updates.push({ id: ann.id, changes });
      }
    } else {
      if (!ann.orphaned) {
        updates.push({ id: ann.id, changes: { orphaned: true } });
      }
    }
  }

  for (const { id, changes } of updates) {
    const a = annotations[id];
    if (!a) continue;
    Object.assign(a, changes, { updated_at: new Date().toISOString() });
    saveLocal(annotations);
    syncAnnotation(a);
  }
}

function wrapRange(range: Range, ann: Annotation) {
  const color = ann.color || 'yellow';
  const treeWalker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  );

  const textNodes: Text[] = [];
  while (treeWalker.nextNode()) {
    const node = treeWalker.currentNode as Text;
    if (range.intersectsNode(node)) textNodes.push(node);
  }

  if (!textNodes.length) {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      textNodes.push(range.startContainer as Text);
    }
  }

  for (const node of textNodes) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.START_TO_START, nodeRange) > 0) {
      nodeRange.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, nodeRange) < 0) {
      nodeRange.setEnd(range.endContainer, range.endOffset);
    }

    const text = nodeRange.toString();
    if (!text.trim()) continue;

    const mark = document.createElement('mark');
    mark.dataset.annId = ann.id;
    mark.className = `hl hl-${color}`;
    mark.title = ann.body || '';
    try {
      nodeRange.surroundContents(mark);
    } catch {
      const fragment = nodeRange.extractContents();
      mark.appendChild(fragment);
      nodeRange.insertNode(mark);
    }
  }
}

// ---- selection capture ------------------------------------------------------
function getSelectionContext(container: Element): {
  quote: string; prefix: string; suffix: string; text_position: number;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const quote = sel.toString().trim();
  if (!quote || quote.length < 2) return null;

  const plain = extractPlaintext(container);
  const normalizedQuote = normalizePlaintext(quote);
  const idx = plain.indexOf(normalizedQuote);
  if (idx < 0) return null;

  const prefixStart = Math.max(0, idx - 32);
  const prefix = plain.slice(prefixStart, idx);
  const suffixEnd = Math.min(plain.length, idx + normalizedQuote.length + 32);
  const suffix = plain.slice(idx + normalizedQuote.length, suffixEnd);

  return { quote: normalizedQuote, prefix, suffix, text_position: idx };
}

// ---- sync -------------------------------------------------------------------
async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function syncAnnotation(ann: Annotation) {
  if (!sb) return;
  const session = await getSession();
  if (!session) return;
  const { error } = await sb.from('annotations').upsert({
    id: ann.id,
    user_id: session.user.id,
    section_key: ann.section_key,
    kind: ann.kind,
    body: ann.body,
    quote: ann.quote,
    prefix: ann.prefix,
    suffix: ann.suffix,
    text_position: ann.text_position,
    color: ann.color,
    section_hash: ann.section_hash,
    title_snapshot: ann.title_snapshot,
    orphaned: ann.orphaned,
    deleted: ann.deleted,
    created_at: ann.created_at,
    updated_at: ann.updated_at,
  }, { onConflict: 'id' });
  if (error) console.warn('[globway] annotation sync failed:', error.message);
}

async function pullAnnotations() {
  if (!sb) return;
  const session = await getSession();
  if (!session) return;
  const { data, error } = await sb.from('annotations').select('*');
  if (error) { console.warn('[globway] annotation pull failed:', error.message); return; }

  const remote: Record<string, Annotation> = {};
  for (const r of data || []) {
    remote[r.id] = {
      id: r.id,
      section_key: r.section_key,
      kind: r.kind,
      body: r.body,
      quote: r.quote,
      prefix: r.prefix,
      suffix: r.suffix,
      text_position: r.text_position,
      color: r.color,
      section_hash: r.section_hash,
      title_snapshot: r.title_snapshot,
      orphaned: r.orphaned ?? false,
      deleted: r.deleted ?? false,
      created_at: r.created_at,
      updated_at: r.updated_at || new Date(0).toISOString(),
    };
  }

  const upserts: any[] = [];
  for (const [id, local] of Object.entries(annotations)) {
    const rem = remote[id];
    if (!rem || (local.updated_at || '') > (rem.updated_at || '')) {
      remote[id] = local;
      upserts.push({
        id: local.id, user_id: session.user.id,
        section_key: local.section_key, kind: local.kind,
        body: local.body, quote: local.quote, prefix: local.prefix,
        suffix: local.suffix, text_position: local.text_position,
        color: local.color, section_hash: local.section_hash,
        title_snapshot: local.title_snapshot, orphaned: local.orphaned,
        deleted: local.deleted, created_at: local.created_at,
        updated_at: local.updated_at,
      });
    }
  }
  if (upserts.length) {
    await sb.from('annotations').upsert(upserts, { onConflict: 'id' });
  }

  annotations = remote;
  saveLocal(annotations);
  // A pull can land after the section already rendered (it's async and may be
  // triggered by a late sign-in / coming back online). Re-render so freshly
  // pulled annotations actually appear, mirroring pullRemote()'s applyAll().
  renderCurrentSection();
}

// Re-render the section currently on screen, if any. No-op before a section page
// has initialised (currentSectionKey is null on the home page / decks).
function renderCurrentSection() {
  if (!currentContainer || !currentSectionKey || !notesPanel) return;
  renderHighlights(currentContainer, currentSectionKey);
  renderNotesPanel(currentSectionKey);
}

// ---- CRUD -------------------------------------------------------------------
function generateId(): string {
  return crypto.randomUUID();
}

function createAnnotation(fields: {
  section_key: string;
  kind: 'note' | 'highlight';
  body?: string | null;
  quote?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  text_position?: number | null;
  color?: string | null;
  title_snapshot?: string | null;
}): Annotation {
  const now = new Date().toISOString();
  const ann: Annotation = {
    id: generateId(),
    section_key: fields.section_key,
    kind: fields.kind,
    body: fields.body ?? null,
    quote: fields.quote ?? null,
    prefix: fields.prefix ?? null,
    suffix: fields.suffix ?? null,
    text_position: fields.text_position ?? null,
    color: fields.color ?? null,
    section_hash: sectionHashes[resolveKey(fields.section_key)] ?? null,
    title_snapshot: fields.title_snapshot ?? null,
    orphaned: false,
    deleted: false,
    created_at: now,
    updated_at: now,
  };
  annotations[ann.id] = ann;
  saveLocal(annotations);
  syncAnnotation(ann);
  return ann;
}

function updateAnnotation(id: string, changes: Partial<Pick<Annotation, 'body' | 'color' | 'quote' | 'prefix' | 'suffix' | 'text_position'>>) {
  const ann = annotations[id];
  if (!ann) return;
  Object.assign(ann, changes, { updated_at: new Date().toISOString() });
  saveLocal(annotations);
  syncAnnotation(ann);
}

function deleteAnnotation(id: string) {
  const ann = annotations[id];
  if (!ann) return;
  ann.deleted = true;
  ann.updated_at = new Date().toISOString();
  saveLocal(annotations);
  syncAnnotation(ann);
}

// ---- UI: selection popover --------------------------------------------------
let popover: HTMLElement | null = null;
let currentContainer: Element | null = null;
let currentSectionKey: string | null = null;
let currentTitleSnapshot: string | null = null;

function removePopover() {
  popover?.remove();
  popover = null;
}

function showSelectionPopover(x: number, y: number, context: ReturnType<typeof getSelectionContext>) {
  if (!context) return;
  removePopover();

  popover = document.createElement('div');
  popover.className = 'ann-popover';
  popover.innerHTML =
    `<button type="button" class="ann-pop-btn" data-pop-action="highlight" data-color="yellow" title="Highlight">` +
      `<span class="ann-pop-swatch hl-yellow"></span></button>` +
    `<button type="button" class="ann-pop-btn" data-pop-action="highlight" data-color="green" title="Highlight green">` +
      `<span class="ann-pop-swatch hl-green"></span></button>` +
    `<button type="button" class="ann-pop-btn" data-pop-action="highlight" data-color="blue" title="Highlight blue">` +
      `<span class="ann-pop-swatch hl-blue"></span></button>` +
    `<button type="button" class="ann-pop-btn" data-pop-action="highlight" data-color="pink" title="Highlight pink">` +
      `<span class="ann-pop-swatch hl-pink"></span></button>` +
    `<button type="button" class="ann-pop-btn ann-pop-note" data-pop-action="highlight-note" title="Highlight + note">` +
      `<span aria-hidden="true">📝</span></button>`;

  popover.style.left = `${x}px`;
  popover.style.top = `${y}px`;
  document.body.appendChild(popover);

  const rect = popover.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    popover.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.top < 0) {
    popover.style.top = `${y + 24}px`;
  }

  popover.addEventListener('mousedown', e => e.preventDefault());
  popover.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-pop-action]');
    if (!btn || !currentContainer || !currentSectionKey) return;
    const action = btn.dataset.popAction;
    const color = btn.dataset.color || 'yellow';

    if (action === 'highlight') {
      createAnnotation({
        section_key: currentSectionKey,
        kind: 'highlight',
        quote: context.quote,
        prefix: context.prefix,
        suffix: context.suffix,
        text_position: context.text_position,
        color,
        title_snapshot: currentTitleSnapshot,
      });
      window.getSelection()?.removeAllRanges();
      removePopover();
      renderHighlights(currentContainer, currentSectionKey);
      renderNotesPanel(currentSectionKey);
    } else if (action === 'highlight-note') {
      const ann = createAnnotation({
        section_key: currentSectionKey,
        kind: 'highlight',
        quote: context.quote,
        prefix: context.prefix,
        suffix: context.suffix,
        text_position: context.text_position,
        color: 'yellow',
        title_snapshot: currentTitleSnapshot,
      });
      window.getSelection()?.removeAllRanges();
      removePopover();
      renderHighlights(currentContainer, currentSectionKey);
      renderNotesPanel(currentSectionKey);
      openNoteEditor(ann.id);
    }
  });
}

function onSelectionChange() {
  if (!currentContainer) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    removePopover();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!currentContainer.contains(range.commonAncestorContainer)) {
    removePopover();
    return;
  }
  const context = getSelectionContext(currentContainer);
  if (!context) { removePopover(); return; }

  const rect = range.getBoundingClientRect();
  const x = rect.left + window.scrollX + rect.width / 2 - 70;
  const y = rect.top + window.scrollY - 44;
  showSelectionPopover(x, y, context);
}

// ---- UI: notes panel --------------------------------------------------------
let notesPanel: HTMLElement | null = null;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderNotesPanel(sectionKey: string) {
  if (!notesPanel) return;
  const anns = forSection(sectionKey);
  const list = notesPanel.querySelector<HTMLElement>('.ann-list');
  if (!list) return;

  const count = notesPanel.querySelector<HTMLElement>('.ann-count');
  if (count) count.textContent = anns.length ? `${anns.length}` : '';

  if (!anns.length) {
    list.innerHTML = '<p class="ann-empty">No notes yet. Select text to highlight, or add a page note below.</p>';
    return;
  }

  list.innerHTML = anns.map(a => {
    const isHighlight = a.kind === 'highlight';
    const orphanClass = a.orphaned ? ' ann-orphan' : '';
    const colorClass = a.color ? ` hl-${a.color}` : '';
    const quote = a.quote ? `<div class="ann-quote${colorClass}">"${escapeHtml(a.quote.length > 120 ? a.quote.slice(0, 117) + '…' : a.quote)}"</div>` : '';
    const body = a.body ? `<div class="ann-body">${escapeHtml(a.body)}</div>` : '';
    const orphanLabel = a.orphaned ? '<span class="ann-orphan-label">detached</span>' : '';
    const kindIcon = isHighlight ? '' : '<span class="ann-kind-icon" aria-hidden="true">📄</span> ';

    return `<div class="ann-item${orphanClass}" data-ann-item="${a.id}">` +
      `<div class="ann-item-head">` +
        `${kindIcon}${orphanLabel}` +
        `<button type="button" class="ann-edit-btn" data-ann-edit="${a.id}" title="Edit">✏️</button>` +
        `<button type="button" class="ann-del-btn" data-ann-delete="${a.id}" title="Delete">×</button>` +
      `</div>` +
      quote + body +
    `</div>`;
  }).join('');
}

function openNoteEditor(annId: string) {
  const ann = annotations[annId];
  if (!ann || ann.deleted) return;

  const item = document.querySelector<HTMLElement>(`[data-ann-item="${annId}"]`);
  if (!item) return;

  const existing = item.querySelector('.ann-editor');
  if (existing) { (existing.querySelector('textarea') as HTMLTextAreaElement)?.focus(); return; }

  const editor = document.createElement('div');
  editor.className = 'ann-editor';
  const textarea = document.createElement('textarea');
  textarea.className = 'ann-textarea';
  textarea.value = ann.body || '';
  textarea.placeholder = 'Add a note…';
  textarea.rows = 3;

  const actions = document.createElement('div');
  actions.className = 'ann-editor-actions';
  actions.innerHTML =
    `<button type="button" class="ann-save-btn" data-ann-save="${annId}">Save</button>` +
    `<button type="button" class="ann-cancel-btn" data-ann-cancel="${annId}">Cancel</button>`;

  editor.appendChild(textarea);
  editor.appendChild(actions);
  item.appendChild(editor);
  textarea.focus();
}

// ---- UI: mark click handler -------------------------------------------------
function onMarkClick(e: MouseEvent) {
  const mark = (e.target as HTMLElement).closest<HTMLElement>('mark[data-ann-id]');
  if (!mark) return;
  const id = mark.dataset.annId!;
  const ann = annotations[id];
  if (!ann) return;

  if (notesPanel) {
    const panel = notesPanel.closest<HTMLElement>('.ann-panel');
    if (panel) panel.open = true;
  }

  openNoteEditor(id);

  const item = document.querySelector<HTMLElement>(`[data-ann-item="${id}"]`);
  item?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- init / teardown --------------------------------------------------------
let teardown: (() => void) | null = null;

export function initAnnotations(signal: AbortSignal) {
  const host = document.querySelector<HTMLElement>('[data-section-key]');
  if (!host) return;

  currentSectionKey = host.dataset.sectionKey!;
  currentTitleSnapshot = host.querySelector('h1')?.textContent?.trim() || currentSectionKey;

  const contentEl = host.querySelector<HTMLElement>(':scope > div:not(.section-head):not([hidden])') || host;
  currentContainer = contentEl;

  // inject notes panel
  const panelHtml =
    `<details class="ann-panel" open>` +
      `<summary class="ann-panel-toggle">Notes <span class="ann-count"></span></summary>` +
      `<div class="ann-list"></div>` +
      `<div class="ann-add-row">` +
        `<button type="button" class="ann-add-note-btn" data-action="add-page-note">+ Page note</button>` +
      `</div>` +
    `</details>`;

  const pager = host.querySelector('.pager');
  const panelWrapper = document.createElement('div');
  panelWrapper.className = 'ann-panel-wrap';
  panelWrapper.innerHTML = panelHtml;
  if (pager) host.insertBefore(panelWrapper, pager);
  else host.appendChild(panelWrapper);
  notesPanel = panelWrapper.querySelector('.ann-panel');

  renderHighlights(currentContainer, currentSectionKey);
  renderNotesPanel(currentSectionKey);

  // selection popover
  const selHandler = () => onSelectionChange();
  document.addEventListener('selectionchange', selHandler, { signal });

  // click on marks
  contentEl.addEventListener('click', onMarkClick as EventListener, { signal });

  // panel interactions (delegated)
  panelWrapper.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const editBtn = target.closest<HTMLElement>('[data-ann-edit]');
    if (editBtn) { openNoteEditor(editBtn.dataset.annEdit!); return; }

    const delBtn = target.closest<HTMLElement>('[data-ann-delete]');
    if (delBtn) {
      deleteAnnotation(delBtn.dataset.annDelete!);
      if (currentContainer && currentSectionKey) {
        renderHighlights(currentContainer, currentSectionKey);
        renderNotesPanel(currentSectionKey);
      }
      return;
    }

    const saveBtn = target.closest<HTMLElement>('[data-ann-save]');
    if (saveBtn) {
      const id = saveBtn.dataset.annSave!;
      const textarea = saveBtn.closest('.ann-editor')?.querySelector('textarea');
      if (textarea) {
        updateAnnotation(id, { body: textarea.value || null });
        if (currentContainer && currentSectionKey) {
          renderHighlights(currentContainer, currentSectionKey);
          renderNotesPanel(currentSectionKey);
        }
      }
      return;
    }

    const cancelBtn = target.closest<HTMLElement>('[data-ann-cancel]');
    if (cancelBtn) {
      cancelBtn.closest('.ann-editor')?.remove();
      return;
    }

    if (target.closest('[data-action="add-page-note"]')) {
      if (!currentSectionKey) return;
      const ann = createAnnotation({
        section_key: currentSectionKey,
        kind: 'note',
        title_snapshot: currentTitleSnapshot,
      });
      renderNotesPanel(currentSectionKey);
      openNoteEditor(ann.id);
      return;
    }
  }, { signal });

  // dismiss popover on click outside
  document.addEventListener('mousedown', (e: MouseEvent) => {
    if (popover && !popover.contains(e.target as Node)) removePopover();
  }, { signal });

  signal.addEventListener('abort', () => {
    removePopover();
    panelWrapper.remove();
    if (currentContainer) clearMarks(currentContainer);
    currentContainer = null;
    currentSectionKey = null;
    notesPanel = null;
  });
}

export { pullAnnotations };
