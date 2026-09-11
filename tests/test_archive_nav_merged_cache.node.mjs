// THE MERGED PROJECT LIST'S NORMALIZE CACHE.
//
// ArchiveNavMerged.paint() runs on every fuzzy-filter keystroke, but two
// of its three steps - filterByHost() and ArchiveNavOrder.sortNodes() -
// do not depend on the filter TEXT at all, only on the node list, the
// machine filter and the sort mode. Recomputing both on every keystroke
// was pure waste on a list this app holds up to ~80 rows of. This file
// proves the cache added for that: a keystroke-only repaint must not
// re-run either step, and a change to any of the three real inputs
// (nodes, hostId, orderMode) must still recompute correctly.
//
// THE INVALIDATION CASES ARE THE POINT. A cache-hit test alone would
// pass on a cache that never invalidates. Every "must recompute" case
// below was confirmed to fail when the corresponding comparison in
// normalizedProjects() is loosened - see the report for the exact
// mutation tried and reverted.
//
// Run with: node tests/test_archive_nav_merged_cache.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createEnvironment } from './mini-dom.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion block, recording pass/fail rather than throwing.
 * @param {string} name @param {() => (void|Promise<void>)} fn
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
 * Load the rail modules into one vm context and wrap
 * ArchiveNavOrder.sortNodes to count real (uncached) invocations.
 * @returns {{merged: object, sortCalls(): number, document: object}}
 */
function load() {
    const env = createEnvironment();
    const fakeWindow = { document: env.document };
    const context = {
        window: fakeWindow,
        document: env.document,
        console: { log() {}, warn() {}, error() {}, debug() {} },
    };
    vm.createContext(context);
    for (const file of ['archive-outcome.js', 'archive-format.js',
                        'archive-outcome-view.js', 'archive-nav-fuzzy.js',
                        'archive-nav-row.js', 'archive-nav-card.js',
                        'archive-nav-info.js', 'archive-nav-order.js',
                        'archive-nav-merged.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', file), 'utf8'),
            context, { filename: file }
        );
    }
    var calls = 0;
    var real = context.window.ArchiveNavOrder.sortNodes;
    context.window.ArchiveNavOrder.sortNodes = function () {
        calls++;
        return real.apply(this, arguments);
    };
    return {
        merged: context.window.ArchiveNavMerged,
        sortCalls: function () { return calls; },
        document: env.document,
    };
}

/** A merged project node as the server sends it. */
function node(displayName, fullPath, hosts, count) {
    return {
        project_id: 1, display_name: displayName, full_path: fullPath,
        observed_cwd: '/x/' + fullPath, hosts: hosts, host_count: hosts.length,
        transcript_count: count,
        members: hosts.map((h, i) => ({
            project_id: i + 1, corpus_id: i + 1, host_id: i + 1,
            host_display_name: h, slug: fullPath, transcript_count: count,
        })),
    };
}

/**
 * Paint into a fresh slot and hand back both the slot and paint()'s own
 * return value.
 * @param {object} doc @param {object} merged @param {object} state
 * @returns {{slot: object, result: object}}
 */
function paintInto(doc, merged, state) {
    const slot = doc.createElement('ul');
    const result = merged.paint(doc, slot, state);
    return { slot, result };
}

await test('a filter-text-only repaint does not re-run sortNodes', async () => {
    const { merged, sortCalls, document } = load();
    const nodes = [node('Alpha', 'alpha', ['h1'], 3), node('Beta', 'beta', ['h1'], 5)];

    paintInto(document, merged, { nodes, unattributed: [], hostId: null, filterText: 'a' });
    const afterFirst = sortCalls();
    assert.ok(afterFirst > 0, 'the first paint must have sorted at all');

    paintInto(document, merged, { nodes, unattributed: [], hostId: null, filterText: 'al' });
    assert.equal(sortCalls(), afterFirst,
        'a filter-text keystroke must not re-run sortNodes - the cache should hit');
});

await test('a DIFFERENT hostId forces a real recompute', async () => {
    const { merged, sortCalls, document } = load();
    // Distinct member host_ids, assigned explicitly rather than through
    // node()'s per-node index (which would give both nodes' sole member
    // host_id 1, making a host filter meaningless in this fixture).
    const alpha = node('Alpha', 'alpha', ['h1'], 3);
    alpha.members[0].host_id = 1;
    const beta = node('Beta', 'beta', ['h2'], 5);
    beta.members[0].host_id = 2;
    const nodes = [alpha, beta];

    paintInto(document, merged, { nodes, unattributed: [], hostId: null, filterText: '' });
    const afterFirst = sortCalls();

    // REMOVING hostId from the cache key's comparison is exactly what
    // this catches: without it, filtering to host 2 after having shown
    // both would keep serving the unfiltered ('both hosts') answer.
    const { result } = paintInto(document, merged,
        { nodes, unattributed: [], hostId: 2, filterText: '' });
    assert.ok(sortCalls() > afterFirst,
        'a changed host filter must recompute, not reuse the old membership');
    assert.equal(result.total, 1, 'the host filter must actually narrow the list');
});

await test('a NEW nodes array (a real refetch) forces a real recompute', async () => {
    const { merged, sortCalls, document } = load();
    const nodesA = [node('Alpha', 'alpha', ['h1'], 3)];
    paintInto(document, merged, { nodes: nodesA, unattributed: [], hostId: null, filterText: '' });
    const afterFirst = sortCalls();

    // A DIFFERENT array reference, even with identical contents, must be
    // treated as a new fetch - archive-nav.js only ever replaces
    // merged.nodes wholesale on a real fetch, never mutates the old one,
    // so a stale array here would mean a genuine data refresh got served
    // the previous fetch's stale order.
    const nodesB = [node('Alpha', 'alpha', ['h1'], 3)];
    paintInto(document, merged, { nodes: nodesB, unattributed: [], hostId: null, filterText: '' });
    assert.ok(sortCalls() > afterFirst,
        'a new nodes array must recompute even if its contents look the same');
});

await test('a DIFFERENT orderMode forces a real recompute', async () => {
    const { merged, sortCalls, document } = load();
    const nodes = [node('Alpha', 'alpha', ['h1'], 3), node('Zeta', 'zeta', ['h1'], 9)];

    paintInto(document, merged,
        { nodes, unattributed: [], hostId: null, filterText: '', orderMode: 'name' });
    const afterFirst = sortCalls();

    paintInto(document, merged,
        { nodes, unattributed: [], hostId: null, filterText: '', orderMode: 'recent' });
    assert.ok(sortCalls() > afterFirst,
        'a changed sort mode must recompute, not keep the old ordering');
});

await test('the cached path still renders the correct, current rows', async () => {
    // Caching the PIPELINE must never mean caching the RENDER: two
    // filter texts against the same normalized list must still show
    // their own distinct rows.
    const { merged, document } = load();
    const nodes = [node('Alpha', 'alpha', ['h1'], 3), node('Beta', 'beta', ['h1'], 5)];

    const first = paintInto(document, merged, { nodes, unattributed: [], hostId: null, filterText: 'alp' });
    const firstLabels = first.slot.querySelectorAll('.archive-nav__label')
        .map((el) => el.textContent);
    assert.deepEqual(firstLabels, ['Alpha']);

    const second = paintInto(document, merged, { nodes, unattributed: [], hostId: null, filterText: 'bet' });
    const secondLabels = second.slot.querySelectorAll('.archive-nav__label')
        .map((el) => el.textContent);
    assert.deepEqual(secondLabels, ['Beta']);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) { console.error('FAILURES'); process.exit(1); }
console.log('ALL PASS');
