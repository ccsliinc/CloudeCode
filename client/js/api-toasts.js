/**
 * API Module, toast half - the two CROSS-SESSION toast reads.
 *
 * WHY THIS IS A SEPARATE FILE, and why it extends the prototype rather
 * than subclassing: the same reasons api-archive.js gives. `window.API`
 * is one instance built at the end of api.js and roughly a hundred call
 * sites hold it; a second singleton would give the app two token-refresh
 * mutexes, which is the exact race api.js's single-flight comment exists
 * to prevent. `Object.assign(API.prototype, ...)` leaves every call site
 * and the mutex untouched.
 *
 * LOAD ORDER IS LOAD-BEARING: this file MUST come after api.js.
 * `class API` is not hoisted across scripts, so loading it first throws
 * a ReferenceError at parse time.
 *
 * WHAT IS NOT HERE. `ackToast` stays in api.js and is unchanged. That is
 * the whole shape of this change: the READ became global, the WRITE
 * stayed per session. A dismissal is still `POST /toasts/<id>/ack?
 * session_id=<the toast's own session>`, and nothing in this file can
 * widen it.
 */

console.log('[API Toasts Module] Loading...');

if (typeof API !== 'function') {
    // A named refusal, not a silent no-op. Loading this before api.js is
    // a build-order mistake and must say so rather than leaving the two
    // methods quietly absent, which would render as "no notifications".
    throw new Error(
        'api-toasts.js loaded before api.js - class API is not defined. '
        + 'Fix the script order in client/index.html.'
    );
}

Object.assign(API.prototype, {
    /**
     * Every session's toasts, newest first - the CROSS-SESSION raise.
     *
     * Punchlist item 7. `getSessionToasts` asks about one session and is
     * therefore blind to a session that needs attention while the user is
     * looking elsewhere; this asks about all of them. It is also the only
     * toast read that works on a screen with no terminal WebSocket (the
     * launchpad, the archive), which were previously deaf to
     * notifications entirely.
     *
     * Inputs: opts.unackedOnly (boolean, default true) - undismissed only.
     *   opts.limit (number, optional) - page size; the server clamps it.
     * Output: Promise<{toasts: Array<object>, total: number,
     *   unacked_only: boolean}>.
     * Example: await API.getAllToasts() -> {toasts: [...], total: 3, ...}
     */
    async getAllToasts({ unackedOnly = true, limit = null } = {}) {
        const params = [`unacked=${unackedOnly ? 'true' : 'false'}`];
        if (limit) params.push(`limit=${encodeURIComponent(limit)}`);
        return await this.call(`/toasts?${params.join('&')}`);
    },

    /**
     * Page back through every toast this SERVER RUN has recorded.
     *
     * Punchlist item 8. Includes dismissed records - the point is to find
     * what was missed - each carrying `acknowledged`. The response also
     * carries `storage`, which the panel renders verbatim: these records
     * live in the server process's memory and do not survive a restart,
     * and a history view that did not say so would read as "nothing ever
     * happened" after every restart.
     *
     * Inputs: opts.limit (number, default server-side 100),
     *   opts.offset (number, default 0).
     * Output: Promise<{toasts, total, limit, offset, next_offset,
     *   summary, storage}>. `next_offset` is null on the last page.
     * Example: await API.getToastHistory({limit: 100, offset: 0})
     */
    async getToastHistory({ limit = null, offset = 0 } = {}) {
        const params = [];
        if (limit) params.push(`limit=${encodeURIComponent(limit)}`);
        if (offset) params.push(`offset=${encodeURIComponent(offset)}`);
        const q = params.length ? `?${params.join('&')}` : '';
        return await this.call(`/toasts/history${q}`);
    },
});
