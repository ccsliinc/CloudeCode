/**
 * TerminalSocketAbandon - retire a WebSocket that a new connect attempt
 * is about to stop referencing.
 *
 * WHY THIS EXISTS. `TerminalController.connectWebSocket()` refused to do
 * anything only when the socket it held was already OPEN:
 *
 *     if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
 *
 * A socket still mid-handshake fell straight through that guard and was
 * silently overwritten by the `this.ws = window.API.openWebSocket(...)`
 * at the bottom of the method. Nothing ever closed it. The server does
 * not close on handshake timeout either, so the orphan sat open forever
 * still attached to the pane's FIFO. Measured on live: 161 WebSocket
 * connects against 116 disconnects, so 45 sockets opened and never
 * closed, and 70 `send_pty_output_error` lines writing bytes to viewers
 * nobody was watching.
 *
 * The trigger was a duplicate click handler on a notification toast
 * firing two navigations for one click, each closing the live socket and
 * scheduling a fresh connect 500 ms later. That duplicate is fixed
 * separately, in client/js/toast.js. This is the reason it cost so much:
 * without it, a burst of connects leaks a socket per overlap instead of
 * simply doing redundant work.
 *
 * CLOSE, DO NOT REFUSE, and the difference is the whole design. The
 * obvious alternative is to widen the guard above to cover CONNECTING as
 * well as OPEN. That is a trap: ONE socket wedged in CONNECTING would
 * then block every future reconnect for the life of the page, turning a
 * thirty-second stall into a permanent outage. Closing is bounded by
 * construction, because the caller is about to stop referencing that
 * socket whatever happens next.
 *
 * THE HANDLERS COME OFF BEFORE THE CLOSE, and the ordering is the claim.
 * A close we asked for is not a disconnection. If it reached `onclose`
 * it would paint the "[Disconnected]" banner and start a reconnect
 * ladder racing the connect happening on the very next line. Detaching
 * is used rather than the controller's `_intentionalClose` flag because
 * that flag is single-shot and is consumed by whichever close lands
 * first, which need not be this one. It is the same detach the supersede
 * guard inside `setupWebSocketHandlers()` already performs on a socket
 * it has decided to ignore.
 *
 * ONLY CONNECTING IS RETIRED HERE. OPEN is the caller's own early
 * return. CLOSING and CLOSED are already on their way out and hold no
 * viewer open server-side, so closing them again is noise in the log for
 * no gain.
 *
 * This lives in its own file because client/js/terminal.js is past the
 * repo's 500-line guideline and carries a test that fails the build if
 * it grows, and because a rule this easy to get backwards is worth
 * stating once where it can be read without the surrounding method.
 */
(function () {
    'use strict';

    /**
     * Description: close and detach a socket the caller is about to
     *   abandon, when and only when it is still mid-handshake.
     * Inputs: ws (WebSocket|null) - the socket currently held.
     *   WS (object) - the WebSocket constructor, for its readyState
     *   constants. Passed rather than read off the global so this is
     *   testable without a browser and so a missing global cannot make
     *   the comparison silently undefined.
     * Output: boolean - true when a socket was retired, so the caller can
     *   drop its reference and log. False means "nothing to do", which
     *   covers null, OPEN, CLOSING and CLOSED alike.
     * Example: abandonIfConnecting(this.ws, WebSocket) -> true
     */
    function abandonIfConnecting(ws, WS) {
        if (!ws || !WS || ws.readyState !== WS.CONNECTING) return false;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
            ws.close();
        } catch (err) {
            // A socket that refuses to close is already unusable and is
            // being dropped by the caller on the next line regardless.
            // Swallowed deliberately: throwing here would abort a connect
            // the user is waiting on, in order to report a socket nobody
            // wants any more.
            console.debug('[TerminalSocketAbandon] close failed', err);
        }
        return true;
    }

    window.TerminalSocketAbandon = {
        abandonIfConnecting: abandonIfConnecting,
    };
}());
