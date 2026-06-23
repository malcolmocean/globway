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
const sections = located
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
      aliases: [...aliases],
      html: rewritten,
    };
  });

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

// ---- 4c. Decks: lists presented one item at a time by the shared presenter.
// aux = the 959 auxiliary practices; p3/p8 = the prompt lists inside those two
// sections, split into one card per top-level <li>. All share the same {items}
// shape so /aux, /p3, /p8 reuse one presenter (see src/components/Presenter.astro).
const byKeySection = new Map(sections.map((s) => [s.key, s]));
const decks = {
  aux: auxPractices.map((p) => ({ key: p.key, title: p.title, order: p.order, html: p.html })),
  p3: buildListDeck('p3'),
  p8: buildListDeck('p8'),
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
// Decks ship as static assets the presenter fetches once (cached), rather than
// inlining ~0.5 MB into the page HTML.
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
for (const [name, items] of Object.entries(decks)) {
  fs.writeFileSync(
    path.join(ROOT, 'public', `${name}.json`),
    JSON.stringify({ count: items.length, items }, null, 0)
  );
}

console.log(
  `Wrote ${sections.length} sections (${Object.keys(aliasToCanonical).length} anchors). ` +
    `TOC items: ${tocItems.length}, located: ${located.length}. ` +
    `Decks: ${Object.entries(decks).map(([n, i]) => `${n}=${i.length}`).join(', ')}.`
);

// Split a section's prompt list(s) into one card per TOP-LEVEL <li> (nested
// sub-bullets ride along inside their parent card). Used for p3/p8, whose content
// is a deck of prompts with no per-item anchors.
function buildListDeck(sectionKey) {
  const s = byKeySection.get(sectionKey);
  if (!s) { console.warn(`! deck source section not found: ${sectionKey}`); return []; }
  const root = parseHtml(s.html);
  const items = [];
  for (const li of root.querySelectorAll('li')) {
    let anc = li.parentNode, nested = false;
    while (anc) { if ((anc.tagName || '').toUpperCase() === 'LI') { nested = true; break; } anc = anc.parentNode; }
    if (nested) continue; // only top-level items become cards
    const text = (li.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const order = items.length;
    items.push({
      key: `${sectionKey}-${order + 1}`,
      title: text.length > 80 ? text.slice(0, 79).trimEnd() + '…' : text,
      order,
      html: li.innerHTML,
    });
  }
  return items;
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
    practices.push({ key, title: names[i].name, order: i, html });
  }
  return { auxPractices: practices, auxSlugToKey };
}

// ---- helpers ----------------------------------------------------------------
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
    .replace(/<p>\s*<\/p>/gi, '');
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
