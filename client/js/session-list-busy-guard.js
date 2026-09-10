/**
 * IS THE USER MID-INTERACTION INSIDE THE LIST WE ARE ABOUT TO WIPE?
 * ----------------------------------------------------------------------
 * `renderRunningSessions()` ends in an unconditional `innerHTML =`
 * write, and a write landing while an inline rename input is open
 * DELETES THE FIELD, THE CARET AND THE TYPED TEXT with no error
 * anywhere. The signature diff does not save it: a status flip on any
 * OTHER row is a real change and paints.
 *
 * THIS FILE IS WHAT SURVIVED `project-list-render-guard.js`. That module
 * held three unrelated predicates for three unrelated consumers, and
 * slice 4 of the Svelte migration deleted the one it was named for -
 * the project tree is reactive now, so there is no repaint to guard and
 * nothing that could destroy what a user is doing. `shouldPoll` moved to
 * `web/src/lib/sessions/poller.ts`, beside the tick it gates. This is
 * the last one, and it lives here rather than in a 220-line file whose
 * headline function no longer exists.
 *
 * SLICE 5 DELETES IT. When the running-sessions list becomes a component
 * its rows stop being rebuilt, and a guard against a repaint that cannot
 * happen is dead weight.
 *
 * BUSY IS MEASURED IN THE CONTAINER, NOT ON THE PAGE. An open row
 * overflow menu (`SessionRowMenuOpen.isOpen()` - its own predicate,
 * reused rather than re-derived) and a live inline rename input both
 * mean a repaint would delete something under the user's hands. The
 * focus test is scoped with `container.contains()` on purpose: a focused
 * input anywhere else on the page is none of this guard's business, and
 * a page-wide focus test would let one stray focused field freeze the
 * list indefinitely.
 *
 * SKIPPING A PAINT IS NOT REMEMBERING IT. The caller stores nothing on a
 * busy skip, so the very next tick paints once the reason has gone.
 * There is no queue, no timer and no flag to leak.
 *
 * Load BEFORE launchpad.js.
 */

(function () {
    'use strict';

    /**
     * Elements that mean a user is editing inside the list right now.
     * Exact class names taken from the code that creates them
     * (launchpad.js `_handleRenameRunningSession`), never guessed.
     */
    var EDITOR_SELECTORS = ['.running-session-rename-input'];

    /** Tag names whose focus means "typing", for the focus test. */
    var EDITOR_TAGS = { INPUT: true, TEXTAREA: true, SELECT: true };

    /**
     * Is the user mid-interaction with something inside this container?
     *
     * Description: an open row overflow menu, a live inline rename input,
     *   or focus sitting in an editable field INSIDE the container. Any
     *   of the three makes a repaint destructive rather than merely
     *   wasteful.
     * Inputs: opts (object) - {container: Element, doc: Document}.
     * Output: boolean. A missing container answers false: there is
     *   nothing to destroy.
     * Example: if (SessionListBusyGuard.isBusy({container: el})) return;
     */
    function isBusy(opts) {
        var container = opts && opts.container;
        var doc = (opts && opts.doc) || (typeof document !== 'undefined' ? document : null);
        if (!container) return false;

        var menu = typeof window !== 'undefined' ? window.SessionRowMenuOpen : null;
        if (menu && typeof menu.isOpen === 'function' && menu.isOpen()) return true;

        if (typeof container.querySelector === 'function') {
            for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
                if (container.querySelector(EDITOR_SELECTORS[i])) return true;
            }
        }

        var active = doc ? doc.activeElement : null;
        if (active
                && typeof container.contains === 'function'
                && container.contains(active)) {
            if (EDITOR_TAGS[active.tagName]) return true;
            if (active.isContentEditable) return true;
        }
        return false;
    }

    window.SessionListBusyGuard = {
        isBusy: isBusy,
    };
})();
