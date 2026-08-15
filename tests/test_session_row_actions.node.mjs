// Node-based test for the shared session-row control
// (client/js/session-row-actions.js + the closeIconSvg glyph it pulls from
// client/js/session-status-ui.js).
//
// WHY THIS FILE EXISTS: the repo has no package.json / jest / mocha, so the
// established pattern for testing client JS is a `vm`-sandboxed node script
// (see tests/test_deeplink_resolver.node.mjs, which this follows). The
// behavior under test is entirely client-side: which control a row gets for
// a given status, that the two controls never both appear, that both carry
// a hover tooltip (the bug that started this: the launcher's X had an
// aria-label and NO title), and that the confirm copy does not overstate
// what the action destroys.
//
// Run with: node tests/test_session_row_actions.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read one client JS module's source. */
function readClientJs(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'client', 'js', name), 'utf8');
}

let failures = 0;
let passes = 0;
const queue = [];

/**
 * Queue one named assertion block. Bodies may be sync or async and are run
 * STRICTLY IN ORDER by runQueue() below, so tests that inspect the shared
 * confirm-modal call log cannot interleave and read each other's entries.
 * Failures are recorded, not thrown, so one does not hide the rest.
 * Inputs: name (string), fn (function|async function) - throws on failure.
 * Output: void.
 */
function test(name, fn) {
    queue.push([name, fn]);
}

/**
 * Run every queued test in order.
 * Inputs: none.
 * Output: Promise<void>.
 */
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
 * Load session-status-ui.js and session-row-actions.js into a sandbox with
 * a document stub good enough for the modules' HTML escaping (they build a
 * detached div and read innerHTML back).
 *
 * Inputs: none.
 * Output: object - {SessionRowActions, SessionStatusUI, confirmCalls}.
 *   confirmCalls records every App.showConfirmModal() invocation as
 *   [title, message, details, primaryLabel, secondaryLabel].
 */
function makeSandbox() {
    const confirmCalls = [];

    /** Minimal stand-in for a detached element used only for escaping. */
    function makeEscapingDiv() {
        let text = '';
        return {
            set textContent(v) { text = v == null ? '' : String(v); },
            get textContent() { return text; },
            get innerHTML() {
                return text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
            },
        };
    }

    const fakeDocument = {
        createElement() { return makeEscapingDiv(); },
        getElementById() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
    };

    const fakeWindow = {
        App: {
            showConfirmModal(title, message, details, primaryLabel, secondaryLabel) {
                confirmCalls.push([title, message, details, primaryLabel, secondaryLabel]);
                return Promise.resolve(true);
            },
        },
    };
    fakeWindow.window = fakeWindow;

    const context = { window: fakeWindow, document: fakeDocument, console };
    vm.createContext(context);
    vm.runInContext(readClientJs('session-status-ui.js'), context);
    vm.runInContext(readClientJs('session-row-actions.js'), context);

    return {
        SessionRowActions: fakeWindow.SessionRowActions,
        SessionStatusUI: fakeWindow.SessionStatusUI,
        confirmCalls,
    };
}

const { SessionRowActions, SessionStatusUI, confirmCalls } = makeSandbox();

// Every status the app can paint, split by the promise its control makes.
const RUNNING_STATUSES = [
    'question', 'working_subagent', 'working', 'finished_unread', 'idle',
    'running', 'unknown', undefined, null, 'nonsense',
];
const STOPPED_STATUSES = ['dead'];

test('running statuses get the close action, stopped get remove', () => {
    for (const status of RUNNING_STATUSES) {
        assert.equal(
            SessionRowActions.actionFor(status),
            SessionRowActions.ACTION_CLOSE,
            `expected close for status ${String(status)}`
        );
    }
    for (const status of STOPPED_STATUSES) {
        assert.equal(SessionRowActions.actionFor(status), SessionRowActions.ACTION_REMOVE);
    }
});

test('unknown is never treated as stopped', () => {
    // Guessing "stopped" on an undetermined status would offer a control
    // that forgets a live session's entry.
    assert.equal(SessionRowActions.actionFor('unknown'), SessionRowActions.ACTION_CLOSE);
});

test('a row renders exactly one control, never both glyphs', () => {
    const running = SessionRowActions.html('working', 'cloude_api', 'running-session-kill');
    const stopped = SessionRowActions.html('dead', 'cloude_api', 'running-session-kill');
    for (const markup of [running, stopped]) {
        assert.equal((markup.match(/<button/g) || []).length, 1);
    }
    // The X is two crossing strokes; the trash can has a lid line and a
    // tapering body. Neither markup may contain the other's paths.
    const closeGlyph = SessionStatusUI.closeIconSvg();
    const trashGlyph = SessionStatusUI.trashIconSvg();
    assert.ok(running.includes(closeGlyph), 'running row must draw the X');
    assert.ok(!running.includes(trashGlyph), 'running row must not draw the trash');
    assert.ok(stopped.includes(trashGlyph), 'stopped row must draw the trash');
    assert.ok(!stopped.includes(closeGlyph), 'stopped row must not draw the X');
});

test('the control always has BOTH a title and an aria-label (the original bug)', () => {
    for (const status of ['working', 'dead']) {
        const markup = SessionRowActions.html(status, 'cloude_api', 'running-session-kill');
        const title = /title="([^"]*)"/.exec(markup);
        const aria = /aria-label="([^"]*)"/.exec(markup);
        assert.ok(title && title[1], `missing title for status ${status}`);
        assert.ok(aria && aria[1], `missing aria-label for status ${status}`);
        assert.equal(title[1], aria[1], 'tooltip and accessible name must not drift');
    }
});

test('both surfaces get identical wording for the same action', () => {
    const launcher = SessionRowActions.html('working', 'cloude_api', 'running-session-kill');
    const sidebar = SessionRowActions.html('working', 'cloude_api', 'session-sidebar-row-delete');
    const wording = (m) => /title="([^"]*)"/.exec(m)[1];
    assert.equal(wording(launcher), wording(sidebar));
    // ...and only the surface class differs.
    assert.ok(launcher.includes(SessionRowActions.BASE_CLASS));
    assert.ok(sidebar.includes(SessionRowActions.BASE_CLASS));
});

test('the session name is escaped into the data attribute', () => {
    const markup = SessionRowActions.html('working', 'evil" onclick="x', 'running-session-kill');
    // The payload only becomes an attribute if its quotes survive raw.
    assert.ok(!markup.includes('onclick="'), 'attribute injection must not survive escaping');
    assert.ok(markup.includes('evil&quot; onclick=&quot;x'), 'quotes must be entity-escaped');
    assert.ok(!/<script/i.test(SessionRowActions.html('working', '<script>x</script>', 'c')));
});

test('the control is a real button, so it is keyboard operable', () => {
    const markup = SessionRowActions.html('working', 'cloude_api', 'running-session-kill');
    assert.ok(markup.startsWith('<button type="button"'));
    assert.ok(!markup.includes('role="button"'), 'a span pretending to be a button needs key handlers');
});

test('close copy is accurate: terminates the process, keeps the transcript', async () => {
    confirmCalls.length = 0;
    const ok = await SessionRowActions.confirm(SessionRowActions.ACTION_CLOSE, 'api-work');
    assert.equal(ok, true);
    assert.equal(confirmCalls.length, 1, 'must route through the ONE shared confirm modal');
    const [title, message, details] = confirmCalls[0];
    assert.ok(message.includes('api-work'), 'the confirm must name the specific session');
    assert.ok(/close/.test(title));
    assert.ok(/terminated/.test(details), 'closing does stop the process, say so');
    assert.ok(/~\/\.claude\/projects/.test(details), 'and say the transcript survives');
    assert.ok(!/cannot be undone/.test(details), 'overstated warnings train people to ignore warnings');
});

test('remove copy is accurate: nothing on disk is touched', async () => {
    confirmCalls.length = 0;
    await SessionRowActions.confirm(SessionRowActions.ACTION_REMOVE, 'old-thing');
    const [, message, details] = confirmCalls[0];
    assert.ok(message.includes('old-thing'), 'the confirm must name the specific session');
    assert.ok(/nothing on disk is touched/.test(details));
    assert.ok(/nothing is terminated/.test(details), 'a stopped session has no process to kill');
});

test('the close glyph matches the shared icon family', () => {
    const svg = SessionStatusUI.closeIconSvg();
    assert.ok(svg.includes('viewBox="0 0 16 16"'));
    assert.ok(svg.includes('fill="none"'));
    assert.ok(svg.includes('stroke="currentColor"'));
    assert.ok(svg.includes('stroke-width="1.5"'));
});

// ---------------------------------------------------------------------
// Call-site checks. The module being right is not the same as the rows
// the user actually sees being right, so these drive the REAL render
// functions in launchpad.js and session-sidebar.js and read back the
// markup they hand to the DOM.
// ---------------------------------------------------------------------

/**
 * Load one client module into a sandbox that captures whatever it writes
 * into a named container's innerHTML.
 *
 * Inputs:
 *   moduleFile (string) - file name under client/js.
 *   containerId (string) - the element id the module paints into.
 * Output:
 *   object - {win, container} where container.innerHTML holds the paint.
 */
function makeRenderSandbox(moduleFile, containerId) {
    const container = {
        innerHTML: '',
        style: {},
        addEventListener() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
        classList: { add() {}, remove() {} },
        setAttribute() {},
    };

    const escaping = () => {
        let text = '';
        return {
            set textContent(v) { text = v == null ? '' : String(v); },
            get textContent() { return text; },
            get innerHTML() {
                return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            },
        };
    };

    const fakeDocument = {
        getElementById(id) { return id === containerId ? container : null; },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        createElement() { return escaping(); },
        addEventListener() {},
        body: { appendChild() {} },
    };

    const win = { API: {}, App: { showConfirmModal: () => Promise.resolve(false) } };
    win.window = win;
    const context = {
        window: win,
        document: fakeDocument,
        console,
        localStorage: { getItem() { return null; }, setItem() {} },
        setInterval() { return 0; },
        clearInterval() {},
        setTimeout() { return 0; },
    };
    vm.createContext(context);
    vm.runInContext(readClientJs('session-status-ui.js'), context);
    vm.runInContext(readClientJs('session-row-actions.js'), context);
    vm.runInContext(readClientJs(moduleFile), context, { filename: moduleFile });
    return { win, container };
}

test('launchpad running-session rows paint the right control per state', () => {
    const { win, container } = makeRenderSandbox('launchpad.js', 'running-sessions-list');
    win.Launchpad.runningSessions = [
        { name: 'cloude_alive', created_by_cloude: true, is_active: true, session_id: 's1', status: 'working' },
        { name: 'cloude_gone', created_by_cloude: true, is_active: false, session_id: null, status: 'dead' },
    ];
    win.Launchpad.renderRunningSessions();
    const html = container.innerHTML;
    // The bug that started this: the X had an aria-label and no title.
    assert.ok(!/aria-label="[^"]*"(?![^>]*title=)[^>]*data-session-action/.test(html));
    assert.equal((html.match(/data-session-action="close"/g) || []).length, 1);
    assert.equal((html.match(/data-session-action="remove"/g) || []).length, 1);
    assert.ok(html.includes('title="close session"'));
    assert.ok(html.includes('title="remove from the list"'));
});

test('sidebar rows paint the same control with the same wording', () => {
    const { win, container } = makeRenderSandbox('session-sidebar.js', 'session-sidebar-list');
    win.SessionSidebar.listEl = container;
    win.SessionSidebar.render([
        { name: 'cloude_alive', created_by_cloude: true, status: 'idle', is_active: true },
        { name: 'cloude_gone', created_by_cloude: true, status: 'dead', is_active: false },
    ]);
    const html = container.innerHTML;
    assert.ok(html.includes('title="close session"'), 'same tooltip wording as the launcher');
    assert.ok(html.includes('title="remove from the list"'));
    assert.equal((html.match(/data-session-action=/g) || []).length, 2, 'one control per row, never two');
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
