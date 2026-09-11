/**
 * TerminalInputBuffer - what happens to what you typed before the pane
 * could hear it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A LATENCY PROBLEM. Opening a
 * session is not instant, and the window is not merely slow - it is
 * DEAF. The server's attach handshake (src/api/websocket.py) sits in a
 * receive loop waiting for the client's `pty_resize` and DISCARDS every
 * binary frame that arrives before it, deliberately. So input typed
 * while a socket was OPEN but mid-handshake was thrown away by the
 * server, and input typed before the socket existed at all was thrown
 * away by `if (ws.readyState === OPEN)` on the client. Neither left a
 * trace. The server now says when the pane can hear, with a
 * `terminal.ready` message; this module is what holds the keystrokes
 * until it does.
 *
 * KEYED BY CONNECTION GENERATION, NOT BY SESSION ID, and that is the
 * load-bearing detail. A reconnect to the SAME session is a NEW
 * connection, and what the user typed before the socket dropped must not
 * be replayed into the pane afterwards - the pane may have moved on, and
 * half of a command line delivered late is a different command. A
 * session id cannot express "this is a different attempt at the same
 * session"; a monotonic counter can. It is deliberately NOT the
 * navigation generation from navigation-generation.js: that one answers
 * "is this still the screen the user is looking at", does not move on a
 * reconnect, and would therefore let a pre-drop keystroke survive into a
 * post-drop socket.
 *
 * NO LOCAL ECHO, EVER. Painting buffered input into xterm would show the
 * user text the pane has not received. If the batch is then rejected -
 * which is a real outcome, see below - the terminal is showing a lie
 * about a command that never ran. The buffer holds bytes; it never
 * writes them anywhere but the socket.
 *
 * 64 KiB, AND OVERFLOW REJECTS THE WHOLE UNSENT BATCH. Not the newest,
 * not the oldest, ALL of it: partial input is worse than no input,
 * because half a command line is a different command that the shell will
 * happily run. This is the opposite rule from
 * terminal-write-queue.js, which sheds the OLDEST output and keeps
 * going, and the asymmetry is deliberate. Output is a record of what
 * already happened, so a gap in it is a gap in a transcript, announced
 * and survivable. Input is an INSTRUCTION that has not happened yet, so a
 * gap in it is a DIFFERENT instruction, and there is no marker that
 * makes that safe. The bound is not a performance tuning knob - 64 KiB
 * of typing before a session opens is not a real scenario - it exists so
 * a connect that never completes cannot consume memory without limit.
 *
 * THE OVERFLOW OUTCOME IS NAMED AND IS ANNOUNCED EXACTLY ONCE.
 * `rejected_overflow` is the moment of rejection and the caller MUST
 * tell the user; `refused_overflowed` is every keystroke after it in the
 * same generation, held by nothing and reported by nobody, because a
 * status pill per keypress is not feedback. The generation stays
 * poisoned until it ends: once the user has been told to retype, quietly
 * starting to accumulate a second batch would deliver a fragment of what
 * they typed, which is the same defect the whole-batch rule exists to
 * prevent.
 *
 * Loaded as a plain script, no build step. Exposes
 * `window.TerminalInputBuffer`.
 */

console.log('[TerminalInputBuffer Module] Loading...');

(function (global) {
    'use strict';

    /**
     * The most unsent input we will hold for one connection, in bytes.
     * @type {number}
     */
    var MAX_BUFFERED_BYTES = 64 * 1024;

    /**
     * How long the hold may last with no `terminal.ready` in sight,
     * measured from the socket OPENING.
     *
     * WHY A BOUND EXISTS AT ALL, and it is not about slowness. A server
     * that does not send `terminal.ready` - one predating the message -
     * would leave a new client holding every keystroke FOREVER, a
     * terminal that silently accepts no input at all. The additive
     * contract protects an old CLIENT against a new server; this is the
     * other direction, and it is the worse failure of the two because
     * nothing on screen would say what was wrong.
     *
     * So the same rule this codebase already applies to layout waits: a
     * wait may DELAY the work, never CANCEL it. On expiry the batch is
     * DELIVERED, not dropped - the user typed it for this pane and the
     * socket is open - and the connection falls through to passing input
     * straight on, which is exactly how every client behaved before the
     * message existed.
     *
     * 4 seconds because the server's own handshake budget is 2 seconds
     * and the attach settle is 150 ms, so a healthy connect reaches ready
     * with an order of magnitude to spare. It is a backstop, not a
     * deadline.
     * @type {number}
     */
    var READY_TIMEOUT_MS = 4000;

    /**
     * Monotonic connection counter. Starts at 0, which is never handed
     * out: `arm()` increments before returning, so 0 means "no
     * connection has ever been armed" and can never match a caller's
     * token.
     * @type {number}
     */
    var generation = 0;

    /**
     * What the current generation is doing. Four words, and every one of
     * them is reachable:
     *   'idle'              - nothing armed, or the last one was discarded.
     *   'buffering'         - armed, holding input, waiting for ready.
     *   'ready'             - the pane said it can hear; send straight through.
     *   'rejected_overflow' - this generation exceeded the bound and its
     *                         whole batch was dropped. It stays here
     *                         until the generation ends.
     * @type {string}
     */
    var phase = 'idle';

    /** @type {Array<Uint8Array>} Chunks held, oldest first. */
    var held = [];

    /** @type {number} Running total of held bytes, so admission is O(1). */
    var heldBytes = 0;

    /** @type {string|null} What this generation was armed for, for logs. */
    var label = null;

    /**
     * Description: declare that a connection to the pane is being
     *   attempted, and start holding input for it. IDEMPOTENT WHILE ONE
     *   IS ALREADY PENDING: an entry path arms before its readiness gate
     *   and `connectWebSocket` arms again when it actually opens the
     *   socket, and those are one connection, not two - bumping the
     *   counter in between would discard the keystrokes typed during the
     *   gate, which is precisely the window this module exists for.
     *   A generation that has already gone `ready`, or been discarded,
     *   is finished, so arming again starts a new one.
     * Inputs: what (string) - a label for the log line. Optional.
     * Output: number - the generation to pass to offer() and release().
     * Example:
     *   this._connGen = TerminalInputBuffer.arm('connectToSession');
     */
    function arm(what) {
        if (phase === 'buffering') {
            // A connect is already pending. Same connection, same batch.
            return generation;
        }
        generation += 1;
        phase = 'buffering';
        held = [];
        heldBytes = 0;
        label = what == null ? null : String(what);
        return generation;
    }

    /**
     * Description: offer user input for delivery. This is the ONE
     *   decision point - the caller does not inspect the phase itself,
     *   because two readers of one state is how they come to disagree.
     * Inputs:
     *   token (number) - the generation from arm().
     *   bytes (Uint8Array) - the encoded input.
     * Output: string, one of:
     *   'send_now'          - nothing is holding input; send it. This is
     *                         the steady state and the behaviour of a
     *                         client that never had this module.
     *   'buffered'          - held for the flush on ready.
     *   'rejected_overflow' - the bound was exceeded. The WHOLE unsent
     *                         batch, including these bytes, has been
     *                         dropped. THE CALLER MUST TELL THE USER.
     *   'refused_overflowed'- this generation already overflowed and was
     *                         already reported. Dropped, say nothing.
     *   'stale_generation'  - these bytes belong to a connection that has
     *                         been superseded. Dropped silently: the user
     *                         typed them at a pane that is no longer the
     *                         one in front of them.
     * Example:
     *   var r = TerminalInputBuffer.offer(gen, encoded);
     *   if (r === 'send_now') ws.send(encoded);
     */
    function offer(token, bytes) {
        if (phase === 'idle' || phase === 'ready') return 'send_now';
        if (typeof token !== 'number' || token !== generation) {
            console.debug('[input-buffer] dropped input from a superseded connection',
                { token: token, current: generation, label: label });
            return 'stale_generation';
        }
        if (phase === 'rejected_overflow') return 'refused_overflowed';

        var size = (bytes && typeof bytes.length === 'number') ? bytes.length : 0;
        if (heldBytes + size > MAX_BUFFERED_BYTES) {
            var lost = heldBytes + size;
            held = [];
            heldBytes = 0;
            phase = 'rejected_overflow';
            console.warn('[input-buffer] rejected', lost,
                'bytes of pre-ready input: over the', MAX_BUFFERED_BYTES,
                'byte bound', { label: label, generation: generation });
            return 'rejected_overflow';
        }
        held.push(bytes);
        heldBytes += size;
        return 'buffered';
    }

    /**
     * Description: the pane says it can hear. Hand back what was held, in
     *   the order it was typed, and stop buffering. The caller sends;
     *   this module never touches a socket, which is what keeps it
     *   testable without one.
     * Inputs: token (number) - the generation `terminal.ready` arrived on.
     * Output: {outcome: string, chunks: Array<Uint8Array>, bytes: number}
     *   outcome is one of:
     *   'flushed'          - chunks carries what to send, in order.
     *   'nothing_held'     - ready arrived with an empty buffer, which is
     *                        every ordinary connect. Now sending through.
     *   'overflowed'       - the batch was rejected earlier, so there is
     *                        nothing to flush and nothing may be invented.
     *   'stale_generation' - a ready for a connection that is no longer
     *                        the current one. Nothing flushed, nothing
     *                        opened: a late message must not un-hold a
     *                        newer connection's input.
     * Example:
     *   var r = TerminalInputBuffer.release(gen);
     *   r.chunks.forEach(function (c) { ws.send(c); });
     */
    function release(token) {
        if (typeof token !== 'number' || token !== generation) {
            console.debug('[input-buffer] ignored a ready for a superseded connection',
                { token: token, current: generation });
            return { outcome: 'stale_generation', chunks: [], bytes: 0 };
        }
        if (phase === 'rejected_overflow') {
            phase = 'ready';
            return { outcome: 'overflowed', chunks: [], bytes: 0 };
        }
        var chunks = held;
        var bytes = heldBytes;
        held = [];
        heldBytes = 0;
        phase = 'ready';
        if (!chunks.length) return { outcome: 'nothing_held', chunks: [], bytes: 0 };
        console.log('[input-buffer] flushing', bytes, 'bytes typed before the pane was ready');
        return { outcome: 'flushed', chunks: chunks, bytes: bytes };
    }

    /**
     * Description: throw the batch away. Called for an AMBIGUOUS
     *   DISCONNECT (the socket closed and we cannot know whether the
     *   server received anything), for a deliberate teardown, and for a
     *   session switch. There is no replay path and there must not be
     *   one: re-sending input we are not sure was delivered risks running
     *   a command twice, and the user can retype far more cheaply than
     *   they can undo.
     * Inputs: reason (string) - for the log line when bytes are lost.
     * Output: {outcome: string, bytes: number} - 'discarded' when
     *   something was thrown away (the caller may want to say so),
     *   'nothing_held' otherwise, which is the ordinary case.
     * Example: TerminalInputBuffer.discard('socket closed');
     */
    function discard(reason) {
        var bytes = heldBytes;
        held = [];
        heldBytes = 0;
        phase = 'idle';
        if (!bytes) return { outcome: 'nothing_held', bytes: 0 };
        console.warn('[input-buffer] discarded', bytes,
            'bytes of pre-ready input:', reason || 'no reason given');
        return { outcome: 'discarded', bytes: bytes };
    }

    /**
     * Description: read the current phase. DIAGNOSTICS AND TESTS ONLY -
     *   `offer` is the decision point, and a caller branching on this
     *   instead would be a second copy of that decision.
     * Inputs: none.
     * Output: string - 'idle' | 'buffering' | 'ready' | 'rejected_overflow'.
     */
    function state() {
        return phase;
    }

    /**
     * Description: how many bytes are held right now. Diagnostics and
     *   tests only.
     * Inputs: none.
     * Output: number.
     */
    function heldByteCount() {
        return heldBytes;
    }

    // ------------------------------------------------------------------
    // THE SEAM. Everything above is pure - measurements in, a verdict
    // out, no socket and no DOM - and everything below is the four call
    // sites terminal.js has, kept here so that file carries one
    // delegating line each rather than a second copy of these rules.
    // A caller that reads `state()` and branches on it itself would be
    // exactly that second copy.
    // ------------------------------------------------------------------

    /**
     * Description: the message shown when input is thrown away. ONE
     *   string, because "your typing went" said two different ways on two
     *   paths reads as two different problems.
     * @type {string}
     */
    var RETYPE_MESSAGE = 'input dropped, the session was not ready yet. type it again.';

    /**
     * Description: tell the controller something, through the app's
     *   single status-pill path. Never throws.
     * Inputs: controller (object), text (string).
     * Output: void.
     */
    function report(controller, text) {
        if (controller && typeof controller._showStatusPill === 'function') {
            controller._showStatusPill(text, 'error');
            return;
        }
        console.warn('[input-buffer]', text);
    }

    /**
     * Description: a connection to the pane is starting, so hold input
     *   from here until ready. DISCARD FIRST, THEN ARM: whatever the
     *   previous connection held belongs to a pane the user has left, or
     *   to a socket that dropped without saying what it received, and the
     *   discard is what makes the arm mint a NEW generation rather than
     *   joining the old batch.
     * Inputs: controller (object) - gets `_connGen`. what (string).
     * Output: number|null - the generation.
     */
    function begin(controller, what) {
        cancelBackstop();
        discard('a new connection to the pane is starting');
        var gen = arm(what);
        if (controller) controller._connGen = gen;
        return gen;
    }

    /**
     * Description: send user input, or hold it until the pane can hear.
     *   THE ONE decision point for every keystroke-shaped path.
     * Inputs: controller (object) - `.ws`, `._connGen`. bytes (Uint8Array).
     * Output: boolean - true when the bytes reached the socket.
     */
    function send(controller, bytes) {
        var verdict = offer(controller ? controller._connGen : null, bytes);
        // Said exactly once, by offer()'s own rule: the whole unsent
        // batch went and the user has to retype it. Half a command line
        // is a different command, so there is no partial delivery to
        // offer instead.
        if (verdict === 'rejected_overflow') report(controller, RETYPE_MESSAGE);
        if (verdict !== 'send_now') return false;
        var ws = controller && controller.ws;
        if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return false;
        ws.send(bytes);
        return true;
    }

    /**
     * Description: the pane said it can take input. Send what was held,
     *   in order, once.
     *
     *   SENT RAW RATHER THAN BACK THROUGH send(): the phase is already
     *   'ready' by the time these come back, so re-offering them would be
     *   correct and pointless, and a re-entrant offer is a shape nobody
     *   should have to reason about.
     * Inputs: controller (object), message (object) - the ready frame.
     * Output: string - the release outcome, for the caller's log line.
     */
    function flushOnReady(controller, message) {
        cancelBackstop();
        var r = release(controller ? controller._connGen : null);
        console.log('[input-buffer] pane ready', {
            startup_command: message && message.startup_command,
            input: r.outcome, bytes: r.bytes
        });
        if (r.outcome !== 'flushed') return r.outcome;
        var ws = controller && controller.ws;
        if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) {
            // The socket went between ready arriving and this line. The
            // batch is GONE rather than re-held: what we could not
            // deliver on the connection it was typed for must never be
            // replayed onto a later one.
            report(controller, RETYPE_MESSAGE);
            return 'socket_gone';
        }
        for (var i = 0; i < r.chunks.length; i++) ws.send(r.chunks[i]);
        if (typeof controller._noteUserInputToSession === 'function') {
            controller._noteUserInputToSession();
        }
        return 'flushed';
    }

    /**
     * Description: the socket closed. AN AMBIGUOUS DISCONNECT DISCARDS
     *   AND NEVER REPLAYS - we cannot know what the server received, so
     *   re-sending risks running a command twice. Retyping is cheap;
     *   undoing is not.
     * Inputs: controller (object), reason (string).
     * Output: string - 'discarded' | 'nothing_held'.
     */
    function abandon(controller, reason) {
        cancelBackstop();
        var r = discard(reason);
        if (r.outcome === 'discarded') report(controller, RETYPE_MESSAGE);
        return r.outcome;
    }

    /** @type {*} The backstop timer, so a ready can cancel it. */
    var backstop = null;

    /**
     * Description: stop waiting for a `terminal.ready` that is never
     *   coming. Armed when the socket OPENS, because that is the moment
     *   from which the server owes us the message; armed earlier it would
     *   be counting time the connect legitimately spends before there is
     *   a server in the conversation at all.
     * Inputs: controller (object). ms (number) - override, for tests.
     * Output: void.
     * Example: TerminalInputBuffer.armReadyBackstop(this);
     */
    function armReadyBackstop(controller, ms) {
        cancelBackstop();
        var wait = typeof ms === 'number' ? ms : READY_TIMEOUT_MS;
        var forGeneration = generation;
        backstop = setTimeout(function () {
            backstop = null;
            if (phase !== 'buffering' || generation !== forGeneration) return;
            // DELIVER, DO NOT DROP. The socket is open and these bytes
            // were typed for this pane; the only thing we did not get was
            // permission to send them. Dropping here would punish the
            // user for a server that is older than this client.
            console.warn('[input-buffer] no terminal.ready after ' + wait
                + 'ms, sending anyway and passing input straight through');
            flushOnReady(controller, { startup_command: 'unknown',
                via: 'ready_backstop' });
        }, wait);
    }

    /**
     * Description: cancel the backstop. Called by every path that ends a
     *   connection's hold, so a timer cannot fire against a generation
     *   that is already finished.
     * Inputs: none.
     * Output: void.
     */
    function cancelBackstop() {
        if (backstop !== null) {
            clearTimeout(backstop);
            backstop = null;
        }
    }

    global.TerminalInputBuffer = {
        MAX_BUFFERED_BYTES: MAX_BUFFERED_BYTES,
        READY_TIMEOUT_MS: READY_TIMEOUT_MS,
        RETYPE_MESSAGE: RETYPE_MESSAGE,
        armReadyBackstop: armReadyBackstop,
        arm: arm,
        offer: offer,
        release: release,
        discard: discard,
        state: state,
        heldByteCount: heldByteCount,
        begin: begin,
        send: send,
        flushOnReady: flushOnReady,
        abandon: abandon
    };
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[TerminalInputBuffer Module] Exported as window.TerminalInputBuffer');
