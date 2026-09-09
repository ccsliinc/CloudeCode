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
 * The stylesheet with every `/* ... *\/` comment removed.
 *
 * This file is heavily commented and several of those comments name the
 * very properties the structural assertions below forbid - the block
 * explaining WHY the referee may not reset `box-shadow` contains the
 * string `box-shadow`, and the one explaining why nothing may move the
 * element contains `inset:`. Matching against the raw text makes those
 * explanations fail their own tests, so anything asserting "this
 * property does not appear" reads RULES instead. Assertions about a
 * specific declaration's text may use either.
 * @type {string}
 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

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

test('the inner vocabulary is exactly the seven documented states', () => {
    assert.deepEqual(plain(Led.INNER_STATES), [
        'working',
        'waiting-permission',
        'waiting-input',
        'idle',
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
        { inner: 'idle', outer: 'off' },
    );
});

test('question maps to waiting-permission - the agent is stopped', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'question' })), {
        inner: 'waiting-permission',
        outer: 'active',
    });
});

test('notice maps to waiting-input - it wants you but is not blocked', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'notice' })), {
        inner: 'waiting-input',
        outer: 'active',
    });
});

test('question and notice do not paint the same inner dot', () => {
    // The whole point of the 2026-09-08 split. If these ever converge,
    // the server distinction stops reaching the only surface that
    // matters - the light.
    assert.notEqual(
        Led.ledStateFor({ activity_status: 'question' }).inner,
        Led.ledStateFor({ activity_status: 'notice' }).inner,
    );
});

test('a startup prompt and a notice share waiting-input', () => {
    // Both mean "come and look"; neither means "approve this".
    assert.equal(
        Led.ledStateFor({
            activity_status: 'idle',
            startup_gate: 'awaiting_startup_prompt',
        }).inner,
        Led.ledStateFor({ activity_status: 'notice' }).inner,
    );
});

test('an unread flag never downgrades a blocking permission prompt', () => {
    // The halo is where unread lives; it may not overwrite the dot that
    // says the agent is stopped.
    assert.deepEqual(
        plain(Led.ledStateFor({ activity_status: 'question', unread: true })),
        { inner: 'waiting-permission', outer: 'active' },
    );
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

test('idle and seen is its OWN gray dot, at rest with no ring at all', () => {
    // 2026-09-09: idle used to share `done`'s green fill and only the
    // outer ring moved when a session was read - too subtle to register.
    // It now gets a distinct inner state, and pairs with outer `off` so
    // opening a tab reads as visibly calmer, not just differently haloed.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'idle' })), {
        inner: 'idle',
        outer: 'off',
    });
});

test('idle is not done, and not unknown either', () => {
    // The whole point of the split: a MEASURED at-rest session must not
    // collapse onto the "finished, unread" green or the "never measured"
    // grey - it is its own answer.
    const idle = Led.ledStateFor({ activity_status: 'idle' });
    assert.notEqual(idle.inner, 'done');
    assert.notEqual(idle.inner, 'unknown');
    assert.equal(idle.inner, 'idle');
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


// ---- ONE ELEMENT, and why -----------------------------------------------
//
// The owner's report, twice. First: "the leds are not lined up directly
// centered so there is a weird offset." That was traced to the halo's own
// internal asymmetry - a `top`/`left` percentage plus a negative margin
// plus a separate width calc, three independently-rounded quantities that
// all had to agree - and fixed by giving the halo a single symmetric
// `inset`. Then, after that shipped: "the circles are still not lining up
// properly. can we do the same with only one icon?"
//
// The remaining drift was never inside the halo. It was BETWEEN TWO
// BOXES. The layout engine snaps a box's position and size to the device
// pixel grid, and it does that for the halo's box independently of the
// dot's, so whenever the dot landed on a fractional x/y - routine inside
// a flex row, or wherever a text baseline puts an inline box on a half
// pixel - the two rounded different ways and came apart. No arrangement
// of a second box can fix that, because the second box is the defect.
//
// A box-shadow is not a box. It is painted from the element's own border
// box at that box's own subpixel position, so it cannot be snapped to a
// different grid than the fill it surrounds. These tests pin the shape of
// that fix: no pseudo-element, one box-shadow, and nothing in the
// animation that can move the element.

test('the halo pseudo-element is gone entirely', () => {
    // The whole point of the rewrite. A ::after on this component is a
    // second box, and a second box is the drift.
    assert.ok(
        !RULES.includes('.status-led::after'),
        'no ::after rule may remain on the LED - that is the two-box defect',
    );
    assert.ok(
        !RULES.includes('::before'),
        'and no ::before either - one element means one box',
    );
});

test('the ring and the glow are layers of ONE box-shadow on the element', () => {
    const base = RULES.split('\n.status-led {')[1].split('\n}')[0];
    const shadowDeclarations = base.split('box-shadow:').length - 1;
    assert.equal(
        shadowDeclarations,
        1,
        'the base rule must declare box-shadow exactly once',
    );
    assert.ok(
        base.includes(
            'box-shadow: var(--led-inset-ring), var(--led-ring-layer), var(--led-ring-feather-layer),\n' +
                '        var(--led-glow-layer);',
        ),
        'the one declaration must be the four named layers, in paint order',
    );
});

test('the hard ring is a zero-blur spread shadow, so its outer edge is exact', () => {
    // `0 0 0 <width>` puts the ring's outer diameter at exactly
    // size + 2 * width with no blur to soften where it lands. At the 9px
    // default that is an integer, 12px (2026-09-09: was 11px at the
    // former 1px width), so the ring's edge sits on the pixel grid
    // whenever the dot's does.
    assert.ok(
        /--led-ring-layer:\s*0 0 0 var\(--led-ring-width\)/.test(CSS),
        'the ring layer must be 0 0 0 <ring-width>, not a blurred shadow',
    );
    const widthMatch = CSS.match(/--led-ring-width:\s*([\d.]+)px;/);
    assert.ok(widthMatch, '--led-ring-width must be a plain px value');
    const width = Number(widthMatch[1]);
    assert.equal(width, 1.5, '2026-09-09: the ring widened from 1px to 1.5px, per the owner\'s ask');
    const size = 9;
    const ringDiameter = size + 2 * width;
    assert.ok(
        ringDiameter > size && ringDiameter <= size + 4,
        `ring diameter ${ringDiameter}px must read as a little larger than the ${size}px dot, per the owner's calibration`,
    );
    assert.ok(
        Number.isInteger(ringDiameter),
        'the ring diameter must be an integer at the 9px default so it cannot land off-grid',
    );
});

test('the ring edge is feathered by a second, blurred layer at the same spread', () => {
    // 2026-09-09, owner's ask: "can we feather it". A hard `0 0 0 <width>`
    // shadow alone has a knife-edge; the feather is a second shadow at the
    // SAME spread as the hard ring (so it sits exactly on the ring's own
    // edge) with a small blur and a fraction of the ring's alpha.
    assert.ok(
        /--led-ring-feather-layer:\s*0 0 var\(--led-ring-feather-blur\) var\(--led-ring-width\)/.test(
            CSS,
        ),
        'the feather layer must share the ring\'s own spread, blurred',
    );
    assert.ok(
        CSS.includes(
            'color-mix(\n            in srgb,\n            var(--led-ring-ink) calc(var(--led-ring-alpha) * var(--led-ring-feather-fraction)),\n            transparent\n        )',
        ),
        'the feather alpha must be a FRACTION of the ring alpha, so it zeroes automatically with the ring',
    );
    const blurMatch = CSS.match(/--led-ring-feather-blur:\s*([\d.]+)px;/);
    const fractionMatch = CSS.match(/--led-ring-feather-fraction:\s*([\d.]+);/);
    assert.ok(blurMatch, '--led-ring-feather-blur must be a plain px value');
    assert.ok(fractionMatch, '--led-ring-feather-fraction must be a plain unitless value');
    const fraction = Number(fractionMatch[1]);
    assert.ok(fraction > 0 && fraction < 1, `feather fraction ${fraction} must be a real fraction, not the whole ring or none of it`);
});

test('the whole ring apparatus (hard ring plus feather) stays within about 4px of the dot', () => {
    // The owner's budget: "a little larger", not a second halo. The
    // feather shares the ring's own spread, so its visible influence
    // reaches spread + blur/2 past the border box - the same formula the
    // glow uses - and that is what must not blow past the ceiling, not
    // the ring width taken alone.
    const width = Number(CSS.match(/--led-ring-width:\s*([\d.]+)px;/)[1]);
    const featherBlur = Number(CSS.match(/--led-ring-feather-blur:\s*([\d.]+)px;/)[1]);
    const reach = width + featherBlur / 2;
    assert.ok(
        reach <= 4,
        `the ring's feathered edge reaches ${reach}px past the dot, over the owner's ~4px ceiling`,
    );
});

test('the soft glow is a blurred layer with its own blur and spread tokens', () => {
    assert.ok(
        /--led-glow-layer:\s*0 0 var\(--led-glow-blur\) var\(--led-glow-spread\)/.test(
            CSS,
        ),
        'the glow layer must be 0 0 <blur> <spread>',
    );
    const blurMatch = CSS.match(/--led-glow-blur:\s*([\d.]+)px;/);
    const spreadMatch = CSS.match(/--led-glow-spread:\s*([\d.]+)px;/);
    assert.ok(blurMatch && spreadMatch, 'both glow tokens must be plain px values');
    assert.equal(
        Number(blurMatch[1]),
        6,
        '2026-09-09: the glow blur rose from 4px to 6px so the halo reads softer, spread held fixed',
    );
    assert.equal(Number(spreadMatch[1]), 1.5, 'the glow spread must stay fixed - only the blur rose');
    // A blurred shadow reaches spread + blur/2 past the border box. The
    // ::after era reached 16.2px across at the 9px default; the
    // 2026-09-09 feathering round raised the ceiling to 18px (blur
    // 4px -> 6px, spread unchanged) as an accepted, documented cost of
    // the softer edge - not a silent regrowth.
    const reach = Number(spreadMatch[1]) + Number(blurMatch[1]) / 2;
    const litDiameter = 9 + 2 * reach;
    assert.ok(
        litDiameter <= 18,
        `lit object ${litDiameter}px must not exceed the 18px the 2026-09-09 feathering round settled on`,
    );
});

test('alpha lives in the shadow colour, never in element opacity', () => {
    // One element cannot carry an `opacity` for its ring without fading
    // the state colour at the centre too. Every alpha is mixed into the
    // shadow's own colour instead.
    assert.ok(
        !/^\s*opacity:/m.test(RULES),
        'no rule may set opacity on the LED - it would fade the fill as well as the ring',
    );
    assert.ok(
        CSS.includes('color-mix(in srgb, var(--led-ring-ink) var(--led-ring-alpha), transparent)'),
        'the ring alpha must be mixed into the ring colour',
    );
    assert.ok(
        CSS.includes('color-mix(in srgb, var(--led-ring-ink) var(--led-glow-alpha), transparent)'),
        'the glow alpha must be mixed into the glow colour',
    );
});

test('the hollow unknown rim is a shadow LAYER, not a second box-shadow declaration', () => {
    // There is one box-shadow property on this element and the outer ring
    // needs it. An inner-state rule declaring its own would erase the
    // outer ring for that state, and the two dimensions would stop being
    // independent - the invariant this whole component exists to hold.
    const unknownBlock = RULES.split(".status-led[data-inner='unknown'] {")[1].split(
        '\n}',
    )[0];
    assert.ok(
        !unknownBlock.includes('box-shadow:'),
        'the unknown rule must not declare box-shadow',
    );
    assert.ok(
        unknownBlock.includes('--led-inset-ring: inset 0 0 0 var(--led-hollow-width)'),
        'it must set the inset layer instead',
    );
    assert.ok(
        CSS.includes('--led-inset-ring: inset 0 0 0 0 transparent;'),
        'and the default must be a no-op inset layer, so the list length never changes',
    );
});

test('the legacy referee no longer resets box-shadow, which would erase every ring', () => {
    // That reset was correct while the ring lived on a pseudo-element. Now
    // that the ring is ON the element, `.status-dot.status-led` is two
    // classes and therefore beats every rule above it - a `box-shadow:
    // none` here would blank the outer ring on every LED in the app.
    const refereeBlocks = RULES.split('.status-dot.status-led');
    for (let i = 1; i < refereeBlocks.length; i++) {
        const block = refereeBlocks[i].split('\n}')[0];
        assert.ok(
            !block.includes('box-shadow'),
            'no .status-dot.status-led rule may touch box-shadow',
        );
    }
});

test('the referee animation reset excludes the two breathing states', () => {
    // A blanket `.status-dot.status-led { animation: none }` is (0,2,0),
    // ties with the breathing rule and wins on source order, silently
    // killing the pulse for every LED in the app. Excluding the two
    // states makes it order-independent.
    assert.ok(
        CSS.includes(
            ".status-dot.status-led:not([data-outer='active']):not([data-outer='unread']) {",
        ),
        'the legacy animation reset must be scoped off the breathing states',
    );
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

test('idle has its own fill token, distinct from both unknown and done', () => {
    const idleBlock = RULES.split(".status-led[data-inner='idle'] {")[1].split(
        '\n}',
    )[0];
    assert.ok(
        idleBlock.includes('--led-ink: var(--led-color-idle)'),
        'idle must resolve to its own colour token, not reuse done or unknown',
    );
    assert.ok(
        !idleBlock.includes('var(--led-color-done)'),
        'idle must not fall back to the done colour',
    );
    assert.ok(
        !idleBlock.includes('var(--led-color-unknown)'),
        'idle must not fall back to the unknown colour',
    );
    // The two greys must actually be different values, or the "own
    // colour token" is cosmetic. Compared as the literal fallback behind
    // each var(), since that is what a themeless context resolves to.
    const idleFallback = CSS.match(/--led-color-idle:\s*var\([^,]+,\s*([^)]+)\)/)[1].trim();
    const unknownFallback = CSS.match(/--led-color-unknown:\s*var\([^,]+,\s*([^)]+)\)/)[1].trim();
    assert.notEqual(
        idleFallback,
        unknownFallback,
        'idle and unknown must not resolve to the same literal grey',
    );
});

test('idle stays a SOLID dot - unknown is the only hollow one', () => {
    const idleBlock = RULES.split(".status-led[data-inner='idle'] {")[1].split(
        '\n}',
    )[0];
    assert.ok(
        !idleBlock.includes('background-color: transparent'),
        'idle must not go hollow - that shape is reserved for unknown',
    );
    assert.ok(
        !idleBlock.includes('--led-inset-ring:'),
        'idle must not set the hollow-rim layer',
    );
});

test('idle renders through ledHtml with outer off and shows no lit ring', () => {
    // The owner's ask: clicking a tab should read as calm, at-rest grey -
    // no ring, no glow. Rendered through the real ledStateFor -> ledHtml
    // chain, not asserted as a fact about the mapping alone.
    const state = Led.ledStateFor({ activity_status: 'idle' });
    assert.deepEqual(plain(state), { inner: 'idle', outer: 'off' });
    const offBlock = RULES.split(".status-led[data-outer='off'] {")[1].split(
        '\n}',
    )[0];
    assert.ok(offBlock.includes('--led-ring-alpha: 0%'), 'idle\'s outer ring must be fully off');
    assert.ok(offBlock.includes('--led-glow-alpha: 0%'), 'idle\'s glow must be fully off');
});

test('every outer state has a rule, and every one of them sets the ring', () => {
    for (const outer of plain(Led.OUTER_STATES)) {
        assert.ok(
            CSS.includes(`[data-outer='${outer}']`),
            `no rule for outer state ${outer}`,
        );
        const block = RULES.split(`.status-led[data-outer='${outer}'] {`)[1].split(
            '\n}',
        )[0];
        assert.ok(
            block.includes('--led-ring-alpha:'),
            `outer state ${outer} must say how solid its ring reads`,
        );
        assert.ok(
            block.includes('--led-glow-alpha:'),
            `outer state ${outer} must say how strong its glow reads`,
        );
    }
});

test('the state colours are named tokens in one place', () => {
    for (const token of [
        '--led-color-working',
        '--led-color-waiting',
        '--led-color-permission',
        '--led-color-done',
        '--led-color-idle',
        '--led-color-dead',
        '--led-color-unknown',
        '--led-color-unread',
    ]) {
        const declarations = CSS.split(`${token}:`).length - 1;
        assert.equal(declarations, 1, `${token} must be declared exactly once`);
    }
});

test('the retired halo tokens are gone, not left behind as dead weight', () => {
    // --led-halo-scale sized a box that no longer exists, and
    // --led-halo-inset positioned it. A token nothing reads is a false
    // lead for the next person tuning this component.
    for (const token of [
        '--led-halo-scale',
        '--led-halo-inset',
        '--led-halo-ink',
        '--led-halo-opacity',
    ]) {
        assert.ok(!RULES.includes(token), `${token} must be retired with the halo box`);
    }
});

test('only the two breathing states animate, and the animation is on the element', () => {
    assert.ok(CSS.includes(".status-led[data-outer='active'],"));
    assert.ok(CSS.includes(".status-led[data-outer='unread'] {"));
    // The base rule must not carry a running animation - a resting LED
    // holds still.
    assert.ok(
        !/^\.status-led\s*\{[^}]*animation:\s*(?!none)/m.test(RULES),
        'the base rule must not carry a running animation',
    );
});

test('done is steady - it has no animation', () => {
    const block = RULES.split(".status-led[data-outer='steady'] {")[1].split('\n}')[0];
    assert.ok(!block.includes('animation'), 'steady must not pulse');
});

test('dead has no ring and no glow at all, rather than dim ones', () => {
    const block = RULES.split(".status-led[data-outer='off'] {")[1].split('\n}')[0];
    assert.ok(block.includes('--led-ring-alpha: 0%'), 'a corpse must not ring');
    assert.ok(block.includes('--led-glow-alpha: 0%'), 'a corpse must not glow');
    // And it must go transparent rather than `box-shadow: none`, which
    // would take the hollow `unknown` rim with it and make one dimension
    // depend on the other.
    assert.ok(
        !block.includes('box-shadow'),
        'off must not blank the whole box-shadow - the inset layer belongs to the other dimension',
    );
});

test('dim is a low-alpha ring, not a lit one', () => {
    const block = RULES.split(".status-led[data-outer='dim'] {")[1].split('\n}')[0];
    const alpha = Number(block.match(/--led-ring-alpha:\s*(\d+)%/)[1]);
    assert.ok(alpha > 0 && alpha < 50, `dim ring alpha ${alpha}% must be faint but present`);
    assert.ok(block.includes('--led-glow-alpha: 0%'), 'not-measured must not glow');
});

test('the breathing keyframes move the GLOW LAYER and nothing else', () => {
    const block = RULES.split('@keyframes status-led-breathe')[1].split('\n}\n')[0];
    assert.ok(block, 'the breathing keyframes must exist');
    // Only box-shadow may appear. A transform, a width, a margin or an
    // inset in here would move the element's own box and reintroduce the
    // drift the one-element rewrite exists to remove.
    for (const forbidden of [
        'transform:',
        'width:',
        'height:',
        'margin',
        'inset:',
        'top:',
        'left:',
        'scale(',
        'opacity:',
    ]) {
        assert.ok(
            !block.includes(forbidden),
            `the keyframes must not touch ${forbidden} - box-shadow is the only paint-only option`,
        );
    }
    const shadowFrames = block.split('box-shadow:').length - 1;
    assert.equal(shadowFrames, 2, 'exactly two keyframes, each writing box-shadow');
    // The two frames must differ in the glow layer alone: same inset
    // layer, same ring layer, one uses the rest variant of the glow.
    assert.ok(
        block.includes('var(--led-glow-layer-rest)'),
        'the trough must use the rest glow layer',
    );
    assert.ok(
        block.includes('var(--led-ring-layer)'),
        'the ring layer must be identical at both ends, so the ring never moves',
    );
    assert.equal(
        block.split('var(--led-ring-layer)').length - 1,
        2,
        'both frames must carry the same ring layer',
    );
    assert.equal(
        block.split('var(--led-inset-ring)').length - 1,
        2,
        'both frames must carry the same inset layer, so the layer count never changes mid-animation',
    );
    assert.equal(
        block.split('var(--led-ring-feather-layer)').length - 1,
        2,
        'both frames must carry the same feather layer too - it is the ring\'s edge, not the glow',
    );
});

test('the rest glow shrinks and dims from ONE fraction', () => {
    // Spread and alpha move together off --led-glow-rest, which is what
    // reads as a glow swelling rather than a light flickering.
    assert.ok(
        CSS.includes('calc(var(--led-glow-spread) * var(--led-glow-rest))'),
        'the trough spread must derive from the rest fraction',
    );
    assert.ok(
        CSS.includes('calc(var(--led-glow-alpha) * var(--led-glow-rest))'),
        'the trough alpha must derive from the same fraction',
    );
    const rest = Number(CSS.match(/--led-glow-rest:\s*([\d.]+);/)[1]);
    assert.ok(rest > 0 && rest < 1, `--led-glow-rest ${rest} must be a real fraction`);
});

test('nothing in the stylesheet can move the element', () => {
    // The static half of the same guarantee. A transform, a negative
    // margin or an inset on this component would put its painted box
    // somewhere other than its layout box, which is exactly the class of
    // thing that made the two circles come apart.
    for (const forbidden of ['transform:', 'margin-top:', 'margin-left:', 'inset:']) {
        assert.ok(
            !RULES.includes(forbidden),
            `the LED must not use ${forbidden} anywhere`,
        );
    }
    assert.ok(
        !RULES.includes('position: absolute'),
        'nothing here may be taken out of flow - there is only one box now',
    );
});

test('prefers-reduced-motion kills the pulse and leaves the ring lit', () => {
    assert.ok(CSS.includes('@media (prefers-reduced-motion: reduce)'));
    const block = RULES.split('@media (prefers-reduced-motion: reduce)')[1];
    assert.ok(block.includes('animation: none'), 'no motion');
    // The glow must survive. It does so by simply not being animated:
    // the base rule already paints the full-strength ring and glow, so
    // the reduced-motion block needs to kill the animation and nothing
    // else. It must NOT re-state geometry, or the two would drift apart.
    assert.ok(
        !block.includes('box-shadow'),
        'reduced motion must not restate the shadow - the base rule is already the lit value',
    );
});

test('the breathing period is about two seconds, as specified', () => {
    assert.ok(CSS.includes('status-led-breathe 2s ease-in-out infinite'));
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
