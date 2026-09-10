// The notification history's pure half, and the ring that stops a
// dismissed card coming back.
// ----------------------------------------------------------------------
// TWO MODULES, ONE SUITE, because they are the two halves of the same
// change and each is meaningless without the other:
//
//   client/js/toast-history-render.js decides every word a history row
//   claims (punchlist 8). It is pure, so what it says can be asserted
//   directly rather than inferred from a screenshot.
//
//   client/js/toast-dismissed-ring.js is the short memory that stops the
//   new cross-session poll (punchlist 7) resurrecting a card whose ack is
//   still in flight. Its whole contract is an expiry, so the clock is
//   injected and the rule is measured rather than waited for.
//
// THE OUTCOME VOCABULARY IS THE POINT OF HALF THIS FILE, and it grew a
// third word once the evidence for one existed. It used to say two: the
// server recorded `acknowledged` as a bare boolean and nothing stamped
// which act set it, so a row could only say `dismissed` or `open`.
// `ack_reason` closes that - the human paths write `dismissed`, the
// hook-driven auto-ack writes `answered` (src/core/toast_auto_ack.py) -
// so a row may now say `answered` because the server SAID so, not
// because the page guessed. A record carrying no reason still reads
// `dismissed`, which is the claim that assumes least, and the suite
// asserts the three-value vocabulary so a fourth has to arrive with the
// evidence that justifies it.
//
// NEGATIVE CONTROLS. Every "it is filtered" assertion is preceded by
// proof the same input survives when the filter is not armed - a ring
// that returned [] for everything would satisfy every suppression check
// while destroying the notifications it exists to protect.
//
// NOT A PIXEL TEST. There is no layout or stylesheet here.
//
// Run with: node tests/test_toast_history_render.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/**
 * Description: evaluate a shipped client module in a fresh fake-window
 *   context and hand back the globals it defined. Loading the REAL file
 *   is the point - a test against a re-typed copy measures the copy.
 * Inputs: files (array of repo-relative paths), extras (object merged
 *   into the context before evaluation).
 * Output: the context object.
 */
function load(files, extras = {}) {
    const ctx = { console, Date, Math, JSON, Map, Set, Array, isNaN, String, ...extras };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    return ctx;
}

const tests = [];
/** Description: register one named case. Inputs: name, fn. Output: None. */
function test(name, fn) { tests.push([name, fn]); }

// ------------------------------------------------------- history render

const RENDER = ['client/js/toast-history-render.js'];

test('a kind is translated to the word the rest of the UI uses', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    assert.equal(R.kindLabel('PermissionRequest'), 'permission');
    assert.equal(R.kindLabel('Notification'), 'notice');
    assert.equal(R.kindLabel('Stop'), 'done');
    assert.equal(R.kindLabel('StartupPrompt'), 'startup');
});

test('an UNKNOWN kind is passed through verbatim, never defaulted', () => {
    // A future kind rendered as "notice" would be a silent mislabel on a
    // page whose job is to report what happened.
    const { ToastHistoryRender: R } = load(RENDER);
    assert.equal(R.kindLabel('SomethingNew'), 'SomethingNew');
    assert.equal(R.kindLabel(undefined), 'unknown');
});

test('the outcome vocabulary is exactly three words', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    assert.equal(R.outcomeOf({ acknowledged: true }), 'dismissed');
    assert.equal(R.outcomeOf({ acknowledged: false }), 'open');
    assert.equal(R.outcomeOf({}), 'open', 'a record with no flag is not yet dealt with');
    assert.equal(R.outcomeOf(null), 'open');
    assert.equal(
        R.outcomeOf({ acknowledged: true, ack_reason: 'answered' }), 'answered',
        'the third outcome arrived with the evidence for it: the server now '
        + 'stamps ack_reason, so a hook-cleared record is a recorded fact '
        + 'rather than a guess');
    assert.deepEqual(
        [R.OUTCOME_OPEN, R.OUTCOME_DISMISSED, R.OUTCOME_ANSWERED].sort(),
        ['answered', 'dismissed', 'open'],
        'a FOURTH outcome must arrive with the server-side evidence for it');
});

test('an acked record with no reason reads dismissed, never answered', () => {
    // THE CLAIM THAT ASSUMES LEAST. Records acked before `ack_reason`
    // existed carry null, and not having recorded which act cleared a
    // toast is not evidence it cleared itself.
    const { ToastHistoryRender: R } = load(RENDER);
    assert.equal(R.outcomeOf({ acknowledged: true, ack_reason: null }), 'dismissed');
    assert.equal(R.outcomeOf({ acknowledged: true, ack_reason: 'dismissed' }),
        'dismissed');
    // NEGATIVE CONTROL: an unrecognised future reason must not be read as
    // the auto-ack either.
    assert.equal(R.outcomeOf({ acknowledged: true, ack_reason: 'swept' }),
        'dismissed');
});

test('the session name goes through the app-wide resolver when there is one', () => {
    const ctx = load(RENDER, {
        SessionLabel: {
            UNKNOWN: 'unknown session',
            resolveToast: (t) => (t.session_label ? `RESOLVED:${t.session_label}` : null),
        },
    });
    const R = ctx.ToastHistoryRender;
    assert.equal(R.sessionText({ session_label: 'Dev' }), 'RESOLVED:Dev');
});

test('a toast that can name no session SAYS so rather than being dropped', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    // Negative control first: the identical call with identity present
    // must NOT produce the unknown marker, or this proves nothing.
    assert.equal(R.sessionText({ session_name: 'cloude_x' }), 'cloude_x');
    assert.equal(R.sessionText({}), 'unknown session');
});

test('relative time is coarse, and an unparseable stamp yields nothing', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    const now = Date.parse('2026-09-08T12:00:00Z');
    assert.equal(R.relativeTime('2026-09-08T11:59:30Z', now), 'just now');
    assert.equal(R.relativeTime('2026-09-08T11:59:00Z', now), '1 minute ago');
    assert.equal(R.relativeTime('2026-09-08T11:30:00Z', now), '30 minutes ago');
    assert.equal(R.relativeTime('2026-09-08T09:00:00Z', now), '3 hours ago');
    assert.equal(R.relativeTime('2026-09-06T12:00:00Z', now), '2 days ago');
    // 'NaN ago' and the epoch are both worse than saying nothing.
    assert.equal(R.relativeTime('not a date', now), '');
    assert.equal(R.absoluteTime('not a date'), '');
});

test('a row carries every field a reader needs and nothing invented', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    const now = Date.parse('2026-09-08T12:00:00Z');
    const view = R.row({
        id: 't1',
        session_id: 'ses_a',
        session_label: 'Cloude Code',
        kind: 'PermissionRequest',
        title: 'approve?',
        body: 'rm -rf /tmp/x',
        acknowledged: false,
        created_at: '2026-09-08T11:55:00Z',
    }, now);
    assert.equal(view.id, 't1');
    assert.equal(view.sessionId, 'ses_a');
    assert.equal(view.session, 'Cloude Code');
    assert.equal(view.kind, 'permission');
    assert.equal(view.rawKind, 'PermissionRequest');
    assert.equal(view.title, 'approve?');
    assert.equal(view.body, 'rm -rf /tmp/x');
    assert.equal(view.outcome, 'open');
    assert.equal(view.relative, '5 minutes ago');
    assert.equal(view.jumpable, true);
});

test('a record with no session id is NOT jumpable', () => {
    // The one case a jump link cannot be honoured, so it is not offered
    // rather than offered and silently doing nothing.
    const { ToastHistoryRender: R } = load(RENDER);
    assert.equal(R.row({ id: 't', session_id: 'ses_a' }).jumpable, true);
    assert.equal(R.row({ id: 't' }).jumpable, false);
});

test('the empty state names the retention instead of implying nothing happened', () => {
    const { ToastHistoryRender: R } = load(RENDER);
    const text = R.emptyText('process_memory');
    assert.match(text, /current server run/,
        'an empty list after a restart means the record was LOST, and the '
        + 'page has to say so');
    assert.match(text, /restarting the server clears it/);
});

// -------------------------------------------------------- dismissed ring

const RING = ['client/js/toast-dismissed-ring.js'];

test('a dismissed id is filtered out of the next poll result', () => {
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing();
    const payload = [{ id: 'a' }, { id: 'b' }];
    // NEGATIVE CONTROL: nothing noted, nothing filtered.
    assert.deepEqual(ring.filter(payload).map((t) => t.id), ['a', 'b']);
    ring.note('a');
    assert.deepEqual(ring.filter(payload).map((t) => t.id), ['b']);
});

test('the suppression EXPIRES, so a failed ack is not silence forever', () => {
    // If the ack genuinely failed, the record is still unacked on the
    // server and must come back. A permanent ring would turn a failed
    // write into a notification the user never sees again.
    let clock = 1000;
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing({ now: () => clock, ttlMs: 5000 });
    ring.note('a');
    assert.equal(ring.has('a'), true);
    clock += 4999;
    assert.equal(ring.has('a'), true, 'still inside the window');
    clock += 2;
    assert.equal(ring.has('a'), false, 'past the window it must be forgotten');
});

test('noting the same id twice is idempotent, not two entries', () => {
    let clock = 0;
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing({ now: () => clock });
    ring.note('a');
    ring.note('a');
    ring.note('a');
    assert.equal(ring.size(), 1);
});

test('a re-note refreshes the entry rather than ageing out on the first', () => {
    let clock = 0;
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing({ now: () => clock, ttlMs: 100 });
    ring.note('a');
    clock = 80;
    ring.note('a');
    clock = 150;
    assert.equal(ring.has('a'), true, 'the SECOND note is what the age is measured from');
});

test('the ring is bounded, oldest evicted first', () => {
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing({ maxEntries: 3 });
    ['a', 'b', 'c', 'd'].forEach((id) => ring.note(id));
    assert.equal(ring.size(), 3);
    assert.equal(ring.has('a'), false, 'the oldest fell off');
    assert.equal(ring.has('d'), true);
});

test('a malformed poll payload yields [] rather than throwing', () => {
    // A response shape the poller did not expect must not take down the
    // loop - a stopped notification poll is silence, which is the exact
    // failure this whole change exists to fix.
    const { ToastDismissedRing } = load(RING);
    const ring = new ToastDismissedRing();
    // Length, not deepEqual: the array comes back from the module's own
    // vm realm, so its Array prototype is not this realm's and a
    // structural comparison fails on identity rather than on content.
    assert.equal(ring.filter(null).length, 0);
    assert.equal(ring.filter(undefined).length, 0);
    assert.equal(ring.filter({ toasts: [] }).length, 0);
    assert.equal(ring.filter([null, { id: 'a' }]).length, 2,
        'a null ENTRY is passed through, not swallowed - it is the caller\'s '
        + 'to reject, and dropping it here would hide a server bug');
});

// ------------------------------------------------ wiring, read off source

test('toast-lifecycle.js announces every dismissal so the poller can suppress it', () => {
    // issue #55 moved dismiss() (which fires cloude:toast-dismissed) into
    // toast-lifecycle.js and _renderCard() (which marks a card clickable)
    // into toast-render.js - the two halves of this claim now live in
    // different files, split along the same seam the rest of the module
    // was split along.
    const lifecycleSrc = fs.readFileSync(
        path.join(ROOT, 'client/js/toast-lifecycle.js'), 'utf8');
    const renderSrc = fs.readFileSync(
        path.join(ROOT, 'client/js/toast-render.js'), 'utf8');
    assert.match(lifecycleSrc, /cloude:toast-dismissed/,
        'without this event the poll tick resurrects the card the user just '
        + 'dismissed, while its ack is still in flight');
    assert.match(renderSrc, /toast--clickable/,
        'a card is now usually about a session that is NOT on screen, so it '
        + 'has to be a way to get there');
});

test('the dismiss button stops the click reaching the card navigate handler', () => {
    const src = fs.readFileSync(
        path.join(ROOT, 'client/js/toast-render.js'), 'utf8');
    assert.match(src, /stopPropagation\(\);\n\s*this\.dismissGroup\(key\)/,
        'dismissing a card must not also yank the user into the session');
});

test('the poller filters through the ring before it backfills', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/js/toast-global-poll.js'), 'utf8');
    assert.match(src, /r\.filter\(list\)/);
    assert.match(src, /ToastManager\.backfill\(fresh\)/,
        'it must feed the SAME backfill the WS/attach path uses, so a record '
        + 'arriving by both routes dedupes on id and renders once');
    assert.match(src, /unackedOnly: true/);
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
