/**
 * Reconnect repaint decision.
 * ----------------------------------------------------------------------
 * Owns exactly one question: when the client re-attaches to a backend
 * session, may it throw away what xterm has already rendered?
 *
 * WHY THIS EXISTS (the reconnect repaint loss, measured 2026-09-08):
 *
 * Both re-attach paths in terminal.js called `term.reset()`
 * UNCONDITIONALLY and then painted `initial_scrollback_b64`, which the
 * server produces with `tmux capture-pane -S -N`. That is right for a
 * session this browser has never rendered. It is destructive for one it
 * has.
 *
 * Claude Code's TUI draws IN PLACE on the alternate screen, so the tmux
 * pane's `history_size` is 0 and the capture is ONE SCREEN: the current
 * frame and nothing before it. The browser meanwhile holds every byte
 * the websocket ever delivered, which is the whole conversation. Reset
 * plus repaint therefore trades the entire history for a single frame,
 * and it fires every time the app server restarts and the client
 * re-attaches to a pane that never died. The user watches their
 * conversation vanish while the session underneath is perfectly healthy.
 *
 * THE RULE. Re-attaching to the SAME session id in a terminal whose
 * buffer already holds content means the bytes on screen came from this
 * very pane and are strictly better than the capture, so we keep them.
 * The live stream resumes on the same pane and the TUI repaints its
 * screen on the next output; the reconnect nudge in
 * `Terminal#connectWebSocket` (a FORCED `sendResize`, whose SIGWINCH the
 * server answers with a single 0x0c) guarantees that frame arrives
 * without waiting for the user to type. An empty buffer or a DIFFERENT
 * session has nothing worth keeping and takes the original path.
 *
 * WHY THE CAPTURE SIZE NEVER OVERRIDES A KEEP. A capture bigger than the
 * buffer looks like evidence the server knows more than we do. It is
 * not: a bigger capture of an in-place TUI is still just the current
 * frame, drawn at a larger pane geometry. Painting it under a kept
 * buffer would staple a duplicate of the screen the user is already
 * looking at underneath their history. The capture inputs are accepted
 * and recorded because they belong in the log line that explains a
 * verdict, and they are deliberately not allowed to move it.
 *
 * WHAT A 'keep' DOES AT THE CALL SITE, since terminal.js is under a hard
 * no-growth guard (`tests/test_terminal_layout.node.mjs`) and carries the
 * mechanics without the prose. Both `Terminal#connectToSession` and
 * `Terminal#reconnectToExistingSession` skip THREE things on a keep - the
 * `term.reset()`, the capture paint, and the "[Session created]" banner -
 * and set two flags instead:
 *
 *   `_needsReconnectRedrawNudge`  read once in `connectWebSocket`'s
 *       `ws.onopen`, where it turns the routine `sendResize('ws.onopen')`
 *       into a FORCED one. It has to be forced: a kept rejoin has the same
 *       cols and rows as before, so `sendResize`'s dedup gate would drop
 *       the frame, tmux would never see a SIGWINCH, and the kept buffer
 *       would sit on the frame from before the drop until the agent next
 *       wrote something. The server answers that SIGWINCH with a single
 *       0x0c, which is the redraw. The client still must NOT write its own
 *       0x0c - two within ~2s is Claude Code's `/clear` chord, and that
 *       wipes the user's context. That is why this reuses the resize path
 *       rather than adding a write.
 *   `_pendingPostConnectScroll`   pins the viewport to the bottom once the
 *       socket is up, same as the capture-paint path, because a rejoin is
 *       an explicit "back to live" intent.
 *
 * Loaded as a plain script (no build step). Exposes
 * `window.TerminalReconnectBuffer`.
 */
(function () {
    'use strict';

    /**
     * The verdicts this module can return. Named rather than bare
     * strings so a typo at a call site is a load-time `undefined`
     * instead of a silently-never-matching comparison.
     *
     * KEEP_AND_APPEND_CAPTURE is RESERVED and the rule below never
     * selects it. It is the obvious-looking third option - keep the
     * history AND paint the capture after it - and it is wrong for an
     * in-place TUI for the reason in the header: the capture is the
     * frame the kept buffer already ends with. It is named here, and
     * pinned by a test asserting no input produces it, so that nobody
     * reaches for it as a "more complete" fix without first proving the
     * pane actually scrolls.
     */
    var PAINT = {
        REPLACE: 'replace',
        KEEP: 'keep',
        KEEP_AND_APPEND_CAPTURE: 'keep_and_append_capture'
    };

    /**
     * How many leading buffer lines actually hold rendered content.
     *
     * Measured from xterm's real buffer, never guessed, because the two
     * numbers that look like an emptiness test are both traps:
     *
     *  - `length` alone is useless. On the alternate screen (any
     *    full-screen TUI, so every Claude Code session) the active
     *    buffer is always exactly `rows` lines long, blank or not, so a
     *    freshly `reset()` terminal reports the same length as a full
     *    one.
     *  - `baseY` alone is useless the other way. It is the number of
     *    rows that have scrolled off the top, and it is pinned at 0 on
     *    the alternate screen no matter how much has been drawn.
     *
     * So this reads all three fields, each for a different reason:
     * `baseY > 0` is an immediate yes (scrollback cannot exist without
     * content), `cursorY > 0` is an immediate yes (the cursor only
     * leaves the home row after something was written), and only when
     * both are 0 does it scan the viewport - bounded by `rows`, tens of
     * lines - for a single non-blank row. That last case is the one that
     * matters for a TUI, which can park its cursor at the home row with
     * a full screen behind it.
     *
     * @param {object|null|undefined} term - an xterm.js Terminal, or any
     *   falsy value.
     * @returns {number} count of leading lines holding content, 0 when
     *   the buffer is empty or unreadable. Unreadable reads as 0 on
     *   purpose: it routes to REPLACE, which is the behaviour that
     *   shipped, so a broken read can never be worse than the old code.
     * @example
     *   measureBufferLines(term) // 412 on a live conversation, 0 after reset()
     */
    function measureBufferLines(term) {
        if (!term) return 0;
        try {
            var buf = term.buffer && term.buffer.active;
            if (!buf) return 0;

            var baseY = typeof buf.baseY === 'number' ? buf.baseY : 0;
            if (baseY > 0) return baseY + 1;

            var cursorY = typeof buf.cursorY === 'number' ? buf.cursorY : 0;
            if (cursorY > 0) return cursorY + 1;

            var length = typeof buf.length === 'number' ? buf.length : 0;
            if (!length || typeof buf.getLine !== 'function') return 0;

            var last = -1;
            for (var i = 0; i < length; i++) {
                var line = buf.getLine(i);
                var text = line && typeof line.translateToString === 'function'
                    ? line.translateToString(true)
                    : '';
                if (text && text.trim() !== '') last = i;
            }
            return last + 1;
        } catch (err) {
            // Deliberately swallowed: an unreadable buffer is not a
            // reason to refuse the reconnect, and 0 routes to REPLACE,
            // which is exactly what this code did before the fix.
            console.warn('TerminalReconnectBuffer: buffer read failed', err);
            return 0;
        }
    }

    /**
     * Decide what a re-attach may do to the terminal buffer.
     *
     * @param {object} [input] - the measured situation.
     * @param {boolean} [input.sameSession] - true only when the session
     *   id being attached is the one this terminal was already showing.
     *   A missing previous id is NOT the same session.
     * @param {number} [input.bufferLines] - from `measureBufferLines`.
     * @param {number} [input.captureBytes] - size of the server's
     *   `initial_scrollback_b64` payload. Recorded, never decisive.
     * @param {number} [input.captureLines] - line count of that capture.
     *   Recorded, never decisive.
     * @returns {string} one of `PAINT.REPLACE` / `PAINT.KEEP`. See the
     *   header for why `PAINT.KEEP_AND_APPEND_CAPTURE` is reserved and
     *   never returned.
     * @example
     *   decideReconnectPaint({sameSession: true, bufferLines: 412})  // 'keep'
     *   decideReconnectPaint({sameSession: true, bufferLines: 0})    // 'replace'
     *   decideReconnectPaint({sameSession: false, bufferLines: 412}) // 'replace'
     */
    function decideReconnectPaint(input) {
        var opts = input || {};
        var sameSession = opts.sameSession === true;
        var bufferLines = typeof opts.bufferLines === 'number' && opts.bufferLines > 0
            ? opts.bufferLines
            : 0;

        if (sameSession && bufferLines > 0) return PAINT.KEEP;
        return PAINT.REPLACE;
    }

    /**
     * Are two session ids the same attachment?
     *
     * Split out because "same" has one non-obvious rule: an absent
     * previous id is not a match for anything, including another absent
     * id. Two unknowns are not evidence of sameness, and treating them
     * as one would keep a buffer full of session A while attaching to B.
     *
     * @param {string|null|undefined} previousId - id the terminal was showing.
     * @param {string|null|undefined} incomingId - id being attached now.
     * @returns {boolean} true only when both are present and equal.
     * @example
     *   isSameSession('abc', 'abc') // true
     *   isSameSession(null, null)   // false
     */
    function isSameSession(previousId, incomingId) {
        if (!previousId || !incomingId) return false;
        return String(previousId) === String(incomingId);
    }

    /**
     * The whole decision, for a re-attach call site.
     *
     * Exists so `terminal.js` spends ONE line per call site on this and
     * carries none of the reasoning: that file is under a hard
     * no-growth guard (`tests/test_terminal_layout.node.mjs`) and the
     * explanation belongs next to the rule anyway.
     *
     * MUST be called at the TOP of a re-attach path, before the teardown
     * nulls the controller's current session, because the previous id is
     * the entire question. Session ids are passed in already unwrapped:
     * the SessionInfo-wrapper-vs-`.session` trap has exactly one resolver
     * in this codebase (`Terminal#_unwrapSession`) and this module is not
     * going to become a second one.
     *
     * `captureB64` is recorded in the log line and never consulted by the
     * rule, for the reason in this file's header.
     *
     * @param {object|null} term - the live xterm.js Terminal, or null.
     * @param {string|null|undefined} previousId - session id currently on screen.
     * @param {string|null|undefined} incomingId - session id being attached.
     * @param {string} [captureB64] - the server's initial_scrollback_b64.
     * @returns {string} `PAINT.KEEP` or `PAINT.REPLACE`.
     * @example
     *   planFor(this.term, 'sess-a', 'sess-a', '') // 'keep'
     */
    function planFor(term, previousId, incomingId, captureB64) {
        var bufferLines = measureBufferLines(term);
        var captureBytes = captureB64 ? captureB64.length : 0;
        var verdict = decideReconnectPaint({
            sameSession: isSameSession(previousId, incomingId),
            bufferLines: bufferLines,
            captureBytes: captureBytes
        });
        console.log('[TERM-REJOIN] ' + verdict + ' session=' + incomingId +
            ' was=' + previousId + ' bufferLines=' + bufferLines +
            ' captureB64Bytes=' + captureBytes);
        return verdict;
    }

    window.TerminalReconnectBuffer = {
        PAINT: PAINT,
        decideReconnectPaint: decideReconnectPaint,
        measureBufferLines: measureBufferLines,
        isSameSession: isSameSession,
        planFor: planFor
    };
})();
