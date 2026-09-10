// Node test for fetching one directory's children on expand.
//
// THE TWO CONTRACTS THIS PINS.
//
// 1. COMPATIBILITY IS ONE STRICT COMPARISON. `needsFetch` must test
//    `children_loaded === false`, never falsiness. A server that predates
//    the field omits it, so it arrives as `undefined`; if that counted as
//    "not loaded", every directory in a full tree the server already sent
//    would trigger a pointless request for children the client is holding,
//    and the panel would flicker through a loading row on every expansion.
//    Reading `undefined` as "loaded" is what lets a new client work against
//    an old server with no version check.
//
// 2. THREE OUTCOMES, NEVER TWO. Fetching on expand adds a failure mode the
//    eager tree did not have: the answer can fail to arrive AFTER the user
//    has clicked. If a failed request returned an empty list, an expansion
//    that reveals nothing would be indistinguishable from a directory that
//    is genuinely empty - "I could not find out" rendered as "there is
//    nothing here", which is this project's most repeated defect shape. So
//    the negative controls below are load-bearing: a `childrenFor` that
//    swallowed errors into `{nodes: []}` would pass every positive test
//    here and be exactly the bug.
//
// Run with: node tests/test_config_editor_lazy.node.mjs

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
 * @param {() => Promise<void>|void} fn  Body; throwing marks the test failed.
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
 * Load config-editor-lazy.js in a sandbox with a stub API and the REAL
 * config-editor-roots.js beside it, so the sentences under test are the ones
 * the app actually renders rather than copies written for the test.
 * @param {(root: string, projectPath: string|null, opts: object) => Promise<object>} fetchImpl
 *   Stands in for window.API.getConfigFileTree.
 * @returns {{lazy: object, calls: Array<object>}}
 */
function loadLazy(fetchImpl) {
    const calls = [];
    const fakeWindow = {};
    fakeWindow.window = fakeWindow;
    fakeWindow.API = {
        async getConfigFileTree(root, projectPath, opts) {
            calls.push({ root, projectPath, opts });
            return await fetchImpl(root, projectPath, opts);
        },
    };
    const context = { window: fakeWindow, console: { log() {}, warn() {} } };
    vm.createContext(context);
    for (const file of ['config-editor-roots.js', 'config-editor-lazy.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, '..', 'client', 'js', file), 'utf8'),
            context,
        );
    }
    return { lazy: fakeWindow.ConfigEditorLazy, calls };
}

const NEVER = () => {
    throw new Error('the fetch must not have been attempted');
};

await test('a directory the server did not look inside needs a fetch', () => {
    const { lazy } = loadLazy(NEVER);
    assert.equal(lazy.needsFetch({ is_dir: true, children_loaded: false }), true);
});

await test('COMPATIBILITY: an absent children_loaded is treated as loaded', () => {
    // An old server omits the field entirely. Reading that as "not loaded"
    // would refetch every directory of a tree the client already holds.
    const { lazy } = loadLazy(NEVER);
    assert.equal(lazy.needsFetch({ is_dir: true }), false);
    assert.equal(lazy.needsFetch({ is_dir: true, children_loaded: undefined }), false);
    assert.equal(lazy.needsFetch({ is_dir: true, children_loaded: true }), false);
});

await test('a file never needs a fetch, whatever the flag says', () => {
    const { lazy } = loadLazy(NEVER);
    assert.equal(lazy.needsFetch({ is_dir: false, children_loaded: false }), false);
});

await test('children already in hand are returned without a request', async () => {
    const { lazy, calls } = loadLazy(NEVER);
    const node = { is_dir: true, rel_path: 'src', children_loaded: true, children: [{ name: 'a' }] };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'have');
    assert.equal(verdict.nodes.length, 1);
    assert.equal(calls.length, 0, 'nothing should have been requested');
});

await test('an unloaded directory is fetched at depth 1, by its own rel_path', async () => {
    const { lazy, calls } = loadLazy(async () => ({ tree: [{ name: 'app.py' }] }));
    const node = { is_dir: true, rel_path: 'src', children_loaded: false, children: [] };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'loaded');
    assert.deepEqual(verdict.nodes.map((n) => n.name), ['app.py']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].root, 'workdir');
    assert.equal(calls[0].projectPath, '/p');
    assert.equal(calls[0].opts.path, 'src');
    assert.equal(calls[0].opts.depth, 1,
        'asking for more than one level prefetches what nobody opened');
});

await test('a fetched directory with no entries is a MEASURED empty one', async () => {
    const { lazy } = loadLazy(async () => ({ tree: [] }));
    const node = { is_dir: true, rel_path: 'empty', children_loaded: false, children: [] };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'loaded');
    assert.deepEqual(verdict.nodes, []);
});

await test('NEGATIVE CONTROL: a failed request is not an empty directory', async () => {
    // The load-bearing one. A childrenFor that caught the error and returned
    // {status:'loaded', nodes: []} passes every test above this line.
    const err = new Error("'locked' could not be read: Permission denied");
    err.status = 503;
    const { lazy } = loadLazy(async () => { throw err; });
    const node = { is_dir: true, rel_path: 'locked', children_loaded: false, children: [] };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'failed',
        'a request that did not answer must never report as a successful empty read');
    assert.equal(verdict.nodes, undefined, 'there are no nodes to render');
    assert.ok(verdict.message.includes('Permission denied'),
        'the server\'s own reason must reach the user');
    assert.ok(!/empty/i.test(verdict.message));
});

await test('NEGATIVE CONTROL: a network failure with no status still says so', async () => {
    const { lazy } = loadLazy(async () => { throw new Error('Failed to fetch'); });
    const node = { is_dir: true, rel_path: 'src', children_loaded: false, children: [] };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'failed');
    assert.ok(verdict.message.length > 0);
});

await test('a server-reported list_error is rendered without asking again', async () => {
    const { lazy, calls } = loadLazy(NEVER);
    const node = {
        is_dir: true, rel_path: 'locked', children_loaded: false,
        children: [], list_error: 'Permission denied',
    };
    const verdict = await lazy.childrenFor('workdir', node, '/p');
    assert.equal(verdict.status, 'list_error');
    assert.ok(verdict.message.includes('Permission denied'));
    assert.equal(calls.length, 0,
        'the server already measured this one; asking again just fails differently');
});

await test('the three failure-ish outcomes render three different sentences', () => {
    // If any two of these collapse, a user cannot tell what happened.
    const { lazy } = loadLazy(NEVER);
    void lazy;
    const fakeWindow = {};
    fakeWindow.window = fakeWindow;
    const ctx = { window: fakeWindow, console: { log() {} } };
    vm.createContext(ctx);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'client', 'js', 'config-editor-roots.js'), 'utf8'),
        ctx,
    );
    const Roots = fakeWindow.ConfigEditorRoots;
    const sentences = new Set([
        Roots.listErrorNotice('Permission denied'),
        Roots.expandFailedNotice('Permission denied'),
        Roots.workdirUnavailableNotice('project files', '/p'),
    ]);
    assert.equal(sentences.size, 3, 'each outcome needs its own wording');
});

await test('the panel wires the expansion through this module, not its own fetch', () => {
    const panel = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'config-editor-panel.js'),
        'utf8',
    );
    assert.ok(panel.includes('window.ConfigEditorLazy.childrenFor'),
        'the panel must expand through the tested module');
    assert.ok(panel.includes('ConfigEditorLazy.FETCH_DEPTH'),
        'the root listing must be shallow too, or the server still walks everything');
    assert.ok(/verdict\.status === 'failed'/.test(panel),
        'the panel must render the could-not-load outcome rather than dropping it');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
