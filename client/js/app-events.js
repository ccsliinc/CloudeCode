/**
 * The browser end of `/ws/events`: one socket per TAB, for the whole app.
 *
 * WHY IT IS NOT IN terminal.js. That socket is per SESSION and exists only
 * while a terminal is open, which is precisely the limitation this file
 * closes: a browser on the home screen held nothing and learned nothing
 * until its next five second poll, and a browser looking at session A
 * learned nothing about session B. This socket is opened once, after
 * auth, and stays up across every screen.
 *
 * AN OPTIMISATION, NEVER A DEPENDENCY. Every poll in the app is untouched
 * and keeps its own schedule. If this socket never connects, or connects
 * and then drops and never comes back, every screen still converges
 * within one poll interval exactly as it did before this file existed.
 * So nothing here may throw into a caller, and nothing here may be the
 * only writer of any piece of state.
 *
 * EVERY FRAME IS A STATEMENT OF CURRENT FACT, NOT A DELTA. These notices
 * derive from Claude Code lifecycle hooks, which arrive unordered, may be
 * duplicated and may be dropped - so the notices are too. That is why a
 * status frame carries the value rather than a change to it, why the same
 * frame twice is a no-op, and why a dropped frame is closed by the next
 * frame or the next poll rather than by a replay nobody can ask for.
 *
 * A RECONNECT IS AN AUTHORITATIVE REFRESH, NOT A RESUME. While the socket
 * was down no frame was delivered and the server buffers nothing, so the
 * only sound recovery is to re-read the real endpoints. That is what
 * `events.hello` triggers, on the first connect and on every one after.
 *
 * AND THE OVERFLOW RECOVERY IS MEANT TO BE INVISIBLE. When a client falls
 * far enough behind that the server closes it at the bound, the close
 * carries code 4429 - an application code precisely so it can be told
 * apart from a server restart. The answer is to reconnect immediately and
 * re-read, with no banner: nothing is wrong that the user can act on.
 */

console.log('[AppEvents Module] Loading...');

(function () {
    /** @type {string} WebSocket path. Auth rides the subprotocol header. */
    var EVENTS_PATH = '/ws/events';

    /**
     * Close code the server uses when this client crossed its queue bound.
     * Matches EVENTS_OVERFLOW_CLOSE_CODE in src/core/event_hub.py. An
     * application code rather than 1013 so this recovery stays silent.
     * @type {number}
     */
    var OVERFLOW_CLOSE_CODE = 4429;

    /** @type {number} Close code for a rejected or expired token. */
    var AUTH_CLOSE_CODE = 4401;

    /** @type {number} First reconnect delay, milliseconds. */
    var BASE_DELAY_MS = 1000;

    /** @type {number} Ceiling on the backoff, milliseconds. */
    var MAX_DELAY_MS = 30000;

    var state = {
        ws: null,
        timer: null,
        attempts: 0,
        stopped: true,
    };

    /**
     * Re-read the authoritative endpoints. Fire and forget.
     *
     * Description: THE CORRECTNESS HALF. Called on every connect, because
     *   anything that happened while the socket was down was never
     *   delivered and is never replayed. Each target is optional and
     *   guarded on its own: a page that loaded only some modules still
     *   refreshes the ones it has, and a module that throws must not stop
     *   the others from running.
     * Inputs: none.
     * Output: undefined.
     * Example: AppEvents.refreshAll();
     */
    function refreshAll() {
        if (globalThis.PreferencesTransport) {
            try { globalThis.PreferencesTransport.refreshOnReconnect(); } catch (err) {
                console.warn('[AppEvents] preferences refresh failed', err);
            }
        }
        refreshSessionSurfaces();
    }

    /**
     * Ask whatever session list is on screen to re-read itself now.
     *
     * Description: the STRUCTURAL answer, and also what a status notice
     *   resolves to. Deliberately a re-read rather than a local patch of
     *   one row: patching would make this file a second assembler of the
     *   session list beside `/sessions/list`, and the two would drift.
     *   The notice's value is that it says "now" instead of "in up to
     *   five seconds", not that it saves the read.
     * Inputs: none.
     * Output: undefined.
     * Example: AppEvents.refreshSessionSurfaces();
     */
    function refreshSessionSurfaces() {
        var sidebar = globalThis.SessionSidebar;
        if (sidebar && typeof sidebar.refreshNow === 'function') {
            try { sidebar.refreshNow(); } catch (err) {
                console.warn('[AppEvents] sidebar refresh failed', err);
            }
        }
        var launchpad = globalThis.Launchpad;
        if (launchpad && typeof launchpad.loadRunningSessions === 'function') {
            try { launchpad.loadRunningSessions(); } catch (err) {
                console.warn('[AppEvents] launchpad refresh failed', err);
            }
        }
    }

    /**
     * Act on one decoded frame.
     *
     * Description: every branch delegates to the module that already owns
     *   that job - ToastManager for cards, PreferencesTransport for the
     *   preference block, the list surfaces for rows - so this file adds a
     *   transport and never a second copy of a rule. An unrecognised type
     *   is IGNORED rather than treated as a structural change: a newer
     *   server sending a frame this page does not know must not make it
     *   re-read the world on a timer it did not choose.
     * Inputs: frame (object) - the decoded message.
     * Output: boolean - whether a branch matched.
     * Example: AppEvents.handleFrame({type: 'sessions.changed'});
     */
    function handleFrame(frame) {
        if (!frame || typeof frame !== 'object') return false;
        var type = frame.type;

        if (type === 'events.hello') {
            refreshAll();
            return true;
        }
        if (type === 'session.status' || type === 'sessions.changed') {
            refreshSessionSurfaces();
            return true;
        }
        if (type === 'toast.new') {
            if (globalThis.ToastManager && frame.toast) {
                globalThis.ToastManager.add(frame.toast);
            }
            return true;
        }
        if (type === 'toast.ack') {
            if (globalThis.ToastManager && frame.toast_id) {
                globalThis.ToastManager.dismiss(frame.toast_id, { syncToServer: false });
            }
            return true;
        }
        if (globalThis.PreferencesTransport
            && type === globalThis.PreferencesTransport.CHANGED) {
            globalThis.PreferencesTransport.handleFrame(frame);
            return true;
        }
        if (type === 'pong') return true;
        return false;
    }

    /**
     * How long to wait before the next connect attempt.
     *
     * Description: exponential with a ceiling, EXCEPT after an overflow
     *   close, which reconnects at once. An overflow means this client
     *   fell behind, not that the server is unwell, so backing off would
     *   leave the user on stale rows for no reason.
     * Inputs: closeCode (number|undefined) - the code the socket closed
     *   with.
     * Output: number - milliseconds.
     * Example: AppEvents.backoffFor(4429) === 0
     */
    function backoffFor(closeCode) {
        if (closeCode === OVERFLOW_CLOSE_CODE) return 0;
        var delay = BASE_DELAY_MS * Math.pow(2, Math.max(0, state.attempts - 1));
        return Math.min(delay, MAX_DELAY_MS);
    }

    function scheduleReconnect(closeCode) {
        if (state.stopped) return;
        if (state.timer) return;
        var delay = backoffFor(closeCode);
        state.timer = setTimeout(function () {
            state.timer = null;
            connect();
        }, delay);
    }

    function connect() {
        if (state.stopped) return;
        if (state.ws) return;
        if (!globalThis.API || typeof globalThis.API.openWebSocket !== 'function') return;
        if (typeof globalThis.API.getToken === 'function' && !globalThis.API.getToken()) {
            // No credential to present. Stay down rather than opening a
            // socket the server will refuse; `start()` runs again after a
            // successful auth.
            return;
        }

        var ws;
        try {
            ws = globalThis.API.openWebSocket(null, EVENTS_PATH);
        } catch (err) {
            console.warn('[AppEvents] could not open events socket', err);
            state.attempts += 1;
            scheduleReconnect();
            return;
        }
        state.ws = ws;

        ws.onopen = function () {
            state.attempts = 0;
            console.log('[AppEvents] events channel open');
        };
        ws.onmessage = function (event) {
            var frame;
            try {
                frame = JSON.parse(event.data);
            } catch (err) {
                // A frame this client cannot read is not a reason to drop
                // a working channel: the poll still covers everything.
                console.warn('[AppEvents] undecodable frame ignored');
                return;
            }
            handleFrame(frame);
        };
        ws.onerror = function () {
            // onclose always follows, and that is where recovery lives.
            // Logged at debug level only: a transport error on an
            // optimisation channel is not something a user can act on.
        };
        ws.onclose = function (event) {
            state.ws = null;
            var code = event && event.code;
            if (code === AUTH_CLOSE_CODE) {
                // The token was refused. Retrying on a schedule would
                // hammer the endpoint with the same bad credential, so
                // stand down and wait for the next `start()`, which the
                // app calls after a successful auth.
                console.warn('[AppEvents] events channel refused auth, standing down');
                state.stopped = true;
                return;
            }
            if (code !== OVERFLOW_CLOSE_CODE) state.attempts += 1;
            scheduleReconnect(code);
        };
    }

    /**
     * Open the channel, and keep it open.
     *
     * Description: idempotent. Call it after authentication succeeds; a
     *   second call while connected does nothing.
     * Inputs: none.
     * Output: undefined.
     * Example: AppEvents.start();
     */
    function start() {
        state.stopped = false;
        connect();
    }

    /**
     * Close the channel and stop reconnecting.
     *
     * Description: a DELIBERATE close. Used on logout, so a socket is not
     *   left reconnecting with a credential the user just gave up.
     * Inputs: none.
     * Output: undefined.
     * Example: AppEvents.stop();
     */
    function stop() {
        state.stopped = true;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        if (state.ws) {
            try { state.ws.close(1000, 'client stopping'); } catch (err) { /* already gone */ }
            state.ws = null;
        }
        state.attempts = 0;
    }

    var api = {
        EVENTS_PATH: EVENTS_PATH,
        OVERFLOW_CLOSE_CODE: OVERFLOW_CLOSE_CODE,
        start: start,
        stop: stop,
        handleFrame: handleFrame,
        refreshAll: refreshAll,
        refreshSessionSurfaces: refreshSessionSurfaces,
        backoffFor: backoffFor,
        _state: state,
    };

    // Published on globalThis rather than window by name so the same file
    // loads unchanged in a browser and under `node --test`, matching
    // client/js/preferences-transport.js.
    globalThis.AppEvents = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    console.log('[AppEvents Module] Loaded');
})();
