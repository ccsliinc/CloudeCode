// One click on a toast must produce exactly ONE navigation.
// ----------------------------------------------------------------------
// THE ASSERTION IS A COUNT, AND THAT IS THE WHOLE POINT. A test that
// asserts "navigation happened" passes just as happily on one navigation
// as on two, and the bug was always two: the toast card bound a click
// handler calling `ToastNavigate.go`, and the session-NAME element inside
// it bound a second one calling `SessionSidebarClicks.activateRow`. Both
// end at `App.returnToExistingTerminal`, which closes the live WebSocket
// and schedules a fresh connect, so one click tore the transport down
// twice and the session took about thirty seconds to settle.
//
// THIS SUITE DISPATCHES A BUBBLING CLICK, and it has to. The shared stub's
// `El.click()` fires only the listeners on that one element, so a test
// written against it as-is would have counted ONE navigation on the
// BROKEN code and proved nothing at all. `clickBubbling` below walks the
// `parentNode` chain the way a browser does, honouring
// `stopPropagation()`. The shared stub is deliberately NOT changed: other
// suites depend on its non-bubbling `click()`.
//
// THE NEGATIVE CONTROL IS LOAD-BEARING. The fix pairs the de-duplication
// with a guard that refuses to re-enter the session already on screen. A
// guard that refused EVERYTHING would satisfy "exactly one navigation" and
// "no teardown when already attached" perfectly, while breaking the
// feature outright: the user clicks a toast for another session and
// nothing happens. So "a toast for a DIFFERENT session still navigates"
// is asserted alongside, and it is the case that fails first if the guard
// is ever widened.
//
// NOT A PIXEL TEST. This reads the element tree the shipped module builds
// against the shared stub DOM, and drives the shipped `toast-navigate.js`
// inside the same sandbox. There is no layout and no stylesheet here.
//
// Run with: node tests/test_toast_click_single_navigation.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

import { makeEnv, toast, cards, settle } from './lib_toast_dom_stub.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const NAVIGATE_SRC = fs.readFileSync(path.join(ROOT, 'client/js/toast-navigate.js'), 'utf8');

const tests = [];
/** Description: register one named case. Inputs: name, fn. Output: None. */
function test(name, fn) { tests.push([name, fn]); }

/**
 * Description: dispatch a click the way a browser does - fire the
 *   listeners on the target, then on each ancestor in turn, stopping if a
 *   handler calls stopPropagation(). The shared stub's own `click()` does
 *   NOT bubble, which is exactly why this exists: the defect under test
 *   IS the bubble.
 * Inputs: el (stub element).
 * Output: None.
 */
function clickBubbling(el) {
    let stopped = false;
    const evt = {
        stopPropagation() { stopped = true; },
        preventDefault() {},
    };
    let node = el;
    while (node && !stopped) {
        const fns = (node._listeners && node._listeners.get('click')) || [];
        for (const fn of fns.slice()) fn(evt);
        node = node.parentNode;
    }
}

/**
 * Description: the session-name element inside a card, which is the
 *   element the user actually clicks. THROWS when absent rather than
 *   returning null: a lookup that silently found nothing would make every
 *   click below a no-op and every count assertion read zero, which is a
 *   green test measuring an empty room.
 * Inputs: card (stub element).
 * Output: stub element.
 */
function sessionNameEl(card) {
    const el = card.querySelector('.toast__session');
    if (!el) {
        throw new Error(
            'no .toast__session inside the card, so this suite is clicking '
            + 'nothing - the class name changed and these assertions have '
            + 'stopped measuring the defect');
    }
    return el;
}

/**
 * Description: a sandbox holding the shipped toast manager AND the
 *   shipped toast-navigate module, with the collaborators both reach for
 *   replaced by recorders.
 * Inputs: activeTmuxName (string|null) - the session this browser is
 *   attached to, as SessionSidebar would report it.
 *   rows (array) - what GET /sessions/list returns.
 * Output: {container, mgr, navigations, listCalls}.
 */
function makeNavEnv(activeTmuxName, rows) {
    const { sandbox, container, mgr } = makeEnv();
    const w = sandbox.window;

    const navigations = [];
    const listCalls = [];

    w.App = {
        returnToExistingTerminal(info) { navigations.push(info); },
    };
    w.API.listSessions = () => { listCalls.push(1); return Promise.resolve(rows); };
    w.SessionSidebar = {
        _activeSessionId: null,
        _activeTmuxName: activeTmuxName || null,
        activeTmuxName() { return this._activeTmuxName; },
    };
    // The other collaborator the OLD name handler used. Left present and
    // recording, so "the duplicate navigation is gone" is measured rather
    // than assumed: if the call came back, this counter would move.
    const activateRowCalls = [];
    w.SessionSidebarClicks = {
        activateRow(ctrl, row) { activateRowCalls.push(row); },
    };

    vm.runInContext(NAVIGATE_SRC, sandbox, { filename: 'toast-navigate.js' });
    if (!w.ToastNavigate || typeof w.ToastNavigate.go !== 'function') {
        throw new Error(
            'toast-navigate.js did not export itself into the sandbox, so the '
            + 'card would bind no navigation at all and every count below '
            + 'would read zero for the wrong reason');
    }
    return { container, mgr, navigations, listCalls, activateRowCalls, w };
}

/** Description: a SessionInfo row in the shape /sessions/list returns. */
function row(sessionId, tmuxName) {
    return { tmux_session: tmuxName, session: { id: sessionId, name: tmuxName } };
}

/** Description: let the listSessions promise chain drain. */
function drain() { return new Promise((resolve) => setTimeout(resolve, 20)); }

// ----------------------------------------------------- the defect itself

test('NEGATIVE CONTROL: the card is on screen and its name is clickable', async () => {
    const { container, mgr } = makeNavEnv(null, [row('A', 'cloude_a')]);
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();
    assert.equal(cards(container).length, 1,
        'the control is blind: a card must exist before any click assertion '
        + 'below means anything');
    const name = sessionNameEl(cards(container)[0]);
    assert.ok((name._listeners.get('click') || []).length > 0,
        'the name element must carry a click listener, or the bubbling test '
        + 'is measuring an inert node');
});

test('clicking the session name navigates EXACTLY ONCE', async () => {
    const { container, mgr, navigations, activateRowCalls } =
        makeNavEnv(null, [row('A', 'cloude_a')]);
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();

    clickBubbling(sessionNameEl(cards(container)[0]));
    await drain();

    assert.equal(navigations.length, 1,
        'ONE click must produce ONE navigation. Two means the name handler '
        + 'and the card handler both ran, and each one closes the live '
        + 'WebSocket and opens another');
    assert.equal(activateRowCalls.length, 0,
        'the name handler must no longer reach SessionSidebarClicks.activateRow: '
        + 'that was the duplicate, and it ran with a fabricated controller '
        + 'whose null _activeTmuxName disabled the already-here guard');
});

test('clicking the card BODY navigates exactly once', async () => {
    const { container, mgr, navigations } = makeNavEnv(null, [row('A', 'cloude_a')]);
    mgr.add(toast('Stop', 'Your turn', 'some body text', 'A', 'cloude_a'));
    await settle();

    clickBubbling(cards(container)[0]);
    await drain();

    assert.equal(navigations.length, 1,
        'the card is still the thing that navigates, and once');
});

test('clicking the session name still dismisses the card', async () => {
    const { container, mgr } = makeNavEnv(null, [row('A', 'cloude_a')]);
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();
    assert.equal(cards(container).length, 1, 'setup');

    clickBubbling(sessionNameEl(cards(container)[0]));
    await settle();

    assert.equal(cards(container).length, 0,
        'clicking the name dismisses the card: the user is being taken to '
        + 'the session it is about, so the card has served its purpose');
});

// --------------------------------------- the guard, and its counterpart

test('a toast for the session ALREADY attached does not navigate', async () => {
    const { container, mgr, navigations, w } =
        makeNavEnv(null, [row('A', 'cloude_a')]);
    // THE ORDERING HERE IS THE REAL RACE, not a convenience. `add()`
    // consults `_isActiveSession` and REFUSES to render a card for the
    // session on screen, so a card for the attached session can only
    // exist if it was raised while the user was somewhere else and they
    // then walked in. Setting the active name first would leave the
    // container EMPTY, the click below would land on `undefined`, and
    // "zero navigations" would be a false green measuring an empty room.
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();
    assert.equal(cards(container).length, 1,
        'the card must be on screen before the click, or this case proves '
        + 'nothing at all');

    w.SessionSidebar._activeTmuxName = 'cloude_a';
    clickBubbling(cards(container)[0]);
    await drain();

    assert.equal(navigations.length, 0,
        're-entering the session already on screen closes a HEALTHY '
        + 'WebSocket and schedules a new one, which is the flicker this '
        + 'change exists to stop');
});

test('NEGATIVE CONTROL: a toast for a DIFFERENT session DOES navigate', async () => {
    const { container, mgr, navigations } =
        makeNavEnv('cloude_a', [row('A', 'cloude_a'), row('B', 'cloude_b')]);
    mgr.add(toast('Stop', 'Your turn', null, 'B', 'cloude_b'));
    await settle();

    clickBubbling(cards(container)[0]);
    await drain();

    assert.equal(navigations.length, 1,
        'THIS IS THE CASE A TOO-WIDE GUARD BREAKS. A guard that refused '
        + 'everything would pass every other test in this file and leave '
        + 'the user clicking notifications that do nothing');
    assert.equal(navigations[0].tmux_session, 'cloude_b',
        'and it must navigate to the session the toast names');
});

test('the already-attached guard still dismisses on a name click', async () => {
    const { container, mgr, navigations, w } =
        makeNavEnv(null, [row('A', 'cloude_a')]);
    // Same add-then-attach ordering, and for the same reason: see the
    // case above.
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();
    assert.equal(cards(container).length, 1, 'setup');

    w.SessionSidebar._activeTmuxName = 'cloude_a';
    clickBubbling(sessionNameEl(cards(container)[0]));
    await settle();

    assert.equal(navigations.length, 0, 'no re-entry');
    assert.equal(cards(container).length, 0,
        'the dismiss must not be swallowed by the navigation guard: the '
        + 'user clicked the card, and a click that does nothing at all '
        + 'reads as broken');
});

// ------------------------------------------------------- dismiss button

test('the dismiss button dismisses WITHOUT navigating', async () => {
    const { container, mgr, navigations } =
        makeNavEnv(null, [row('A', 'cloude_a')]);
    mgr.add(toast('Stop', 'Your turn', null, 'A', 'cloude_a'));
    await settle();

    const btn = cards(container)[0].querySelector('.toast__dismiss');
    assert.ok(btn, 'the dismiss control must exist');
    clickBubbling(btn);
    await settle();

    assert.equal(cards(container).length, 0, 'the card is gone');
    assert.equal(navigations.length, 0,
        'the dismiss button is a SIBLING of the name and stops propagation: '
        + 'throwing a notification away must never yank the user into the '
        + 'session it was about');
});

// ------------------------------------------------- the pure name reader

test('tmuxNameOf mirrors what returnToExistingTerminal reads', async () => {
    const { w } = makeNavEnv(null, []);
    const T = w.ToastNavigate;
    assert.equal(T.tmuxNameOf({ tmux_session: 'cloude_a' }), 'cloude_a',
        'the wrapper level wins, which is where /sessions/list puts it');
    assert.equal(T.tmuxNameOf({ session: { tmux_session: 'cloude_b' } }), 'cloude_b',
        'the nested level is the fallback for the flatter older shapes');
    assert.equal(T.tmuxNameOf({ name: 'cloude_c' }), 'cloude_c');
    assert.equal(T.tmuxNameOf({}), null,
        'a row with no derivable name answers null, which means NAVIGATE');
    assert.equal(T.tmuxNameOf(null), null);
});

test('alreadyAttachedTo refuses only on a positive match', async () => {
    const { w } = makeNavEnv('cloude_a', []);
    const T = w.ToastNavigate;
    assert.equal(T.alreadyAttachedTo('cloude_a'), true, 'the same name matches');
    assert.equal(T.alreadyAttachedTo('cloude_b'), false, 'a different name does not');
    assert.equal(T.alreadyAttachedTo(null), false,
        'an underivable name must NAVIGATE, not refuse');
    assert.equal(T.alreadyAttachedTo(''), false);

    w.SessionSidebar._activeTmuxName = null;
    assert.equal(T.alreadyAttachedTo('cloude_a'), false,
        'attached to nothing means navigate');

    delete w.SessionSidebar;
    assert.equal(T.alreadyAttachedTo('cloude_a'), false,
        'no sidebar at all means navigate: not having been able to ask is '
        + 'not evidence the user is already there');
});

// ----------------------------------------------------------------- run

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`not ok - ${name}\n    ${err && err.message}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
