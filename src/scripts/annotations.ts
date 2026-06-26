import { getSupabase } from '../lib/supabase';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import aliasData from '../data/aliases.json';
import hashData from '../data/hashes.json';

const aliasToCanonical: Record<string, string> = aliasData.aliasToCanonical;
const sectionHashes: Record<string, string> = hashData as Record<string, string>;

type Annotation = {
  id: string;
  section_key: string;
  kind: 'note' | 'highlight' | 'para';
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

// ---- note drafts (local-only, never synced) --------------------------------
// In-progress note text is autosaved here on every keystroke so closing the tab
// / navigating / reloading mid-write never loses work. Kept in a *separate*
// localStorage key from committed annotations (and out of Supabase): a draft is
// unsaved-by-definition, and we don't want half-written notes racing across
// devices. A draft is cleared once its note is saved, cancelled, or deleted.
const DRAFT_KEY = 'globway:annotation-drafts';
type Draft = { body: string; updated_at: string };
let drafts: Record<string, Draft> = (() => {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
})();
function saveDrafts() { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); }
function getDraft(id: string): string | null {
  return Object.prototype.hasOwnProperty.call(drafts, id) ? drafts[id].body : null;
}
function setDraft(id: string, body: string) {
  drafts[id] = { body, updated_at: new Date().toISOString() };
  saveDrafts();
}
function clearDraft(id: string) {
  if (Object.prototype.hasOwnProperty.call(drafts, id)) { delete drafts[id]; saveDrafts(); }
}
// A note carries unsaved work iff a draft exists that differs from its committed
// body (an empty draft on an empty body is nothing; a draft equal to the saved
// text isn't "unsaved").
function hasDraft(n: Annotation): boolean {
  const d = getDraft(n.id);
  return d != null && d !== (n.body || '');
}
// What to *show* for a note: the draft if there's unsaved work, else committed.
function displayBody(n: Annotation): string | null {
  return hasDraft(n) ? getDraft(n.id) : n.body;
}

// noteId -> the DOM element an anchored note points at (first <mark> for a
// highlight, the block element for a paragraph note). Rebuilt every render; the
// rail reads these to position cards beside their targets.
const anchorEl: Record<string, HTMLElement> = {};

function resolveKey(key: string): string {
  return aliasToCanonical[key] || key;
}

function forSection(key: string): Annotation[] {
  const canon = resolveKey(key);
  return Object.values(annotations)
    .filter(a => !a.deleted && resolveKey(a.section_key) === canon);
}

// Anchored notes: highlights that carry a comment + paragraph notes. Ordered by
// position in the text (text_position), so the rail builds top-to-bottom.
function anchoredFor(key: string): Annotation[] {
  return forSection(key)
    .filter(a => (a.kind === 'para' || (a.kind === 'highlight' && a.body !== null)) && !a.orphaned)
    .sort((a, b) => (a.text_position ?? 0) - (b.text_position ?? 0));
}

// Page panel contents: unanchored page notes + any orphaned anchored note (so a
// note whose text vanished is still readable, never lost). Oldest first.
function pageFor(key: string): Annotation[] {
  return forSection(key)
    .filter(a => a.kind === 'note' || a.orphaned)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ============================================================================
// ANCHORING — design notes & tradeoffs
// ----------------------------------------------------------------------------
// An annotation is stored as text, not DOM coordinates, so it can survive the
// section being re-rendered or lightly edited between versions. The persisted
// fields are: quote (the selected text), prefix/suffix (≤32 chars of normalized
// context on each side) and text_position (a normalized-plaintext offset). On
// every render we re-derive a live DOM Range from those.
//
// Why a single normalized coordinate space (buildPlainMap):
//   Everything — searching for the quote, computing the selection offset, and
//   mapping an offset back to a DOM Range — must agree on what "offset N" means.
//   The original code had TWO disagreeing notions of that: extractPlaintext
//   collapsed whitespace across the whole container and trimmed, while
//   rangeFromOffset re-collapsed each text node independently and never trimmed.
//   They drifted by one char per inter-node/leading space, so highlights landed
//   a few characters off. buildPlainMap is now the one source of truth: a single
//   walk producing the plaintext AND a parallel pos[] mapping each char back to
//   (node, rawOffset). extractPlaintext and rangeFromOffset both derive from it,
//   so the two directions are exact inverses by construction.
//
// Why we measure the real selection offset (normalizedOffsetAt) instead of
// plain.indexOf(quote): indexOf always returns the FIRST occurrence, so any
// repeated word ("with", "the", …) anchored to the wrong copy. We instead count
// the normalized characters before the selection's start boundary.
//
// Tradeoffs / known limits accepted here:
//   - NFC length drift: we assume non-whitespace normalizes 1:1 with the raw DOM
//     text (so a raw offset == a normalized offset for non-space chars). True for
//     this content; a precomposed-vs-decomposed combining sequence split across
//     nodes could misalign. The validate-and-fallback guard in
//     anchorContextFromRange / getBlockContext catches gross mismatches.
//   - Disambiguation is prefix/suffix-dominant (±10 each) with text_position as a
//     near-weightless ±0.001 tiebreak. So position is advisory only and never the
//     thing that picks an occurrence — which is also why the old wrong-position
//     data never corrupted recovery (it was only ever a tiebreak, never a DOM
//     offset).
// ============================================================================

// ---- plaintext normalization ------------------------------------------------
function normalizePlaintext(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// The single source of truth for plaintext<->DOM coordinates. Walks the text
// nodes once and produces (a) the normalized plaintext and (b) a parallel array
// where pos[k] is the DOM position (node + raw offset) of plain[k]. Crucially the
// whitespace collapse and leading/trailing trim happen *across the whole
// container* (not per node), so plaintext offsets map back to the DOM exactly —
// previously rangeFromOffset re-collapsed each node on its own and drifted out of
// sync with extractPlaintext by one char per inter-node space / leading space,
// which made highlights render a few characters off (or on the wrong word).
type DomPos = { node: Text; offset: number };
function buildPlainMap(container: Element): { plain: string; pos: DomPos[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let plain = '';
  const pos: DomPos[] = [];
  let prevWasSpace = true; // seeded true so leading whitespace is trimmed
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tn = node as Text;
    const raw = tn.textContent || '';
    const norm = raw.normalize('NFC');
    let ri = 0; // raw index, advanced in parallel (non-ws assumed 1:1 with NFC)
    for (let ni = 0; ni < norm.length; ) {
      if (/\s/.test(norm[ni])) {
        const rawStart = ri;
        ni++; ri++;
        while (ni < norm.length && /\s/.test(norm[ni])) { ni++; ri++; }
        while (ri < raw.length && /\s/.test(raw[ri])) ri++;
        if (!prevWasSpace) { plain += ' '; pos.push({ node: tn, offset: rawStart }); prevWasSpace = true; }
      } else {
        plain += norm[ni];
        pos.push({ node: tn, offset: ri });
        ni++; ri++;
        prevWasSpace = false;
      }
    }
  }
  while (plain.endsWith(' ')) { plain = plain.slice(0, -1); pos.pop(); }
  return { plain, pos };
}

function extractPlaintext(container: Element): string {
  return buildPlainMap(container).plain;
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
  if (length <= 0) return null;
  const { pos } = buildPlainMap(container);
  if (offset < 0 || offset >= pos.length) return null;
  const start = pos[offset];
  const last = pos[Math.min(offset + length - 1, pos.length - 1)];
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(last.node, Math.min(last.offset + 1, (last.node.textContent || '').length));
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

  // One path for every highlight regardless of whether the hash still matches:
  // anchorHighlight already handles exact/scored/fuzzy internally, and routing all
  // of them through here means healing runs even on an unchanged section (which is
  // exactly where legacy first-occurrence context needs correcting).
  for (const ann of anns) {
    delete anchorEl[ann.id];
    const result = anchorHighlight(ann, container);
    if (result) {
      // Heal stored context toward where it actually resolved — computed *before*
      // wrapRange mutates the DOM and invalidates result.range.
      const ctx = anchorContextFromRange(container, result.range);
      const mark = wrapRange(result.range, ann);
      if (mark) anchorEl[ann.id] = mark;
      const changes: Partial<Annotation> = {};
      if (currentHash && ann.section_hash !== currentHash) changes.section_hash = currentHash;
      if (ann.orphaned) changes.orphaned = false;
      if (result.updated) Object.assign(changes, result.updated);
      healAnchor(ann, ctx, changes);
      if (Object.keys(changes).length) updates.push({ id: ann.id, changes });
    } else if (!ann.orphaned) {
      updates.push({ id: ann.id, changes: { orphaned: true } });
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

function wrapRange(range: Range, ann: Annotation): HTMLElement | null {
  let firstMark: HTMLElement | null = null;
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
    // Single highlight style (no per-color classes); a comment is shown in the
    // rail card, not as a native tooltip.
    mark.className = 'hl';
    try {
      nodeRange.surroundContents(mark);
    } catch {
      const fragment = nodeRange.extractContents();
      mark.appendChild(fragment);
      nodeRange.insertNode(mark);
    }
    if (!firstMark) firstMark = mark;
  }
  return firstMark;
}

// ---- paragraph notes: block tagging, anchoring, outlines --------------------
const BLOCK_TAGS = /^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/;

// Tag the eligible blocks (top-level p/hN/blockquote/pre + first-level list
// items) with a stable-per-render id, so paragraph hover/click can identify the
// block under the pointer. Anchoring itself is by text (below), not this id.
function tagBlocks(container: Element) {
  let i = 0;
  const tag = (el: Element) => {
    if (!(el as HTMLElement).dataset.blockId) (el as HTMLElement).dataset.blockId = 'b' + (++i);
  };
  Array.from(container.children).forEach(child => {
    const t = child.tagName;
    if (t === 'UL' || t === 'OL') Array.from(child.children).forEach(tag);
    else if (BLOCK_TAGS.test(t)) tag(child);
  });
}

function blockOf(node: Node | null, container: Element): HTMLElement | null {
  let el: HTMLElement | null = node && node.nodeType === Node.TEXT_NODE
    ? node.parentElement : (node as HTMLElement | null);
  while (el && el !== container) {
    if (el.dataset && el.dataset.blockId) return el;
    el = el.parentElement;
  }
  return null;
}

// The tagged block a paragraph note belongs to. A para quote is a whole block's
// text, so it can start on the inter-block whitespace (a text node parented by
// the container, not a block) — hence we check both range ends and, failing
// that, the block the range intersects.
function blockForRange(range: Range, container: Element): HTMLElement | null {
  const direct = blockOf(range.startContainer, container) || blockOf(range.endContainer, container);
  if (direct) return direct;
  for (const b of Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'))) {
    if (range.intersectsNode(b)) return b;
  }
  return null;
}

// Fast exact-text path: the block whose normalized text equals the stored quote.
function blockForQuote(container: Element, quote: string | null): HTMLElement | null {
  if (!quote) return null;
  for (const b of Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'))) {
    if (normalizePlaintext(b.textContent || '') === quote) return b;
  }
  return null;
}

function clearParaOutlines(container: Element) {
  container.querySelectorAll<HTMLElement>('.para-anchor').forEach(el => {
    el.classList.remove('para-anchor', 'is-active');
  });
}

// Anchor each paragraph note (quote = the block's normalized text) the same
// robust way highlights anchor, then outline the enclosing block. Reuses the
// quote/context/position self-healing, so para notes survive Mark's edits.
function renderParas(container: Element, sectionKey: string) {
  clearParaOutlines(container);
  const anns = forSection(sectionKey).filter(a => a.kind === 'para');
  const currentHash = sectionHashes[resolveKey(sectionKey)];
  const updates: { id: string; changes: Partial<Annotation> }[] = [];

  for (const ann of anns) {
    delete anchorEl[ann.id];
    let block = blockForQuote(container, ann.quote);
    let result: AnchorResult = null;
    if (!block) {
      result = anchorHighlight(ann, container);     // self-healing fuzzy fallback
      block = result ? blockForRange(result.range, container) : null;
    }
    if (block) {
      block.classList.add('para-anchor');
      anchorEl[ann.id] = block;
      const changes: Partial<Annotation> = { section_hash: currentHash, orphaned: false };
      if (result && result.updated) Object.assign(changes, result.updated);
      const healed = healAnchor(ann, getBlockContext(container, block), changes, true);
      if (ann.orphaned || ann.section_hash !== currentHash || (result && result.updated) || healed) {
        updates.push({ id: ann.id, changes });
      }
    } else if (!ann.orphaned) {
      updates.push({ id: ann.id, changes: { orphaned: true } });
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

// Normalized-plaintext offset of a DOM boundary (endNode/endOffset) within the
// container — i.e. how many characters of extractPlaintext() precede that point.
// This is the inverse of rangeFromOffset and the thing that makes anchoring land
// on the occurrence the user actually picked rather than the first copy of a
// repeated word. We measure the real text before the boundary and collapse it
// the same way extractPlaintext does (NFC + whitespace-run collapse + leading
// trim) so the two coordinate systems line up.
function normalizedOffsetAt(container: Element, endNode: Node, endOffset: number): number {
  const pre = document.createRange();
  pre.selectNodeContents(container);
  try { pre.setEnd(endNode, endOffset); } catch { return 0; }
  return pre.toString().normalize('NFC').replace(/\s+/g, ' ').replace(/^ /, '').length;
}

type AnchorContext = { quote: string; prefix: string; suffix: string; text_position: number };

// Recompute the stored anchor fields from a resolved DOM range. Shared by
// selection capture and by the heal-on-re-anchor pass (which rewrites legacy
// first-occurrence context toward where a note actually resolved, so old data
// self-corrects over time). knownQuote lets the caller supply the trimmed
// selection string instead of re-deriving it from the range.
function anchorContextFromRange(container: Element, range: Range, knownQuote?: string): AnchorContext | null {
  const quote = normalizePlaintext(knownQuote ?? range.toString());
  if (!quote) return null;
  const plain = extractPlaintext(container);
  let idx = normalizedOffsetAt(container, range.startContainer, range.startOffset);
  if (plain.slice(idx, idx + quote.length) !== quote) {
    const near = plain.indexOf(quote, Math.max(0, idx - 2));
    idx = near >= 0 ? near : plain.indexOf(quote);
  }
  if (idx < 0) return null;
  const prefix = plain.slice(Math.max(0, idx - 32), idx);
  const suffix = plain.slice(idx + quote.length, Math.min(plain.length, idx + quote.length + 32));
  return { quote, prefix, suffix, text_position: idx };
}

// Heal-on-re-anchor: each time a note successfully resolves, rewrite its stored
// context to match where it actually landed, so anchors stay fresh as content
// evolves and legacy/stale data self-corrects over time.
//
// What it can and can't do:
//   - Helps a UNIQUE-quote note whose context went stale (edited surroundings,
//     or legacy bad data): the quote still resolves it unambiguously, then we
//     refresh prefix/suffix/position so the NEXT recovery is sturdier.
//   - Helps paragraph notes track edits: their quote IS the block text, so we
//     heal the quote too (healQuote) — after Mark tweaks a paragraph the stored
//     quote follows it and the fast exact-block path keeps working.
//   - Cannot resurrect a REPEATED-word note whose disambiguating context is gone:
//     with nothing to tell the copies apart it resolves to (and then heals
//     toward) the first occurrence. No ground truth exists to do better; we
//     accept "stably wrong" over "randomly wrong".
//
// Cost: an extra plaintext walk per resolved note per render. Annotation counts
// per section are small, so this is fine; the guard `if (Object.keys(changes))`
// in the callers means healthy notes write/sync nothing (no churn).
//
// Returns whether anything changed (so callers know to persist). quote is only
// healed for paragraph notes; for highlights the quote is authoritative.
function healAnchor(ann: Annotation, ctx: AnchorContext | null, changes: Partial<Annotation>, healQuote = false): boolean {
  if (!ctx) return false;
  let changed = false;
  if (healQuote && ctx.quote !== ann.quote) { changes.quote = ctx.quote; changed = true; }
  if (ctx.prefix !== ann.prefix) { changes.prefix = ctx.prefix; changed = true; }
  if (ctx.suffix !== ann.suffix) { changes.suffix = ctx.suffix; changed = true; }
  if (ctx.text_position !== ann.text_position) { changes.text_position = ctx.text_position; changed = true; }
  return changed;
}

// Whole-block selector context, mirroring getSelectionContext but for a tagged
// block element — used when creating a paragraph note from the ¶ button.
function getBlockContext(container: Element, block: Element): {
  quote: string; prefix: string; suffix: string; text_position: number;
} | null {
  const quote = normalizePlaintext(block.textContent || '');
  if (!quote) return null;
  const plain = extractPlaintext(container);
  // Offset of *this* block, not the first block whose text happens to match.
  let idx = normalizedOffsetAt(container, block.parentNode || container,
    Array.prototype.indexOf.call((block.parentNode || container).childNodes, block));
  if (plain.slice(idx, idx + quote.length) !== quote) {
    const near = plain.indexOf(quote, Math.max(0, idx - 2));
    idx = near >= 0 ? near : plain.indexOf(quote);
  }
  if (idx < 0) return null;
  const prefix = plain.slice(Math.max(0, idx - 32), idx);
  const suffix = plain.slice(idx + quote.length, Math.min(plain.length, idx + quote.length + 32));
  return { quote, prefix, suffix, text_position: idx };
}

// ---- minimal markdown (bold/italic/code/link), HTML-escaped first -----------
// Note bodies render as full GitHub-flavored Markdown (tables, task lists,
// strikethrough, autolinks, fenced code, headings, …) via `marked`, then run
// through DOMPurify. We don't need the hand-rolled subset anymore.
//
// Security: notes sync per-user through Supabase, but treat the rendered HTML as
// untrusted anyway (a synced row, an imported note, or a future "shared note"
// could carry a hostile payload). marked emits raw HTML for any HTML the author
// typed, so DOMPurify is the actual guard — it drops <script>, inline event
// handlers, javascript:/data: URLs, etc. The afterSanitizeAttributes hook then
// forces every surviving link to open safely in a new tab.
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function md(src: string | null): string {
  const s = src == null ? '' : String(src);
  if (!s.trim()) return '';
  const html = marked.parse(s, { async: false }) as string;
  return DOMPurify.sanitize(html);
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

  // The real selection offset (not plain.indexOf(quote), which always snaps to
  // the first occurrence and anchors repeated words like "with" to the wrong copy).
  return anchorContextFromRange(container, range, quote);
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
  if (!currentContainer || !currentSectionKey || !railEl) return;
  refresh();
}

// ---- CRUD -------------------------------------------------------------------
function generateId(): string {
  return crypto.randomUUID();
}

function createAnnotation(fields: {
  section_key: string;
  kind: 'note' | 'highlight' | 'para';
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

// ===========================================================================
// UI — anchored side rail
//
// The article body is React-/framework-free static HTML we own imperatively.
// Highlights live as <mark>s inside it; paragraph notes outline their block.
// The rail (right column on desktop) holds a fixed page-notes panel plus
// position-tracking cards that align to each anchored note's target, collapsing
// to preview pills and summarising off-screen notes with ↑/↓ counters. On
// narrow screens the rail stacks under the body and an activated note expands
// inline beneath its target. Ported from the Claude-design mockup.
// ===========================================================================

let currentContainer: Element | null = null;   // = bodyEl, the annotatable article
let currentSectionKey: string | null = null;
let currentTitleSnapshot: string | null = null;

let bodyEl: HTMLElement | null = null;
let rowEl: HTMLElement | null = null;          // .annot-row (positioning context)
let railEl: HTMLElement | null = null;
let pagePanelEl: HTMLElement | null = null;
let pageListEl: HTMLElement | null = null;
let aboveEl: HTMLElement | null = null;
let belowEl: HTMLElement | null = null;

const cardRefs: Record<string, HTMLElement> = {};  // noteId -> rail card / wrapper

let activeId: string | null = null;
let editingId: string | null = null;
let isNew = false;            // editing a just-created note → Cancel discards it
let pageCollapsed = false;
let narrow = false;

let popupEl: HTMLElement | null = null;        // selection popup (Note / Highlight)
let markMenuEl: HTMLElement | null = null;     // bare-mark menu (Note / Remove)
let paraFabEl: HTMLElement | null = null;      // ¶ block-hover button
let paraFabBlock: HTMLElement | null = null;

let pendingScroll: string | null = null;
let pendingFocus: string | null = null;
let scrollRaf = 0;
let mq: MediaQueryList | null = null;
let hideFabTimer: ReturnType<typeof setTimeout> | null = null;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---- text helpers -----------------------------------------------------------
function previewText(n: Annotation): string {
  const first = (displayBody(n) || '').split('\n')[0].replace(/[*`#>[\]]/g, '').trim();
  return first || (n.kind === 'para' ? 'Add a note on this paragraph…' : 'Add a note…');
}
function anchorLabel(n: Annotation): string {
  const q = (n.quote || '').replace(/\s+/g, ' ').trim();
  const short = q.length > 90 ? q.slice(0, 90) + '…' : q;
  return n.kind === 'para' ? '¶ ' + short : '“' + short + '”';
}

// ---- render: rail contents --------------------------------------------------
function refresh() {
  if (!currentContainer || !currentSectionKey || !railEl) return;
  renderHighlights(currentContainer, currentSectionKey);
  renderParas(currentContainer, currentSectionKey);
  renderRail();
  applyActiveStates();
  layout();
  if (pendingFocus) { const id = pendingFocus; pendingFocus = null; focusEditor(id); }
  if (pendingScroll) {
    const id = pendingScroll; pendingScroll = null;
    requestAnimationFrame(() => ensureVisible(id));
  }
}

function buildCard(n: Annotation): HTMLElement {
  const card = document.createElement('div');
  const anchored = (n.kind === 'para' || (n.kind === 'highlight' && n.body !== null)) && !n.orphaned;
  const active = activeId === n.id;
  const editing = editingId === n.id;
  const draft = hasDraft(n);
  card.className = 'ann-card'
    + (n.kind === 'para' ? ' is-para' : n.kind === 'highlight' ? ' is-hl' : ' is-page')
    + (anchored && active ? ' is-active' : '')
    + (editing ? ' is-editing' : '')
    + (draft ? ' has-draft' : '');
  card.dataset.cardId = n.id;

  const label = anchored ? `<div class="ann-anchor-label">${escapeHtml(anchorLabel(n))}</div>` : '';

  if (editing) {
    // Seed the field from the draft if there's unsaved work, else the saved body.
    const seed = draft ? (getDraft(n.id) || '') : (n.body || '');
    card.innerHTML = label
      + `<textarea class="ann-textarea" data-editor="${n.id}" placeholder="Write a note… Markdown supported">${escapeHtml(seed)}</textarea>`
      + `<div class="ann-md-hint">Full Markdown — headings, lists, tables, \`code\`, [links](url) · ⌘/Ctrl+Enter to save · Esc to cancel`
      + `<span class="ann-draft-flag" data-draft-flag="${n.id}"${draft ? '' : ' hidden'}> · draft autosaved</span></div>`
      + `<div class="ann-editor-actions"><button type="button" class="ann-save" data-save="${n.id}">Save</button>`
      + `<button type="button" class="ann-cancel" data-cancel="${n.id}">Cancel</button></div>`;
    return card;
  }

  const orphan = n.orphaned
    ? `<div class="ann-detached">detached${n.quote ? ` · “${escapeHtml(n.quote.length > 80 ? n.quote.slice(0, 80) + '…' : n.quote)}”` : ''}</div>`
    : '';
  const badge = draft ? `<span class="ann-draft-badge">unsaved draft</span>` : '';
  const tools = `<div class="ann-card-tools">`
    + `<button type="button" class="ann-icon-btn" data-edit="${n.id}" title="Edit">✎</button>`
    + `<button type="button" class="ann-icon-btn ann-del" data-delete="${n.id}" title="Delete">×</button></div>`;
  card.innerHTML = label + orphan + badge
    + `<div class="ann-card-row"><div class="ann-md">${md(displayBody(n))}</div>${tools}</div>`;
  return card;
}

function buildPill(n: Annotation): HTMLElement {
  const pill = document.createElement('div');
  pill.className = 'ann-pill' + (n.kind === 'para' ? ' is-para' : ' is-hl') + (hasDraft(n) ? ' has-draft' : '');
  pill.dataset.activate = n.id;
  const glyph = n.kind === 'para' ? '¶' : '';
  pill.innerHTML = `<span class="ann-pill-dot">${glyph}</span>`
    + `<span class="ann-pill-text">${escapeHtml(previewText(n))}</span>`
    + (hasDraft(n) ? `<span class="ann-draft-badge">draft</span>` : '');
  return pill;
}

function renderRail() {
  if (!railEl || !currentSectionKey) return;
  railEl.innerHTML = '';
  for (const k in cardRefs) delete cardRefs[k];

  // fixed page-notes panel
  const pageNotes = pageFor(currentSectionKey);
  const panel = document.createElement('div');
  panel.className = 'ann-page-panel' + (pageCollapsed ? '' : ' is-open');
  panel.innerHTML =
    `<div class="ann-page-head" data-toggle-page>`
    + `<span class="ann-page-title"><span class="ann-chevron">▸</span> PAGE NOTES${pageNotes.length ? ` · ${pageNotes.length}` : ''}</span>`
    + `<button type="button" class="ann-icon-btn" data-add-page title="Add page note">+</button></div>`
    + `<div class="ann-page-list"></div>`;
  railEl.appendChild(panel);
  pagePanelEl = panel;
  pageListEl = panel.querySelector('.ann-page-list');
  if (pageListEl) {
    if (pageNotes.length) {
      pageNotes.forEach(n => { const c = buildCard(n); cardRefs[n.id] = c; pageListEl!.appendChild(c); });
    } else {
      const e = document.createElement('p');
      e.className = 'ann-empty';
      e.textContent = 'No page notes yet.';
      pageListEl.appendChild(e);
    }
  }

  // off-screen counters
  aboveEl = document.createElement('div');
  aboveEl.className = 'ann-offscreen';
  aboveEl.textContent = '↑';
  aboveEl.style.display = 'none';
  aboveEl.addEventListener('click', jumpUp);
  railEl.appendChild(aboveEl);
  belowEl = document.createElement('div');
  belowEl.className = 'ann-offscreen';
  belowEl.textContent = '↓';
  belowEl.style.display = 'none';
  belowEl.addEventListener('click', jumpDown);
  railEl.appendChild(belowEl);

  // anchored cards (only those that resolved to a target this render)
  anchoredFor(currentSectionKey).forEach(n => {
    if (!anchorEl[n.id]) return;
    const wrap = document.createElement('div');
    wrap.className = 'ann-anchored';
    wrap.style.display = 'none';
    const expanded = activeId === n.id || editingId === n.id;
    wrap.appendChild(expanded ? buildCard(n) : buildPill(n));
    cardRefs[n.id] = wrap;
    railEl!.appendChild(wrap);
  });
}

function applyActiveStates() {
  if (!currentContainer) return;
  currentContainer.querySelectorAll<HTMLElement>('mark[data-ann-id]').forEach(m => {
    m.classList.toggle('is-active', m.dataset.annId === activeId);
  });
  const activeBlock = activeId ? anchorEl[activeId] : null;
  currentContainer.querySelectorAll<HTMLElement>('.para-anchor').forEach(b => {
    b.classList.toggle('is-active', b === activeBlock);
  });
}

function focusEditor(id: string) {
  const ta = railEl?.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`);
  if (!ta) return;
  ta.focus();
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  // Autosave a draft on every keystroke (synchronously to localStorage, so even
  // an abrupt tab close keeps the latest text), and reveal the "draft autosaved"
  // flag once the text diverges from what's committed.
  ta.addEventListener('input', () => {
    setDraft(id, ta.value);
    const ann = annotations[id];
    const flag = railEl?.querySelector<HTMLElement>(`[data-draft-flag="${id}"]`);
    if (flag) flag.toggleAttribute('hidden', !(ann && ta.value !== (ann.body || '')));
  });
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveNote(id); }
    else if (e.key === 'Escape') { e.preventDefault(); requestCancel(id); }
  });
  if (!narrow && pageListEl && pageListEl.contains(ta)) {
    const card = cardRefs[id];
    if (card && pageListEl.contains(card)) pageListEl.scrollTop = Math.max(0, card.offsetTop - 6);
  }
}

// ---- layout: position cards beside their targets ----------------------------
function headerBottom(): number {
  const sh = currentContainer?.closest('.content')?.querySelector('.section-head');
  const b = sh ? sh.getBoundingClientRect().bottom : 0;
  return Math.max(b + 12, 24);
}

function layout() {
  if (!railEl || !bodyEl) return;
  if (narrow) layoutNarrow(); else layoutWide();
}

function layoutWide() {
  if (!railEl || !bodyEl || !currentSectionKey) return;
  const rb = railEl.getBoundingClientRect();
  if (pagePanelEl) {
    // Page notes are pinned to the *bottom* of the rail (fixed). Anchoring at
    // the bottom keeps a constant, tidy offset from the viewport edge however
    // far you've scrolled (a top-pinned panel drifted relative to the header),
    // and frees the whole upper rail for anchored cards. It grows upward.
    pagePanelEl.style.position = 'fixed';
    pagePanelEl.style.left = rb.left + 'px';
    pagePanelEl.style.width = rb.width + 'px';
    pagePanelEl.style.top = '';
    pagePanelEl.style.bottom = '16px';
    pagePanelEl.style.zIndex = '23';
    if (pageListEl) {
      const editingPage = editingId != null && pageFor(currentSectionKey).some(n => n.id === editingId);
      pageListEl.style.display = pageCollapsed ? 'none' : 'block';
      pageListEl.style.maxHeight = editingPage ? 'min(62vh, 520px)' : '32vh';
    }
  }
  const bodyTop = bodyEl.getBoundingClientRect().top;
  const items = anchoredFor(currentSectionKey)
    .filter(n => anchorEl[n.id] && cardRefs[n.id])
    .map(n => ({ n, offset: anchorEl[n.id].getBoundingClientRect().top - bodyTop }))
    .sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const { n, offset } of items) {
    const el = cardRefs[n.id];
    el.style.display = 'block';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.zIndex = activeId === n.id ? '12' : '6';
    const top = Math.max(offset, cursor);
    el.style.top = top + 'px';
    cursor = top + el.offsetHeight + 8;
  }
  railEl.style.minHeight = Math.max(bodyEl.offsetHeight, cursor) + 'px';
  updateOffscreen();
}

function layoutNarrow() {
  if (!railEl || !bodyEl || !currentSectionKey) return;
  if (pagePanelEl) {
    pagePanelEl.style.position = '';
    pagePanelEl.style.left = '';
    pagePanelEl.style.width = '';
    pagePanelEl.style.top = '';
    pagePanelEl.style.bottom = '';
    pagePanelEl.style.zIndex = '';
  }
  if (pageListEl) {
    pageListEl.style.display = pageCollapsed ? 'none' : 'block';
    pageListEl.style.maxHeight = '';
  }
  if (aboveEl) aboveEl.style.display = 'none';
  if (belowEl) belowEl.style.display = 'none';
  railEl.style.minHeight = '';
  const mr = rowEl ? rowEl.getBoundingClientRect() : null;
  const ar = bodyEl.getBoundingClientRect();
  anchoredFor(currentSectionKey).forEach(n => {
    const el = cardRefs[n.id];
    if (!el) return;
    const target = anchorEl[n.id];
    if (n.id === activeId && target && mr) {
      const tr = target.getBoundingClientRect();
      el.style.display = 'block';
      el.style.position = 'absolute';
      el.style.top = (tr.bottom - mr.top + 8) + 'px';
      el.style.left = (ar.left - mr.left) + 'px';
      el.style.right = 'auto';
      el.style.width = ar.width + 'px';
      el.style.zIndex = '30';
    } else {
      el.style.display = 'none';
    }
  });
}

// The visible band for anchored cards: from just under the sticky header down
// to the top of the bottom-pinned page panel (or the viewport edge if it isn't
// pinned). Both off-screen counters and scroll-into-view share these bounds.
function railBounds() {
  const top = headerBottom();
  const fixedPanel = !narrow && pagePanelEl && pagePanelEl.style.position === 'fixed';
  const bottom = fixedPanel ? pagePanelEl!.getBoundingClientRect().top - 8 : window.innerHeight;
  return { top, bottom };
}

function ensureVisible(id: string) {
  const el = cardRefs[id];
  if (!el || el.style.display === 'none') return;
  const { top, bottom } = railBounds();
  const topGuard = narrow ? 78 : top;
  const botGuard = (narrow ? window.innerHeight : bottom) - 12;
  const r = el.getBoundingClientRect();
  let delta = 0;
  if (r.top < topGuard) delta = r.top - topGuard;
  else if (r.bottom > botGuard) delta = Math.min(r.top - topGuard, r.bottom - botGuard);
  if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'smooth' });
}

function offscreenSets() {
  const { top, bottom } = railBounds();
  const above: HTMLElement[] = [], below: HTMLElement[] = [];
  if (currentSectionKey) anchoredFor(currentSectionKey).forEach(n => {
    const el = cardRefs[n.id];
    if (!el || el.style.display === 'none') return;
    const r = el.getBoundingClientRect();
    if (r.bottom <= top + 2) above.push(el);
    else if (r.top >= bottom - 4) below.push(el);
  });
  return { above, below, top, bottom };
}

function updateOffscreen() {
  if (narrow || !railEl || !aboveEl || !belowEl) return;
  const rb = railEl.getBoundingClientRect();
  const { above, below, top, bottom } = offscreenSets();
  const cx = rb.left + rb.width / 2;
  if (above.length) {
    aboveEl.style.display = 'flex';
    aboveEl.title = above.length + ' note' + (above.length > 1 ? 's' : '') + ' above';
    aboveEl.style.left = cx + 'px';
    aboveEl.style.top = (top + 4) + 'px';
  } else aboveEl.style.display = 'none';
  if (below.length) {
    belowEl.style.display = 'flex';
    belowEl.title = below.length + ' note' + (below.length > 1 ? 's' : '') + ' below';
    belowEl.style.left = cx + 'px';
    belowEl.style.top = (bottom - 38) + 'px';   // 34px tall → ~4px off its edge
  } else belowEl.style.display = 'none';
}

function jumpUp() {
  const { above, top } = offscreenSets();
  if (!above.length) return;
  const el = above[above.length - 1];
  window.scrollBy({ top: el.getBoundingClientRect().top - (top + 16), behavior: 'smooth' });
}
function jumpDown() {
  const { below, top } = offscreenSets();
  if (!below.length) return;
  window.scrollBy({ top: below[0].getBoundingClientRect().top - (top + 16), behavior: 'smooth' });
}

// ---- note state transitions -------------------------------------------------
function setActive(id: string | null) {
  if (editingId && editingId !== id) editingId = null;
  activeId = id;
  refresh();
}
function openEdit(id: string) {
  editingId = id;
  activeId = id;
  isNew = false;
  pendingFocus = id;
  refresh();
}
function saveNote(id: string) {
  const ta = railEl?.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`);
  const val = ta ? ta.value : '';
  const ann = annotations[id];
  editingId = null;
  isNew = false;
  clearDraft(id);                       // committing (or clearing) ends the draft
  if (!val.trim()) {
    // Emptied a comment: a highlight reverts to a bare highlight; a page/para
    // note with no text is pointless, so it's removed.
    if (ann && ann.kind === 'highlight') updateAnnotation(id, { body: null });
    else { removeNote(id); return; }
  } else {
    updateAnnotation(id, { body: val });
  }
  refresh();
}
// Esc / Cancel: confirm before throwing away unsaved work. (Closing the tab or
// navigating away does NOT discard — the draft is autosaved for next time;
// only an explicit cancel destroys it, and only with a confirmation.)
function requestCancel(id: string) {
  const ta = railEl?.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`);
  const ann = annotations[id];
  const val = ta ? ta.value : '';
  const dirty = val.trim() !== (ann?.body || '').trim();
  if (!dirty) { cancelNote(id); return; }
  confirmDiscard().then(discard => {
    if (discard) cancelNote(id);
    else railEl?.querySelector<HTMLTextAreaElement>(`[data-editor="${id}"]`)?.focus();
  });
}
function cancelNote(id: string) {
  const ann = annotations[id];
  clearDraft(id);                       // explicit cancel discards the draft
  if (isNew) { isNew = false; removeNote(id); return; }
  // A highlight that was given a (still-empty) comment via the mark menu falls
  // back to a bare highlight on cancel rather than lingering as an empty card.
  if (ann && ann.kind === 'highlight' && (ann.body === '' || (ann.body && !ann.body.trim()))) {
    updateAnnotation(id, { body: null });
  }
  editingId = null;
  isNew = false;
  refresh();
}

// Accessible discard-confirm modal. Resolves true = discard, false = keep
// editing. Traps Tab/Shift+Tab within the dialog, focuses the safe ("Keep
// editing") action by default, closes on Esc / backdrop = keep, and restores
// focus to whatever was focused before it opened.
function confirmDiscard(): Promise<boolean> {
  return new Promise(resolve => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'ann-modal-overlay';
    overlay.innerHTML =
      `<div class="ann-modal" role="dialog" aria-modal="true" aria-labelledby="ann-modal-title">`
      + `<p class="ann-modal-title" id="ann-modal-title">Discard this note?</p>`
      + `<p class="ann-modal-msg">Your unsaved changes will be lost.</p>`
      + `<div class="ann-modal-actions">`
      + `<button type="button" class="ann-modal-keep">Keep editing</button>`
      + `<button type="button" class="ann-modal-discard">Discard</button>`
      + `</div></div>`;
    document.body.appendChild(overlay);
    const keep = overlay.querySelector<HTMLButtonElement>('.ann-modal-keep')!;
    const discard = overlay.querySelector<HTMLButtonElement>('.ann-modal-discard')!;
    const focusables = [keep, discard];

    const close = (v: boolean) => {
      overlay.removeEventListener('keydown', onKey, true);
      overlay.remove();
      // restore focus unless the caller will move it (keep editing refocuses the field)
      if (v && prevFocus && document.contains(prevFocus)) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Tab') {
        // simple two-button focus trap
        e.preventDefault();
        const i = focusables.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey ? (i <= 0 ? focusables.length - 1 : i - 1)
                                : (i === focusables.length - 1 ? 0 : i + 1);
        focusables[next].focus();
      }
    };
    overlay.addEventListener('keydown', onKey, true);
    keep.addEventListener('click', () => close(false));
    discard.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(false); });
    keep.focus();
  });
}
function removeNote(id: string) {
  if (currentContainer) {
    currentContainer.querySelectorAll(`mark[data-ann-id="${id}"]`).forEach(el => {
      const p = el.parentNode;
      if (!p) return;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
      p.normalize?.();
    });
  }
  delete anchorEl[id];
  delete cardRefs[id];
  clearDraft(id);
  if (activeId === id) activeId = null;
  if (editingId === id) editingId = null;
  removeMarkMenu();
  deleteAnnotation(id);
  refresh();
}
function addPageNote() {
  if (!currentSectionKey) return;
  const ann = createAnnotation({ section_key: currentSectionKey, kind: 'note', body: '', title_snapshot: currentTitleSnapshot });
  isNew = true;
  pendingFocus = ann.id;
  activeId = ann.id;
  editingId = ann.id;
  pageCollapsed = false;
  refresh();
}

// ---- rail click delegation --------------------------------------------------
function onRailClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>('[data-activate]');
  if (act) { pendingScroll = act.dataset.activate!; setActive(act.dataset.activate!); return; }
  const ed = t.closest<HTMLElement>('[data-edit]');
  if (ed) { e.stopPropagation(); openEdit(ed.dataset.edit!); return; }
  const del = t.closest<HTMLElement>('[data-delete]');
  if (del) { e.stopPropagation(); removeNote(del.dataset.delete!); return; }
  const sv = t.closest<HTMLElement>('[data-save]');
  if (sv) { saveNote(sv.dataset.save!); return; }
  const cn = t.closest<HTMLElement>('[data-cancel]');
  if (cn) { requestCancel(cn.dataset.cancel!); return; }
  if (t.closest('[data-add-page]')) { e.stopPropagation(); addPageNote(); return; }
  if (t.closest('[data-toggle-page]')) {
    pageCollapsed = !pageCollapsed;
    renderRail(); applyActiveStates(); layout();
    return;
  }
}

// ---- selection → highlight / note popup -------------------------------------
function removePopup() { popupEl?.remove(); popupEl = null; }

function onSelectionChange() {
  if (!bodyEl) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) { removePopup(); return; }
  const range = sel.getRangeAt(0);
  if (!bodyEl.contains(range.commonAncestorContainer)) { removePopup(); return; }
  showSelectionPopup(range.getBoundingClientRect());
}

function showSelectionPopup(rect: DOMRect) {
  removePopup();
  popupEl = document.createElement('div');
  popupEl.className = 'ann-popup';
  popupEl.innerHTML =
    `<button type="button" data-pop="note"><span class="ann-ico">✎</span> Note</button>`
    + `<span class="ann-popup-sep"></span>`
    + `<button type="button" data-pop="hl">Highlight</button>`;
  document.body.appendChild(popupEl);
  popupEl.style.left = (rect.left + rect.width / 2) + 'px';
  popupEl.style.top = (rect.top - 8) + 'px';
  const pr = popupEl.getBoundingClientRect();
  if (pr.left < 6) popupEl.style.left = (6 + pr.width / 2) + 'px';
  if (pr.right > window.innerWidth - 6) popupEl.style.left = (window.innerWidth - 6 - pr.width / 2) + 'px';
  if (pr.top < 6) popupEl.style.top = (rect.bottom + 8 + pr.height) + 'px';
  popupEl.addEventListener('mousedown', e => e.preventDefault());
  popupEl.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]');
    if (b) addHighlight(b.dataset.pop === 'note');
  });
}

function addHighlight(withComment: boolean) {
  if (!bodyEl || !currentSectionKey) return;
  const ctx = getSelectionContext(bodyEl);
  if (!ctx) { removePopup(); return; }
  const ann = createAnnotation({
    section_key: currentSectionKey,
    kind: 'highlight',
    quote: ctx.quote, prefix: ctx.prefix, suffix: ctx.suffix, text_position: ctx.text_position,
    body: withComment ? '' : null,
    title_snapshot: currentTitleSnapshot,
  });
  window.getSelection()?.removeAllRanges();
  removePopup();
  if (withComment) { isNew = true; pendingFocus = ann.id; activeId = ann.id; editingId = ann.id; }
  refresh();
}

// ---- clicks inside the article body -----------------------------------------
function onBodyClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const mark = t.closest<HTMLElement>('mark[data-ann-id]');
  if (mark) { e.stopPropagation(); onMarkClick(mark.dataset.annId!, mark); return; }
  const block = t.closest<HTMLElement>('[data-block-id]');
  if (!block) { hideFab(); return; }
  if (currentSectionKey) {
    const para = forSection(currentSectionKey).find(n => n.kind === 'para' && anchorEl[n.id] === block);
    if (para) { pendingScroll = para.id; setActive(para.id); return; }
  }
  if (narrow) showFabFor(block);
}

function onMarkClick(id: string, el: HTMLElement) {
  const n = annotations[id];
  if (!n) return;
  if (n.body === null) { showMarkMenu(id, el); }      // bare highlight → menu
  else { pendingScroll = id; setActive(id); }          // commented → open its card
}

// ---- bare-mark menu (Note / Remove) -----------------------------------------
function removeMarkMenu() { markMenuEl?.remove(); markMenuEl = null; }

function showMarkMenu(id: string, el: HTMLElement) {
  removeMarkMenu();
  markMenuEl = document.createElement('div');
  markMenuEl.className = 'ann-mark-menu';
  markMenuEl.innerHTML =
    `<button type="button" data-mm="note"><span class="ann-ico">✎</span> Note</button>`
    + `<button type="button" data-mm="remove" class="ann-mm-remove"><span class="ann-ico">✕</span> Remove</button>`;
  document.body.appendChild(markMenuEl);
  const r = el.getBoundingClientRect();
  markMenuEl.style.left = (r.left + r.width / 2) + 'px';
  markMenuEl.style.top = (r.top - 8) + 'px';
  markMenuEl.addEventListener('mousedown', e => e.preventDefault());
  markMenuEl.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mm]');
    if (!b) return;
    if (b.dataset.mm === 'note') { updateAnnotation(id, { body: '' }); removeMarkMenu(); openEdit(id); }
    else removeNote(id);
  });
}

// ---- paragraph hover/tap ¶ button -------------------------------------------
function onBodyMove(e: MouseEvent) {
  if (narrow) return;
  const block = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
  if (!block) return;
  if (hideFabTimer) { clearTimeout(hideFabTimer); hideFabTimer = null; }
  if (block === paraFabBlock && paraFabEl && paraFabEl.style.display !== 'none') return;
  // Place the fab next to where the cursor entered the block (clamped to the
  // block) so it's a short hop away wherever you are in a long paragraph —
  // then hold it still (the guard above) so it isn't a moving target.
  showFabFor(block, e.clientY);
}
function onBodyLeave() { scheduleHideFab(); }
function scheduleHideFab() {
  if (hideFabTimer) clearTimeout(hideFabTimer);
  // Generous: the fab sits across a gap from the text, so the trip from "stop
  // hovering the block" to "land on the button" needs slack.
  hideFabTimer = setTimeout(hideFab, 360);
}
function hideFab() {
  if (hideFabTimer) { clearTimeout(hideFabTimer); hideFabTimer = null; }
  paraFabBlock = null;
  if (paraFabEl) paraFabEl.style.display = 'none';
}
// SVG pencil — text glyphs (✎) render small and sit visually high; an SVG
// centers cleanly at any size.
const FAB_ICON =
  `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"`
  + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
function showFabFor(block: HTMLElement, cursorY?: number) {
  if (!paraFabEl) {
    paraFabEl = document.createElement('div');
    paraFabEl.className = 'ann-para-fab';
    paraFabEl.innerHTML = `<button type="button" title="Add a note on this block">${FAB_ICON}</button>`;
    document.body.appendChild(paraFabEl);
    paraFabEl.addEventListener('mouseenter', () => { if (hideFabTimer) { clearTimeout(hideFabTimer); hideFabTimer = null; } });
    paraFabEl.addEventListener('mouseleave', scheduleHideFab);
    paraFabEl.querySelector('button')!.addEventListener('mousedown', e => {
      e.preventDefault();
      if (paraFabBlock) addParaNote(paraFabBlock);
    });
  }
  paraFabBlock = block;
  const r = block.getBoundingClientRect();
  // The wrapper carries transparent padding (see CSS) that enlarges the hover
  // catch area and bridges the gap from the text; offset position by it so the
  // visible button still lands where we compute.
  const PAD = 12, BTN = 42;
  const btnLeft = Math.min(r.right + 8, window.innerWidth - BTN - 10);
  const btnTop = typeof cursorY === 'number'
    ? Math.max(r.top, Math.min(cursorY - BTN / 2, r.bottom - BTN))
    : r.top;
  paraFabEl.style.display = 'flex';
  paraFabEl.style.left = (btnLeft - PAD) + 'px';
  paraFabEl.style.top = (btnTop - PAD) + 'px';
}
function addParaNote(block: HTMLElement) {
  if (!bodyEl || !currentSectionKey) return;
  const existing = forSection(currentSectionKey).find(n => n.kind === 'para' && anchorEl[n.id] === block);
  if (existing) { hideFab(); openEdit(existing.id); return; }
  const ctx = getBlockContext(bodyEl, block);
  if (!ctx) { hideFab(); return; }
  const ann = createAnnotation({
    section_key: currentSectionKey,
    kind: 'para',
    quote: ctx.quote, prefix: ctx.prefix, suffix: ctx.suffix, text_position: ctx.text_position,
    body: '',
    title_snapshot: currentTitleSnapshot,
  });
  hideFab();
  isNew = true;
  pendingFocus = ann.id;
  activeId = ann.id;
  editingId = ann.id;
  refresh();
}

// ---- dismiss popups / deactivate on outside interaction ---------------------
function onDocDown(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (!t.closest) return;
  if (popupEl && !t.closest('.ann-popup')) removePopup();
  if (markMenuEl && !t.closest('.ann-mark-menu') && !t.closest('mark[data-ann-id]')) removeMarkMenu();
  if (paraFabEl && paraFabEl.style.display !== 'none' && !t.closest('.ann-para-fab') && !t.closest('[data-block-id]')) hideFab();
  if (activeId && !editingId
    && !t.closest('.ann-anchored') && !t.closest('.ann-page-panel')
    && !t.closest('mark[data-ann-id]') && !t.closest('.para-anchor')) {
    setActive(null);
  }
}

// ---- init / teardown --------------------------------------------------------
export function initAnnotations(signal: AbortSignal) {
  const host = document.querySelector<HTMLElement>('[data-section-key]');
  if (!host) return;
  bodyEl = host.querySelector<HTMLElement>('[data-annot-body]');
  rowEl = host.querySelector<HTMLElement>('[data-annot-row]');
  railEl = host.querySelector<HTMLElement>('[data-annot-rail]');
  if (!bodyEl || !railEl) return;

  currentContainer = bodyEl;
  currentSectionKey = host.dataset.sectionKey!;
  currentTitleSnapshot = host.querySelector('.section-h h1, h1')?.textContent?.trim() || currentSectionKey;
  tagBlocks(bodyEl);

  mq = window.matchMedia('(max-width: 1199px)');
  narrow = mq.matches;
  const onMq = () => { narrow = mq!.matches; layout(); };
  mq.addEventListener('change', onMq);

  document.addEventListener('selectionchange', onSelectionChange, { signal });
  bodyEl.addEventListener('click', onBodyClick as EventListener, { signal });
  bodyEl.addEventListener('mousemove', onBodyMove as EventListener, { signal });
  bodyEl.addEventListener('mouseleave', onBodyLeave, { signal });
  railEl.addEventListener('click', onRailClick as EventListener, { signal });
  document.addEventListener('mousedown', onDocDown as EventListener, { signal, capture: true });

  const onScroll = () => {
    if (paraFabEl && paraFabEl.style.display !== 'none') hideFab();
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; if (!narrow) updateOffscreen(); });
  };
  window.addEventListener('scroll', onScroll, { signal, passive: true, capture: true });
  window.addEventListener('resize', layout, { signal });

  refresh();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (railEl) layout(); });

  signal.addEventListener('abort', () => {
    removePopup();
    removeMarkMenu();
    if (paraFabEl) { paraFabEl.remove(); paraFabEl = null; }
    paraFabBlock = null;
    if (hideFabTimer) { clearTimeout(hideFabTimer); hideFabTimer = null; }
    mq?.removeEventListener('change', onMq);
    if (currentContainer) { clearMarks(currentContainer); clearParaOutlines(currentContainer); }
    currentContainer = null; currentSectionKey = null;
    bodyEl = null; rowEl = null; railEl = null;
    pagePanelEl = null; pageListEl = null; aboveEl = null; belowEl = null;
    activeId = null; editingId = null; isNew = false; pageCollapsed = false;
    pendingScroll = null; pendingFocus = null;
    for (const k in cardRefs) delete cardRefs[k];
    for (const k in anchorEl) delete anchorEl[k];
  });
}

export { pullAnnotations };
