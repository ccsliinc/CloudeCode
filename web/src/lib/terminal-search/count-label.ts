/**
 * The words on the search panel's counter.
 *
 * PORTED VERBATIM FROM `client/js/terminal-search-chrome.js::countLabel`.
 * A pure function of what the panel currently knows, so all five of its
 * distinguishable states are drivable in five lines.
 *
 * ABSENT IS NOT ZERO, and that is the rule this exists to hold. xterm's
 * search add-on reports `resultCount: -1` while it is still counting,
 * which the engine passes on as null. Painting that as `no matches`
 * would be a confident, wrong answer about a buffer nobody has finished
 * reading, and a user acts on it by giving up. An unknown count paints
 * NOTHING instead.
 */
import type { EngineResults, HistoryState } from './types';

/** xterm's own highlight cap, used when the engine reports no limit. */
const DEFAULT_LIMIT = 1000;

/** What the counter is a function of. */
export interface CountState {
    history: HistoryState;
    query: string;
    results: EngineResults | null;
}

/**
 * The counter's text.
 *
 * Inputs: state (CountState) - `history` is null / 'pending' / 'painted'
 *   / 'already' / 'unavailable'; `results` is the engine's report, where
 *   a null count means NOT COUNTED YET rather than zero.
 * Output: string - the label, possibly empty.
 * Example:
 *   countLabel({history: 'already', query: 'foo',
 *               results: {resultIndex: 2, resultCount: 9, limit: 1000}})
 *   // => '3 of 9'
 */
export function countLabel(state: CountState): string {
    if (state.history === 'pending') return 'loading history...';
    if (!state.query) {
        // The one thing worth saying with an empty box: that this search
        // can only see what is in the terminal, because the history load
        // did not happen.
        return state.history === 'unavailable' ? 'searching recent output only' : '';
    }
    const r = state.results;
    if (!r || r.resultCount === null || r.resultCount === undefined) return '';
    if (r.resultCount === 0) return 'no matches';
    const limit = r.limit || DEFAULT_LIMIT;
    // At the add-on's highlight cap the count stops being exact, so it is
    // reported as a floor rather than as a number.
    if (r.resultCount >= limit) return `${limit}+`;
    const n = r.resultIndex === null || r.resultIndex === undefined ? 1 : r.resultIndex + 1;
    return `${n} of ${r.resultCount}`;
}
