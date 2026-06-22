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

// ---- 5. Second pass: rewrite in-text #anchor links to /s/<canonical> --------
// (We needed the full alias map first.) Re-render with link rewriting applied.
for (const s of sections) {
  s.html = s.html.replace(/href="#([^"]+)"/g, (full, anchor) => {
    const canon = aliasToCanonical[anchor];
    return canon ? `href="@@BASE@@s/${canon}"` : full; // @@BASE@@ replaced client-side / in layout
  });
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'sections.json'),
  JSON.stringify({ generatedAt: null, count: sections.length, sections }, null, 0)
);
fs.writeFileSync(
  path.join(OUT, 'aliases.json'),
  JSON.stringify({ aliasToCanonical, aliasMap }, null, 0)
);

console.log(
  `Wrote ${sections.length} sections (${Object.keys(aliasToCanonical).length} anchors). ` +
    `TOC items: ${tocItems.length}, located: ${located.length}.`
);

// ---- helpers ----------------------------------------------------------------
function postProcess(html) {
  // strip ids that would collide? keep them — useful for in-page sub-anchors.
  const root = parseHtml(html);
  const plain = root.text || '';
  return { html, plain };
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
