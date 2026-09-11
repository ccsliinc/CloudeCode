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

// =====================================================================
// THE TWO RENDER CASES MOVED IN SLICE 5.
//
// "a session whose pane is DEAD is absent from RUNNING" and "a session
// whose pane status is UNKNOWN still renders as running" both drove the
// real `loadRunningSessions` and read back the rendered rows, because the
// defect they were written for was always visible on screen and never in
// a log. The running list is a component now, and a `vm` sandbox has no
// `Element` for it to mount into - so they are asserted against a REAL
// DOM in web/src/lib/launchpad/running-membership.test.ts, still against
// the rendered rows, still pairing each dead row with a live one so
// "hide everything" cannot pass.
//
// That file also carries the state-level half, which this one never had:
// the husk leaves `sessionStore.runningSessions` and not merely the
// markup, so every other reader of that array - the project tree, a row
// action, the sort - is holding the same list the screen shows.
// =====================================================================

await test('no "earlier session" disclosure exists anywhere in the client', async () => {
    // SLICE 7: `client/js/launchpad.js` is gone, so the claim is made
    // against every slice 7 source - the shell, its help panel and the
    // modules beside them - rather than one deleted file.
    const { HOME_ALL_SRC: launchpad } = await import('./lib-home-source.mjs');
    const indexHtml = fs.readFileSync(
        path.join(ROOT, 'client', 'index.html'), 'utf8');
    assert.ok(!/this one replaced/.test(launchpad),
        'the home screen still renders the "this one replaced" disclosure');
    assert.ok(!/project-session-superseded/.test(launchpad),
        'the home screen still carries the superseded disclosure markup');
    assert.ok(!/SessionSupersede/.test(launchpad),
        'the home screen still calls the supersede classifier');
    assert.ok(!/session-supersede\.js/.test(indexHtml),
        'index.html still loads the supersede module');
    assert.ok(
        !fs.existsSync(path.join(ROOT, 'client', 'js', 'session-supersede.js')),
        'client/js/session-supersede.js still exists');
});

// =====================================================================
// THE PROJECT TREE's THREE CASES MOVED IN SLICE 4.
//
// `_endedSessionsForTree` is `endedSessionsForTree` in
// web/src/lib/launchpad/project-groups.ts now, and all three assertions
// live in web/src/lib/launchpad/project-groups.test.ts under
// "endedSessionsForTree, and its four filters":
//
//   - "a row a RUNNING successor names as its parent is already on
//     screen" (the two rows carry DIFFERENT tmux names on purpose, which
//     is the whole reason the live-name guard misses them)
//   - "it KEEPS an ended row whose successor is NOT running" (the
//     positive control: once nothing on screen represents the row,
//     hiding it would make it unreachable)
//   - "it keeps an ordinary ended session that has no successor at all"
//
// They are stronger there, because they drive the pure function against
// a typed input rather than a hand-built launchpad singleton. The
// one-list rule they enforce is unchanged.
// =====================================================================

// =====================================================================
// 6. THE PARENT-LINK BADGE IS GONE from the running row.
// =====================================================================

// MOVED IN SLICE 5, and the assertion got STRONGER rather than smaller.
// `_renderSessionIdHtml` was a string builder and this drove it directly,
// so it could only prove that ONE function emitted no arrow. The badge is
// part of the card now, and
// web/src/lib/launchpad/running-membership.test.ts asserts the same three
// claims over the WHOLE RENDERED ROW: the id renders, no arrow appears
// anywhere on it, and the replaced session is not named anywhere on it.

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
