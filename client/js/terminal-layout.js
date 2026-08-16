/**
 * Terminal layout / resize pipeline.
 * ----------------------------------------------------------------------
 * Owns the single question "the terminal's box may have changed - refit
 * it and tell tmux" and nothing else. Extracted from terminal.js, which
 * is over the project's 500-line ceiling and must not grow.
 *
 * WHY IT IS ALSO AN EXPLICIT API, not only a set of listeners.
 *
 * The implicit contract used to be "any layout change is caught by the
 * ResizeObserver on #terminal, so callers never have to say anything".
 * That is true only for changes that alter #terminal's own border box,
 * and only if the observer survived. The sidebar pin (session-sidebar-
 * pin.js) shipped on that assumption and the resize was reported not to
 * happen. Rather than debug an invisible dependency, a caller that KNOWS
 * it just changed the layout now says so:
 *
 *     window.TerminalLayout.requestFit('sidebar-pin');
 *
 * The observer stays as the safety net for changes nobody announces.
 * Both routes land in the same debounced fit, so an announced change
 * that ALSO trips the observer still produces exactly one resize frame,
 * and TerminalController#sendResize dedups on (cols, rows) on top of
 * that.
 *
 * NOTHING HERE SCROLLS THE TERMINAL. Refitting must never yank a user who
 * has scrolled up back to the bottom - that is the bug terminal-scroll.js
 * exists to prevent. `fit()` reflows; it is not a scroll command, and no
 * scrollToBottom() call belongs in this file.
 *
 * Loaded BEFORE terminal.js, which calls install() from initTerminal().
 */

console.log('[TerminalLayout Module] Loading...');

(function () {
    'use strict';

    /**
     * Debounce window in ms. One physical layout change fires several of
     * the sources below (a CSS transition alone produces a ResizeObserver
     * callback per frame); collapsing them to one fit keeps a single
     * pty_resize on the wire.
     * @type {number}
     */
    const DEBOUNCE_MS = 100;

    /** @type {?object} The TerminalController install() was given. */
    let controller = null;
    /** @type {?number} Pending debounce timer id. */
    let timer = null;
    /** @type {?ResizeObserver} Observer on the xterm container. */
    let observer = null;
    /** @type {boolean} Guard so install() is idempotent. */
    let listenersWired = false;
    /** @type {string[]} Every reason seen since the last flush, for logs. */
    let pendingReasons = [];

    /**
     * Refit the terminal to its container and ship the new geometry to
     * the backend. Runs at most once per debounce window.
     *
     * @param {string} reason - tag forwarded to sendResize for the
     *   [TERM-RESIZE] log line.
     * @returns {void}
     */
    function flush(reason) {
        timer = null;
        pendingReasons = [];
        if (!controller || !controller.fitAddon || !controller.term) return;
        try {
            controller.fitAddon.fit();
        } catch (err) {
            console.warn('TerminalLayout: fit failed', err);
            return;
        }
        // sendResize is the ONLY path to tmux. A client-side fit that is
        // not followed by this leaves xterm and the pty disagreeing about
        // the grid, which is what "tmux does not resize" looks like.
        controller.sendResize(reason);
    }

    /**
     * Queue a refit. Safe to call from anywhere, any number of times.
     *
     * @param {string} [reason='unknown'] - what changed, for the log line.
     * @param {{immediate?: boolean}} [opts] - immediate skips the
     *   debounce. Use only when the caller knows layout has already
     *   settled; a mid-transition immediate fit measures the wrong box.
     * @returns {void}
     */
    function requestFit(reason = 'unknown', opts = {}) {
        pendingReasons.push(reason);
        if (opts.immediate) {
            if (timer) { clearTimeout(timer); timer = null; }
            flush(reason);
            return;
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => flush(reason), DEBOUNCE_MS);
    }

    /**
     * Wire the pipeline to a TerminalController and start listening.
     * Idempotent: a second call re-points the controller but does not
     * stack a second set of listeners.
     *
     * Sources, and what each one alone would miss:
     *   window.resize          - desktop window / browser chrome
     *   orientationchange      - phone rotation
     *   visualViewport.resize  - on-screen keyboard, iOS URL bar collapse
     *   ResizeObserver         - any layout change of #terminal that no
     *                            caller announced (font load, CSS
     *                            transition, docked panel)
     *
     * @param {object} ctl - a TerminalController with .fitAddon, .term
     *   and .sendResize(reason).
     * @returns {void}
     */
    function install(ctl) {
        controller = ctl;
        if (listenersWired) return;
        listenersWired = true;

        window.addEventListener('resize', () => requestFit('window.resize'));
        window.addEventListener('orientationchange', () => requestFit('orientationchange'));
        if (window.visualViewport) {
            window.visualViewport.addEventListener(
                'resize', () => requestFit('visualViewport.resize'));
        }

        const container = document.getElementById('terminal');
        if (container && typeof ResizeObserver !== 'undefined') {
            try {
                observer = new ResizeObserver(() => requestFit('ResizeObserver'));
                observer.observe(container);
            } catch (err) {
                console.warn('TerminalLayout: ResizeObserver setup failed', err);
            }
        }
    }

    window.TerminalLayout = {
        install,
        requestFit,
        DEBOUNCE_MS,
        /** Test seam: the live observer, or null when unsupported. */
        get observer() { return observer; },
    };
    console.log('[TerminalLayout Module] Exported as window.TerminalLayout');
})();
