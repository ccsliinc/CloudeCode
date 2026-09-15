/**
 * The transcript list's PURE DECISIONS: what a row leads with, what its
 * title-source badge says, which of its columns a fuzzy filter can see,
 * and the two honesty sentences under the list.
 *
 * WHAT CHANGED IN THE PORT, AND WHY IT IS SMALLER. The vanilla
 * `archive-tlist-row.js` was pure functions AND a DOM builder in one
 * file: `renderRow` created elements, set attributes and attached a
 * listener. In Svelte the markup is the template, so the DOM half has no
 * counterpart here and `TranscriptRow.svelte` owns it. What remains is
 * exactly the part that was always a decision rather than a drawing, and
 * it is the part that needs testing: every function below is a pure
 * function of its arguments, callable with no document at all.
 *
 * FORMATTING IS SLICE 2's AND IS IMPORTED, NOT REIMPLEMENTED. The
 * vanilla file wrote `window.ArchiveFormat ? ... : String(n)` at four
 * call sites, a fallback that silently produced `1451` where the UI
 * meant `1,451` whenever the script had not loaded. `format.ts` is a
 * module import, so the fallback is not a smaller risk here, it is not a
 * reachable state.
 *
 * Ported from client/js/archive-tlist-row.js. No DOM. No globals.
 */
import { formatCount, formatTimestamp } from './format';
import {
    SCHEME_FILTERS,
    TITLE_SOURCES,
    TITLE_SOURCE_NONE,
    TITLE_SOURCE_UNKNOWN,
    UNESTABLISHED_ATTRIBUTION,
    type TitleSourceDef,
} from './tlist-vocab';

/**
 * One transcript row as the archive list routes return it.
 *
 * Description: every field optional because the server's own envelope
 *   makes them so - a `title` may be null because there is no name or
 *   because the lookup failed, and those are different findings that
 *   `titleSource` below tells apart. `transcript_id` is the only
 *   identity; `session_ref` is display text and NEVER a key (measured:
 *   `journal` names 14 different transcripts, `audit` 5).
 */
export interface TranscriptRowData {
    readonly transcript_id?: number | string | null;
    readonly session_ref?: string | null;
    readonly session_ref_scheme?: string | null;
    readonly title?: string | null;
    readonly title_source?: string | null;
    readonly host_attribution?: string | null;
    readonly line_count?: number | null;
    readonly raw_byte_length?: number | null;
    readonly ingested_at?: string | null;
}

/** The server's `meta.filters` block, as far as this file reads it. */
export interface FilterMeta {
    readonly applied?: boolean;
    readonly session_ref_scheme?: string;
    readonly matched_in_scope?: number;
    readonly scope_total_before_filter?: number;
    readonly session_ref_scheme_means?: string;
}

/**
 * Translate a UI filter choice into the wire value the server takes, or
 * null for "do not send the parameter".
 *
 * Description: `null` and `'all'` are NOT interchangeable on the wire.
 *   Sending `session_ref_scheme=all` is an UNKNOWN scheme and answers
 *   400, so "no filter" has to be an omitted parameter rather than a
 *   parameter meaning nothing.
 * Inputs: scheme - a SCHEME_FILTERS value.
 * Output: the wire value, or null to omit the parameter.
 * Example: wireScheme('all') // -> null
 */
export function wireScheme(scheme: string | null | undefined): string | null {
    if (!scheme || scheme === SCHEME_FILTERS.ALL) return null;
    return scheme;
}

/**
 * Whether an attribution field states a real finding or states that
 * nothing was established.
 *
 * Inputs: value - the row's `host_attribution`, whatever it holds.
 * Output: true when the link was NOT established.
 * Example: isUnestablished('cannot_determine') // -> true
 */
export function isUnestablished(value: unknown): boolean {
    return UNESTABLISHED_ATTRIBUTION.indexOf(String(value)) !== -1;
}

/**
 * Classify a row's `title_source` into how it renders.
 *
 * Description: total - every input lands on exactly one descriptor, so
 *   an unrecognised value can never be presented as a chosen name.
 *
 *   THE FAILED LOOKUP IS CHECKED FIRST, AND THAT ORDER IS THE WHOLE
 *   POINT. The server ships `title: null, title_source: 'cannot_determine'`
 *   when it could not READ the title records, and `title: null,
 *   title_source: null` when it looked and there is genuinely no name.
 *   Testing the empty title first collapses the two into NOT NAMED,
 *   reporting a measurement the server explicitly declined to make.
 * Inputs: row - one transcript row, or null.
 * Output: one of TITLE_SOURCES' entries, TITLE_SOURCE_NONE or
 *   TITLE_SOURCE_UNKNOWN.
 * Example: titleSource({title: 'x', title_source: 'last-prompt'}).kind
 *          // -> 'weak'
 */
export function titleSource(
    row: TranscriptRowData | null | undefined,
): TitleSourceDef {
    const r = row || {};
    const src = String(r.title_source);
    // Read ONCE and test the value, rather than calling hasOwnProperty and
    // then indexing again: two lookups can disagree under a strict index
    // signature, and the second one is the branch that would return
    // undefined where the type says it cannot.
    const known = Object.prototype.hasOwnProperty.call(TITLE_SOURCES, src)
        ? TITLE_SOURCES[src]
        : undefined;
    if (known && src === 'cannot_determine') return known;
    const t = r.title;
    if (typeof t !== 'string' || t.length === 0) return TITLE_SOURCE_NONE;
    if (known) return known;
    return TITLE_SOURCE_UNKNOWN;
}

/** What a row leads with, and whether that text is actually a name. */
export interface DisplayTitle {
    readonly text: string;
    readonly isTitle: boolean;
}

/**
 * The text that LEADS the row, and whether it is a name.
 *
 * Description: THE FALLBACK MUST NOT IMPLY A NAME EXISTS. With no title
 *   the row leads with the session_ref, which is a file-derived
 *   reference, so `isTitle` comes back false and the caller styles it as
 *   the reference it is, beside a NOT NAMED marker. Rendering the ref in
 *   the title's own treatment would present every unnamed session as
 *   though somebody had named it after its UUID.
 * Inputs: row - one transcript row, or null.
 * Output: the text to lead with and whether it is a name.
 * Example: displayTitle({session_ref: 'journal'})
 *          // -> {text: 'journal', isTitle: false}
 */
export function displayTitle(
    row: TranscriptRowData | null | undefined,
): DisplayTitle {
    const r = row || {};
    if (typeof r.title === 'string' && r.title.length > 0) {
        return { text: r.title, isTitle: true };
    }
    if (typeof r.session_ref === 'string' && r.session_ref.length > 0) {
        return { text: r.session_ref, isTitle: false };
    }
    return { text: 'no name and no session_ref recorded', isTitle: false };
}

/**
 * Read one FUZZY-FILTERABLE column out of a row, as the string that is
 * actually on screen.
 *
 * Description: filtering a value the person cannot see - a raw epoch
 *   behind a formatted date - makes a filter that fails for reasons
 *   nobody can inspect. So the date column is the FORMATTED date, which
 *   is why this function has to reach `format.ts` rather than being a
 *   property read.
 * Inputs: row - one transcript row. key - 'title', 'ref' or 'date'.
 * Output: the on-screen string, or '' for an unknown column.
 * Example: rowValue({ingested_at: '2026-08-31T00:00:00Z'}, 'date')
 */
export function rowValue(
    row: TranscriptRowData | null | undefined,
    key: string,
): string {
    const r = row || {};
    if (key === 'title') return displayTitle(r).text;
    if (key === 'ref') {
        return typeof r.session_ref === 'string' ? r.session_ref : '';
    }
    if (key === 'date') return formatTimestamp(r.ingested_at);
    return '';
}

/**
 * The sentence under the list, built from what the SERVER reported
 * rather than from what this file counted.
 *
 * Description: it states three separate things and does not merge them -
 *   how many rows are on screen, how many the whole scope holds under
 *   this filter, and what the filter is actually matching on. The third
 *   comes from the server's own `session_ref_scheme_means`, so there is
 *   one wording and it cannot drift from the API's.
 * Inputs: loaded - rows on screen. filters - the server's `meta.filters`
 *   block, or null when the last response carried none.
 * Output: the sentence, or '' when no filter is applied.
 * Example: describeFilter(50, {applied: true, matched_in_scope: 77,
 *          scope_total_before_filter: 3416, session_ref_scheme: 'uuid'})
 */
export function describeFilter(
    loaded: number,
    filters: FilterMeta | null | undefined,
): string {
    if (!filters || filters.applied !== true) return '';
    const noun = filters.session_ref_scheme === SCHEME_FILTERS.CONVERSATIONS
        ? 'conversations (uuid scheme)'
        : 'agent sidechains';
    let line = `Showing ${formatCount(loaded)} ${noun}.`;
    if (typeof filters.matched_in_scope === 'number') {
        line += ' The server filtered the WHOLE scope, which holds '
            + `${formatCount(filters.matched_in_scope)} rows with this scheme`;
        if (typeof filters.scope_total_before_filter === 'number') {
            line += ` out of ${formatCount(filters.scope_total_before_filter)}`;
        }
        line += '.';
    } else {
        line += ' The server did not report how many rows in this scope'
            + ' carry this scheme, so that number is NOT KNOWN.';
    }
    if (typeof filters.session_ref_scheme_means === 'string') {
        line += ` Caveat from the server: ${filters.session_ref_scheme_means}`;
    }
    return line;
}

/**
 * The fuzzy filter's OWN honesty line, describing the rows fetched so
 * far and NOTHING else.
 *
 * Description: `hasMore` is THREE-VALUED and each value is a different
 *   sentence. `true` means there are more pages, `false` means the list
 *   is complete, and `null` means the server did not say - which is not
 *   the same as saying there is nothing more, and rendering it as the
 *   complete case would claim the end of a list that was never read.
 * Inputs: shown - rows after filtering. loaded - rows fetched.
 *   hasMore - as received, three-valued. active - is any column filtered.
 * Output: the sentence, or '' when no column is filtered.
 * Example: fuzzyNote(3, 50, null, true)  // ends '...NOT KNOWN, so rows...'
 */
export function fuzzyNote(
    shown: number,
    loaded: number,
    hasMore: boolean | null,
    active: boolean,
): string {
    if (!active) return '';
    let line = `Name/ref/date filter: ${shown} of the ${loaded}`
        + ' rows LOADED SO FAR match. This filter runs in the browser over'
        + ' the rows already fetched - it does not ask the server, and it'
        + ' cannot see a row on a page nobody has loaded.';
    if (hasMore === true) {
        line += ' There ARE more pages in this scope; load them to filter them.';
    } else if (hasMore !== false) {
        line += ' Whether more pages exist: NOT KNOWN, so rows may be'
            + ' missing from what this filter can reach.';
    }
    return line;
}

/**
 * Advance to the next scheme filter, which is what the `t` key does.
 *
 * Description: THE CYCLE ORDER IS `SCHEME_DEFS`, which is also the order
 *   the options are drawn in, so the keyboard order and the visual order
 *   are one declaration and cannot drift into disagreeing about what
 *   "next" means.
 *
 *   An unrecognised current value yields index -1, and -1 + 1 is 0, so
 *   the cycle RESTARTS at 'all' rather than throwing or sticking. That
 *   is a deliberate recovery, not an accident of the arithmetic.
 * Inputs: current - the scheme in force. defs - the scheme table.
 * Output: the next scheme's wire value.
 * Example: nextScheme('all', SCHEME_DEFS) // -> 'uuid'
 */
export function nextScheme(
    current: string,
    defs: readonly { readonly v: string }[],
): string {
    if (defs.length === 0) return current;
    let at = -1;
    for (let i = 0; i < defs.length; i++) {
        if (defs[i]?.v === current) { at = i; break; }
    }
    const next = defs[(at + 1) % defs.length];
    // An empty table already returned above, so this cannot miss; the
    // fallback is what keeps that reasoning checkable rather than asserted
    // with a non-null assertion.
    return next ? next.v : current;
}

/**
 * The label of the scheme in force, or a NAMED unknown.
 *
 * Description: an unrecognised value is named rather than silently shown
 *   as the first option. A control that displays a choice nobody made is
 *   how a filter becomes untrustworthy.
 * Inputs: scheme - the value in force. defs - the scheme table.
 * Output: the label, or 'UNKNOWN FILTER (<value>)'.
 * Example: activeSchemeLabel('zzz', SCHEME_DEFS)
 *          // -> 'UNKNOWN FILTER (zzz)'
 */
export function activeSchemeLabel(
    scheme: string,
    defs: readonly { readonly v: string; readonly label: string }[],
): string {
    for (const def of defs) {
        if (def.v === scheme) return def.label;
    }
    return `UNKNOWN FILTER (${String(scheme)})`;
}
