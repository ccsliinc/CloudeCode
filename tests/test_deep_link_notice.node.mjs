// The deep-link / navigation notice banner (#deep-link-error), its
// lifecycle, and the two toast-navigate.js defects beside it.
// ----------------------------------------------------------------------
// THE OWNER'S COMPLAINT, VERBATIM: "now i have this and i can't get rid
// of it ... zero need for something that alarming." Three defects, three
// groups of tests below.
//
// D1 - STICKY. Router.clearError() used to be called only from
// applyCurrentPath() (init/popstate/authenticated), which in-app session
// entry never triggers (it uses pushState/replaceState, which fire no
// popstate). The fix wires a clear into every screen-entry point
// (App.showTerminal, App.returnToExistingTerminal, App.showLaunchpad),
// guarded by navigation-generation.js so a bounce can never silence the
// very rejection it just raised.
//
// THE DECISIVE CASE, and the one most worth getting right: a message
// raised inside a navigation must not be clearable BY THAT SAME
// navigation. This suite proves it two ways - by driving the shipped
// clearError() and asserting it refuses, and by mechanically stripping
// its guard out of the loaded source and asserting the SAME scenario
// then clears, so a passing test above can never be an accident of a
// scenario that was never going to fail. See 'NEGATIVE CONTROL' below -
// this is the verification the task asked to be done, done in code
// rather than asserted in prose.
//
// D3 - a false death claim, keyed on POSITIVE PROOF OF LIFE and on
// telling "could not measure" apart from "measured absent". Both
// directions are load-bearing: a browser already attached to the exact
// pane must raise nothing, and a genuinely dead session must still be
// reported - a matcher that always finds life is exactly as wrong as one
// that always finds death.
//
// Run with: node tests/test_deep_link_notice.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NAVGEN_SRC = read('client/js/navigation-generation.js');
const ROUTER_SRC = read('client/js/router.js');
const TOASTNAV_SRC = read('client/js/toast-navigate.js');

/**
 * Description: a fake DOM element carrying just what router.js touches -
 *   `style.display`, `textContent`, and (for the dismiss button)
 *   `addEventListener`.
 * Inputs: none.
 * Output: object.
 */
function makeFakeElement() {
    return {
        style: { display: 'none' },
        textContent: '',
        _listeners: {},
        addEventListener(type, fn) { this._listeners[type] = fn; },
        setAttribute() {},
    };
}

/**
 * Description: a bare sandbox carrying navigation-generation.js and
 *   router.js, with a fake `#deep-link-error` (+ its two children) and no
 *   real timers - showError() arms an 8s auto-dismiss and these tests
 *   must not wait on it.
 * Inputs: routerSrc (string, optional) - defaults to the real shipped
 *   source; the negative-control test passes a mutated copy.
 * Output: {window, elements, timers: {scheduled: Map, fire(id)}}.
 */
function makeRouterSandbox(routerSrc) {
    const elements = {
        'deep-link-error': makeFakeElement(),
        'deep-link-error-text': makeFakeElement(),
        'deep-link-error-dismiss': makeFakeElement(),
    };
    let timerSeq = 1;
    const scheduled = new Map();
    const sandbox = {
        window: {},
        document: {
            getElementById: (id) => elements[id] || null,
        },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout: (fn, ms) => { const id = timerSeq++; scheduled.set(id, fn); return id; },
        clearTimeout: (id) => { scheduled.delete(id); },
        history: { replaceState() {}, pushState() {} },
        Promise, TextEncoder,
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.history = sandbox.history;
    sandbox.window.location = { pathname: '/', search: '' };
    sandbox.window.addEventListener = () => {};
    sandbox.window.dispatchEvent = () => true;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });
    vm.runInContext(routerSrc || ROUTER_SRC, sandbox, { filename: 'router.js' });
    if (!sandbox.window.Router || typeof sandbox.window.Router.clearError !== 'function') {
        throw new Error('router.js did not export clearError - harness or source drifted');
    }
    return {
        window: sandbox.window,
        elements,
        timers: {
            scheduled,
            fire(id) { const fn = scheduled.get(id); if (fn) fn(); },
        },
    };
}

// ------------------------------------------------------- D1: the banner

test('D1 POSITIVE CONTROL: a stale banner IS cleared by a successful navigation', () => {
    const { window: w, elements } = makeRouterSandbox();
    const NG = w.NavigationGeneration;
    // The deep link's own navigation begins, then fails.
    const failedNav = NG.begin('deeplink:cloudecode-2');
    w.Router.rejectTarget('cloudecode-2');
    assert.equal(elements['deep-link-error'].style.display, 'flex',
        'rejectTarget must show the banner');

    // A LATER, genuinely separate navigation begins and succeeds - this
    // is what App.showTerminal()/returnToExistingTerminal() do: read the
    // generation their caller already began, then clear on it.
    const laterNav = NG.begin('session:cloude_other');
    w.Router.clearError(laterNav);

    assert.equal(elements['deep-link-error'].style.display, 'none',
        'a later successful navigation must clear the stale banner');
    assert.equal(elements['deep-link-error-text'].textContent, '');
});

test('D1 THE DECISIVE CASE: a rejection is not silenced by the bounce that raised it', () => {
    // This is the scenario CLAUDE.md's gotcha 3 exists to forbid: the
    // banner rejectTarget() just raised must survive a clear-attempt made
    // WITHIN THE SAME NAVIGATION GENERATION - which is exactly what
    // App.showLaunchpad()'s own clearError(navGenBeforeEntry) call does
    // when it runs as a direct continuation of the same failed
    // resolution (see app.js: navGenBeforeEntry is captured BEFORE
    // showLaunchpad's own begin(), so it equals whatever generation was
    // current when the rejection fired).
    const { window: w, elements } = makeRouterSandbox();
    const NG = w.NavigationGeneration;
    const failedNav = NG.begin('deeplink:cloudecode-2');
    w.Router.rejectTarget('cloudecode-2');
    assert.equal(elements['deep-link-error'].style.display, 'flex');

    // The bounce's own clear attempt, using the SAME generation that was
    // current when the rejection fired - this is what a naive
    // "clear on every showLaunchpad() call" would do.
    w.Router.clearError(failedNav);

    assert.equal(elements['deep-link-error'].style.display, 'flex',
        'a rejection must survive a clear-attempt made in its own generation - '
        + 'this is THE decisive case for gotcha 3');
    assert.equal(elements['deep-link-error-text'].textContent, 'session not found: "cloudecode-2" - returned to home.');
});

test('NEGATIVE CONTROL: the same exact scenario DOES clear once the guard is stripped', () => {
    // This is the verification the task asked to be done, done in code.
    // It mechanically removes clearError()'s stale-guard from a COPY of
    // the real source and re-runs THE DECISIVE CASE above against it. If
    // this test ever fails, the guard text has drifted from what this
    // file expects to strip, and the "decisive case" test above is no
    // longer proven to be testing anything.
    const GUARD_BLOCK =
        "        if (typeof token === 'number' && typeof bannerGeneration === 'number') {\n"
        + "            if (!(bannerGeneration < token)) {\n"
        + "                // Same generation as the one that raised this message\n"
        + "                // (or, impossibly, a newer one) - refuse. See doc comment.\n"
        + "                return;\n"
        + "            }\n"
        + "        }\n";
    assert.ok(ROUTER_SRC.indexOf(GUARD_BLOCK) !== -1,
        "router.js's clearError guard block text has changed; update this test's slice");
    const naiveSrc = ROUTER_SRC.replace(GUARD_BLOCK, '');

    const { window: w, elements } = makeRouterSandbox(naiveSrc);
    const NG = w.NavigationGeneration;
    const failedNav = NG.begin('deeplink:cloudecode-2');
    w.Router.rejectTarget('cloudecode-2');
    w.Router.clearError(failedNav);

    assert.equal(elements['deep-link-error'].style.display, 'none',
        'WITHOUT the guard, clearing in the same generation DOES silence the '
        + 'rejection - this is what proves the guard in the shipped code is '
        + 'load-bearing, not decorative');
});

test('D2: re-raising a message resets the auto-dismiss timer rather than stacking one', () => {
    const { window: w, timers } = makeRouterSandbox();
    w.Router.showError('first message');
    assert.equal(timers.scheduled.size, 1, 'one timer armed after the first raise');
    const firstTimerId = [...timers.scheduled.keys()][0];

    w.Router.showError('second message');
    assert.equal(timers.scheduled.size, 1,
        're-raising must not leave a second timer running alongside the first');
    assert.ok(!timers.scheduled.has(firstTimerId),
        'the first message\'s timer must be cancelled, not merely outnumbered');
});

test('D2: the auto-dismiss timer clears the banner unconditionally when it fires', () => {
    const { window: w, elements, timers } = makeRouterSandbox();
    w.Router.showError('will time out');
    const id = [...timers.scheduled.keys()][0];
    timers.fire(id);
    assert.equal(elements['deep-link-error'].style.display, 'none');
});

// -------------------------------------------------- D3: toast-navigate

/**
 * Description: a sandbox carrying navigation-generation.js and
 *   toast-navigate.js, with recorders standing in for API/App/Router/
 *   SessionSidebar.
 * Inputs: opts - { listSessionsResult, attachedTmuxName }.
 *   listSessionsResult: value (or thenable) API.listSessions() resolves
 *     to.
 *   attachedTmuxName: string|null - what SessionSidebar.activeTmuxName()
 *     answers.
 * Output: {window, entered: Array, errors: Array, listCalls: number-ref}.
 */
function makeToastNavSandbox(opts) {
    const sandbox = {
        window: {},
        document: { getElementById: () => null },
        console: { log() {}, warn() {}, debug() {}, error() {} },
        setTimeout, clearTimeout, Promise, TextEncoder,
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
        },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.dispatchEvent = () => true;
    vm.createContext(sandbox);
    vm.runInContext(NAVGEN_SRC, sandbox, { filename: 'navigation-generation.js' });

    const state = { listCalls: 0, entered: [], errors: [] };
    sandbox.window.API = {
        listSessions: () => {
            state.listCalls += 1;
            return Promise.resolve(opts.listSessionsResult);
        },
    };
    sandbox.window.App = {
        returnToExistingTerminal: (info) => { state.entered.push(info); },
    };
    sandbox.window.SessionSidebar = {
        activeTmuxName: () => (opts.attachedTmuxName != null ? opts.attachedTmuxName : null),
    };
    sandbox.window.Router = {
        showError: (message) => { state.errors.push(message); },
    };

    vm.runInContext(TOASTNAV_SRC, sandbox, { filename: 'toast-navigate.js' });
    if (!sandbox.window.ToastNavigate || typeof sandbox.window.ToastNavigate.go !== 'function') {
        throw new Error('toast-navigate.js did not export go() - harness or source drifted');
    }
    return { window: sandbox.window, state };
}

test('D3: already attached to the exact pane raises no death claim and never calls the listing', async () => {
    const { window: w, state } = makeToastNavSandbox({
        attachedTmuxName: 'cloude_myproject',
        listSessionsResult: [],
    });
    const ok = await w.ToastNavigate.go({ session_id: 'ses_a', session_name: 'cloude_myproject' });
    assert.equal(ok, true);
    assert.equal(state.listCalls, 0, 'a positive proof-of-life check must skip the listing fetch entirely');
    assert.deepEqual(state.errors, [], 'no death claim when we are already attached');
});

test('D3: a browser attached to a DIFFERENT (uniquified) name still gets a full, honest check', async () => {
    // The exact scenario the coordinator's correction describes: the
    // pinned toast names the ORIGINAL, now-dead session
    // (cloude_cloudecode), while this browser is attached to the
    // uniquified survivor (cloude_cloudecode-2) created after the
    // original's pane died. Exact-string comparison must not conflate
    // the two - the dead one must still be reported.
    const { window: w, state } = makeToastNavSandbox({
        attachedTmuxName: 'cloude_cloudecode-2',
        listSessionsResult: [], // the dead original is gone from the listing
    });
    const ok = await w.ToastNavigate.go({ session_id: 'ses_dead', session_name: 'cloude_cloudecode' });
    assert.equal(ok, false);
    assert.equal(state.listCalls, 1, 'a differently-named attachment must not skip the honest check');
    assert.equal(state.errors.length, 1, 'the genuinely dead session must still be reported');
});

test('D3: a malformed (non-array) listing payload raises no death claim', async () => {
    const { window: w, state } = makeToastNavSandbox({
        attachedTmuxName: null,
        listSessionsResult: { degraded: true }, // not an array
    });
    const ok = await w.ToastNavigate.go({ session_id: 'ses_a', session_name: 'cloude_a' });
    assert.equal(ok, false);
    assert.equal(state.listCalls, 1);
    assert.deepEqual(state.errors, [],
        'a could-not-measure payload must never be reported as a confirmed death');
});

test('D3 TRUE POSITIVE, MUST SURVIVE: a well-formed listing genuinely missing the session still reports', async () => {
    const { window: w, state } = makeToastNavSandbox({
        attachedTmuxName: null,
        listSessionsResult: [
            { session: { id: 'ses_other' }, tmux_session: 'cloude_other' },
        ],
    });
    const ok = await w.ToastNavigate.go({ session_id: 'ses_gone', session_name: 'cloude_gone' });
    assert.equal(ok, false);
    assert.equal(state.errors.length, 1,
        'a genuine measured absence must still be reported - softening the '
        + 'false-death cases must never soften this one');
    assert.match(state.errors[0], /no longer running/);
});

test('D3 positive control: a well-formed listing that DOES contain the session still navigates', async () => {
    const { window: w, state } = makeToastNavSandbox({
        attachedTmuxName: null,
        listSessionsResult: [
            { session: { id: 'ses_a' }, tmux_session: 'cloude_a' },
        ],
    });
    const ok = await w.ToastNavigate.go({ session_id: 'ses_a', session_name: 'cloude_a' });
    assert.equal(ok, true);
    assert.equal(state.entered.length, 1);
    assert.deepEqual(state.errors, []);
});
