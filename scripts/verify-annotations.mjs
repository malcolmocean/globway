// End-to-end verification of annotation anchoring + heal-on-re-anchor, driven
// through a real browser with Playwright. Guards the two bugs this code has hit:
//
//   1. Wrong-occurrence anchoring. getSelectionContext used plain.indexOf(quote),
//      which always returns the FIRST match, so highlighting a repeated word
//      ("with", "the", …) anchored to the first copy instead of the selected one.
//      Plus extractPlaintext (global whitespace collapse + trim) and
//      rangeFromOffset (per-node collapse, no trim) disagreed on what an "offset"
//      meant, so even unique highlights rendered a few characters off. Both now
//      share one buildPlainMap() coordinate space and measure the real selection
//      offset. -> tests A, B below.
//
//   2. Healing never ran on an unchanged section. A fast path re-anchored and
//      `continue`d before writing anything, so legacy/stale context on a section
//      whose hash still matched was never refreshed. The loop is now unified so
//      heal-on-re-anchor always runs; healthy notes still write nothing. -> tests
//      C, D below.
//
// Usage: start the dev server (`npm run dev`) then `node scripts/verify-annotations.mjs`.
// Override the target with BASE_URL=... if the server isn't on :4321.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4321';
// A section with a numbered list (repeated words + inter-node whitespace — the
// exact shape that surfaced both bugs).
const URL = `${BASE}/s/risks-maximally-cautious-warnings-directives-first-`;
const LS = 'globway:annotations';

const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

async function reset() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate((k) => localStorage.removeItem(k), LS);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
}

// Drag-select `len` chars starting at `phrase.indexOf(word)` and click Highlight.
// Returns the selection's on-screen rect so we can assert the mark lands there.
async function highlight(phrase, word) {
  const w = await page.evaluate(({ phrase, word }) => {
    const body = document.querySelector('[data-annot-body]');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node, found = null;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf(phrase);
      if (i >= 0) { found = { node, at: i + phrase.indexOf(word) }; break; }
    }
    if (!found) return null;
    const r = document.createRange();
    r.setStart(found.node, found.at); r.setEnd(found.node, found.at + word.length);
    const rc = r.getBoundingClientRect();
    return { startX: rc.left, endX: rc.right, midY: rc.top + rc.height / 2,
             top: Math.round(rc.top), left: Math.round(rc.left) };
  }, { phrase, word });
  if (!w) return null;
  await page.mouse.move(w.startX + 1, w.midY); await page.mouse.down();
  await page.mouse.move(w.endX - 1, w.midY, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  if (!(await page.$('.ann-popup'))) return null;
  await page.click('.ann-popup [data-pop="hl"]');
  await page.waitForTimeout(250);
  return w;
}

const markGeom = () => page.evaluate(() => {
  const m = document.querySelector('mark.hl');
  if (!m) return null;
  const rc = m.getBoundingClientRect();
  return { text: m.textContent, top: Math.round(rc.top), left: Math.round(rc.left) };
});
const stored = () => page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}'))[0], LS);
const aligned = (m, sel) => m && Math.abs(m.top - sel.top) <= 3 && Math.abs(m.left - sel.left) <= 3;

// A — a repeated word anchors to the occurrence actually selected.
await reset();
const selA = await highlight('households with other residents', 'with');
const markA = await markGeom();
ok('repeated word "with" anchors to the selected copy', markA?.text === 'with' && aligned(markA, selA),
   JSON.stringify(markA));

// B — a second, later "with" lands on ITS line, not the first (regression net).
await reset();
const selB = await highlight('you must not engage with the practices', 'with');
const markB = await markGeom();
ok('a different "with" anchors to its own line', aligned(markB, selB), JSON.stringify({ sel: selB, mark: markB }));

// C — heal a unique-quote note whose context was corrupted: it still resolves
// (quote is unique) and rewrites its stored context back to correct values.
await reset();
const selC = await highlight('glaucoma), breathing', 'glaucoma');
const goodC = await stored();
await page.evaluate((k) => {
  const s = JSON.parse(localStorage.getItem(k)); const id = Object.keys(s)[0];
  s[id].prefix = 'XX'; s[id].suffix = 'YY'; s[id].text_position = 99999;
  localStorage.setItem(k, JSON.stringify(s));
}, LS);
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(400);
const markC = await markGeom(); const healedC = await stored();
ok('corrupted unique note re-renders in the right place', markC?.text === 'glaucoma' && aligned(markC, selC));
ok('heal rewrote stored context to correct values',
   healedC.prefix === goodC.prefix && healedC.suffix === goodC.suffix && healedC.text_position === goodC.text_position);

// D — a healthy note must NOT churn (no updated_at rewrite / sync) on reload.
await reset();
await highlight('households with other residents', 'with');
const t1 = (await stored()).updated_at;
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(400);
const t2 = (await stored()).updated_at;
ok('healthy note does not churn on reload', t1 === t2, `${t1} -> ${t2}`);

await browser.close();
console.log(process.exitCode ? '✗ FAILED' : '✓ all annotation checks passed');
