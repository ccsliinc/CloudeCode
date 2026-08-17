// Node tests for where the connection light is allowed to live.
//
// THE RULE. The status light is OUT of the top header entirely. A screen
// that has bottom furniture carries the light there - the home screen's
// `.home-bar` already did. A screen that has none shows no light.
//
// THE ONE SCREEN THAT ARGUES WITH THE RULE, AND WHAT WAS DECIDED. The
// terminal screen deliberately has no bottom bar: it clawed its usable
// height back from 720 to 770 of 786px and is not paying any of that back
// for chrome. But a running session is exactly when a dropped socket
// matters most, so "no bar therefore no light" there would blind the user
// at the worst moment. The decision: the terminal gets the light as a
// RAIL item, not a bar item - `position: fixed` on the same right-hand
// column as #sessionEditorBtn, one slot below it, costing zero vertical
// layout space. The auth screen gets neither bar nor rail and therefore
// no light, which is the rule applied honestly rather than an oversight.
//
// WHAT THESE TESTS HOLD DOWN:
//   (a) the light is not in `.header .controls`, and app.js does not
//       reach for that container any more;
//   (b) there is still exactly ONE #statusText node. It is RE-PARENTED,
//       never cloned, because app.js and terminal.js both write it by id -
//       a copy means one writer updating an invisible node;
//   (c) the rail cannot quietly grow into the bottom bar the terminal
//       refused. No background, no border, no height: one dot;
//   (d) the rail's tooltip is right-anchored. Centred + nowrap runs off
//       screen from a dot 26px in from the right edge, and the tooltip is
//       the ONLY way to read the status text on this screen.
//
// Run with: node tests/test_status_light_placement.node.mjs

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
 * Read one stylesheet from client/css.
 * @param {string} name  File name, e.g. `terminal-tools.css`.
 * @returns {string} File contents.
 */
function css(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'css', name), 'utf8');
}

/**
 * Read one script from client/js.
 * @param {string} name  File name, e.g. `app.js`.
 * @returns {string} File contents.
 */
function js(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'js', name), 'utf8');
}

/**
 * Strip `/* ... *\/` comments so a prose mention of a selector cannot
 * satisfy an assertion meant for a declaration.
 * @param {string} sheet  Full stylesheet text.
 * @returns {string} The stylesheet with comments removed.
 */
function stripCssComments(sheet) {
    return sheet.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Declaration block of the first rule whose selector matches exactly.
 * @param {string} sheet  Full stylesheet text (comments already stripped).
 * @param {string} selector  Exact selector, e.g. `.status-rail`.
 * @returns {string} The text between that rule's braces.
 */
function ruleBody(sheet, selector) {
    const re = new RegExp(
        `(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
    );
    const m = sheet.match(re);
    assert.ok(m, `expected a rule for selector "${selector}"`);
    return m[1];
}

const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const appJs = js('app.js');
const launchpadJs = js('launchpad.js');
const tools = stripCssComments(css('terminal-tools.css'));
const iosChrome = stripCssComments(css('ios-chrome.css'));

/* ---------------------------------------------------------------------------
 * 1. The light is out of the header, and there is still only one of it
 * ------------------------------------------------------------------------- */

test('exactly one #statusText node exists in the whole client', () => {
    const inHtml = (html.match(/id="statusText"/g) || []).length;
    assert.equal(inHtml, 1, 'the light is moved between screens, never cloned');
    const jsDir = path.join(__dirname, '..', 'client', 'js');
    for (const name of fs.readdirSync(jsDir)) {
        if (!name.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(jsDir, name), 'utf8');
        assert.doesNotMatch(
            src, /id="statusText"/,
            `${name} renders a second copy - both writers address it by id`);
    }
    assert.doesNotMatch(launchpadJs, /id="statusText"/, 'the home bar mounts the node, it does not render one');
});

test('#statusText is not inside .header .controls', () => {
    const controlsStart = html.indexOf('<div class="controls">');
    assert.ok(controlsStart !== -1, 'expected the header controls row');
    // The controls row ends at the first `</div>` that closes it, but the
    // row contains nested elements, so bound the search by the light's own
    // container instead: the rail is declared far later in the file, after
    // every screen element. Asserting the ORDER is what proves it is out of
    // the header - the header block is entirely above the screens.
    const railStart = html.indexOf('<div class="status-rail" id="status-rail">');
    assert.ok(railStart !== -1, 'expected the #status-rail container');
    const statusAt = html.indexOf('id="statusText"');
    assert.ok(statusAt > railStart, 'the light must be inside the rail, not the header row');
    const terminalScreenAt = html.indexOf('<div id="terminal-screen"');
    assert.ok(terminalScreenAt !== -1, 'expected the terminal screen element');
    assert.ok(
        railStart > terminalScreenAt,
        'the rail is body-level chrome declared after the screens, not a header child');
});

test('#statusText stays focusable so a tap can reveal its text', () => {
    const tag = html.match(/<span class="status" id="statusText"[^>]*>/);
    assert.ok(tag, 'expected the status span');
    assert.match(tag[0], /tabindex="0"/, 'hover does not exist on a phone');
    assert.match(tag[0], /role="status"/, 'it announces live state');
});

/* ---------------------------------------------------------------------------
 * 2. app.js places it in a bar or a rail, never the header
 * ------------------------------------------------------------------------- */

test('_placeStatusLight targets the home bar and the rail, and nothing else', () => {
    const start = appJs.indexOf('_placeStatusLight(screen) {');
    assert.ok(start !== -1, 'the function must exist');
    const body = appJs.slice(start, appJs.indexOf('\n    }', start));
    assert.match(body, /getElementById\('home-bar-status'\)/, 'home screen goes in the bar');
    assert.match(body, /getElementById\('status-rail'\)/, 'every other screen goes on the rail');
    assert.doesNotMatch(
        body, /\.header \.controls/,
        'the header is not a home for the light any more');
});

test('all three screens still place the light', () => {
    for (const screen of ['auth', 'launchpad', 'terminal']) {
        assert.match(
            appJs,
            new RegExp(`_placeStatusLight\\('${screen}'\\)`),
            `${screen} must place the light - an unplaced node is a stale one`);
    }
});

/* ---------------------------------------------------------------------------
 * 3. The rail costs no vertical space and cannot become a bar
 * ------------------------------------------------------------------------- */

test('the rail is fixed to the FAB column, one slot below the editor button', () => {
    const body = ruleBody(tools, '.status-rail');
    assert.match(body, /position:\s*fixed/, 'fixed, so it takes no layout height from the terminal');
    assert.match(body, /right:\s*var\(--fab-slot-0\)/, 'same right-hand column as the FABs');
    assert.match(
        body, /top:\s*calc\(var\(--fab-top-edge\)\s*\+\s*var\(--fab-size\)\s*\+\s*var\(--fab-gap\)\)/,
        'derived from the FAB tokens, never a hardcoded offset that drifts');
    assert.match(body, /z-index:\s*60/, 'must clear terminal output, same layer as the FABs');
});

test('the rail cannot quietly grow into the bottom bar the terminal refused', () => {
    const body = ruleBody(tools, '.status-rail');
    assert.doesNotMatch(body, /(^|[\s;])background\s*:/, 'a background makes it a bar');
    assert.doesNotMatch(body, /(^|[\s;])border(-top|-bottom)?\s*:/, 'a border makes it a bar');
    assert.doesNotMatch(body, /(^|[\s;])height\s*:/, 'a declared height makes it a bar');
    assert.doesNotMatch(body, /(^|[\s;])bottom\s*:/, 'it is a top rail item, not bottom furniture');
});

test('the rail does not eat clicks meant for the terminal underneath', () => {
    assert.match(ruleBody(tools, '.status-rail'), /pointer-events:\s*none/);
    assert.match(ruleBody(tools, '.status-rail > .status'), /pointer-events:\s*auto/);
});

test('the rail is absent on the screens that have no session', () => {
    // The home screen's light is in the bar; the auth screen has no bar and
    // therefore no light at all. Same `:has()` screen scoping the FABs use.
    assert.match(
        tools,
        /body:has\(#launchpad-screen\.active\) \.status-rail,\s*\n\s*body:has\(#auth-screen\.active\) \.status-rail \{[^}]*display:\s*none/,
        'both no-session screens must hide the rail');
    assert.match(ruleBody(tools, '.status-rail:empty'), /display:\s*none/,
        'an empty rail collapses rather than sitting invisible');
});

/* ---------------------------------------------------------------------------
 * 4. The tooltip is the only way to read the status on this screen
 * ------------------------------------------------------------------------- */

test('the rail tooltip is right-anchored so it cannot run off screen', () => {
    const body = ruleBody(tools, '.status-rail .status::after');
    assert.match(body, /left:\s*auto/, 'the shared rule centres it - that must be undone here');
    assert.match(body, /right:\s*0/, 'anchor the right edge to the dot and grow leftwards');
    assert.match(body, /transform:\s*none/, 'the shared translateX would re-centre it');
    assert.match(body, /max-width:\s*calc\(100vw/, 'capped at the viewport');
});

/* ---------------------------------------------------------------------------
 * 5. Standalone (home-screen) mode pays the same top inset as the button
 *    above it
 * ------------------------------------------------------------------------- */

test('the rail pays the safe-area top inset in standalone mode', () => {
    const body = ruleBody(iosChrome, '.status-rail');
    assert.match(body, /env\(safe-area-inset-top\)/,
        'the editor FAB above it moves down by the inset; without this they overlap');
    assert.match(body, /var\(--fab-size\)/, 'still one slot below that button');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
