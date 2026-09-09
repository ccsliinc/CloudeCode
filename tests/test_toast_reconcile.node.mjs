// A card must LEAVE when the server stops listing it, not only arrive.
// ----------------------------------------------------------------------
// WHAT THIS IS FOR. The server now closes a toast by itself: a hook
// saying the user submitted a prompt answers everything that session was
// asking of them (src/core/toast_auto_ack.py). That is the whole point
// of the owner's ask - he types into the pane, and the card should go.
//
// AND THE SERVER DOING IT IS ONLY HALF THE FEATURE. `backfill` has only
// ever ADDED. That was correct while the only thing that could close a
// toast was a click here (which removes the card locally) or a click in
// another tab (which arrives as a `toast.ack` frame). Neither is true
// any more, and a surface holding no socket for the raising session -
// the launchpad, the archive, a terminal attached somewhere else - has
// no frame to hear it on. Its only channel is the poll, and a poll that
// can only add is a card that never leaves. So the fix the user actually
// experiences is `reconcileOpen`, and this file is what measures it.
//
// THE RACE IS THE INTERESTING PART, and it is ToastDismissedRing's race
// pointing the other way. A poll response describes the server as it was
// when the request LEFT. A `toast.new` frame that arrived after that
// instant is absent from the response through no fault of its own, and
// removing it would delete a card the server does hold - a notification
// destroyed by the very mechanism meant to tidy up. So a card younger
// than the snapshot is spared, and that is asserted here rather than
// assumed.
//
// NEGATIVE CONTROLS THROUGHOUT. Every "the card is gone" assertion is
// preceded or paired with proof the same setup KEEPS a card when the
// server still lists it. A `reconcileOpen` that simply cleared
// everything would satisfy every disappearance check in this file while
// destroying every notification the app exists to deliver, and it would
// look like a pass.
//
// NOT A PIXEL TEST. It reads the element tree the shipped module builds
// against the shared stub DOM.
//
// Run with: node tests/test_toast_reconcile.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

import { makeEnv, toast, cards, settle } from './lib_toast_dom_stub.mjs';

const tests = [];
/** Description: register one named case. Inputs: name, fn. Output: None. */
function test(name, fn) { tests.push([name, fn]); }

/**
 * Description: pin the manager's clock so a card's age relative to a poll
 *   snapshot is a fact the test sets rather than one it races. Returns a
 *   handle whose `at` is what `add()` will stamp next.
 * Inputs: mgr (ToastManager). Output: {at: number}.
 */
function pinClock(mgr) {
    const clock = { at: 1000 };
    mgr._now = () => clock.at;
    return clock;
}

// ------------------------------------------------------------ the basics

test('NEGATIVE CONTROL: a card the server still lists is kept', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    const t = toast('PermissionRequest', 'needs your permission', 'Bash: ls', 'A');
    mgr.add(t);
    assert.equal(cards(container).length, 1, 'setup');

    const removed = mgr.reconcileOpen([t], { since: 5000 });
    await settle();
    assert.equal(removed, 0);
    assert.equal(cards(container).length, 1,
        'the control is blind unless a still-open card demonstrably survives '
        + 'the same call that removes a closed one');
});

test('a card the server no longer lists is removed', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    mgr.add(toast('PermissionRequest', 'needs your permission', 'Bash: ls', 'A'));
    assert.equal(cards(container).length, 1, 'setup');

    const removed = mgr.reconcileOpen([], { since: 5000 });
    await settle();
    assert.equal(removed, 1);
    assert.equal(cards(container).length, 0,
        'the server answered this toast because the user typed; the card is '
        + 'the only thing left claiming otherwise');
});

test('removal never acks - the server already closed the record', async () => {
    const { container, mgr, acked } = makeEnv();
    pinClock(mgr);
    mgr.add(toast('Notification', 'wants your attention', 'hi', 'A'));
    mgr.reconcileOpen([], { since: 5000 });
    await settle();
    assert.equal(cards(container).length, 0);
    assert.equal(acked.length, 0,
        'acking a record the server has already closed is a write with '
        + 'nothing to change, aimed at a session this browser may not be on');
});

test('only the sessions the server dropped lose their cards', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    const a = toast('PermissionRequest', 'needs your permission', null, 'A');
    const b = toast('Notification', 'wants your attention', 'read me', 'B');
    mgr.add(a);
    mgr.add(b);
    assert.equal(cards(container).length, 2, 'setup');

    // The user typed into A. B is still asking for something.
    const removed = mgr.reconcileOpen([b], { since: 5000 });
    await settle();
    assert.equal(removed, 1);
    const left = cards(container);
    assert.equal(left.length, 1);
    assert.equal(left[0].querySelector('.toast__title-text').textContent,
        'wants your attention',
        "typing into one session says nothing about what another is asking");
});

// ------------------------------------------------------------- the race

test('a card that arrived AFTER the snapshot was taken is spared', async () => {
    const { container, mgr } = makeEnv();
    const clock = pinClock(mgr);

    // The poll request leaves at t=5000. Then a `toast.new` frame lands.
    const requestedAt = 5000;
    clock.at = 5200;
    mgr.add(toast('PermissionRequest', 'needs your permission', 'Bash: rm', 'A'));
    assert.equal(cards(container).length, 1, 'setup');

    // The response comes back describing the server BEFORE that toast
    // existed. It is absent for a reason that is not "closed".
    const removed = mgr.reconcileOpen([], { since: requestedAt });
    await settle();
    assert.equal(removed, 0);
    assert.equal(cards(container).length, 1,
        'a snapshot older than the card cannot testify about it; removing it '
        + 'would destroy a notification the server does hold');
});

test('the spared card is removed by the NEXT tick, once one can speak to it',
    async () => {
        const { container, mgr } = makeEnv();
        const clock = pinClock(mgr);
        clock.at = 5200;
        mgr.add(toast('PermissionRequest', 'needs your permission', null, 'A'));
        mgr.reconcileOpen([], { since: 5000 });
        await settle();
        assert.equal(cards(container).length, 1, 'setup: spared by the first tick');

        // A later snapshot IS newer than the card, so it may speak to it.
        const removed = mgr.reconcileOpen([], { since: 15000 });
        await settle();
        assert.equal(removed, 1);
        assert.equal(cards(container).length, 0,
            'sparing must be a DELAY, never a permanent exemption, or the '
            + 'card never leaves at all');
    });

test('with no snapshot instant the set is taken as authoritative', async () => {
    const { container, mgr } = makeEnv();
    const clock = pinClock(mgr);
    clock.at = 9999;
    mgr.add(toast('Stop', 'Your turn', null, 'A'));
    const removed = mgr.reconcileOpen([]);
    await settle();
    assert.equal(removed, 1);
    assert.equal(cards(container).length, 0);
});

// -------------------------------------------------------- shape handling

test('bare ids and server-shape objects are both understood', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    const t = toast('Stop', 'Your turn', null, 'A');
    mgr.add(t);
    assert.equal(mgr.reconcileOpen([t.id], { since: 5000 }), 0);
    await settle();
    assert.equal(cards(container).length, 1);
});

test('a malformed response removes nothing rather than clearing the screen',
    async () => {
        const { container, mgr } = makeEnv();
        pinClock(mgr);
        mgr.add(toast('PermissionRequest', 'needs your permission', null, 'A'));
        for (const bad of [null, undefined, 'nonsense', { toasts: [] }, 42]) {
            assert.equal(mgr.reconcileOpen(bad, { since: 5000 }), 0);
        }
        await settle();
        assert.equal(cards(container).length, 1,
            'a bad response is not evidence a notification was answered');
    });

test('reconciling twice removes once - it is idempotent', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    mgr.add(toast('Notification', 'wants your attention', 'x', 'A'));
    assert.equal(mgr.reconcileOpen([], { since: 5000 }), 1);
    await settle();
    assert.equal(mgr.reconcileOpen([], { since: 6000 }), 0);
    await settle();
    assert.equal(cards(container).length, 0);
});

test('a coalesced pile leaves the screen when every member is closed', async () => {
    const { container, mgr } = makeEnv();
    pinClock(mgr);
    for (let i = 0; i < 5; i++) mgr.add(toast('Stop', 'Your turn', `tail ${i}`, 'A'));
    assert.equal(cards(container).length, 1, 'setup: five Stops coalesce to one card');
    const removed = mgr.reconcileOpen([], { since: 5000 });
    await settle();
    assert.equal(removed, 5, 'every member id is its own record server-side');
    assert.equal(cards(container).length, 0);
});

// ------------------------------------------- the poller actually wires it

test('the poller reconciles removals, against the RAW list, with an instant',
    () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'client/js/toast-global-poll.js'), 'utf8');
        assert.match(src, /reconcileOpen\(list, \{ since: startedAt \}\)/,
            'removals must be computed from the raw server list, not the '
            + 'ring-filtered one: an id the ring suppresses is already gone '
            + 'from this browser, so subtracting it only makes the open set '
            + 'look smaller than the server said');
        assert.match(src, /var startedAt = Date\.now\(\);[\s\S]{0,400}getAllToasts/,
            'the instant must be stamped BEFORE the request leaves, or it '
            + 'describes the response rather than the snapshot');
        assert.match(src, /ToastManager\.backfill\(fresh\)/,
            'additions still go through the ring-filtered list');
    });

// ----------------------------------------------------------------- runner

let failed = 0;
for (const [name, fn] of tests) {
    try {
        // eslint-disable-next-line no-await-in-loop
        await fn();
        console.log('ok  ', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name, '\n     ', err.message);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
