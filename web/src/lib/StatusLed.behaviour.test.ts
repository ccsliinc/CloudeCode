/**
 * Vitest port of tests/test_status_led.node.mjs: behavioural cases for
 * the TypeScript LED port itself, covering the vocabularies it exports
 * (minus the drift guard), the markup ledHtml renders, and the mapping
 * from server signals to led state.
 *
 * WHAT IS PORTED AND WHAT IS NOT. The node suite has 56 test blocks. The
 * 30 that exercise the MODULE are ported one for one across this file and
 * its siblings, same names, same assertions, so a failure reads the same
 * in either harness. The 26 that assert on the TEXT of
 * client/css/status-led.css are NOT ported: that stylesheet is not copied
 * by this port, it is the same file both trees paint through, and the
 * node suite already runs those assertions on every push (see the
 * `javascript` job in .github/workflows/tests.yml). Two copies of an
 * assertion about one file is two things to update when the file
 * changes, and the stale one is the one somebody trusts.
 *
 * Split out of StatusLed.test.ts: this file holds
 * describe('the vocabularies') minus its two legacy-sandbox cases,
 * describe('markup per state') and describe('the mapping from server
 * signals'), unchanged. The drift guard lives in
 * StatusLed.drift-guard.test.ts and the byte-for-byte equivalence proof
 * against the legacy renderer lives in StatusLed.parity.test.ts - both
 * share a sandbox loader in led-legacy-fixture.ts that this file does not
 * need, because nothing here reaches into client/js.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test } from 'vitest';

import * as Led from './led';

/**
 * Pull one attribute's raw value out of generated markup.
 *
 * Inputs: html - the markup; attr - the attribute name.
 * Output: string | null - the raw value, or null when absent.
 * Example: rawAttr('<span data-inner="idle">', 'data-inner') -> 'idle'
 */
function rawAttr(html: string, attr: string): string | null {
    const start = html.indexOf(`${attr}="`);
    if (start === -1) return null;
    const from = start + attr.length + 2;
    const end = html.indexOf('"', from);
    if (end === -1) return null;
    return html.slice(from, end);
}

// ---- the vocabularies (minus the drift guard) -------------------------

describe('the vocabularies', () => {
    test('both vocabularies are exported and non-empty', () => {
        expect(Array.isArray(Led.INNER_STATES)).toBe(true);
        expect(Led.INNER_STATES.length).toBeGreaterThan(0);
        expect(Array.isArray(Led.OUTER_STATES)).toBe(true);
        expect(Led.OUTER_STATES.length).toBeGreaterThan(0);
    });


    test('the inner vocabulary is exactly the nine documented states', () => {
        // `notice` and `disconnected` joined in the five-colour pass that
        // release/1.2 carries: `notice` is the only state that is BOTH
        // working and asking for the user, and `disconnected` is a
        // TRANSPORT fact rather than a session fact.
        expect([...Led.INNER_STATES]).toEqual([
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
        expect([...Led.OUTER_STATES]).toEqual([
            'active',
            'steady',
            'unread',
            'off',
            'dim',
        ]);
    });

    test('THE RING CARRIES UNREAD - the owner ruled for it, 2026-09-09', () => {
        // This assertion is INVERTED from the one this port shipped with,
        // and the inversion is the point. Two lines of this project fixed
        // one reported defect in opposite ways: one retired the outer
        // `unread` state, the other kept the ring and stopped it
        // breathing. The owner picked the second and it is what landed in
        // release/1.2, so a port that hid `unread` from the vocabulary
        // would be re-litigating a settled decision in code.
        expect([...Led.OUTER_STATES].indexOf('unread')).toBeGreaterThanOrEqual(0);
    });

    test('EXACTLY THE FINISHED-TURN STATES PRODUCE AN unread RING', () => {
        // The ring is a claim that a turn FINISHED here and nobody has
        // looked. A session that is MOVING must not wear it (it would say
        // two contradictory things at once), and neither may an unmeasured
        // one - a green ring over `unknown` is the false green this
        // project keeps paying for.
        const withRing: string[] = [];
        const statuses = [
            'working',
            'working_subagent',
            'running',
            'question',
            'notice',
            'finished_unread',
            'idle',
            'dead',
            'stopped',
            'unknown',
            undefined,
            'a-state-from-2030',
        ];
        for (const status of statuses) {
            for (const gate of [undefined, 'awaiting_startup_prompt', 'unknown']) {
                const led = Led.ledStateFor({
                    activity_status: status,
                    unread: true,
                    startup_gate: gate,
                });
                if (led.outer === 'unread') withRing.push(`${status}/${gate}`);
                expect(
                    [...Led.OUTER_STATES].indexOf(led.outer),
                    `${status} produced an outer value outside the vocabulary`,
                ).toBeGreaterThanOrEqual(0);
            }
        }
        // `finished_unread` and the defensive `idle`+flag branch, and only
        // those - each once per gate value that does not pre-empt them.
        expect(withRing).toEqual([
            'finished_unread/undefined',
            'finished_unread/unknown',
            'idle/undefined',
            'idle/unknown',
        ]);
    });

    test('NOTHING AT REST BREATHES', () => {
        // `active` is the one animated ring. Since release/1.2 it covers
        // the stopped-but-live turns as well as the moving ones - a parked
        // turn is not a resting session - so the assertion that matters is
        // the negative one: no state that has genuinely STOPPED may move.
        const breathing: string[] = [];
        for (const status of [
            'working',
            'working_subagent',
            'running',
            'question',
            'notice',
            'finished_unread',
            'idle',
            'dead',
            'unknown',
        ]) {
            if (
                Led.ledStateFor({ activity_status: status, unread: true }).outer ===
                'active'
            ) {
                breathing.push(status);
            }
        }
        expect(breathing).toEqual([
            'working',
            'working_subagent',
            'running',
            'question',
            'notice',
        ]);
        for (const atRest of ['finished_unread', 'idle', 'dead', 'unknown']) {
            expect(
                Led.ledStateFor({ activity_status: atRest, unread: true }).outer,
                `${atRest} must not animate`,
            ).not.toBe('active');
        }
    });

    test('the exported vocabularies cannot be mutated by a caller', () => {
        // The legacy module hands out a `.slice()`; an ES module has one
        // instance, so the same guarantee is bought by freezing. Module
        // code is strict, so the write throws rather than being dropped.
        expect(() => {
            (Led.INNER_STATES as unknown as string[]).push('bogus');
        }).toThrow();
        expect([...Led.INNER_STATES].indexOf('bogus' as never)).toBe(-1);
    });
});

// ---- markup per state -------------------------------------------------

describe('markup per state', () => {
    test('every inner x outer combination renders a labelled LED', () => {
        for (const inner of Led.INNER_STATES) {
            for (const outer of Led.OUTER_STATES) {
                const html = Led.ledHtml({ inner, outer });
                expect(rawAttr(html, 'data-inner'), `inner ${inner}`).toBe(inner);
                expect(rawAttr(html, 'data-outer'), `outer ${outer}`).toBe(outer);
                expect(html).toContain('class="status-led"');
                expect(html).toContain('role="img"');
                const label = rawAttr(html, 'aria-label');
                expect(label, `labelled: ${inner}/${outer}`).toBeTruthy();
                expect(rawAttr(html, 'title')).toBe(label);
            }
        }
    });

    test('an unknown inner or outer value is clamped, never emitted raw', () => {
        const html = Led.ledHtml({ inner: 'banana', outer: 'kumquat' });
        expect(rawAttr(html, 'data-inner')).toBe('unknown');
        expect(rawAttr(html, 'data-outer')).toBe('dim');
    });

    test('no arguments at all still renders a valid not-measured LED', () => {
        const html = Led.ledHtml();
        expect(rawAttr(html, 'data-inner')).toBe('unknown');
        expect(rawAttr(html, 'data-outer')).toBe('dim');
    });

    test('ledHtml escapes a hostile title rather than interpolating it raw', () => {
        const html = Led.ledHtml({
            inner: 'done',
            outer: 'steady',
            title: '"><img src=x>',
        });
        expect(html).not.toContain('<img');
        expect(html).toContain('&quot;');
    });

    test('size is accepted only as a plain CSS length', () => {
        expect(Led.ledHtml({ size: '18px' })).toContain('--led-size: 18px');
        expect(Led.ledHtml({ size: '1.5rem' })).toContain('--led-size: 1.5rem');
        // Anything else is dropped, not sanitised.
        expect(Led.ledHtml({ size: 'red; background:url(x)' })).not.toContain('style=');
        expect(Led.ledHtml({ size: 12 })).not.toContain('style=');
    });

    test('extraClass is accepted only as plain class names', () => {
        expect(Led.ledHtml({ extraClass: 'status-dot status-dot--dead' })).toContain(
            'class="status-dot status-dot--dead status-led"',
        );
        expect(Led.ledHtml({ extraClass: '" onload="x' })).toContain(
            'class="status-led"',
        );
    });
});

// ---- the mapping from server signals ----------------------------------

describe('the mapping from server signals', () => {
    test('dead outranks everything, and a corpse never glows', () => {
        expect(Led.ledStateFor({ activity_status: 'dead', unread: true })).toEqual({
            inner: 'dead',
            outer: 'off',
        });
        // `stopped` is a session that is GONE rather than a held-open
        // corpse, but it is equally not something to go and read.
        expect(Led.ledStateFor({ activity_status: 'stopped', unread: true })).toEqual({
            inner: 'dead',
            outer: 'off',
        });
    });

    test('a startup prompt is waiting-input even when the status says nothing', () => {
        expect(
            Led.ledStateFor({
                activity_status: 'idle',
                startup_gate: 'awaiting_startup_prompt',
            }),
        ).toEqual({ inner: 'waiting-input', outer: 'active' });
    });

    test('a startup gate that could not be measured does not claim anything', () => {
        // Not having looked is not evidence of a prompt.
        expect(
            Led.ledStateFor({ activity_status: 'idle', startup_gate: 'unknown' }),
        ).toEqual({ inner: 'idle', outer: 'steady' });
    });

    test('question maps to waiting-permission - the agent is stopped', () => {
        expect(Led.ledStateFor({ activity_status: 'question' })).toEqual({
            inner: 'waiting-permission',
            outer: 'active',
        });
    });

    test('notice has its OWN inner state - working, but wanting you', () => {
        // It shared `waiting-input` before the five-colour pass. The
        // owner's rule: "if the session is fully stopped waiting for a
        // response, then yellow. if it's still working but needs something
        // from me, make it light blue." `notice` is the only state on the
        // second side of that sentence, so it cannot share a name with the
        // stopped ones.
        expect(Led.ledStateFor({ activity_status: 'notice' })).toEqual({
            inner: 'notice',
            outer: 'active',
        });
    });

    test('question and notice do not paint the same inner dot', () => {
        expect(Led.ledStateFor({ activity_status: 'question' }).inner).not.toBe(
            Led.ledStateFor({ activity_status: 'notice' }).inner,
        );
    });

    test('a startup prompt is STOPPED, and so is not a notice', () => {
        // Both mean "come and look", which is why they shared an inner
        // state before the five-colour pass. They no longer do: a pane on
        // its trust dialog has not started, and `notice` is a claude that
        // is still working. Yellow versus light blue, per the owner's rule.
        const gated = Led.ledStateFor({
            activity_status: 'idle',
            startup_gate: 'awaiting_startup_prompt',
        }).inner;
        expect(gated).toBe('waiting-input');
        expect(gated).not.toBe(Led.ledStateFor({ activity_status: 'notice' }).inner);
    });

    test('an unread flag never downgrades a blocking permission prompt', () => {
        // The flag must not swap the loud stopped-on-a-yes/no light for
        // the quiet finished-turn ring: the permission is the fact that
        // will not resolve itself.
        expect(
            Led.ledStateFor({ activity_status: 'question', unread: true }),
        ).toEqual({ inner: 'waiting-permission', outer: 'active' });
    });

    test('working and working_subagent share the inner dot', () => {
        expect(Led.ledStateFor({ activity_status: 'working' }).inner).toBe('working');
        expect(Led.ledStateFor({ activity_status: 'working_subagent' }).inner).toBe(
            'working',
        );
    });

    test('the legacy `running` spelling still maps to working', () => {
        expect(Led.ledStateFor({ activity_status: 'running' }).inner).toBe('working');
    });

    test('UNREAD RIDES THE RING, and a working session never wears it', () => {
        // A WORKING SESSION IS SOLID GREEN, flag or not: the finished-turn
        // ring around a running session would say two contradictory things
        // at once, and unread on something that is moving resolves itself
        // the moment it stops.
        const busy = Led.ledStateFor({ activity_status: 'working', unread: true });
        expect(busy).toEqual({ inner: 'working', outer: 'active' });

        const rested = Led.ledStateFor({ activity_status: 'idle', unread: true });
        expect(rested).toEqual({ inner: 'done', outer: 'unread' });

        const read = Led.ledStateFor({ activity_status: 'idle', unread: false });
        expect(read).toEqual({ inner: 'idle', outer: 'steady' });
        expect(read.outer).not.toBe(rested.outer);
    });

    test('idle and seen is its own grey dot in a lit-but-still ring', () => {
        // Lit and still rather than off: a session the user has looked at
        // reads as visibly calmer than one they have not, and it does it
        // without the LED changing size.
        expect(Led.ledStateFor({ activity_status: 'idle' })).toEqual({
            inner: 'idle',
            outer: 'steady',
        });
    });

    test('idle is not done, and not unknown either', () => {
        const idle = Led.ledStateFor({ activity_status: 'idle' });
        expect(idle.inner).not.toBe('done');
        expect(idle.inner).not.toBe('unknown');
        expect(idle.inner).toBe('idle');
    });

    test('finished_unread is the green RING - the chat itself is at rest', () => {
        // The inner state stays `done` because the CHAT has stopped; the
        // RING is what says there is something here for the user.
        expect(Led.ledStateFor({ activity_status: 'finished_unread' })).toEqual({
            inner: 'done',
            outer: 'unread',
        });
    });

    test('finished_unread and idle differ in BOTH rings', () => {
        // They are the two halves of rest - unread and read - and since
        // release/1.2 each half moves both dimensions, so the difference
        // is legible whichever ring the eye lands on first.
        const unread = Led.ledStateFor({ activity_status: 'finished_unread' });
        const read = Led.ledStateFor({ activity_status: 'idle' });
        expect(unread.outer).not.toBe(read.outer);
        expect(unread.inner).not.toBe(read.inner);
    });

    test('A DEAD TRANSPORT OUTRANKS EVERYTHING, including a working row', () => {
        // Only the literal `disconnected` counts: this browser holds a
        // socket to at most ONE session, so knowing nothing about the rest
        // is the normal case, not a fault. A light we cannot refresh must
        // not keep asserting the last status it happened to see.
        expect(
            Led.ledStateFor({ activity_status: 'working', transport: 'disconnected' }),
        ).toEqual({ inner: 'disconnected', outer: 'off' });
        for (const t of [undefined, 'connected', 'unknown', 'reconnecting']) {
            expect(
                Led.ledStateFor({ activity_status: 'working', transport: t }).inner,
                `transport=${t} must fall through`,
            ).toBe('working');
        }
    });

    test('UNKNOWN IS NOT DONE - the false green this project keeps paying for', () => {
        expect(Led.ledStateFor({ activity_status: 'unknown' }).inner).toBe('unknown');
        expect(Led.ledStateFor({}).inner).toBe('unknown');
        expect(Led.ledStateFor(null).inner).toBe('unknown');
        expect(Led.ledStateFor({ activity_status: 'a-state-from-2030' }).inner).toBe(
            'unknown',
        );
    });

    test('an unmeasured session stays unmeasured even with the flag set', () => {
        expect(Led.ledStateFor({ activity_status: 'unknown', unread: true })).toEqual({
            inner: 'unknown',
            outer: 'dim',
        });
    });
});
