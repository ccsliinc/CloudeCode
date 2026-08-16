/**
 * Terminal scroll anchoring.
 * ----------------------------------------------------------------------
 * Owns the single question "after this write, should the viewport jump
 * back to the bottom?" and nothing else.
 *
 * WHY THIS EXISTS (the scrollback bug):
 *
 * The original code answered that question with a boolean
 * (`Terminal#autoScrollEnabled`) that was flipped to false by a
 * `.xterm-viewport` scroll listener behind a 100ms debounce, while
 * `Terminal#flush()` called `scrollToBottom()` on EVERY write for as
 * long as the flag was still true. While an agent is streaming output
 * (a spinner alone redraws several times a second) those two race, and
 * the write always wins:
 *
 *   1. finger drags up  -> scroll event -> 100ms debounce timer starts
 *   2. output arrives inside that 100ms -> flag still true -> yanked
 *      back to the bottom
 *   3. the yank is itself a scroll event, so the debounce restarts; when
 *      it finally runs the viewport IS at the bottom, so the flag is set
 *      back to true
 *
 * The user can never stay scrolled up. The desktop wheel path dodged it
 * by clearing the flag synchronously (its own comment called this
 * "bypass the 100ms scroll-listener debounce race"), which is why the
 * wheel half-worked and touch did not at all.
 *
 * THE FIX: stop tracking intent in a racing flag and measure the actual
 * buffer position BEFORE each write. xterm exposes it exactly:
 * `buffer.active.viewportY` is the top row on screen and
 * `buffer.active.baseY` is the top row when scrolled fully down, so
 * `viewportY >= baseY` IS "the user is at the bottom". Sampled before
 * `term.write()` it cannot race the write, because it describes where
 * the user had already put the viewport. A short gesture latch covers
 * the remaining case of momentum scrolling passing through the bottom
 * mid-drag.
 *
 * No timers decide anything here; the latch only suppresses.
 */
(function () {
    'use strict';

    /**
     * How long after the last touch/wheel movement we keep refusing to
     * auto-scroll. Covers iOS momentum, which keeps moving the viewport
     * after touchend with no further touch events.
     */
    var GESTURE_LATCH_MS = 1200;

    /** Timestamp (ms) of the last user scroll gesture. 0 = never. */
    var lastGestureAt = 0;

    /** True between touchstart and touchend on the viewport. */
    var touchActive = false;

    /** Guard so init() is idempotent across session swaps. */
    var wired = false;

    /**
     * Returns the live xterm Terminal, or null. Set by init(). A getter
     * rather than the instance because the listeners are wired once onto
     * #terminal (never recreated) while `term` IS replaced on a session
     * swap.
     *
     * @type {function(): (object|null)}
     */
    var getTerm = function () { return null; };

    /** pageY of the previous touchmove, for per-event deltas. */
    var lastTouchY = 0;

    /**
     * Vertical pixels moved by the touchmove currently being dispatched,
     * measured in the capture-phase listener so the value is correct no
     * matter who handles the event afterwards. Positive = finger moved
     * up = scroll forward through the buffer, matching xterm's own sign
     * convention in `Viewport#handleTouchMove`.
     */
    var pendingDy = 0;

    /** Sub-row remainder carried between touchmoves so slow drags move. */
    var pendingRows = 0;

    /** Fallback row height (px) when the viewport cannot be measured. */
    var FALLBACK_CELL_HEIGHT = 17;

    /**
     * Is the terminal viewport scrolled to the live bottom?
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {boolean} true when the bottom row is on screen, and also
     *   true when the buffer cannot be read (fail safe: an unreadable
     *   buffer should keep following output rather than freeze).
     */
    function isPinnedToBottom(term) {
        if (!term) return true;
        try {
            var buf = term.buffer && term.buffer.active;
            if (!buf) return true;
            return buf.viewportY >= buf.baseY;
        } catch (err) {
            console.warn('TerminalScroll: buffer read failed', err);
            return true;
        }
    }

    /**
     * Record that the user just scrolled by hand. Suppresses auto-scroll
     * for GESTURE_LATCH_MS so momentum cannot be cut short.
     *
     * @returns {void}
     */
    function noteUserScroll() {
        lastGestureAt = Date.now();
    }

    /**
     * Is a user scroll gesture in progress (finger down, or inside the
     * momentum latch)?
     *
     * @returns {boolean}
     */
    function isGestureActive() {
        if (touchActive) return true;
        return (Date.now() - lastGestureAt) < GESTURE_LATCH_MS;
    }

    /**
     * The whole decision, sampled BEFORE a write.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {boolean} true when the write that follows should be
     *   chased with scrollToBottom().
     */
    function shouldFollowOutput(term) {
        if (isGestureActive()) return false;
        return isPinnedToBottom(term);
    }

    /**
     * Drop the gesture latch and jump to the live bottom. Used by the
     * d-pad "scroll to bottom" control and by post-reconnect repaint,
     * both of which are explicit "take me back to live" intents that
     * must beat a latch the user's last drag left behind.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {void}
     */
    function pinToBottom(term) {
        lastGestureAt = 0;
        touchActive = false;
        if (!term) return;
        try {
            term.scrollToBottom();
        } catch (err) {
            console.warn('TerminalScroll: scrollToBottom failed', err);
        }
    }

    /**
     * Height of one terminal row in CSS pixels.
     *
     * Measured from the DOM rather than read out of xterm's private
     * render service, so it cannot break on a vendored-bundle bump.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {number} row height in px, never zero.
     */
    function cellHeight(term) {
        try {
            var vp = document.querySelector('.xterm-viewport');
            if (vp && vp.clientHeight > 0 && term.rows > 0) {
                return vp.clientHeight / term.rows;
            }
        } catch (err) {
            console.warn('TerminalScroll: cell height read failed', err);
        }
        return FALLBACK_CELL_HEIGHT;
    }

    /**
     * Can the terminal buffer still move in the direction of this drag?
     *
     * This is the whole distinction between a drag the terminal can
     * CONSUME and a drag that is trying to ESCAPE to the page. It is
     * asked of the xterm buffer, not of any DOM scroll position, because
     * the buffer is what the user is actually looking at.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @param {number} rows - whole rows to scroll; >0 forward, <0 back.
     * @returns {boolean} true when scrolling by `rows` would move the view.
     */
    function canConsumeScroll(term, rows) {
        if (!term || !rows) return false;
        try {
            var buf = term.buffer && term.buffer.active;
            if (!buf) return false;
            return rows < 0 ? buf.viewportY > 0 : buf.viewportY < buf.baseY;
        } catch (err) {
            console.warn('TerminalScroll: buffer read failed', err);
            return false;
        }
    }

    /**
     * Scroll the terminal by hand for a drag xterm declined to handle.
     *
     * WHY THIS IS NEEDED (measured on iPhone 16e / iOS 26.1, 2026-08-16):
     * xterm 5.3.0 gates BOTH of its touch handlers on
     * `!coreMouseService.areMouseEventsActive`, so the moment an
     * application turns on mouse reporting - which Claude Code does,
     * VT200 with SGR encoding - xterm stops scrolling the viewport by
     * touch entirely and stops cancelling the touchmove as well. The
     * wheel path is gated on a narrower condition (only the wheel bit of
     * the active protocol, which VT200 does not set), so the desktop
     * wheel keeps working. That asymmetry IS the reported bug: scrollback
     * exists, desktop scrolls, the phone cannot.
     *
     * Native scrolling is not an available fallback either: the touch
     * lands on `canvas.xterm-link-layer`, which is a SIBLING of
     * `.xterm-viewport`, so the scrollable element is not on the touch
     * target's ancestor chain at all.
     *
     * @param {number} dy - pixels the finger moved this event, up-positive.
     * @returns {boolean} true when the view actually moved.
     */
    function consumeDragScroll(dy) {
        var term = getTerm();
        if (!term || !dy) return false;
        pendingRows += dy / cellHeight(term);
        var rows = pendingRows > 0 ? Math.floor(pendingRows) : Math.ceil(pendingRows);
        if (!rows) return false;
        if (!canConsumeScroll(term, rows)) {
            // At the boundary. Drop the remainder so it cannot accumulate
            // into a jump when the user drags back the other way.
            pendingRows = 0;
            return false;
        }
        pendingRows -= rows;
        try {
            term.scrollLines(rows);
        } catch (err) {
            console.warn('TerminalScroll: scrollLines failed', err);
            return false;
        }
        return true;
    }

    /**
     * Stop a boundary drag from escaping to the page.
     *
     * xterm's own touchmove handler scrolls `.xterm-viewport` in JS and
     * calls preventDefault ONLY while the viewport can still move in
     * that direction (`_bubbleScroll`); at either boundary it returns
     * without cancelling, on purpose, so the host page can take over.
     * On a page whose body is `overflow: hidden` there is nothing for
     * the page to scroll, so iOS Safari claims the gesture instead and
     * reloads - the "it tries to refresh" the user reported. The CSS
     * `overscroll-behavior: contain` on `.terminal-container` is the
     * declarative half of this fix; this is the half that does not
     * depend on an engine honouring that property on a non-scrollable
     * scroll container.
     *
     * Deliberately narrow:
     *   - runs in the BUBBLE phase on #terminal, so xterm (bound on the
     *     descendant `.xterm`) has already had the event and already
     *     cancelled it whenever it consumed the scroll;
     *   - `defaultPrevented` short-circuit means normal in-range
     *     scrolling is never touched, only the released boundary case;
     *   - single-touch only, so pinch-zoom over the terminal still
     *     reaches the browser;
     *   - touch-select.js calls stopPropagation() while a selection
     *     drag is live, so this never runs during select mode.
     *
     * It must, however, distinguish the two very different reasons a
     * touchmove can arrive here uncancelled, because the original version
     * only knew about the first and swallowed the second:
     *
     *   ESCAPE  - the terminal is at a scrollback boundary, so there is
     *             nothing left to show in that direction. Cancel and stop,
     *             which is the pull-to-refresh block.
     *   CONSUMABLE - the terminal is NOT at that boundary and simply was
     *             not offered the event, because mouse reporting is on
     *             (see consumeDragScroll). Scroll it here, then cancel.
     *
     * The test is `canConsumeScroll`: it asks the xterm buffer whether
     * `viewportY` can still move in the direction of THIS drag. Nothing
     * else can tell them apart - the event flags are identical in both
     * cases, which is precisely why the bug was invisible.
     *
     * @param {TouchEvent} ev - the bubbling touchmove.
     * @returns {void}
     */
    function blockOverscrollEscape(ev) {
        if (ev.defaultPrevented) return;
        if (!ev.cancelable) return;
        if (ev.touches && ev.touches.length !== 1) return;
        consumeDragScroll(pendingDy);
        pendingDy = 0;
        ev.preventDefault();
    }

    /**
     * Wire the gesture listeners. Idempotent; listeners ride on the
     * #terminal container (never recreated) so a term.reset() during a
     * session swap does not wipe them.
     *
     * @param {HTMLElement} container - the #terminal element.
     * @param {function(): (object|null)} [termGetter] - returns the live
     *   xterm Terminal. Required for touch scrolling under mouse
     *   reporting; omitting it degrades to block-only behaviour.
     * @returns {void}
     */
    function init(container, termGetter) {
        if (typeof termGetter === 'function') getTerm = termGetter;
        if (wired || !container) return;
        wired = true;

        // Passive: we never cancel these, we only observe that the user
        // is driving the viewport. Cancelling would break xterm's own
        // native touch scrolling, which is what we want to preserve.
        container.addEventListener('touchstart', function (ev) {
            touchActive = true;
            pendingRows = 0;
            pendingDy = 0;
            if (ev && ev.touches && ev.touches.length) lastTouchY = ev.touches[0].pageY;
            noteUserScroll();
        }, { capture: true, passive: true });

        // Capture phase on purpose: the per-event delta has to be taken
        // BEFORE xterm's own handler runs, so the number is right whether
        // xterm consumes the event or declines it.
        container.addEventListener('touchmove', function (ev) {
            if (ev && ev.touches && ev.touches.length === 1) {
                var y = ev.touches[0].pageY;
                pendingDy = lastTouchY - y;
                lastTouchY = y;
            } else {
                pendingDy = 0;
            }
            noteUserScroll();
        }, { capture: true, passive: true });

        var endGesture = function () {
            touchActive = false;
            noteUserScroll();
        };
        container.addEventListener('touchend', endGesture, { capture: true, passive: true });
        container.addEventListener('touchcancel', endGesture, { capture: true, passive: true });

        container.addEventListener('wheel', function () {
            noteUserScroll();
        }, { capture: true, passive: true });

        // The one NON-passive listener here: it has to be able to cancel.
        // Bubble phase on purpose - see blockOverscrollEscape().
        container.addEventListener('touchmove', blockOverscrollEscape, { passive: false });
    }

    /** Test seam: reset module state between assertions. */
    function _reset() {
        lastGestureAt = 0;
        touchActive = false;
        wired = false;
        lastTouchY = 0;
        pendingDy = 0;
        pendingRows = 0;
        getTerm = function () { return null; };
    }

    window.TerminalScroll = {
        init: init,
        blockOverscrollEscape: blockOverscrollEscape,
        canConsumeScroll: canConsumeScroll,
        consumeDragScroll: consumeDragScroll,
        isPinnedToBottom: isPinnedToBottom,
        shouldFollowOutput: shouldFollowOutput,
        noteUserScroll: noteUserScroll,
        isGestureActive: isGestureActive,
        pinToBottom: pinToBottom,
        _reset: _reset
    };
})();
