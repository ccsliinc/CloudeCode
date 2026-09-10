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
 * The body of the one rule whose WHOLE selector list is `selector`.
 *
 * Description: most assertions in this file reach a rule with
 *   `CSS.split("<fragment> {")[1]`, which is fine while every selector
 *   fragment appears once. It stopped being fine on 2026-09-09: the
 *   cleared centre is now declared in a rule naming TWO states, so
 *   `[data-outer='unread'] {` matches that shared rule as well as the
 *   unread block, and `[data-inner='unknown'] {` is additionally a
 *   substring of the legacy `.status-dot.status-led[...]` selector. A
 *   split then reads the wrong body and the assertion fails while the
 *   stylesheet is correct. This matches on the ENTIRE selector list
 *   instead, with comments stripped first so a comment above a rule
 *   cannot end up inside it, and asserts the match is unique.
 * Inputs: selector (string) - the full selector list, comma and newline
 *   normalised to ', ' (e.g. "a, b").
 * Output: string - the declarations between the braces.
 * Example: ruleBody(".status-led[data-outer='off']")
 */
function ruleBody(selector) {
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
        (m) => m[1].trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ') === selector,
    );
    assert.equal(hits.length, 1, `expected exactly one "${selector}" rule`);
    return hits[0][2];
}

/**
 * The stylesheet with every CSS comment removed.
 *
 * status-led.css is heavily commented and several of those comments name
 * the very properties the structural assertions below forbid - the block
 * explaining WHY the referee may not reset `box-shadow` contains the
 * string `box-shadow`, and the one explaining why nothing may move the
 * element contains `inset:`. Matching against the raw text makes those
 * explanations fail their own tests, so anything asserting "this property
 * does not appear" reads RULES instead. Assertions about a specific
 * declaration's text may use either.
 * @type {string}
 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every body of a rule whose selector list matches, in source order.
 *
 * Description: `ruleBody` insists on exactly one match, which is right
 *   for a state rule and wrong for `.status-led` itself - the base rule
 *   and the reduced-motion override share that selector, deliberately.
 *   Splitting the file on the selector TEXT is not an option either: the
 *   file's own header comment quotes these selectors, so a text split
 *   lands inside the prose. That has already cost one false pass.
 * Inputs: selector (string) - normalized selector list.
 * Output: string[] - one body per matching rule, in source order.
 * Example: ruleBodies('.status-led')[0] // the base rule
 */
function ruleBodies(selector) {
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1].trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ') === selector)
        .map((m) => m[2]);
}

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

test('the inner vocabulary is exactly the nine documented states', () => {
    // `idle` joined on 2026-09-09: the READ half of rest, a solid grey
    // dot, distinct from `done` (which is what sits inside the green
    // unread ring) and from `unknown` (which is hollow). See
    // docs/session-status.md.
    assert.deepEqual(plain(Led.INNER_STATES), [
        'working',
        'waiting-permission',
        'waiting-input',
        'notice',
        'idle',
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
        { inner: 'idle', outer: 'steady' },
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

test('AND SO DO THE TWO YELLOWS - permission is not a startup prompt', () => {
    // The mirror of the test above, and it became load-bearing on
    // 2026-09-09 when the KEY collapsed to one row per colour. The legend
    // now shows one yellow light and one sentence, so the only place a
    // user can still learn which of the two a particular dot is, is the
    // dot's own tooltip and accessible name. A paraphrase in both would
    // retire that distinction without deleting anything.
    const perm = Led.INNER_LABELS['waiting-permission'];
    const input = Led.INNER_LABELS['waiting-input'];
    assert.ok(perm && input && perm !== input);
    assert.ok(/permission/.test(perm), `permission must say so, got "${perm}"`);
    // Both are "stopped", which is the fact they genuinely share and the
    // reason they paint one hue. It is the rest of the sentence that has
    // to differ.
    for (const label of [perm, input]) {
        assert.ok(/stopped/.test(label), `got "${label}"`);
    }
    // And the pair really does resolve to ONE colour, or collapsing the
    // key's two yellow rows into one would have hidden a real difference.
    const inkFor = (state) => {
        const block = CSS.split(`[data-inner='${state}'] {`)[1].split('}')[0];
        return block.match(/--led-ink:\s*var\((--led-color-[a-z-]+)\)/)[1];
    };
    const hueOf = (token) => CSS.match(
        new RegExp(`${token}:\\s*([^;]+);`),
    )[1].trim();
    assert.equal(
        hueOf(inkFor('waiting-permission')),
        hueOf(inkFor('waiting-input')),
        'the two yellow states must really paint the same hue',
    );
    assert.equal(
        hueOf(inkFor('dead')),
        hueOf(inkFor('disconnected')),
        'and so must the two red ones',
    );
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

test('idle and seen is a steady IDLE - the grey read dot, not the green one', () => {
    // The owner's 2026-09-09 report: "i need the lights to go idle, (i
    // think thats gray) when i click on a tab. there needs to be a
    // read/idle color." Opening a tab therefore changes TWO things - the
    // ring goes from green to the dot's own grey, and the recessed
    // centre becomes a solid grey dot - rather than only the ring, which
    // was too small a change to register at a glance.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'idle' })), {
        inner: 'idle',
        outer: 'steady',
    });
});

test('READ AND UNREAD DIFFER IN BOTH RINGS, which is what makes it visible', () => {
    const read = plain(Led.ledStateFor({ activity_status: 'idle' }));
    const unread = plain(Led.ledStateFor({ activity_status: 'finished_unread' }));
    assert.notEqual(read.inner, unread.inner, 'the dot must change');
    assert.notEqual(read.outer, unread.outer, 'the ring must change');
});

test('an idle row carrying the flag renders as finished_unread, not as idle', () => {
    // DEFENSIVE, not normally reachable: the server derives this pair
    // from the flag on every path (session_status.derive_read_state), so
    // a well-formed row never carries both. If one ever arrives
    // contradictory the FLAG wins, because session-status-summary.js
    // buckets inner `done` as unread and a row that disagreed would make
    // the group header lie about its own child.
    assert.deepEqual(plain(Led.ledStateFor({ activity_status: 'idle', unread: true })), {
        inner: 'done',
        outer: 'unread',
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
        [{ activity_status: 'idle' }, 'idle', 'steady'],
        [{ activity_status: 'idle', unread: true }, 'done', 'unread'],
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

test('the finished-turn ring is a GREEN RIM around the SAME recessed centre unknown shows', () => {
    // The owner's 2026-09-09 correction, verbatim: "it should look like
    // the 'status not measured' dot, but the outline should be green
    // instead of light grey with the dark grey center". The first version
    // filled the middle with the grey `done` dot, which read as two
    // lights stacked. This is the treatment that replaced the unread
    // envelope ICON, so it is the only thing left saying "there is
    // something here for you".
    const led = Led.ledStateFor({ activity_status: 'finished_unread' });
    // THE STATE MACHINE DID NOT MOVE. Only the paint of the centre did,
    // so the inner state is still `done` and still resolves to the grey
    // ink every other resting light uses.
    assert.equal(led.inner, 'done');
    assert.equal(led.outer, 'unread');
    assert.ok(CSS.includes('--led-color-idle: var(--color-fg-muted'));
    assert.ok(/--led-ink:\s*var\(--led-color-idle\)/.test(
        ruleBody(".status-led[data-inner='done']")));
    // green rim
    assert.ok(CSS.includes('--led-color-unread: var(--color-success'));
    const block = ruleBody(".status-led[data-outer='unread']");
    // The SAME inset rim `unknown` draws, green instead of grey, and it
    // goes in through --led-inset-ring rather than as its own
    // `box-shadow` declaration - there is one box-shadow property on
    // this element and the outer ring needs it.
    assert.ok(
        /--led-inset-ring:\s*inset 0 0 0 var\(--led-hollow-width\) var\(--led-color-unread\)/
            .test(block),
        "unread reuses unknown's inset rim in green, as a shadow LAYER",
    );
    // AND IT MUST NOT RESIZE ITSELF. This block used to carry its own
    // halo scale, which is precisely how `unread` and `active` came to
    // paint two different diameters in one list. The size now lives
    // once, on `.status-led`, and every state inherits it.
    for (const geom of ['--led-size', '--led-ring-width', '--led-ring-feather-blur',
                        '--led-glow-blur', '--led-glow-spread', '--led-lit-scale',
                        '--led-halo-scale']) {
        assert.ok(!new RegExp(geom + ':').test(block),
            `no state may set ${geom} - see the geometry block`);
    }
});

test("unread's centre matches unknown's centre - same recipe, one different hue", () => {
    // This is the assertion the 2026-09-09 overshoot would have caught.
    // Both hollow states clear the fill and draw a 2px inset rim of the
    // SAME width from the SAME token; only the rim's colour differs. If
    // one of them ever grows its own width or its own clear, the two
    // stop being the same dot and the owner's requirement quietly stops
    // holding.
    const unknownBlock = ruleBody(".status-led[data-inner='unknown']");
    const unreadBlock = ruleBody(".status-led[data-outer='unread']");
    for (const block of [unknownBlock, unreadBlock]) {
        assert.ok(
            /--led-inset-ring:\s*inset 0 0 0 var\(--led-hollow-width\)/.test(block),
            'both rims are the same width, read from one token',
        );
    }
    assert.ok(/var\(--led-color-unknown\)/.test(unknownBlock), "unknown's rim is grey");
    assert.ok(/var\(--led-color-unread\)/.test(unreadBlock), "unread's rim is green");
    // The surround is the same faint grey in both, so the only thing the
    // eye can tell apart is the rim.
    assert.ok(/--led-ring-ink:\s*var\(--led-color-unknown\)/.test(unreadBlock));
    assert.ok(/--led-glow-alpha:\s*0%/.test(unreadBlock), 'the ring does not glow');
});

test('THE CLEARED CENTRE IS ONE RECIPE SHARED BY BOTH HOLLOW STATES', () => {
    // The unread ring and the `unknown` dot are the same construction in
    // two hues, which is precisely what the owner asked for. Two copies
    // of "clear the middle" would be free to drift into one state showing
    // the real background and the other showing a grey somebody picked,
    // and at nine pixels nobody would notice for weeks.
    //
    // So the clear is a TOKEN, set in exactly one rule that names both
    // states. Asserting the count is the whole point: a second
    // declaration is the drift.
    const clears = CSS.match(/--led-fill:\s*transparent;/g) || [];
    assert.equal(
        clears.length, 1,
        'the cleared centre must be declared in exactly one place',
    );
    assert.ok(
        /--led-fill:\s*transparent;/.test(ruleBody(
            ".status-led[data-inner='unknown'], .status-led[data-outer='unread']",
        )),
        'the one clear must name both hollow states',
    );
    // AND THE DOT MUST ACTUALLY READ THE TOKEN. `background-color:
    // var(--led-ink)` here would refill both of them and every assertion
    // above would still pass.
    // ruleBody, not a naive split: the file's own header comment quotes
    // these selectors, so a text split lands inside the prose.
    const base = ruleBodies('.status-led')[0];
    assert.ok(
        /background-color:\s*var\(--led-fill\);/.test(base),
        'the dot is painted with the fill token, not the ink',
    );
    assert.ok(
        /--led-fill:\s*var\(--led-ink\);/.test(base),
        'and it defaults to the ink, so a solid state stays solid',
    );
    // THE LEGACY COMPAT BLOCK IS THE TRAP. `.status-dot.status-led`
    // outranks `.status-led[data-outer='unread']` and sits later in the
    // file, so a `var(--led-ink)` there would silently put the grey blob
    // back on every surface that emits the legacy class - which is all of
    // them, via session-status-ui.js's dotHtml.
    const legacy = ruleBody('.status-dot.status-led');
    assert.ok(
        /background-color:\s*var\(--led-fill\);/.test(legacy),
        'the legacy compat block must not refill the hollow states',
    );
});

test('grey at rest and grey unmeasured are told apart by SHAPE', () => {
    // Same hue on purpose, which is how "we did not look" stays
    // distinguishable from "we looked and it is quiet" without ranking
    // one above the other with a louder colour. `unknown` keeps its 2px
    // rim on the 9px dot and a cleared middle; `idle` is a SOLID dot,
    // because it is a measurement and the other is the absence of one.
    assert.ok(CSS.includes('--led-color-unknown: var(--color-fg-muted'));
    assert.ok(CSS.includes('--led-color-idle: var(--color-fg-muted'));
    const hollow = ruleBody(".status-led[data-inner='unknown']");
    assert.ok(/--led-inset-ring:\s*inset/.test(hollow), 'the rim is an inset shadow layer');
    assert.ok(/var\(--led-color-unknown\)/.test(hollow), 'the rim is grey');
    const idle = ruleBody(".status-led[data-inner='idle']");
    assert.ok(!/--led-inset-ring:/.test(idle), 'idle is not hollow');
    assert.ok(!/--led-fill:\s*transparent/.test(idle), 'idle keeps its fill');
    // AND THE TWO HOLLOW STATES ARE NOT THE SAME LIGHT. They share a
    // construction and must not share a hue, or the legend's last two
    // rows would be describing one dot.
    const ring = ruleBody(".status-led[data-outer='unread']");
    assert.ok(/var\(--led-color-unread\)/.test(ring), 'the ring is green');
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






// ---- compact-size geometry ---------------------------------------------
//
// The owner's report ("on the compact view the breathing is way too big.
// also in the homepage") traced to a halo that grew to about 35px across
// at the breathing peak while the dot itself renders at the CSS default
// of 9px everywhere - the sidebar row and the launchpad card both call
// `dotHtml()` with no `size`, so both got that oversized halo. These pin
// the tuned-down geometry so a future edit cannot silently regrow it.




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

test('the referee animation reset excludes the breathing state', () => {
    // A blanket `.status-dot.status-led { animation: none }` is (0,2,0),
    // ties with the breathing rule and wins on source order, silently
    // killing the pulse for every LED in the app. Excluding the one
    // breathing state makes it order-independent.
    assert.ok(
        CSS.includes(".status-dot.status-led:not([data-outer='active']) {"),
        'the legacy animation reset must be scoped off the breathing state',
    );
});

test('idle has its own NAMED token, and is told apart by shape not hue', () => {
    // `idle` and `unknown` resolve to the same grey ON PURPOSE - neither
    // is interesting to look at and neither may be dressed up as a
    // measured healthy state - so what separates them is SHAPE: `idle`
    // is a solid dot, `unknown` is hollow. See the "told apart by SHAPE"
    // case above, which is the other half of this pair.
    //
    // The token is still its OWN name rather than an alias, because a
    // theme has to be able to pull the two apart without editing this
    // file, and because the two answer different questions: measured and
    // at rest, versus not measured at all.
    const idleBlock = RULES.split(".status-led[data-inner='idle'] {")[1].split('\n}')[0];
    assert.ok(
        idleBlock.includes('--led-ink: var(--led-color-idle)'),
        'idle must resolve through its own colour token',
    );
    assert.ok(
        !idleBlock.includes('var(--led-color-unknown)'),
        'idle must not reach for the unknown token directly',
    );
    // Both tokens exist and are declared separately, so redefining one
    // in a theme cannot move the other.
    assert.ok(/--led-color-idle:\s*var\(/.test(CSS));
    assert.ok(/--led-color-unknown:\s*var\(/.test(CSS));
    assert.equal(
        (CSS.match(/--led-color-idle:/g) || []).length, 1,
        'declared exactly once',
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

test('EXACTLY ONE outer state animates, and the animation is on the element', () => {
    assert.ok(CSS.includes(".status-led[data-outer='active'] {"));
    assert.equal(
        (CSS.match(/animation: status-led-breathe/g) || []).length,
        1,
        'only one rule may start the breathing animation',
    );
    // The base rule must not carry a running animation - a resting LED
    // holds still.
    assert.ok(
        !/^\.status-led\s*\{[^}]*animation:\s*(?!none)/m.test(RULES),
        'the base rule must not carry a running animation',
    );
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
