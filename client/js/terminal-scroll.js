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
     * @param {TouchEvent} ev - the bubbling touchmove.
     * @returns {void}
     */
    function blockOverscrollEscape(ev) {
        if (ev.defaultPrevented) return;
        if (!ev.cancelable) return;
        if (ev.touches && ev.touches.length !== 1) return;
        ev.preventDefault();
    }

    /**
     * Wire the gesture listeners. Idempotent; listeners ride on the
     * #terminal container (never recreated) so a term.reset() during a
     * session swap does not wipe them.
     *
     * @param {HTMLElement} container - the #terminal element.
     * @returns {void}
     */
    function init(container) {
        if (wired || !container) return;
        wired = true;

        // Passive: we never cancel these, we only observe that the user
        // is driving the viewport. Cancelling would break xterm's own
        // native touch scrolling, which is what we want to preserve.
        container.addEventListener('touchstart', function () {
            touchActive = true;
            noteUserScroll();
        }, { capture: true, passive: true });

        container.addEventListener('touchmove', function () {
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
    }

    window.TerminalScroll = {
        init: init,
        blockOverscrollEscape: blockOverscrollEscape,
        isPinnedToBottom: isPinnedToBottom,
        shouldFollowOutput: shouldFollowOutput,
        noteUserScroll: noteUserScroll,
        isGestureActive: isGestureActive,
        pinToBottom: pinToBottom,
        _reset: _reset
    };
})();
