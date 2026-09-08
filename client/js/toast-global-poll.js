/**
 * ToastGlobalPoll - punchlist item 7: a toast raised by ANY session
 * reaches the browser, whatever session the user happens to be looking
 * at.
 *
 * WHAT USED TO FILTER THEM, because it was two filters and not one, and
 * fixing either alone would have left the bug:
 *
 *   1. THE WEBSOCKET. `toast.new` is fanned out only to sockets bound to
 *      the raising session ("toasts for session A never leak", in
 *      routes.py's own words). A browser holds ONE terminal socket, bound
 *      to the session on screen, so a toast for any other session had no
 *      transport to arrive on.
 *   2. THE BACKFILL. `terminal.js` asks `GET /sessions/<id>/toasts` for
 *      the ATTACHED session only, and only at WebSocket open.
 *
 * Between them, a session that needed attention while the user was
 * elsewhere was silent, and the launchpad and archive screens - which
 * hold no terminal socket at all - were deaf to notifications entirely.
 *
 * WHY A POLL RATHER THAN A WIDER BROADCAST. Widening the WebSocket
 * fan-out would push every session's toast frames down the ONE terminal
 * socket and make terminal.js filter them, coupling notification
 * delivery to the terminal transport - which is the coupling that caused
 * this bug in the first place. It would also still leave the
 * socket-less screens deaf. A poll works everywhere, needs no change to
 * the session-scoped socket, and leaves the existing lockstep ack
 * broadcast working exactly as it does today for the viewed session.
 *
 * BOTH PATHS FEED ONE MODEL. The WebSocket stays the FAST path for the
 * session on screen; this is the CATCH-ALL for every other session. Both
 * end in `ToastManager.add()`, which dedupes on `toast.id`, so a record
 * arriving by both routes renders once. That is the same backfill/WS
 * race the toast module already documents.
 *
 * RAISING IS GLOBAL, DISMISSING IS NOT, and nothing here touches the
 * second half. `ToastManager.dismiss()` acks with `toast.session_id` -
 * the toast's OWN session, never the one on screen - and
 * `dismissForSessionActivity(sid)` is scoped to the session the user
 * typed into. So a card raised by session B is now visible from session
 * A and is still dismissed only for B.
 *
 * IDEMPOTENT UNDER REPETITION, which is the property that matters here:
 * the same record arriving on ten consecutive ticks renders once (id
 * dedupe), and a record the user just dismissed is filtered out by
 * `ToastDismissedRing` so it cannot come back while its ack is still in
 * flight.
 */
(function () {
    'use strict';

    /** Poll cadence. The sidebar and health pollers sit at 15s and 5s. */
    var POLL_MS = 10000;

    /** Event `toast.js` dispatches on every local dismissal. */
    var DISMISS_EVENT = 'cloude:toast-dismissed';

    var state = {
        timer: null,
        inFlight: false,
        ring: null,
        wired: false,
    };

    /**
     * Description: the dismissal memory, built lazily so this file has no
     *   load-order dependency on toast-dismissed-ring.js beyond first use.
     * Inputs: none. Output: ToastDismissedRing | null.
     */
    function ring() {
        if (!state.ring && window.ToastDismissedRing) {
            state.ring = new window.ToastDismissedRing();
        }
        return state.ring;
    }

    /**
     * Description: can a poll usefully run right now? Refuses when there
     *   is no token (the login screen would otherwise generate a 401 every
     *   ten seconds), when the API or the toast manager has not loaded,
     *   and when a previous tick is still outstanding - a slow response
     *   must not be allowed to queue up ticks behind it.
     * Inputs: none. Output: boolean.
     */
    function canPoll() {
        if (state.inFlight) return false;
        if (!window.API || typeof window.API.getAllToasts !== 'function') return false;
        if (typeof window.API.getToken === 'function' && !window.API.getToken()) {
            return false;
        }
        return !!window.ToastManager;
    }

    /**
     * Description: one poll pass - fetch every session's undismissed
     *   toasts, drop the ones dismissed here in the last minute, and hand
     *   the rest to the toast manager's existing backfill.
     *
     *   FAILURE IS LOGGED AND SWALLOWED, deliberately: a notification
     *   poll that threw would stop the loop, and a stopped loop is
     *   silence, which is the exact failure this module exists to fix.
     *   The next tick simply tries again.
     * Inputs: none. Output: Promise<void>.
     */
    function tick() {
        if (!canPoll()) return Promise.resolve();
        state.inFlight = true;
        return window.API.getAllToasts({ unackedOnly: true })
            .then(function (payload) {
                var list = (payload && payload.toasts) || [];
                var r = ring();
                var fresh = r ? r.filter(list) : list;
                if (fresh.length) window.ToastManager.backfill(fresh);
            })
            .catch(function (err) {
                console.warn('[ToastGlobalPoll] tick failed', err && err.message);
            })
            .then(function () {
                state.inFlight = false;
            });
    }

    /**
     * Description: remember a locally dismissed id so the next tick does
     *   not resurrect it while its ack is still in flight.
     * Inputs: evt (CustomEvent with detail.id). Output: void.
     */
    function onDismissed(evt) {
        var id = evt && evt.detail && evt.detail.id;
        var r = ring();
        if (id && r) r.note(id);
    }

    /**
     * Description: start the loop. Idempotent - a second call is a no-op
     *   rather than a second timer, which is how a poller ends up firing
     *   at twice its stated cadence.
     * Inputs: none. Output: void.
     * Example: ToastGlobalPoll.start()
     */
    function start() {
        if (!state.wired) {
            document.addEventListener(DISMISS_EVENT, onDismissed);
            // A backgrounded tab's timers are throttled hard, so coming
            // back to the tab is the moment to re-sync rather than
            // waiting out a stretched interval.
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) tick();
            });
            state.wired = true;
        }
        if (state.timer) return;
        state.timer = setInterval(tick, POLL_MS);
        tick();
    }

    /** Description: stop the loop. Idempotent. Inputs: none. Output: void. */
    function stop() {
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    }

    window.ToastGlobalPoll = {
        start: start,
        stop: stop,
        tick: tick,
        POLL_MS: POLL_MS,
        DISMISS_EVENT: DISMISS_EVENT,
    };

    // Self-starting: this must run on EVERY screen, including the ones
    // that never build a terminal, so it deliberately does not wait to be
    // wired from a screen controller. `canPoll` makes an unauthenticated
    // tick a no-op, so starting before login costs one function call per
    // ten seconds and no network traffic.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}());
