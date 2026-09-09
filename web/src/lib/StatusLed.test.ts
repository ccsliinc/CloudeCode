/**
 * Vitest port of tests/test_status_led.node.mjs, plus the equivalence
 * proof that is the whole reason this port is allowed to exist.
 *
 * WHAT IS PORTED AND WHAT IS NOT. The node suite has 56 test blocks. The
 * 30 that exercise the MODULE are ported here one for one, same names,
 * same assertions, so a failure reads the same in either harness. The 26
 * that assert on the TEXT of client/css/status-led.css are NOT ported:
 * that stylesheet is not copied by this port, it is the same file both
 * trees paint through, and the node suite already runs those assertions
 * on every push (see the `javascript` job in .github/workflows/tests.yml).
 * Two copies of an assertion about one file is two things to update when
 * the file changes, and the stale one is the one somebody trusts.
 *
 * THE EQUIVALENCE TEST IS THE LOAD-BEARING ONE. Porting a module by hand
 * and then testing the port against hand-written expectations proves only
 * that the port agrees with what the porter remembered. So the last block
 * loads the REAL client/js/status-led.js and client/js/session-status-ui.js
 * in a `vm` sandbox and compares their output against this port's, string
 * against string, across the full cross product of status, unread flag,
 * startup gate and status source. If a rule here and a rule there ever
 * disagree by one character, that is where it surfaces.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as Led from './led';
import { ledHtmlForStatus } from './status-dot';

/** Repo root, two levels up from web/src/lib. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

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

/** The shape the legacy files publish, as far as these tests use it. */
interface LegacyApi {
    dotHtml(status?: unknown, signals?: unknown): string;
    ledStateFor(signals?: unknown): { inner: string; outer: string };
    ledHtml(opts?: unknown): string;
}

/**
 * Load the two legacy client modules in one bare sandbox.
 *
 * Description: status-led.js publishes onto `globalThis` and
 *   session-status-ui.js onto `window`, so the sandbox supplies a bare
 *   `window` object and nothing else. There is deliberately no document:
 *   both modules claim to need none, and a reach for one throws here,
 *   which is the point.
 * Inputs: none.
 * Output: LegacyApi - the two entry points these tests compare against.
 * Example: legacy().dotHtml('idle', {unread: true})
 */
function legacy(): LegacyApi {
    const context: Record<string, unknown> = { console, window: {} };
    vm.createContext(context);
    for (const file of ['status-led.js', 'session-status-ui.js']) {
        const src = fs.readFileSync(path.join(repoRoot, 'client', 'js', file), 'utf8');
        vm.runInContext(src, context);
    }
    const led = context['StatusLed'] as LegacyApi;
    const ui = (context['window'] as Record<string, unknown>)[
        'SessionStatusUI'
    ] as LegacyApi;
    return {
        dotHtml: (status, signals) => ui.dotHtml(status, signals),
        ledStateFor: (signals) => led.ledStateFor(signals),
        ledHtml: (opts) => led.ledHtml(opts),
    };
}

// ---- the vocabularies -------------------------------------------------

describe('the vocabularies', () => {
    test('both vocabularies are exported and non-empty', () => {
        expect(Array.isArray(Led.INNER_STATES)).toBe(true);
        expect(Led.INNER_STATES.length).toBeGreaterThan(0);
        expect(Array.isArray(Led.OUTER_STATES)).toBe(true);
        expect(Led.OUTER_STATES.length).toBeGreaterThan(0);
    });

    test('the inner vocabulary is exactly the seven documented states', () => {
        expect([...Led.INNER_STATES]).toEqual([
            'working',
            'waiting-permission',
            'waiting-input',
            'idle',
            'done',
            'dead',
            'unknown',
        ]);
    });

    test('the outer vocabulary is exactly the four documented states', () => {
        expect([...Led.OUTER_STATES]).toEqual(['active', 'steady', 'off', 'dim']);
    });

    test('THE RETIRED `unread` OUTER STATE IS GONE FROM THE VOCABULARY', () => {
        // A value left in the vocabulary is a value some caller can still
        // pass, and it would render as an unstyled ring rather than fail
        // loudly. The stylesheet half of this assertion stays in the node
        // suite, which owns the stylesheet text.
        expect([...Led.OUTER_STATES].indexOf('unread' as never)).toBe(-1);
    });

    test('NO ACTIVITY_STATUS CAN PRODUCE AN unread RING, WHATEVER THE FLAG', () => {
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
            for (const unread of [true, false]) {
                for (const gate of [undefined, 'awaiting_startup_prompt', 'unknown']) {
                    const led = Led.ledStateFor({
                        activity_status: status,
                        unread,
                        startup_gate: gate,
                    });
                    expect(
                        led.outer,
                        `${status}/unread=${unread}/gate=${gate} produced an unread ring`,
                    ).not.toBe('unread');
                    expect(
                        [...Led.OUTER_STATES].indexOf(led.outer),
                        `${status} produced an outer value outside the vocabulary`,
                    ).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });

    test('ONLY A RUNNING SESSION BREATHES', () => {
        // `active` is the one animated ring, so the set of statuses that
        // map to it is the set of things the user will see moving.
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
        expect(breathing).toEqual(['working', 'working_subagent', 'running']);
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
        ).toEqual({ inner: 'waiting-input', outer: 'steady' });
    });

    test('a startup gate that could not be measured does not claim anything', () => {
        // Not having looked is not evidence of a prompt.
        expect(
            Led.ledStateFor({ activity_status: 'idle', startup_gate: 'unknown' }),
        ).toEqual({ inner: 'idle', outer: 'off' });
    });

    test('question maps to waiting-permission - the agent is stopped', () => {
        expect(Led.ledStateFor({ activity_status: 'question' })).toEqual({
            inner: 'waiting-permission',
            outer: 'steady',
        });
    });

    test('notice maps to waiting-input - it wants you but is not blocked', () => {
        expect(Led.ledStateFor({ activity_status: 'notice' })).toEqual({
            inner: 'waiting-input',
            outer: 'steady',
        });
    });

    test('question and notice do not paint the same inner dot', () => {
        expect(Led.ledStateFor({ activity_status: 'question' }).inner).not.toBe(
            Led.ledStateFor({ activity_status: 'notice' }).inner,
        );
    });

    test('a startup prompt and a notice share waiting-input', () => {
        expect(
            Led.ledStateFor({
                activity_status: 'idle',
                startup_gate: 'awaiting_startup_prompt',
            }).inner,
        ).toBe(Led.ledStateFor({ activity_status: 'notice' }).inner);
    });

    test('an unread flag never downgrades a blocking permission prompt', () => {
        expect(
            Led.ledStateFor({ activity_status: 'question', unread: true }),
        ).toEqual({ inner: 'waiting-permission', outer: 'steady' });
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

    test('UNREAD RIDES THE INNER DOT, and never the ring', () => {
        const busy = Led.ledStateFor({ activity_status: 'working', unread: true });
        expect(busy).toEqual({ inner: 'working', outer: 'active' });

        const rested = Led.ledStateFor({ activity_status: 'idle', unread: true });
        expect(rested).toEqual({ inner: 'done', outer: 'off' });

        const read = Led.ledStateFor({ activity_status: 'idle', unread: false });
        expect(read).toEqual({ inner: 'idle', outer: 'off' });
        expect(read.inner).not.toBe(rested.inner);
    });

    test('idle and seen is its OWN gray dot, at rest with no ring at all', () => {
        expect(Led.ledStateFor({ activity_status: 'idle' })).toEqual({
            inner: 'idle',
            outer: 'off',
        });
    });

    test('idle is not done, and not unknown either', () => {
        const idle = Led.ledStateFor({ activity_status: 'idle' });
        expect(idle.inner).not.toBe('done');
        expect(idle.inner).not.toBe('unknown');
        expect(idle.inner).toBe('idle');
    });

    test('finished_unread is the green dot ALONE - no ring at all', () => {
        expect(Led.ledStateFor({ activity_status: 'finished_unread' })).toEqual({
            inner: 'done',
            outer: 'off',
        });
    });

    test('finished_unread and idle differ in the dot, not the ring', () => {
        const unread = Led.ledStateFor({ activity_status: 'finished_unread' });
        const read = Led.ledStateFor({ activity_status: 'idle' });
        expect(unread.outer).toBe(read.outer);
        expect(unread.inner).not.toBe(read.inner);
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

// ---- the equivalence proof --------------------------------------------

describe('byte-identical to the legacy renderer', () => {
    /** Every status the legacy vocabulary knows, plus two it does not. */
    const STATUSES = [
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
    /** Every status_source the server can send, plus two it cannot. */
    const SOURCES = [
        undefined,
        'hook',
        'transcript',
        'seed_row',
        'tmux',
        'none',
        'not-a-source',
    ];
    /** Every startup_gate value, plus absent. */
    const GATES = [undefined, 'ready', 'awaiting_startup_prompt', 'unknown'];

    test('the legacy files load in a bare sandbox', () => {
        const api = legacy();
        expect(typeof api.dotHtml).toBe('function');
        expect(typeof api.ledStateFor).toBe('function');
    });

    test('ledHtmlForStatus matches SessionStatusUI.dotHtml over the whole matrix', () => {
        const api = legacy();
        let compared = 0;
        for (const status of STATUSES) {
            for (const unread of [true, false, undefined]) {
                for (const startup_gate of GATES) {
                    for (const status_source of SOURCES) {
                        const signals = { unread, startup_gate, status_source };
                        const mine = ledHtmlForStatus(status, signals);
                        const theirs = api.dotHtml(status, signals);
                        expect(
                            mine,
                            `status=${status} unread=${unread} gate=${startup_gate} source=${status_source}`,
                        ).toBe(theirs);
                        compared++;
                    }
                }
            }
        }
        // A matcher that always finds something is worse than useless, so
        // the count is asserted: a loop that silently ran zero times would
        // otherwise pass this test perfectly.
        expect(compared).toBe(
            STATUSES.length * 3 * GATES.length * SOURCES.length,
        );
        expect(compared).toBeGreaterThan(1000);
    });

    test('the `size` passthrough matches too, including the values it drops', () => {
        const api = legacy();
        for (const size of ['9px', '18px', '1.5rem', 'red; background:url(x)', '']) {
            const signals = { unread: false, size };
            expect(ledHtmlForStatus('idle', signals), `size=${size}`).toBe(
                api.dotHtml('idle', signals),
            );
        }
    });

    test('a caller passing no signals at all matches too', () => {
        const api = legacy();
        for (const status of STATUSES) {
            expect(ledHtmlForStatus(status), `status=${status}`).toBe(
                api.dotHtml(status),
            );
            expect(ledHtmlForStatus(status, null), `status=${status} null`).toBe(
                api.dotHtml(status, null),
            );
        }
    });

    test('the low-level ledHtml matches the legacy one over its own matrix', () => {
        const api = legacy();
        for (const inner of [...Led.INNER_STATES, 'banana', undefined]) {
            for (const outer of [...Led.OUTER_STATES, 'kumquat', undefined]) {
                for (const extraClass of [undefined, 'status-dot', '" onload="x']) {
                    const opts = { inner, outer, extraClass };
                    expect(
                        Led.ledHtml(opts),
                        `${String(inner)}/${String(outer)}/${String(extraClass)}`,
                    ).toBe(api.ledHtml(opts));
                }
            }
        }
    });

    test('NEGATIVE CONTROL: the comparison can actually fail', () => {
        // Everything above compares two strings and asserts they match. If
        // the legacy loader silently returned this port instead of the
        // legacy code, every one of those assertions would pass and prove
        // nothing. So: feed the legacy renderer a DIFFERENT input and
        // require the strings to differ.
        const api = legacy();
        expect(ledHtmlForStatus('idle', { unread: false })).not.toBe(
            api.dotHtml('idle', { unread: true }),
        );
        expect(ledHtmlForStatus('working')).not.toBe(api.dotHtml('dead'));
    });
});
