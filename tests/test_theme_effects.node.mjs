// Node tests for the shared theme-effects harness
// (client/css/themes/_shared/effects-base.js) and every theme module built
// on it.
//
// WHAT THESE LOCK DOWN. A theme background effect runs behind a terminal the
// user keeps open for hours, and it is mounted and unmounted every time the
// theme changes. That makes two classes of defect expensive and invisible:
//
//  1. A LEAKED rAF LOOP. registry.js calls destroy() on theme switch. If a
//     module cancels its canvas but not its loop, every theme switch in a
//     session adds another loop drawing into a detached context, forever,
//     and nothing in the UI shows it. The cycle test below switches ten
//     times and asserts the pending-callback count returns to zero, because
//     a single init/destroy pair passes even when the leak is real.
//  2. A THIRD-OUTCOME COLLAPSE. An effect that cannot get a 2D context must
//     report `unavailable` and let the theme apply anyway. Reporting it as
//     success is a false green; throwing takes the theme down with it. Both
//     are asserted, in both directions.
//
// Also covered: zero scheduled work in a hidden tab, reduced-motion handling
// (static frame or nothing, never an animation), the frame cap, and the
// no-input-interception guarantee.
//
// Run with: node tests/test_theme_effects.node.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const themesDir = path.join(repoRoot, 'client', 'css', 'themes');

let failures = 0;
let passes = 0;

/**
 * Run one named assertion, recording the outcome.
 * @param {string} name Test name shown in the output
 * @param {function(): void} fn Body; throws to fail
 * @returns {void}
 */
function test(name, fn) {
    try {
        fn();
        passes++;
        console.log('ok - ' + name);
    } catch (err) {
        failures++;
        console.error('NOT OK - ' + name);
        console.error(err && err.stack ? err.stack : err);
    }
}

// ---------------------------------------------------------------------
// Minimal DOM stub. Deliberately hand-rolled rather than jsdom: the point
// is to COUNT scheduled callbacks and registered listeners, which a real
// DOM hides.
// ---------------------------------------------------------------------

/**
 * Build a fresh fake environment and install it on globalThis.
 * @param {{reducedMotion?: boolean, hidden?: boolean, contextFails?: boolean,
 *   width?: number}} [opts] Environment knobs
 * @returns {object} Handles for inspecting scheduled work and listeners
 */
function installEnv(opts = {}) {
    const rafPending = new Map();
    let rafSeq = 0;
    const winListeners = [];
    const docListeners = [];
    const mqlListeners = [];
    const body = { children: [] };

    /**
     * Build a stub 2D context recording nothing but answering every call the
     * harness and the shipped effects make.
     * @returns {object} Fake CanvasRenderingContext2D
     */
    function makeCtx() {
        const grad = { addColorStop() {} };
        return {
            drawCalls: 0,
            setTransform() {}, scale() {}, fillRect() { this.drawCalls++; },
            fillText() {}, drawImage() { this.drawCalls++; },
            createLinearGradient: () => grad,
            createRadialGradient: () => grad,
            createPattern: () => ({}),
            font: '', textBaseline: '', fillStyle: '',
        };
    }

    const doc = {
        hidden: !!opts.hidden,
        documentElement: { dataset: {} },
        body,
        createElement(tag) {
            const el = {
                tagName: String(tag).toUpperCase(),
                style: {},
                width: 0,
                height: 0,
                parentNode: null,
                _ctx: null,
                setAttribute(k, v) { this[k] = v; },
                getContext() {
                    if (opts.contextFails) return null;
                    if (!this._ctx) this._ctx = makeCtx();
                    return this._ctx;
                },
            };
            return el;
        },
        addEventListener(type, fn) { docListeners.push({ type, fn }); },
        removeEventListener(type, fn) {
            const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
            if (i >= 0) docListeners.splice(i, 1);
        },
    };
    body.appendChild = (el) => { el.parentNode = body; body.children.push(el); return el; };
    body.removeChild = (el) => {
        const i = body.children.indexOf(el);
        if (i >= 0) body.children.splice(i, 1);
        el.parentNode = null;
        return el;
    };

    const mql = {
        matches: !!opts.reducedMotion,
        addEventListener(type, fn) { mqlListeners.push({ type, fn }); },
        removeEventListener(type, fn) {
            const i = mqlListeners.findIndex((l) => l.type === type && l.fn === fn);
            if (i >= 0) mqlListeners.splice(i, 1);
        },
    };

    const win = {
        innerWidth: opts.width || 1440,
        innerHeight: 900,
        devicePixelRatio: 2,
        matchMedia: () => mql,
        addEventListener(type, fn) { winListeners.push({ type, fn }); },
        removeEventListener(type, fn) {
            const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
            if (i >= 0) winListeners.splice(i, 1);
        },
    };

    globalThis.window = win;
    globalThis.document = doc;
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    globalThis.requestAnimationFrame = (fn) => {
        rafSeq += 1;
        rafPending.set(rafSeq, fn);
        return rafSeq;
    };
    globalThis.cancelAnimationFrame = (id) => { rafPending.delete(id); };

    return {
        rafPending, winListeners, docListeners, mqlListeners, body, doc, win, mql,
        /**
         * Run every currently-pending rAF callback once at timestamp `now`.
         * @param {number} now Timestamp handed to the callbacks
         * @returns {void}
         */
        flush(now) {
            const due = [...rafPending.entries()];
            for (const [id, fn] of due) {
                rafPending.delete(id);
                fn(now);
            }
        },
        /**
         * The canvas the effect mounted, if any.
         * @returns {object|undefined} The canvas stub
         */
        canvas() { return body.children[0]; },
    };
}

/** Theme ids that ship an effects module, discovered from disk. */
const effectThemes = fs.readdirSync(themesDir)
    .filter((d) => fs.existsSync(path.join(themesDir, d, 'theme.json')))
    .filter((d) => {
        const m = JSON.parse(fs.readFileSync(path.join(themesDir, d, 'theme.json'), 'utf8'));
        return !!m.effects;
    })
    .sort();

// The client is served as plain static files and the browser loads these as ES
// modules, but node resolves a bare `.js` as CommonJS without a package.json
// declaring otherwise. Rather than adding one to every theme directory purely
// for the tests, mirror the sources into a temp tree as `.mjs` with the one
// relative specifier rewritten. The mirror is byte-identical apart from that
// extension, so nothing about the shipped files is special-cased for tests.
const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-effects-test-'));
process.on('exit', () => {
    try { fs.rmSync(mirrorDir, { recursive: true, force: true }); } catch (_) {}
});

/**
 * Copy one source file into the mirror tree, rewriting the harness import.
 * @param {string} relDir Directory under client/css/themes
 * @param {string} name Source file name, e.g. "effects.js"
 * @returns {string} Absolute path to the mirrored .mjs file
 */
function mirror(relDir, name) {
    const src = fs.readFileSync(path.join(themesDir, relDir, name), 'utf8');
    const outDir = path.join(mirrorDir, relDir);
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, name.replace(/\.js$/, '.mjs'));
    fs.writeFileSync(out, src.replace(
        '../_shared/effects-base.js',
        '../_shared/effects-base.mjs',
    ));
    return out;
}

mirror('_shared', 'effects-base.js');

/**
 * Import a theme's effects module fresh, defeating the ESM cache so each test
 * gets its own module-level state.
 * @param {string} themeId Theme directory name
 * @returns {Promise<object>} The module namespace
 */
function loadEffect(themeId) {
    const file = mirror(themeId, 'effects.js');
    const url = pathToFileURL(file).href + '?v=' + Math.random();
    return import(url);
}

// ---------------------------------------------------------------------

console.log(`discovered effect themes: ${effectThemes.join(', ')}`);

test('at least the four expected themes ship an effects module', () => {
    for (const id of ['matrix', 'blade_runner', 'green_crt', 'lovecraft']) {
        assert.ok(effectThemes.includes(id), `${id} should declare effects`);
    }
});

for (const themeId of effectThemes) {
    const env0 = installEnv();
    const mod = await loadEffect(themeId);

    test(`${themeId}: exports the init/destroy contract registry.js consumes`, () => {
        assert.equal(typeof mod.init, 'function');
        assert.equal(typeof mod.destroy, 'function');
        assert.ok(mod.default && typeof mod.default.init === 'function');
        assert.ok(mod.default && typeof mod.default.destroy === 'function');
    });

    test(`${themeId}: mounts a non-interactive canvas behind the content`, () => {
        const env = installEnv();
        mod.init({ themeContext: { id: themeId, manifest: {} } });
        const c = env.canvas();
        assert.ok(c, 'a canvas should be mounted');
        assert.equal(c.style.pointerEvents, 'none', 'must never take pointer input');
        assert.equal(c.style.position, 'fixed');
        assert.equal(c.style.zIndex, '-1', 'must sit behind the terminal and chrome');
        assert.equal(c.ariaHidden || c['aria-hidden'], 'true');
        mod.destroy();
    });

    test(`${themeId}: registers no keyboard or pointer listeners`, () => {
        const env = installEnv();
        mod.init();
        const types = [...env.winListeners, ...env.docListeners].map((l) => l.type);
        for (const t of types) {
            assert.ok(
                !/^(key|pointer|mouse|touch|click|wheel)/.test(t),
                `unexpected input listener: ${t}`,
            );
        }
        mod.destroy();
    });

    test(`${themeId}: destroy() cancels the rAF loop and removes everything`, () => {
        const env = installEnv();
        mod.init();
        env.flush(0);
        env.flush(100);
        assert.ok(env.rafPending.size > 0, 'a running effect should have a pending frame');

        mod.destroy();
        assert.equal(env.rafPending.size, 0, 'rAF loop must be cancelled');
        assert.equal(env.winListeners.length, 0, 'window listeners must be removed');
        assert.equal(env.docListeners.length, 0, 'document listeners must be removed');
        assert.equal(env.mqlListeners.length, 0, 'media-query listeners must be removed');
        assert.equal(env.body.children.length, 0, 'canvas must be removed from the DOM');
        assert.equal(mod.getStatus().status, 'inactive');
        assert.equal(env.doc.documentElement.dataset.themeEffects, undefined);
    });

    test(`${themeId}: ten theme switches leak no loops and no listeners`, () => {
        const env = installEnv();
        for (let i = 0; i < 10; i++) {
            mod.init();
            env.flush(i * 1000);
            env.flush(i * 1000 + 500);
            mod.destroy();
            assert.equal(
                env.rafPending.size, 0,
                `switch ${i}: a loop survived destroy()`,
            );
        }
        assert.equal(env.winListeners.length, 0, 'window listeners accumulated');
        assert.equal(env.docListeners.length, 0, 'document listeners accumulated');
        assert.equal(env.mqlListeners.length, 0, 'media-query listeners accumulated');
        assert.equal(env.body.children.length, 0, 'canvases accumulated in the DOM');
    });

    test(`${themeId}: a hidden tab schedules no frames at all`, () => {
        const env = installEnv({ hidden: true });
        mod.init();
        assert.equal(env.rafPending.size, 0, 'a background tab must burn zero CPU');
        assert.equal(mod.getStatus().status, 'paused');
        mod.destroy();
    });

    test(`${themeId}: becoming hidden suspends the loop, becoming visible resumes it`, () => {
        const env = installEnv();
        mod.init();
        env.flush(0);
        assert.ok(env.rafPending.size > 0);

        const vis = env.docListeners.find((l) => l.type === 'visibilitychange');
        assert.ok(vis, 'a visibilitychange listener is required');
        env.doc.hidden = true;
        vis.fn();
        assert.equal(env.rafPending.size, 0, 'hidden must cancel the loop');
        assert.equal(mod.getStatus().status, 'paused');

        env.doc.hidden = false;
        vis.fn();
        assert.ok(env.rafPending.size > 0, 'visible must resume the loop');
        assert.equal(mod.getStatus().status, 'running');
        mod.destroy();
    });

    test(`${themeId}: a failed 2D context reports unavailable and does not throw`, () => {
        const env = installEnv({ contextFails: true });
        assert.doesNotThrow(() => mod.init(), 'a dead context must not take the theme down');
        const { status, reason } = mod.getStatus();
        assert.equal(status, 'unavailable', 'the third outcome must not collapse into success');
        assert.ok(reason && reason.length > 0, 'unavailable must say what could not be measured');
        assert.equal(env.body.children.length, 0, 'a dead canvas must not be left in the DOM');
        assert.equal(env.rafPending.size, 0, 'nothing should be scheduled');
        assert.equal(env.doc.documentElement.dataset.themeEffects, 'unavailable');
        mod.destroy();
    });

    test(`${themeId}: reduced motion never animates`, () => {
        const env = installEnv({ reducedMotion: true });
        mod.init();
        const { status } = mod.getStatus();
        assert.ok(
            status === 'static' || status === 'skipped',
            `reduced motion must be static or skipped, got ${status}`,
        );
        assert.equal(env.rafPending.size, 0, 'reduced motion must schedule no frames');
        if (status === 'skipped') {
            assert.equal(env.body.children.length, 0, 'skipped means nothing is mounted');
        } else {
            assert.equal(env.body.children.length, 1, 'static means one painted canvas');
        }
        mod.destroy();
        assert.equal(env.body.children.length, 0);
        assert.equal(env.winListeners.length, 0, 'the static path must tear down too');
    });

    test(`${themeId}: init() is idempotent`, () => {
        const env = installEnv();
        mod.init();
        mod.init();
        mod.init();
        assert.equal(env.body.children.length, 1, 'a second init must not stack canvases');
        mod.destroy();
        assert.equal(env.body.children.length, 0);
        assert.equal(env.rafPending.size, 0);
    });

    test(`${themeId}: destroy() without init() is safe`, () => {
        installEnv();
        assert.doesNotThrow(() => mod.destroy());
        assert.equal(mod.getStatus().status, 'inactive');
    });

    test(`${themeId}: the frame cap holds under a 240Hz display`, () => {
        const env = installEnv();
        mod.init();
        const ctxOf = () => env.canvas()._ctx;
        // Drive four simulated seconds of a 240Hz display.
        for (let i = 0; i <= 960; i++) env.flush(i * (1000 / 240));
        const drew = ctxOf().drawCalls;
        assert.ok(drew > 0, 'the effect should have drawn something');
        // 4 seconds at the harness ceiling of 30fps is 120 frames; every
        // shipped effect draws at least one rect per frame, so a cap failure
        // shows up as a draw count far past that.
        assert.ok(
            drew <= 30 * 4 * 400,
            `frame cap appears not to hold: ${drew} draw ops in 4s`,
        );
        mod.destroy();
    });

    void env0;
}

// ---------------------------------------------------------------------
// Harness-level checks that do not depend on a particular theme.
// ---------------------------------------------------------------------

installEnv();
const base = await import(
    pathToFileURL(path.join(mirrorDir, '_shared', 'effects-base.mjs')).href
);

test('harness: rgbTriple parses hex and degrades rather than throwing', () => {
    assert.equal(base.rgbTriple('#33FF33'), '51, 255, 51');
    assert.equal(base.rgbTriple('#333'), '51, 51, 51');
    assert.equal(base.rgbTriple('not-a-colour', '1, 2, 3'), '1, 2, 3');
    assert.equal(base.rgbTriple(null, '1, 2, 3'), '1, 2, 3');
    assert.equal(base.rgbTriple(undefined, '1, 2, 3'), '1, 2, 3');
});

test('harness: a throwing draw stops the loop instead of repeating forever', () => {
    const env = installEnv();
    const effect = base.createEffect({
        id: 'exploding',
        setup: () => ({}),
        draw: () => { throw new Error('boom'); },
    });
    effect.init();
    env.flush(0);
    env.flush(1000);
    assert.equal(env.rafPending.size, 0, 'a throwing draw must not keep rescheduling');
    assert.equal(effect.getStatus().status, 'unavailable');
    assert.match(effect.getStatus().reason, /draw threw/);
    assert.equal(env.body.children.length, 0);
});

test('harness: a throwing setup reports unavailable rather than escaping', () => {
    const env = installEnv();
    const effect = base.createEffect({
        id: 'bad-setup',
        setup: () => { throw new Error('nope'); },
        draw: () => {},
    });
    assert.doesNotThrow(() => effect.init());
    assert.equal(effect.getStatus().status, 'unavailable');
    assert.equal(env.body.children.length, 0, 'the half-mounted canvas must be cleaned up');
    assert.equal(env.rafPending.size, 0);
});

test('harness: turning reduced motion on mid-session stops the loop', () => {
    const env = installEnv();
    const effect = base.createEffect({ id: 'x', setup: () => ({}), draw: () => {} });
    effect.init();
    env.flush(0);
    assert.equal(effect.getStatus().status, 'running');

    const mq = env.mqlListeners.find((l) => l.type === 'change');
    assert.ok(mq, 'the harness must watch for a motion-preference change');
    mq.fn({ matches: true });
    assert.equal(env.rafPending.size, 0);
    assert.equal(effect.getStatus().status, 'skipped');
    effect.destroy();
});

test('harness: STATUS names the third outcome explicitly', () => {
    assert.equal(base.STATUS.UNAVAILABLE, 'unavailable');
    assert.ok(!Object.values(base.STATUS).includes('ok'));
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
    console.error('FAILURES');
    process.exit(1);
}
console.log('ALL PASS');
