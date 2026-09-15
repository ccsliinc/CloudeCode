/**
 * THE FUZZY MATCHER, AS AN INJECTED DEPENDENCY RATHER THAN A GLOBAL.
 *
 * WHY AN INTERFACE AND NOT A PORT. `client/js/archive-fuzzy.js` is not
 * one of slice 6's four source files and has no Svelte counterpart yet.
 * Reaching for `window.ArchiveFuzzy` from inside a component would put a
 * global back into a tree whose whole point is that a plugin reaches for
 * nothing - the same reasoning `state.ts` gives for injecting
 * `OutcomeClassifier` rather than importing `window.ArchiveOutcome`.
 * When the matcher is ported, it satisfies this interface and the
 * injection site is the only thing that changes.
 *
 * ABSENT IS A SUPPORTED STATE AND IT IS THE VANILLA BEHAVIOUR. The
 * original wrote `if (!window.ArchiveFuzzy || !isActive(q)) return every
 * row unhighlighted`, so a list with no matcher shows everything and
 * marks nothing. That is carried across exactly: `visibleRows` with a
 * null matcher is the identity function over the rows. It is a fallback
 * that already existed, not one invented here.
 */
import type { TranscriptRowData } from './tlist-row';

/** A [start, end) character range that matched, as the matcher reports it. */
export type MatchSpan = readonly [number, number];

/** Match spans per fuzzy column key ('title', 'ref', 'date'). */
export type SpanMap = Readonly<Record<string, readonly MatchSpan[] | undefined>>;

/** One segment of a label, and whether it was matched. */
export interface LabelSegment {
    readonly text: string;
    readonly hit: boolean;
}

/** One ranked row and the spans that put it there. */
export interface RankedRow {
    readonly row: TranscriptRowData;
    readonly spans: SpanMap;
}

/**
 * What this list needs from a fuzzy matcher. Three methods, the same
 * three `window.ArchiveFuzzy` already exports.
 */
export interface FuzzyMatcher {
    /** Is any column actually being filtered? */
    isActive(queries: Readonly<Record<string, string>>): boolean;
    /** Rank and filter rows, reading each column through `valueOf`. */
    rank(
        rows: readonly TranscriptRowData[],
        queries: Readonly<Record<string, string>>,
        valueOf: (row: TranscriptRowData, key: string) => string,
    ): readonly RankedRow[];
    /** Split `text` into matched and unmatched segments. */
    segments(text: string, spans: readonly MatchSpan[]): readonly LabelSegment[];
}

/**
 * The rows to draw, after the CLIENT-side fuzzy filter, each with its
 * match spans.
 *
 * Description: THE TWO FILTERS ARE APPLIED IN DIFFERENT PLACES ON
 *   PURPOSE. The scheme filter is the SERVER's and has already narrowed
 *   the rows across the whole scope, so it is never re-applied here - a
 *   second, invisible copy of that rule could disagree with the counts
 *   the honesty note quotes. The fuzzy filter is this client's and can
 *   only ever see what has been fetched, which is exactly what its own
 *   note says.
 * Inputs: rows - every row fetched so far. queries - the typed text per
 *   column. matcher - the injected matcher, or null. valueOf - reads one
 *   on-screen column off a row.
 * Output: the rows to draw, with spans. Every row, unhighlighted, when
 *   there is no matcher or nothing is typed.
 * Example: visibleRows(rows, {title: 'dep'}, fuzzy, rowValue)
 */
export function visibleRows(
    rows: readonly TranscriptRowData[],
    queries: Readonly<Record<string, string>>,
    matcher: FuzzyMatcher | null | undefined,
    valueOf: (row: TranscriptRowData, key: string) => string,
): readonly RankedRow[] {
    if (!matcher || !matcher.isActive(queries)) {
        return rows.map((row) => ({ row, spans: {} as SpanMap }));
    }
    return matcher.rank(rows, queries, valueOf);
}

/**
 * Is any column being filtered right now?
 *
 * Description: routed through the matcher rather than answered by
 *   reading the strings here, because "active" is the matcher's own
 *   definition - a query of whitespace is not active, and this module
 *   should not hold a second opinion about that.
 * Inputs: queries - the typed text per column. matcher - or null.
 * Output: false when there is no matcher, which is what makes an absent
 *   matcher a list with no filter rather than a list with a broken one.
 * Example: isFiltering({title: ''}, fuzzy) // -> false
 */
export function isFiltering(
    queries: Readonly<Record<string, string>>,
    matcher: FuzzyMatcher | null | undefined,
): boolean {
    return !!matcher && matcher.isActive(queries);
}
