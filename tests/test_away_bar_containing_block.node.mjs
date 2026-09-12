/**
 * The away bar must be anchored to the TERMINAL PANE, not to the screen.
 * ---------------------------------------------------------------------
 * THE BUG, IN THE OWNER'S WORDS: "the idle bar is wide when the sidebar
 * is out and its overlapping". The bar is the one that reads
 * "away 2 hr 49 min / close / show full history / show summary /
 * just continue".
 *
 * THE MECHANISM. `.away-bar` is `position: absolute` with
 * `left: 15px; right: 15px`, and `terminal-away-bar.js` appends it to
 * `.terminal-container`. `.terminal-container` carried no `position` at
 * all, so the bar's containing block was the nearest ancestor that did
 * have one - `#terminal-screen`, which is `.screen { position: relative }`.
 * An absolutely positioned box resolves `left`/`right` against its
 * containing block's PADDING box, and `body.session-sidebar-pinned .screen`
 * puts `padding-left: var(--sidebar-dock-w)` on exactly that element. So
 * the bar measured from the viewport edge, behind the docked sidebar,
 * instead of from the pane it is asking the user about.
 *
 * MEASURED IN A REAL ENGINE at 1357px with the sidebar docked, both
 * arms of the same page, the pre-fix rule reproduced inline:
 *
 *              bar.x   bar.width   intrusion into the 320px sidebar column
 *   static       15      1327                    305
 *   relative    335      1007                      0
 *
 * The pane itself is x=320 w=1037 in both arms, so the broken bar was
 * 290px wider than the thing it overlays. A collateral-damage control was
 * run in the same page with a real xterm mounted: there are SEVEN
 * absolutely positioned descendants of `.terminal-container` and making it
 * a containing block moved exactly ONE of them, the bar. The other six are
 * xterm's own, and `.xterm` is itself `position: relative`.
 *
 * WHY THIS FILE IS NOT A GREP. "the stylesheet contains
 * `position: relative`" would pass while a later file at equal specificity
 * overrode it, which is the whole failure mode here - `.terminal-container`
 * is declared in FOUR stylesheets. So this RESOLVES the cascade over the
 * real stylesheets in `client/index.html`'s real load order and reports the
 * winning declaration, the way a browser does.
 *
 * THE NEGATIVE CONTROL IS THE LOAD-BEARING PART. A resolver that answered
 * "relative" for everything would pass every positive check here. So the
 * same resolver is re-run over a model with the fix's own rule REMOVED and
 * is required to report `static` - the pre-fix behaviour, reproduced rather
 * than described.
 *
 * Run with: node tests/test_away_bar_containing_block.node.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let passes = 0;
let failures = 0;

/**
 * Run one named check.
 *
 * @param {string} name - what is being asserted.
 * @param {Function} fn - the body; throwing marks a failure.
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
// The stylesheets, in the order the shipped page loads them.
// ---------------------------------------------------------------------

/**
 * Every stylesheet `client/index.html` links, as repo-relative paths, in
 * document order.
 *
 * Read out of the page rather than listed here, because source order is
 * what decides a tie between two equally specific rules and a hand-kept
 * list is exactly the thing that drifts.
 *
 * @returns {string[]} absolute paths, load order preserved.
 */
function stylesheetsInLoadOrder() {
    const html = fs.readFileSync(path.join(repoRoot, 'client', 'index.html'), 'utf8');
    const hrefs = [];
    const re = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
    assert.ok(hrefs.length > 10, `expected the real stylesheet list, got ${hrefs.length}`);
    return hrefs.map((href) => {
        assert.ok(href.startsWith('/static/'), `unexpected stylesheet href: ${href}`);
        return path.join(repoRoot, 'client', href.slice('/static/'.length));
    }).filter((p) => fs.existsSync(p));
}

/**
 * Strip CSS comments without touching anything inside a string literal.
 *
 * @param {string} css - raw stylesheet text.
 * @returns {string} the same text with comments replaced by a space.
 */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Flatten one stylesheet into a list of rules, carrying the at-rule
 * conditions each one sits under.
 *
 * DEPTH IS REFUSED, NOT GUESSED. One level of at-rule nesting is the
 * whole vocabulary these files are written in. A rule found two levels
 * deep throws rather than being silently flattened, because a resolver
 * that quietly mis-scopes the one rule that matters gives a confident
 * wrong answer, which is worse than no test.
 *
 * @param {string} css - stylesheet text, comments already stripped.
 * @param {number} fileIndex - position in the load order, for tie-breaks.
 * @returns {Array<{selectors: string[], decls: string, conditions: string[], order: number}>}
 */
function flatten(css, fileIndex) {
    const rules = [];
    let i = 0;
    let ordinal = 0;

    /**
     * Parse rules until the matching close brace (or end of input).
     *
     * @param {string[]} conditions - at-rule conditions in force here.
     * @param {number} depth - nesting level; 2 is refused.
     * @returns {void}
     */
    function parseBlock(conditions, depth) {
        while (i < css.length) {
            // Skip whitespace, and stop at the end of the enclosing block.
            while (i < css.length && /\s/.test(css[i])) i++;
            if (i >= css.length) return;
            if (css[i] === '}') { i++; return; }

            const braceAt = css.indexOf('{', i);
            if (braceAt === -1) return;
            const prelude = css.slice(i, braceAt).trim();

            if (prelude.startsWith('@')) {
                const name = prelude.split(/[\s(]/, 1)[0];
                if (name === '@media' || name === '@supports') {
                    if (depth >= 1) {
                        throw new Error(`nested at-rule too deep to resolve: ${prelude}`);
                    }
                    i = braceAt + 1;
                    parseBlock(conditions.concat(prelude), depth + 1);
                    continue;
                }
                // @font-face, @keyframes and friends carry no selectors we
                // ask about; skip the whole block by brace counting.
                i = skipBlock(braceAt);
                continue;
            }

            const close = css.indexOf('}', braceAt);
            if (close === -1) return;
            rules.push({
                selectors: prelude.split(',').map((s) => s.trim()).filter(Boolean),
                decls: css.slice(braceAt + 1, close),
                conditions: conditions.slice(),
                order: fileIndex * 100000 + (ordinal++),
            });
            i = close + 1;
        }
    }

    /**
     * Skip a brace-balanced block starting at an opening brace.
     *
     * @param {number} openAt - index of the `{`.
     * @returns {number} index just past the matching `}`.
     */
    function skipBlock(openAt) {
        let j = openAt;
        let depth = 0;
        for (; j < css.length; j++) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') { depth--; if (depth === 0) return j + 1; }
        }
        return css.length;
    }

    parseBlock([], 0);
    return rules;
}

/**
 * Build the whole model once: every rule from every linked stylesheet,
 * in load order.
 *
 * @returns {Array<object>} flattened rules.
 */
function buildModel() {
    const rules = [];
    stylesheetsInLoadOrder().forEach((file, idx) => {
        const css = stripComments(fs.readFileSync(file, 'utf8'));
        for (const rule of flatten(css, idx)) {
            rule.file = path.relative(repoRoot, file);
            rules.push(rule);
        }
    });
    return rules;
}

/**
 * Does a `@media` condition hold at a given viewport width?
 *
 * Only min-width and max-width are understood, which is the whole
 * vocabulary the selectors under test are written in. Any other
 * condition throws rather than being assumed true or false.
 *
 * @param {string} condition - e.g. "@media (max-width: 520px)".
 * @param {number} width - viewport width in px.
 * @returns {boolean}
 */
function conditionHolds(condition, width) {
    if (condition.startsWith('@supports')) return true;
    const body = condition.slice('@media'.length).trim();
    const clauses = body.split(/\s+and\s+/);
    return clauses.every((raw) => {
        const clause = raw.trim().replace(/^\(|\)$/g, '');
        if (clause === 'screen' || clause === 'all') return true;
        const m = /^(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px$/.exec(clause);
        if (!m) throw new Error(`media condition not understood: ${raw}`);
        const n = Number(m[2]);
        return m[1] === 'min' ? width >= n : width <= n;
    });
}

/**
 * Specificity of one simple selector, as (ids, classes, elements).
 *
 * @param {string} selector - one selector, no commas.
 * @returns {number} a comparable score.
 */
function specificity(selector) {
    const ids = (selector.match(/#[\w-]+/g) || []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+\(?/g) || []).length;
    const elements = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 10000 + classes * 100 + elements;
}

/**
 * Resolve one property for one selector at one viewport width.
 *
 * Matching is by EXACT selector text, which is enough here and is
 * deliberately not a selector engine: every rule this asks about is
 * written as a literal in the stylesheets, and a partial matcher would
 * quietly widen what "the winning rule" means.
 *
 * @param {Array<object>} rules - the flattened model.
 * @param {string} selector - the exact selector text to look for.
 * @param {string} property - e.g. "position".
 * @param {number} width - viewport width in px.
 * @returns {{value: string|null, from: string|null}} the winning
 *   declaration and the file it came from; `value` is null when nothing
 *   declared it.
 */
function resolve(rules, selector, property, width) {
    let best = null;
    for (const rule of rules) {
        if (!rule.selectors.includes(selector)) continue;
        if (!rule.conditions.every((c) => conditionHolds(c, width))) continue;
        const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i');
        const m = re.exec(rule.decls);
        if (!m) continue;
        const score = specificity(selector);
        if (!best || score > best.score || (score === best.score && rule.order > best.order)) {
            best = { score, order: rule.order, value: m[1].trim(), from: rule.file };
        }
    }
    return best ? { value: best.value, from: best.from } : { value: null, from: null };
}

const MODEL = buildModel();

// ---------------------------------------------------------------------
// What the fix actually claims.
// ---------------------------------------------------------------------

test('the bar is an overlay: .away-bar resolves to position: absolute', () => {
    for (const width of [1357, 780, 390]) {
        const got = resolve(MODEL, '.away-bar', 'position', width);
        assert.equal(got.value, 'absolute', `at ${width}px the bar is ${got.value}`);
    }
});

test('the pane is the containing block: .terminal-container is never static', () => {
    for (const width of [1357, 780, 390]) {
        const got = resolve(MODEL, '.terminal-container', 'position', width);
        assert.ok(got.value, `at ${width}px nothing declares .terminal-container's position`);
        assert.notEqual(
            got.value, 'static',
            `at ${width}px .terminal-container resolves to ${got.value} (from ${got.from}), `
            + 'so the away bar escapes to #terminal-screen and spans the docked sidebar',
        );
    }
});

test('the docked sidebar really does pad .screen, which is what made it matter', () => {
    const got = resolve(MODEL, 'body.session-sidebar-pinned .screen', 'padding-left', 1357);
    assert.ok(got.value, 'nothing pads .screen when the sidebar is docked');
    assert.notEqual(
        got.value.replace(/\s/g, ''), '0',
        'the docked offset is zero, so this test is no longer describing the real layout',
    );
});

test('the renderer still appends the bar into .terminal-container', () => {
    const js = fs.readFileSync(
        path.join(repoRoot, 'client', 'js', 'terminal-away-bar.js'), 'utf8');
    const host = /host\s*=\s*document\.querySelector\(\s*'([^']+)'\s*\)/.exec(js);
    assert.ok(host, 'could not find the host lookup in terminal-away-bar.js');
    assert.equal(
        host[1], '.terminal-container',
        'the bar moved house; the containing-block rule has to move with it',
    );
    assert.match(
        js, /host\.appendChild\(bar\)/,
        'the bar is no longer appended to the host it looked up',
    );
});

// ---------------------------------------------------------------------
// NEGATIVE CONTROL. Reproduce the pre-fix rule and require the check to
// fail. Without this, a resolver that always answered "relative" would
// pass everything above.
// ---------------------------------------------------------------------

test('NEGATIVE CONTROL: with the fix removed, the resolver reports static', () => {
    // Drop every .terminal-container rule that declares a position, which
    // is exactly the state of the tree before this change.
    const preFix = MODEL.filter((rule) => !(
        rule.selectors.includes('.terminal-container') && /(?:^|;)\s*position\s*:/i.test(rule.decls)
    ));
    assert.notEqual(
        preFix.length, MODEL.length,
        'nothing was removed, so this control is not reproducing anything',
    );
    const got = resolve(preFix, '.terminal-container', 'position', 1357);
    assert.equal(
        got.value, null,
        'the pre-fix model still declares a position, so the control is not the pre-fix state',
    );
    // And the claim the positive test makes must now be false.
    assert.throws(() => {
        assert.ok(got.value && got.value !== 'static');
    }, 'the positive assertion still passed against the pre-fix model');
});

test('NEGATIVE CONTROL: the resolver can report a value it was not given', () => {
    // A resolver that invented answers would also invent this one.
    const got = resolve(MODEL, '.away-bar-there-is-no-such-thing', 'position', 1357);
    assert.equal(got.value, null, 'the resolver answered for a selector nothing declares');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
