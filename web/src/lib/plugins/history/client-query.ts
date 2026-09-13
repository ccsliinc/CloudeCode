/**
 * The query-string builder and the deadline table, split out of
 * `client.ts` so neither file grows past this repo's 500-line cap.
 *
 * Both are PURE DATA ABOUT REQUESTS and are the two things every one of
 * the thirteen endpoints touches, so they are the natural cut: the
 * endpoints are what changes when a route is added, and these two are
 * what changes when the rules about requests themselves change.
 *
 * THE DEADLINES MOVED HERE FROM `client/js/api.js`, WHERE THEY WERE THE
 * ONLY ARCHIVE-SHAPED THING LEFT IN THE LEGACY CLIENT. They belong to
 * the archive's own request classes, nothing outside the archive read
 * them (measured: one definition site, one consumer), and leaving a copy
 * behind would be two tables that drift.
 */

/** The deadline table, by request class. Milliseconds. */
export interface ArchiveTimeouts {
    /** Hosts, corpora, projects, unattributed, for-cwd. */
    readonly hierarchy: number;
    /** One transcript, its lines, its messages, its subagents. */
    readonly transcript: number;
    /** One message body. The longest, and deliberately so. */
    readonly body: number;
    /** Search across a scope. */
    readonly search: number;
    /** An export header preflight. */
    readonly exportPreflight: number;
}

/**
 * The deadlines, as measured against the live corpus.
 *
 * `body` is the longest because a single body in this corpus measured
 * 54,376,879 bytes, which is a legitimately slow transfer rather than a
 * hung request. A request with NO deadline is the case none of these
 * may become: it is a state that can never fail, so a view waiting on it
 * can never answer "what happened".
 */
export const ARCHIVE_TIMEOUTS: ArchiveTimeouts = {
    hierarchy: 10000,
    transcript: 15000,
    body: 30000,
    search: 45000,
    exportPreflight: 20000,
};

/** One query parameter's value, before it is serialised. */
export type QueryValue = string | number | boolean | null | undefined;

/**
 * Build a query string from named params, dropping every unset one.
 *
 * Description: A NULL THAT REACHES THE WIRE AS `&cursor=null` IS A
 *   MALFORMED CURSOR, and the server correctly answers
 *   `cannot_determine` for it - a third outcome this client would have
 *   inflicted on itself. Only params with a real value are serialised.
 *
 *   THE TEST IS AGAINST null, undefined AND '' EXPLICITLY, NEVER
 *   FALSINESS. `start_line: 0` is a real request for the first line of a
 *   transcript, and `if (!value)` would drop it silently, returning an
 *   unpositioned page that happens to look right. `false` is likewise a
 *   real value for `case_sensitive` and `include_bodies`.
 * Inputs: params - name to value; null, undefined and '' are dropped.
 * Output: '' or '?a=1&b=2', already percent-encoded.
 * Example: archiveQuery({limit: 50, cursor: null})   // -> '?limit=50'
 *          archiveQuery({start_line: 0})             // -> '?start_line=0'
 */
export function archiveQuery(params: Record<string, QueryValue>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params || {})) {
        if (value === null || value === undefined || value === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
}
