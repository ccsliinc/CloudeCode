// The same-origin script loader behind issue #48's lazy-loaded families.
// ----------------------------------------------------------------------
// WHAT THIS SUITE PINS, AND WHY. client/js/module-loader.js downloads a
// named family of same-origin <script> elements concurrently and executes
// them in document order, retries only the resource that actually failed,
// and is idempotent per family name. None of that is provable by reading
// the file - it has to be driven against a fake DOM that can answer
// "load" or "error" for each element independently and out of order,
// which is exactly what a real flaky network does.
//
// THE LOAD-BEARING CASE IS THE FAILURE ONE. A test proving a family loads
// successfully proves nothing about what happens when a resource does
// not arrive - see CLAUDE.md, "a test that cannot fail is not evidence".
// test_family_exhausts_retries_and_rejects_naming_the_url below is that
// case: it drives every retry to failure and asserts the family's promise
// REJECTS, naming the URL that never loaded, rather than resolving as if
// nothing were wrong.
//
// Run with: node --test tests/test_module_loader.node.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'client', 'js', 'module-loader.js'), 'utf8');

/**
 * A fake <script> element: enough of the real surface for module-loader.js
 * to drive (src assignment history, async flag, load/error listeners) plus
 * test-only hooks to fire those events on demand.
 *
 * @returns {object} the fake element.
 */
function makeFakeScript() {
    const listeners = { load: [], error: [] };
    return {
        tagName: 'SCRIPT',
        async: true,
        _srcHistory: [],
        _src: null,
        get src() { return this._src; },
        set src(v) { this._src = v; this._srcHistory.push(v); },
        addEventListener(type, cb) { listeners[type].push(cb); },
        removeEventListener(type, cb) {
            listeners[type] = listeners[type].filter((f) => f !== cb);
        },
        _fireLoad() { listeners.load.slice().forEach((cb) => cb()); },
        _fireError() { listeners.error.slice().forEach((cb) => cb()); },
    };
}

/**
 * A fake document whose createElement('script') hands back a script this
 * test can drive, and whose head.appendChild records arrival ORDER - the
 * property module-loader.js's async=false technique depends on.
 *
 * @returns {{doc: object, created: object[]}} the fake document and the
 *   list of every script element it created, in creation/append order.
 */
function makeFakeDocument() {
    const created = [];
    const doc = {
        head: {
            appendChild(el) { created.push(el); },
        },
        createElement(tag) {
            assert.equal(tag, 'script', 'module-loader.js must only create <script> elements');
            return makeFakeScript();
        },
    };
    return { doc, created };
}

/**
 * Load module-loader.js into a fresh vm sandbox wired to a fresh fake
 * document, so each test gets an isolated window.ModuleLoader with no
 * state left over from a previous test.
 *
 * @returns {{ModuleLoader: object, created: object[]}}
 */
function loadModuleLoader() {
    const { doc, created } = makeFakeDocument();
    const sandbox = {
        window: {},
        document: doc,
        console: { log() {}, warn() {}, error() {}, debug() {} },
        setTimeout,
        clearTimeout,
        Promise,
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'module-loader.js' });
    assert.ok(sandbox.window.ModuleLoader, 'module-loader.js must define window.ModuleLoader');
    return { ModuleLoader: sandbox.window.ModuleLoader, created };
}

test('every element is created and appended in document order before any resolves', () => {
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/a.js', '/static/js/b.js', '/static/js/c.js'];
    ModuleLoader.loadFamily('fam', urls);
    assert.deepEqual(created.map((el) => el._src), urls,
        'elements must be created/appended in the family\'s given order');
    assert.ok(created.every((el) => el.async === false),
        'every element must set async=false so parallel download does not reorder execution');
});

test('execution order is preserved when downloads complete out of order', async () => {
    // Case 6 from issue #48: force the LATER resource to answer first.
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/first.js', '/static/js/second.js'];
    const p = ModuleLoader.loadFamily('archive-order-test', urls);
    assert.equal(created.length, 2);
    // second.js answers before first.js - a real out-of-order network.
    created[1]._fireLoad();
    created[0]._fireLoad();
    const result = await p;
    assert.equal(result.ok, true);
    // The DOM position each element was appended at is what a real browser
    // uses to order execution; both were appended once, in the family's
    // order, regardless of which one's network response landed first.
    assert.deepEqual(created.map((el) => el._src), urls);
});

test('opening a family twice while loading returns the SAME promise and injects nothing twice', async () => {
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/a.js', '/static/js/b.js'];
    const p1 = ModuleLoader.loadFamily('archive', urls);
    const p2 = ModuleLoader.loadFamily('archive', urls);
    assert.equal(p1, p2, 'a second call while loading must return the identical promise');
    assert.equal(created.length, 2, 'no second set of elements may be created while the first is in flight');
    created.forEach((el) => el._fireLoad());
    await p1;
});

test('a family already loaded resolves immediately with no new DOM work', async () => {
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/only.js'];
    const p1 = ModuleLoader.loadFamily('config-editor', urls);
    created[0]._fireLoad();
    const first = await p1;
    assert.equal(first.cached, false);
    assert.equal(ModuleLoader.status('config-editor'), ModuleLoader.STATUS_LOADED);

    const before = created.length;
    const second = await ModuleLoader.loadFamily('config-editor', urls);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(created.length, before, 'a loaded family must create no new script elements');
});

test('a resource that fails once is retried IN PLACE, and only that resource', async () => {
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/flaky.js', '/static/js/steady.js'];
    const p = ModuleLoader.loadFamily('retry-test', urls, { maxRetries: 2, retryDelayMs: 1 });
    assert.equal(created.length, 2, 'both elements are created up front, not one at a time');

    created[1]._fireLoad(); // the healthy resource loads normally
    created[0]._fireError(); // the flaky one fails its first attempt

    // Wait past the retry backoff for the SAME element to be re-armed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(created.length, 2, 'a retry must reuse the existing element, never create a new one');
    assert.ok(created[0]._src.includes('_retry=1'),
        'the retried element\'s src must carry a cache-busting marker so a cached error is not replayed');
    created[0]._fireLoad();

    const result = await p;
    assert.equal(result.ok, true, 'the family must still succeed once the retried resource loads');
});

test('a family exhausts retries and REJECTS, naming the url that never loaded', async () => {
    // THE LOAD-BEARING CASE. A lazily-loaded chunk that never arrives must
    // fail loudly - see issue #48 and client/js/archive-loader.js, which
    // turns this rejection into a visible banner rather than a blank
    // screen. A test that only proves the happy path proves nothing about
    // this, which is exactly the failure mode CLAUDE.md's "a test that
    // cannot fail is not evidence" warns about.
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/never-arrives.js', '/static/js/fine.js'];
    const p = ModuleLoader.loadFamily('doomed', urls, { maxRetries: 2, retryDelayMs: 1 });

    created[1]._fireLoad(); // the other resource is healthy throughout

    // Fail the first attempt and both retries - three failures total for
    // maxRetries: 2 (the original attempt plus two retries).
    created[0]._fireError();
    await new Promise((resolve) => setTimeout(resolve, 10));
    created[0]._fireError();
    await new Promise((resolve) => setTimeout(resolve, 20));
    created[0]._fireError();

    await assert.rejects(
        p,
        (err) => {
            assert.match(err.message, /doomed/, 'the rejection must name the family');
            assert.match(err.message, /never-arrives\.js/, 'the rejection must name the failed URL');
            return true;
        },
    );
    assert.equal(ModuleLoader.status('doomed'), ModuleLoader.STATUS_FAILED);
});

test('a family that failed is retried FRESH on the next call, not remembered as permanently failed', async () => {
    const { ModuleLoader, created } = loadModuleLoader();
    const urls = ['/static/js/sometimes.js'];
    const p1 = ModuleLoader.loadFamily('flaky-family', urls, { maxRetries: 0, retryDelayMs: 1 });
    created[0]._fireError();
    await assert.rejects(p1);
    assert.equal(ModuleLoader.status('flaky-family'), ModuleLoader.STATUS_FAILED);

    const p2 = ModuleLoader.loadFamily('flaky-family', urls, { maxRetries: 0, retryDelayMs: 1 });
    assert.notEqual(p1, p2, 'a failed family must start a genuinely new attempt, not replay the rejected promise');
    assert.equal(created.length, 2, 'the fresh attempt creates its own element rather than reusing the failed one');
    created[1]._fireLoad();
    const result = await p2;
    assert.equal(result.ok, true);
    assert.equal(ModuleLoader.status('flaky-family'), ModuleLoader.STATUS_LOADED);
});

test('status() reports unloaded for a family never requested', () => {
    const { ModuleLoader } = loadModuleLoader();
    assert.equal(ModuleLoader.status('never-asked-for'), ModuleLoader.STATUS_UNLOADED);
});
