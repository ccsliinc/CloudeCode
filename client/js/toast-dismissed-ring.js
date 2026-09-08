/**
 * ToastDismissedRing - the short memory that stops a dismissed toast
 * coming back on the next poll tick.
 *
 * WHY THIS EXISTS. Making the raise path GLOBAL (punchlist item 7) meant
 * adding a poll: `toast-global-poll.js` asks the server every few
 * seconds for every session's undismissed toasts. That introduces a race
 * the per-session attach backfill never had, because the backfill only
 * ran at WebSocket open and never while the user was clicking.
 *
 * THE RACE, precisely. `ToastManager.dismiss()` removes the id from its
 * model immediately and fires `POST /toasts/<id>/ack` asynchronously. A
 * poll tick whose request left the browser BEFORE that ack landed comes
 * back holding a snapshot in which the toast is still unacked. The
 * backfill feeds it to `add()`, which sees an id it no longer holds, and
 * the card the user just dismissed reappears. That is a card returning
 * from the dead in front of the user, and it is the one new defect this
 * whole change could introduce.
 *
 * SO A DISMISSAL IS REMEMBERED FOR A WHILE. Any id in this ring is
 * filtered out of a poll result before it reaches the toast manager.
 * `TTL_MS` only has to outlive an in-flight ack; it is set two orders of
 * magnitude above one, which costs nothing and covers a slow request.
 *
 * IT IS A SUPPRESSION, NEVER AN ACK. Nothing here talks to the server or
 * changes what the server believes. If the ack genuinely FAILED, the
 * record is still unacked server-side, the ring forgets it after the
 * TTL, and the toast comes back - which is correct, because it was never
 * dismissed. Making this permanent would turn a failed write into a
 * notification the user never sees again.
 *
 * BOUNDED, so a long-lived tab cannot grow it without limit: entries
 * expire on age and the map is capped by insertion order.
 *
 * PURE - no DOM, no network, no timers of its own. The clock is injected
 * so the expiry rule can be tested without waiting for it.
 */
(function () {
    'use strict';

    /** How long a dismissed id is remembered. Must outlive an in-flight ack. */
    var TTL_MS = 60000;

    /** Hard cap on remembered ids, oldest evicted first. */
    var MAX_ENTRIES = 500;

    /**
     * Description: a bounded, expiring set of toast ids the user has
     *   dismissed locally in the recent past.
     * Inputs: opts.now (function -> number) - injectable clock, defaults
     *   to Date.now. opts.ttlMs (number). opts.maxEntries (number).
     * Output: a ring instance.
     * Example: var ring = new ToastDismissedRing(); ring.note('a');
     *          ring.has('a') === true
     */
    function ToastDismissedRing(opts) {
        opts = opts || {};
        this._now = opts.now || function () { return Date.now(); };
        this._ttlMs = opts.ttlMs || TTL_MS;
        this._max = opts.maxEntries || MAX_ENTRIES;
        // Map preserves insertion order, which is what makes the
        // oldest-first eviction below a two-line operation.
        this._seen = new Map();
    }

    /**
     * Description: remember that this toast id was dismissed locally.
     *   Idempotent - noting the same id twice refreshes its timestamp
     *   rather than storing it twice, so a double-click cannot double
     *   the memory footprint.
     * Inputs: toastId (string). Output: void.
     */
    ToastDismissedRing.prototype.note = function (toastId) {
        if (!toastId) return;
        // Delete before set so a refreshed id moves to the END of the
        // insertion order; otherwise eviction would drop the entry that
        // was most recently confirmed, which is the opposite of intent.
        this._seen.delete(toastId);
        this._seen.set(toastId, this._now());
        this._evict();
    };

    /**
     * Description: has this id been dismissed recently enough to suppress?
     *   Expired entries are dropped as they are read, so a `has` on a
     *   stale id both answers false and cleans up after itself.
     * Inputs: toastId (string). Output: boolean.
     */
    ToastDismissedRing.prototype.has = function (toastId) {
        if (!toastId || !this._seen.has(toastId)) return false;
        var at = this._seen.get(toastId);
        if ((this._now() - at) > this._ttlMs) {
            this._seen.delete(toastId);
            return false;
        }
        return true;
    };

    /**
     * Description: drop the ids in a server list that were just dismissed
     *   here. THE ONLY CONSUMER-FACING OPERATION - the poller calls this
     *   and nothing else, so "what does the ring do to a poll result" has
     *   one answer in one place.
     * Inputs: toasts (Array of server-shape toast objects, or anything).
     * Output: Array - the same objects, minus recently dismissed ones.
     *   A non-array input yields [] rather than throwing, because a
     *   malformed response must not take down the poll loop.
     * Example: ring.filter([{id: 'a'}, {id: 'b'}]) -> [{id: 'b'}]
     */
    ToastDismissedRing.prototype.filter = function (toasts) {
        if (!Array.isArray(toasts)) return [];
        var self = this;
        return toasts.filter(function (t) {
            return !(t && self.has(t.id));
        });
    };

    /** Description: how many ids are currently remembered. Output: number. */
    ToastDismissedRing.prototype.size = function () {
        return this._seen.size;
    };

    /**
     * Description: enforce the entry cap, oldest insertion first.
     * Inputs: none. Output: void.
     */
    ToastDismissedRing.prototype._evict = function () {
        while (this._seen.size > this._max) {
            var oldest = this._seen.keys().next();
            if (oldest.done) return;
            this._seen.delete(oldest.value);
        }
    };

    ToastDismissedRing.TTL_MS = TTL_MS;
    ToastDismissedRing.MAX_ENTRIES = MAX_ENTRIES;

    window.ToastDismissedRing = ToastDismissedRing;
}());
