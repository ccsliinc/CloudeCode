// Node-based tests for client/js/status-led.js and its stylesheet.
//
// WHY THIS FILE EXISTS. The LED is the indicator every surface in the app
// renders its session state through, so a defect here is a defect in the
// sidebar, the launchpad, the project tree and the terminal header at
// once. Three properties are worth pinning:
//
//   1. THE TWO DIMENSIONS ARE INDEPENDENT. Every (inner, outer) pair must
//      render, because that is what makes a gallery able to enumerate the
//      matrix and what stops one ring's value from being derived from the
//      other's.
//   2. NOTHING FALLS THROUGH TO AN UNSTYLED OR UNLABELLED LED. A stale
//      cached API response carrying a state this client has never heard of
//      must still produce a labelled element, and it must land on
//      `unknown`/`dim` rather than on a state that claims a measurement.
//   3. `unknown` IS NOT `done`. The single most repeated defect class in
//      this project is a not-measured value rendering as a measured one.
//
// The stylesheet assertions are deliberately here rather than in a manual
// harness: `prefers-reduced-motion` support and the existence of a colour
// rule per inner state are both things a refactor can silently drop, and
// both are checkable as text.
//
// Run with: node tests/test_status_led.node.mjs
// Exits 0 and prints "ALL PASS" on success; exits 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passes = 0;
const queue = [];

/** Queue one named assertion block. Inputs: name, fn. Output: void. */
function test(name, fn) {
    queue.push([name, fn]);
}

/** Run every queued test in order. Inputs: none. Output: Promise<void>. */
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
 * Load status-led.js in a bare sandbox.
 *
 * The module's whole contract is that it needs no DOM and no globals, so
 * the sandbox deliberately provides neither a document nor a window - if
 * a future edit reaches for one, this loader throws and the test fails,
 * which is the point.
 * Inputs: none. Output: object - the StatusLed api.
 */
function loadLed() {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'js', 'status-led.js'),
        'utf8',
    );
    const context = { console };
    vm.createContext(context);
    vm.runInContext(src, context);
    return context.StatusLed;
}

const Led = loadLed();

const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'css', 'status-led.css'),
    'utf8',
);

/**
 * Re-create a value in THIS realm.
 *
 * status-led.js is evaluated inside a `vm` context, so every array and
 * object it returns carries that realm's Object.prototype. `assert/strict`
 * compares prototypes, so a structurally identical value from the sandbox
 * fails deepEqual against a literal written here. Round-tripping through
 * JSON strips the foreign prototype and compares the data, which is the
 * only thing these assertions are about.
 * Inputs: value (any) - JSON-serialisable. Output: any.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Pull one attribute's raw value out of generated markup.
 * Inputs: html (string); attr (string). Output: string|null.
 */
function rawAttr(html, attr) {
    const start = html.indexOf(`${attr}="`);
    if (start === -1) return null;
    const from = start + attr.length + 2;
    const end = html.indexOf('"', from);
    if (end === -1) return null;
    return html.slice(from, end);
}

// ---- the vocabularies -------------------------------------------------

test('both vocabularies are exported and non-empty', () => {
    assert.ok(Array.isArray(Led.INNER_STATES) && Led.INNER_STATES.length > 0);
    assert.ok(Array.isArray(Led.OUTER_STATES) && Led.OUTER_STATES.length > 0);
});

test('the inner vocabulary is exactly the six documented states', () => {
    assert.deepEqual(plain(Led.INNER_STATES), [
        'working',
        'waiting-permission',
        'waiting-input',
        'done',
        'dead',
        'unknown',
    ]);
});

test('the outer vocabulary is exactly the five documented states', () => {
    assert.deepEqual(plain(Led.OUTER_STATES), [
        'active',
        'steady',
        'unread',
        'off',
        'dim',
    ]);
});

test('the exported vocabularies are copies, so a caller cannot mutate them', () => {
    // Mutate a SEPARATE instance: poisoning the shared `Led` here would
    // silently corrupt every test queued after this one, which is exactly
    // the class of defect this assertion exists to prevent.
    const victim = loadLed();
    victim.INNER_STATES.push('bogus');
    const fresh = loadLed();
    assert.ok(fresh.INNER_STATES.indexOf('bogus') === -1);
});

// ---- markup per state -------------------------------------------------

test('every inner x outer combination renders a labelled LED', () => {
    for (const inner of plain(Led.INNER_STATES)) {
        for (const outer of plain(Led.OUTER_STATES)) {
            const html = Led.ledHtml({ inner, outer });
            assert.equal(rawAttr(html, 'data-inner'), inner, `inner ${inner}`);
            assert.equal(rawAttr(html, 'data-outer'), outer, `outer ${outer}`);
            assert.ok(html.includes('class="status-led"'), 'carries the class');
            assert.ok(html.includes('role="img"'), 'is a meaningful glyph');
            const label = rawAttr(html, 'aria-label');
            assert.ok(label && label.length > 0, `labelled: ${inner}/${outer}`);
            assert.equal(rawAttr(html, 'title'), label, 'title matches aria-label');
        }
    }
});

test('an unknown inner or outer value is clamped, never emitted raw', () => {
    const html = Led.ledHtml({ inner: 'banana', outer: 'kumquat' });
    assert.equal(rawAttr(html, 'data-inner'), 'unknown');
    assert.equal(rawAttr(html, 'data-outer'), 'dim');
});

test('no arguments at all still renders a valid not-measured LED', () => {
    const html = Led.ledHtml();
    assert.equal(rawAttr(html, 'data-inner'), 'unknown');
    assert.equal(rawAttr(html, 'data-outer'), 'dim');
});

test('ledHtml escapes a hostile title rather than interpolating it raw', () => {
    const html = Led.ledHtml({ inner: 'done', outer: 'steady', title: '"><img src=x>' });
    assert.ok(!html.includes('<img'), 'no tag escapes into the markup');
    assert.ok(html.includes('&quot;'), 'the quote is entity-encoded');
});

test('size is accepted only as a plain CSS length', () => {
    assert.ok(Led.ledHtml({ size: '18px' }).includes('--led-size: 18px'));
    assert.ok(Led.ledHtml({ size: '1.5rem' }).includes('--led-size: 1.5rem'));
    // Anything else is dropped, not sanitised - an allowlist is the only
    // version of "a value lands in a style attribute" worth reasoning about.
    assert.ok(!Led.ledHtml({ size: 'red; background:url(x)' }).includes('style='));
    assert.ok(!Led.ledHtml({ size: 12 }).includes('style='));
});

test('extraClass is accepted only as plain class names', () => {
    const ok = Led.ledHtml({ extraClass: 'status-dot status-dot--dead' });
    assert.ok(ok.includes('class="status-dot status-dot--dead status-led"'));
    const bad = Led.ledHtml({ extraClass: '" onload="x' });
    assert.ok(bad.includes('class="status-led"'), 'rejected, not escaped in');
});

// ---- the mapping from server signals ----------------------------------

test('dead outranks everything, and a corpse never glows', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'dead', unread: true })), {
        inner: 'dead',
        outer: 'off',
    });
    // `stopped` is a session that is GONE rather than a held-open corpse,
    // but it is equally not something to go and read.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'stopped', unread: true })), {
        inner: 'dead',
        outer: 'off',
    });
});

test('a startup prompt is waiting-input even when the status says nothing', () => {
    assert.deepEqual(
        plain(Led.ledStateFor({
            activity_status: 'idle',
            startup_gate: 'awaiting_startup_prompt',
        })),
        { inner: 'waiting-input', outer: 'active' },
    );
});

test('a startup gate that could not be measured does not claim anything', () => {
    // `unknown` is a legal startup_gate value and must not be read as
    // `awaiting`. Not having looked is not evidence of a prompt.
    assert.deepEqual(
        plain(Led.ledStateFor({ activity_status: 'idle', startup_gate: 'unknown' })),
        { inner: 'done', outer: 'steady' },
    );
});

test('question maps to waiting-input', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'question' })), {
        inner: 'waiting-input',
        outer: 'active',
    });
});

test('working and working_subagent share the inner dot', () => {
    assert.equal(Led.ledStateFor({ activity_status: 'working' }).inner, 'working');
    assert.equal(
        Led.ledStateFor({ activity_status: 'working_subagent' }).inner,
        'working',
    );
});

test('the legacy `running` spelling still maps to working', () => {
    // A stale cached response from a pre-hook-era server. Mapping it keeps
    // a half-upgraded deployment meaningful instead of grey.
    assert.equal(Led.ledStateFor({ activity_status: 'running' }).inner, 'working');
});

test('unread rides the HALO independently of the inner dot', () => {
    // This is the whole reason there are two rings: the old single dot
    // could not say "working, and also unread" at all.
    const busy = Led.ledStateFor({ activity_status: 'working', unread: true });
    assert.equal(busy.inner, 'working', 'still working');
    assert.equal(busy.outer, 'unread', 'and still wants attention');

    const rested = Led.ledStateFor({ activity_status: 'idle', unread: true });
    assert.deepEqual(plain(rested), { inner: 'done', outer: 'unread' });
});

test('idle and seen is a steady done', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'idle' })), {
        inner: 'done',
        outer: 'steady',
    });
});

test('finished_unread is done plus an unread halo', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'finished_unread' })), {
        inner: 'done',
        outer: 'unread',
    });
});

test('UNKNOWN IS NOT DONE - the false green this project keeps paying for', () => {
    assert.equal(Led.ledStateFor({ activity_status: 'unknown' }).inner, 'unknown');
    assert.equal(Led.ledStateFor({}).inner, 'unknown');
    assert.equal(Led.ledStateFor(null).inner, 'unknown');
    assert.equal(Led.ledStateFor({ activity_status: 'a-state-from-2030' }).inner, 'unknown');
});

test('an unread session that could not be measured still shows the halo', () => {
    // The measurement failed; the fact that something is waiting did not.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'unknown', unread: true })), {
        inner: 'unknown',
        outer: 'unread',
    });
});

// ---- the stylesheet ---------------------------------------------------

test('every inner state has a colour rule', () => {
    for (const inner of plain(Led.INNER_STATES)) {
        assert.ok(
            CSS.includes(`[data-inner='${inner}']`),
            `no rule for inner state ${inner}`,
        );
    }
});

test('every outer state has a rule', () => {
    for (const outer of plain(Led.OUTER_STATES)) {
        assert.ok(
            CSS.includes(`[data-outer='${outer}']`),
            `no rule for outer state ${outer}`,
        );
    }
});

test('the five state colours are named tokens in one place', () => {
    for (const token of [
        '--led-color-working',
        '--led-color-waiting',
        '--led-color-done',
        '--led-color-dead',
        '--led-color-unknown',
        '--led-color-unread',
    ]) {
        const declarations = CSS.split(`${token}:`).length - 1;
        assert.equal(declarations, 1, `${token} must be declared exactly once`);
    }
});

test('only the two breathing states animate, and only on the halo', () => {
    // The dot itself must never animate: the state colour has to stay at
    // full strength and legible at every point in the cycle.
    assert.ok(CSS.includes("[data-outer='active']::after"));
    assert.ok(CSS.includes("[data-outer='unread']::after"));
    // The `.status-dot.status-led` compat block sets `animation: none`,
    // which is a reset and not motion, so the check is anchored to a rule
    // whose selector is the bare component at the start of a line.
    assert.ok(
        !/^\.status-led\s*\{[^}]*animation:\s*(?!none)/m.test(CSS),
        'the dot itself must not carry a running animation',
    );
});

test('done is steady - it has no animation', () => {
    const block = CSS.split("[data-outer='steady']")[1].split('}')[0];
    assert.ok(!block.includes('animation'), 'steady must not pulse');
});

test('dead has no halo at all, rather than a dim one', () => {
    const block = CSS.split("[data-outer='off']")[1].split('}')[0];
    assert.ok(block.includes('--led-halo-opacity: 0'), 'a corpse must not glow');
});

test('prefers-reduced-motion kills the pulse but keeps the glow', () => {
    assert.ok(CSS.includes('@media (prefers-reduced-motion: reduce)'));
    const block = CSS.split('@media (prefers-reduced-motion: reduce)')[1];
    assert.ok(block.includes('animation: none'), 'no motion');
    // The glow must survive: it is what makes the LED readable, and the
    // active/resting distinction moves entirely into opacity.
    assert.ok(
        block.includes('opacity: var(--led-halo-opacity)'),
        'the halo stays lit at its full value',
    );
});

test('the breathing period is about two seconds, as specified', () => {
    assert.ok(CSS.includes('status-led-breathe 2s ease-in-out infinite'));
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
