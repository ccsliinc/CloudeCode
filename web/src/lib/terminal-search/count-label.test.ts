/**
 * THE COUNTER'S FIVE DISTINGUISHABLE STATES, one of which is "I do not
 * know".
 *
 * Ported from the `countLabel` cases in
 * `tests/test_terminal_search_keys.node.mjs`. The load-bearing one is
 * the last: xterm's add-on reports `resultCount: -1` while it is still
 * counting, which the engine passes on as null, and painting that as
 * `no matches` would be a confident wrong answer a user acts on by
 * giving up.
 */
import { describe, expect, test } from 'vitest';

import { countLabel } from './count-label';

describe('what the counter says', () => {
    test('a history load in flight says so, whatever else is true', () => {
        expect(countLabel({ history: 'pending', query: 'x', results: null })).toBe(
            'loading history...',
        );
    });

    test('an empty box says nothing, once the history is in', () => {
        expect(countLabel({ history: 'painted', query: '', results: null })).toBe('');
        expect(countLabel({ history: 'already', query: '', results: null })).toBe('');
    });

    test('an empty box after a FAILED history load says what it can see', () => {
        expect(countLabel({ history: 'unavailable', query: '', results: null })).toBe(
            'searching recent output only',
        );
    });

    test('a real count reads "n of N", one-based', () => {
        expect(
            countLabel({
                history: 'already',
                query: 'foo',
                results: { resultIndex: 2, resultCount: 9, limit: 1000 },
            }),
        ).toBe('3 of 9');
    });

    test('no index yet still counts from one rather than from zero', () => {
        expect(
            countLabel({
                history: 'already',
                query: 'foo',
                results: { resultIndex: null, resultCount: 9, limit: 1000 },
            }),
        ).toBe('1 of 9');
    });

    test('zero matches is said out loud', () => {
        expect(
            countLabel({ history: 'already', query: 'foo', results: { resultCount: 0 } }),
        ).toBe('no matches');
    });

    test('at the highlight cap the count is a floor, not a number', () => {
        expect(
            countLabel({
                history: 'already',
                query: 'e',
                results: { resultIndex: 4, resultCount: 1000, limit: 1000 },
            }),
        ).toBe('1000+');
    });

    test('NEGATIVE: an uncounted result paints NOTHING, never "no matches"', () => {
        for (const results of [null, {}, { resultCount: null }, { resultCount: undefined }]) {
            expect(countLabel({ history: 'already', query: 'foo', results })).toBe('');
        }
    });
});
