// Node test for client/js/terminal-search-deep-dive.js - widening the
// terminal's search query to every archived conversation in the same
// project folder.
//
// WHAT IS BEING GUARDED. Three of these rules are only visible as an
// absence, which is exactly the kind that rots quietly:
//
//   - The button must not appear when the archive is switched OFF, and
//     must not appear when nothing MEASURED whether it is on. Offering it
//     on an `unknown` sends the user to a screen whose every request
//     404s, which is the false-green failure this project keeps paying
//     for, so `unknown` is treated as a no here even though
//     ArchiveEntry.open() deliberately treats it as a yes.
//   - Navigation is `syncUrl` plus `App.showArchive`, NEVER
//     `location.href`. A real navigation in this single-page app tears
//     down the terminal, its WebSocket and every open session to reach a
//     screen the router could have shown in place, so the test asserts
//     the router path was used and the address bar was pushed.
//   - The cwd lookup is cached, INCLUDING its null answer. Without that,
//     a panel that re-derives the link as the user types costs one server
//     request per keystroke for a fact that cannot change.
//
// The archive deep-link builder is the REAL module, not a stub: the whole
// value of this file is the path it produces, and a stub would only prove
// that the test author can concatenate strings.
//
// Run with: node tests/test_terminal_search_deep_dive.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', 'client', 'js');

let failures = 0;
let passes = 0;

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

const CWD = '/Users/a/Development/thing';
const SESSION = { working_dir: CWD };

/**
 * Description: one realm holding the real ArchiveDeeplink plus the deep
 *   dive module, with stubbed archive state, lookup and router.
 * Inputs: opts (object):
 *   archiveState (string) - what ArchiveEntry.ensure() resolves to.
 *   projectId (number|null) - what the lookup route answers with, null
 *     meaning "no project covers this folder".
 *   resultShape (string) - 'object' (default), 'bare' or 'missing', so
 *     the reader is driven against every shape the envelope can carry.
 *   noLookupFn (boolean) - the API method is absent from this build.
 *   transportError (string) - the route could not be reached.
 * Output: object - {w, lookups, shown, pushed}.
 */
function loadModules(opts = {}) {
    const lookups = [];
    const shown = [];
    const pushed = [];
    const context = {
        console: { log() {}, warn() {}, error() {}, debug() {} },
        Promise, Number, Math, Object, Array, String, JSON, Map,
        setTimeout, clearTimeout,
        location: { pathname: '/session/cloude_thing', search: '' },
        history: {
            pushState(state, title, url) { pushed.push(url); },
            replaceState(state, title, url) { pushed.push(url); },
        },
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    for (const f of ['archive-deeplink.js', 'terminal-search-deep-dive.js']) {
        vm.runInContext(fs.readFileSync(path.join(CLIENT_JS, f), 'utf8'),
            context, { filename: f });
    }
    context.ArchiveEntry = {
        STATE_ENABLED: 'enabled',
        STATE_DISABLED: 'disabled',
        STATE_UNKNOWN: 'unknown',
        async ensure() {
            return opts.archiveState === undefined ? 'enabled' : opts.archiveState;
        },
    };
    if (!opts.noLookupFn) {
        context.API = {
            async getArchiveProjectForCwd(cwd) {
                lookups.push(cwd);
                if (opts.transportError) {
                    return { envelope: null, transportError: opts.transportError };
                }
                const id = opts.projectId === undefined ? 12 : opts.projectId;
                let result;
                if (id === null) result = null;
                else if (opts.resultShape === 'bare') result = id;
                else if (opts.resultShape === 'missing') result = {};
                else result = { project_id: id, matched_by: 'realpath' };
                return { envelope: { result, result_status: 'ok' }, transportError: null };
            },
        };
    } else {
        context.API = {};
    }
    context.App = { showArchive(route) { shown.push(route); } };
    return { w: context, lookups, shown, pushed };
}

await test('a resolved project builds /archive/p/<id>?q=<term>', async () => {
    const { w } = loadModules({ projectId: 12 });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), '/archive/p/12?q=hazard');
});

await test('the working_dir is read from either level of the session shape', async () => {
    const { w } = loadModules({ projectId: 12 });
    const wrapped = { session: { working_dir: CWD }, activity_status: 'idle' };
    assert.equal(await w.DeepDive.hrefFor(wrapped, 'hazard'), '/archive/p/12?q=hazard');
});

await test('the query is url-encoded and trimmed', async () => {
    const { w } = loadModules({ projectId: 7 });
    assert.equal(await w.DeepDive.hrefFor(SESSION, '  a b&c  '),
        '/archive/p/7?q=a%20b%26c');
});

await test('the id is read from result.project_id, the shape the route documents', async () => {
    const obj = loadModules({ projectId: 5, resultShape: 'object' });
    assert.equal(await obj.w.DeepDive.hrefFor(SESSION, 'hazard'), '/archive/p/5?q=hazard');
    // A bare number is NOT the contract. It reads as no project rather
    // than as a plausible id, so a route that changed shape fails loudly
    // here instead of silently linking somewhere else.
    const bare = loadModules({ projectId: 5, resultShape: 'bare' });
    assert.equal(await bare.w.DeepDive.hrefFor(SESSION, 'hazard'), null);
});

await test('NEGATIVE CONTROL: a switched-off archive offers nothing', async () => {
    const { w, lookups } = loadModules({ archiveState: 'disabled' });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
    assert.equal(lookups.length, 0, 'and it must not ask the server either');
});

await test('NEGATIVE CONTROL: an UNKNOWN archive offers nothing', async () => {
    // Nothing measured whether the archive is on. Offering the button
    // would lead to a screen of 404s.
    const { w, lookups } = loadModules({ archiveState: 'unknown' });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
    assert.equal(lookups.length, 0);
});

await test('NEGATIVE CONTROL: a session with no working directory offers nothing', async () => {
    const { w, lookups } = loadModules({});
    assert.equal(await w.DeepDive.hrefFor({}, 'hazard'), null);
    assert.equal(await w.DeepDive.hrefFor(null, 'hazard'), null);
    assert.equal(lookups.length, 0);
});

await test('NEGATIVE CONTROL: a query under the archive floor offers nothing', async () => {
    const { w, lookups } = loadModules({});
    assert.equal(w.DeepDive.MIN_QUERY_CHARS, 2);
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'a'), null);
    assert.equal(await w.DeepDive.hrefFor(SESSION, ' '), null);
    assert.equal(await w.DeepDive.hrefFor(SESSION, ''), null);
    assert.equal(lookups.length, 0, 'a refused query must cost no request');
});

await test('NEGATIVE CONTROL: a folder with no archived project offers nothing', async () => {
    const { w } = loadModules({ projectId: null });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
});

await test('NEGATIVE CONTROL: an unreachable lookup offers nothing', async () => {
    const { w } = loadModules({ transportError: 'network down' });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
});

await test('NEGATIVE CONTROL: a build without the lookup route offers nothing', async () => {
    const { w } = loadModules({ noLookupFn: true });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
});

await test('a result naming no id is a null, not a NaN project', async () => {
    const { w } = loadModules({ projectId: 12, resultShape: 'missing' });
    assert.equal(await w.DeepDive.hrefFor(SESSION, 'hazard'), null);
});

await test('one cwd costs ONE lookup however many times it is asked', async () => {
    const { w, lookups } = loadModules({ projectId: 12 });
    await w.DeepDive.hrefFor(SESSION, 'ha');
    await w.DeepDive.hrefFor(SESSION, 'haz');
    await w.DeepDive.hrefFor(SESSION, 'hazard');
    assert.equal(lookups.length, 1, 'the panel re-derives the link per keystroke');
    assert.deepEqual([...lookups], [CWD]);
});

await test('a NULL answer is cached too, so a folderless project is asked about once', async () => {
    const { w, lookups } = loadModules({ projectId: null });
    await w.DeepDive.hrefFor(SESSION, 'hazard');
    await w.DeepDive.hrefFor(SESSION, 'hazardous');
    assert.equal(lookups.length, 1);
});

await test('reset() drops the cache', async () => {
    const { w, lookups } = loadModules({ projectId: 12 });
    await w.DeepDive.hrefFor(SESSION, 'hazard');
    w.DeepDive.reset();
    await w.DeepDive.hrefFor(SESSION, 'hazard');
    assert.equal(lookups.length, 2);
});

await test('open() pushes the path and shows the archive through the ROUTER', async () => {
    const { w, shown, pushed } = loadModules({ projectId: 12 });
    assert.equal(await w.DeepDive.open(SESSION, 'hazard'), true);
    assert.deepEqual([...pushed], ['/archive/p/12?q=hazard'],
        'the address bar must follow, through the History API');
    assert.equal(shown.length, 1, 'and the screen must change in place');
    assert.equal(shown[0].view, 'project');
    assert.equal(shown[0].projectId, 12);
    assert.equal(typeof shown[0].projectId, 'number',
        'ArchiveScreen scopes on a NUMBER; a string id silently matches nothing');
    assert.equal(shown[0].query.q, 'hazard');
});

await test('open() refuses without navigating when there is nowhere to go', async () => {
    const { w, shown, pushed } = loadModules({ projectId: null });
    assert.equal(await w.DeepDive.open(SESSION, 'hazard'), false);
    assert.equal(shown.length, 0);
    assert.equal(pushed.length, 0);
});

await test('open() reports false rather than throwing when the screen is missing', async () => {
    const { w, shown } = loadModules({ projectId: 12 });
    delete w.App;
    assert.equal(await w.DeepDive.open(SESSION, 'hazard'), false);
    assert.equal(shown.length, 0);
});

await test('the module performs no real navigation', () => {
    // The behavioural test above proves the router path is TAKEN; this
    // one proves the other path is absent, because a fallback added
    // later would be reached only on the day the router is missing and
    // would tear down every open session at exactly the wrong moment.
    // The pattern is an ASSIGNMENT, not the words: the header explains
    // why `location.href` is refused and must be allowed to say so.
    const src = fs.readFileSync(
        path.join(CLIENT_JS, 'terminal-search-deep-dive.js'), 'utf8');
    for (const bad of [/location\.href\s*=/, /location\.assign\s*\(/,
        /location\.replace\s*\(/, /window\.location\s*=/]) {
        assert.equal(bad.test(src), false,
            `${bad} would be a real navigation out of the app`);
    }
});

await test('the module stays under the 500-line guideline', () => {
    const lines = fs.readFileSync(
        path.join(CLIENT_JS, 'terminal-search-deep-dive.js'), 'utf8').split('\n').length;
    assert.ok(lines < 500,
        `terminal-search-deep-dive.js is ${lines} lines, over the 500 limit`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
