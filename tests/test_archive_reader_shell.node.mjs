// The reader shell: state routing, the anti-jump payment, and the fact
// that nothing renders a hand-rolled empty or error state.
//
// WHY THIS FILE EXISTS ALONGSIDE THE OTHER THREE. Those test the engine,
// the gates and the row. This one tests the composition, which is where
// a correct engine and a correct renderer can still produce a wrong
// screen: a spinner that never resolves, an empty state where a
// cannot-determine belongs, or an anti-jump delta computed and then
// never paid.
//
// THE ANTI-JUMP ASSERTION IS THE POINT. The virtual list computes the
// delta; only the reader can pay it, and it must pay it in the same
// frame. A test that only asserts the engine's return value would pass
// on a reader that throws the delta away, which is exactly the bug the
// design fears.
//
// mini-dom has no layout, so heights are injected via a stub
// getBoundingClientRect. That is honest about what is being tested:
// the reconcile ARITHMETIC and the scrollTop write, not the browser's
// measurement. Real pixel behaviour needs a real browser.
//
// Run with: node tests/test_archive_reader_shell.node.mjs

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

/**
 * Load every archive client module into one sandbox sharing a window.
 * @param {object} doc - a MiniDocument
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
        'archive-outcome-view.js', 'archive-state.js', 'archive-virtual-list.js',
        'archive-body-cache.js', 'archive-line-render.js', 'archive-reader.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8'),
            context, { filename: f });
    }
    return fakeWindow;
}

/**
 * A document whose elements carry a settable `style`, `clientHeight` and
 * `scrollTop`, which mini-dom does not model. Only the reader needs them.
 * @returns {object} {window, document, flush}
 */
function harness() {
    const env = createEnvironment();
    // Height oracle. The reader recreates its row elements on EVERY
    // paint, so a rect stubbed onto a node after one render is gone by
    // the next one. Installing it at createElement time is the only way
    // to give a freshly painted row a height, which is what a real
    // browser does for free.
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
        /**
         * Install the height oracle. `null` means "no element can be
         * measured", which is the honest default for a DOM with no
         * layout - and is why nothing reconciles unless a test asks.
         * @param {?function(number): ?number} fn @returns {void}
         */
        setHeights(fn) { heightFor = fn; },
        /** Run every queued animation frame callback. @returns {void} */
        flush() { const q = frames.splice(0); for (const fn of q) fn(); },
        /** The injectable rAF. @param {Function} fn @returns {number} */
        raf(fn) { frames.push(fn); return frames.length; },
    };
}

/**
 * A spine of `n` assistant rows with a fixed estimated size.
 * @param {number} n @returns {Array<object>}
 */
function spineOf(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push({ line_no: i, record_type: 'assistant', role: 'assistant',
            body_id: null, body_chars: 400, body_state: 'not_requested' });
    }
    return rows;
}

/** An api that is never allowed to be called. */
const NO_API = {
    /** @returns {Promise<never>} always throws */
    async getArchiveBody() { throw new Error('the reader fetched a bodyless row'); },
};

await test('idle renders the prompt and the verbatim NOT CHECKED line', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    const t = r.root().textContent;
    assert.ok(t.includes('Pick a transcript.'));
    // Rendered verbatim: this build does not correlate archived
    // transcripts with live sessions, and it is not asserting that there
    // are none. "Not checked" and "none found" are different findings.
    assert.ok(t.includes('Live session: NOT CHECKED'));
    // idle must NOT look like empty.
    assert.equal(r.root().querySelectorAll('[data-outcome="empty"]').length, 0);
    assert.equal(
        r.root().querySelector('.archive-reader__status')
            .getAttribute('data-reader-state'), 'idle');
});

await test('loading states its own deadline, so it is visibly terminal', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    r.setToken('loading', null);
    const t = r.root().textContent;
    // A spinner with no terminal condition is a state that can never
    // fail. The deadline is named in seconds so a reader can tell.
    assert.ok(/\d+s/.test(t), `no deadline named in the loading state: ${t}`);
    assert.ok(t.includes('NO ANSWER FROM THE SERVER'));
});

await test('every failure token routes through archive-outcome-view, never a hand-rolled state', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    const cases = [
        ['cannot-determine', { result: null, result_status: 'cannot_determine',
            scope_status: 'resolved',
            unevaluated: [{ subject: 'lines', reason: 'index unreadable' }],
            meta: {} }, 'COULD NOT EVALUATE'],
        ['not-found', { result: null, result_status: 'not_found',
            scope_status: 'not_found',
            unevaluated: [{ subject: 'transcript:99999',
                reason: 'no row in message_transcripts with id 99999' }],
            meta: {} }, 'NOT FOUND'],
        ['transport-error', null, 'NO ANSWER FROM THE SERVER'],
        ['empty', { result: [], result_status: 'ok', scope_status: 'resolved',
            unevaluated: [], meta: {} }, 'NO MATCHES'],
        ['partial', { result: [1], result_status: 'partial',
            scope_status: 'resolved', unevaluated: [], meta: {} },
            'INCOMPLETE'],
    ];
    const labels = new Set();
    for (const [token, env, word] of cases) {
        r.setToken(token, env);
        const block = r.root().querySelector('[data-outcome]');
        assert.ok(block, `${token}: no outcome block rendered`);
        assert.equal(block.getAttribute('data-outcome'), token);
        assert.ok(r.root().textContent.includes(word),
            `${token}: expected the words "${word}"`);
        labels.add(word);
    }
    // The five must be distinguishable by their WORDS alone, with no
    // colour and no radius involved.
    assert.equal(labels.size, cases.length,
        'two outcomes rendered the same leading words');
});

await test('the header survives a cannot-determine on the lines', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    // The SERVER'S field names, verbatim from GET
    // /api/v1/archive/transcripts/5767 (measured 2026-08-31). An invented
    // name here is how the header shipped "size NOT KNOWN" over a byte
    // count the app already had, with this test green.
    r.setHeader({ transcript_id: 5767, session_ref: '6e4a3f8b-4751',
        line_count: 30805, raw_byte_length: 91950363 });
    r.setToken('cannot-determine', { result: null,
        result_status: 'cannot_determine', scope_status: 'resolved',
        unevaluated: [{ subject: 'lines', reason: 'index unreadable' }], meta: {} });
    const t = r.root().querySelector('.archive-reader__header').textContent;
    // The header's facts came from a DIFFERENT request that succeeded.
    // Hiding them would discard a real measurement.
    assert.ok(t.includes('6e4a3f8b-4751'));
    assert.ok(t.includes('30,805') || t.includes('30805'),
        `line count missing from the header: ${t}`);
    // The byte count too. Without this the header could go back to
    // reading a field the server does not send and this test would not
    // notice - which is exactly what happened.
    assert.ok(!t.includes('size NOT KNOWN'),
        `header rendered an unknown size over a real raw_byte_length: ${t}`);
});

await test('an incomplete spine ends in a named sentinel, not a silent stop', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    r.setSpine(spineOf(20), false);
    assert.ok(r.root().textContent.includes('More lines not loaded yet'),
        'a list that just ends looks complete');

    r.setSpine(spineOf(20), true);
    assert.ok(!r.root().textContent.includes('More lines not loaded yet'));
});

await test('30,805 rows render a bounded window, not 30,805 elements', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    const scroller = r.root().querySelector('.archive-reader__scroller');
    scroller.clientHeight = 800;
    r.setSpine(spineOf(30805), true);

    const rendered = r.root().querySelectorAll('[data-index]').length;
    assert.ok(rendered > 0, 'nothing rendered at all');
    assert.ok(rendered < 200,
        `${rendered} rows in the DOM for a 30,805-row transcript`);
    // The spacer carries the honest total height: a real sum, in px,
    // never a round number and never a page count.
    const spacer = r.root().querySelector('.archive-reader__spacer');
    assert.equal(spacer.style.height, r.list.totalHeight() + 'px');
    assert.ok(r.list.totalHeight() > 0);
});

await test('the reader PAYS the anti-jump delta, in the same pass', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    const scroller = r.root().querySelector('.archive-reader__scroller');
    scroller.clientHeight = 800;
    r.setSpine(spineOf(5000), true);

    // Scroll deep enough that rows sit above the viewport.
    scroller.scrollTop = 40000;
    r.render();
    const win = r.list.windowFor(40000, 800);
    assert.ok(win.firstVisible > 20, 'the pivot must have rows above it');

    // Every rendered row above the pivot reports 50px more than its
    // estimate. Nothing at or below the pivot changes, so the whole
    // delta is owed to the rows the reader cannot see.
    const before = scroller.scrollTop;
    const rendered = [...r.root().querySelectorAll('[data-index]')]
        .map((n) => parseInt(n.getAttribute('data-index'), 10));
    const above = rendered.filter((i) => i < win.firstVisible);
    assert.ok(above.length > 0, 'the setup produced nothing to compensate');
    const owed = above.length * 50;
    const baseline = new Map(rendered.map((i) => [i, r.list.heightOf(i)]));
    h.setHeights((i) => baseline.has(i)
        ? baseline.get(i) + (i < win.firstVisible ? 50 : 0)
        : null);

    r.render();
    assert.equal(scroller.scrollTop, before + owed,
        'the reader computed the delta and did not pay it');
    // And nothing was double-counted on a second pass: the heights now
    // match, so there is no correction left to make.
    const settled = scroller.scrollTop;
    r.render();
    assert.equal(scroller.scrollTop, settled,
        'a settled reader must not keep scrolling itself');
});

await test('a bodyless row is never fetched, so the reader never touches the api', () => {
    const h = harness();
    let calls = 0;
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document,
        api: { async getArchiveBody() { calls++; return {}; } },
        requestAnimationFrame: h.raf,
    });
    r.mount(h.env.document.body);
    r.root().querySelector('.archive-reader__scroller').clientHeight = 400;
    r.setSpine(spineOf(50), true);
    assert.equal(calls, 0, 'rows with a null body_id must not be fetched');
});

await test('a hard-gated row in the window is never auto-fetched by the reader', () => {
    const h = harness();
    let calls = 0;
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document,
        api: { async getArchiveBody() { calls++; return {}; } },
        requestAnimationFrame: h.raf,
    });
    r.mount(h.env.document.body);
    r.root().querySelector('.archive-reader__scroller').clientHeight = 400;
    r.setSpine([
        { line_no: 62, record_type: 'user', role: 'user', body_id: 2396142,
            body_chars: 54376859, body_state: 'not_requested' },
    ], true);
    assert.equal(calls, 0, 'the reader auto-fetched the 54 MB body');
    const box = r.root().querySelector('.archive-row__body');
    assert.equal(box.getAttribute('data-body-state'), 'gated-hard');
    assert.equal(
        r.root().querySelectorAll('[data-action="render-anyway"]').length, 0);
});

await test('expanding a progress run is an ordinary height correction', () => {
    const h = harness();
    const r = h.w.ArchiveReader.createReader({
        document: h.env.document, api: NO_API, requestAnimationFrame: h.raf });
    r.mount(h.env.document.body);
    r.root().querySelector('.archive-reader__scroller').clientHeight = 800;
    const spine = [{ line_no: 1, record_type: 'assistant', role: 'assistant',
        body_id: null, body_chars: 100 }];
    for (let i = 2; i <= 15; i++) {
        spine.push({ line_no: i, record_type: 'progress', role: null,
            body_id: null, body_chars: 40 });
    }
    r.setSpine(spine, true);
    assert.equal(r.items().length, 2, 'the run must fold');
    const collapsedTotal = r.list.totalHeight();

    r.setProgressExpanded(1, true);
    assert.ok(r.list.totalHeight() > collapsedTotal,
        'expanding must grow the content height');
    assert.equal(
        r.root().querySelectorAll('.archive-row__progress-children').length, 1);
    assert.ok(r.root().textContent.includes('progress x 14'),
        'the count stays visible when expanded');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
