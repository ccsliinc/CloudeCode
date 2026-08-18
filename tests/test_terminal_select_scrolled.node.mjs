// Node test for client/js/terminal-select-scrolled.js.
//
// WHY THIS FILE EXISTS: "on the scroll back mouse does not reset scroll any
// longer but when trying to hilight it highlites on bottom off screen looks
// like where the mouse original [was]". The scroll-jump fix (04139ac) is
// correct and must NOT be undone - see the constraint in the file header of
// terminal-select-scrolled.js. What it exposed: xterm's own SGR mouse
// reports are SCREEN-relative, never scrollback-relative (verified against
// the real vendored bundle - a drag over identical on-screen pixels encodes
// an IDENTICAL row/col whether viewportY equals baseY or sits 30 rows above
// it: `\x1b[<0;1;3M` either way, see the harness note at the bottom of this
// file). Before the fix, every such report ALSO re-pinned the view to the
// bottom first, so the user was never actually looking at scrollback while
// dragging - nothing for the screen-relative encoding to get wrong. Once
// pinning stopped, a forwarded report while scrolled up gets applied by the
// remote program to ITS OWN live screen (anchored near the true buffer
// bottom), so any highlight it draws lands off screen below the viewport.
//
// terminal-select-scrolled.js's fix: force xterm's own local-selection
// bypass (`shouldForceSelection`, normally a shift/option-click) whenever
// the app owns the mouse AND the view is scrolled away from the live
// bottom, because in that state a forwarded report cannot mean what the
// app thinks it means. At the live bottom nothing changes.
//
// Run with: node tests/test_terminal_select_scrolled.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', 'client', 'js');
const src = fs.readFileSync(path.join(CLIENT_JS, 'terminal-select-scrolled.js'), 'utf8');

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
 * A minimal recording MouseEvent - the sandbox has no real DOM, so this
 * captures exactly what terminal-select-scrolled.js asks the browser to
 * construct.
 */
class FakeMouseEvent {
    constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
    }
}

/**
 * Build a fresh module instance plus a fake term/DOM environment.
 *
 * @param {{pinned: boolean, mouseActive: boolean}} state - the two
 *   booleans the whole module's decision is built from.
 * @returns {{api: object, term: object, screenEl: object, dispatched: object[]}}
 */
function loadModule(state) {
    const dispatched = [];
    const screenEl = {
        dispatchEvent(ev) { dispatched.push(ev); return true; },
    };
    const term = {
        options: { macOptionClickForcesSelection: false },
        _core: { coreMouseService: { areMouseEventsActive: state.mouseActive } },
        element: { querySelector: (sel) => (sel === '.xterm-screen' ? screenEl : null) },
    };
    const sandbox = {
        window: {
            TerminalScroll: { isPinnedToBottom: () => state.pinned },
        },
        console: { warn() {}, log() {} },
        MouseEvent: FakeMouseEvent,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { api: sandbox.window.TerminalSelectScrolled, term, screenEl, dispatched };
}

function realMouseDown(overrides) {
    let prevented = false;
    let stopped = false;
    return Object.assign({
        button: 0,
        buttons: 1,
        detail: 1,
        clientX: 42,
        clientY: 77,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
        get defaultPrevented() { return prevented; },
        get propagationStopped() { return stopped; },
    }, overrides);
}

/* ================= 1. the decision the whole module exists for ================= */

test('scrolled up + mouse tracking active: real mousedown is replaced', () => {
    const { api, term, dispatched } = loadModule({ pinned: false, mouseActive: true });
    const ev = realMouseDown();
    api.handleMouseDown(term, ev);
    assert.equal(ev.defaultPrevented, true, 'the real report-triggering event must be cancelled');
    assert.equal(ev.propagationStopped, true, 'must not also reach xterm\'s own report-mode listener');
    assert.equal(dispatched.length, 1, 'exactly one synthetic mousedown must be dispatched');
    const synth = dispatched[0];
    assert.equal(synth.type, 'mousedown');
    assert.equal(synth.shiftKey, true, 'non-mac force-selection gate');
    assert.equal(synth.altKey, true, 'mac force-selection gate (with macOptionClickForcesSelection)');
    assert.equal(synth.clientX, 42);
    assert.equal(synth.clientY, 77);
});

test('at the live bottom: nothing is touched, the app stays in control', () => {
    const { api, term, dispatched } = loadModule({ pinned: true, mouseActive: true });
    const ev = realMouseDown();
    api.handleMouseDown(term, ev);
    assert.equal(ev.defaultPrevented, false, 'a live-bottom click is a legitimate app interaction');
    assert.equal(dispatched.length, 0);
});

test('mouse tracking off: the app never owned this gesture, nothing to fix', () => {
    const { api, term, dispatched } = loadModule({ pinned: false, mouseActive: false });
    const ev = realMouseDown();
    api.handleMouseDown(term, ev);
    assert.equal(ev.defaultPrevented, false,
        'xterm\'s own SelectionService already handles this correctly - see scenario A '
        + 'in the harness note below; touching it here would be pure risk for no gain');
    assert.equal(dispatched.length, 0);
});

test('a right or middle click is left alone even when scrolled up', () => {
    const { api, term, dispatched } = loadModule({ pinned: false, mouseActive: true });
    for (const button of [1, 2]) {
        const ev = realMouseDown({ button });
        api.handleMouseDown(term, ev);
        assert.equal(ev.defaultPrevented, false, `button ${button} must not be intercepted`);
    }
    assert.equal(dispatched.length, 0);
});

/* ================= 2. macOptionClickForcesSelection is restored ================= */

test('the mac force-selection option is restored after dispatch, not left on', () => {
    const { api, term } = loadModule({ pinned: false, mouseActive: true });
    term.options.macOptionClickForcesSelection = false;
    api.handleMouseDown(term, realMouseDown());
    assert.equal(term.options.macOptionClickForcesSelection, false,
        'a permanent flip would silently change the user\'s own option-click behaviour');
});

test('the option is flipped back even if it started true', () => {
    const { api, term } = loadModule({ pinned: false, mouseActive: true });
    term.options.macOptionClickForcesSelection = true;
    api.handleMouseDown(term, realMouseDown());
    assert.equal(term.options.macOptionClickForcesSelection, true);
});

/* ================= 3. fails closed on the parts that can throw ================= */

test('an unreadable coreMouseService fails to the safe no-op side', () => {
    const { api, dispatched } = loadModule({ pinned: false, mouseActive: true });
    const brokenTerm = { options: {}, element: {} }; // no _core at all
    const ev = realMouseDown();
    api.handleMouseDown(brokenTerm, ev);
    assert.equal(ev.defaultPrevented, false, 'must not intercept when it cannot even ask');
    assert.equal(dispatched.length, 0);
});

test('a missing .xterm-screen element is a no-op, not a throw', () => {
    const { api, term } = loadModule({ pinned: false, mouseActive: true });
    term.element.querySelector = () => null;
    assert.doesNotThrow(() => api.handleMouseDown(term, realMouseDown()));
});

/* ================= 4. call-site and load-order wiring ================= */

test('terminal.js wires TerminalSelectScrolled from initTerminal', () => {
    const terminalSrc = fs.readFileSync(path.join(CLIENT_JS, 'terminal.js'), 'utf8');
    assert.match(terminalSrc, /_applySelectWhileScrolled\s*\(\s*\)\s*\{/,
        'the hook method must exist');
    assert.match(terminalSrc, /this\._applySelectWhileScrolled\(\);/,
        'initTerminal must call it, same as _applyTouchSelection()');
    const defMatch = terminalSrc.match(/_applySelectWhileScrolled\(\)\s*\{/);
    assert.ok(defMatch, 'method definition not found');
    const at = defMatch.index;
    const body = terminalSrc.slice(at, at + 500);
    assert.match(body, /window\.TerminalSelectScrolled\.init\(/,
        'the hook must actually call TerminalSelectScrolled.init');
});

test('index.html loads terminal-select-scrolled.js after terminal-scroll.js, before terminal.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
    const scroll = html.indexOf('terminal-scroll.js');
    const selectScrolled = html.indexOf('terminal-select-scrolled.js');
    const term = html.indexOf('/static/js/terminal.js');
    assert.notEqual(selectScrolled, -1, 'terminal-select-scrolled.js must be loaded');
    assert.ok(scroll < selectScrolled,
        'it reads window.TerminalScroll.isPinnedToBottom() and must load after it');
    assert.ok(selectScrolled < term,
        'terminal.js calls it from initTerminal() and must load after it');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------
// HARNESS NOTE - measured against the real vendored xterm bundle
// (client/vendor/xterm/xterm.js) driven in jsdom, mirroring the pattern
// documented in tests/test_terminal_input_kind.node.mjs. Not committed as
// a test here because this repo's *.node.mjs convention is "no package.json,
// no jest" (zero runtime dependencies); jsdom is a real npm dependency, so
// the full-engine proof lives as a standalone throwaway script instead and
// its numbers are recorded here verbatim for anyone who wants to rerun it.
//
//   Scenario A (mouse tracking OFF, real scrollback, viewportY=347 of
//   baseY=377): xterm's own SelectionService already resolves this
//   correctly without any help - term.getSelectionPosition() returned
//   {start:{x:1,y:349}, end:{x:11,y:351}}, exactly viewportY + the two rows
//   dragged over. This rules out "the selection layer resolves rows from a
//   stale viewport offset" as the cause; nothing here needed fixing.
//
//   Scenario B (mouse tracking ON, same scrolled state): the SGR report for
//   an identical on-screen drag was `\x1b[<0;1;3M` whether the terminal was
//   pinned to the bottom (viewportY===baseY) or scrolled 30 rows above it -
//   byte for byte identical. BEFORE this fix, that mousedown ALSO called
//   TerminalScroll.pinToBottom() (baseline mode), snapping viewportY from
//   347 to 377 before the drag could even start. AFTER this fix, the
//   mousedown is replaced per the assertions above, so it never reaches
//   xterm's report-encoding path at all and viewportY stays exactly 347
//   through the whole gesture - the scroll-jump fix stays intact and the
//   drag becomes a real local selection instead of a report the app
//   would have misapplied to its own live screen.
// ---------------------------------------------------------------------
