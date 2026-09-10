// Node test for the project tree's left gutter alignment.
//
// THE BUG THIS EXISTS TO CATCH. `.project-node__row` used to be a flex
// row: the chevron+count toggle button first, the `.project-item` card
// second. A flex item sizes to its own content, so the toggle's width
// tracked the digit count of the session count it drew - "1" produced a
// narrower button than "6", "100" narrower still - and every card after
// it started at a different x. Child `.project-node__sessions` rows were
// indented by a separate hardcoded 28px that agreed with neither.
//
// THE FIX. `.project-node__row` is a CSS grid with a fixed-width first
// column, `--project-gutter`, so the card's left edge is a constant
// regardless of what the gutter draws. `.project-node__sessions` reuses
// the exact same token for its indent, rather than restating a pixel
// value that could drift out of sync. The count is set in tabular
// figures so a digit swap never nudges the clear space that follows it.
//
// FOLLOW-UP (same day). The count used to be right-aligned inside the
// gutter (`margin-left: auto`), which pushed it flush against the
// project card - far from the chevron it belongs to, and crowding the
// project name beside it. The owner's words: "the session count, its 2
// far from the arrow and too close to the tab." The auto margin is
// gone; the count now sits a fixed 4px from the chevron (the toggle's
// own existing `gap: 4px`) and is coloured to match the sidebar's own
// count treatment (`.session-sidebar-group__count`, accent text, no
// pill, from 2174b0d) rather than inheriting the toggle's muted text
// colour.
//
// A project with nothing to fold renders no toggle at all (see
// renderProjectList()), which is exactly the case that broke a grid
// with only one child: a lone grid item auto-places into the FIRST
// column, not the second, landing the card under the gutter instead of
// beside it. `.project-node__gutter` is a wrapper markup always emits
// (empty when there is no toggle) so the row is always two grid
// children and the card is always in column two.
//
// The assertions are against the CSS text and the JS source, like
// test_button_box_sizing.node.mjs does, because this bug is a missing
// fixed-width contract rather than a logic error.
//
// Run with: node tests/test_project_gutter_alignment.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name  Test description.
 * @param {() => void} fn  Body; throwing marks the test failed.
 * @returns {void}
 */
function test(name, fn) {
    try {
        fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

/**
 * Read one file from the client directory.
 * @param {...string} parts  Path segments below `client/`.
 * @returns {string} File contents.
 */
function clientFile(...parts) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', ...parts), 'utf8');
}

/**
 * Split a stylesheet into flat {selector, body} records, comments first
 * stripped so a selector quoted in prose cannot be read as a live rule.
 * Deliberately not a real parser - these are flat, hand-written sheets.
 *
 * @param {string} source  CSS text.
 * @returns {Array<{selector: string, body: string}>} One entry per rule.
 */
function rules(source) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        const selector = m[1].trim().replace(/\s+/g, ' ');
        if (!selector || selector.startsWith('@')) continue;
        out.push({ selector, body: m[2] });
    }
    return out;
}

/**
 * Every rule whose selector list contains exactly the given selector.
 * @param {Array<{selector: string, body: string}>} ruleList  Parsed rules.
 * @param {string} wanted  Selector to look for, e.g. `.project-node__row`.
 * @returns {Array<{selector: string, body: string}>} Matching rules.
 */
function bySelector(ruleList, wanted) {
    return ruleList.filter((r) => r.selector.split(',').some((s) => s.trim() === wanted));
}

/**
 * Read one longhand declaration out of a rule body. Last match wins, so a
 * later cascade rule correctly shadows an earlier one for the same
 * selector - matching how the browser would resolve it.
 * @param {string} body  Declaration block text.
 * @param {string} prop  Property name.
 * @returns {string|null} Trimmed value, or null when absent.
 */
function decl(body, prop) {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'gi');
    let m;
    let last = null;
    while ((m = re.exec(body)) !== null) last = m[1].trim();
    return last;
}

const stylesCss = clientFile('css', 'styles.css');
const styleRules = rules(stylesCss);

test('--project-gutter token is declared once, in :root', () => {
    const matches = [...stylesCss.matchAll(/--project-gutter\s*:\s*[^;]+;/g)];
    assert.equal(matches.length, 1,
        'expected exactly one declaration of --project-gutter (single source of truth)');
    // Balanced-brace scan of the FIRST :root block (the design-tokens block
    // at the top of the file), rather than a naive open/close tally, since
    // that block is large enough that a naive count is easy to get wrong.
    const rootStart = stylesCss.indexOf(':root');
    const braceStart = stylesCss.indexOf('{', rootStart);
    let depth = 0;
    let braceEnd = braceStart;
    for (let i = braceStart; i < stylesCss.length; i++) {
        if (stylesCss[i] === '{') depth++;
        else if (stylesCss[i] === '}') {
            depth--;
            if (depth === 0) { braceEnd = i; break; }
        }
    }
    const firstRootBlock = stylesCss.slice(braceStart, braceEnd);
    assert.ok(firstRootBlock.includes('--project-gutter'),
        '--project-gutter must be declared inside the first :root design-tokens block');
});

test('.project-node__row is a grid with the gutter as its fixed first column', () => {
    const row = bySelector(styleRules, '.project-node__row');
    assert.ok(row.length > 0, '.project-node__row rule not found');
    const body = row.map((r) => r.body).join(';');
    assert.equal(decl(body, 'display'), 'grid',
        'a flex row sizes its first column to content, which is the whole bug: '
        + 'the gutter must be a grid track with a fixed width instead');
    assert.equal(decl(body, 'grid-template-columns'), 'var(--project-gutter) 1fr',
        'the gutter column must be the --project-gutter token, not a literal '
        + 'pixel value restated here');
});

test('.project-node__gutter exists to keep a foldless project two grid children wide', () => {
    const gutter = bySelector(styleRules, '.project-node__gutter');
    assert.ok(gutter.length > 0,
        '.project-node__gutter rule not found - without this wrapper, a project '
        + 'with no toggle renders only ONE child in the grid row, which CSS grid '
        + 'auto-places into column one, landing the card under the gutter');
});

test('.project-node__sessions indents child rows by the SAME token as the row gutter', () => {
    const sessions = bySelector(styleRules, '.project-node__sessions');
    assert.ok(sessions.length > 0, '.project-node__sessions rule not found');
    const margin = decl(sessions.map((r) => r.body).join(';'), 'margin');
    assert.ok(margin, '.project-node__sessions must declare margin');
    assert.match(margin, /var\(--project-gutter\)/,
        'child session rows must indent by var(--project-gutter), reusing the '
        + 'row gutter token, or a future edit to one can silently un-align the other');
});

test('.project-node__count sits tight beside the chevron, coloured, with tabular numerals', () => {
    const count = bySelector(styleRules, '.project-node__count');
    assert.ok(count.length > 0, '.project-node__count rule not found');
    const body = count.map((r) => r.body).join(';');
    assert.notEqual(decl(body, 'margin-left'), 'auto',
        'margin-left: auto pushes the count to the gutter\'s right edge, flush '
        + 'against the project card - the owner\'s complaint was that this puts '
        + 'the count far from the chevron and crowds the project name');
    assert.equal(decl(body, 'font-variant-numeric'), 'tabular-nums',
        'without tabular numerals a digit swap (1 session -> 10) changes the '
        + 'count\'s own rendered width and nudges the clear space after it');
    assert.equal(decl(body, 'color'), 'var(--color-accent)',
        'the count must match the sidebar\'s own treatment '
        + '(.session-sidebar-group__count, 2174b0d): accent-coloured text, not '
        + 'the toggle\'s muted default');
});

test('.project-node__toggle keeps a small fixed gap for the chevron and count to sit in', () => {
    const toggle = bySelector(styleRules, '.project-node__toggle');
    const body = toggle.map((r) => r.body).join(';');
    const gap = decl(body, 'gap');
    assert.ok(gap, '.project-node__toggle must declare a gap - it is the only '
        + 'thing spacing the chevron from the count now that the count is not '
        + 'right-aligned');
    const px = parseFloat(gap);
    assert.ok(px >= 4 && px <= 6,
        `expected a small fixed gap (4-6px) between the chevron and the count, got ${gap}`);
});

test('.project-node__toggle fills the fixed-width gutter column', () => {
    const toggle = bySelector(styleRules, '.project-node__toggle');
    assert.ok(toggle.length > 0, '.project-node__toggle rule not found');
    const body = toggle.map((r) => r.body).join(';');
    assert.equal(decl(body, 'width'), '100%',
        'the toggle must fill its gutter column so the count has a constant '
        + 'right edge to align against, whether the chevron stands alone or a '
        + 'count chip sits beside it');
});

test('the stale ITEM 43 min-width/justify-content override is gone', () => {
    // That override applied `justify-content: center` to EVERY
    // `.project-node__toggle` (same selector, later in the cascade), which
    // would have centred the chevron+count pair and defeated the
    // margin-left: auto right-alignment above. It existed to compensate for
    // the flex-sized gutter; the grid column makes it unnecessary.
    const overrides = bySelector(styleRules, '.project-node__toggle')
        .filter((r) => decl(r.body, 'justify-content') === 'center');
    assert.equal(overrides.length, 0,
        'a `.project-node__toggle { justify-content: center }` override would '
        + 'defeat the count\'s margin-left: auto right-alignment');
});

// THE MARKUP HALF OF THIS FILE MOVED IN SLICE 4. It used to assert that
// `renderProjectList` emitted `<div class="project-node__gutter">`
// unconditionally, by regex against `client/js/launchpad.js`. That
// method is now one line and the tree is a Svelte component, so the same
// claim is asserted against the RENDERED DOM in
// web/src/lib/launchpad/ProjectTree.behaviour.test.ts ("THE GUTTER IS
// THERE EVEN WITH NO TOGGLE, which is the grid contract"), which is a
// stronger test: it counts the row's grid children rather than matching
// a template literal. The CSS assertions below are unchanged and stay
// here, because the stylesheet is still a stylesheet.

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
