/**
 * Every sentence the session data layer says when a probe did not answer.
 *
 * WHAT THIS REPLACES. `Launchpad._listingDetailFromError`,
 * `loadSessionAttribution`'s two failure branches, the malformed-array
 * branch inside `loadRunningSessions` and `loadProjects`'s
 * `showError('failed to load projects: ' + error.message)` each carried
 * their copy inline. That last one is the exact shape
 * `.claude/notes/i18n-design.md` names first: a `+ 'text'` concatenation
 * fixes word order, and word order is precisely what a translation
 * changes.
 *
 * A SERVER SENTENCE IS PASSED THROUGH, NOT TRANSLATED, and that is a
 * decision rather than a gap. The server's own `listing_detail` knows
 * things the browser cannot - which tmux command failed, what stderr
 * said - so it wins over any catalog message, exactly as it did before.
 * Server strings are out of scope for this round (i18n-design section 7);
 * what changed is that the BROWSER'S OWN sentences are no longer inline.
 *
 * A REASON TOKEN IS NOT COPY. `http_500`, `unauthorized`, `tmux_missing`
 * are identifiers compared against the server's vocabulary, and they stay
 * in web/src/lib/sessions/listing.ts untranslated. Only the second line,
 * the one written for a person, is assembled here.
 *
 * PURE, AND `t` IS AN ARGUMENT. It touches no DOM, no globals and no
 * locale of its own, so a test can drive it in the pseudo locale without
 * moving the running app's. Same shape as ./recent-session.js and
 * ./session-summary.js.
 *
 * THIS FILE IS SCANNED BY THE COVERAGE GUARD (`PORTED_FILES` in
 * web/src/lib/i18n/coverage.test.ts). A string literal here that reads
 * like a sentence fails the build.
 */

/**
 * The catalog keys this surface is built from, in one place.
 *
 * Description: exported so the coverage test can assert every one of them
 *   exists in the catalog, and so a reader chasing "where does that
 *   sentence come from" finds the answer without reading a function.
 *   Named for the DOMAIN concept - a listing, a record set, a project
 *   fetch - never for the screen, because the screen these paint on is
 *   being rewritten around them.
 */
export const LISTING_KEYS = {
    /** The second line under a CANNOT DETERMINE row, by cause. */
    detailUnauthorized: 'session.listing.detail.unauthorized',
    detailTmuxUnreadable: 'session.listing.detail.tmux_unreadable',
    detailHttpStatus: 'session.listing.detail.http_status',
    /** A 200 whose body was not the array it promised. */
    sessionsMalformed: 'session.listing.detail.malformed_sessions',
    recordsMalformed: 'session.listing.detail.malformed_records',
    /** The project list fetch, which reports through the error banner. */
    projectsLoadFailed: 'project.list.load_failed',
    /** The shared fallback when nothing named a cause. */
    unreachable: 'error.server_unreachable',
};

/**
 * Read the server's own explanation off a rejected API call.
 *
 * Description: `api.js` preserves a structured error body on
 *   `err.detail`. `listing_detail` is the server's sentence about THIS
 *   listing; `message` is its generic one. Either beats anything this
 *   client could say, so both are checked before the catalog is.
 * Inputs: err (any) - the rejection.
 * Output: string|null - null when the server said nothing.
 * Example: serverDetail(err)  // 'tmux exited 2: no server running'
 */
export function serverDetail(err) {
    const d = err && err.detail;
    if (d && typeof d === 'object') {
        if (typeof d.listing_detail === 'string' && d.listing_detail) return d.listing_detail;
        if (typeof d.message === 'string' && d.message) return d.message;
    }
    return null;
}

/**
 * The human explanation shown under a CANNOT DETERMINE session row.
 *
 * Description: same precedence the legacy `_listingDetailFromError` had,
 *   unchanged - the server's own text, then the status-specific
 *   sentence, then the error's own message, then the shared fallback.
 *   NEVER RETURNS AN EMPTY STRING: a blank cell is not an explanation,
 *   and a row that says nothing reads as a row with nothing wrong.
 * Inputs: err (any) - the rejection. status (number|null) - already
 *   parsed by the caller. t (function) - the translator.
 * Output: string - one short sentence.
 * Example: listingDetail(err, 401, t)  // 'sign in again to see your sessions'
 */
export function listingDetail(err, status, t) {
    const fromServer = serverDetail(err);
    if (fromServer) return fromServer;
    if (status === 401) return t(LISTING_KEYS.detailUnauthorized);
    if (status === 503) return t(LISTING_KEYS.detailTmuxUnreadable);
    if (typeof status === 'number' && status > 0) {
        return t(LISTING_KEYS.detailHttpStatus, { status });
    }
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return t(LISTING_KEYS.unreachable);
}

/**
 * The explanation when `GET /sessions/attachable` answered a 200 whose
 * body was not an array.
 *
 * Description: a 200 that did not parse is NOT an empty list, it is an
 *   unparseable one, and saying zero there would be the same invented
 *   verdict as swallowing a rejection.
 * Inputs: t (function). Output: string.
 * Example: sessionsMalformedDetail(t)
 */
export function sessionsMalformedDetail(t) {
    return t(LISTING_KEYS.sessionsMalformed);
}

/**
 * The same, for `GET /sessions/records`.
 *
 * Inputs: t (function). Output: string.
 * Example: recordsMalformedDetail(t)
 */
export function recordsMalformedDetail(t) {
    return t(LISTING_KEYS.recordsMalformed);
}

/**
 * The explanation stored when the attribution fetch REJECTED.
 *
 * Description: the error's own message when it has one, because it is
 *   usually the transport fact a reader needs, and the shared fallback
 *   otherwise. Mirrors what `loadSessionAttribution`'s catch stored.
 * Inputs: error (any). t (function). Output: string.
 * Example: attributionFailedDetail(error, t)
 */
export function attributionFailedDetail(error, t) {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return t(LISTING_KEYS.unreachable);
}

/**
 * The banner text when `GET /projects` itself failed.
 *
 * Description: one message with a `{reason}` hole, replacing the
 *   `'failed to load projects: ' + error.message` concatenation. The
 *   colon and the word order now belong to the message, where a
 *   translator can move them.
 * Inputs: error (any). t (function). Output: string.
 * Example: projectsLoadFailed(error, t)
 */
export function projectsLoadFailed(error, t) {
    const reason = (error && typeof error.message === 'string' && error.message)
        ? error.message
        : t(LISTING_KEYS.unreachable);
    return t(LISTING_KEYS.projectsLoadFailed, { reason });
}
