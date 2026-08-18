/**
 * History viewer - paging arithmetic and formatting. No DOM, no fetch.
 * ----------------------------------------------------------------------
 * Two jobs, both pure and both testable without a browser:
 *
 * 1. WHICH ROWS TO ASK FOR. The messages endpoint pages FORWARD only, so
 *    reading upward has to be expressed as a bounded forward read of the
 *    range below what is on screen. `backwardWindow` is that arithmetic
 *    and the constant it leans on is load-bearing - read its comment
 *    before changing either number.
 *
 * 2. HOW TO PRINT WHAT CAME BACK. Timestamps and durations, including the
 *    Safari date-parsing fix, and the rule that an unmeasured duration
 *    renders as nothing rather than as zero.
 *
 * What a row IS - bubble, chip, divider, note - is `history-nodes.js`.
 */

console.log('[HistoryModel Module] Loading...');

(function () {
    'use strict';

    /** Server-side page size for reading FORWARD (newer). */
    var PAGE_SIZE = 50;

    /**
     * Span of `seq_in_file` requested when reading BACKWARD (older).
     *
     * The API pages forward only: `after_seq` is an exclusive LOWER bound.
     * There is no `before_seq`. Reading upward is therefore expressed as a
     * bounded forward read of the range immediately below what is already
     * on screen: ask for `after_seq = topSeq - SPAN` and discard anything
     * that lands at or past `topSeq`.
     *
     * THE SPAN MUST NOT EXCEED THE REQUEST LIMIT, and that is the whole
     * reason this is one constant used for both. `seq_in_file` values are
     * distinct integers, so a window of N consecutive integers can hold at
     * most N rows; asking for `limit = SPAN` therefore CANNOT come back
     * short of the range and leave an invisible hole between the fetched
     * chunk and the chunk above it. Set the span larger than the limit and
     * that guarantee is gone and the thread silently skips messages.
     *
     * 200 is the server's `history.max_page_size` cap, so this is the
     * largest span that keeps the guarantee in a single round trip.
     */
    var BACKWARD_SPAN = 200;

    /**
     * How far back from the estimated end of a session the thread opens.
     *
     * A conversation reader wants the tail, the way a messaging app does.
     * The API has no "last page" call, so the entry point is estimated
     * from `sessions.message_count` (see estimateTailStart) and then
     * CONFIRMED by paging forward until the server says `has_more: false`.
     */
    var TAIL_SPAN = 160;

    /**
     * Cap on the confirm-the-tail forward walk described above.
     *
     * `message_count` equals `max(seq_in_file)` for 18,868 of 19,067
     * sessions in the live archive (measured 2026-08-18, 98.96%), so the
     * estimate normally lands within one page of the end. It is an
     * ESTIMATE though, and an unbounded "keep fetching until has_more is
     * false" loop on the 1% where it is wrong is exactly how a phone ends
     * up pulling a whole session. Past this many follow-up pages the view
     * stops and leaves the user an explicit control instead.
     */
    var MAX_TAIL_FOLLOW = 4;

    /** Milliseconds per second / minute, for duration formatting. */
    var MS_PER_SECOND = 1000;
    var MS_PER_MINUTE = 60000;

    /** Characters of a `toolu_...` id kept for a chip label. */
    var SHORT_ID_CHARS = 8;

    /**
     * Compute the request parameters for reading one page OLDER than what
     * is on screen.
     *
     * Inputs:
     *   cursor (number) - the exclusive lower bound of what is ALREADY
     *     loaded, which is the `after_seq` of the oldest request made so
     *     far. This is deliberately NOT "the lowest rendered seq": the
     *     two differ whenever a requested range came back partly or
     *     wholly empty (every row in it was a filtered `progress` or
     *     machinery record), and driving the next request from the
     *     rendered row would re-request the empty stretch forever, while
     *     driving the filter from the cursor would skip real rows.
     * Output: object - `{after_seq, limit, ceiling, reachesStart}` where
     *   `ceiling` is the exclusive upper bound the caller must filter on
     *   (rows at or past it are already loaded) and `reachesStart` says
     *   whether this request covers the very beginning of the session, so
     *   the caller can stop asking rather than looping on an empty range.
     * Example: backwardWindow(500) -> {after_seq: 300, limit: 200,
     *   ceiling: 501, reachesStart: false}
     */
    function backwardWindow(cursor) {
        var lo = Math.max(0, cursor - BACKWARD_SPAN);
        return {
            after_seq: lo,
            limit: BACKWARD_SPAN,
            ceiling: cursor + 1,
            reachesStart: lo === 0
        };
    }

    /**
     * Estimate where to open a thread so it lands near the session's end.
     *
     * Inputs: messageCount (number|null) - `sessions.message_count`.
     * Output: number - an `after_seq` value. 0 means "open at the start",
     *   which is the honest answer when the count is missing or the
     *   session is short enough that the tail IS the start.
     * Example: estimateTailStart(29322) -> 29162
     */
    function estimateTailStart(messageCount) {
        if (!messageCount || messageCount <= TAIL_SPAN) return 0;
        return messageCount - TAIL_SPAN;
    }

    /**
     * Milliseconds between two archive timestamps.
     *
     * Inputs: startedAt (string|null), endedAt (string|null) - the
     *   archive stores these as `YYYY-MM-DD HH:MM:SS.ffffff`, which Safari
     *   will not parse with a bare `new Date()`, hence normaliseStamp.
     * Output: number|null - null when either end is missing or unparseable.
     *   Null means "not measured" and the renderer must not print a zero.
     */
    function durationBetween(startedAt, endedAt) {
        var start = parseStamp(startedAt);
        var end = parseStamp(endedAt);
        if (start === null || end === null) return null;
        var delta = end - start;
        return delta >= 0 ? delta : null;
    }

    /**
     * Parse an archive timestamp into epoch milliseconds.
     *
     * Inputs: value (string|null).
     * Output: number|null - null when absent or unparseable. iOS Safari
     *   rejects `"2026-08-18 12:00:39.711511"` (space separator, six
     *   fractional digits), so the separator is normalised to `T`, the
     *   fraction clipped to three digits and a `Z` appended; the archive
     *   stores UTC.
     */
    function parseStamp(value) {
        if (!value) return null;
        var iso = String(value).trim().replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1');
        if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
        var ms = Date.parse(iso);
        return isNaN(ms) ? null : ms;
    }

    /**
     * Render a duration for a tool chip.
     *
     * Inputs: ms (number|null).
     * Output: string - "" when the duration was not measured. Empty rather
     *   than "0ms": a tool call whose result is outside the loaded window
     *   did not take no time, it was not timed.
     * Example: formatDuration(1500) -> "1.5s"
     */
    function formatDuration(ms) {
        if (ms === null || ms === undefined) return '';
        if (ms < MS_PER_SECOND) return Math.round(ms) + 'ms';
        if (ms < MS_PER_MINUTE) return (ms / MS_PER_SECOND).toFixed(1) + 's';
        var minutes = Math.floor(ms / MS_PER_MINUTE);
        var seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND);
        return minutes + 'm ' + seconds + 's';
    }

    /**
     * Render an archive timestamp for display in the local timezone.
     *
     * Inputs: value (string|null).
     * Output: string - "" when absent or unparseable, so a missing
     *   timestamp shows nothing rather than "Invalid Date".
     */
    function formatWhen(value) {
        var ms = parseStamp(value);
        if (ms === null) return '';
        try {
            return new Date(ms).toLocaleString();
        } catch (err) {
            return '';
        }
    }

    /**
     * Render a date only, for session-list rows.
     *
     * Inputs: value (string|null).
     * Output: string - "" when absent or unparseable.
     */
    function formatDate(value) {
        var ms = parseStamp(value);
        if (ms === null) return '';
        try {
            return new Date(ms).toLocaleDateString();
        } catch (err) {
            return '';
        }
    }

    /**
     * Shorten a `toolu_...` identifier for a chip label.
     *
     * Inputs: toolUseId (string|null).
     * Output: string - "" when there is no id.
     * Example: shortId("toolu_01JaUAiaRHZmMnovzQcL7tRN") -> "01JaUAia"
     */
    function shortId(toolUseId) {
        if (!toolUseId) return '';
        return String(toolUseId).replace(/^toolu_/, '').slice(0, SHORT_ID_CHARS);
    }

    /**
     * Keep only the rows of a backward page that are not already rendered.
     *
     * Inputs: items (Array), ceiling (number) - the exclusive upper bound
     *   from backwardWindow().
     * Output: Array - rows with `seq_in_file` strictly below the ceiling.
     */
    function belowCeiling(items, ceiling) {
        return (items || []).filter(function (item) {
            return item.seq_in_file < ceiling;
        });
    }

    window.HistoryModel = {
        PAGE_SIZE: PAGE_SIZE,
        BACKWARD_SPAN: BACKWARD_SPAN,
        TAIL_SPAN: TAIL_SPAN,
        MAX_TAIL_FOLLOW: MAX_TAIL_FOLLOW,
        backwardWindow: backwardWindow,
        estimateTailStart: estimateTailStart,
        belowCeiling: belowCeiling,
        durationBetween: durationBetween,
        formatDuration: formatDuration,
        formatWhen: formatWhen,
        formatDate: formatDate,
        parseStamp: parseStamp,
        shortId: shortId
    };
})();
