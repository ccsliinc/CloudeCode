// Node test for the file editor's root plan: which roots get listed, and
// what the user is told when one is not.
//
// THE BUG THIS EXISTS TO CATCH. The panel used to skip the "project" and
// "workdir" roots with a bare `continue` whenever the working directory
// did not resolve. The tree then rendered ~/.claude alone, with no
// message, and the user read it as "the file editor is no longer showing
// my project files" - which is what was reported. A short tree that says
// nothing is indistinguishable from a complete one.
//
// So there are two independent contracts here, and both must hold:
//   1. a resolved working directory yields ALL THREE roots and no notice;
//   2. an unresolved one yields the user root PLUS a notice that names
//      what is missing and why - never a silently short plan.
// Deleting the notice from planRoots(), or restoring the `continue` by
// dropping the project roots without one, fails a test below.
//
// The unwrap is covered too: the session object is a SessionInfo WRAPPER
// on the rejoin/deep-link paths and a bare Session on create/adopt, and
// working_dir lives at `.session.working_dir` in the first case. Reading
// it unwrapped is the recurring bug class in this codebase (the PID
// display was fixed four times for it), so both shapes are asserted.
//
// Run with: node tests/test_config_editor_roots.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name  Test description.
 * @param {() => void} fn  Body; throwing marks the test failed.
 * @returns {void}
 */
function test(name, fn) {
    try {
        fn();
        passes++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`NOT OK - ${name}`);
        console.error(err && err.stack ? err.stack : err);
    }
}

/**
 * Load config-editor-roots.js in a bare sandbox. The module is pure
 * string/object work with no DOM dependency, which is the reason it was
 * extracted out of the panel in the first place.
 * @returns {object}  window.ConfigEditorRoots.
 */
function loadRoots() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'config-editor-roots.js'),
        'utf8',
    );
    const fakeWindow = {};
    fakeWindow.window = fakeWindow;
    const context = { window: fakeWindow, console: { log() {} } };
    vm.createContext(context);
    vm.runInContext(src, context);
    return fakeWindow.ConfigEditorRoots;
}

const Roots = loadRoots();

/**
 * Ids of the roots a plan actually lists.
 * @param {Array<object>} plan  planRoots() output.
 * @returns {string[]}  Root ids in plan order.
 */
function rootIds(plan) {
    return plain(plan).filter((s) => s.kind === 'root').map((s) => s.def.id);
}

/**
 * Notice messages a plan carries.
 * @param {Array<object>} plan  planRoots() output.
 * @returns {string[]}  Messages in plan order.
 */
function notices(plan) {
    return plain(plan).filter((s) => s.kind === 'notice').map((s) => s.message);
}

/**
 * Strip the vm realm off a value so assert's prototype-sensitive deep
 * comparison can be used: objects built inside vm.runInContext have a
 * different Object.prototype and are never "reference-equal" to a literal
 * declared out here, however identical their contents.
 * @param {any} value  Any JSON-serializable value from the sandbox.
 * @returns {any}  The same value, rebuilt in this realm.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

const WORKDIR = '/Users/someone/Development/project';

test('the three roots are declared in order, workdir collapsed by default', () => {
    assert.deepEqual(plain(Roots.ROOTS.map((r) => r.id)), ['user', 'project', 'workdir']);
    const workdir = Roots.ROOTS.find((r) => r.id === 'workdir');
    assert.equal(workdir.label, 'project files');
    assert.equal(workdir.defaultExpanded, false);
});

test('a SessionInfo WRAPPER resolves working_dir from .session', () => {
    const tc = { _currentSession: { session: { id: 'ses_1', working_dir: WORKDIR }, tmux_session: 'x' } };
    assert.deepEqual(plain(Roots.resolveProjectContext(tc)), { path: WORKDIR, reason: 'ok' });
});

test('a BARE Session resolves working_dir from the top level', () => {
    const tc = { _currentSession: { id: 'ses_1', working_dir: WORKDIR } };
    assert.deepEqual(plain(Roots.resolveProjectContext(tc)), { path: WORKDIR, reason: 'ok' });
});

test('no attached session reports reason no-session, not a bare null', () => {
    assert.deepEqual(plain(Roots.resolveProjectContext({ _currentSession: null })), { path: null, reason: 'no-session' });
    assert.deepEqual(plain(Roots.resolveProjectContext(null)), { path: null, reason: 'no-session' });
});

test('an attached session with no working_dir is its OWN reason', () => {
    const tc = { _currentSession: { session: { id: 'ses_1' } } };
    assert.deepEqual(plain(Roots.resolveProjectContext(tc)), { path: null, reason: 'no-working-dir' });
});

test('REGRESSION: a resolved working dir plans all three roots, no notice', () => {
    const plan = Roots.planRoots({ path: WORKDIR, reason: 'ok' });
    assert.deepEqual(rootIds(plan), ['user', 'project', 'workdir'],
        'project and workdir must be planned whenever the working directory resolved');
    assert.deepEqual(notices(plan), [], 'nothing to explain when every root is listed');
});

test('REGRESSION: dropping the project roots is never silent (no session)', () => {
    const plan = Roots.planRoots({ path: null, reason: 'no-session' });
    assert.deepEqual(rootIds(plan), ['user']);
    const msgs = notices(plan);
    assert.equal(msgs.length, 1, 'a short plan MUST carry exactly one explanation');
    assert.match(msgs[0], /no session attached/);
    assert.match(msgs[0], /project files/, 'the message must name what is missing');
});

test('REGRESSION: an unresolvable working dir is never silent either', () => {
    const plan = Roots.planRoots({ path: null, reason: 'no-working-dir' });
    assert.deepEqual(rootIds(plan), ['user']);
    const msgs = notices(plan);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /no working directory/);
    assert.match(msgs[0], /project \.claude and project files/);
});

test('every short plan carries a notice, for every non-ok reason', () => {
    for (const reason of ['no-session', 'no-working-dir']) {
        const plan = Roots.planRoots({ path: null, reason });
        assert.equal(notices(plan).length, 1, `reason ${reason} planned no explanation`);
    }
});

test('a missing root notice names the root and the directory', () => {
    const absent = Roots.missingRootNotice('project .claude', 'unavailable', WORKDIR);
    assert.match(absent, /project \.claude/);
    assert.match(absent, /not present/);
    assert.ok(absent.includes(WORKDIR), 'the notice must say WHERE it looked');
    const empty = Roots.missingRootNotice('project files', 'empty', WORKDIR);
    assert.match(empty, /nothing to list/);
});

test('copy stays in the lowercase UI voice, with no dashes or emoji', () => {
    const strings = [
        Roots.projectRootsNotice('no-session'),
        Roots.projectRootsNotice('no-working-dir'),
        Roots.missingRootNotice('project files', 'unavailable', WORKDIR),
        Roots.missingRootNotice('project files', 'empty', WORKDIR),
    ];
    for (const s of strings) {
        assert.ok(s, 'every non-ok state needs a sentence');
        assert.ok(!/[–—]/.test(s), `no en/em dashes: ${s}`);
        assert.ok(!/[A-Z]/.test(s.replace(WORKDIR, '')), `lowercase copy: ${s}`);
    }
    assert.equal(Roots.projectRootsNotice('ok'), null, 'ok has nothing to say');
});

test('the panel reads its root table and plan from this module', () => {
    const panel = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'config-editor-panel.js'),
        'utf8',
    );
    assert.ok(panel.includes('window.ConfigEditorRoots.ROOTS'),
        'the panel must not keep a second copy of the root table');
    assert.ok(panel.includes('window.ConfigEditorRoots.planRoots'),
        'the panel must render the plan, not re-derive which roots to skip');
    assert.ok(!/continue; \/\/ no session attached/.test(panel),
        'the silent continue that dropped both project roots must stay gone');
});

test('index.html loads the roots module before the panel', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
    const roots = html.indexOf('<script src="/static/js/config-editor-roots.js">');
    const panel = html.indexOf('<script src="/static/js/config-editor-panel.js">');
    assert.ok(roots !== -1, 'config-editor-roots.js must be served');
    assert.ok(roots < panel, 'the panel reads ConfigEditorRoots.ROOTS at definition time');
});

test('REGRESSION: roots.js and panel.js share a global scope without colliding', () => {
    // These ship as classic <script> tags, so both files' top-level
    // bindings land in ONE global scope. Both legitimately want the name
    // CONFIG_EDITOR_ROOTS, and a duplicate top-level `const` is an
    // uncaught SyntaxError that kills the SECOND file at parse time -
    // window.ConfigEditorPanel never gets defined and the file editor
    // button does nothing at all. Loading them back to back in one
    // context is the only check that reproduces it; reading either file
    // alone cannot. roots.js keeps its bindings inside a closure.
    const read = (name) => fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', name), 'utf8',
    );
    const fakeWindow = {};
    fakeWindow.window = fakeWindow;
    const context = {
        window: fakeWindow,
        console: { log() {} },
        document: { createElement: () => ({ style: {} }) },
    };
    vm.createContext(context);
    vm.runInContext(read('config-editor-roots.js'), context);
    vm.runInContext(read('config-editor-panel.js'), context);
    assert.ok(fakeWindow.ConfigEditorPanel,
        'the panel must still define window.ConfigEditorPanel after roots.js loaded');
    assert.deepEqual(
        plain(fakeWindow.ConfigEditorRoots.ROOTS.map((r) => r.id)),
        ['user', 'project', 'workdir'],
    );
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
