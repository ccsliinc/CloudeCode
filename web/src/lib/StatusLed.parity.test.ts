/**
 * THE EQUIVALENCE PROOF: THE LOAD-BEARING TEST in the whole port. Porting
 * a module by hand and then testing the port against hand-written
 * expectations proves only that the port agrees with what the porter
 * remembered. So this file loads the REAL client/js/status-led.js and
 * client/js/session-status-ui.js in a `vm` sandbox and compares their
 * output against this port's, string against string, across the full
 * cross product of status, unread flag, startup gate, status source and
 * transport. If a rule here and a rule there ever disagree by one
 * character, that is where it surfaces.
 *
 * Split out of StatusLed.test.ts, formerly describe('byte-identical to
 * the legacy renderer'). Shares its sandbox loader with
 * StatusLed.drift-guard.test.ts via led-legacy-fixture.ts; behavioural
 * cases for the port itself live in StatusLed.behaviour.test.ts.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test } from 'vitest';

import * as Led from './led';
import { ledHtmlForStatus } from './status-dot';
import { legacy } from './led-legacy-fixture';

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
    /**
     * Every transport value, plus absent and one this client does not know.
     * It is in the matrix because it is a signal the port PASSES THROUGH:
     * an untested passthrough that silently dropped the field would leave
     * every other cell green while disconnected sessions kept asserting a
     * status nothing could refresh.
     */
    const TRANSPORTS = [undefined, 'connected', 'disconnected', 'reconnecting'];

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
                        for (const transport of TRANSPORTS) {
                            const signals = {
                                unread,
                                startup_gate,
                                status_source,
                                transport,
                            };
                            const mine = ledHtmlForStatus(status, signals);
                            const theirs = api.dotHtml(status, signals);
                            expect(
                                mine,
                                `status=${status} unread=${unread} gate=${startup_gate} source=${status_source} transport=${transport}`,
                            ).toBe(theirs);
                            compared++;
                        }
                    }
                }
            }
        }
        // A matcher that always finds something is worse than useless, so
        // the count is asserted: a loop that silently ran zero times would
        // otherwise pass this test perfectly.
        expect(compared).toBe(
            STATUSES.length * 3 * GATES.length * SOURCES.length * TRANSPORTS.length,
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
