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

test('the inner vocabulary is exactly the eight documented states', () => {
    assert.deepEqual(plain(Led.INNER_STATES), [
        'working',
        'waiting-permission',
        'waiting-input',
        'notice',
        'done',
        'dead',
        'disconnected',
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

test('question maps to waiting-permission - the agent is stopped', () => {
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'question' })), {
        inner: 'waiting-permission',
        outer: 'active',
    });
});

test('notice has its own inner state - working, and wanting you', () => {
    // The five-colour pass: "if it's still working but needs something
    // from me, make it light blue". It is the only state on that side of
    // the sentence, so it cannot share a name with the yellow ones.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'notice' })), {
        inner: 'notice',
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

test('a startup prompt is STOPPED, so it paints the permission yellow', () => {
    // A pane parked on the folder-trust dialog is "fully stopped waiting
    // for a response" - the same thing a permission prompt is, and the
    // opposite of a notice, which is still working.
    const gated = Led.ledStateFor({
        activity_status: 'idle',
        startup_gate: 'awaiting_startup_prompt',
    });
    assert.equal(gated.inner, 'waiting-input');
    assert.notEqual(gated.inner, Led.ledStateFor({ activity_status: 'notice' }).inner);
});

test('the two yellows resolve to the same colour token', () => {
    // Separate names, separate labels, ONE hue: the user's answer to a
    // permission prompt and to a startup prompt is the same - go there
    // and respond.
    assert.ok(CSS.includes('--led-color-waiting: var(--color-warning'));
    assert.ok(CSS.includes('--led-color-permission: var(--color-warning'));
});

test('light blue is not the green, and is not derived from it', () => {
    // Red-green colourblindness is the case this pair has to survive, so
    // the notice hue must come from a different family entirely rather
    // than being a lighter green.
    assert.ok(CSS.includes('--led-color-notice: var(--color-info'));
    assert.ok(CSS.includes('--led-color-working: var(--color-success'));
});

test('BOTH a permission and a notice open still answers yellow', () => {
    // `permission_open` and `notice_open` are two independent booleans
    // server-side and permission is read first, so a session holding both
    // arrives here as `question`. The client must not second-guess that.
    const both = Led.ledStateFor({
        activity_status: 'question',
        notice_open: true,
        permission_open: true,
    });
    assert.equal(both.inner, 'waiting-permission');
    assert.notEqual(both.inner, 'notice');
});

test('a dropped socket is red, and outranks every session-side status', () => {
    // Nothing we are showing is fresh once the transport is down, so the
    // light may not keep asserting the last status it happened to see.
    for (const status of [
        'working', 'working_subagent', 'question', 'notice',
        'finished_unread', 'idle', 'unknown', undefined,
    ]) {
        assert.deepEqual(
            plain(Led.ledStateFor({ activity_status: status, transport: 'disconnected' })),
            { inner: 'disconnected', outer: 'off' },
            `transport must win over ${status}`,
        );
    }
    assert.ok(CSS.includes('--led-color-disconnected: var(--color-danger'));
    assert.ok(CSS.includes('--led-color-dead: var(--color-danger'));
});

test('DEAD AND DISCONNECTED SHARE A COLOUR AND MUST NOT SHARE WORDS', () => {
    // One red was asked for, so the label is the only thing left that can
    // tell a corpse from a lost connection.
    const dead = Led.INNER_LABELS.dead;
    const gone = Led.INNER_LABELS.disconnected;
    assert.ok(dead && gone && dead !== gone);
    assert.ok(/process/.test(dead), 'dead must say the process exited');
    assert.ok(/connection/.test(gone), 'disconnected must say the connection is gone');
});

test('connected and unknown transports change nothing', () => {
    // This browser holds a socket to at most ONE session; knowing nothing
    // about the rest is the normal case, not a fault.
    for (const t of ['connected', 'unknown', undefined, null, '']) {
        assert.equal(
            Led.ledStateFor({ activity_status: 'working', transport: t }).inner,
            'working',
        );
    }
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

test('A WORKING SESSION IS SOLID GREEN, unread flag or not', () => {
    // It used to take the unread halo. After the five-colour pass that
    // would paint the finished-turn ring around a session that has not
    // finished, which is two contradictory claims on one light.
    const busy = Led.ledStateFor({ activity_status: 'working', unread: true });
    assert.deepEqual(plain(busy), { inner: 'working', outer: 'active' });

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

test('UNKNOWN STAYS GREY even with an unread flag on it', () => {
    // The green ring is a claim that a turn FINISHED here. Nothing was
    // measured, so nothing may claim that - not having looked is not
    // evidence of anything, which is the rule this whole component is
    // built around.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'unknown', unread: true })), {
        inner: 'unknown',
        outer: 'dim',
    });
});

test('THE WHOLE MAPPING, one row per state, is what the user asked for', () => {
    // Five colours: yellow stopped-and-waiting, light blue
    // working-and-wanting-you, green working, grey at rest or not
    // measured, red unusable. Plus the one two-part treatment: a
    // finished turn nobody has looked at is a grey dot in a green ring.
    const cases = [
        [{ activity_status: 'question' }, 'waiting-permission', 'active'],
        [{ activity_status: 'idle', startup_gate: 'awaiting_startup_prompt' },
            'waiting-input', 'active'],
        [{ activity_status: 'notice' }, 'notice', 'active'],
        [{ activity_status: 'finished_unread' }, 'done', 'unread'],
        [{ activity_status: 'working' }, 'working', 'active'],
        [{ activity_status: 'working_subagent' }, 'working', 'active'],
        [{ activity_status: 'idle' }, 'done', 'steady'],
        [{ activity_status: 'unknown' }, 'unknown', 'dim'],
        [{ activity_status: 'dead' }, 'dead', 'off'],
        [{ activity_status: 'stopped' }, 'dead', 'off'],
        [{ transport: 'disconnected' }, 'disconnected', 'off'],
    ];
    for (const [signals, inner, outer] of cases) {
        assert.deepEqual(
            plain(Led.ledStateFor(signals)),
            { inner, outer },
            `wrong LED for ${JSON.stringify(signals)}`,
        );
    }
});

test('the finished-turn ring is a GREEN OUTLINE around a GREY DOT', () => {
    // The owner's words. This is the treatment that replaced the unread
    // envelope icon, so it is the only thing left saying "there is
    // something here for you".
    const led = Led.ledStateFor({ activity_status: 'finished_unread' });
    assert.equal(led.inner, 'done');
    assert.equal(led.outer, 'unread');
    // grey dot
    assert.ok(CSS.includes('--led-color-idle: var(--color-fg-muted'));
    assert.ok(/\[data-inner='done'\]\s*\{\s*--led-ink: var\(--led-color-idle\)/.test(CSS));
    // green ring
    assert.ok(CSS.includes('--led-color-unread: var(--color-success'));
    const block = CSS.split("[data-outer='unread'] {")[1].split('}')[0];
    assert.ok(/--led-halo-opacity:\s*1;/.test(block), 'the ring is opaque');
    // AND IT MUST NOT RESIZE ITSELF. This block used to carry its own
    // `--led-halo-scale: 1.7`, which is precisely how `unread` and
    // `active` came to paint two different diameters in one list. The
    // size now lives once, on `.status-led`, and every state inherits it.
    assert.ok(
        !/--led-lit-scale:/.test(block) && !/--led-halo-scale:/.test(block),
        'no state may set its own lit diameter - see the geometry block',
    );
    // AND IT MUST BE A RING, NOT A DISC. The halo pseudo-element paints
    // ABOVE the element background, which IS the dot, so an opaque FILL
    // hides the grey entirely - measured, it came out a solid green blob.
    // A transparent centre with an inset band is what leaves the dot
    // visible. If this ever reverts to a fill, the treatment the owner
    // asked for silently stops existing.
    const pseudo = CSS.split("[data-outer='unread']::after {")[1].split('}')[0];
    assert.ok(/background:\s*transparent/.test(pseudo), 'the centre must be clear');
    assert.ok(/box-shadow:\s*inset/.test(pseudo), 'the band must be an inset ring');
    assert.ok(CSS.includes('--led-ring-width'), 'the band width is a named token');
});

test('grey at rest and grey unmeasured are told apart by SHAPE', () => {
    // Same hue on purpose. `unknown` is the one hollow dot in the
    // component, which is how "we did not look" stays distinguishable
    // from "we looked and it is quiet" without ranking one above the
    // other with a louder colour.
    assert.ok(CSS.includes('--led-color-unknown: var(--color-fg-muted'));
    assert.ok(CSS.includes('--led-color-idle: var(--color-fg-muted'));
    const hollow = CSS.split("[data-inner='unknown'] {")[1].split('}')[0];
    assert.ok(/background:\s*transparent/.test(hollow));
    assert.ok(/box-shadow:\s*inset/.test(hollow));
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

test('every state colour is a named token declared in one place', () => {
    for (const token of [
        '--led-color-working',
        '--led-color-waiting',
        '--led-color-permission',
        '--led-color-notice',
        '--led-color-idle',
        '--led-color-dead',
        '--led-color-disconnected',
        '--led-color-unknown',
        '--led-color-unread',
    ]) {
        const declarations = CSS.split(`${token}:`).length - 1;
        assert.equal(declarations, 1, `${token} must be declared exactly once`);
    }
});

test('only `active` breathes, and only on the halo', () => {
    // The dot itself must never animate: the state colour has to stay at
    // full strength and legible at every point in the cycle. `unread`
    // stopped breathing with the five-colour pass - an outline that
    // pulses stops reading as an outline at nine pixels, and motion is
    // now its own signal: a light that moves is a session that is moving.
    assert.ok(CSS.includes("[data-outer='active']::after"));
    assert.ok(
        !/\[data-outer='unread'\]::after\s*\{\s*animation:/.test(CSS),
        'the finished-turn ring must be still',
    );
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

// ---- compact-size geometry ---------------------------------------------
//
// The owner's report ("on the compact view the breathing is way too big.
// also in the homepage") traced to a halo that grew to about 35px across
// at the breathing peak while the dot itself renders at the CSS default
// of 9px everywhere - the sidebar row and the launchpad card both call
// `dotHtml()` with no `size`, so both got that oversized halo. These pin
// the tuned-down geometry so a future edit cannot silently regrow it.

test('THE LIT DIAMETER IS DECLARED ONCE AND NO STATE MAY OVERRIDE IT', () => {
    // The 2026-09-09 defect. Every LED's ELEMENT box measured 9px in
    // every state - which is why nothing caught it - while the lit
    // object came out at three different diameters, because the halo
    // was sized per state AND drawn partly outside its own box. Only
    // the two loud states were ever visible, so in a list where one
    // session is working and the rest are at rest, one dot read about
    // 60 percent wider than its neighbours.
    //
    // Both halves of the fix are asserted here: the size token appears
    // exactly once in the file, and the glow is a contained gradient
    // rather than an outward box-shadow.
    const declarations = CSS.match(/--led-lit-scale:/g) || [];
    assert.equal(
        declarations.length, 1,
        'the lit diameter must be declared in exactly one place',
    );
    const base = CSS.split('.status-led {')[1].split('\n}')[0];
    assert.ok(
        /--led-lit-scale:\s*1\.7;/.test(base),
        'the lit diameter lives on .status-led itself',
    );
    assert.ok(
        !/--led-glow-spread/.test(CSS),
        'the spread box-shadow glow is gone - it painted outside its own box, '
        + 'so it could never be held to a declared diameter',
    );
    const pseudo = CSS.split('.status-led::after {')[1].split('\n}')[0];
    assert.ok(
        /background:\s*radial-gradient\(/.test(pseudo),
        'the glow must be a gradient that fades out AT the box edge',
    );
    assert.ok(
        /box-shadow:\s*none;/.test(pseudo),
        'and nothing may paint beyond that edge',
    );
});

test('the lit object stays within the owner-calibrated size, and the ring sets it', () => {
    // The ring is the one treatment with a hard size requirement: a 9px
    // dot, a readable gap, and a band thick enough to see. 9 + 2*0.65 +
    // 2*2.5 = 15.3px, i.e. 1.7x the dot. Every other state now paints
    // inside that same box, so this is the whole component's maximum.
    const size = 9;
    const scale = Number(CSS.match(/--led-lit-scale:\s*([\d.]+);/)[1]);
    const band = Number(CSS.match(/--led-ring-width:\s*([\d.]+)px;/)[1]);
    const lit = size * scale;
    assert.ok(
        lit < 16,
        `lit diameter ${lit}px must stay well clear of the old ~21px and ~35px regressions`,
    );
    // The band must leave the grey dot visible with daylight around it,
    // or the ring and the dot read as one blob.
    const gap = (lit - 2 * band - size) / 2;
    assert.ok(gap > 0.3, `the ring must clear the dot, got ${gap}px of gap`);
    // And the halo's OPAQUE core must not exceed the dot, or the glow
    // stops reading as a glow and starts reading as a wider dot - which
    // is what the owner reported.
    const core = Number(CSS.match(/--led-halo-core:\s*([\d.]+)%;/)[1]);
    const opaque = lit * (core / 100);
    assert.ok(
        opaque <= size,
        `the halo's solid core (${opaque}px) must not exceed the ${size}px dot`,
    );
});

test('the breathing amplitude does not grow the halo past its resting size', () => {
    // The old keyframes scaled up to 1.06 at the peak, growing the
    // already-oversized halo further. The peak must now be the halo's own
    // unscaled size (scale 1, i.e. no growth) so the geometry tokens above
    // are the true maximum, not a floor the animation overshoots.
    const block = CSS.split('@keyframes status-led-breathe')[1];
    assert.ok(block, 'the breathing keyframes must exist');
    assert.ok(
        /50%\s*\{[^}]*transform:\s*scale\(1\)/.test(block),
        'the breathing peak must not scale the halo past its own size',
    );
    assert.ok(
        !/scale\(1\.0[1-9]/.test(block) && !/scale\(1\.1/.test(block),
        'the breathing peak must not grow past scale(1)',
    );
});

await runQueue();
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log('ALL PASS');
