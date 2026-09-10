// One navigation generation token, and the paths that REFUSE on it.
// ----------------------------------------------------------------------
// THE DEFECT. Nothing in the client knew which navigation was current, so
// every entry path into a session started asynchronous work and none of
// them could tell whether their own completion still belonged on screen.
// Click session A, click session B before A's fetch resolves, resolve A,
// and A paints over B.
//
// WHAT THIS SUITE IS REALLY PINNING, and it is not that a counter counts.
// A unit test proving begin() increments would pass against a token
// nothing checks, which is exactly the shape of guard this codebase has
// been bitten by before (CLAUDE.md: "a guard whose only exercised caller
// sets the flag it checks has never been tested"). So the load-bearing
// cases below drive the SHIPPED client/js/session-sidebar-clicks.js and
// the SHIPPED client/js/terminal.js against a real out-of-order
// resolution and assert that the LATE one writes NOTHING.
//
// THE POSITIVE CONTROL IS EQUALLY LOAD-BEARING. A guard that refused
// everything would satisfy every "A did not paint" assertion perfectly
// and break navigation entirely, so each refusal case is paired with the
// same scenario resolved in order, asserting the navigation DOES happen.
//
// Run with: node --test tests/test_navigation_generation.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NAVGEN_SRC = read('client/js/navigation-generation.js');
const CLICKS_SRC = read('client/js/session-sidebar-clicks.js');
const TERM_SRC = read('client/js/terminal.js');
const INDEX_HTML = read('client/index.html');
const TERM_SINGLETON = 'window.TerminalController = new Terminal();';

/**
 * Description: a bare sandbox with the globals these modules touch.
 * Inputs: none.
 * Output: vm context object.
 */
function makeSandbox() {
    const sandbox = {
        window: {},
        document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout, clearTimeout, Promise, TextEncoder,
        requestAnimationFrame: (fn) => { fn(); return 1; },
        WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
        },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.WebSocket = sandbox.WebSocket;
    sandbox.window.CustomEvent = sandbox.CustomEvent;
    sandbox.window.dispatchEvent = () => true;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });
    if (!sandbox.window.NavigationGeneration) {
        throw new Error(
            'navigation-generation.js did not export itself, so every case '
            + 'below would be measuring a harness bug rather than the module');
    }
    return sandbox;
}

/**
 * Description: a promise plus the function that settles it, so a test can
 *   decide the ORDER two fetches resolve in. That order is the entire
 *   scenario under test; an await on real timers could not express it.
 * Inputs: none.
 * Output: {promise, resolve}.
 */
function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/**
 * Description: a sandbox carrying the shipped sidebar click module and a
 *   recorder in place of App, with one deferred getSession per row.
 * Inputs: none.
 * Output: {sandbox, entered, fetches, activateRow, rowFor, ctrl}.
 */
function makeSidebar() {
    const sandbox = makeSandbox();
    const entered = [];
    const fetches = new Map();
    sandbox.window.API = {
        getSession: (id) => {
            const d = deferred();
            fetches.set(id, d);
            return d.promise;
        },
        adoptSession: () => Promise.resolve({ session: { id: 'unused' } }),
    };
    sandbox.window.App = {
        returnToExistingTerminal: (info) => { entered.push(info.session.id); },
    };
    vm.runInContext(CLICKS_SRC, sandbox, { filename: 'session-sidebar-clicks.js' });
    const api = sandbox.window.SessionSidebarClicks;
    if (!api || typeof api.activateRow !== 'function') {
        throw new Error('session-sidebar-clicks.js no longer exports activateRow');
    }
    const ctrl = { _activeTmuxName: null, _closeAfterSwitch() {} };
    const rowFor = (name, id) => ({ dataset: { name, sessionId: id } });
    return { sandbox, entered, fetches, activateRow: api.activateRow, rowFor, ctrl };
}

/**
 * Description: the shipped Terminal class without its trailing singleton
 *   construction, which builds a live xterm and cannot run here.
 * Inputs: sandbox (vm context).
 * Output: class.
 */
function loadTerminalClass(sandbox) {
    const cut = TERM_SRC.indexOf(TERM_SINGLETON);
    if (cut === -1) {
        throw new Error(
            'terminal.js no longer ends with its singleton line, so this '
            + 'loader is slicing something it does not understand');
    }
    vm.runInContext(
        TERM_SRC.slice(0, cut) + '\nwindow.__TerminalClass = Terminal;',
        sandbox, { filename: 'terminal.js' });
    return sandbox.window.__TerminalClass;
}

// ------------------------------------------------------------ the module

test('begin returns a value that is current until the next begin', () => {
    const { window: w } = makeSandbox();
    const NG = w.NavigationGeneration;
    const a = NG.begin('a');
    assert.equal(NG.isCurrent(a), true);
    const b = NG.begin('b');
    assert.equal(NG.isCurrent(b), true);
    assert.equal(NG.isCurrent(a), false,
        'a superseded token must stop being current, or the whole model is a no-op');
});

test('two navigations to the SAME target are still two generations', () => {
    // WHY A COUNTER AND NOT A TARGET IDENTITY. Click a session, click
    // away, click back: comparing session ids would let the FIRST click's
    // in-flight work satisfy the third, and the screen it would paint
    // into was torn down in between.
    const { window: w } = makeSandbox();
    const NG = w.NavigationGeneration;
    const first = NG.begin('session:same');
    NG.begin('launchpad');
    const third = NG.begin('session:same');
    assert.equal(NG.isCurrent(third), true);
    assert.equal(NG.isCurrent(first), false,
        'the first visit must not be satisfied by the third, however alike they look');
});

test('a non-number is never current, so a caller that lost its token proves nothing', () => {
    const { window: w } = makeSandbox();
    const NG = w.NavigationGeneration;
    NG.begin('a');
    for (const bad of [null, undefined, '1', {}, NaN]) {
        assert.equal(NG.isCurrent(bad), false, `${String(bad)} must not read as current`);
    }
});

test('keep() answers the same question as isCurrent and never throws', () => {
    const { window: w } = makeSandbox();
    const NG = w.NavigationGeneration;
    const a = NG.begin('a');
    assert.equal(NG.keep(a, 'work'), true);
    NG.begin('b');
    assert.equal(NG.keep(a, 'work'), false);
});

test('the module has no dependencies beyond window and console', () => {
    // It is loaded before everything else in index.html, so anything it
    // reached for would be undefined at load time on a real page.
    const bare = { window: {}, console: { log() {}, debug() {} } };
    bare.window.window = bare.window;
    vm.createContext(bare);
    vm.runInContext(NAVGEN_SRC, bare, { filename: 'navigation-generation.js' });
    assert.equal(typeof bare.window.NavigationGeneration.begin, 'function');
});

// -------------------------------------------- the sidebar, out of order

test('POSITIVE CONTROL: one click, resolved in order, enters that session', async () => {
    // Without this, a guard that refused everything would pass every
    // refusal case below while breaking navigation entirely.
    const { entered, fetches, activateRow, rowFor, ctrl } = makeSidebar();
    const run = activateRow(ctrl, rowFor('cloude_a', 'ses_a'));
    fetches.get('ses_a').resolve({ session: { id: 'ses_a' } });
    await run;
    assert.deepEqual(entered, ['ses_a'],
        'the ordinary case must still navigate, or nothing below is measuring a guard');
});

test('THE DECISIVE CASE: A resolving after B was clicked paints nothing', async () => {
    const { entered, fetches, activateRow, rowFor, ctrl } = makeSidebar();
    // Click A. Its fetch is left hanging.
    const runA = activateRow(ctrl, rowFor('cloude_a', 'ses_a'));
    // Click B before A settles. This is the second navigation.
    const runB = activateRow(ctrl, rowFor('cloude_b', 'ses_b'));
    // B answers first, so B is on screen.
    fetches.get('ses_b').resolve({ session: { id: 'ses_b' } });
    await runB;
    // NOW A's fetch comes back, late.
    fetches.get('ses_a').resolve({ session: { id: 'ses_a' } });
    await runA;
    assert.deepEqual(entered, ['ses_b'],
        'A resolved after B was entered and must have written nothing - '
        + 'this is the bug the token exists to make impossible');
});

test('the LAST click wins even when it answers first', async () => {
    const { entered, fetches, activateRow, rowFor, ctrl } = makeSidebar();
    const runA = activateRow(ctrl, rowFor('cloude_a', 'ses_a'));
    const runB = activateRow(ctrl, rowFor('cloude_b', 'ses_b'));
    fetches.get('ses_a').resolve({ session: { id: 'ses_a' } });
    await runA;
    fetches.get('ses_b').resolve({ session: { id: 'ses_b' } });
    await runB;
    assert.deepEqual(entered, ['ses_b'],
        'A must be refused even when it lands first, because B is the '
        + 'navigation the user asked for last');
});

test('a click, a return to the same session, and the first is still refused', async () => {
    const { entered, fetches, activateRow, rowFor, ctrl } = makeSidebar();
    const runA1 = activateRow(ctrl, rowFor('cloude_a', 'ses_a'));
    const runB = activateRow(ctrl, rowFor('cloude_b', 'ses_b'));
    fetches.get('ses_b').resolve({ session: { id: 'ses_b' } });
    await runB;
    // Back to A. Same target, new generation.
    const runA2 = activateRow(ctrl, rowFor('cloude_a', 'ses_a2'));
    fetches.get('ses_a2').resolve({ session: { id: 'ses_a' } });
    await runA2;
    // The FIRST A finally answers.
    fetches.get('ses_a').resolve({ session: { id: 'ses_a_stale' } });
    await runA1;
    assert.deepEqual(entered, ['ses_b', 'ses_a'],
        'the first visit to A must not be satisfied by its own late fetch, '
        + 'even though the user is back in A - the screen was rebuilt in between');
});

// ------------------------------------- the terminal's scheduled connect

test('a scheduled connect for a superseded navigation never opens a socket', async () => {
    const sandbox = makeSandbox();
    const Klass = loadTerminalClass(sandbox);
    const P = Klass.prototype;
    const NG = sandbox.window.NavigationGeneration;

    let connects = 0;
    const self = {
        _navToken: null,
        connectWebSocket() { connects += 1; },
        _navCurrent: P._navCurrent,
    };

    const nav = NG.begin('session:a');
    self._navToken = nav;
    // POSITIVE CONTROL: with nothing superseding it, the timer connects.
    assert.equal(self._navCurrent('scheduled connect'), true);

    NG.begin('session:b');
    assert.equal(self._navCurrent('scheduled connect'), false,
        'the 500ms delay before a connect is a window a session switch '
        + 'lands in, and a connect fired inside it opens a socket for a '
        + 'session nobody is looking at');
    assert.equal(connects, 0);
});

test('the terminal falls back to WORKING when the module is absent', () => {
    // A load-order accident must not stop the terminal connecting. The
    // token is a correctness guard, never a dependency.
    const sandbox = makeSandbox();
    delete sandbox.window.NavigationGeneration;
    const Klass = loadTerminalClass(sandbox);
    const self = { _navToken: 12345, _navCurrent: Klass.prototype._navCurrent };
    assert.equal(self._navCurrent('anything'), true);
});

// ------------------------------------------------- wiring, in the page

test('index.html loads the module before every consumer of it', () => {
    const order = [...INDEX_HTML.matchAll(/\/static\/js\/([A-Za-z0-9._\-/]+\.js)/g)]
        .map((m) => m[1]);
    const at = (f) => order.indexOf(f);
    assert.ok(at('navigation-generation.js') >= 0,
        'navigation-generation.js must be in index.html or it is dead code');
    for (const consumer of ['app.js', 'router.js', 'launchpad.js', 'terminal.js',
                            'session-sidebar-clicks.js', 'toast-navigate.js',
                            'session-restart-return.js']) {
        assert.ok(at('navigation-generation.js') < at(consumer),
            `navigation-generation.js must load before ${consumer}`);
    }
});

test('every entry path declares an intent, and the two App entries only READ one', () => {
    // The asymmetry is the design and it is easy to get backwards.
    // App.showTerminal() bumping the counter would let a caller that
    // ALREADY lost the race mint itself a fresh win a few awaits later.
    const app = read('client/js/app.js');
    for (const fn of ['showTerminal', 'returnToExistingTerminal']) {
        const body = app.slice(app.indexOf(`async ${fn}(`));
        const head = body.slice(0, body.indexOf('this.hideAllScreens()'));
        assert.ok(/NavigationGeneration\s*\.current\(\)/.test(head),
            `${fn} must READ the current generation`);
        assert.ok(!/NavigationGeneration\s*\.begin\(/.test(head),
            `${fn} must NOT begin one - see this test's comment`);
    }
    for (const [file, count] of [
        ['client/js/session-sidebar-clicks.js', 1],
        ['client/js/session-restart-return.js', 1],
        ['client/js/toast-navigate.js', 1],
        ['client/js/router.js', 1],
        // Six: the five surfaces that dispatch `session-created`, plus
        // the launcher's own return-to-a-running-session path.
        ['client/js/launchpad.js', 6],
    ]) {
        const hits = (read(file).match(/NavigationGeneration\s*\.begin\(/g) || []).length;
        assert.equal(hits, count,
            `${file} must declare exactly ${count} navigation intent(s)`);
    }
});

test('a stale generation never reaches the deep-link rejection banner', () => {
    // rejectTarget()'s contract is one banner for a URL that names
    // nothing. A superseded navigation names something perfectly real -
    // the user simply went elsewhere - and a banner for it is a lie the
    // user has to dismiss.
    const lp = read('client/js/launchpad.js');
    const guard = lp.indexOf("keep(deepLinkNav, 'deep-link resolve')");
    assert.ok(guard > 0, 'openProjectByName must check the deep link is still current');
    const afterGuard = lp.slice(guard, guard + 220);
    assert.ok(!/rejectTarget/.test(afterGuard),
        'the stale branch must return, never reject the target');
});
