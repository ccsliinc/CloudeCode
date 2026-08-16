// Node test for the pull-to-refresh fix on the terminal.
//
// WHY THIS FILE EXISTS: the bug was a MISSING DECLARATION plus a
// deliberately-released gesture, and neither leaves a trace anyone can
// see in a screenshot. Dragging down at the top of the scrollback made
// iOS Safari reload the page instead of showing earlier lines.
//
// The mechanism, verified live 2026-08-16 against the vendored xterm
// bundle and the real DOM: a touch on the terminal lands on
// `canvas.xterm-link-layer`, which is NOT inside `.xterm-viewport` (they
// are siblings under `.xterm`). xterm's `_bubbleScroll` cancels the
// touchmove only while the viewport can still move, and at either
// boundary returns without cancelling - so the browser then walks the
// CANVAS's ancestor chain, which had no `overscroll-behavior` barrier
// anywhere before the document.
//
// Two assertions therefore, one per half of the fix:
//   1. `.terminal-container` still carries `overscroll-behavior` - the
//      narrowest ancestor of the touch target that is a scroll container
//      at all. Delete it and the declarative barrier is gone.
//   2. `blockOverscrollEscape` cancels exactly the released case and
//      nothing else.
//
// Run with: node tests/test_terminal_scroll_gesture.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(__dirname, '..', 'client', 'css', 'styles.css');
const jsPath = path.join(__dirname, '..', 'client', 'js', 'terminal-scroll.js');
// Comments are stripped first: styles.css documents its own history in
// prose, and one of those comments quotes `.terminal-container { flex: 1 }`
// verbatim, which a naive text search happily matches instead of the rule.
const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const src = fs.readFileSync(jsPath, 'utf8');

let failures = 0;
let passes = 0;

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
 * Extract the declaration body of a top-level rule by exact selector.
 *
 * @param {string} sheet - full stylesheet text.
 * @param {string} selector - selector to match, e.g. '.terminal-container'.
 * @returns {string} the text between the braces of the first match.
 */
function ruleBody(sheet, selector) {
    const needle = selector + ' {';
    const at = sheet.indexOf(needle);
    assert.ok(at !== -1, `selector ${selector} not found in stylesheet`);
    const open = at + needle.length;
    const close = sheet.indexOf('}', open);
    assert.ok(close !== -1, `unterminated rule for ${selector}`);
    return sheet.slice(open, close);
}

/**
 * Fresh module instance with a bare window, plus a recording container
 * so listener registration can be inspected.
 *
 * @returns {{api: object, container: object, listeners: Array}}
 */
function loadModule() {
    const listeners = [];
    const sandbox = {
        window: {},
        console: { warn() {}, log() {} },
        Date,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const container = {
        addEventListener(type, fn, opts) {
            listeners.push({ type, fn, opts: opts || {} });
        },
    };
    return { api: sandbox.window.TerminalScroll, container, listeners };
}

/**
 * Minimal cancelable TouchEvent stand-in.
 *
 * @param {object} opts - {touches, cancelable, defaultPrevented}.
 * @returns {object} event with a preventDefault that records the call.
 */
function touchEvent(opts) {
    const ev = {
        touches: new Array(opts.touches === undefined ? 1 : opts.touches).fill({}),
        cancelable: opts.cancelable === undefined ? true : opts.cancelable,
        defaultPrevented: !!opts.defaultPrevented,
        prevented: false,
    };
    ev.preventDefault = function () {
        ev.prevented = true;
        ev.defaultPrevented = true;
    };
    return ev;
}

/* ================= 1. the CSS declaration ================= */

test('.terminal-container declares overscroll-behavior', () => {
    const body = ruleBody(css, '.terminal-container');
    assert.match(
        body,
        /overscroll-behavior(-y)?\s*:\s*(contain|none)\s*;/,
        '.terminal-container must contain the pull-to-refresh barrier'
    );
});

test('.terminal-container is still a scroll container', () => {
    // overscroll-behavior only applies to scroll containers. If someone
    // drops the overflow, the declaration above silently stops working.
    const body = ruleBody(css, '.terminal-container');
    assert.match(body, /overflow\s*:\s*hidden\s*;/);
});

test('the barrier is not applied document-wide', () => {
    // Requirement: do not blanket the whole document. The one body-level
    // overscroll rule that predates this fix is scoped to standalone
    // display mode and lives in ios-chrome.css, not here.
    const bodyRule = ruleBody(css, 'body');
    assert.ok(
        !/overscroll-behavior/.test(bodyRule),
        'body must not carry an unscoped overscroll-behavior'
    );
});

/* ================= 2. the JS boundary guard ================= */

test('cancels a released single-touch drag', () => {
    const { api } = loadModule();
    const ev = touchEvent({});
    api.blockOverscrollEscape(ev);
    assert.equal(ev.prevented, true);
});

test('leaves an already-consumed drag alone', () => {
    // xterm cancelled it, meaning it scrolled the viewport itself. Doing
    // anything here would be second-guessing a working scroll.
    const { api } = loadModule();
    const ev = touchEvent({ defaultPrevented: true });
    api.blockOverscrollEscape(ev);
    assert.equal(ev.prevented, false);
});

test('leaves multi-touch alone so pinch-zoom survives', () => {
    const { api } = loadModule();
    const ev = touchEvent({ touches: 2 });
    api.blockOverscrollEscape(ev);
    assert.equal(ev.prevented, false);
});

test('never calls preventDefault on a non-cancelable event', () => {
    // Calling it would log a console error on every frame of a scroll.
    const { api } = loadModule();
    const ev = touchEvent({ cancelable: false });
    api.blockOverscrollEscape(ev);
    assert.equal(ev.prevented, false);
});

/* ================= 3. how it is wired ================= */

test('registers the guard non-passively in the bubble phase', () => {
    const { api, container, listeners } = loadModule();
    api.init(container);
    const guards = listeners.filter(
        (l) => l.type === 'touchmove' && l.opts.passive === false
    );
    assert.equal(guards.length, 1, 'exactly one cancelling touchmove listener');
    assert.notEqual(
        guards[0].opts.capture, true,
        'must bubble so xterm sees the event first'
    );
});

test('the auto-scroll race listeners are still passive', () => {
    // Regression guard for the scrollback fix this file sits next to:
    // making any of those cancelling would break xterm's own scrolling.
    const { api, container, listeners } = loadModule();
    api.init(container);
    const passiveTypes = listeners
        .filter((l) => l.opts.capture === true)
        .map((l) => l.type)
        .sort();
    assert.deepEqual(
        passiveTypes,
        ['touchcancel', 'touchend', 'touchmove', 'touchstart', 'wheel']
    );
    listeners
        .filter((l) => l.opts.capture === true)
        .forEach((l) => assert.equal(l.opts.passive, true, `${l.type} must stay passive`));
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
