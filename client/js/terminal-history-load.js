/**
 * TerminalHistory - pull the tmux pane's SCROLLBACK into xterm once, so
 * search has something to search.
 *
 * WHY IT IS NEEDED AT ALL. An attach paints ONE VIEWPORT
 * (`paint_on_attach`), so the browser holds only what has been written
 * since it connected. tmux is holding up to `scrollback_lines` behind
 * that, and the search add-on can only match rows xterm actually has. So
 * the first time the panel opens, the history is fetched through the same
 * `include_scrollback` endpoint the launchpad rejoin already uses, and
 * painted.
 *
 * IT IS PAINTED, NEVER ENQUEUED. `TerminalController.enqueue` is the live
 * output path, bounded at 4 MiB by terminal-write-queue.js, and a
 * 10000-line ANSI capture is 1 to 3 MB of that budget in one go. Worse,
 * an overflow there SHEDS THE OLDEST CHUNKS AND WRITES A DROP MARKER,
 * which would put "output dropped" into the middle of the user's own
 * history. This goes straight to `TerminalScrollbackPaint`, which is the
 * module that owns writing a capture into the parser.
 *
 * THE UNAVOIDABLE WINDOW, STATED RATHER THAN HIDDEN. The server captures
 * the pane at one instant and this client erases the buffer and repaints
 * it a network round trip later. Anything the pane emitted in between is
 * in NEITHER: not in the capture, because it had not happened, and not on
 * screen, because the erase took it. It comes back on claude's next full
 * repaint and is gone from the buffer until then. A hold on the live
 * stream cannot close that window - it would only move the loss to the
 * other side of the erase - so the honest answer is to do this ONCE, on
 * an explicit user action, and say so here.
 *
 * ONCE PER SESSION PER NAVIGATION, and the memo proves it with a
 * consequence rather than a hook. `buf.baseY` only ever grows while a
 * terminal keeps running and is zeroed by `term.reset()`, which is
 * exactly what a reconnect repaint does. So a memo holding the baseY
 * measured just after the paint answers "is this still the buffer I
 * painted into" with no listener inside terminal.js and nothing for that
 * file to remember to call.
 *
 * Loaded as a plain script, no build step. Exposes `window.TerminalHistory`.
 */
(function (global) {
    'use strict';

    /**
     * The last successful load. `{sessionId, navToken, baseYAfterPaint}`,
     * or null. Module-level rather than per-terminal because there is one
     * terminal in this page and the session id is part of the key.
     */
    var memo = null;

    /**
     * Description: how many lines a decoded capture holds.
     * Inputs: bytes (Uint8Array|null) - the decoded capture.
     * Output: number - newline count, plus one for a final line with no
     *   terminator. 0 for an empty or absent capture.
     * Example: countLines(new Uint8Array([65, 10, 66])) // 2
     */
    function countLines(bytes) {
        if (!bytes || !bytes.length) return 0;
        var n = 0;
        for (var i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) n++;
        return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
    }

    /**
     * Description: may this capture be painted over what is on screen?
     *
     *   THE RULE IS "DEEPER THAN", NOT "DIFFERENT FROM". Painting a
     *   capture SHALLOWER than the buffer trades a long conversation the
     *   browser already holds for a short one, which is the exact defect
     *   terminal-reconnect-buffer.js exists to record: the pane's
     *   `history_size` is 0 while claude's TUI draws in place, so a
     *   capture can legitimately come back as a single screen.
     *
     * Inputs: input (object) - `bufferLines` (from
     *   TerminalReconnectBuffer.measureBufferLines), `captureLines` (from
     *   countLines), `altScreen` (boolean).
     * Output: string - 'alternate_screen' (a TUI owns the screen and has
     *   no scrollback to load), 'not_deeper' (nothing to gain), or
     *   'paint'.
     * Example: decide({bufferLines: 40, captureLines: 900}) // 'paint'
     */
    function decide(input) {
        var o = input || {};
        if (o.altScreen === true) return 'alternate_screen';
        var have = typeof o.bufferLines === 'number' ? o.bufferLines : 0;
        var got = typeof o.captureLines === 'number' ? o.captureLines : 0;
        if (got <= have) return 'not_deeper';
        return 'paint';
    }

    /** Forget the memo, so the next call fetches again. Output: void. */
    function forget() {
        memo = null;
    }

    /** The one outcome shape, so no branch below invents its own. */
    function result(loaded, lines, reason) {
        var r = { loaded: loaded, lines: lines || 0 };
        if (reason) r.reason = reason;
        return r;
    }

    /** The live controller, or null. Read at use, never captured. */
    function controller() {
        return global.TerminalController || null;
    }

    /**
     * Description: is this the buffer a previous load already painted?
     * Inputs: term (object), sessionId (string), navToken (any).
     * Output: boolean. False whenever anything cannot be compared, which
     *   costs one refetch and never a wrong answer.
     */
    function alreadyLoaded(term, sessionId, navToken) {
        if (!memo || memo.sessionId !== sessionId) return false;
        if (memo.navToken !== navToken) return false;
        var buf = term && term.buffer && term.buffer.active;
        if (!buf || typeof buf.baseY !== 'number') return false;
        return buf.baseY >= memo.baseYAfterPaint;
    }

    /**
     * Description: load this session's tmux scrollback into the terminal,
     *   at most once per session per navigation.
     *
     * Inputs:
     *   term (object) - the live xterm Terminal.
     *   sessionId (string) - the session being searched.
     * Output: Promise<{loaded, lines, reason?}> - NEVER rejects.
     *   'painted'     - the history is in the buffer; `lines` is its depth.
     *   'already'     - nothing to do; the buffer is as deep or deeper.
     *   'unavailable' - no history was loaded, and `reason` says which of
     *                   the six refusals it was. The panel shows
     *                   "searching recent output only" and carries on:
     *                   searching one viewport is a smaller feature, not
     *                   a broken one.
     * Example:
     *   const r = await TerminalHistory.ensureLoaded(term, 'ses_1');
     *   if (r.loaded === 'unavailable') showRecentOnlyNotice();
     */
    async function ensureLoaded(term, sessionId) {
        var ctl = controller();
        var buf = term && term.buffer && term.buffer.active;
        if (!term || !buf) return result('unavailable', 0, 'no_terminal');

        // 1. A TUI owns the screen. Writing `ESC[?1049l` into it would
        //    yank vim or less out from under the user, and there is no
        //    scrollback on the alternate buffer to load anyway.
        if (buf.type === 'alternate') {
            return result('unavailable', 0, 'alternate_screen');
        }

        var navToken = ctl ? ctl._navToken : null;
        if (alreadyLoaded(term, sessionId, navToken)) {
            return result('already', measure(term));
        }

        // 2. Where the user is looking, sampled BEFORE anything moves.
        //    `distance` is rows above the bottom, which survives the
        //    repaint; an absolute viewportY does not, because baseY moves.
        var scroll = global.TerminalScroll;
        var pinned = scroll && typeof scroll.isPinnedToBottom === 'function'
            ? scroll.isPinnedToBottom(term)
            : true;
        var distance = Math.max(0, (buf.baseY || 0) - (buf.viewportY || 0));
        var bufferLines = measure(term);

        // 3. The fetch. Cols and rows go with it so the server resizes the
        //    pane to THIS grid before capturing: history captured at
        //    another width reflows into garbled rows here.
        var info;
        try {
            var api = global.API;
            if (!api || typeof api.getSession !== 'function') {
                return result('unavailable', 0, 'no_api');
            }
            info = await api.getSession(sessionId, {
                includeScrollback: true,
                cols: term.cols,
                rows: term.rows
            });
        } catch (err) {
            console.warn('TerminalHistory: the capture request failed', err);
            return result('unavailable', 0, 'request_failed');
        }

        // 4. CLAIM AT THE GESTURE, CHECK AT THE WRITE. The user can open
        //    another session inside one round trip, and this write erases
        //    the buffer: landing it on the session they moved to would
        //    destroy that session's screen and paint a stranger's history
        //    into it.
        var ctlNow = controller();
        if (ctlNow && ctlNow._navToken !== navToken) {
            return result('unavailable', 0, 'navigated_away');
        }

        var b64 = info && (info.initial_scrollback_b64
            || (info.session && info.session.initial_scrollback_b64));
        if (!b64) return result('unavailable', 0, 'no_capture');

        var painter = global.TerminalScrollbackPaint;
        if (!painter || typeof painter.paint !== 'function') {
            return result('unavailable', 0, 'no_paint_module');
        }

        var captureLines;
        try {
            captureLines = countLines(painter.decodeCapture(b64));
        } catch (err) {
            console.warn('TerminalHistory: the capture would not decode', err);
            return result('unavailable', 0, 'decode_failed');
        }

        var verdict = decide({
            bufferLines: bufferLines,
            captureLines: captureLines,
            altScreen: buf.type === 'alternate'
        });
        if (verdict !== 'paint') {
            return verdict === 'alternate_screen'
                ? result('unavailable', 0, 'alternate_screen')
                : result('already', bufferLines, 'not_deeper');
        }

        var shim = shimFor(term, ctlNow, pinned, distance, sessionId, navToken);
        var painted = await painter.paint(shim, b64, 'history',
            { clearScrollback: true });
        if (painted !== 'painted') {
            return result('unavailable', 0, painted);
        }
        rememberFrom(term, sessionId, navToken);
        return result('painted', captureLines);
    }

    /**
     * Description: rows of real content already in the buffer.
     * Inputs: term (object).
     * Output: number - 0 when the measuring module is missing, which
     *   routes to a paint, matching what an empty buffer would do.
     */
    function measure(term) {
        var m = global.TerminalReconnectBuffer;
        return m && typeof m.measureBufferLines === 'function'
            ? m.measureBufferLines(term)
            : 0;
    }

    /**
     * Description: the controller-shaped object `paint` is given.
     *
     *   `_forceScrollToBottom` IS THE WRITE CALLBACK, which is the only
     *   hook into "the bytes have been parsed" that the paint module
     *   offers. Pinned, it does what the name says. NOT pinned, it must
     *   not: the user was reading something, and yanking them to the
     *   bottom of a buffer that just grew by ten thousand rows loses their
     *   place completely. So it restores the same DISTANCE FROM THE
     *   BOTTOM instead, which is the only measure that survives a repaint.
     *
     * Inputs: term (object), ctl (object|null) - the real controller, for
     *   its fitAddon and its own scroll-to-bottom. pinned (boolean),
     *   distance (number) - rows above the bottom, sampled before the
     *   fetch. sessionId (string), navToken (any) - for the memo.
     * Output: object - {term, fitAddon, _forceScrollToBottom}.
     */
    function shimFor(term, ctl, pinned, distance, sessionId, navToken) {
        return {
            term: term,
            fitAddon: ctl ? ctl.fitAddon : null,
            _forceScrollToBottom: function () {
                rememberFrom(term, sessionId, navToken);
                if (pinned) {
                    if (ctl && typeof ctl._forceScrollToBottom === 'function') {
                        ctl._forceScrollToBottom();
                    }
                    return;
                }
                try {
                    var b = term.buffer.active;
                    term.scrollToLine(Math.max(0, (b.baseY || 0) - distance));
                } catch (err) {
                    console.warn('TerminalHistory: could not restore the '
                        + 'scroll position after the history paint', err);
                }
            }
        };
    }

    /** Record the buffer depth this load reached. Output: void. */
    function rememberFrom(term, sessionId, navToken) {
        var buf = term && term.buffer && term.buffer.active;
        memo = {
            sessionId: sessionId,
            navToken: navToken,
            baseYAfterPaint: buf && typeof buf.baseY === 'number' ? buf.baseY : 0
        };
    }

    global.TerminalHistory = {
        ensureLoaded: ensureLoaded,
        decide: decide,
        countLines: countLines,
        forget: forget
    };
}(typeof window !== 'undefined' ? window : globalThis));
