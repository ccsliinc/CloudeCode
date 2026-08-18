/**
 * History viewer - the HTTP edge. One place that knows the endpoint URLs
 * and the three-outcome envelope, so no view has to.
 * ----------------------------------------------------------------------
 * EVERY CALL RESOLVES, NONE REJECT. The server answers `status: "ok"`,
 * `"no_matches"` or `"unavailable"` and uses HTTP 200 for all three on
 * purpose (see src/api/history.py's module docstring): the third outcome
 * is DATA, and a 5xx would be flattened into a generic error toast that
 * erases the reason. This layer extends that contract over the one case
 * the server cannot answer for - the request never arriving - by turning
 * a thrown fetch into the SAME envelope with `reason: "request_failed"`.
 *
 * That reason is deliberately its own value rather than being folded into
 * `db_missing` or `disabled`. "The archive told me it is unavailable" and
 * "I could not reach the archive to ask" are different facts, and a view
 * that showed them identically would be inventing a verdict about the
 * archive from a fact about the network.
 *
 * Authentication, token refresh and the 401 replay all belong to
 * `window.API.call` and are not re-implemented here.
 */

console.log('[HistoryAPI Module] Loading...');

(function () {
    'use strict';

    var BASE = '/history';

    /** Envelope statuses, mirroring src/api/history_support.py. */
    var STATUS_OK = 'ok';
    var STATUS_NO_MATCHES = 'no_matches';
    var STATUS_UNAVAILABLE = 'unavailable';

    /** Our own reason for "the call never reached the server". */
    var REASON_REQUEST_FAILED = 'request_failed';

    /**
     * Build a query string from a plain object, skipping empty values.
     *
     * Inputs: params (object) - values are stringified; null, undefined
     *   and "" are omitted so an unset filter does not become `?x=`.
     * Output: string - "" or "?a=1&b=2", percent-encoded.
     */
    function queryString(params) {
        var parts = [];
        Object.keys(params || {}).forEach(function (key) {
            var value = params[key];
            if (value === null || value === undefined || value === '') return;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    /**
     * Issue one authenticated GET and normalise its failure mode.
     *
     * Inputs: path (string) - e.g. "/history/projects", already encoded.
     * Output: Promise<object> - the response body, or an `unavailable`
     *   envelope with `reason: "request_failed"` when the request threw.
     *   Never rejects.
     */
    async function get(path) {
        try {
            var body = await window.API.call(path, { method: 'GET' });
            if (body && body.status) return body;
            // A 200 with no envelope is not something this API produces;
            // saying so beats rendering an empty list as an empty archive.
            return failure('the server answered but not in the expected shape');
        } catch (err) {
            console.error('HistoryAPI: request failed', path, err);
            return failure((err && err.message) || 'the request did not complete');
        }
    }

    /**
     * Build the local `unavailable` envelope for a failed request.
     *
     * Inputs: message (string) - a human sentence.
     * Output: object - an envelope shaped exactly like the server's.
     */
    function failure(message) {
        return {
            status: STATUS_UNAVAILABLE,
            reason: REASON_REQUEST_FAILED,
            message: message
        };
    }

    /**
     * Did this envelope carry data?
     *
     * Inputs: body (object|null).
     * Output: boolean - true only for `ok`. `no_matches` is a successful
     *   measurement of nothing and is NOT lumped in here, because the two
     *   render differently on purpose.
     */
    function isOk(body) {
        return !!body && body.status === STATUS_OK;
    }

    /**
     * Was this a completed search that matched nothing?
     *
     * Inputs: body (object|null). Output: boolean.
     */
    function isNoMatches(body) {
        return !!body && body.status === STATUS_NO_MATCHES;
    }

    /**
     * The sentence to show a reader when a call could not be evaluated.
     *
     * Inputs: body (object|null).
     * Output: string - the server's own message when it sent one, else a
     *   sentence naming the reason. Never empty: a blank cell is the
     *   failure this whole contract exists to prevent.
     */
    function reasonText(body) {
        if (!body) return 'the archive could not be read, and no reason was given';
        if (body.message) return body.message;
        if (body.reason) return 'the archive could not be read: ' + body.reason;
        return 'the archive could not be read, and no reason was given';
    }

    window.HistoryAPI = {
        STATUS_OK: STATUS_OK,
        STATUS_NO_MATCHES: STATUS_NO_MATCHES,
        STATUS_UNAVAILABLE: STATUS_UNAVAILABLE,
        REASON_REQUEST_FAILED: REASON_REQUEST_FAILED,
        isOk: isOk,
        isNoMatches: isNoMatches,
        reasonText: reasonText,

        /**
         * Archive availability and freshness.
         * Inputs: none. Output: Promise<object> envelope.
         */
        status: function () {
            return get(BASE + '/status');
        },

        /**
         * Projects with per-kind session counts, most recent first.
         * Inputs: none. Output: Promise<object> envelope with `items`.
         */
        projects: function () {
            return get(BASE + '/projects');
        },

        /**
         * One page of sessions, newest first.
         * Inputs: opts (object) - {projectId, limit, offset}. `kind` is
         *   left at the server default (`main`) so subagent transcripts do
         *   not appear as conversations in a list view.
         * Output: Promise<object> envelope with `items`, `total`,
         *   `has_more`.
         */
        sessions: function (opts) {
            var o = opts || {};
            return get(BASE + '/sessions' + queryString({
                project_id: o.projectId,
                limit: o.limit,
                offset: o.offset
            }));
        },

        /**
         * A session's cheap map: metadata, compaction events, turn stubs.
         * Inputs: sessionId (number).
         * Output: Promise<object> envelope.
         */
        outline: function (sessionId) {
            return get(BASE + '/sessions/' + encodeURIComponent(sessionId) + '/outline');
        },

        /**
         * One window of a session thread, ascending by `seq_in_file`.
         * Inputs: sessionId (number), opts (object) - {afterSeq, limit,
         *   includeMachinery}.
         * Output: Promise<object> envelope with `items`, `has_more`,
         *   `next_after_seq`.
         */
        messages: function (sessionId, opts) {
            var o = opts || {};
            return get(BASE + '/sessions/' + encodeURIComponent(sessionId) + '/messages'
                + queryString({
                    after_seq: o.afterSeq,
                    limit: o.limit,
                    include_machinery: o.includeMachinery ? 'true' : 'false'
                }));
        },

        /**
         * Full-text search inside one session.
         * Inputs: sessionId (number), query (string), limit (number).
         * Output: Promise<object> envelope; `no_matches` is a real outcome
         *   here and is distinct from `unavailable`/`query_syntax_error`.
         */
        search: function (sessionId, query, limit) {
            return get(BASE + '/search' + queryString({
                q: query,
                session_id: sessionId,
                limit: limit
            }));
        }
    };
})();
