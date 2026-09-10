/**
 * Where the preference block meets this browser's WebSocket.
 *
 * ITS OWN FILE because client/js/terminal.js is held to a line budget by
 * tests/test_terminal_layout.node.mjs and, more to the point, because
 * neither of these two rules is about the terminal. terminal.js owns the
 * socket; it should not also own what a preference frame means or when a
 * refresh is owed. It keeps two delegating lines and this file keeps the
 * reasoning, the same split client/js/terminal-socket-abandon.js already
 * uses for the abandoned-handshake rule.
 *
 * TWO HOOKS, TWO DIFFERENT JOBS.
 *
 * `handleFrame` is the OPTIMISATION. A `preferences.changed` frame says
 * another client committed something, and Preferences.applyRemote takes
 * it only when its revision is higher than the one held - so a duplicate,
 * a reordered pair and a dropped frame all resolve without the socket
 * promising delivery or order.
 *
 * `refreshOnReconnect` is the CORRECTNESS. While the socket was down no
 * frame was delivered and nothing replays one, so the only sound recovery
 * is to re-read the block. Server values win. A local edit still in
 * flight becomes a visible conflict rather than being silently dropped or
 * silently uploaded back over what another device committed.
 *
 * BOTH REFUSE QUIETLY WHEN THE PREFERENCES MODULE IS ABSENT. A browser
 * that loaded a partial page still has a working terminal; preferences
 * failing to load is not a reason to break the pane the user is typing
 * into.
 */

console.log('[PreferencesTransport Module] Loading...');

(function () {
    /** @type {string} The frame type this module answers. */
    const CHANGED = 'preferences.changed';

    /**
     * Apply a `preferences.changed` frame from the terminal socket.
     *
     * Description: hands the frame to Preferences.applyRemote, which
     *   ignores anything not strictly newer than what it holds and
     *   refuses any save raised while it is applying - that guard is
     *   what stops two browsers echoing at each other.
     * Inputs: frame (object) - the decoded WebSocket message.
     * Output: boolean - whether anything was applied.
     * Example: PreferencesTransport.handleFrame(message);
     */
    function handleFrame(frame) {
        if (!globalThis.Preferences) return false;
        if (!frame || frame.type !== CHANGED) return false;
        return globalThis.Preferences.applyRemote(frame);
    }

    /**
     * Re-read the whole block after a socket comes back up.
     *
     * Description: THE AUTHORITATIVE REFRESH, not an event replay. Fire
     *   and forget: a failure leaves the module on what it already held
     *   and refusing nothing it was not already refusing, so it must not
     *   be allowed to reject into the socket's open handler.
     * Inputs: api (object|undefined) - the API client, defaulting to the
     *   global one.
     * Output: undefined.
     * Example: PreferencesTransport.refreshOnReconnect();
     */
    function refreshOnReconnect(api) {
        if (!globalThis.Preferences) return;
        const client = api || globalThis.api;
        Promise.resolve(globalThis.Preferences.hydrate(client)).catch(function (err) {
            // Deliberately swallowed: the terminal is up and usable, and
            // the next refresh will try again. Rejecting here would put a
            // preferences failure into the socket's open path.
            console.warn('[Preferences] refresh on reconnect failed',
                err && err.message ? err.message : err);
        });
    }

    const api = {
        CHANGED: CHANGED,
        handleFrame: handleFrame,
        refreshOnReconnect: refreshOnReconnect,
    };

    // Published on globalThis rather than window by name so the same file
    // loads unchanged in a browser and under `node --test`, matching
    // client/js/preferences.js.
    globalThis.PreferencesTransport = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[PreferencesTransport Module] Loaded');
})();
