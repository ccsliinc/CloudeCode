/**
 * NavigationGeneration - the ONE answer to "is the navigation I started
 * still the one on screen?"
 *
 * WHY THIS MODULE EXISTS. Every path that puts a session on screen starts
 * asynchronous work, and none of them could tell whether their own
 * completion still belonged on screen. Click session A, click session B
 * before A settles, and A's late completion paints into B. This repo has
 * already paid for one instance of that exact shape - the theme bleed
 * fixed in a6b6b91, whose post-mortem is gotcha 7 in CLAUDE.md. That fix
 * produced ONE total function for themes specifically. This is the same
 * idea for navigation as a whole.
 *
 * THE SHARED SEMANTIC, and the reason it lives in one place: A COMPLETION
 * MAY ONLY WRITE TO SHARED UI STATE WHILE ITS NAVIGATION IS CURRENT.
 * Everything downstream of this module depends on that sentence meaning
 * exactly one thing.
 *
 * WHY A COUNTER AND NOT A TARGET IDENTITY. Two navigations to the SAME
 * session - click it, click away, click back - must not have the second
 * one satisfied by the first one's in-flight work, because the
 * intervening screen may have torn the terminal down. Comparing session
 * ids gets that wrong and a monotonic counter cannot.
 *
 * WHY A SEPARATE MODULE AND NOT A FIELD ON App. router.js, launchpad.js
 * and the conversation sidebar all need it, and app.js is already past
 * the 500-line guideline this repo keeps. A module with no dependencies
 * is also testable without a DOM, which is what
 * tests/test_navigation_generation.node.mjs relies on.
 *
 * WHAT A STALE TOKEN MEANS, AND WHAT IT DOES NOT. It means DISCARD,
 * silently, with a debug log. It never means retry and it never means
 * show an error: the user got what they asked for, which was the newer
 * screen. In particular a stale generation is NOT a rejected deep-link
 * target and must never raise Router.rejectTarget()'s banner.
 *
 * WHERE IT IS DELIBERATELY NOT USED. Not on a synchronous path. A check
 * between a gesture and a write with no await between them costs a
 * comparison, buys nothing, and tells the next reader there was a race
 * where there was none.
 *
 * ONE GLOBAL COUNTER, NOT ONE PER SURFACE. Per-surface tokens were
 * considered and refused: no caller in this client needs a sidebar
 * refresh to survive a terminal navigation, and building both would mean
 * two vocabularies for one question.
 */

console.log('[NavigationGeneration Module] Loading...');

(function () {
    'use strict';

    /**
     * The monotonic counter. Starts at 0, which is a real generation: the
     * page's own first paint navigated to whatever the URL named, and work
     * begun before anything else happened is legitimately current.
     * @type {number}
     */
    var generation = 0;

    /**
     * What the current generation was begun FOR. Diagnostics only - never
     * an input to isCurrent(), because comparing targets is precisely the
     * mistake the counter exists to avoid.
     * @type {string|null}
     */
    var currentTarget = null;

    /**
     * Description: declare a new navigation INTENT. Call at the TOP of
     *   every entry path, synchronously, before the first await. The value
     *   it returns is the caller's proof of ownership for the rest of that
     *   path.
     * Inputs: target (string|object|null) - what is being navigated to.
     *   Recorded for logging only; a string name or a session-shaped object
     *   are both accepted and anything else is stringified.
     * Output: number - the new generation.
     * Example:
     *   var nav = NavigationGeneration.begin('session:cloude_myproject');
     *   var info = await API.getSession(id);
     *   if (!NavigationGeneration.isCurrent(nav)) return;
     */
    function begin(target) {
        generation += 1;
        currentTarget = describeTarget(target);
        return generation;
    }

    /**
     * Description: read the generation that is current right now. For a
     *   callee that did not begin the navigation itself and must not bump
     *   the counter - App.showTerminal() is the worked example: bumping
     *   there would let a caller that ALREADY lost the race mint itself a
     *   fresh win.
     * Inputs: none.
     * Output: number.
     */
    function current() {
        return generation;
    }

    /**
     * Description: is this token still the current navigation?
     * Inputs: token (number) - a value returned by begin() or current().
     * Output: boolean - true only for an exact match. A non-number is
     *   false: a caller that lost its token has not proved anything, and
     *   guessing in its favour is how a guard becomes decorative.
     * Example: if (!NavigationGeneration.isCurrent(nav)) return;
     */
    function isCurrent(token) {
        return typeof token === 'number' && token === generation;
    }

    /**
     * Description: the standard discard. Logs at debug level and answers
     *   false so a caller can write `if (!NavGen.keep(nav, 'what')) return;`
     *   in one line instead of repeating the log at every site.
     * Inputs: token (number) - the caller's token.
     *   what (string) - what is being abandoned, for the log line.
     * Output: boolean - true to continue, false to discard.
     */
    function keep(token, what) {
        if (isCurrent(token)) return true;
        console.debug(
            '[nav] dropped ' + (what || 'work') + ' from a superseded navigation',
            { token: token, current: generation, target: currentTarget }
        );
        return false;
    }

    /**
     * Description: render a navigation target for a log line.
     * Inputs: target (string|object|null).
     * Output: string|null.
     */
    function describeTarget(target) {
        if (target == null) return null;
        if (typeof target === 'string') return target;
        if (typeof target === 'object') {
            var inner = (target.session && typeof target.session === 'object')
                ? target.session
                : target;
            return String(target.tmux_session || inner.tmux_session
                || inner.id || inner.name || '[object]');
        }
        return String(target);
    }

    window.NavigationGeneration = {
        begin: begin,
        current: current,
        isCurrent: isCurrent,
        keep: keep
    };
})();

console.log('[NavigationGeneration Module] Exported as window.NavigationGeneration');
