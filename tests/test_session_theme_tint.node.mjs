// Node tests for painting a session row in that session's own theme.
//
// WHAT THIS FEATURE IS. Per-session themes exist so you can tell your
// sessions apart at a glance. Until now that only worked once you were
// INSIDE a session - the sidebar list and the home screen rendered every
// row identically, which is exactly where you are choosing which session
// to enter. Themed rows now carry a 3px inline-start rail and a 1px ring
// in the theme's own --color-accent, and sidebar rows additionally get a
// low-alpha wash of it.
//
// THE THING THAT COULD GO WRONG, AND THE MEASUREMENT THAT GOVERNS IT.
// The wash is the only cue that puts colour BEHIND text, so it is the
// only one that can cost contrast. There are 23 themes, so 529 (host
// theme, session theme) pairs, and a spot check on the two or three
// themes anyone actually uses would prove nothing about the rest.
//
// Sweeping all 529, alpha-compositing the wash over each surface's real
// background:
//   - SIDEBAR row, name colour --color-fg: at alpha 0.10 no pair falls
//     below the 4.5:1 body-text floor. At 0.14 three pairs do.
//   - HOME row, name colour --color-accent over --color-accent-bg-soft:
//     several themes already sit barely above the floor with no wash at
//     all (jagermeister: 5.66:1). Alpha 0.10 costs 44 of the 529 pairs
//     their 4.5:1, and even 0.03 costs 6. There is no safe alpha.
// So the home row gets the rail and the ring - which are edges, and sit
// behind nothing - and no wash. That asymmetry is the finding, and the
// sweep below is re-run on every test run rather than trusted from this
// comment.
//
// THE OTHER HALF: A SESSION WITH NO THEME MUST RENDER EXACTLY AS BEFORE.
// Three outcomes, not two - no theme set, an id the registry does not
// know, and a registry that has not finished loading are all "leave the
// row alone", never a default colour. `attrs()` returns '' for all
// three, the row carries no `data-session-theme`, and not one rule in
// session-theme-tint.css can match it.
//
// Run with: node tests/test_session_theme_tint.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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

// ---------------------------------------------------------------------
// Colour maths. Plain alpha compositing and WCAG 2 relative luminance.
// ---------------------------------------------------------------------

/**
 * Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` into channels.
 * @param {string} text  A CSS colour from a theme manifest.
 * @returns {[number, number, number, number]} r, g, b in 0-255 and alpha.
 */
function parseColor(text) {
    const s = String(text).trim();
    if (s.startsWith('#')) {
        let h = s.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const n = parseInt(h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    const m = s.match(/rgba?\(([^)]*)\)/);
    assert.ok(m, `unparseable colour: ${text}`);
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/**
 * Composite one colour over an opaque background.
 * @param {number[]} c  Source colour with alpha.
 * @param {number[]} bg  Opaque backdrop.
 * @returns {number[]} The resulting opaque colour.
 */
function over(c, bg) {
    return [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3]));
}

/**
 * WCAG 2 relative luminance.
 * @param {number[]} c  An opaque colour.
 * @returns {number} Luminance in [0, 1].
 */
function luminance(c) {
    const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/**
 * WCAG 2 contrast ratio between two opaque colours.
 * @param {number[]} a  First colour.
 * @param {number[]} b  Second colour.
 * @returns {number} Ratio in [1, 21].
 */
function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------------
// Fixtures: every bundled theme, and the module under test in a sandbox.
// ---------------------------------------------------------------------

// Two themes (corporate_v2, legacy_windows) do not declare
// --color-accent-bg / --color-accent-bg-soft at all, so the browser
// resolves them from the :root block in styles.css. Model that rather
// than inventing a fallback, or the sweep silently measures a surface
// no one ever renders.
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'client', 'css', 'styles.css'), 'utf8');

/**
 * Read one custom property's value from the `:root` block in styles.css.
 * @param {string} name  Property name including the leading `--`.
 * @returns {string} The declared value.
 */
function rootVar(name) {
    const m = BASE_CSS.match(new RegExp(`${name}:\\s*([^;]+);`));
    assert.ok(m, `${name} is not declared in styles.css :root`);
    return m[1].trim();
}

const THEME_DIR = path.join(ROOT, 'client', 'css', 'themes');
const THEMES = fs.readdirSync(THEME_DIR)
    .filter((d) => fs.existsSync(path.join(THEME_DIR, d, 'theme.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(THEME_DIR, d, 'theme.json'), 'utf8')));

/**
 * Load session-theme-tint.js into a sandbox with a stubbed registry.
 * @param {?Array<object>} manifests  What Themes.listAll() returns, or
 *   null to simulate the registry not being loaded at all.
 * @returns {object} The sandbox window.
 */
function load(manifests) {
    const sandbox = { console: { log() {}, warn() {}, error() {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    if (manifests !== null) {
        sandbox.Themes = { listAll: () => manifests };
    }
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'session-theme-tint.js'), 'utf8'),
        sandbox,
    );
    return sandbox;
}

const tint = load(THEMES).SessionThemeTint;
const tintCss = fs.readFileSync(path.join(ROOT, 'client', 'css', 'session-theme-tint.css'), 'utf8');

// ---------------------------------------------------------------------
// 1. THE CONTRAST SWEEP. 529 pairs, run for real.
// ---------------------------------------------------------------------

/**
 * The three row surfaces a wash could sit on, for one host theme: the
 * plain sidebar row (transparent over the panel), the active sidebar row
 * (accent-bg over it), and the home row (accent-bg-soft over it), each
 * paired with the text colour that row's name actually uses.
 * @param {object} vars  One theme's cssVars.
 * @returns {Array<{tag: string, base: number[], text: number[]}>}
 */
function surfaces(vars) {
    const bg = parseColor(vars['--color-bg']);
    const fg = parseColor(vars['--color-fg']);
    const accent = parseColor(vars['--color-accent']);
    const activeBg = over(
        parseColor(vars['--color-accent-bg'] || rootVar('--color-accent-bg')), bg);
    const homeBg = over(
        parseColor(vars['--color-accent-bg-soft'] || rootVar('--color-accent-bg-soft')), bg);
    return [
        { tag: 'sidebar', base: bg, text: fg },
        { tag: 'sidebar-active', base: activeBg, text: fg },
        { tag: 'home', base: homeBg, text: accent },
    ];
}

/**
 * Sweep every (host theme, session theme) pair at one alpha.
 * @param {number} alpha  Wash alpha.
 * @param {string[]} tags  Which surfaces the wash is applied to.
 * @returns {{broken: string[], worstKept: number}} Pairs that were above
 *   4.5:1 unwashed and fall below washed, and the lowest surviving ratio.
 */
function sweep(alpha, tags) {
    const broken = [];
    let worstKept = Infinity;
    for (const host of THEMES) {
        for (const surface of surfaces(host.cssVars)) {
            if (tags.indexOf(surface.tag) === -1) continue;
            const before = contrast(surface.text, surface.base);
            if (before < 4.5) continue;  // pre-existing, not ours to judge
            for (const session of THEMES) {
                const accent = parseColor(session.cssVars['--color-accent']);
                const washed = over([accent[0], accent[1], accent[2], alpha], surface.base);
                const after = contrast(surface.text, washed);
                if (after < 4.5) {
                    broken.push(`${host.id}/${session.id}/${surface.tag} `
                        + `${before.toFixed(2)}->${after.toFixed(2)}`);
                } else if (after < worstKept) {
                    worstKept = after;
                }
            }
        }
    }
    return { broken, worstKept };
}

test('the sweep covers every theme pair, so it is not a spot check', () => {
    assert.ok(THEMES.length >= 23, `expected 23+ themes, found ${THEMES.length}`);
    for (const t of THEMES) {
        for (const v of ['--color-bg', '--color-fg', '--color-accent']) {
            assert.ok(t.cssVars && t.cssVars[v], `${t.id} is missing ${v}`);
        }
    }
    // The two overlay tints are optional in a manifest; every surface in
    // the sweep must still resolve to a real colour.
    for (const t of THEMES) {
        for (const s of surfaces(t.cssVars)) {
            assert.ok(s.base.every((v) => Number.isFinite(v)),
                `${t.id} ${s.tag} did not resolve to a colour`);
        }
    }
});

test('the sidebar wash costs no theme pair its 4.5:1', () => {
    const { broken, worstKept } = sweep(tint.WASH_ALPHA, ['sidebar', 'sidebar-active']);
    assert.deepEqual(broken, [],
        'these pairs are legible unwashed and illegible washed');
    assert.ok(worstKept >= 4.5, `worst surviving ratio ${worstKept.toFixed(2)}`);
});

test('the chosen alpha is the constraint, not a preference', () => {
    // If a bigger alpha were also safe, the value would be arbitrary and
    // this whole sweep would be decoration. 0.14 breaks three pairs.
    const bigger = sweep(0.14, ['sidebar', 'sidebar-active']);
    assert.ok(bigger.broken.length > 0,
        'a larger wash must be demonstrably unsafe, or 0.10 is unmotivated');
});

test('no alpha is safe for the home row, which is why it has no wash', () => {
    for (const alpha of [0.03, 0.10]) {
        const { broken } = sweep(alpha, ['home']);
        assert.ok(broken.length > 0,
            `alpha ${alpha} looks safe on the home row; if that is now true the `
            + 'no-wash decision needs revisiting rather than silently keeping');
    }
    assert.doesNotMatch(
        tintCss,
        /\.running-session-row\[data-session-theme\][^{]*\{[^}]*background-image/,
        'the home row must not carry the wash');
});

// ---------------------------------------------------------------------
// 2. What a themed row gets, and what an unthemed one does not.
// ---------------------------------------------------------------------

test('a themed row carries the theme id and its three colours', () => {
    const out = tint.attrs('dracula');
    assert.match(out, /data-session-theme="dracula"/);
    // dracula --color-accent is #bd93f9.
    assert.match(out, /--session-theme-accent: rgb\(189, 147, 249\)/);
    assert.match(out, /--session-theme-wash: rgba\(189, 147, 249, 0\.1\)/);
    assert.match(out, /--session-theme-ring: rgba\(189, 147, 249, 0\.45\)/);
});

test('all three not-themed cases render exactly as today', () => {
    assert.equal(tint.attrs(null), '', 'no theme set');
    assert.equal(tint.attrs(undefined), '', 'field absent');
    assert.equal(tint.attrs('no-such-theme'), '', 'id the registry does not know');
    const noRegistry = load(null).SessionThemeTint;
    assert.equal(noRegistry.attrs('dracula'), '',
        'the registry loads asynchronously; an early paint must degrade to '
        + 'the plain row, never to a default colour');
});

test('an unknown id is not cached, because the registry fills in later', () => {
    const sandbox = load([]);
    assert.equal(sandbox.SessionThemeTint.attrs('dracula'), '');
    sandbox.Themes.listAll = () => THEMES;
    assert.match(sandbox.SessionThemeTint.attrs('dracula'), /data-session-theme/,
        'a miss must stay askable on the next paint');
});

test('a theme id cannot break out of the attribute it is written into', () => {
    const out = tint.attrs('dracula" onload="alert(1)');
    assert.equal(out, '',
        'the id is scrubbed to [A-Za-z0-9_-], and a scrubbed id that does not '
        + 'match a manifest yields nothing at all');
});

// ---------------------------------------------------------------------
// 3. The CSS. Two declarations here are load-bearing and both look like
//    style choices.
// ---------------------------------------------------------------------

test('the wash is a background-image, so hover and active survive it', () => {
    assert.match(tintCss, /background-image:\s*linear-gradient\(/,
        'a `background` shorthand would discard the row background-color '
        + 'that carries hover and the active-row highlight');
    assert.doesNotMatch(tintCss, /\n\s*background:\s/,
        'no background shorthand anywhere in this file');
});

test('the rail and ring are inset shadows, not borders', () => {
    assert.match(tintCss, /box-shadow:\s*[\s\S]*inset 3px 0 0 var\(--session-theme-accent\)/,
        'a border-left here would fight .running-session-row.owned/.external, '
        + 'which already own that border to encode ownership');
    assert.match(tintCss, /inset 0 0 0 1px var\(--session-theme-ring\)/);
});

test('the stylesheet loads last, which is what makes it win', () => {
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
    const tintAt = html.indexOf('session-theme-tint.css');
    const sidebarAt = html.indexOf('session-sidebar.css');
    const stylesAt = html.indexOf('css/styles.css');
    assert.ok(tintAt > -1, 'session-theme-tint.css is not linked at all');
    assert.ok(tintAt > sidebarAt && tintAt > stylesAt,
        'it competes at equal specificity with row backgrounds in both, so '
        + 'source order is the whole mechanism');
    assert.ok(html.indexOf('js/session-theme-tint.js') < html.indexOf('js/launchpad.js'),
        'launchpad.js calls window.SessionThemeTint');
});

// ---------------------------------------------------------------------
// 4. Both row templates use it, and the sidebar repaints on a re-theme.
// ---------------------------------------------------------------------

test('both surfaces splice the attributes into their row', () => {
    for (const file of ['session-sidebar-rows.js', 'launchpad.js']) {
        const src = fs.readFileSync(path.join(ROOT, 'client', 'js', file), 'utf8');
        assert.match(src, /window\.SessionThemeTint\s*\?\s*window\.SessionThemeTint\.attrs\(/,
            `${file} must ask for the attributes and tolerate the module being absent`);
        assert.match(src, /\$\{themeAttrs\}/, `${file} must splice them into the row`);
    }
});

test('re-theming a session repaints the sidebar list', () => {
    const src = fs.readFileSync(
        path.join(ROOT, 'client', 'js', 'session-sidebar-rows.js'), 'utf8');
    const sig = src.slice(src.indexOf('function signature'));
    assert.match(sig.slice(0, sig.indexOf('\n    }')), /theme: r\.pinned_theme/,
        'the sidebar skips the DOM rewrite when its row signature is unchanged, '
        + 'so a theme it does not fingerprint leaves every row stale');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
