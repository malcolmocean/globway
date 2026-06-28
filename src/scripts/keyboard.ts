// Keyboard navigation. Two listeners routed by *real* browser focus — one on
// `document` for the article body (reading state = focus resting on <body>), one
// on the persistent `.sidebar` for the TOC tree — plus a declarative keymap table
// that drives both dispatch *and* the generated help overlay. No central mode
// machine: "where am I" is whatever has focus. See
// docs/plans/2026-06-26-kb-navigation-architecture.md.
import {
  kbFocusBlock, kbHighlight, kbNote, kbPageNote, kbStepMark, kbEscape,
} from './annotations';
import {
  kbNotesMove, kbNotesEnter, kbNotesOpen, kbNotesEdit, kbNotesDelete, kbNotesEscape,
} from './notes-view';
import { openSearch } from './search';

// mac vs win/linux, resolved once. `mod` = ⌘ on mac, Ctrl elsewhere — used at
// both match time (below) and render time (the help overlay), from one table.
const IS_MAC = /mac|iphone|ipad/i.test(
  (navigator as any).userAgentData?.platform ?? navigator.platform ?? '');

// ---- the section action surface the body bindings call into -----------------
// Provided by app.ts (which owns read/star/hide/markdown), so this module needs
// no import from app.ts — avoiding an init-order cycle.
export interface KeyboardHost {
  toggle: (field: 'read' | 'starred' | 'hidden') => void;
  copyMd: () => void;
}
let host: KeyboardHost = { toggle: () => {}, copyMd: () => {} };

// ---- keymap table -----------------------------------------------------------
type Scope = 'body' | 'sidebar' | 'notes';
interface Command { id: string; title: string; run: () => void; }
interface Binding {
  keys: string;          // e.g. 'j', 'alt+j', 'mod+ArrowDown', '?', 'Escape'
  command: string;       // Command.id
  scope: Scope;          // which listener owns it
  group: string;         // section heading in the help overlay
  native?: boolean;      // let the browser handle it (Enter / mod+Enter on a link)
}

const COMMANDS: Record<string, Command> = {
  'focus.next':    { id: 'focus.next',    title: 'Focus next paragraph',          run: () => kbFocusBlock('next') },
  'focus.prev':    { id: 'focus.prev',    title: 'Focus previous paragraph',      run: () => kbFocusBlock('prev') },
  'ann.highlight': { id: 'ann.highlight', title: 'Highlight selection / paragraph', run: kbHighlight },
  'ann.note':      { id: 'ann.note',      title: 'Note on selection / paragraph', run: kbNote },
  'sec.read':      { id: 'sec.read',      title: 'Toggle read',                   run: () => host.toggle('read') },
  'sec.star':      { id: 'sec.star',      title: 'Toggle star',                   run: () => host.toggle('starred') },
  'sec.hide':      { id: 'sec.hide',      title: 'Toggle hidden',                 run: () => host.toggle('hidden') },
  'sec.md':        { id: 'sec.md',        title: 'Copy section as Markdown',      run: () => host.copyMd() },
  'page.note':     { id: 'page.note',     title: 'New page note',                 run: kbPageNote },
  'sidebar.focus': { id: 'sidebar.focus', title: 'Focus the sidebar',             run: focusSidebar },
  'mark.next':     { id: 'mark.next',     title: 'Next highlight / note',         run: () => kbStepMark('next') },
  'mark.prev':     { id: 'mark.prev',     title: 'Previous highlight / note',     run: () => kbStepMark('prev') },
  'search.open':   { id: 'search.open',   title: 'Search the manual',             run: openSearch },
  'help':          { id: 'help',          title: 'Show this help',                run: openHelp },
  'esc':           { id: 'esc',           title: 'Dismiss cursor / selection / active note', run: () => { kbEscape(); } },
  // notes view (/notes) — a virtual cursor over the note cards
  'notes.next':   { id: 'notes.next',   title: 'Focus next note',          run: () => kbNotesMove('next') },
  'notes.prev':   { id: 'notes.prev',   title: 'Focus previous note',      run: () => kbNotesMove('prev') },
  'notes.open':   { id: 'notes.open',   title: 'Open note’s section', run: kbNotesEnter },
  'notes.newtab': { id: 'notes.newtab', title: 'Open section in new tab',  run: () => kbNotesOpen(true) },
  'notes.edit':   { id: 'notes.edit',   title: 'Edit note',                run: kbNotesEdit },
  'notes.delete': { id: 'notes.delete', title: 'Delete note',              run: kbNotesDelete },
  'notes.esc':    { id: 'notes.esc',    title: 'Cancel delete / clear cursor', run: () => { kbNotesEscape(); } },
  // Sidebar commands run through runSidebar() (they need the focused row); the
  // entries here exist so the help overlay can name them.
  'sb.down':   { id: 'sb.down',   title: 'Move down',          run: () => {} },
  'sb.up':     { id: 'sb.up',     title: 'Move up',            run: () => {} },
  'sb.parent': { id: 'sb.parent', title: 'To parent section',  run: () => {} },
  'sb.child':  { id: 'sb.child',  title: 'Into subsection',    run: () => {} },
  'sb.open':   { id: 'sb.open',   title: 'Open section',       run: () => {} },
  'sb.newtab': { id: 'sb.newtab', title: 'Open in new tab',    run: () => {} },
  'sb.exit':   { id: 'sb.exit',   title: 'Back to reading',    run: () => {} },
};

const TABLE: Binding[] = [
  // body — article reading & actions
  { keys: 'j',             command: 'focus.next',    scope: 'body', group: 'Reading' },
  { keys: 'k',             command: 'focus.prev',    scope: 'body', group: 'Reading' },
  { keys: 'h',             command: 'ann.highlight', scope: 'body', group: 'Annotate' },
  { keys: 'n',             command: 'ann.note',      scope: 'body', group: 'Annotate' },
  { keys: 'p',             command: 'page.note',     scope: 'body', group: 'Annotate' },
  { keys: 'alt+j',         command: 'mark.next',     scope: 'body', group: 'Annotate' },
  { keys: 'mod+ArrowDown', command: 'mark.next',     scope: 'body', group: 'Annotate' },
  { keys: 'alt+k',         command: 'mark.prev',     scope: 'body', group: 'Annotate' },
  { keys: 'mod+ArrowUp',   command: 'mark.prev',     scope: 'body', group: 'Annotate' },
  { keys: 'r',             command: 'sec.read',      scope: 'body', group: 'Section' },
  { keys: '*',             command: 'sec.star',      scope: 'body', group: 'Section' },
  { keys: 'b',             command: 'sec.hide',      scope: 'body', group: 'Section' },
  { keys: 'm',             command: 'sec.md',        scope: 'body', group: 'Section' },
  { keys: 's',             command: 'sidebar.focus', scope: 'body', group: 'Navigation' },
  { keys: 'mod+k',         command: 'search.open',   scope: 'body', group: 'Search' },
  { keys: '?',             command: 'help',          scope: 'body', group: 'General' },
  { keys: 'Escape',        command: 'esc',           scope: 'body', group: 'General' },
  // sidebar — TOC tree (hjkl and arrows are parallel bindings)
  { keys: 'j',          command: 'sb.down',   scope: 'sidebar', group: 'Sidebar' },
  { keys: 'ArrowDown',  command: 'sb.down',   scope: 'sidebar', group: 'Sidebar' },
  { keys: 'k',          command: 'sb.up',     scope: 'sidebar', group: 'Sidebar' },
  { keys: 'ArrowUp',    command: 'sb.up',     scope: 'sidebar', group: 'Sidebar' },
  { keys: 'h',          command: 'sb.parent', scope: 'sidebar', group: 'Sidebar' },
  { keys: 'ArrowLeft',  command: 'sb.parent', scope: 'sidebar', group: 'Sidebar' },
  { keys: 'l',          command: 'sb.child',  scope: 'sidebar', group: 'Sidebar' },
  { keys: 'ArrowRight', command: 'sb.child',  scope: 'sidebar', group: 'Sidebar' },
  { keys: 'Enter',      command: 'sb.open',   scope: 'sidebar', group: 'Sidebar', native: true },
  { keys: 'mod+Enter',  command: 'sb.newtab', scope: 'sidebar', group: 'Sidebar', native: true },
  { keys: 's',          command: 'sb.exit',   scope: 'sidebar', group: 'Sidebar' },
  { keys: 'Escape',     command: 'sb.exit',   scope: 'sidebar', group: 'Sidebar' },
  // notes view (/notes) — owns the document scope on that page (the body reading
  // bindings don't apply there). hjkl-style + the shared s / ? bindings.
  { keys: 'j',         command: 'notes.next',   scope: 'notes', group: 'Notes view' },
  { keys: 'ArrowDown', command: 'notes.next',   scope: 'notes', group: 'Notes view' },
  { keys: 'k',         command: 'notes.prev',   scope: 'notes', group: 'Notes view' },
  { keys: 'ArrowUp',   command: 'notes.prev',   scope: 'notes', group: 'Notes view' },
  { keys: 'Enter',     command: 'notes.open',   scope: 'notes', group: 'Notes view' },
  { keys: 'mod+Enter', command: 'notes.newtab', scope: 'notes', group: 'Notes view' },
  { keys: 'e',         command: 'notes.edit',   scope: 'notes', group: 'Notes view' },
  { keys: 'd',         command: 'notes.delete', scope: 'notes', group: 'Notes view' },
  { keys: 's',         command: 'sidebar.focus', scope: 'notes', group: 'Notes view' },
  { keys: 'mod+k',     command: 'search.open',  scope: 'notes', group: 'Search' },
  { keys: '?',         command: 'help',         scope: 'notes', group: 'General' },
  { keys: 'Escape',    command: 'notes.esc',    scope: 'notes', group: 'Notes view' },
];

// ---- key parsing & matching -------------------------------------------------
interface ParsedKey { mod: boolean; alt: boolean; shift: boolean; ctrl: boolean; meta: boolean; key: string; }
function parseKeys(s: string): ParsedKey {
  const parts = s.split('+');
  const key = parts.pop()!;
  const p: ParsedKey = { mod: false, alt: false, shift: false, ctrl: false, meta: false, key };
  for (const part of parts) (p as any)[part] = true;
  return p;
}

// Match on the actual character the layout produced (e.key), not the physical
// key position (e.code) — so non-QWERTY layouts (Colemak, Dvorak, …) bind to the
// keys their users actually press.
//
// The one exception is Alt-combos: macOS composes Option+letter into a glyph
// (⌥J = '∆'), losing the base letter from e.key, so we fall back to the physical
// code *only when Alt is part of the binding*. Scoping the fallback to Alt keeps
// plain-letter bindings (the common case) fully layout-correct while letting
// ⌥J/⌥K resolve on a Mac.
function keyMatches(e: KeyboardEvent, bkey: string, alt: boolean): boolean {
  if (bkey.length !== 1) return e.key === bkey;   // ArrowDown, Enter, Escape, …
  const k = bkey.toLowerCase();
  if (e.key.toLowerCase() === k) return true;
  if (!alt) return false;
  if (/^Key[A-Z]$/.test(e.code) && e.code.slice(3).toLowerCase() === k) return true;
  if (/^Digit[0-9]$/.test(e.code) && e.code.slice(5) === k) return true;
  return false;
}

function bindingMatches(e: KeyboardEvent, p: ParsedKey): boolean {
  if (!keyMatches(e, p.key, p.alt)) return false;
  const wantMeta = p.meta || (p.mod && IS_MAC);
  const wantCtrl = p.ctrl || (p.mod && !IS_MAC);
  if (e.metaKey !== wantMeta) return false;
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.altKey !== p.alt) return false;
  // A plain letter binding must not fire on a capital (Shift+letter); symbols like
  // '*' / '?' already encode their Shift, so we don't constrain Shift for them.
  const isAlpha = p.key.length === 1 && /[a-z]/i.test(p.key);
  if (isAlpha && !p.shift && e.shiftKey) return false;
  if (p.shift && !e.shiftKey) return false;
  return true;
}

const bodyBindings = TABLE.filter(b => b.scope === 'body').map(b => ({ ...b, parsed: parseKeys(b.keys) }));
const sidebarBindings = TABLE.filter(b => b.scope === 'sidebar').map(b => ({ ...b, parsed: parseKeys(b.keys) }));
const notesBindings = TABLE.filter(b => b.scope === 'notes').map(b => ({ ...b, parsed: parseKeys(b.keys) }));
const HELP_PARSED = parseKeys('?');
const SEARCH_PARSED = parseKeys('mod+k');

// True on the all-notes page (/notes). Its document scope belongs to the notes
// cursor, not the article-reading bindings (there's no article body there).
function onNotesPage(): boolean { return !!document.querySelector('[data-notes-view]'); }

// The one guard that makes typing & dialogs safe: if the event is inside a field
// or an open dialog, the nav listeners do nothing. closest() matches any
// descendant at any depth, so no widget has to cooperate.
function navGuardBail(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && !!t.closest('input, textarea, [contenteditable], [role="dialog"], .kbd-help-overlay, .search-overlay');
}

// ---- body (document) listener -----------------------------------------------
function onBodyKey(e: KeyboardEvent) {
  if (navGuardBail(e)) return;
  if ((e.target as HTMLElement).closest('.sidebar')) return;     // the sidebar owns its own keys
  if (onNotesPage()) return;                                     // the notes cursor owns this page
  for (const b of bodyBindings) {
    if (!bindingMatches(e, b.parsed)) continue;
    if (b.command === 'esc') { if (kbEscape()) e.preventDefault(); return; }
    e.preventDefault();
    COMMANDS[b.command]?.run();
    return;
  }
  // Everything else (↑↓ PgUp/PgDn Home/End ←→, Space) is left untouched so native
  // scrolling keeps working.
}

// ---- sidebar listener -------------------------------------------------------
function onSidebarKey(e: KeyboardEvent) {
  if (navGuardBail(e)) return;                                    // e.g. the AuthBar email field
  if (bindingMatches(e, SEARCH_PARSED)) { e.preventDefault(); openSearch(); return; } // ⌘K works sidebar-wide
  if (bindingMatches(e, HELP_PARSED)) { e.preventDefault(); openHelp(); return; } // ? works sidebar-wide
  const row = (e.target as HTMLElement).closest<HTMLElement>('a.row[data-row-key]');
  if (!row) return;                                              // not on a row → let it bubble
  for (const b of sidebarBindings) {
    if (!bindingMatches(e, b.parsed)) continue;
    if (b.native) return;                                        // Enter / mod+Enter: native anchor
    e.preventDefault();
    e.stopPropagation();                                         // only the keys we handle
    runSidebar(b.command, row);
    return;
  }
}

// ---- notes view listener ----------------------------------------------------
// Lives on `document` (the /notes container isn't a persistent element, so we
// can't bind to it once). Active only on /notes, and only when focus isn't in the
// sidebar (which owns its own keys) or a field/dialog (the nav guard).
function onNotesKey(e: KeyboardEvent) {
  if (navGuardBail(e)) return;
  if ((e.target as HTMLElement).closest('.sidebar')) return;
  if (!onNotesPage()) return;
  for (const b of notesBindings) {
    if (!bindingMatches(e, b.parsed)) continue;
    if (b.command === 'notes.esc') { if (kbNotesEscape()) e.preventDefault(); return; }
    e.preventDefault();
    COMMANDS[b.command]?.run();
    return;
  }
}

function runSidebar(command: string, row: HTMLElement) {
  switch (command) {
    case 'sb.down':   sidebarMove('down', row); break;
    case 'sb.up':     sidebarMove('up', row); break;
    case 'sb.parent': sidebarMove('parent', row); break;
    case 'sb.child':  sidebarMove('child', row); break;
    case 'sb.exit':   exitSidebar(); break;
  }
}

// ---- sidebar state & movement -----------------------------------------------
// The only persistent keyboard state besides the body's virtual cursor: the row
// you were last on (so `s` returns you there) and, per parent, the child you last
// descended into (so `h` then `l` comes back to the same row).
let rememberedRow: HTMLElement | null = null;
const lastChild: Record<string, string> = {};

function sidebarRoot(): HTMLElement | null { return document.querySelector<HTMLElement>('.sidebar'); }
function tocRows(): HTMLElement[] {
  const root = sidebarRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('nav[data-toc] a.row[data-row-key]'))
    .filter(r => r.getClientRects().length > 0);                 // skip filtered-out (display:none)
}
function currentRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.sidebar nav[data-toc] a.row.current') ?? tocRows()[0] ?? null;
}
// Roving tabindex: exactly one row is in the tab order at a time.
function setRoving(target: HTMLElement) {
  for (const r of tocRows()) r.tabIndex = r === target ? 0 : -1;
}
function focusRow(row: HTMLElement | null) {
  if (!row) return;
  setRoving(row);
  rememberedRow = row;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}
function focusSidebar() {
  const remembered = rememberedRow && rememberedRow.isConnected && rememberedRow.getClientRects().length
    ? rememberedRow : null;
  focusRow(remembered ?? currentRow());
}
function exitSidebar() {
  (document.activeElement as HTMLElement | null)?.blur();         // focus falls to <body> = reading state
}
function rowParent(row: HTMLElement): HTMLElement | null {
  const li = row.closest('li')?.parentElement?.closest('li');
  return li?.querySelector<HTMLElement>(':scope > a.row') ?? null;
}
function rowChildren(row: HTMLElement): HTMLElement[] {
  const ul = row.closest('li')?.querySelector(':scope > ul');
  if (!ul) return [];
  return Array.from(ul.querySelectorAll<HTMLElement>(':scope > li > a.row'))
    .filter(r => r.getClientRects().length > 0);
}
function sidebarMove(dir: 'down' | 'up' | 'parent' | 'child', row: HTMLElement) {
  if (dir === 'down' || dir === 'up') {
    const rows = tocRows();
    const ni = rows.indexOf(row) + (dir === 'down' ? 1 : -1);
    if (ni >= 0 && ni < rows.length) focusRow(rows[ni]);
  } else if (dir === 'parent') {
    const p = rowParent(row);
    if (p) { lastChild[p.dataset.rowKey!] = row.dataset.rowKey!; focusRow(p); }
  } else {                                                        // child
    const kids = rowChildren(row);
    if (!kids.length) return;                                     // leaf row: no-op
    const want = lastChild[row.dataset.rowKey!];
    focusRow(kids.find(k => k.dataset.rowKey === want) ?? kids[0]);
  }
}

// ---- help overlay (generated from the table) --------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
// Resolve a binding string to platform glyphs: ⌘⌥⇧ on mac, Ctrl/Alt/Shift else.
function renderKeys(keys: string): string {
  const glyph = (part: string): string => {
    switch (part) {
      case 'mod':   return IS_MAC ? '⌘' : 'Ctrl';
      case 'alt':   return IS_MAC ? '⌥' : 'Alt';
      case 'shift': return IS_MAC ? '⇧' : 'Shift';
      case 'ctrl':  return 'Ctrl';
      case 'meta':  return '⌘';
      case 'ArrowDown':  return '↓';
      case 'ArrowUp':    return '↑';
      case 'ArrowLeft':  return '←';
      case 'ArrowRight': return '→';
      case 'Enter':  return IS_MAC ? '↵' : 'Enter';
      case 'Escape': return 'Esc';
      default: return part.length === 1 ? part.toUpperCase() : part;
    }
  };
  return keys.split('+').map(p => `<kbd>${escapeHtml(glyph(p))}</kbd>`).join(IS_MAC ? '' : '+');
}
// group -> (command -> {title, all of its key strings}), preserving table order.
function helpGroups(): Map<string, Map<string, { title: string; keys: string[] }>> {
  const out = new Map<string, Map<string, { title: string; keys: string[] }>>();
  for (const b of TABLE) {
    const cmd = COMMANDS[b.command];
    if (!cmd) continue;
    if (!out.has(b.group)) out.set(b.group, new Map());
    const g = out.get(b.group)!;
    if (!g.has(b.command)) g.set(b.command, { title: cmd.title, keys: [] });
    g.get(b.command)!.keys.push(b.keys);
  }
  return out;
}

let helpEl: HTMLElement | null = null;
function openHelp() {
  if (helpEl) return;
  const sections = [...helpGroups()].map(([name, cmds]) => {
    const rows = [...cmds.values()].map(c =>
      `<div class="kbd-row"><span class="kbd-keys">`
      + c.keys.map(renderKeys).join('<span class="kbd-or">/</span>')
      + `</span><span class="kbd-title">${escapeHtml(c.title)}</span></div>`).join('');
    return `<section class="kbd-group"><h3>${escapeHtml(name)}</h3>${rows}</section>`;
  }).join('');
  helpEl = document.createElement('div');
  helpEl.className = 'kbd-help-overlay';
  helpEl.tabIndex = -1;
  helpEl.innerHTML =
    `<div class="kbd-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">`
    + `<div class="kbd-help-head"><h2>Keyboard shortcuts</h2>`
    + `<button type="button" class="kbd-close" aria-label="Close help">×</button></div>`
    + `<div class="kbd-grid">${sections}</div></div>`;
  document.body.appendChild(helpEl);
  // Own every key while up (it carries role="dialog" + is in the guard): close on
  // Esc or ?, swallow the rest so nothing leaks to the body listener beneath.
  helpEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); }
    e.stopPropagation();
  });
  helpEl.addEventListener('mousedown', e => {
    if (e.target === helpEl || (e.target as HTMLElement).closest('.kbd-close')) closeHelp();
  });
  helpEl.focus();
}
function closeHelp() { helpEl?.remove(); helpEl = null; }

// ---- wiring -----------------------------------------------------------------
// Listeners live on persistent elements (document / .sidebar), so they're wired
// exactly once. The body's virtual cursor and sidebar roving state are reset /
// reseeded per page by setupKeyboardPage().
export function initKeyboard(h: KeyboardHost) {
  host = h;
  document.addEventListener('keydown', onBodyKey);
  document.addEventListener('keydown', onNotesKey);
  sidebarRoot()?.addEventListener('keydown', onSidebarKey);
  document.addEventListener('astro:before-swap', closeHelp);     // the overlay's <body> is swapped away
}

export function setupKeyboardPage() {
  // After a navigation, focus may be stranded on whatever in the (persisted) sidebar
  // triggered it — a clicked TOC row, the brand link, or a dice/draw control (these
  // now navigate client-side instead of full-reloading, so focus no longer resets).
  // Drop it back to <body> so you land in reading state; otherwise the body key
  // listener ignores `s` (and every reading key) while focus sits inside the sidebar.
  const a = document.activeElement as HTMLElement | null;
  if (a?.closest?.('.sidebar') && !a.matches('input, textarea, [contenteditable]')) a.blur();
  // Seed the roving tabindex on the current page's row so Tab enters the TOC there,
  // and move the remembered cursor to it: navigating (clicking a TOC link, following
  // a body link, Enter on a row) all land on a new page, so `s` should focus *this*
  // page in the TOC — not wherever the cursor was parked before you navigated away.
  const cur = currentRow();
  if (cur) { setRoving(cur); rememberedRow = cur; }
}
