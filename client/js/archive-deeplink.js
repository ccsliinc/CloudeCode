/**
 * Parse and build the four archive routes.
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
 * symptom. ROUTE_PATTERNS is exported in order and parseWith() takes a
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
 * Pure. No DOM, no history API, no fetch, no globals beyond the export.
 */

console.log('[ArchiveDeeplink Module] Loading...');

(function () {
    'use strict';

    /** Path prefix every archive route lives under. @type {string} */
    var ARCHIVE_PREFIX = '/archive';

    /**
     * Query parameters permitted in an archive URL, and the only ones
     * build() will ever emit. ALLOWLIST BY DESIGN - see the header note
     * on resume cursors.
     * @type {string[]}
     */
    var QUERY_ALLOWLIST = ['q', 'scope'];

    /**
     * The four routes, in MATCH ORDER. Line before transcript; see the
     * header. Exported so a test can reorder or relax a pattern and
     * assert what actually protects the line route.
     * @type {Array<{view: string, rx: RegExp, keys: string[]}>}
     */
    var ROUTE_PATTERNS = [
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
          keys: [] }
    ];

    /**
     * Description: is this string a bare non-negative decimal integer?
     *   Rejects '5767abc', '', '-1', '1.0', '0x5', ' 5767' and 'journal'.
     *   Used by the BUILDERS; the parsers get the same guarantee from
     *   their anchored [0-9]+ patterns.
     * Inputs: v (*) - candidate id, string or number.
     * Output: boolean.
     */
    function _isNumericId(v) {
        if (typeof v === 'number') {
            return isFinite(v) && Math.floor(v) === v && v >= 0;
        }
        if (typeof v !== 'string') return false;
        return /^[0-9]+$/.test(v);
    }

    /**
     * Description: split a query string into an object, keeping only the
     *   allowlisted keys. Hand-rolled rather than URLSearchParams so this
     *   file has no dependency on a global that a bare vm sandbox may not
     *   define.
     * Inputs: search (string) - '?q=hazard&scope=transcript', with or
     *   without the leading '?'. Anything else yields {}.
     * Output: object - allowlisted keys only, values decoded.
     * Example: _parseQuery('?q=hazard&cursor=abc') // -> {q: 'hazard'}
     */
    function _parseQuery(search) {
        var out = {};
        if (typeof search !== 'string' || search === '' || search === '?') return out;
        var body = search.charAt(0) === '?' ? search.slice(1) : search;
        var parts = body.split('&');
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === '') continue;
            var eq = parts[i].indexOf('=');
            var rawKey = eq === -1 ? parts[i] : parts[i].slice(0, eq);
            var rawVal = eq === -1 ? '' : parts[i].slice(eq + 1);
            var key;
            try {
                key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
            } catch (e) {
                // A malformed percent-escape is not a key we can name.
                // Skipping it is safe here because the allowlist below
                // would have to accept it anyway, and no allowlisted key
                // needs escaping.
                continue;
            }
            if (QUERY_ALLOWLIST.indexOf(key) === -1) continue;
            try {
                out[key] = decodeURIComponent(rawVal.replace(/\+/g, ' '));
            } catch (e2) {
                continue;
            }
        }
        return out;
    }

    /**
     * Description: render an allowlisted query object back into a query
     *   string, in ALLOWLIST ORDER so a round trip is byte-stable.
     * Inputs: query (object|null) - candidate parameters. Any key not in
     *   QUERY_ALLOWLIST is dropped silently, which is the whole point.
     * Output: string - '' or '?k=v&k2=v2'.
     * Example: _buildQuery({q: 'hazard', resume_cursor: 'eyJ...'})
     *          // -> '?q=hazard'   (the cursor is not emitted)
     */
    function _buildQuery(query) {
        if (!query || typeof query !== 'object') return '';
        var parts = [];
        for (var i = 0; i < QUERY_ALLOWLIST.length; i++) {
            var key = QUERY_ALLOWLIST[i];
            if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
            var val = query[key];
            if (val === null || val === undefined || val === '') continue;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
        }
        return parts.length ? '?' + parts.join('&') : '';
    }

    /**
     * Description: parse an archive path against an explicit, ordered
     *   pattern list. The list is a parameter so a test can prove the
     *   ordering is what protects the line route.
     * Inputs: patterns (Array) - same shape as ROUTE_PATTERNS, in match
     *           order.
     *         pathname (string) - e.g. '/archive/t/5767/l/1695'.
     *         search (string, optional) - e.g. '?q=hazard'.
     * Output: {ok: true, route: {view, projectId, transcriptId, lineNo,
     *            query}}
     *      or {ok: false, token: 'no-match', reason: string}
     *           - not an archive path at all; the router must fall
     *             through to its other route tables.
     *      or {ok: false, token: 'cannot-determine', reason: string}
     *           - an archive path this client cannot resolve. The reason
     *             names the offending segment. NOT a redirect.
     * Example:
     *   parseWith(ROUTE_PATTERNS, '/archive/t/5767/l/1695')
     *   // -> {ok: true, route: {view: 'line', transcriptId: 5767,
     *   //      lineNo: 1695, projectId: null, query: {}}}
     */
    function parseWith(patterns, pathname, search) {
        if (typeof pathname !== 'string') {
            return { ok: false, token: 'no-match',
                     reason: 'no path to parse' };
        }
        if (pathname !== ARCHIVE_PREFIX &&
            pathname.indexOf(ARCHIVE_PREFIX + '/') !== 0) {
            return { ok: false, token: 'no-match',
                     reason: String(pathname) + ' is not an archive route' };
        }

        var list = Array.isArray(patterns) ? patterns : ROUTE_PATTERNS;
        for (var i = 0; i < list.length; i++) {
            var m = list[i].rx.exec(pathname);
            if (!m) continue;
            var route = {
                view: list[i].view,
                projectId: null,
                transcriptId: null,
                lineNo: null,
                query: _parseQuery(search)
            };
            for (var k = 0; k < list[i].keys.length; k++) {
                // Every capture group in every pattern is [0-9]+, so
                // parseInt cannot produce NaN here.
                route[list[i].keys[k]] = parseInt(m[k + 1], 10);
            }
            return { ok: true, route: route };
        }

        return { ok: false, token: 'cannot-determine',
                 reason: _malformedReason(pathname) };
    }

    /**
     * Description: parse an archive path using the canonical ordered
     *   pattern list.
     * Inputs: pathname (string), search (string, optional).
     * Output: same as parseWith.
     * Example: parse('/archive/t/journal')
     *   // -> {ok: false, token: 'cannot-determine',
     *   //     reason: '"journal" is not a numeric transcript id'}
     */
    function parse(pathname, search) {
        return parseWith(ROUTE_PATTERNS, pathname, search);
    }

    /**
     * Description: say specifically what is wrong with an archive path
     *   that did not match, naming the offending segment. A generic "bad
     *   route" tells the reader nothing they can act on.
     * Inputs: pathname (string).
     * Output: string.
     */
    function _malformedReason(pathname) {
        var segments = pathname.split('/').filter(function (s) { return s !== ''; });
        // segments[0] is 'archive'.
        var kind = segments[1];
        if (kind === 't') {
            if (segments.length >= 3 && !_isNumericId(segments[2])) {
                return '"' + segments[2] + '" is not a numeric transcript id';
            }
            if (segments.length >= 5 && segments[3] === 'l' &&
                !_isNumericId(segments[4])) {
                return '"' + segments[4] + '" is not a numeric line number';
            }
            return '"' + pathname + '" is not a transcript route this ' +
                   'client recognises';
        }
        if (kind === 'p') {
            if (segments.length >= 3 && !_isNumericId(segments[2])) {
                return '"' + segments[2] + '" is not a numeric project id';
            }
            return '"' + pathname + '" is not a project route this client ' +
                   'recognises';
        }
        return '"' + pathname + '" is not an archive route this client ' +
               'recognises';
    }

    /**
     * Description: build the canonical path for a parsed route. The
     *   inverse of parse(), so build(parse(p).route) === p for every
     *   canonical p.
     * Inputs: route (object) - {view, projectId, transcriptId, lineNo,
     *   query}. Ids must be numeric; a non-numeric id returns null rather
     *   than a plausible-looking path.
     * Output: string path (with query), or null when the route cannot be
     *   built. NEVER a partial or fallback path: returning '/archive' for
     *   an unbuildable transcript route would be the silent redirect this
     *   module exists to prevent, moved to the other end.
     * Example: build({view: 'line', transcriptId: 5767, lineNo: 1695,
     *                 query: {q: 'hazard'}})
     *          // -> '/archive/t/5767/l/1695?q=hazard'
     */
    function build(route) {
        if (!route || typeof route !== 'object') return null;
        var qs = _buildQuery(route.query);
        switch (route.view) {
            case 'root':
                return ARCHIVE_PREFIX + qs;
            case 'project':
                if (!_isNumericId(route.projectId)) return null;
                return ARCHIVE_PREFIX + '/p/' + String(route.projectId) + qs;
            case 'transcript':
                if (!_isNumericId(route.transcriptId)) return null;
                return ARCHIVE_PREFIX + '/t/' + String(route.transcriptId) + qs;
            case 'line':
                if (!_isNumericId(route.transcriptId)) return null;
                if (!_isNumericId(route.lineNo)) return null;
                return ARCHIVE_PREFIX + '/t/' + String(route.transcriptId) +
                       '/l/' + String(route.lineNo) + qs;
            default:
                return null;
        }
    }

    /**
     * Description: path for the archive root.
     * Inputs: query (object, optional).
     * Output: string.
     */
    function buildRootPath(query) {
        return build({ view: 'root', query: query });
    }

    /**
     * Description: path for one project.
     * Inputs: projectId (number|string) - must be numeric.
     *         query (object, optional).
     * Output: string, or null when projectId is not numeric.
     */
    function buildProjectPath(projectId, query) {
        return build({ view: 'project', projectId: projectId, query: query });
    }

    /**
     * Description: path for one transcript. Returns null for anything
     *   non-numeric, which is how a session_ref is refused: a
     *   session_ref is not unique and cannot address a transcript.
     * Inputs: transcriptId (number|string) - must be numeric.
     *         query (object, optional).
     * Output: string, or null.
     * Example: buildTranscriptPath('journal')  // -> null
     */
    function buildTranscriptPath(transcriptId, query) {
        return build({ view: 'transcript', transcriptId: transcriptId,
                       query: query });
    }

    /**
     * Description: path for one line of one transcript.
     * Inputs: transcriptId (number|string), lineNo (number|string), both
     *   numeric. query (object, optional).
     * Output: string, or null.
     */
    function buildLinePath(transcriptId, lineNo, query) {
        return build({ view: 'line', transcriptId: transcriptId,
                       lineNo: lineNo, query: query });
    }

    window.ArchiveDeeplink = {
        parse: parse,
        parseWith: parseWith,
        build: build,
        buildRootPath: buildRootPath,
        buildProjectPath: buildProjectPath,
        buildTranscriptPath: buildTranscriptPath,
        buildLinePath: buildLinePath,
        ROUTE_PATTERNS: ROUTE_PATTERNS,
        QUERY_ALLOWLIST: QUERY_ALLOWLIST,
        ARCHIVE_PREFIX: ARCHIVE_PREFIX
    };
    console.log('[ArchiveDeeplink Module] Exported as window.ArchiveDeeplink');
})();
