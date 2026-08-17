/**
 * Alternate-screen scrollback for Claude Code's `tui: fullscreen`.
 * ----------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Claude Code's `tui` setting picks the renderer. Under `default` it draws
 * on the MAIN screen, so the terminal keeps real scrollback and
 * terminal-scroll.js can move it with `term.scrollLines()`. Under
 * `fullscreen` - the flicker-free mode, and the one a new user is most
 * likely to land on - claude switches to the ALTERNATE screen (`?1049h`).
 * The alternate screen has no scrollback by construction: measured on a
 * live 2.1.199 session, `tmux display-message -p '#{history_size}'` is
 * exactly 0 and xterm's `buffer.active.baseY` never leaves 0. There is
 * nothing for a scroll gesture to move. Scrolling appears to "stop at the
 * welcome header", which reads as a broken app.
 *
 * WHAT WAS MEASURED (claude 2.1.199, 100x30 pane, 2026-08-17)
 *
 *   - claude enables mouse tracking (`?1000h ?1002h ?1003h ?1006h`) and
 *     then IGNORES the wheel: SGR button 64 does nothing at any row,
 *     repeated or after a motion event.
 *   - PageUp, arrows, shift-arrows and X10 wheel all do nothing in the
 *     normal state.
 *   - `ctrl+o` (0x0f) opens claude's own "detailed transcript" view. In
 *     that view UP scrolls one row and PageUp jumps a page. 50 UPs in a
 *     single write moved exactly 50 rows - no coalescing, perfectly
 *     linear. Roughly 180 PageUps reached the very top of a 240-message
 *     transcript, so there is no depth limit.
 *   - A draft typed into the prompt SURVIVES a ctrl+o round trip intact.
 *   - The transcript view renders its own footer,
 *     "Showing detailed transcript - ctrl+o to toggle - up/down scroll",
 *     which is both the state signature and the user's way out.
 *
 * WHOSE HISTORY, AND CAN THE TERMINAL'S STILL BE REACHED (no)
 *
 * While claude is painting the screen full-screen, claude owns the
 * history completely: a scroll gesture drives claude's transcript and
 * never falls through to the terminal buffer underneath, however far the
 * transcript has been scrolled. That is a deliberate choice over the
 * alternative of falling through once claude's transcript is exhausted.
 *
 *   - There is nothing to fall through TO. The buffer under a fullscreen
 *     paint holds whatever the shell printed before claude started, which
 *     is the noise this whole change exists to stop showing people. The
 *     rejoin path no longer even sends it (TmuxBackend.capture_scrollback).
 *   - The fallthrough is not observable from here. We send arrows and read
 *     the screen back; "claude is at the top of its transcript" and
 *     "claude ignored that arrow" look identical, so the trigger would be
 *     a guess, and a guess that silently changes what a gesture does.
 *   - It would be undiscoverable. Two identical drags would move two
 *     unrelated histories with no boundary the user can see.
 *
 * The state this leaves behind is discoverable by construction: claude's
 * transcript view draws its own footer, "Showing detailed transcript -
 * ctrl+o to toggle - up/down scroll", so the user can see where they are
 * and how to leave, and the d-pad's scroll-to-bottom closes it. A user who
 * wants terminal-based scrolling has it under `tui: default`, where
 * claude's conversation IS the terminal buffer and this module stands
 * down.
 *
 * THE HAZARD, AND HOW IT IS CONTAINED
 *
 * This module synthesises keystrokes into a live session that may hold
 * the user's real work. `ctrl+o` means something else - sometimes
 * destructive - in a shell, in nano, and in several REPLs, and all of
 * those can also own the alternate screen. So the alternate screen alone
 * is NEVER sufficient authority to inject. Every send is gated on a
 * POSITIVE identification of claude's own chrome, read out of the xterm
 * buffer at the moment of the gesture, plus a typing quiet period. When
 * the read is anything other than a confident claude state the answer is
 * to do nothing at all. See detectState().
 */
(function () {
    'use strict';

    /** ctrl+o - claude's detailed-transcript toggle. */
    var CTRL_O = '\x0f';

    /** CSI cursor up/down. Verified against claude 2.1.199: it does not
     *  set DECCKM, so the CSI form (not SS3) is what it reads. */
    var CSI_UP = '\x1b[A';
    var CSI_DOWN = '\x1b[B';

    /** Box-drawing horizontal, U+2500. claude's prompt frame is built of it. */
    var RULE_CHAR = '─';

    /** How many consecutive RULE_CHARs count as a frame edge. */
    var RULE_RUN = 20;

    /** claude's prompt caret, U+276F. */
    var CARET = '❯';

    /**
     * Substring that appears ONLY in the transcript view's footer. Lower
     * cased before comparison so a theme that upper cases it still matches.
     */
    var TRANSCRIPT_MARK = 'ctrl+o to toggle';

    /**
     * Refuse to inject anything within this long of the user's last
     * keystroke. Deliberately generous: a missed scroll is a shrug, a
     * keystroke injected into a half-typed prompt is not.
     */
    var TYPING_QUIET_MS = 1200;

    /** Give up waiting for the transcript view to paint after this long. */
    var OPEN_SETTLE_MS = 1500;

    /** How often to re-read the buffer while waiting for that paint. */
    var OPEN_POLL_MS = 40;

    /** Never send more than this many arrows for one gesture. */
    var MAX_ROWS_PER_GESTURE = 40;

    /** Timestamp (ms) of the user's last real keystroke. 0 = never. */
    var lastInputAt = 0;

    /** Timestamp (ms) of the ctrl+o we sent to OPEN the view. 0 = none. */
    var openSentAt = 0;

    /** Returns the live xterm Terminal, or null. */
    var getTerm = function () { return null; };

    /** Writes a raw string to the pty. Set by init(). */
    var sendKeys = function () { };

    /** setTimeout handle for the settle poll, so it cannot stack up. */
    var settleTimer = null;

    /**
     * Read the visible rows of the terminal as plain strings.
     *
     * Only the VISIBLE window is read, never the whole buffer: the
     * question is "what is on screen right now", and on the alternate
     * screen the visible window is the whole buffer anyway.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {string[]} one string per visible row, empty on any failure.
     */
    function visibleRows(term) {
        var out = [];
        try {
            var buf = term && term.buffer && term.buffer.active;
            if (!buf) return out;
            var top = buf.viewportY;
            var n = term.rows || 0;
            for (var i = 0; i < n; i++) {
                var line = buf.getLine(top + i);
                out.push(line ? line.translateToString(true) : '');
            }
        } catch (err) {
            console.warn('AltScreenScroll: buffer read failed', err);
            return [];
        }
        return out;
    }

    /**
     * Is this row one edge of claude's prompt frame?
     *
     * @param {string} row - a visible row's text.
     * @returns {boolean} true when it holds a long run of U+2500.
     */
    function isRule(row) {
        if (!row) return false;
        var run = 0;
        for (var i = 0; i < row.length; i++) {
            if (row.charAt(i) === RULE_CHAR) {
                run++;
                if (run >= RULE_RUN) return true;
            } else {
                run = 0;
            }
        }
        return false;
    }

    /**
     * Does this row look like claude's prompt line?
     *
     * Measured: claude renders the caret followed by U+00A0, so a plain
     * `startsWith(CARET)` after trimming leading whitespace is the test.
     *
     * @param {string} row - a visible row's text.
     * @returns {boolean}
     */
    function isPromptLine(row) {
        if (!row) return false;
        return row.replace(/^\s+/, '').indexOf(CARET) === 0;
    }

    /**
     * Is claude's own chrome on screen, and in which view?
     *
     * Pure function of the visible text, so it answers "who is painting
     * this screen" without any opinion about the buffer underneath it.
     * detectState() adds that second question.
     *
     * @param {string[]} rows - visible row text, top row first.
     * @returns {('live'|'transcript'|null)} null when neither signature is
     *   present, which includes claude showing a dialog in place of its
     *   prompt frame.
     */
    function identifyClaude(rows) {
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].toLowerCase().indexOf(TRANSCRIPT_MARK) !== -1) {
                return 'transcript';
            }
        }
        for (var j = 0; j + 2 < rows.length; j++) {
            if (isRule(rows[j]) && isPromptLine(rows[j + 1]) && isRule(rows[j + 2])) {
                return 'live';
            }
        }
        return null;
    }

    /**
     * WHOSE HISTORY IS THE USER ASKING FOR?
     *
     * This is the whole safety argument, so it is worth being explicit
     * about what each answer is evidence FOR.
     *
     *   'main'       - the terminal buffer owns the history. Either no
     *                  claude chrome is on screen, or claude is drawing
     *                  with `tui: default`, where the conversation IS the
     *                  scrollback. The caller must use term.scrollLines()
     *                  and this module must not touch anything.
     *   'transcript' - claude's detailed-transcript view is open. Proven
     *                  by its own footer text, which no other program
     *                  prints, and which claude only draws in that view.
     *                  Arrow keys here are the documented scroll keys.
     *   'live'       - claude's normal view, painted full-screen. Proven
     *                  by its prompt frame: a rule row, a caret row,
     *                  another rule row, in three consecutive visible
     *                  rows. `less`, `htop`, `top` and `vim` were each run
     *                  on the alternate screen and none of them produces
     *                  that shape (verified 2026-08-17). A shell prompt
     *                  using U+276F between two rules is excluded whenever
     *                  the shell has printed anything at all, because that
     *                  gives the buffer history and resolves to 'main'.
     *   'unknown'    - the screen is owned by something we cannot
     *                  identify, OR it is claude showing a dialog in place
     *                  of its prompt. Both mean the same thing: we have no
     *                  authority to synthesise a keystroke.
     *
     * The third outcome is a real answer, not a flavour of the other two.
     * Callers must treat 'unknown' as "inject nothing", never as "probably
     * fine".
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {('main'|'live'|'transcript'|'unknown')}
     */
    function detectState(term) {
        var type = null;
        var baseY = null;
        try {
            var buf = term && term.buffer && term.buffer.active;
            if (buf) {
                type = buf.type;
                baseY = buf.baseY;
            }
        } catch (err) {
            console.warn('AltScreenScroll: buffer read failed', err);
            return 'unknown';
        }
        // "I could not read the buffer" is NOT "it is the main screen".
        // Collapsing the two would let an unreadable buffer authorise the
        // main-screen path, which is the same false-green shape this
        // module exists to avoid on the other side.
        if (typeof type !== 'string' || typeof baseY !== 'number') return 'unknown';

        var rows = visibleRows(term);
        // Nothing readable on screen. The buffer is still evidence: rows
        // have scrolled off, so scrollLines() has somewhere to go.
        if (!rows.length) return baseY > 0 ? 'main' : 'unknown';

        // THE QUESTION IS "WHOSE HISTORY", NOT "IS THERE ANY HISTORY".
        //
        // The previous gate returned 'main' the moment `baseY > 0`, i.e.
        // as soon as ANY row had scrolled off the top. That reads as
        // "there is something to scroll, so scroll it", which is not the
        // user's question. A fullscreen claude session that was started
        // from a shell which had already printed something - a seeded
        // test run, an motd, a git status, a wrapper echo, a banner -
        // carries that output as terminal scrollback, so the gate chose
        // the terminal and dragged the user back through pre-claude noise
        // while claude's own transcript stayed out of reach. Reported and
        // reproduced 2026-08-17 with 400 seed lines ahead of claude.
        //
        // So identity comes FIRST: when claude's own chrome is on screen
        // it owns the history the user is asking for, and whatever the
        // shell printed before it started is not it.
        var owner = identifyClaude(rows);

        // Identity alone is not sufficient, because it does not say
        // whether what we are looking at is a full-screen PAINT or
        // terminal OUTPUT, and claude produces both:
        //
        //   - `tui: fullscreen` paints the alternate screen. The buffer
        //     under it belongs to whatever ran before claude. Claude's
        //     transcript is reachable only through ctrl+o, so this module
        //     must take the gesture.
        //   - `tui: default` writes the conversation into the terminal as
        //     ordinary output. There the scrollback IS claude's
        //     transcript, and `term.scrollLines()` already shows exactly
        //     the content the user wants. Injecting ctrl+o would replace a
        //     working scroll with a synthesised keystroke for no gain.
        //
        // Two facts separate them. `type === 'alternate'` is definitive
        // when the client saw the `?1049h`. It is not always available:
        // this app streams the pane with `tmux pipe-pane`, which only
        // carries bytes emitted AFTER it attached, and a client that
        // joins late is repainted with Ctrl+L (ws_startup_paint.py, gated
        // on `#{alternate_on}`). Claude answers a Ctrl+L by redrawing; it
        // does NOT re-send `?1049h`, because from its side it never left
        // the alternate screen. That client holds a fullscreen paint on
        // its NORMAL buffer. `baseY === 0` covers it: a fullscreen paint
        // never scrolls the buffer, so a claude screen with no history
        // beneath it is a paint, not output. The rejoin path no longer
        // manufactures history beneath such a paint either - see
        // TmuxBackend.capture_scrollback, which returns nothing for a pane
        // on the alternate screen precisely so this stays true.
        if (owner && (type === 'alternate' || baseY === 0)) return owner;

        // Not claude, or claude writing into a real terminal buffer.
        // Either way the buffer is the thing to move, and this module
        // must not touch it.
        if (baseY > 0) return 'main';

        // Alternate screen (or an empty one), owned by something we
        // cannot identify. No authority to synthesise anything.
        return 'unknown';
    }

    /**
     * Record a real keystroke from the user.
     *
     * Wired at the two places raw input reaches the pty (xterm's onData
     * and the d-pad's sendKeyToTerminal). Keys this module synthesises go
     * out through sendKeys() and deliberately do NOT come back through
     * here, so our own writes cannot extend our own quiet period.
     *
     * @returns {void}
     */
    function noteUserInput() {
        lastInputAt = Date.now();
    }

    /**
     * Is the user mid-keystroke?
     *
     * @returns {boolean} true inside TYPING_QUIET_MS of the last keystroke.
     */
    function isTyping() {
        if (!lastInputAt) return false;
        return (Date.now() - lastInputAt) < TYPING_QUIET_MS;
    }

    /**
     * Are we still waiting for a ctrl+o we already sent to take effect?
     *
     * @returns {boolean}
     */
    function openPending() {
        if (!openSentAt) return false;
        return (Date.now() - openSentAt) < OPEN_SETTLE_MS;
    }

    /**
     * Build a run of arrow keys.
     *
     * @param {number} rows - signed row count; >0 scrolls down, <0 up.
     * @returns {string} the bytes to write, capped at MAX_ROWS_PER_GESTURE.
     */
    function arrowRun(rows) {
        var n = Math.min(Math.abs(rows), MAX_ROWS_PER_GESTURE);
        var key = rows < 0 ? CSI_UP : CSI_DOWN;
        var out = '';
        for (var i = 0; i < n; i++) out += key;
        return out;
    }

    /**
     * Poll the buffer until the transcript view has actually painted, then
     * send the arrows that the opening gesture was asking for.
     *
     * WHY A POLL AND NOT A FIXED DELAY: arrows written in the SAME pty
     * write as the ctrl+o are DROPPED - measured, the view opened and the
     * 10 following UPs moved nothing. Claude discards input across the
     * view switch. A fixed delay would have to guess a round trip that
     * varies with the network. This waits for the evidence instead, and if
     * the evidence never arrives it sends nothing at all rather than
     * firing arrows at whatever is actually on screen.
     *
     * @param {number} rows - signed row count the gesture asked for.
     * @param {number} deadline - Date.now() after which to give up.
     * @returns {void}
     */
    function sendAfterOpen(rows, deadline) {
        settleTimer = null;
        var term = getTerm();
        var state = detectState(term);
        if (state === 'transcript') {
            openSentAt = 0;
            if (!isTyping()) sendKeys(arrowRun(rows));
            return;
        }
        if (Date.now() >= deadline || state === 'main') {
            // Gave up, or claude left the alternate screen underneath us.
            // Send nothing: we have no idea what would receive it.
            openSentAt = 0;
            return;
        }
        settleTimer = setTimeout(function () {
            sendAfterOpen(rows, deadline);
        }, OPEN_POLL_MS);
    }

    /**
     * Handle one scroll gesture on the alternate screen.
     *
     * Called by BOTH the wheel path and the touch path so the two cannot
     * drift apart; they hand in the same signed row count they would have
     * passed to term.scrollLines().
     *
     * IDEMPOTENCE: the open/closed state is re-read from the SCREEN on
     * every gesture, never from a flag alone. The flag (openSentAt) only
     * suppresses - it covers the window where the ctrl+o is still in
     * flight and the screen still shows 'live', which is exactly when two
     * fast gestures would otherwise send ctrl+o twice and toggle the view
     * shut. During that window this returns handled-but-does-nothing.
     *
     * @param {number} rows - signed row count; >0 down, <0 up.
     * @returns {boolean} true when this module owns the gesture, in which
     *   case the caller must NOT also call term.scrollLines(). false only
     *   for the main screen, where normal scrollback works.
     */
    function scrollByRows(rows) {
        var term = getTerm();
        if (!term) return false;
        var state = detectState(term);
        if (state === 'main') return false;
        if (!rows) return true;
        // Alternate screen, but not identified as claude. Swallow the
        // gesture - there is nothing to scroll and nothing safe to send.
        if (state === 'unknown') return true;
        if (openPending() && state !== 'transcript') return true;
        if (isTyping()) return true;

        if (state === 'live') {
            // Opening gesture. Send ONLY the toggle here; the arrows go
            // out from sendAfterOpen() once the view is proven open.
            openSentAt = Date.now();
            sendKeys(CTRL_O);
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(function () {
                sendAfterOpen(rows, Date.now() + OPEN_SETTLE_MS);
            }, OPEN_POLL_MS);
            return true;
        }

        openSentAt = 0;
        sendKeys(arrowRun(rows));
        return true;
    }

    /**
     * Close the transcript view and return to the live conversation.
     *
     * Backs the d-pad's "scroll to bottom" control. Screen-verified: a
     * blind ctrl+o sent while already live would OPEN the view instead of
     * closing it, which was measured and is the reason this cannot be a
     * plain toggle.
     *
     * @returns {boolean} true when a close was sent, in which case the
     *   caller should not also pin the (empty) alternate-screen viewport.
     */
    function exitTranscript() {
        var term = getTerm();
        if (detectState(term) !== 'transcript') return false;
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
        openSentAt = 0;
        sendKeys(CTRL_O);
        return true;
    }

    /**
     * Wire dependencies. Idempotent; safe to call again on session swap.
     *
     * @param {function(): (object|null)} termGetter - returns the live
     *   xterm Terminal.
     * @param {function(string): void} writer - writes a raw string to the
     *   pty WITHOUT counting as user input.
     * @returns {void}
     */
    function init(termGetter, writer) {
        if (typeof termGetter === 'function') getTerm = termGetter;
        if (typeof writer === 'function') sendKeys = writer;
    }

    /** Test seam: reset module state between assertions. */
    function _reset() {
        lastInputAt = 0;
        openSentAt = 0;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = null;
        getTerm = function () { return null; };
        sendKeys = function () { };
    }

    window.AltScreenScroll = {
        init: init,
        detectState: detectState,
        scrollByRows: scrollByRows,
        exitTranscript: exitTranscript,
        noteUserInput: noteUserInput,
        isTyping: isTyping,
        _reset: _reset,
        _keys: { CTRL_O: CTRL_O, UP: CSI_UP, DOWN: CSI_DOWN },
        _timing: {
            TYPING_QUIET_MS: TYPING_QUIET_MS,
            OPEN_SETTLE_MS: OPEN_SETTLE_MS,
            OPEN_POLL_MS: OPEN_POLL_MS,
            MAX_ROWS_PER_GESTURE: MAX_ROWS_PER_GESTURE
        }
    };
})();
