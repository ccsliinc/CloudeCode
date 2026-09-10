/**
 * TerminalReconnectPolicy - what a reconnect attempt MEASURED, what that
 * costs the retry budget, and which recovery a close code asks for.
 *
 * THE RECONNECT LADDER NEVER RECONNECTED, and that is measured, not
 * inferred. `attemptReconnect()` set `isReconnecting = true`, incremented
 * the counter and scheduled `connectWebSocket()`. The first line of
 * `connectWebSocket()` was:
 *
 *     if (this.isReconnecting) { this.stopReconnecting(); return; }
 *
 * so the retry the scheduler had just fired hit that guard, RETURNED
 * without opening anything, and `stopReconnecting()` set the budget back
 * to zero on its way out. Driven against the shipped class: one timer,
 * ZERO sockets opened, budget back to 0, and the only thing the user ever
 * saw was "reconnecting, attempt 1 of 5" followed by silence - not even
 * the failure message, because `attemptReconnect()` was never re-entered.
 * Present since the initial commit. It is why the 4404 and outage paths
 * were bolted on beside the general mechanism: they call
 * `reconnectToExistingSession` directly and never went through it.
 *
 * A COUNTER WITH FOUR WRITERS CANNOT BE REASONED ABOUT. `reconnectAttempts`
 * was set to 0 in the constructor, in `connectToSession`, in
 * `reconnectToExistingSession`, in `ws.onopen` and in
 * `stopReconnecting()`, and compared against its ceiling in exactly one
 * place. Any reset that fires on a path that also schedules a retry makes
 * the ceiling unreachable, and `stopReconnecting()` is called from the
 * exhaustion branch itself - so even without the defect above, five
 * failures produced a message and then five more attempts, forever.
 *
 * TWO QUESTIONS, TWO COUNTERS, ONE WRITER EACH. The BUDGET answers "have
 * we told the user this session is unreachable yet" and only a MEASURED
 * FAILURE moves it. The BACKOFF answers "how long before we try again"
 * and every attempt moves it. Sharing one counter is what forced the
 * choice between a budget that never fills and a delay that never grows.
 *
 * THREE FACTS, NOT ONE, AND ONLY THE THIRD IS INITIALIZATION SUCCESS.
 * The socket opening, the dimension handshake completing, and the first
 * bytes arriving from the pane are three different things. A socket that
 * opens proves the SERVER answered; it says nothing about whether the
 * pane is talking, which is the only thing the user cares about. So the
 * outcome is named with the vocabulary this codebase already uses for
 * exactly this question, `ready` / `awaiting_startup_prompt` / `unknown`
 * (`src/core/session_startup_gate.py`), reused rather than given a fourth
 * spelling.
 *
 * `ready` claims only "not blocked on a startup prompt", NOT "healthy" -
 * the server-side ladder is explicit about that and so is this.
 *
 * NOT HAVING MEASURED A SUCCESS IS NOT EVIDENCE OF FAILURE, and that
 * asymmetry is the whole point. A socket that opened and then closed
 * without the pane saying anything is UNKNOWN, and an unknown must not
 * consume the budget - or a slow machine, or a pane parked on its
 * folder-trust dialog, exhausts five attempts against a session that is
 * perfectly healthy and gets told it is unreachable. It is the same rule
 * `resolve_startup_gate` applies at rung 5 versus rung 7, and the same
 * rule `refuse_if_transcript_missing` applies to `unchecked`.
 *
 * THE COST OF THAT CHOICE, STATED RATHER THAN HIDDEN: a server that
 * accepts a socket and immediately closes it, forever, is retried
 * forever. The BACKOFF still grows to its ceiling, so it is a slow poll
 * and not a spin, and the status line keeps saying so. Declaring a
 * healthy session dead is the worse failure, which is the direction taken
 * deliberately.
 */

console.log('[TerminalReconnectPolicy Module] Loading...');

(function () {
    'use strict';

    /**
     * What an attempt measured about the PANE, in the server's own
     * three-value startup vocabulary.
     * @type {Object<string,string>}
     */
    var INIT = {
        READY: 'ready',
        AWAITING: 'awaiting_startup_prompt',
        UNKNOWN: 'unknown'
    };

    /**
     * Which recovery a close asks for. Each is a NAMED BRANCH of the
     * scheduler with a stated condition, rather than a guard clause
     * bolted in front of the general mechanism.
     * @type {Object<string,string>}
     */
    var RECOVERY = {
        AUTH: 'refresh_auth',          // 4401: the token is stale
        BY_NAME: 're_resolve_by_name', // 4404: the server forgot the id
        OUTAGE: 'wait_for_server',     // the server may be restarting
        RETRY: 'retry_same_id',        // everything else
        NONE: 'none'                   // a close we asked for
    };

    /** Delay for the first retry, in ms. */
    var BACKOFF_BASE_MS = 1000;

    /** The longest we will ever wait between attempts, in ms. */
    var BACKOFF_CEILING_MS = 16000;

    /**
     * Description: what did this attempt measure about the pane?
     * Inputs: signals (object) -
     *   socketOpened (boolean) - did ws.onopen fire at all.
     *   bytesSeen (boolean) - did the PANE send anything. The only
     *     positive proof that the session is talking.
     *   startupGate (string|null) - the server's own verdict from the
     *     session row, when the caller has one.
     * Output: string - one of INIT.
     * Example: initOutcome({socketOpened: true, bytesSeen: true}) === 'ready'
     */
    function initOutcome(signals) {
        var s = signals || {};
        if (s.bytesSeen) return INIT.READY;
        if (s.socketOpened && s.startupGate === INIT.AWAITING) return INIT.AWAITING;
        return INIT.UNKNOWN;
    }

    /**
     * Description: may this attempt take one off the retry budget?
     *   ONLY a measured failure may: the socket never opened, so the
     *   server did not answer. Everything else is an unknown wearing a
     *   different hat.
     * Inputs: signals (object) - socketOpened (boolean), outcome (string).
     * Output: boolean.
     * Example: consumesBudget({socketOpened: false}) === true
     */
    function consumesBudget(signals) {
        var s = signals || {};
        if (s.outcome === INIT.READY) return false;
        if (s.outcome === INIT.AWAITING) return false;
        return s.socketOpened !== true;
    }

    /**
     * Description: how long to wait before the next attempt. Grows with
     *   every attempt, not with the budget, so an unknown outcome still
     *   backs off even though it costs nothing.
     * Inputs: attemptsSinceProgress (number) - 1 for the first retry.
     * Output: number - milliseconds.
     * Example: backoffMs(1) === 1000, backoffMs(9) === 16000
     */
    function backoffMs(attemptsSinceProgress) {
        var n = (typeof attemptsSinceProgress === 'number' && attemptsSinceProgress > 0)
            ? attemptsSinceProgress : 1;
        return Math.min(BACKOFF_BASE_MS * Math.pow(2, n - 1), BACKOFF_CEILING_MS);
    }

    /**
     * Description: which recovery this close asks for. The 4404 case used
     *   to be a guard clause in front of the retry loop; it is a named
     *   branch here with its condition written down, so the scheduler has
     *   ONE shape and the special case is part of it.
     * Inputs: signals (object) -
     *   code (number|null) - the WebSocket close code.
     *   intentional (boolean) - we asked for this close.
     *   byNameAlreadyTried (boolean) - one re-resolve per disconnect
     *     episode; a second would be the same lookup twice.
     *   outageCodeKnown (boolean) - ServerRestartWatch is loaded AND
     *     recognises this code as a possible outage. Two facts, because a
     *     missing script must degrade to the plain retry rather than
     *     throwing inside onclose.
     * Output: string - one of RECOVERY.
     */
    function recoveryFor(signals) {
        var s = signals || {};
        if (s.intentional) return RECOVERY.NONE;
        if (s.code === 4401) return RECOVERY.AUTH;
        if (s.code === 4404) {
            return s.byNameAlreadyTried ? RECOVERY.RETRY : RECOVERY.BY_NAME;
        }
        if (s.outageCodeKnown) return RECOVERY.OUTAGE;
        return RECOVERY.RETRY;
    }

    window.TerminalReconnectPolicy = {
        INIT: INIT,
        RECOVERY: RECOVERY,
        BACKOFF_BASE_MS: BACKOFF_BASE_MS,
        BACKOFF_CEILING_MS: BACKOFF_CEILING_MS,
        initOutcome: initOutcome,
        consumesBudget: consumesBudget,
        backoffMs: backoffMs,
        recoveryFor: recoveryFor
    };
})();

console.log('[TerminalReconnectPolicy Module] Exported as window.TerminalReconnectPolicy');
