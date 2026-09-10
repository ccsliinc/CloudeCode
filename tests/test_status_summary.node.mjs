// Node-based tests for client/js/session-status-summary.js.
//
// WHY THIS FILE EXISTS. A group header's LED is a claim about sessions the
// user cannot currently see, which makes it the easiest place in the app
// to be confidently wrong. The fold has to hold three properties:
//
//   1. THE PRIORITY IS STABLE AND WRITTEN DOWN. waiting > working >
//      unread > idle > dead > unknown. If a refactor reorders it, a group
//      containing something blocked on the user stops announcing it.
//   1b. AND THE RING IS A SEPARATE FOLD. Since 2026-09-09 the header's
//      inner dot is the highest-priority state in the group while its
//      ring is ACTIVITY across the whole group, so a group holding one
//      parked session and one busy one has to paint the parked dot
//      inside a breathing ring. Deriving the ring from the winning
//      bucket instead would hide the running work behind the more
//      urgent dot.
//   2. AN EMPTY GROUP IS `unknown`, NOT `done`. Nothing to measure is not
//      the same as measured-and-quiet, and a calm green light on an empty
//      group is the false green this project keeps paying for.
//   3. THE HEADER CANNOT DISAGREE WITH ITS ROWS, because both resolve
//      through the same StatusLed mapping rather than through two copies
//      of the rules.
//
// Run with: node tests/test_status_summary.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createI18n } from '../client/js/i18n/runtime.js';
import { sessionSummaryLabel } from '../client/js/labels/session-summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;
const queue = [];

/** Queue one named assertion block. Inputs: name, fn. Output: void. */
function test(name, fn) {
    queue.push([name, fn]);
}

/** Run every queued test in order. Inputs: none. Output: Promise<void>. */
async function runQueue() {
    for (const [name, fn] of queue) {
        try {
            await fn();
            passes++;
            console.log(`ok - ${name}`);
        } catch (err) {
            failures++;
            console.error(`NOT OK - ${name}`);
            console.error(err && err.stack ? err.stack : err);
        }
    }
}

/**
 * Load status-led.js and session-status-summary.js into ONE sandbox.
 *
 * They share it because the summary module reads the LED's mapping off the
 * global - loading them separately would test a summary that resolves
 * against a different copy of the rules than the rows do, which is exactly
 * the drift these tests exist to prevent.
 *
 * THE SANDBOX IS THE PAGE, so it also gets the string layer. On a real
 * page `client/js/i18n/boot.js` publishes `CloudeI18n` and `CloudeLabels`
 * as a module script, before any render; here they are injected from the
 * SAME modules, which this file can simply import because it is real ESM.
 * Handing the sandbox a second copy of the strings would defeat the point
 * of there being one catalog.
 * Inputs: none. Output: object - {Led, Summary}.
 */
function loadModules() {
    const context = {
        console,
        CloudeI18n: createI18n({ locale: 'en' }),
        CloudeLabels: { sessionSummaryLabel },
    };
    vm.createContext(context);
    for (const file of ['status-led.js', 'session-status-summary.js']) {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'client', 'js', file),
            'utf8',
        );
        vm.runInContext(src, context);
    }
    return { Led: context.StatusLed, Summary: context.SessionStatusSummary };
}

const { Summary } = loadModules();

/**
 * Re-create a sandbox value in this realm - see the same helper in
 * test_status_led.node.mjs for why `assert/strict` needs it.
 * Inputs: value (any). Output: any.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// ---- the empty case ---------------------------------------------------

test('AN EMPTY GROUP IS UNKNOWN, NOT DONE', () => {
    const s = plain(Summary.summarizeStates([]));
    assert.equal(s.bucket, 'unknown');
    assert.equal(s.inner, 'unknown');
    assert.equal(s.outer, 'dim');
    assert.equal(s.total, 0);
    assert.equal(s.unreadCount, 0);
});

test('a null or non-array input is the empty case, not a crash', () => {
    assert.equal(plain(Summary.summarizeStates(null)).bucket, 'unknown');
    assert.equal(plain(Summary.summarizeStates(undefined)).bucket, 'unknown');
    assert.equal(plain(Summary.summarizeStates('nope')).bucket, 'unknown');
});

test('one malformed row cannot blank a whole header', () => {
    const s = plain(
        Summary.summarizeStates([null, 'garbage', { activity_status: 'working' }]),
    );
    assert.equal(s.bucket, 'working');
    assert.equal(s.total, 1, 'only the real row counts toward the total');
});

// ---- the priority order ------------------------------------------------

test('the documented priority order is the one in the table', () => {
    assert.deepEqual(
        plain(Summary.SUMMARY_PRIORITY).map((e) => e.key),
        ['permission', 'input', 'working', 'unread', 'done', 'dead', 'unknown'],
    );
});

test('THE `done` BUCKET MEANS READ, AND IT RENDERS THE GREY `idle` DOT', () => {
    // Two names, one meaning, and they must not be confused: the BUCKET
    // is called `done` because that is what the group is (finished, and
    // already read), while the DOT it paints is `idle`, because that is
    // what a read session looks like on a row. A header that painted the
    // green `done` dot here would contradict every child under it.
    const entry = plain(Summary.SUMMARY_PRIORITY).find((e) => e.key === 'done');
    assert.ok(entry, 'the done bucket exists');
    assert.equal(entry.inner, 'idle');
    // And there is no separate `idle` bucket to disagree with it.
    assert.equal(
        plain(Summary.SUMMARY_PRIORITY).filter((e) => e.key === 'idle').length,
        0,
    );
});

test('THE UNREAD RING IS REACHED ONLY WHEN NOTHING IS RUNNING', () => {
    // The ring carries BOTH activity and unread since the owner's
    // 2026-09-09 ruling, and only one of them can be painted. Activity
    // wins: a breathing ring expires on its own, a green unread ring
    // does not. This is the exhaustive check that the rule holds for
    // every pair of states, not just the ones somebody thought of.
    const open = ['working', 'question', 'notice'];
    const statuses = [
        'working', 'question', 'notice', 'finished_unread',
        'idle', 'dead', 'unknown',
    ];
    for (const a of statuses) {
        for (const b of statuses) {
            for (const unread of [true, false]) {
                const s = plain(
                    Summary.summarizeStates([
                        { activity_status: a, unread },
                        { activity_status: b },
                    ]),
                );
                if (open.includes(a) || open.includes(b)) {
                    assert.equal(s.outer, 'active',
                        `${a} + ${b} has an open turn and must breathe`);
                } else {
                    assert.notEqual(s.outer, 'active',
                        `${a} + ${b} has nothing running and must not breathe`);
                }
            }
        }
    }
});

test('THE RING IS FOLDED ACROSS THE GROUP, not looked up on the winning row', () => {
    // A parked session and a busy one: the dot points at the one that
    // needs a human, the ring says a turn is open behind it.
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'question' },
            { activity_status: 'working' },
        ]),
    );
    assert.equal(s.inner, 'waiting-permission');
    assert.equal(s.outer, 'active');

    // A group of nothing but read-and-resting sessions is steady, which
    // is exactly what a single such row paints.
    const quiet = plain(
        Summary.summarizeStates([
            { activity_status: 'idle' },
            { activity_status: 'idle' },
        ]),
    );
    assert.equal(quiet.inner, 'idle');
    assert.equal(quiet.outer, 'steady');

    // Add one unread turn and the ring goes green while the dot follows
    // the higher-priority bucket. Nothing is running, so nothing
    // outranks it.
    const waiting = plain(
        Summary.summarizeStates([
            { activity_status: 'finished_unread' },
            { activity_status: 'idle' },
        ]),
    );
    assert.equal(waiting.inner, 'done');
    assert.equal(waiting.outer, 'unread');
});

test('permission beats working - it is blocked on the user and will not resolve', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'working' },
            { activity_status: 'question' },
        ]),
    );
    assert.equal(s.bucket, 'permission');
    assert.equal(s.inner, 'waiting-permission');
});

test('a notice beats working but loses to a permission prompt', () => {
    const withWork = plain(
        Summary.summarizeStates([
            { activity_status: 'working' },
            { activity_status: 'notice' },
        ]),
    );
    assert.equal(withWork.bucket, 'input');
    // ONE BUCKET, TWO HUES: `notice` shares the `input` bucket with
    // `waiting-input` but keeps its own inner state, because it is the
    // only state that is BOTH working and asking for the user. The
    // bucket's RANK does not move; only the paint does.
    assert.equal(withWork.inner, 'notice');

    // THE HEADLINE IS THE PARKED SESSION, not the chatty one. A group
    // holding both must point the user at the row that will not move
    // until they act.
    const withPermission = plain(
        Summary.summarizeStates([
            { activity_status: 'notice' },
            { activity_status: 'question' },
        ]),
    );
    assert.equal(withPermission.bucket, 'permission');
    assert.equal(withPermission.inner, 'waiting-permission');
});

test('a startup prompt anywhere in the group hoists it to input', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'idle' },
            { activity_status: 'idle', startup_gate: 'awaiting_startup_prompt' },
        ]),
    );
    assert.equal(s.bucket, 'input');
});

test('working beats unread - one is moving, the other is only waiting', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'finished_unread' },
            { activity_status: 'working' },
        ]),
    );
    assert.equal(s.bucket, 'working');
});

test('unread beats read - the green dot is the headline of a quiet group', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'idle' },
            { activity_status: 'idle', unread: true },
        ]),
    );
    assert.equal(s.bucket, 'unread');
    assert.equal(s.inner, 'done');
    assert.equal(s.outer, 'unread', 'the green ring is what says so');
});

test('DEAD SITS BELOW DONE AND IDLE, so one corpse cannot headline nine live sessions', () => {
    const rows = [{ activity_status: 'dead' }];
    for (let i = 0; i < 9; i++) rows.push({ activity_status: 'working' });
    assert.equal(plain(Summary.summarizeStates(rows)).bucket, 'working');

    // A read, at-rest session (`idle`) still outranks a corpse in the same
    // group - the dead pane is not the headline next to a quiet live one
    // either.
    const quiet = [{ activity_status: 'dead' }, { activity_status: 'idle' }];
    assert.equal(plain(Summary.summarizeStates(quiet)).bucket, 'done');

    // `done` (unread) still outranks dead too.
    const quietUnread = [
        { activity_status: 'dead' },
        { activity_status: 'finished_unread' },
    ];
    assert.equal(plain(Summary.summarizeStates(quietUnread)).bucket, 'unread');
});

test('a group of nothing but dead sessions does say dead', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'dead' },
            { activity_status: 'stopped' },
        ]),
    );
    assert.equal(s.bucket, 'dead');
    assert.equal(s.outer, 'off');
});

test('unknown is last - any measured state is more informative', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'unknown' },
            { activity_status: 'idle' },
        ]),
    );
    assert.equal(s.bucket, 'done');
    // ... but a group of only unmeasured sessions stays unmeasured.
    const all = plain(
        Summary.summarizeStates([
            { activity_status: 'unknown' },
            { activity_status: 'unknown' },
        ]),
    );
    assert.equal(all.bucket, 'unknown');
});

// ---- idle: added 2026-09-09 --------------------------------------------

test('a group of nothing but read sessions reads done, not unknown', () => {
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'idle' },
            { activity_status: 'idle' },
        ]),
    );
    assert.equal(s.bucket, 'done');
    assert.equal(s.inner, 'idle');
    assert.equal(s.outer, 'steady');
});

test('one unread among ten idle still bubbles unread', () => {
    const rows = [{ activity_status: 'finished_unread' }];
    for (let i = 0; i < 10; i++) rows.push({ activity_status: 'idle' });
    const s = plain(Summary.summarizeStates(rows));
    assert.equal(s.bucket, 'unread');
    assert.equal(s.inner, 'done');
    assert.equal(s.outer, 'unread');
});

test('idle beats dead but loses to unread', () => {
    assert.equal(
        plain(
            Summary.summarizeStates([
                { activity_status: 'idle' },
                { activity_status: 'finished_unread' },
            ]),
        ).bucket,
        'unread',
    );
});

// ---- the unread count --------------------------------------------------

test('the badge counts unread ROWS, not unread-coloured lights', () => {
    // The working row buckets as `working`, so its halo is not the unread
    // colour - but it is still one unread thing waiting for the user, and
    // the badge is a count of those.
    const s = plain(
        Summary.summarizeStates([
            { activity_status: 'working', unread: true },
            { activity_status: 'idle', unread: true },
            { activity_status: 'idle' },
        ]),
    );
    assert.equal(s.unreadCount, 2);
    assert.equal(s.total, 3);
    assert.equal(s.bucket, 'working');
});

test('summaryHtml never renders a badge element at zero unread', () => {
    const html = Summary.summaryHtml([{ activity_status: 'idle' }]);
    assert.ok(html.includes('status-led'), 'the LED is always rendered');
    assert.ok(!html.includes('status-summary-badge'), 'no badge markup at all');
});

test('summaryHtml renders no badge when unread is non-zero, but the LED carries it', () => {
    const html = Summary.summaryHtml([
        { activity_status: 'idle', unread: true },
        { activity_status: 'idle', unread: true },
    ]);
    assert.ok(!html.includes('status-summary-badge'), 'the badge markup is gone entirely');
    assert.ok(html.includes('data-inner="done"'), 'the dot is the finished-turn one');
    assert.ok(html.includes('data-outer="unread"'), 'and the green ring is what says unread');
    assert.ok(html.includes('aria-label="unread - 2 sessions, 2 unread"'),
        'the count survives in words for accessibility');
    assert.ok(html.includes('title="unread - 2 sessions, 2 unread"'),
        'and in the hover title');
});

test('summaryHtml labels the empty case honestly', () => {
    const html = Summary.summaryHtml([]);
    assert.ok(html.includes('no sessions'));
    assert.ok(html.includes('data-inner="unknown"'));
});

// ---- the header cannot disagree with its rows --------------------------

test('a single-child group renders the same LED state as that child', () => {
    const { Led, Summary: S } = loadModules();
    const rows = [
        { activity_status: 'working' },
        { activity_status: 'question' },
        { activity_status: 'notice' },
        { activity_status: 'dead' },
        { activity_status: 'idle', unread: true },
        { activity_status: 'unknown' },
    ];
    for (const row of rows) {
        const child = plain(Led.ledStateFor(row));
        const header = plain(S.summarizeStates([row]));
        assert.deepEqual(
            { inner: header.inner, outer: header.outer },
            child,
            `header disagrees with its only child: ${row.activity_status}`,
        );
    }
});

// ---- THE SIDEBAR ROW SPELLS THE STATUS `status`, NOT `activity_status` --
//
// The defect measured on live at 880247f. `session-sidebar-fetch.js
// mergeLiveRow()` copies `info.activity_status` onto `row.status`, and the
// group header - the only caller of this module - passes those merged
// rows. A fold that read `activity_status` alone found undefined on every
// child, bucketed all of them `unknown`, and painted EVERY header
// `unknown/dim`: a group of twelve idle sessions and an empty group
// rendered identically. Every test above this line uses the server
// spelling, which is exactly why 23 of them were green over a header that
// had never once told the truth.

test('a merged SIDEBAR row (status:) folds identically to a server row', () => {
    // The negative control for the whole defect: if these two disagree,
    // the header is reading a field its own rows do not carry.
    const cases = [
        ['working', 'working', 'active'],
        ['question', 'waiting-permission', 'active'],
        ['notice', 'notice', 'active'],
        ['finished_unread', 'done', 'unread'],
        ['idle', 'idle', 'steady'],
        ['dead', 'dead', 'off'],
        ['unknown', 'unknown', 'dim'],
    ];
    for (const [state, inner, outer] of cases) {
        const sidebar = plain(Summary.summarizeStates([{ status: state }]));
        const server = plain(Summary.summarizeStates([{ activity_status: state }]));
        assert.equal(sidebar.inner, inner, `sidebar row ${state} inner`);
        assert.equal(sidebar.outer, outer, `sidebar row ${state} outer`);
        assert.deepEqual(
            { inner: sidebar.inner, outer: sidebar.outer, bucket: sidebar.bucket },
            { inner: server.inner, outer: server.outer, bucket: server.bucket },
            `the two spellings of ${state} must fold to one answer`,
        );
    }
});

test('unread and the startup gate reach the fold from a sidebar row too', () => {
    assert.equal(
        plain(Summary.summarizeStates([{ status: 'idle', unread: true }])).inner,
        'done',
    );
    const gated = plain(
        Summary.summarizeStates([
            { status: 'idle', startup_gate: 'awaiting_startup_prompt' },
        ]),
    );
    assert.equal(gated.bucket, 'input');
    assert.equal(gated.inner, 'waiting-input');
    assert.equal(gated.outer, 'active');
});

test('a row carrying NEITHER spelling is unknown, not a guess', () => {
    // The other half of the control. Reconciling the two names must not
    // become "find something to say": no field is no measurement.
    const s = plain(Summary.summarizeStates([{ name: 'cloude_a' }]));
    assert.equal(s.bucket, 'unknown');
    assert.equal(s.inner, 'unknown');
    assert.equal(s.outer, 'dim');
    assert.equal(s.total, 1, 'it is still counted as a member');
});

test('activity_status wins when a row somehow carries both', () => {
    const s = plain(
        Summary.summarizeStates([{ activity_status: 'working', status: 'idle' }]),
    );
    assert.equal(s.bucket, 'working');
});

test('an empty string in either field is not a status', () => {
    assert.equal(plain(Summary.summarizeStates([{ status: '' }])).inner, 'unknown');
    assert.equal(
        plain(Summary.summarizeStates([{ activity_status: '', status: 'working' }])).bucket,
        'working',
        'an empty activity_status falls through to the sidebar spelling',
    );
});

// ---- THE ROLL-UP THE OWNER ASKED FOR, over sidebar-shaped rows ----------

test('a group of nothing but read sidebar rows reads idle / steady', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push({ status: 'idle', unread: false });
    const s = plain(Summary.summarizeStates(rows));
    assert.equal(s.inner, 'idle');
    assert.equal(s.outer, 'steady');
    assert.equal(s.total, 12);
});

test('ONE working among idle reads working / active', () => {
    const s = plain(
        Summary.summarizeStates([
            { status: 'idle' }, { status: 'working' }, { status: 'idle' },
        ]),
    );
    assert.equal(s.inner, 'working');
    assert.equal(s.outer, 'active');
});

test('ONE done-unread among read rows reads done / unread - and never breathes', () => {
    const s = plain(
        Summary.summarizeStates([
            { status: 'idle' }, { status: 'idle', unread: true },
        ]),
    );
    assert.equal(s.inner, 'done');
    assert.equal(s.outer, 'unread',
        'the green ring says it, and `unread` is a STILL ring - only `active` moves');
});

test('a permission among working reads waiting-permission / ACTIVE', () => {
    // The two dimensions are folded INDEPENDENTLY: the dot is the most
    // urgent state in the group, the ring is whether anything in there is
    // moving. Deriving the ring from the winning bucket would hide the
    // running work behind the more urgent dot.
    const s = plain(
        Summary.summarizeStates([
            { status: 'working' }, { status: 'question' }, { status: 'working' },
        ]),
    );
    assert.equal(s.inner, 'waiting-permission');
    assert.equal(s.outer, 'active');
});

test('a notice keeps its own hue and still buckets as input', () => {
    // A `Notification` does not STOP the agent, so its turn is open and
    // its ring breathes like any other open turn. The bucket is `input`
    // (rank unchanged, that is the product decision); only the dot's hue
    // separates it from a session parked on a startup prompt.
    const s = plain(
        Summary.summarizeStates([{ status: 'idle' }, { status: 'notice' }]),
    );
    assert.equal(s.bucket, 'input');
    assert.equal(s.inner, 'notice');
    assert.equal(s.outer, 'active');

    // A STOPPED session in the same bucket takes the yellow instead -
    // whichever of the two is present, the header must not disagree
    // with the child it is describing.
    const stopped = plain(
        Summary.summarizeStates([
            { status: 'notice' },
            { status: 'idle', startup_gate: 'awaiting_startup_prompt' },
        ]),
    );
    assert.equal(stopped.bucket, 'input');
    assert.equal(stopped.inner, 'waiting-input');
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
