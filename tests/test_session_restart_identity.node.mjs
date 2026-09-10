// Node test for RESTART carrying a stopped session's identity:
// client/js/launchpad.js _renderRecentSessionRowHtml() /
// _renderEndedTreeSessionRowHtml() / _restartPlan() / _restartNotice() /
// _restartRecentSession().
//
// THE DEFECT THIS LOCKS DOWN. The restart control built its request from
// working_dir and agent_type alone. The row's TITLE was never put into the
// button markup at all, and its session_uuid was in the row's dataset but
// never passed to the handler - so restarting a named session with hours of
// conversation behind it produced an unnamed blank console in the right
// directory. TWO call sites lost the same information: the RECENT list and
// the project tree's ended rows. Both are asserted here, separately,
// because a fix applied to one of them is exactly how this returns.
//
// WHY THIS ASSERTS ON RENDERED MARKUP AND ON THE ACTUAL CALL ARGUMENTS.
// Same reason as tests/test_recent_sessions.node.mjs: this project shipped
// a feature with 282 green state assertions that rendered zero pixels. Every
// markup assertion below reads the HTML string the renderer wrote into the
// stub container; every payload assertion reads what the API stub was
// actually handed, not what a plan object said it would be handed.
//
// THREE-OUTCOME RULE, asserted twice:
//   - a row with NO session_uuid must not silently start a blank session
//     while implying it resumed one. It gets a notice naming what could not
//     be determined.
//   - a server response of conversation='none_recorded' or 'unknown' must
//     produce a DIFFERENT user-visible sentence from 'resumed'.
//
// TRAP NOTED FOR THE NEXT READER: deepStrictEqual compares prototypes, and
// an object built inside vm.runInContext has a different Object.prototype
// from this module's, so two identical empty objects FAIL that check. Every
// payload assertion below reads Object.keys(...).length and named fields.
//
// Run with: node tests/test_session_restart_identity.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * MUST be awaited by every caller - an un-awaited async body reports a pass
 * before it has run, which is a green suite that measured nothing.
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
        appendChild() {},
        addEventListener() {},
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
}

/**
 * Load launchpad.js in a vm sandbox with recording API stubs.
 * @param {object} [opts]
 * @param {object|Error} [opts.restartResult] Value restartSession resolves
 *   to, or an Error it rejects with.
 * @returns {{lp: object, calls: object, errors: string[], byId: object}}
 */
function loadLaunchpad(opts = {}) {
    const calls = { restart: [], create: [] };
    const errors = [];
    const byId = {
        'recent-sessions-list': makeEl('recent-sessions-list'),
        'recent-sessions-count': makeEl('recent-sessions-count'),
        'recent-sessions-section': makeEl('recent-sessions-section'),
        'project-list': makeEl('project-list'),
    };
    const fakeDocument = {
        getElementById(id) { return byId[id] || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement() { return makeEl('created'); },
        body: makeEl('body'),
    };
    const fakeWindow = {
        API: {
            async listRecentSessions() {
                return { state: 'ok', sessions: [], notice: null };
            },
            async restartSession(uuid) {
                calls.restart.push(uuid);
                if (opts.restartResult instanceof Error) throw opts.restartResult;
                return opts.restartResult === undefined
                    ? { success: true, conversation: 'resumed', lineage_recorded: true }
                    : opts.restartResult;
            },
            async createSession(payload) {
                calls.create.push(payload);
                return { session_id: 'ses_new' };
            },
        },
        SessionStatusUI: { dotHtml() { return '<i class="dot"></i>'; } },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        addEventListener() {},
        dispatchEvent() {},
        CustomEvent: function CustomEvent(type, o) { this.type = type; this.detail = o && o.detail; },
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
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'launchpad.js'), 'utf8'),
        context,
        { filename: 'launchpad.js' }
    );
    const lp = context.window.Launchpad;
    // Capture every user-visible sentence instead of rendering a banner.
    lp.showError = (m) => { errors.push(String(m)); };
    lp.loadRunningSessions = async () => {};
    lp.loadSessionAttribution = async () => {};
    lp.renderProjectList = () => {};
    // The sandbox window is handed back so a test can install the
    // `CloudeWeb` namespace the tree's ended rows now call into. It is
    // deliberately NOT installed here: a test that forgets to stub it
    // should fail on a missing namespace rather than silently exercise
    // an empty one.
    return { lp, calls, errors, byId, window: context.window };
}

function recentRow(overrides = {}) {
    return {
        session_uuid: 'uuid-1',
        origin: 'created',
        owned: true,
        tmux_socket: 'cloude',
        tmux_name: 'cloude_media',
        tmux_created_epoch: 1700000000,
        lifecycle: 'stopped',
        project_attribution: 'none',
        working_dir: '/home/x/proj',
        agent_type: 'claude',
        agent_family: 'claude',
        agent_family_source: 'reserved_name',
        archived_at: null,
        title: 'Media Pipeline',
        ...overrides,
    };
}

function treeRow(overrides = {}) {
    return {
        name: 'cloude_media',
        session_uuid: 'uuid-tree-1',
        created_by_cloude: true,
        working_dir: '/home/x/proj',
        agent_type: 'claude',
        agent_family: 'claude',
        agent_family_source: 'reserved_name',
        title: 'Media Pipeline',
        ...overrides,
    };
}

// =====================================================================
// 1. CALL SITE ONE - the RECENT list. The button must carry BOTH the
//    session uuid and the title, not just the launch context.
// =====================================================================

// =====================================================================
// TRIMMED BY SVELTE SLICE 2, AND WHAT WENT WHERE.
//
// `Launchpad._restartPlan`, `_restartNotice`, `_restartRecentSession`,
// `_renderRecentSessionRowHtml` and `_bindRecentSessionClicks` no longer
// exist: the RECENT section moved into web/src/lib/launchpad/ and those
// methods were deleted in the same commit. Every case in this file that
// drove one of them was PORTED, not dropped:
//
//   the plan, the three-outcome notice and the failure path
//       -> web/src/lib/launchpad/recent-actions.test.ts
//   the row's identity, its restart payload and the lifecycle gate
//       -> web/src/lib/launchpad/recent.test.ts
//   the RECENT row's click wiring
//       -> the component's own onclick, proven in a real browser under
//          the production CSP; there is no delegated listener left to
//          assert against, because Svelte binds the handler to the row.
//
// WHAT SURVIVES HERE IS THE TREE, and only the tree. Its ended rows are
// still built by launchpad.js (slice 4), still carry `data-uuid` and
// `data-title` in their markup, and still route through a delegated
// listener - which now calls the ONE moved implementation by name rather
// than a second copy. That call is what these remaining cases still
// protect: a tree row that stopped carrying its title would start
// restarting sessions into unnamed blank consoles again, which is the
// defect this whole file was written for.
// =====================================================================

await test('TREE ended restart button carries data-uuid AND data-title', async () => {
    const { lp } = loadLaunchpad();
    const html = lp._renderEndedTreeSessionRowHtml(treeRow());
    assert.ok(html.includes('ended-session-restart'), 'no restart control rendered');
    assert.ok(html.includes('data-uuid="uuid-tree-1"'),
        `tree restart control must carry the session uuid, got: ${html}`);
    assert.ok(html.includes('data-title="Media Pipeline"'),
        `tree restart control must carry the title, got: ${html}`);
    assert.ok(html.includes('data-working-dir="/home/x/proj"'));
});

await test('TREE ended restart button escapes a title carrying markup', async () => {
    const { lp } = loadLaunchpad();
    const html = lp._renderEndedTreeSessionRowHtml(
        treeRow({ title: '"><script>x</script>' }));
    assert.ok(!html.includes('<script>'),
        `a title must never reach the markup unescaped, got: ${html}`);
});

// =====================================================================
// 3. THE WIRING. The attributes being IN the markup is half of it; this
//    is the other half - the listener must actually READ them and hand
//    them to the handler. That gap is literally where the original
//    defect lived: the uuid WAS in the dataset and simply never reached
//    the call.
//
//    THE HANDLER IT REACHES MOVED. Slice 2 deleted
//    `Launchpad._restartRecentSession` and the tree now calls
//    `window.CloudeWeb.launchpad.restartRecentSession` - the one
//    implementation, shared with the RECENT rows, rather than a second
//    copy of it. So the stub goes on that namespace. Stubbing the old
//    method name would now assert against a function nothing calls,
//    which is the quietest way for a test to stop testing.
// =====================================================================

/**
 * Build a button stub carrying the four restart attributes.
 * @param {object} attrs
 * @returns {object} element-like with getAttribute.
 */
function btnStub(attrs) {
    return {
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attrs, name)
                ? attrs[name] : null;
        },
    };
}

await test('the TREE delegated listener hands uuid AND title to the handler', async () => {
    const { lp, byId, window: win } = loadLaunchpad();
    let listener = null;
    byId['project-list'].addEventListener = (type, fn) => {
        if (type === 'click') listener = fn;
    };
    lp._bindProjectSessionRowClicks();
    assert.ok(listener, 'no click listener was bound on the project tree');

    const seen = [];
    win.CloudeWeb = {
        launchpad: { restartRecentSession: async (opts) => { seen.push(opts); } },
    };
    const row = {
        dataset: { ended: '1', name: 'cloude_media' },
        classList: { contains() { return false; } },
    };
    const btn = btnStub({
        'data-uuid': 'uuid-tree-1',
        'data-title': 'Media Pipeline',
        'data-working-dir': '/home/x/proj',
        'data-agent-type': 'claude',
    });
    await listener({
        stopPropagation() {},
        target: {
            closest(sel) {
                if (sel === '.project-session-row') return row;
                if (sel === '.ended-session-restart') return btn;
                return null;
            },
        },
    });
    assert.equal(seen.length, 1, 'the tree handler was not called');
    assert.equal(typeof seen[0], 'object',
        'the handler must receive an options object, not a bare working dir');
    assert.equal(seen[0].sessionUuid, 'uuid-tree-1');
    assert.equal(seen[0].title, 'Media Pipeline');
    assert.equal(seen[0].workingDir, '/home/x/proj');
    assert.equal(seen[0].agentType, 'claude');
});


console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
