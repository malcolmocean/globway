// Build step: parse Mark's vendored markdown into structured, anchor-keyed data
// the Astro site consumes. Emits src/data/sections.json and src/data/aliases.json.
//
// Strategy (see docs/plans/2026-06-22-...-design.md):
//  - Hierarchy comes from the TOC list (indent = depth), NOT body header levels.
//  - Content is the concatenated source (same file order as Mark's m.sh), sliced at
//    every TOC-target anchor's line. Each slice -> one section, keyed by anchor.
//  - All identity is anchor-based so it survives Mark's edits and our restructuring.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { parse as parseHtml } from 'node-html-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'protocol-source');
const OUT = path.join(ROOT, 'src', 'data');

// Same input order pandoc uses in m.sh, tagged by kind for filtering/special pages.
const FILE_ORDER = [
  ['index.md', 'main'],
  ['auxiliary_names.md', 'auxiliary'],
  ['auxiliary.md', 'auxiliary'],
  ['appendix_p1_en-US.md', 'appendix'],
  ['w_culture.md', 'appendix'],
  ['subtle_interaction.md', 'appendix'],
  ['larp_death.md', 'appendix'],
  ['long_covid_jhana.md', 'appendix'],
  ['larp_health.md', 'appendix'],
  ['grice.md', 'appendix'],
  ['feelings.md', 'appendix'],
  ['language_causal.md', 'appendix'],
  ['language_perspective.md', 'appendix'],
  ['narrative_writing_bib.md', 'appendix'],
  ['temp_notes.md', 'misc'],
  ['footer.md', 'misc'],
];

const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });

// ---- 1. Concatenate source, tracking provenance per line --------------------
/** @type {{text:string, file:string, kind:string}[]} */
const lines = [];
for (const [file, kind] of FILE_ORDER) {
  const p = path.join(SRC, file);
  if (!fs.existsSync(p)) { console.warn(`! missing source file: ${file}`); continue; }
  const content = fs.readFileSync(p, 'utf8').split('\n');
  for (const text of content) lines.push({ text, file, kind });
  lines.push({ text: '', file, kind }); // blank line between files (pandoc-ish)
}

// ---- 2. Parse the TOC list into an ordered, depth-tagged item list ----------
const idxStart = lines.findIndex(
  (l) => /^#\s/.test(l.text) && /id="full-table-of-contents"/.test(l.text)
);
let idxEnd = lines.findIndex((l, i) => i > idxStart && /^#\s/.test(l.text));
if (idxStart < 0) throw new Error('Could not locate the Full Table of Contents');

const tocItems = [];
for (let i = idxStart + 1; i < idxEnd; i++) {
  const raw = lines[i].text;
  const m = raw.match(/^(\s*)\*\s+<a id="([^"]+)" href="#([^"]+)">([\s\S]*?)<\/a>\s*$/);
  if (!m) continue;
  const indent = m[1].replace(/ {4}/g, '\t');
  const depth = (indent.match(/\t/g) || []).length;
  const title = decodeEntities(m[4].replace(/<[^>]+>/g, '').trim());
  tocItems.push({ depth, tocAnchor: m[2], target: m[3], title });
}
if (!tocItems.length) throw new Error('Parsed 0 TOC items — selector probably broke');

// ---- 3. Locate each target anchor's line in the concatenated source ---------
// Build an index: for the FIRST line each id="..." appears on.
const idLine = new Map(); // id -> line index
const idRe = /id="([^"]+)"/g;
lines.forEach((l, i) => {
  let m;
  idRe.lastIndex = 0;
  while ((m = idRe.exec(l.text))) if (!idLine.has(m[1])) idLine.set(m[1], i);
});

// ---- 4. Build sections from slices between consecutive targets --------------
// Assign each TOC item a source line; sort by document position to slice.
const located = tocItems
  .map((t, order) => ({ ...t, order, line: idLine.has(t.target) ? idLine.get(t.target) : -1 }))
  .filter((t) => {
    if (t.line < 0) console.warn(`! TOC target not found in source: ${t.target}`);
    return t.line >= 0;
  });

// Sort by document line; the next located item's line bounds this slice.
const byLine = [...located].sort((a, b) => a.line - b.line);
const sliceEnd = new Map(); // order -> end line (exclusive)
for (let i = 0; i < byLine.length; i++) {
  const end = i + 1 < byLine.length ? byLine[i + 1].line : lines.length;
  sliceEnd.set(byLine[i].order, end);
}

// Canonical key = the TOC target (a slug). Aliases = every id on the header line
// of the slice (captures legacy numeric ids like "5", "177q") + the target itself.
const aliasMap = {}; // canonicalKey -> [aliases]
let sections = located
  .sort((a, b) => a.order - b.order)
  .map((t) => {
    const start = t.line;
    const end = sliceEnd.get(t.order);
    const slice = lines.slice(start, end);
    const bodyMd = slice.map((l) => l.text).join('\n');

    // aliases: ids on the first (header) line of the slice
    const headerLine = slice[0]?.text || '';
    const aliases = new Set([t.target]);
    let m;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(headerLine))) aliases.add(m[1]);

    let html = md.render(bodyMd);
    const { html: rewritten, plain } = postProcess(html);

    const key = t.target;
    aliasMap[key] = [...aliases];
    return {
      key,
      title: t.title,
      depth: t.depth,
      kind: slice[0]?.kind || 'main',
      file: slice[0]?.file || '',
      wordcount: plain.split(/\s+/).filter(Boolean).length,
      contentHash: contentHash(plain),
      aliases: [...aliases],
      html: rewritten,
      // Raw markdown source, kept for the "copy as markdown" button. Dead nav
      // links stripped (same as the html); in-text #anchor links rewritten to
      // absolute URLs in the second pass below so copied md works anywhere.
      md: stripDeadNavLinks(bodyMd),
    };
  });

// ---- 4a. Site curation (fork-layer, NOT upstream) ---------------------------
// protocol-source/* stays a pristine mirror of Mark's repo so it can be synced /
// PR'd upstream cleanly. Fork-specific presentation changes live here, keyed to
// Mark's stable anchors so they re-apply across his updates. (cf. stripDeadNavLinks.)
sections = curateFrontMatter(sections, aliasMap);

// Reading order + prev/next + parent (nearest preceding shallower item)
sections.forEach((s, i) => {
  s.order = i;
  s.prev = i > 0 ? sections[i - 1].key : null;
  s.next = i < sections.length - 1 ? sections[i + 1].key : null;
  let parent = null;
  for (let j = i - 1; j >= 0; j--) {
    if (sections[j].depth < s.depth) { parent = sections[j].key; break; }
  }
  s.parent = parent;
});

// Build a global alias -> canonical lookup for in-text link rewriting & redirects
const aliasToCanonical = {};
for (const [key, al] of Object.entries(aliasMap)) for (const a of al) aliasToCanonical[a] = key;

// ---- 4b. Auxiliary practices: split appendix 2 ("full") into one record per
// practice, presented on their own at /aux?p=<key> (NOT global sections, so they
// stay out of the sidebar/tree/random). Appendix 1 ("names only") is their index;
// its 959 links are paired by position to these records so every link resolves —
// more robust than slug-matching, since some of Mark's #slug links are broken
// upstream and a few practices share a slug.
const { auxPractices, auxSlugToKey } = buildAuxPractices();

// ---- 5. Second pass: rewrite in-text #anchor links --------------------------
// (We needed the full alias map first.) A bare #slug resolves to an aux practice
// first (so Appendix 1 + any cross-links land on /aux), else to a /s/<canonical>.
function rewriteLinks(html) {
  return html.replace(/href="#([^"]+)"/g, (full, anchor) => {
    if (auxSlugToKey[anchor]) return `href="@@BASE@@aux?p=${auxSlugToKey[anchor]}"`;
    const canon = aliasToCanonical[anchor];
    return canon ? `href="@@BASE@@s/${canon}"` : full; // @@BASE@@ replaced in layout
  });
}
for (const s of sections) s.html = rewriteLinks(s.html);
for (const a of auxPractices) a.html = rewriteLinks(a.html);

// Markdown variant of the link rewrite, for the "copy as markdown" payload: emit
// ABSOLUTE URLs (so pasted md works anywhere), covering both inline-html href="#x"
// and markdown [text](#x) links. Anchors with no canonical target are left as-is.
const SITE = (process.env.PUBLIC_SITE_URL || 'https://globway.top').replace(/\/$/, '');
function absForAnchor(anchor) {
  if (auxSlugToKey[anchor]) return `${SITE}/aux?p=${auxSlugToKey[anchor]}`;
  const canon = aliasToCanonical[anchor];
  return canon ? `${SITE}/s/${canon}` : null;
}
function rewriteLinksMd(md) {
  return md
    .replace(/href="#([^"]+)"/g, (full, a) => { const u = absForAnchor(a); return u ? `href="${u}"` : full; })
    .replace(/\]\(#([^)]+)\)/g, (full, a) => { const u = absForAnchor(a); return u ? `](${u})` : full; });
}
for (const s of sections) if (s.md) s.md = rewriteLinksMd(s.md);

// ---- 4c. Decks: lists presented one item at a time by the shared presenter.
// aux = the 959 auxiliary practices; p3/p8 = the prompt lists inside those two
// sections, split into one card per top-level <li>. All share the same {items}
// shape so /aux, /p3, /p8 reuse one presenter (see src/components/Presenter.astro).
const byKeySection = new Map(sections.map((s) => [s.key, s]));
const decks = {
  // aux cards have real names (shown as the heading); p3/p8 "titles" are just the
  // card's own text truncated for nav, so rendering them as a heading would repeat
  // the body — showTitle=false suppresses that duplicate heading.
  aux: { items: auxPractices.map((p) => ({ key: p.key, title: p.title, order: p.order, html: p.html })), preamble: '', showTitle: true },
  // p3 has no text before its list; its bolded lead item is the stem/instructions.
  p3: { ...buildListDeck('p3', { leadEmphasisPreamble: true }), showTitle: false },
  // p8 cards are short prompts — show the full prompt itself as the (big) heading
  // rather than as body text (bodyAsHeading avoids the 80-char title truncation).
  p8: { ...buildListDeck('p8'), showTitle: false, bodyAsHeading: true },
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'sections.json'),
  JSON.stringify({ generatedAt: null, count: sections.length, sections }, null, 0)
);
fs.writeFileSync(
  path.join(OUT, 'aliases.json'),
  JSON.stringify({ aliasToCanonical, aliasMap }, null, 0)
);
// Lightweight nested TOC (key/title/depth/children only — no bodies) for the
// sidebar tree, which is built once client-side and persisted across navigations
// instead of being server-rendered into all ~587 pages. Mirrors buildTree() in
// src/lib/content.ts but trimmed; bundled into the client JS (small, cached once).
{
  const tnodes = new Map(sections.map((s) => [s.key, { key: s.key, title: s.title, depth: s.depth, children: [] }]));
  const troots = [];
  for (const s of sections) {
    const n = tnodes.get(s.key);
    if (s.parent && tnodes.has(s.parent)) tnodes.get(s.parent).children.push(n);
    else troots.push(n);
  }
  fs.writeFileSync(path.join(OUT, 'toc.json'), JSON.stringify(troots, null, 0));
}
// Per-section content hashes: powers the annotation staleness fast-path.
{
  const hashes = {};
  for (const s of sections) hashes[s.key] = s.contentHash;
  fs.writeFileSync(path.join(OUT, 'hashes.json'), JSON.stringify(hashes, null, 0));
}
// Decks ship as static assets the presenter fetches once (cached), rather than
// inlining ~0.5 MB into the page HTML.
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
for (const [name, deck] of Object.entries(decks)) {
  fs.writeFileSync(
    path.join(ROOT, 'public', `${name}.json`),
    JSON.stringify({ count: deck.items.length, items: deck.items, preamble: deck.preamble || '', showTitle: deck.showTitle !== false, bodyAsHeading: !!deck.bodyAsHeading }, null, 0)
  );
}

// ---- 6. Full-text search index (Malcolm's ⌘K). One plaintext record per
// searchable item — every protocol section (full body), every auxiliary
// practice, and the p3/p8 prompt cards — shipped as a single static asset the
// palette fetches *on demand* (first ⌘K only) and feeds to MiniSearch in the
// browser. Deliberately NOT precached by the service worker (see its EXCLUDE
// set): users who never search never pay for it; the SW runtime-caches it on
// first real fetch so it still works offline afterwards. Stored as html-stripped
// plaintext keyed by {t,key} so the client routes to /s/<key>, /aux?p=<key>, or
// /p3|p8?p=<key>. See src/scripts/search.ts.
{
  const toText = (html) => (parseHtml(html || '').text || '').replace(/\s+/g, ' ').trim();
  const docs = [];
  for (const s of sections) {
    const parent = s.parent ? byKeySection.get(s.parent) : null;
    docs.push({ id: `s:${s.key}`, t: 's', key: s.key, title: s.title,
      sub: parent ? parent.title : 'Section', text: toText(s.html) });
  }
  for (const p of decks.aux.items)
    docs.push({ id: `aux:${p.key}`, t: 'aux', key: p.key, title: p.title,
      sub: 'Auxiliary practice', text: toText(p.html) });
  for (const p of decks.p3.items)
    docs.push({ id: `p3:${p.key}`, t: 'p3', key: p.key, title: p.title,
      sub: 'Practice 3 · prompt', text: toText(p.html) });
  for (const p of decks.p8.items)
    docs.push({ id: `p8:${p.key}`, t: 'p8', key: p.key, title: p.title,
      sub: 'Practice 8 · prompt', text: toText(p.html) });
  fs.writeFileSync(
    path.join(ROOT, 'public', 'search.json'),
    JSON.stringify({ count: docs.length, docs }, null, 0)
  );
  console.log(`Wrote search index: ${docs.length} docs.`);
}

console.log(
  `Wrote ${sections.length} sections (${Object.keys(aliasToCanonical).length} anchors). ` +
    `TOC items: ${tocItems.length}, located: ${located.length}. ` +
    `Decks: ${Object.entries(decks).map(([n, d]) => `${n}=${d.items.length}`).join(', ')}.`
);

// Split a section's prompt list(s) into one card per TOP-LEVEL <li> (nested
// sub-bullets ride along inside their parent card). Also pull a preamble: the
// prose between the section header and the first list (p8), or — with
// leadEmphasisPreamble — a fully-bolded lead item that frames the list (p3).
// Used for p3/p8, whose content is a deck of prompts with no per-item anchors.
function buildListDeck(sectionKey, opts = {}) {
  const s = byKeySection.get(sectionKey);
  if (!s) { console.warn(`! deck source section not found: ${sectionKey}`); return { items: [], preamble: '' }; }
  const root = parseHtml(s.html);
  // Preamble candidate 1: top-level nodes before the first list, minus the <h1>.
  let preamble = '';
  for (const node of root.childNodes) {
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'OL' || tag === 'UL') break;
    if (tag && tag !== 'H1' && (node.text || '').trim()) preamble += node.toString();
  }
  const items = [];
  for (const li of root.querySelectorAll('li')) {
    let anc = li.parentNode, nested = false;
    while (anc) { if ((anc.tagName || '').toUpperCase() === 'LI') { nested = true; break; } anc = anc.parentNode; }
    if (nested) continue; // only top-level items become cards
    const text = (li.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    items.push({ title: text, html: li.innerHTML });
  }
  // Preamble candidate 2 (p3): no prose preamble, but a bolded lead item frames it.
  if (!preamble && opts.leadEmphasisPreamble && items.length && /^<(em|strong)>/.test(items[0].html.trim())) {
    preamble = `<p>${items.shift().html}</p>`;
  }
  return {
    items: items.map((it, order) => ({
      key: `${sectionKey}-${order + 1}`,
      title: it.title.length > 80 ? it.title.slice(0, 79).trimEnd() + '…' : it.title,
      order,
      html: it.html,
    })),
    preamble,
  };
}

// Pair Appendix 1's ordered name-links with Appendix 2's ordered practice headers
// (counts are equal). Each practice's key is the Appendix-1 slug (uniquified on
// the few repeats) so its index link resolves; that key is the /aux?p= value and
// the section_state key for read/star, so per-practice state Just Works.
function buildAuxPractices() {
  const namesMd = fs.readFileSync(path.join(SRC, 'auxiliary_names.md'), 'utf8').split('\n');
  const fullMd = fs.readFileSync(path.join(SRC, 'auxiliary.md'), 'utf8');
  const fullLines = fullMd.split('\n');

  // Appendix 1: ordered list of {slug, name}
  const names = [];
  for (const l of namesMd) {
    const m = l.match(/^\*\s+<a id="\d+auxiliary_names" href="#([^"]*)">([\s\S]*?)<\/a>/);
    if (m) names.push({ slug: m[1], name: decodeEntities(m[2].replace(/<[^>]+>/g, '').trim()) });
  }

  // Appendix 2: header lines (one per practice), excluding the appendix title.
  const heads = [];
  fullLines.forEach((l, i) => {
    if (!/^#[^#]/.test(l)) return;
    if (/id="appendix-2-/.test(l)) return; // the appendix title itself
    heads.push(i);
  });
  if (heads.length !== names.length) {
    console.warn(`! aux pairing mismatch: ${names.length} names vs ${heads.length} practices — links may misalign`);
  }

  const n = Math.min(heads.length, names.length);
  const used = new Map(); // base slug -> count, to uniquify duplicates
  const auxSlugToKey = {};
  const practices = [];
  for (let i = 0; i < n; i++) {
    const start = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1] : fullLines.length;
    const bodyMd = fullLines.slice(start, end).join('\n');
    const baseSlug = names[i].slug || `aux-${i}`;
    const seen = (used.get(baseSlug) || 0) + 1;
    used.set(baseSlug, seen);
    const key = seen === 1 ? baseSlug : `${baseSlug}-${seen}`;
    // bare slug -> first practice using it (for cross-links elsewhere)
    if (!(baseSlug in auxSlugToKey)) auxSlugToKey[baseSlug] = key;
    const { html } = postProcess(md.render(bodyMd));
    // The practice name is shown by the presenter as the card heading, so drop the
    // body's own leading <h1> (which repeated the name with a trailing colon).
    practices.push({ key, title: names[i].name, order: i, html: stripLeadingH1(html) });
  }
  return { auxPractices: practices, auxSlugToKey };
}

// ---- helpers ----------------------------------------------------------------
// Fork-layer curation: merge the scattered front-matter sections (working title …
// copyright, plus funding / canonical location / linking guarantees) into ONE
// section, insert a fork-attribution note, and reframe funding for a fork. Keyed
// to Mark's anchors; merged-away anchors are folded in as aliases of the survivor
// so their links/redirects still land here. Returns the new (shorter) sections[].
function curateFrontMatter(sections, aliasMap) {
  const INTO = 'working-title';
  const TITLE = 'colophon';

  const FORK_NOTE =
    '<div class="fork-note" id="this-fork">\n' +
    '<strong>This is a fork.</strong> This interactive, rearranged edition was created by ' +
    '<a href="https://malcolmocean.com/?utm_source=globway&amp;utm_medium=fork">Malcolm Ocean</a>' +
    ' — one of the lightly-transformed forks permitted above. It may lag the canonical original (linked below). ' +
    'Each section here has its own stable, shareable URL, meant to keep working even as the text is revised.\n' +
    '</div>';

  const FUNDING =
    '<h1 id="funding"><span id="7"></span>Funding:</h1>\n' +
    '<p>Please support Mark Lippmann’s open-access original work: ' +
    '<a href="https://www.patreon.com/meditationstuff">https://www.patreon.com/meditationstuff</a><br>\n' +
    '(This fork is free; funds go to the original author.)</p>';

  // Content order within the merged section. Plain keys pull that section's html;
  // @-tokens inject fork content. Order encodes "blob between copyright & canon".
  const ORDER = [
    'working-title', 'front-quotes', 'byline', 'collaborators-and-credits', 'copyright',
    '@fork', 'canonical-location-of-this-document', '@funding',
  ];
  // Sections absorbed into INTO and dropped from the tree. Not all are re-shown:
  // Mark's verbose (hyper)linking-guarantees section is folded away entirely —
  // replaced by one line in the fork note about THIS edition's own permalinks.
  const ABSORB = [
    'front-quotes', 'byline', 'collaborators-and-credits', 'copyright',
    'canonical-location-of-this-document',
    'hyper-linking-deep-linking-anchor-linking-soft-guarantees', 'funding',
  ];

  const byKey = new Map(sections.map((s) => [s.key, s]));
  const into = byKey.get(INTO);
  if (!into) { console.warn(`! front-matter curation: '${INTO}' not found — skipped`); return sections; }

  const parts = [];
  for (const tok of ORDER) {
    if (tok === '@fork') { parts.push(FORK_NOTE); continue; }
    if (tok === '@funding') { parts.push(FUNDING); continue; }
    const s = byKey.get(tok);
    if (!s) { console.warn(`! front-matter curation: section '${tok}' not found`); continue; }
    parts.push(s.html);
  }
  into.html = parts.join('\n');
  into.title = TITLE;
  into.md = ''; // merged from several sources + fork content; no clean md to copy

  // Fold absorbed sections' anchors into INTO so deep links / in-text links resolve.
  const removed = new Set();
  const aliases = new Set(into.aliases);
  for (const k of ABSORB) {
    const s = byKey.get(k);
    if (!s) continue;
    removed.add(k);
    for (const a of aliasMap[k] || s.aliases || []) aliases.add(a);
    delete aliasMap[k];
  }
  into.aliases = [...aliases];
  aliasMap[into.key] = into.aliases;
  const intoPlain = into.html.replace(/<[^>]+>/g, ' ');
  into.wordcount = intoPlain.split(/\s+/).filter(Boolean).length;
  into.contentHash = contentHash(intoPlain);

  return sections.filter((s) => !removed.has(s.key));
}

function postProcess(html) {
  html = stripDeadNavLinks(html);
  // strip ids that would collide? keep them — useful for in-page sub-anchors.
  const root = parseHtml(html);
  const plain = root.text || '';
  return { html, plain };
}

// Remove the boilerplate "[Go up to this section's line in the Full Table of
// Contents][Go to the Partial Guided Tour …]" blocks. They point at anchors from
// Mark's single-page document (#NNNh, #qq) that have no equivalent in Globway's
// per-section model, so they're dead here — and the breadcrumb + sidebar already
// cover "go up". Done at build time so the vendored source stays untouched.
function stripDeadNavLinks(html) {
  return html
    .replace(/\[?\s*<a\b[^>]*>\s*Go up to this[^<]*Table of Contents\s*<\/a>\s*\]?/gi, '')
    .replace(/\[?\s*<a\b[^>]*>\s*Go to the Partial Guided Tour[^<]*<\/a>\s*\]?/gi, '')
    // Each aux practice ends with "[Click to go back to the corresponding entry in
    // the "auxiliary names" appendix]" pointing at #Nauxiliary_names — an in-page
    // anchor that doesn't exist in Globway's per-page model (the breadcrumb already
    // links back to Appendix 1). Strip the dead link.
    .replace(/\[?\s*<a\b[^>]*auxiliary_names[^>]*>[\s\S]*?<\/a>\s*\]?/gi, '')
    .replace(/<p>\s*<\/p>/gi, '');
}

// Drop a leading <h1>…</h1> (used by deck cards whose heading is shown separately).
function stripLeadingH1(html) {
  return html.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, '');
}
function decodeEntities(s) {
  return s
    .replace(/&#8203;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizePlaintext(text) {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function contentHash(plaintext) {
  return crypto.createHash('sha256').update(normalizePlaintext(plaintext)).digest('hex').slice(0, 16);
}
