/**
 * Parse and build the four archive routes. PORTED from
 * `client/js/archive-deeplink.js`, which is deleted in the same commit.
 *
 * THE ROUTES
 *   /archive                    root, rail loaded, nothing selected
 *   /archive/p/<id>             project <id>, transcript list loaded
 *   /archive/t/<id>             transcript <id> open in the reader
 *   /archive/t/<id>/l/<n>       transcript <id>, scrolled to line <n>
 *
 * NUMERIC TRANSCRIPT IDS ONLY. `session_ref` NEVER APPEARS IN A URL.
 * Measured 2026-08-31 against the live corpus: `session_ref` is not
 * unique and is not close to unique. "journal" is the session_ref of
 * FOURTEEN different transcripts, "audit" of five, "agent-a877057" of
 * four. A route /archive/s/journal cannot resolve to a transcript, and
 * the failure mode is the worst one available: it would resolve to one
 * of fourteen with no error at all, so the link works for the sender and
 * shows the recipient a different document. Nineteen transcripts also
 * carry session_ref_scheme='uuid' while their session_ref is not a UUID,
 * so even a route that keyed on "the ones that look like UUIDs" would be
 * keying on a field whose own scheme label is wrong.
 *
 * WHY THE PATTERN LIST IS ORDERED AND EXPORTED. The LINE pattern must be
 * tested BEFORE the TRANSCRIPT pattern. As written both are anchored, so
 * today they are mutually exclusive and the order is not load-bearing.
 * The order is enforced anyway, because the first person to relax the
 * transcript pattern - dropping the `$`, adding an optional suffix -
 * makes it swallow /archive/t/5767/l/1695, drop the line number, and
 * land the reader at line 0 of the right transcript with no error and no
 * symptom. ROUTE_PATTERNS is exported in order and `parseWith` takes a
 * pattern list, so a test can substitute a deliberately relaxed
 * transcript pattern and prove the ORDERING saves it rather than proving
 * the anchoring does.
 *
 * A NON-NUMERIC SEGMENT IS A cannot-determine, NOT A REDIRECT. Pasting
 * /archive/t/notanumber gets a visible, specific error naming the
 * segment. It does NOT silently land on /archive, because a silent
 * redirect tells the person their link was fine and the thing they
 * wanted simply was not there.
 *
 * NO RESUME CURSOR EVER REACHES A URL. The query allowlist below is an
 * ALLOWLIST, not a denylist, so a query parameter invented later is
 * dropped by default rather than published by default. Measured
 * 2026-08-31, a budget_exhausted search returns a 147-character opaque
 * base64url resume_cursor encoding {bytes, line_no, scanned, t_id,
 * t_ingested_at, v}. It must never be shared: it is opaque, so a
 * recipient cannot tell what they are resuming, and it encodes a
 * position in ONE scan of a database a background ingest writes every
 * 900 seconds - a stale position in someone else's abandoned scan, which
 * is meaningless to the recipient and not obviously meaningless.
 *
 * WHAT THE PORT CHANGED, STATED SO THE DIFF IS NOT MISREAD. The logic is
 * unchanged and the suites that covered it were ported case for case.
 * What moved is the packaging: an IIFE publishing `window.ArchiveDeeplink`
 * became a module with named exports, and `var` became `const`. The one
 * behavioural addition is that `parse` now also answers the host's
 * `AppScreen.parse` contract, which it already satisfied - three
 * outcomes with the same two token spellings - so the surface took the
 * shape of the code rather than the other way round.
 *
 * Pure. No DOM, no history API, no fetch, no globals.
 */
import type { ScreenRouteResult } from '../types';

/** Path prefix every archive route lives under. */
export const ARCHIVE_PREFIX = '/archive';

/** The bare leading segment of that prefix, as `routePrefix` wants it. */
export const ARCHIVE_ROUTE_PREFIX = 'archive';

/** Label of the crumb's first segment, spelled once. */
export const CRUMB_ROOT_LABEL = 'ARCHIVE';

/** Separator drawn between crumb segments. */
export const CRUMB_SEPARATOR = '>';

/**
 * Query parameters permitted in an archive URL, and the only ones
 * `build` will ever emit. ALLOWLIST BY DESIGN - see the header note on
 * resume cursors.
 */
export const QUERY_ALLOWLIST: readonly string[] = ['q', 'scope'];

/** Which of the four shapes a route is. */
export type ArchiveView = 'root' | 'project' | 'transcript' | 'line';

/** One parsed archive location. Every field is present, most are null. */
export interface ArchiveRoute {
    view: ArchiveView;
    projectId: number | null;
    transcriptId: number | null;
    lineNo: number | null;
    query: Record<string, string>;
}

/** One entry in the ordered pattern list. */
export interface RoutePattern {
    readonly view: ArchiveView;
    readonly rx: RegExp;
    readonly keys: readonly ('transcriptId' | 'lineNo' | 'projectId')[];
}

/**
 * The four routes, in MATCH ORDER. Line before transcript; see the
 * header. Exported so a test can reorder or relax a pattern and assert
 * what actually protects the line route.
 */
export const ROUTE_PATTERNS: readonly RoutePattern[] = [
    { view: 'line',
      rx: /^\/archive\/t\/([0-9]+)\/l\/([0-9]+)\/?$/,
      keys: ['transcriptId', 'lineNo'] },
    { view: 'transcript',
      rx: /^\/archive\/t\/([0-9]+)\/?$/,
      keys: ['transcriptId'] },
    { view: 'project',
      rx: /^\/archive\/p\/([0-9]+)\/?$/,
      keys: ['projectId'] },
    { view: 'root',
      rx: /^\/archive\/?$/,
      keys: [] },
];

/**
 * Is this a bare non-negative decimal integer?
 *
 * Description: rejects '5767abc', '', '-1', '1.0', '0x5', ' 5767' and
 *   'journal'. Used by the BUILDERS; the parsers get the same guarantee
 *   from their anchored [0-9]+ patterns.
 * Inputs: v - candidate id, string or number.
 * Output: boolean.
 * Example: isNumericId('journal')  // -> false
 */
export function isNumericId(v: unknown): boolean {
    if (typeof v === 'number') {
        return isFinite(v) && Math.floor(v) === v && v >= 0;
    }
    if (typeof v !== 'string') return false;
    return /^[0-9]+$/.test(v);
}

/**
 * Split a query string into an object, keeping only allowlisted keys.
 *
 * Description: hand-rolled rather than URLSearchParams so this module
 *   has no dependency on a global a bare sandbox may not define.
 * Inputs: search - '?q=hazard&scope=transcript', with or without the
 *   leading '?'. Anything else yields {}.
 * Output: allowlisted keys only, values decoded.
 * Example: parseQuery('?q=hazard&cursor=abc')  // -> {q: 'hazard'}
 */
export function parseQuery(search: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (typeof search !== 'string' || search === '' || search === '?') return out;
    const body = search.charAt(0) === '?' ? search.slice(1) : search;
    for (const part of body.split('&')) {
        if (part === '') continue;
        const eq = part.indexOf('=');
        const rawKey = eq === -1 ? part : part.slice(0, eq);
        const rawVal = eq === -1 ? '' : part.slice(eq + 1);
        let key: string;
        try {
            key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        } catch {
            // A malformed percent-escape is not a key we can name.
            // Skipping it is safe because the allowlist below would have
            // to accept it anyway, and no allowlisted key needs escaping.
            continue;
        }
        if (QUERY_ALLOWLIST.indexOf(key) === -1) continue;
        try {
            out[key] = decodeURIComponent(rawVal.replace(/\+/g, ' '));
        } catch {
            continue;
        }
    }
    return out;
}

/**
 * Render an allowlisted query object back into a query string, in
 * ALLOWLIST ORDER so a round trip is byte-stable.
 * Inputs: query - candidate parameters. Any key not in QUERY_ALLOWLIST
 *   is dropped silently, which is the whole point.
 * Output: '' or '?k=v&k2=v2'.
 * Example: buildQuery({q: 'hazard', resume_cursor: 'eyJ...'})
 *          // -> '?q=hazard'   (the cursor is not emitted)
 */
export function buildQuery(query: Record<string, unknown> | null | undefined): string {
    if (!query || typeof query !== 'object') return '';
    const parts: string[] = [];
    for (const key of QUERY_ALLOWLIST) {
        if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
        const val = query[key];
        if (val === null || val === undefined || val === '') continue;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
    }
    return parts.length ? '?' + parts.join('&') : '';
}

/**
 * Say specifically what is wrong with an archive path that did not
 * match, naming the offending segment.
 *
 * Description: a generic "bad route" tells the reader nothing they can
 *   act on. This is what makes a `cannot-determine` worth having.
 * Inputs: pathname. Output: string.
 * Example: malformedReason('/archive/t/journal')
 *          // -> '"journal" is not a numeric transcript id'
 */
export function malformedReason(pathname: string): string {
    const segments = pathname.split('/').filter((s) => s !== '');
    // segments[0] is 'archive'.
    const kind = segments[1];
    if (kind === 't') {
        if (segments.length >= 3 && !isNumericId(segments[2])) {
            return '"' + segments[2] + '" is not a numeric transcript id';
        }
        if (segments.length >= 5 && segments[3] === 'l'
            && !isNumericId(segments[4])) {
            return '"' + segments[4] + '" is not a numeric line number';
        }
        return '"' + pathname + '" is not a transcript route this '
             + 'client recognises';
    }
    if (kind === 'p') {
        if (segments.length >= 3 && !isNumericId(segments[2])) {
            return '"' + segments[2] + '" is not a numeric project id';
        }
        return '"' + pathname + '" is not a project route this client '
             + 'recognises';
    }
    return '"' + pathname + '" is not an archive route this client '
         + 'recognises';
}

/**
 * Parse an archive path against an explicit, ordered pattern list.
 *
 * Description: the list is a parameter so a test can prove the ordering
 *   is what protects the line route, rather than proving the anchoring
 *   is.
 * Inputs: patterns - same shape as ROUTE_PATTERNS, in match order.
 *         pathname - e.g. '/archive/t/5767/l/1695'.
 *         search - e.g. '?q=hazard'.
 * Output: ScreenRouteResult<ArchiveRoute>.
 * Example:
 *   parseWith(ROUTE_PATTERNS, '/archive/t/5767/l/1695', '')
 *   // -> {ok: true, route: {view: 'line', transcriptId: 5767,
 *   //      lineNo: 1695, projectId: null, query: {}}}
 */
export function parseWith(
    patterns: readonly RoutePattern[],
    pathname: string,
    search?: string,
): ScreenRouteResult<ArchiveRoute> {
    if (typeof pathname !== 'string') {
        return { ok: false, token: 'no-match', reason: 'no path to parse' };
    }
    if (pathname !== ARCHIVE_PREFIX
        && pathname.indexOf(ARCHIVE_PREFIX + '/') !== 0) {
        return { ok: false, token: 'no-match',
                 reason: String(pathname) + ' is not an archive route' };
    }

    const list = Array.isArray(patterns) ? patterns : ROUTE_PATTERNS;
    for (const pattern of list) {
        const m = pattern.rx.exec(pathname);
        if (!m) continue;
        const route: ArchiveRoute = {
            view: pattern.view,
            projectId: null,
            transcriptId: null,
            lineNo: null,
            query: parseQuery(search ?? ''),
        };
        pattern.keys.forEach((key: 'transcriptId' | 'lineNo' | 'projectId', k: number) => {
            // Every capture group in every pattern is [0-9]+, so
            // parseInt cannot produce NaN here.
            route[key] = parseInt(m[k + 1], 10);
        });
        return { ok: true, route };
    }

    return { ok: false, token: 'cannot-determine',
             reason: malformedReason(pathname) };
}

/**
 * Parse an archive path using the canonical ordered pattern list.
 *
 * Description: this is the function the `app-screen` surface calls as
 *   `parse`, unchanged from what `router.js` already delegated to.
 * Inputs: pathname, search. Output: ScreenRouteResult<ArchiveRoute>.
 * Example: parse('/archive/t/journal', '')
 *   // -> {ok: false, token: 'cannot-determine',
 *   //     reason: '"journal" is not a numeric transcript id'}
 */
export function parse(pathname: string, search?: string): ScreenRouteResult<ArchiveRoute> {
    return parseWith(ROUTE_PATTERNS, pathname, search);
}

/**
 * Build the canonical path for a parsed route.
 *
 * Description: the inverse of `parse`, so build(parse(p).route) === p
 *   for every canonical p.
 * Inputs: route - {view, projectId, transcriptId, lineNo, query}. Ids
 *   must be numeric; a non-numeric id returns null rather than a
 *   plausible-looking path.
 * Output: the path with its query, or null when the route cannot be
 *   built. NEVER a partial or fallback path: returning '/archive' for an
 *   unbuildable transcript route would be the silent redirect this
 *   module exists to prevent, moved to the other end.
 * Example: build({view: 'line', transcriptId: 5767, lineNo: 1695,
 *                 query: {q: 'hazard'}})
 *          // -> '/archive/t/5767/l/1695?q=hazard'
 */
export function build(route: Partial<ArchiveRoute> | null | undefined): string | null {
    if (!route || typeof route !== 'object') return null;
    const qs = buildQuery(route.query as Record<string, unknown> | undefined);
    switch (route.view) {
        case 'root':
            return ARCHIVE_PREFIX + qs;
        case 'project':
            if (!isNumericId(route.projectId)) return null;
            return ARCHIVE_PREFIX + '/p/' + String(route.projectId) + qs;
        case 'transcript':
            if (!isNumericId(route.transcriptId)) return null;
            return ARCHIVE_PREFIX + '/t/' + String(route.transcriptId) + qs;
        case 'line':
            if (!isNumericId(route.transcriptId)) return null;
            if (!isNumericId(route.lineNo)) return null;
            return ARCHIVE_PREFIX + '/t/' + String(route.transcriptId)
                 + '/l/' + String(route.lineNo) + qs;
        default:
            return null;
    }
}

/** Path for the archive root. Inputs: query. Output: string. */
export function buildRootPath(query?: Record<string, unknown>): string | null {
    return build({ view: 'root', query: query as Record<string, string> });
}

/**
 * Path for one project.
 * Inputs: projectId - must be numeric. query.
 * Output: string, or null when projectId is not numeric.
 */
export function buildProjectPath(
    projectId: number | string, query?: Record<string, unknown>,
): string | null {
    return build({ view: 'project', projectId: projectId as number,
                   query: query as Record<string, string> });
}

/**
 * Path for one transcript.
 *
 * Description: returns null for anything non-numeric, which is how a
 *   session_ref is refused: a session_ref is not unique and cannot
 *   address a transcript.
 * Inputs: transcriptId - must be numeric. query.
 * Output: string, or null.
 * Example: buildTranscriptPath('journal')  // -> null
 */
export function buildTranscriptPath(
    transcriptId: number | string, query?: Record<string, unknown>,
): string | null {
    return build({ view: 'transcript', transcriptId: transcriptId as number,
                   query: query as Record<string, string> });
}

/**
 * Path for one line of one transcript.
 * Inputs: transcriptId, lineNo, both numeric. query.
 * Output: string, or null.
 */
export function buildLinePath(
    transcriptId: number | string, lineNo: number | string,
    query?: Record<string, unknown>,
): string | null {
    return build({ view: 'line', transcriptId: transcriptId as number,
                   lineNo: lineNo as number,
                   query: query as Record<string, string> });
}

/** The minimum of `window` this module drives. Injected, never read off a global. */
export interface HistoryWindow {
    location: { pathname: string; search: string };
    history: {
        pushState(state: unknown, title: string, url: string): void;
        replaceState(state: unknown, title: string, url: string): void;
    };
}

/**
 * Push or replace the address bar for a route.
 *
 * Description: IT LIVES HERE, BESIDE `build`, ON PURPOSE. The one place
 *   that BUILDS an archive path and the one place that WRITES it to the
 *   address bar cannot drift while they are the same module: a change to
 *   what a route looks like reaches the address bar in the same edit.
 * Inputs: route - the shape `build` takes.
 *         win - the window to drive. Injected rather than read off the
 *           global so a test can drive a stub; null means the real one.
 *         opts - {replace}. Default is a push, so Back returns to the
 *           previous archive location.
 * Output: the path written, or null when nothing was written. Null is a
 *   real answer with three causes, all legitimate: the route did not
 *   build, the path is already current, or the History API refused.
 * Example: syncUrl({view: 'transcript', transcriptId: 5767}, window)
 *          // -> '/archive/t/5767'
 */
export function syncUrl(
    route: Partial<ArchiveRoute> | null,
    win?: HistoryWindow | null,
    opts?: { replace?: boolean },
): string | null {
    const w = win || (typeof window !== 'undefined'
        ? (window as unknown as HistoryWindow) : null);
    if (!w || !w.location || !w.history) return null;
    const path = build(route);
    if (!path) return null;
    if (w.location.pathname + w.location.search === path) return null;
    try {
        if (opts && opts.replace) w.history.replaceState({}, '', path);
        else w.history.pushState({}, '', path);
    } catch (e) {
        // History API blocked (a sandboxed iframe refuses it). Same
        // tolerance router.js applies: navigation still works, the URL
        // simply does not follow. Logged with the path rather than
        // swallowed, so a silent address bar is diagnosable.
        console.warn('history: the History API refused ' + path, e);
        return null;
    }
    return path;
}
