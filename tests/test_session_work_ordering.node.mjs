// THE SESSION AND PROJECT LISTS ARE A TIMELINE, AND LOOKING AT ONE MUST
// NOT REORDER IT.
//
// The user reads down the list to recall what he has in flight: "it keeps
// me know what was recent and i can look down the list to recap other
// things. its sort of a timeline for me." Both lists used to be ordered by
// signals a mere LOOK could move - the sidebar by `is_this_tab` (the
// session this browser tab is attached to) and then `is_active`, the
// project list by `projects.last_opened_at`, which POST /sessions writes
// when you click a project. So opening a row hoisted it to the top and the
// timeline was destroyed by the act of reading it.
//
// These assertions pin the replacement: ordering keys on `last_work_at`,
// which only a Claude Code hook event representing WORK can move (see
// src/core/session_work_stamp.py and claude_hooks.WORK_EVENTS), and
// nothing a click can change participates in the comparison at all.
//
// THE CORE ASSERTION IS THE NEGATIVE ONE - "selecting a row leaves the
// order alone". A test that only proved work sorts to the top would pass
// just as happily on the old code, because the old code ALSO put worked
// sessions near the top most of the time. The regression this file exists
// to catch is the reorder-on-click, so that is what it measures directly.
//
// Run with: node tests/test_session_work_ordering.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// SLICE 3: the session data layer lives in the compiled bundle, and the
// `Launchpad` fields this harness drives are accessors over that one
// store. The REAL client/dist/app.js is evaluated in this sandbox rather
// than stubbed, so these assertions run against the shipped path.
import { installCloudeWeb } from './helpers/cloude-web-sandbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Description: run one named assertion block, recording pass or failure
 *   without aborting the file - a later assertion often explains an
 *   earlier one.
 * Inputs: name (string), fn (function). Output: Promise<void>.
 */
async function test(name, fn) {
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

/**
 * Description: evaluate client modules in one shared sandbox, the same way
 *   the browser loads them - `window` is the context itself, so each
 *   module's `window.X = ...` export is visible to the next.
 * Inputs: names (string[]) - filenames under client/js.
 * Output: object - the sandbox, usable as `window`.
 */
function loadModules(names) {
    /** A detached element stub, good enough for the escaper in rows.js. */
    function makeDiv() {
        let text = '';
        return {
            set textContent(v) { text = v == null ? '' : String(v); },
            get textContent() { return text; },
            get innerHTML() {
                return text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            },
        };
    }
    const context = {
        console: { log() {}, warn() {}, error() {} },
        document: { createElement: () => makeDiv() },
        Date, JSON, Math, Set, Map, Array, Object, String, Number, Boolean,
        Promise, setTimeout, clearTimeout, RegExp,
    };
    context.window = context;
    vm.createContext(context);
    installCloudeWeb(context);
    for (const name of names) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', name), 'utf8'),
            context,
            { filename: name },
        );
    }
    return context;
}

const win = loadModules([
    'session-listing-state.js',
    'session-sidebar-fetch.js',
    'session-status-ui.js',
    'session-row-actions.js',
    'session-sidebar-rows.js',
]);
const Fetch = win.SessionSidebarFetch;

/**
 * Description: three rows whose WORK order is deliberately the opposite of
 *   their creation order, so a sort that silently fell back to
 *   `created_at_epoch` cannot pass by accident.
 * Inputs: none. Output: Array<object>.
 */
function rows() {
    return [
        { name: 'old_work', created_at_epoch: 300, last_work_at: '2026-09-01T10:00:00Z' },
        { name: 'new_work', created_at_epoch: 100, last_work_at: '2026-09-03T10:00:00Z' },
        { name: 'never_worked', created_at_epoch: 200, last_work_at: null },
    ];
}

const names = (list) => list.map((r) => r.name);

await test('the order is by WORK, newest first', () => {
    assert.deepEqual(
        names(Fetch.defaultSort(rows())),
        ['new_work', 'old_work', 'never_worked'],
        'a session worked more recently must come first, regardless of age',
    );
});

await test('SELECTING a row does not move it - the core assertion', () => {
    // `is_this_tab` is what the sidebar sets on the session this browser
    // tab is attached to, i.e. exactly the row the user just clicked. It
    // used to be the FIRST sort term. Marking the bottom row selected must
    // now change nothing at all.
    const before = names(Fetch.defaultSort(rows()));
    const clicked = rows().map(
        (r) => (r.name === 'never_worked' ? { ...r, is_this_tab: true, is_active: true } : r),
    );
    assert.deepEqual(names(Fetch.defaultSort(clicked)), before,
        'clicking a row reordered the list - this is the regression');
    // And the middle one, so the assertion is not an artifact of the
    // clicked row already being last.
    const clickedMid = rows().map(
        (r) => (r.name === 'old_work' ? { ...r, is_this_tab: true, is_active: true } : r),
    );
    assert.deepEqual(names(Fetch.defaultSort(clickedMid)), before);
});

await test('NEITHER is_this_tab NOR is_active appears in the sort at all', () => {
    // A source assertion on top of the behavioural one above: the two
    // terms are gone, so a future edit cannot reintroduce one and merely
    // happen to produce the same order for these three fixtures.
    const src = fs.readFileSync(
        path.join(ROOT, 'client', 'js', 'session-sidebar-fetch.js'), 'utf8');
    const body = src.slice(src.indexOf('function defaultSort'));
    const sortBody = body.slice(0, body.indexOf('\n    }'));
    assert.ok(!sortBody.includes('is_this_tab'),
        'is_this_tab is back in defaultSort - a click can reorder the list again');
    assert.ok(!sortBody.includes('is_active'),
        'is_active is back in defaultSort - attaching can reorder the list again');
});

await test('UNRECORDED is a third outcome: last, but never treated as epoch 0', () => {
    const onlyUnworked = [
        { name: 'b', created_at_epoch: 100, last_work_at: null },
        { name: 'a', created_at_epoch: 200, last_work_at: null },
    ];
    assert.deepEqual(names(Fetch.defaultSort(onlyUnworked)), ['a', 'b'],
        'with nothing measured, rows keep a stable newest-created-first order');
    // The discriminator that a zero-valued fallback would fail: a session
    // worked at the very start of the epoch still outranks an unrecorded
    // one, because "measured, long ago" beats "never measured".
    const ancientWork = [
        { name: 'never', created_at_epoch: 999, last_work_at: null },
        { name: 'ancient', created_at_epoch: 1, last_work_at: '1970-01-01T00:00:01Z' },
    ];
    assert.deepEqual(names(Fetch.defaultSort(ancientWork)), ['ancient', 'never']);
});

await test('an unrecorded row SAYS so, so last does not read as stalest', () => {
    assert.ok(Fetch.workAttr({ last_work_at: null }).includes('data-work="unrecorded"'));
    assert.ok(Fetch.workAttr({ last_work_at: null }).includes('title='),
        'a machine-readable attribute alone is not visible to a person');
    assert.ok(Fetch.workAttr({ last_work_at: '2026-09-03T10:00:00Z' })
        .includes('data-work="recorded"'));
});

await test('the label actually reaches the rendered row', () => {
    // Guards against the attribute existing as a pure function nothing
    // calls - the row builder reaches it through window.SessionSidebarFetch.
    const html = win.SessionSidebarRows.rowHtml(
        { name: 'cloude_x', status: 'idle', last_work_at: null }, 'cozy',
    );
    assert.ok(html.includes('data-work="unrecorded"'), html.slice(0, 200));
    const worked = win.SessionSidebarRows.rowHtml(
        { name: 'cloude_y', status: 'idle', last_work_at: '2026-09-03T10:00:00Z' }, 'cozy',
    );
    assert.ok(worked.includes('data-work="recorded"'));
});

await test('the stamp index takes the MAX per tmux name, not the last seen', () => {
    // A tmux name is reusable: a dead instance and its live replacement can
    // share one. Taking the maximum is what makes the live instance's work
    // win without needing to know which row is live.
    const index = Fetch.workStampIndex([
        { tmux_name: 'cloude_Mac', last_work_at: '2026-09-03T12:00:00Z' },
        { tmux_name: 'cloude_Mac', last_work_at: '2026-08-01T12:00:00Z' },
        { tmux_name: 'cloude_Other', last_work_at: null },
        { tmux_name: null, last_work_at: '2026-09-03T12:00:00Z' },
    ]);
    assert.equal(index.get('cloude_Mac'), '2026-09-03T12:00:00Z');
    assert.equal(index.has('cloude_Other'), false,
        'a row with no stamp must contribute NOTHING, not a zero');
    assert.equal(index.size, 1);
});

await test('the launcher orders its own lists the same way', async () => {
    // THE SAME CLAIM, MEASURED INSTEAD OF READ. This used to slice the
    // TEXT of `Launchpad._sortRunningSessionsByWork` out of launchpad.js
    // and assert that the identifier `is_active` did not appear in it.
    // That could only ever hold while the function stayed in one file
    // under one name, and slice 3 moved it to
    // web/src/lib/sessions/attribution.ts without changing a rule - so a
    // source scan would have gone red over a pure relocation, and a
    // rename would have made it go GREEN over a deletion, which is worse.
    //
    // What is actually worth guarding is the thing the comment always
    // said: two surfaces answering the ordering question differently is
    // the class of bug this repo keeps re-finding. So both surfaces are
    // now RUN over one row set and required to agree, and the row set is
    // built so that a sort leading with `is_active` cannot produce the
    // same answer.
    const rows = [
        { name: 'cloude_stale', created_by_cloude: true, created_at_epoch: 9000 },
        { name: 'cloude_busy', created_by_cloude: true, created_at_epoch: 1000 },
        { name: 'cloude_none', created_by_cloude: true, created_at_epoch: 5000 },
    ];
    const records = [
        { tmux_name: 'cloude_stale', tmux_created_epoch: 9000, last_work_at: '2026-09-01T00:00:00Z' },
        { tmux_name: 'cloude_busy', tmux_created_epoch: 1000, last_work_at: '2026-09-09T00:00:00Z' },
    ];
    const stamps = Fetch.workStampIndex(records);
    const expected = ['cloude_busy', 'cloude_stale', 'cloude_none'];

    // THE SIDEBAR's own sort. Note it reads `last_work_at` OFF THE ROW,
    // because the sidebar stamps its rows from the index before sorting,
    // where the launcher looks the stamp up while comparing. Two
    // mechanics; the claim under test is that they answer the same.
    const sidebarRows = rows.map((r) => ({
        ...r,
        last_work_at: stamps.get(r.name) || null,
    }));
    assert.deepEqual(
        [...Fetch.defaultSort(sidebarRows)].map((r) => r.name),
        expected,
        'the sidebar stopped ordering by work'
    );

    // THE LAUNCHER's, which is the compiled tree's now, driven through
    // the two endpoints exactly as a poll tick drives it. `is_active` is
    // set on the row that must NOT move: a sort that led with it would
    // hoist `cloude_none` to the top and this fails.
    const web = installCloudeWeb(vm.createContext({
        console: { log() {}, warn() {}, error() {} },
    }));
    const store = web.launchpad.sessions;
    store.useHost({
        listAttachableSessions: async () => rows.map((r) => ({ ...r, status: 'idle' })),
        listSessions: async () => [{
            tmux_session: 'cloude_none', activity_status: 'idle', session: { id: 'ses_x' },
        }],
        getCurrentSession: async () => null,
        listSessionRecords: async () => records,
    });
    await store.loadRunningSessions((k) => k);
    assert.deepEqual(
        [...store.runningSessions].map((r) => r.name),
        expected,
        'the launcher disagrees with the sidebar, or leads with is_active again'
    );
    assert.equal(store.runningSessions.find((r) => r.name === 'cloude_none').is_active, true,
        'the row that must not move was not actually the live one');
    store.reset();
    store.useHost(null);

    // THE LABEL MOVED IN SLICE 4, AND SO DID THIS ASSERTION'S TARGET.
    // `_workRecencyAttrs` was a renderer on the launchpad singleton; the
    // rule is `workAttrs()` in web/src/lib/launchpad/project-node.ts now,
    // and the two callers that differ only in which sentence they hover
    // are named constants beside it. Reading the TS source keeps the
    // claim - that an unrecorded row is LABELLED rather than silently
    // sorted last - attached to the file that makes it.
    const src = fs.readFileSync(
        path.join(ROOT, 'web', 'src', 'lib', 'launchpad', 'project-node.ts'), 'utf8');
    assert.ok(src.includes('SESSION_WORK_UNRECORDED_KEY'),
        'the launcher no longer labels its unrecorded rows');
    assert.ok(src.includes('PROJECT_WORK_UNRECORDED_KEY'),
        'the launcher no longer labels its unrecorded projects');
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
