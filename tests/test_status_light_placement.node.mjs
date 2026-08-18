// Node tests for where the connection light is allowed to live.
//
// THE RULE. The status light is OUT of the top header entirely, and out
// from under the session tools (the FAB column) too. A screen that has
// bottom furniture carries the light there. The home screen's `.home-bar`
// already does. The terminal screen has no full bottom bar - it clawed its
// usable height back from 720 to 770 of 786px and is not paying any of
// that back for chrome - so it gets a MINIMAL bar of its own instead: a
// small `position: fixed` chip pinned to the bottom-LEFT corner, well
// clear of the FAB column on the right. Fixed positioning means it still
// costs zero vertical layout space. The auth screen has neither a bar nor
// this chip and therefore shows no light, which is the rule applied
// honestly rather than an oversight.
//
// WHAT THESE TESTS HOLD DOWN:
//   (a) the light is not in `.header .controls`, and app.js does not
//       reach for that container any more;
//   (b) there is still exactly ONE #statusText node. It is RE-PARENTED,
//       never cloned, because app.js and terminal.js both write it by id -
//       a copy means one writer updating an invisible node;
//   (c) the terminal bar sits bottom-LEFT, well clear of the FAB column,
//       so it does not read as a control stacked under the session tools;
//   (d) the terminal bar's tooltip grows upward and rightward from the
//       dot, capped at the viewport, so it cannot run off either edge;
//   (e) #status-rail is gone entirely - no markup, no CSS, no references.
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
 * @param {string} selector  Exact selector, e.g. `.terminal-status-bar`.
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
const configDrawer = stripCssComments(css('config-drawer.css'));

/* ---------------------------------------------------------------------------
 * 0. #status-rail is gone entirely - not resurrected under its old name
 * ------------------------------------------------------------------------- */

test('#status-rail no longer exists anywhere in the client', () => {
    assert.doesNotMatch(html, /status-rail/, 'index.html still names the retired rail');
    assert.doesNotMatch(tools, /status-rail/, 'terminal-tools.css still has rail rules');
    assert.doesNotMatch(iosChrome, /status-rail/, 'ios-chrome.css still has rail rules');
    assert.doesNotMatch(configDrawer, /status-rail/, 'config-drawer.css still has rail rules');
    assert.doesNotMatch(appJs, /status-rail/, 'app.js still targets the rail by id');
});

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
    // container instead: the bar is declared far later in the file, after
    // every screen element. Asserting the ORDER is what proves it is out of
    // the header - the header block is entirely above the screens.
    const barStart = html.indexOf('<div class="terminal-status-bar" id="terminal-status-bar">');
    assert.ok(barStart !== -1, 'expected the #terminal-status-bar container');
    const statusAt = html.indexOf('id="statusText"');
    assert.ok(statusAt > barStart, 'the light must be inside the bar, not the header row');
    const terminalScreenAt = html.indexOf('<div id="terminal-screen"');
    assert.ok(terminalScreenAt !== -1, 'expected the terminal screen element');
    assert.ok(
        barStart > terminalScreenAt,
        'the bar is body-level chrome declared after the screens, not a header child');
});

test('#statusText stays focusable so a tap can reveal its text', () => {
    const tag = html.match(/<span class="status" id="statusText"[^>]*>/);
    assert.ok(tag, 'expected the status span');
    assert.match(tag[0], /tabindex="0"/, 'hover does not exist on a phone');
    assert.match(tag[0], /role="status"/, 'it announces live state');
});

/* ---------------------------------------------------------------------------
 * 2. app.js places it in a bar, never the header, never the FAB rail
 * ------------------------------------------------------------------------- */

test('_placeStatusLight targets the home bar and the terminal bar, and nothing else', () => {
    const start = appJs.indexOf('_placeStatusLight(screen) {');
    assert.ok(start !== -1, 'the function must exist');
    const body = appJs.slice(start, appJs.indexOf('\n    }', start));
    assert.match(body, /getElementById\('home-bar-status'\)/, 'home screen goes in the bar');
    assert.match(body, /getElementById\('terminal-status-bar'\)/, 'every other screen goes in the terminal bar');
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
 * 3. The terminal bar costs no vertical space and sits clear of the FABs
 * ------------------------------------------------------------------------- */

test('the terminal bar is fixed to the bottom-LEFT corner, not the FAB column', () => {
    const body = ruleBody(tools, '.terminal-status-bar');
    assert.match(body, /position:\s*fixed/, 'fixed, so it takes no layout height from the terminal');
    assert.match(body, /left:\s*var\(--fab-edge\)/, 'the left edge, opposite the right-hand FAB column');
    assert.match(body, /bottom:\s*var\(--fab-edge\)/, 'the bottom edge, not stacked under the session tools');
    assert.doesNotMatch(body, /right\s*:/, 'must not sit in the FAB column on the right');
    assert.doesNotMatch(body, /top\s*:/, 'must not sit in the top-right rail any more');
    assert.match(body, /z-index:\s*60/, 'must clear terminal output, same layer as the FABs');
});

test('the terminal bar reads as a bar - a real box, not a bare dot', () => {
    const body = ruleBody(tools, '.terminal-status-bar');
    assert.match(body, /background\s*:/, 'a real bar has a background');
    assert.match(body, /border\s*:/, 'a real bar has a border, matching the FAB chrome');
    assert.match(body, /border-radius:\s*var\(--radius-md\)/, 'radius-md, never a pill/oval shape');
});

test('the terminal bar is absent on the screens that have no session', () => {
    // The home screen's light is in the bar; the auth screen has no bar and
    // therefore no light at all. Same `:has()` screen scoping the FABs use.
    assert.match(
        tools,
        /body:has\(#launchpad-screen\.active\) \.terminal-status-bar,\s*\n\s*body:has\(#auth-screen\.active\) \.terminal-status-bar \{[^}]*display:\s*none/,
        'both no-session screens must hide the terminal bar');
    assert.match(ruleBody(tools, '.terminal-status-bar:empty'), /display:\s*none/,
        'an empty bar collapses rather than sitting invisible');
});

/* ---------------------------------------------------------------------------
 * 4. The tooltip is the only way to read the status on this screen, and it
 *    cannot clip at either edge of the viewport
 * ------------------------------------------------------------------------- */

test('the terminal bar tooltip grows upward and rightward, capped at the viewport', () => {
    const body = ruleBody(tools, '.terminal-status-bar .status::after');
    assert.match(body, /bottom:\s*auto/, 'the shared rule grows downward off the bottom edge - that must be undone here');
    assert.match(body, /top:\s*-\d/, 'anchor above the dot instead, since the dot sits at the viewport bottom');
    assert.match(body, /left:\s*0/, 'anchor the left edge to the dot and grow rightwards, away from the left edge');
    assert.match(body, /transform:\s*none/, 'the shared translateX would re-centre it');
    assert.match(body, /max-width:\s*calc\(100vw/, 'capped at the viewport');
});

/* ---------------------------------------------------------------------------
 * 5. Standalone (home-screen) mode pays the same bottom inset as the other
 *    bottom-edge controls, and the config drawer (which docks on the
 *    RIGHT) no longer reaches for it
 * ------------------------------------------------------------------------- */

test('the terminal bar pays the safe-area bottom inset in standalone mode', () => {
    const body = ruleBody(iosChrome, '.terminal-status-bar');
    assert.match(body, /env\(safe-area-inset-bottom\)/,
        'the bottom-row FABs above it move up by the inset; without this it sits under the home indicator');
});

test('the docked config drawer (right side) does not reposition the terminal bar', () => {
    assert.doesNotMatch(
        configDrawer, /\.terminal-status-bar/,
        'the bar lives at the bottom-left, opposite a drawer that docks on the right');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
