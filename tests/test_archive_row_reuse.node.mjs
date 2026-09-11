// ROW REUSE: the archive reader must not rebuild a visible row's DOM
// subtree when nothing about that row changed, and must NEVER reuse one
// across a body, selection or disclosure-policy change.
//
// THE INVALIDATION TESTS ARE THE POINT, NOT THE HIT TESTS. A cache that
// never invalidates passes "the second render reuses the node" trivially
// and is a disclosure bug. Every "must change" case below was manually
// confirmed to FAIL when the corresponding guard is removed - see the
// comment on each one naming what removing it would let through.
//
// TWO LAYERS ARE TESTED. archive-row-cache.js's own {signature, node}
// contract is proven in isolation first, with no DOM and no reader,
// because that is where "disclosure policy is structurally part of the
// key" is easiest to state precisely: two different signatures for the
// same key can never resolve to the same node, whatever the signatures
// mean. The reader-level tests then prove archive-reader.js actually
// FEEDS that contract the right signals - a real body arriving, a real
// selection move, a real gate being lifted by renderAnyway.
//
// Run with: node tests/test_archive_row_reuse.node.mjs

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
 * Run one named async assertion block, recording pass/fail.
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

// -----------------------------------------------------------------
// LAYER 1: archive-row-cache.js in isolation. No DOM, no reader.
// -----------------------------------------------------------------

/**
 * Load only the row cache module into a bare vm context.
 * @returns {object} the fake window carrying ArchiveRowCache
 */
function loadRowCacheOnly() {
    const fakeWindow = {};
    const context = { window: fakeWindow, console: { log() {}, error() {} } };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'client', 'js', 'archive-row-cache.js'), 'utf8'),
        context, { filename: 'archive-row-cache.js' });
    return fakeWindow;
}

await test('cache: a matching signature returns the SAME node, unbuilt', () => {
    const w = loadRowCacheOnly();
    const cache = w.ArchiveRowCache.createNodeCache();
    let builds = 0;
    const build = () => { builds++; return { marker: builds }; };
    const a = cache.get('line:7', 'sig-a', build);
    const b = cache.get('line:7', 'sig-a', build);
    assert.equal(b, a, 'an unchanged signature must return the identical node');
    assert.equal(builds, 1, 'a cache hit must not call build again');
});

await test('cache: DISCLOSURE IS STRUCTURALLY PART OF THE KEY - a changed ' +
    'signature can never resolve to the old node, in either direction', () => {
    const w = loadRowCacheOnly();
    const cache = w.ArchiveRowCache.createNodeCache();
    // "included, unmasked text" then the SAME key tightens to a mask
    // refusal - the exact shape the issue calls the correctness case.
    const ok = cache.get('line:9', 'state:STATE_OK:0:0::11', () => ({ text: 'hello world' }));
    const tightened = cache.get('line:9', 'state:STATE_MASK_REFUSED:0:1:secret:0',
        () => ({ text: null, withheld: true }));
    assert.notEqual(tightened, ok,
        'a node built under STATE_OK must never be handed back once the ' +
        'same row becomes STATE_MASK_REFUSED');
    assert.equal(tightened.withheld, true);
    // And the reverse direction (a gate lifted) is equally a rebuild,
    // not a patch - REMOVING the signature check (returning `hit.node`
    // whenever `hit` exists, ignoring `signature`) makes this assertion
    // fail: the stale gated placeholder would be handed back forever.
    const loosened = cache.get('line:9', 'state:STATE_OK:0:0::11', () => ({ text: 'hello world' }));
    assert.notEqual(loosened, tightened,
        'a node built under the tightened state must never be handed back ' +
        'once the row is re-rendered under a looser one');
});

await test('cache: retain() drops everything not in the active set, ' +
    'bounding memory on a scrolled-past row', () => {
    const w = loadRowCacheOnly();
    const cache = w.ArchiveRowCache.createNodeCache();
    cache.get('line:1', 's', () => ({}));
    cache.get('line:2', 's', () => ({}));
    cache.get('line:3', 's', () => ({}));
    assert.equal(cache.size(), 3);
    const dropped = cache.retain(['line:2']);
    assert.equal(dropped, 2);
    assert.equal(cache.size(), 1);
    // REMOVING retain()'s call in paint() is exactly what this catches:
    // without it a 30,805-line scroll would grow this Map without bound.
    let builds = 0;
    cache.get('line:2', 's', () => { builds++; return {}; });
    assert.equal(builds, 0, 'the retained key must still be a hit');
});

await test('cache: clear() empties every entry, for a transcript switch', () => {
    const w = loadRowCacheOnly();
    const cache = w.ArchiveRowCache.createNodeCache();
    cache.get('line:1', 's', () => ({}));
    cache.clear();
    assert.equal(cache.size(), 0);
});

// -----------------------------------------------------------------
// LAYER 2: the real reader. archive-reader.js + archive-line-render.js
// + archive-body-cache.js, wired exactly as client/index.html loads them.
// -----------------------------------------------------------------

/**
 * Load every archive client module the reader needs into one sandbox
 * sharing a window, matching test_archive_reader_shell.node.mjs's list
 * plus archive-row-cache.js.
 * @param {object} doc a MiniDocument
 * @returns {object} the shared fake window
 */
function loadModules(doc) {
    const fakeWindow = { document: doc };
    const context = {
        window: fakeWindow,
        console: { log() {}, warn() {}, error() {}, debug() {} },
        Promise, Number, Math, Object, Array, String, Map, Set, JSON,
        setTimeout, clearTimeout,
    };
    context.globalThis = context;
    vm.createContext(context);
    for (const f of ['archive-outcome.js', 'archive-mask.js', 'archive-format.js',
        'archive-outcome-view.js', 'archive-state.js', 'archive-keys.js',
        'archive-virtual-list.js', 'archive-body-gate.js', 'archive-body-cache.js',
        'archive-line-render.js', 'archive-reader-dom.js', 'archive-reader-paging.js',
        'archive-reader-select.js', 'archive-reader-body.js',
        'archive-row-cache.js', 'archive-reader.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8'),
            context, { filename: f });
    }
    return fakeWindow;
}

/**
 * A document whose elements carry a settable style/clientHeight/scrollTop,
 * exactly as test_archive_reader_shell.node.mjs's harness does - the
 * reader needs those to compute a window at all.
 * @returns {{w: object, env: object, raf: Function, flush: Function}}
 */
function harness() {
    const env = createEnvironment();
    // Height oracle defaulting to UNMEASURABLE (null), exactly like
    // test_archive_reader_shell.node.mjs's harness. mini-dom has no
    // layout, so a real-looking constant height here would let the
    // anti-jump reconciler correct every row's estimated height on the
    // very next render, silently changing the window between two calls
    // that are supposed to be identical - a false positive for "the
    // window changed" that has nothing to do with row reuse.
    let heightFor = null;
    const realCreate = env.document.createElement.bind(env.document);
    env.document.createElement = (tag) => {
        const el = realCreate(tag);
        el.style = {};
        el.scrollTop = 0;
        el.clientHeight = 0;
        el.getBoundingClientRect = () => {
            const i = parseInt(el.getAttribute('data-index'), 10);
            const h = (heightFor && Number.isInteger(i)) ? heightFor(i) : null;
            return { height: Number.isFinite(h) ? h : 0 };
        };
        return el;
    };
    const frames = [];
    const w = loadModules(env.document);
    return {
        w, env, frames,
        setHeights(fn) { heightFor = fn; },
        flush() { const q = frames.splice(0); for (const fn of q) fn(); },
        raf(fn) { frames.push(fn); return frames.length; },
    };
}

/** An api that is never allowed to be called. */
const NO_API = {
    async getArchiveBody() { throw new Error('the reader fetched a bodyless row'); },
};

/**
 * A fake api resolving to the exact envelope shape
 * ArchiveBodyCache.request() expects, per test_archive_body_size_gates.
 * @param {object} bodies - body_id -> {body_json, secret_finding_count, secrets}
 * @returns {object} api
 */
function fakeApi(bodies) {
    return {
        async getArchiveBody(id) {
            if (!(id in bodies)) throw new Error(`unexpected fetch of body ${id}`);
            return {
                envelope: { result: bodies[id], result_status: 'ok',
                    scope_status: 'resolved', unevaluated: [], meta: {} },
                httpStatus: 200, headers: null, transportError: null,
            };
        },
    };
}

/**
 * Mount a reader with a measurable viewport.
 * @param {object} h a harness() @param {number} viewportPx
 * @param {?object} api
 * @returns {object} the mounted reader
 */
function mountedReader(h, viewportPx, api) {
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: api || NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    r.root().querySelector('.archive-reader__scroller').clientHeight = viewportPx;
    return r;
}

/**
 * A spine of `n` bodyless assistant rows.
 * @param {number} n @returns {Array<object>}
 */
function spineOf(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push({ line_no: i, record_type: 'assistant', role: 'assistant',
            body_id: null, body_chars: 400, is_sidechain: 0, agent_id: null });
    }
    return rows;
}

/**
 * The rendered `<article class="archive-row">` elements currently in the
 * DOM, in window order.
 * @param {object} r a reader @returns {Array<Element>}
 */
function rowNodes(r) {
    return [...r.root().querySelectorAll('.archive-row')];
}

await test('case 1: re-rendering with the SAME window reuses every node, by identity', () => {
    const h = harness();
    const r = mountedReader(h, 800);
    r.setSpine(spineOf(200), true);
    const before = rowNodes(r);
    assert.ok(before.length > 0, 'nothing rendered');

    // A render triggered for a reason that has nothing to do with these
    // rows - exactly "any unrelated state change" from the issue text.
    // Removing the row cache (falling back to always-rebuild) makes this
    // assertion fail: every node below would be a fresh object.
    r.render();
    const after = rowNodes(r);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
        assert.equal(after[i], before[i], `row ${i} was rebuilt on an unchanged window`);
    }
});

await test('case 2: a body arriving rebuilds ONLY that row; its neighbours are untouched', async () => {
    const h = harness();
    const r = mountedReader(h, 800, fakeApi({
        501: { body_json: 'the fetched body text', secret_finding_count: 0, secrets: [] },
    }));
    const spine = spineOf(10);
    spine[3].body_id = 501;
    spine[3].body_chars = 20;
    r.setSpine(spine, true);

    const before = rowNodes(r);
    const beforeByLine = new Map(before.map((n) => [n.getAttribute('data-line-no'), n]));
    assert.equal(beforeByLine.get('3').querySelector('.archive-row__body')
        .getAttribute('data-body-state'), 'not-requested');

    // Let the auto-fetch triggered by setSpine's render() resolve, then
    // run the queued repaint it scheduled.
    await new Promise((resolve) => setImmediate(resolve));
    h.flush();

    const after = rowNodes(r);
    const afterByLine = new Map(after.map((n) => [n.getAttribute('data-line-no'), n]));
    const row3 = afterByLine.get('3');
    assert.equal(row3.querySelector('.archive-row__body').getAttribute('data-body-state'), 'included',
        'the fetched row must show the arrived body');
    assert.ok(row3.textContent.includes('the fetched body text'));
    assert.notEqual(row3, beforeByLine.get('3'),
        'the row whose body arrived must be a freshly built node');

    // EVERY OTHER VISIBLE ROW MUST BE THE EXACT SAME NODE. Removing the
    // signature/cache-key discipline (rebuilding every visible row on
    // any schedule()) makes this loop fail on row 0, 1, 2, 4... too.
    for (const [line, node] of beforeByLine) {
        if (line === '3') continue;
        assert.equal(afterByLine.get(line), node,
            `row ${line} rebuilt when only row 3's body changed`);
    }
});

await test('case 3: selection moving patches attributes on the two affected ' +
    'rows only; every node keeps its identity', () => {
    const h = harness();
    const r = mountedReader(h, 800);
    r.setSpine(spineOf(50), true);
    r.selectIndex(2);

    const before = rowNodes(r);
    const rowAt = (nodes, i) => nodes.find((n) => n.getAttribute('data-index') === String(i));
    assert.equal(rowAt(before, 2).getAttribute('data-selected'), 'true');
    assert.equal(rowAt(before, 2).getAttribute('tabindex'), '0');
    assert.equal(rowAt(before, 5).getAttribute('tabindex'), '-1');
    assert.equal(rowAt(before, 5).hasAttribute('data-selected'), false);

    r.moveSelection(3); // 2 -> 5

    const after = rowNodes(r);
    assert.equal(after.length, before.length,
        'a selection move must not change how many rows are visible');
    for (let i = 0; i < before.length; i++) {
        assert.equal(after[i], before[i],
            'selection changed which node object represents a row - it ' +
            'must only change which row is MARKED selected');
    }
    assert.equal(rowAt(after, 5).getAttribute('data-selected'), 'true',
        'the newly selected row must be marked');
    assert.equal(rowAt(after, 5).getAttribute('tabindex'), '0');
    assert.equal(rowAt(after, 2).hasAttribute('data-selected'), false,
        'the previously selected row must be UNMARKED, not left selected');
    assert.equal(rowAt(after, 2).getAttribute('tabindex'), '-1');
});

await test('case 4: a lifted gate (a real disclosure-policy change) rebuilds ' +
    'the row and shows the stricter/looser content, never the stale one', async () => {
    const h = harness();
    const r = mountedReader(h, 800, fakeApi({
        900: { body_json: 'B'.repeat(300000), secret_finding_count: 0, secrets: [] },
    }));
    const spine = spineOf(5);
    spine[1].body_id = 900;
    spine[1].body_chars = 300000; // above the 256 KiB soft gate
    r.setSpine(spine, true);

    const gatedNode = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '1');
    assert.equal(gatedNode.querySelector('.archive-row__body').getAttribute('data-body-state'), 'gated-soft',
        'a 300000-char body must land on the soft gate, not auto-render');
    assert.ok(gatedNode.querySelector('[data-action="render-anyway"]'),
        'the gated row must offer the render-anyway action');

    // The reader's OWN "render anyway" verb - the real mechanism by which
    // this row's disclosure outcome changes for a person who asked for it.
    await r.renderAnyway(1);
    h.flush();

    const openedNode = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '1');
    assert.notEqual(openedNode, gatedNode,
        'a row whose disclosure outcome changed must never be handed back ' +
        'as the old node - that would be the stale gate placeholder ' +
        'sitting over content that has actually arrived');
    assert.equal(openedNode.querySelector('.archive-row__body').getAttribute('data-body-state'), 'included');
    assert.ok(openedNode.textContent.includes('B'.repeat(50)),
        'the opened row must show the real body, not the gate message');
    assert.ok(!openedNode.textContent.includes('LARGE BODY'),
        'the stale gated content must not still be on screen');
});

await test('case 5: badges (sidechain, agent) survive a reuse - they are ' +
    'never dropped by a cache hit that skips renderMeta', () => {
    const h = harness();
    const r = mountedReader(h, 800);
    const spine = spineOf(5);
    spine[2].is_sidechain = 1;
    spine[2].agent_id = 'agent-77';
    r.setSpine(spine, true);

    const before = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '2');
    assert.ok(before.querySelector('[data-badge="sidechain"]'), 'sidechain badge missing on first render');
    assert.ok(before.querySelector('[data-badge="agent"]'), 'agent badge missing on first render');

    r.render(); // unrelated re-render; this row's signature is unchanged
    const after = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '2');
    assert.equal(after, before, 'the badged row should have been reused, not rebuilt');
    assert.ok(after.querySelector('[data-badge="sidechain"]'),
        'a reused node lost its sidechain badge');
    assert.ok(after.querySelector('[data-badge="agent"]'),
        'a reused node lost its agent badge');
    assert.ok(after.textContent.includes('agent agent-77'));
});

await test('a transcript switch (setSpine) never reuses a node across ' +
    'colliding line_no values from the OLD transcript', () => {
    const h = harness();
    const r = mountedReader(h, 800);
    r.setSpine(spineOf(5).map((row, i) => ({ ...row, body_id: 1000 + i,
        body_chars: null })), true);
    // Give line 2 real, distinguishable OK content from transcript A.
    const specificA = { line_no: 2, record_type: 'assistant', role: 'assistant',
        body_id: null, body_chars: 12 };
    r.setSpine([specificA], true);
    const nodeA = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '2');
    assert.ok(nodeA, 'transcript A did not render line 2');

    // Transcript B reuses the SAME line_no with a DIFFERENT record_type/
    // role - the exact numeric coincidence the file header warns about.
    // Removing rowCache.clear() from setSpine is what this test exists
    // to catch: without it, a signature that happens to match ('not-
    // requested' for both, same line_no key) would hand back transcript
    // A's node wearing transcript B's line number.
    const specificB = { line_no: 2, record_type: 'user', role: 'user',
        body_id: null, body_chars: 999 };
    r.setSpine([specificB], true);
    const nodeB = rowNodes(r).find((n) => n.getAttribute('data-line-no') === '2');
    assert.ok(nodeB, 'transcript B did not render line 2');
    assert.notEqual(nodeB, nodeA,
        'a new transcript reused a node cached under the old transcript\'s ' +
        'line_no - a real cross-transcript content collision');
    assert.equal(nodeB.querySelector('.archive-row__role').textContent, 'user');
});

if (failures > 0) {
    console.error(`\n${failures} failing, ${passes} passing`);
    process.exit(1);
} else {
    console.log(`\nALL PASS (${passes})`);
}
