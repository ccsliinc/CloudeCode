// A SESSION APPEARS IN EXACTLY ONE LIST. Node test for the launchpad's
// RUNNING and RECENT sections: client/js/launchpad.js
// loadRunningSessions() / loadRecentSessions() / renderRecentSessions().
//
// THE DEFECT THIS PINS. RUNNING is built from a LIVE TMUX PROBE
// (GET /sessions/attachable) and RECENT from a DATABASE READ
// (GET /sessions/recent, lifecycle='stopped'). Two different sources, and
// nothing reconciled them: a row whose reaper had not run yet still read
// 'stopped' in the database while its tmux session was plainly in the
// listing, so the SAME session rendered in BOTH sections. The owner saw
// two running sessions and the same two again under recent.
//
// WHY THE EXCLUSION IS DONE AGAINST THE LIVE PROBE AND NOT THE STORED
// LIFECYCLE. The stored lifecycle is a snapshot written by a reaper that
// runs on its own schedule; the probe is taken this tick. When they
// disagree the probe is the fresher measurement, and trusting the stale
// one is what put the row in two places to begin with.
//
// ASSERTED AGAINST RENDERED MARKUP, NOT STATE. This project shipped a
// feature with 282 green state assertions that rendered zero pixels
// (CLAUDE.md hazard 50), so every assertion below reads the actual HTML
// string the renderer wrote into the stub container.
//
// Run with: node tests/test_session_lists_are_disjoint.node.mjs

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
 * Run one named assertion block, recording pass/fail rather than throwing.
 *
 * Description: AWAITS the body, so an async assertion that rejects is
 *   recorded as a failure instead of becoming an unhandled rejection that
 *   leaves the suite reporting a pass it never made.
 * @param {string} name  Test description.
 * @param {() => (void|Promise<void>)} fn  Body; throwing marks it failed.
 * @returns {Promise<void>}
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
 * Build one stub element that records what the renderer writes into it.
 * @param {string} id  Element id, for getElementById lookup.
 * @returns {object} Stub with innerHTML, textContent, style and dataset.
 */
function makeEl(id) {
    return {
        id,
        innerHTML: '',
        textContent: '',
        style: {},
        dataset: {},
        _attrs: {},
        setAttribute(name, value) { this._attrs[name] = String(value); },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this._attrs, name)
                ? this._attrs[name] : null;
        },
        addEventListener() {},
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: {
            add() {}, remove() {}, toggle() {}, contains() { return false; },
        },
    };
}

/**
 * Load launchpad.js in a vm sandbox with canned RUNNING and RECENT
 * responses, run both loaders, and hand back the rendered containers.
 *
 * Description: runs the RUNNING loader FIRST, exactly as the app does,
 *   because the recent renderer reads `this.runningSessions` to decide
 *   what to exclude. Reversing them would test an ordering the app never
 *   uses.
 * @param {{attachable: Array<object>, recent: object}} opts
 * @returns {Promise<{recentList: object, runningList: object, lp: object}>}
 */
async function loadBoth({ attachable, recent }) {
    const recentList = makeEl('recent-sessions-list');
    const recentCount = makeEl('recent-sessions-count');
    const recentSection = makeEl('recent-sessions-section');
    const runningList = makeEl('running-sessions-list');
    const runningCount = makeEl('running-sessions-count');
    const runningSection = makeEl('running-sessions-section');
    const byId = {
        'recent-sessions-list': recentList,
        'recent-sessions-count': recentCount,
        'recent-sessions-section': recentSection,
        'running-sessions-list': runningList,
        'running-sessions-count': runningCount,
        'running-sessions-section': runningSection,
    };
    const fakeDocument = {
        getElementById(id) { return byId[id] || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement() { return makeEl('created'); },
    };
    const fakeWindow = {
        API: {
            async listAttachableSessions() { return attachable; },
            async listSessions() { return []; },
            async getCurrentSession() { return null; },
            async listRecentSessions() { return recent; },
        },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        addEventListener() {},
        dispatchEvent() {},
        CustomEvent: function CustomEvent(type, opts) {
            this.type = type;
            this.detail = opts && opts.detail;
        },
        requestAnimationFrame(cb) { cb(); },
        matchMedia() { return { matches: false, addEventListener() {} }; },
    };
    fakeWindow.window = fakeWindow;
    const context = {
        window: fakeWindow,
        document: fakeDocument,
        console: { log() {}, warn() {}, error() {}, debug() {} },
        localStorage: fakeWindow.localStorage,
        requestAnimationFrame: fakeWindow.requestAnimationFrame,
        CustomEvent: fakeWindow.CustomEvent,
        setInterval() { return 0; },
        clearInterval() {},
        setTimeout() { return 0; },
        clearTimeout() {},
        alert() {},
    };
    vm.createContext(context);
    installCloudeWeb(context);
    // ONE SCRIPT NOW. `session-recent-visibility.js` was deleted with
    // slice 2 and its rule is imported into the bundle instead; see the
    // note above the first test for where it is asserted.
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'launchpad.js'), 'utf8'),
        context,
        { filename: 'launchpad.js' }
    );
    const lp = context.window.Launchpad;
    await lp.loadRunningSessions();
    return { recentList, runningList, lp };
}

/** One live tmux session as GET /sessions/attachable reports it. */
/**
 * A stable stored-row id for a fixture name.
 *
 * Description: `live('x')` and `stored('x')` mean "the same session" in
 *   every fixture in this file, and the exclusion rule is keyed on the
 *   stored row id rather than on the tmux name (tmux reuses names - see
 *   client/js/session-recent-visibility.js). Deriving both ids from the
 *   name keeps that pairing without hand-numbering every fixture.
 * @param {string} name  tmux session name.
 * @returns {number} a positive, deterministic row id.
 */
function idFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i += 1) {
        h = (h * 31 + name.charCodeAt(i)) % 100000;
    }
    return h + 1;
}

function live(name, overrides = {}) {
    return {
        name,
        session_row_id: idFor(name),
        label: null,
        status: 'running',
        is_active: false,
        created_by_cloude: true,
        created_at_epoch: 1788444837,
        working_dir: '/tmp/proj',
        agent_type: 'claude',
        ...overrides,
    };
}

/** One stored stopped row as GET /sessions/recent reports it. */
function stored(tmuxName, overrides = {}) {
    return {
        id: idFor(tmuxName),
        session_uuid: `uuid-${tmuxName}`,
        origin: 'created',
        owned: true,
        tmux_socket: 'cloude',
        tmux_name: tmuxName,
        tmux_created_epoch: 1788016091,
        lifecycle: 'stopped',
        lifecycle_source: 'tmux_missing',
        project_id: null,
        project_attribution: 'none',
        working_dir: '/tmp/proj',
        agent_type: 'claude',
        agent_family: 'claude',
        agent_family_source: 'reserved_name',
        archived_at: null,
        title: null,
        ...overrides,
    };
}

/**
 * Count how many of the given tmux names appear in a rendered container.
 * @param {object} el  Stub element whose innerHTML the renderer wrote.
 * @param {string} name  tmux session name to look for.
 * @returns {number} occurrences.
 */
function occurrences(el, name) {
    const html = el.innerHTML || '';
    return html.split(name).length - 1;
}

// =====================================================================
// 1. THE RULE: a session currently running is NOT in recent.
// =====================================================================

// =====================================================================
// TRIMMED BY SVELTE SLICE 2, AND THE RULE ITSELF DID NOT MOVE - THE
// SURFACE DID.
//
// "A session appears in exactly one list" has two halves. The RECENT
// half was `client/js/session-recent-visibility.js` plus
// `Launchpad.renderRecentSessions`, and both were deleted when the
// section moved into web/src/lib/launchpad/. That half is now:
//
//   web/src/lib/launchpad/recent-visibility.test.ts
//       every exclusion case, including the archived row that survives a
//       live session reusing its tmux name, and a NEGATIVE CONTROL
//       proving the filter can exclude at all - which the version here
//       did not have.
//   web/src/lib/launchpad/recent.test.ts
//       that the rendered count follows the exclusion, so a hidden row
//       cannot still be counted.
//
// THE RUNNING half and the TREE half are still launchpad.js, and they
// are what is left below. Slice 3 moves the running list and takes them
// with it.
// =====================================================================

await test('a session whose pane is DEAD is absent from RUNNING', async () => {
    const { runningList, lp } = await loadBoth({
        attachable: [
            live('cloude_Alive'),
            live('cloude_Corpse', { status: 'dead' }),
        ],
        recent: { state: 'ok', sessions: [], notice: null },
    });
    assert.equal(
        occurrences(runningList, 'cloude_Corpse'), 0,
        `a dead pane rendered as running: ${runningList.innerHTML}`);
    assert.ok(
        occurrences(runningList, 'cloude_Alive') >= 1,
        'the live session was dropped too, so the filter is too broad');
    assert.equal(
        lp.runningSessions.length, 1,
        'the dead row is still in the running state array');
});

await test('a session whose pane status is UNKNOWN still renders as running', async () => {
    // THE THIRD OUTCOME. Only a MEASURED `dead` is dropped. Dropping
    // `unknown` would assert a death nobody measured - the same invented
    // verdict in the opposite direction.
    const { runningList } = await loadBoth({
        attachable: [live('cloude_Unsure', { status: 'unknown' })],
        recent: { state: 'ok', sessions: [], notice: null },
    });
    assert.ok(
        occurrences(runningList, 'cloude_Unsure') >= 1,
        `an unevaluable pane was dropped as if measured dead: ${runningList.innerHTML}`);
});

// =====================================================================
// 4. THE SUPERSEDE DISCLOSURE IS GONE, structurally.
// =====================================================================

await test('no "earlier session" disclosure exists anywhere in the client', async () => {
    const launchpad = fs.readFileSync(
        path.join(ROOT, 'client', 'js', 'launchpad.js'), 'utf8');
    const indexHtml = fs.readFileSync(
        path.join(ROOT, 'client', 'index.html'), 'utf8');
    assert.ok(!/this one replaced/.test(launchpad),
        'launchpad.js still renders the "this one replaced" disclosure');
    assert.ok(!/project-session-superseded/.test(launchpad),
        'launchpad.js still carries the superseded disclosure markup');
    assert.ok(!/SessionSupersede/.test(launchpad),
        'launchpad.js still calls the supersede classifier');
    assert.ok(!/session-supersede\.js/.test(indexHtml),
        'index.html still loads the supersede module');
    assert.ok(
        !fs.existsSync(path.join(ROOT, 'client', 'js', 'session-supersede.js')),
        'client/js/session-supersede.js still exists');
});

// =====================================================================
// THE PROJECT TREE obeys the same one-list rule, including for the
// legacy rows a name comparison cannot catch. Still launchpad.js.
// =====================================================================

/**
 * Drive _endedSessionsForTree() against canned running rows and records.
 * @param {object[]} running  What the live tmux probe reported.
 * @param {object[]} records  What GET /sessions/records returned.
 * @returns {Promise<string[]>} tmux names the tree would list as ENDED.
 */
async function endedInTree(running, records) {
    const { lp } = await loadBoth({
        attachable: running,
        recent: { state: 'ok', sessions: [], notice: null },
    });
    lp.sessionAttributionListingOk = true;
    lp.sessionRecords = records;
    lp.runningSessions = running;
    return lp._endedSessionsForTree().map(r => r.name);
}

await test('the tree drops an ended row its RUNNING successor already shows', async () => {
    // The two rows carry DIFFERENT tmux names on purpose - that is the
    // whole reason the live-name guard misses them, and it is exactly
    // the shape of the owner's real data.
    const ended = await endedInTree(
        [live('cloude_Media_Compression')],
        [
            { id: 4, tmux_name: 'Media_Compression', lifecycle: 'stopped',
              session_uuid: 'u4', archived_at: null, parent_session_id: null },
            { id: 7, tmux_name: 'cloude_Media_Compression', lifecycle: 'running',
              session_uuid: 'u7', archived_at: null, parent_session_id: 4 },
        ]
    );
    assert.ok(!ended.includes('Media_Compression'),
        `the tree listed a session twice: ended=${JSON.stringify(ended)}`);
    assert.equal(ended.length, 0);
});

await test('the tree KEEPS an ended row whose successor is not running', async () => {
    // POSITIVE CONTROL. Once nothing on screen represents the row,
    // hiding it would make it unreachable.
    const ended = await endedInTree(
        [],
        [
            { id: 4, tmux_name: 'Media_Compression', lifecycle: 'stopped',
              session_uuid: 'u4', archived_at: null, parent_session_id: null },
            { id: 7, tmux_name: 'cloude_Media_Compression', lifecycle: 'stopped',
              session_uuid: 'u7', archived_at: null, parent_session_id: 4 },
        ]
    );
    assert.equal(ended.length, 2,
        `the tree hid rows nothing else represents: ${JSON.stringify(ended)}`);
});

await test('the tree keeps an ordinary ended session with no successor', async () => {
    const ended = await endedInTree(
        [live('cloude_Media_Compression')],
        [
            { id: 9, tmux_name: 'cloude_Old_Thing', lifecycle: 'stopped',
              session_uuid: 'u9', archived_at: null, parent_session_id: null },
            { id: 7, tmux_name: 'cloude_Media_Compression', lifecycle: 'running',
              session_uuid: 'u7', archived_at: null, parent_session_id: null },
        ]
    );
    assert.deepStrictEqual(ended.length, 1);
    assert.ok(ended.includes('cloude_Old_Thing'));
});

// =====================================================================
// 6. THE PARENT-LINK BADGE IS GONE from the running row.
// =====================================================================

await test('a running row does not render an arrow to the session it replaced', async () => {
    const { lp } = await loadBoth({
        attachable: [],
        recent: { state: 'ok', sessions: [], notice: null },
    });
    const html = lp._renderSessionIdHtml({ session_row_id: 7, parent_session_id: 4 });
    assert.ok(/#7/.test(html), `the row id itself must still render: ${html}`);
    assert.ok(!/\u2190/.test(html) && !/&larr;/.test(html),
        `the parent arrow is still rendered: ${html}`);
    assert.ok(!/#4/.test(html),
        `the replaced session is still named: ${html}`);
    assert.ok(!/fork-of/.test(html), `fork-of markup remains: ${html}`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
