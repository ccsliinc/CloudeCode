/**
 * Force local selection while scrolled up and mouse tracking is active.
 * ----------------------------------------------------------------------
 * WHY THIS EXISTS (the "highlight lands off screen at the bottom" bug):
 *
 * xterm's own bindMouse() ONLY consults the running application when the
 * app has turned on mouse tracking (`?1000h` etc, `coreMouseService.
 * areMouseEventsActive`). When it has, a plain mousedown/drag is NOT
 * treated as a local text selection at all - `SelectionService.disable()`
 * runs the moment tracking turns on, and the click/drag/release are
 * instead ENCODED as SGR mouse reports and forwarded to the pty. See
 * `bindMouse()` and `SelectionService.handleMouseDown()` in the vendored
 * bundle: `if(!this._enabled){ if(!this.shouldForceSelection(e)) return; }`.
 *
 * That encoding is fundamentally SCREEN-relative, not buffer-relative: the
 * row/col in an SGR report describe a cell in the currently RENDERED grid
 * (1..term.rows), with no channel to say "this grid is showing scrollback,
 * not the live screen". Measured against the real vendored bundle: the
 * same drag over the same on-screen pixels encodes IDENTICAL row/col
 * whether viewportY equals baseY (live) or sits 30 rows above it (scrolled
 * up) - see tests/test_terminal_select_scrolled.node.mjs. The running
 * program has no idea the user is looking at history; it applies "row 3"
 * to whatever IT thinks occupies row 3 of its own live screen, which is
 * wherever its cursor-addressable output actually is - near the true
 * bottom of the buffer while the user is scrolled away from it. Any
 * highlight the program draws in response to that click lands there:
 * below the visible viewport, invisible until the user scrolls all the
 * way back down. That is the reported "highlites on bottom off screen".
 *
 * BEFORE commit 04139ac this was masked, not fixed: every mouse report -
 * including the very first mousedown of the drag - ALSO called
 * TerminalScroll.pinToBottom(), so the instant the user pressed the mouse
 * button the view snapped back to the live position first. The user was
 * never actually looking at scrollback while dragging; there was nothing
 * for the screen-relative encoding to get wrong. Fixing the mouse-jump bug
 * removed that side effect and exposed this pre-existing one.
 *
 * THE FIX, without reintroducing the jump: xterm ships exactly the escape
 * hatch this needs already - `SelectionService.shouldForceSelection(e)`
 * bypasses the report path for a shift-click (or option-click on macOS,
 * gated by `macOptionClickForcesSelection`) so a user can always select
 * text locally even while an app owns the mouse. This module applies that
 * bypass AUTOMATICALLY, but only when it is the only sensible outcome:
 * the terminal is scrolled away from the live bottom AND the app has
 * mouse tracking on. In that state a forwarded report cannot possibly mean
 * what the app thinks it means (see above), so a local selection is
 * strictly more correct than sending it. At the live bottom, nothing here
 * changes: `TerminalScroll.isPinnedToBottom()` is true, this module steps
 * aside, and the app's own mouse-driven UI (menus, scrollbars, pickers)
 * keeps working exactly as before.
 *
 * MECHANISM: a capture-phase `mousedown` on the #terminal container (the
 * PARENT of `term.element`, so this runs before xterm's own bubble-phase
 * listeners on `term.element` ever see the event - same technique
 * touch-select.js uses for its long-press synthesis) cancels the real
 * event and replaces it with an equivalent synthetic one carrying
 * `shiftKey` and `altKey` both set, with `macOptionClickForcesSelection`
 * flipped on for the instant of dispatch. Only the DOWN event needs
 * synthesis: once `SelectionService.handleMouseDown()` runs with the
 * force-selection gate satisfied, it wires its OWN document-level
 * mousemove/mouseup listeners (unconditional - they do not re-check the
 * modifier), so the REAL subsequent drag events drive the rest without
 * further help. See tests/test_terminal_select_scrolled.node.mjs for the
 * headless proof against the real vendored bundle.
 */
(function () {
    'use strict';

    /**
     * Is the running application currently reading raw mouse events?
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {boolean}
     */
    function areMouseEventsActive(term) {
        try {
            var core = term && term._core;
            var svc = core && core.coreMouseService;
            return !!(svc && svc.areMouseEventsActive);
        } catch (err) {
            console.warn('TerminalSelectScrolled: mouse-service read failed', err);
            return false;
        }
    }

    /**
     * Is the terminal showing something other than the true live output?
     *
     * TWO INDEPENDENT WAYS THIS CAN BE TRUE, because they are two
     * independent ways a terminal can stop tracking its own scrollback:
     *
     * 1. REAL SCROLLBACK, MOVED. Delegates to terminal-scroll.js's
     *    `isPinnedToBottom()` (`viewportY >= baseY`) so the two modules
     *    cannot disagree about what "scrolled up" means. This is the
     *    ONLY case xterm's own buffer state can answer, and only on the
     *    NORMAL screen - see next.
     *
     * 2. THE ALTERNATE SCREEN, SHOWING SOMETHING OTHER THAN THE LIVE
     *    PROMPT. `buffer.active.baseY` is 0 on the alternate screen BY
     *    CONSTRUCTION - it has no scrollback dimension at all, so
     *    `isPinnedToBottom()` is tautologically true there NO MATTER
     *    WHAT is on screen. Measured live 2026-08-17 against a real
     *    session: forced tmux into copy-mode 10 rows back on an
     *    alternate-screen pane (`vim`, mouse reporting on) - the browser
     *    visibly rendered the scrolled-back rows, `getSelection()` after
     *    a real drag over them came back empty, and `term.buffer.active`
     *    read `{viewportY: 0, baseY: 0}` throughout, `isPinnedToBottom()`
     *    true the entire time. Case 1 cannot see this by construction, so
     *    it needs its own check. altscreen-scroll.js already answers the
     *    identifiable version of this question for claude specifically -
     *    `detectState(term) === 'transcript'` is proven (by the
     *    transcript view's own unique footer text) to mean the alternate
     *    screen is showing scrolled-back messages, not the live prompt.
     *    `'live'` and `'unknown'` are deliberately NOT treated as
     *    scrolled: a fresh non-claude alt-screen program (vim, htop) that
     *    the user has not scrolled at all is still legitimately owed its
     *    own mouse clicks (positioning a cursor, opening its own visual
     *    selection), and forcing local selection there would be a new
     *    regression, not a fix - see altscreen-scroll.js's own contract
     *    that 'unknown' means "do nothing", not "assume the worst".
     *
     * Fails closed on both paths (an unreadable state counts as "at the
     * bottom" / "not transcript") so an error here can only skip this
     * module's behaviour, never suppress a legitimate app mouse report.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @returns {boolean}
     */
    function isScrolledUp(term) {
        var ts = window.TerminalScroll;
        var realScrollback = !!(ts && typeof ts.isPinnedToBottom === 'function'
            && !ts.isPinnedToBottom(term));
        if (realScrollback) return true;

        var as = window.AltScreenScroll;
        if (as && typeof as.detectState === 'function') {
            try {
                return as.detectState(term) === 'transcript';
            } catch (err) {
                console.warn('TerminalSelectScrolled: altscreen state read failed', err);
                return false;
            }
        }
        return false;
    }

    /**
     * Replace a real mousedown with an equivalent synthetic one that
     * forces xterm's local-selection bypass, on both platforms.
     *
     * `macOptionClickForcesSelection` is flipped on only for the duration
     * of this synchronous dispatch (xterm reads it synchronously inside
     * the event listener chain triggered by dispatchEvent) so this module
     * never permanently changes the option the user may have set.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @param {Element} screenEl - `.xterm-screen`, the node xterm's own
     *   mouse listeners are bound to (bubbling from here reaches them).
     * @param {MouseEvent} real - the original mousedown, for its
     *   coordinates and button/detail fields.
     * @returns {void}
     */
    function dispatchForcedMouseDown(term, screenEl, real) {
        var opts = term.options;
        var prevForce = opts.macOptionClickForcesSelection;
        opts.macOptionClickForcesSelection = true;
        try {
            screenEl.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window,
                button: real.button,
                buttons: real.buttons || 1,
                detail: real.detail || 1,
                clientX: real.clientX,
                clientY: real.clientY,
                shiftKey: true,
                altKey: true,
            }));
        } finally {
            opts.macOptionClickForcesSelection = prevForce;
        }
    }

    /**
     * Capture-phase mousedown handler. Intercepts and replaces only the
     * gestures that would otherwise be misinterpreted - see file header.
     *
     * @param {object} term - an xterm.js Terminal instance.
     * @param {MouseEvent} ev - the real, trusted mousedown.
     * @returns {void}
     */
    function handleMouseDown(term, ev) {
        if (!term || !ev || ev.button !== 0) return;
        if (!areMouseEventsActive(term)) return; // normal path already works
        if (!isScrolledUp(term)) return;         // live bottom: leave the app in control
        var screenEl = term.element && term.element.querySelector('.xterm-screen');
        if (!screenEl) return;
        ev.preventDefault();
        ev.stopPropagation();
        dispatchForcedMouseDown(term, screenEl, ev);
    }

    /**
     * Wire the capture-phase listener. Idempotent; rides on #terminal
     * (never recreated) so a term.reset() during session swap does not
     * wipe it - same guarantee terminal-scroll.js and touch-select.js
     * rely on.
     *
     * @param {HTMLElement} container - the #terminal element.
     * @param {function(): (object|null)} termGetter - returns the live
     *   xterm Terminal.
     * @returns {void}
     */
    var wired = false;
    function init(container, termGetter) {
        if (wired || !container || typeof termGetter !== 'function') return;
        wired = true;
        container.addEventListener('mousedown', function (ev) {
            handleMouseDown(termGetter(), ev);
        }, { capture: true });
    }

    /** Test seam: reset module state between assertions. */
    function _reset() {
        wired = false;
    }

    window.TerminalSelectScrolled = {
        init: init,
        handleMouseDown: handleMouseDown,
        areMouseEventsActive: areMouseEventsActive,
        isScrolledUp: isScrolledUp,
        _reset: _reset
    };
})();
