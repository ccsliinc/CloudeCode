/**
 * ToastRenderBatch - the frame-or-timer race that lets ToastManager
 * coalesce many model changes into ONE render pass, without betting the
 * flush on a repaint that may never come.
 *
 * WHY THIS EXISTS. `_render()` (client/js/toast-render.js) rebuilds the
 * WHOLE visible card set on every call - the cap, the coalesce counts and
 * the overflow row are all functions of the whole set, so a single-record
 * mutation can invalidate all three. Calling it once per arriving record
 * therefore buys nothing over calling it once per BURST of records.
 * Issue #39 measured a 500-record backfill causing 500 renders and about
 * 173ms of synchronous work, freezing the tab; a bulk "dismiss all" has
 * the identical shape, from the other direction, because each dismissed
 * card's own 220ms fade-out timer used to call `_render()` again on its
 * own.
 *
 * GOTCHA 9 (see CLAUDE.md): a bare `await requestAnimationFrame` never
 * resolves in a hidden tab, because a browser does not run rAF callbacks
 * for a tab it is not painting - not late, not ever, until the tab is
 * painted again. A scheduler built only on rAF would therefore leave an
 * entire backfill sitting un-rendered for as long as the tab stays
 * backgrounded, which is worse than the freeze it replaces: at least a
 * synchronous render eventually finishes. `client/js/terminal-layout-wait.js`
 * already states the rule this follows: a wait may DELAY work, never
 * CANCEL it, and it satisfies that by racing every frame against a plain
 * `setTimeout`, which still fires (throttled, but it fires) in a
 * backgrounded tab.
 *
 * NOT A DEPENDENCY ON terminal-layout-wait.js. That module answers a
 * different question - "has the terminal's layout settled for a couple of
 * frames" - and toasts render on the launchpad and archive screens, which
 * hold no terminal and no reason to load a terminal-specific module. This
 * is the same frame-or-timer PATTERN, reimplemented as its own small
 * dependency-free file, matching how client/js/terminal-write-queue.js
 * stands alone as a pure policy module beside the class that uses it.
 *
 * ONE PENDING FLUSH PER CALLER, NOT A QUEUE. This module holds no state of
 * its own between calls - `ToastManager` is the one that remembers "a
 * flush is already pending" (`_renderPending` in toast-render.js's
 * `_scheduleRender`) and refuses to call `schedule()` again until the
 * pending one has run. That is the entire coalescing mechanism: every
 * model change folds into whichever flush is already in flight.
 *
 * DEGRADES TO IMMEDIATE, NEVER TO SILENT. A caller that finds this module
 * missing (a stripped-down harness, a load-order accident) must render
 * right away rather than not at all - see `_scheduleRender`'s own
 * fallback branch. This file's job is only to decide WHEN a scheduled
 * flush runs, never whether one runs.
 */
console.log('[ToastRenderBatch Module] Loading...');

(function (global) {
    'use strict';

    /**
     * Bound on the setTimeout fallback race, in milliseconds. About two
     * frames' worth: short enough that a foreground burst still reads as
     * instantaneous, and long enough that it is not fighting the frame for
     * no reason. The exact number is not load-bearing - what matters is
     * that it is FINITE, because a background tab never fires a bare rAF
     * at all, so any finite bound beats none.
     * @type {number}
     */
    var FALLBACK_MS = 32;

    /**
     * Run `flush` exactly once, as soon as a frame paints or the fallback
     * timer fires, whichever happens first.
     *
     * Description: in a painted, foreground tab the animation frame wins
     *   and every change made in the current synchronous burst is visible
     *   to `flush` by the time it runs - the whole coalescing property. In
     *   a tab that is not being painted, or a harness with no
     *   `requestAnimationFrame` at all, the timer wins instead, so the
     *   flush still happens rather than waiting on a frame that may never
     *   come.
     * Inputs: flush (function) - called with no arguments, at most once.
     * Output: {cancel: function} - cancels this specific pending call if
     *   neither race leg has fired yet. `ToastManager` does not use it
     *   today (there is nothing to cancel a render in favour of), but a
     *   scheduler that could not be cancelled would be a worse building
     *   block for the next caller than one that can.
     * Example: ToastRenderBatch.schedule(() => this._render());
     */
    function schedule(flush) {
        var done = false;
        function run() {
            if (done) return;
            done = true;
            flush();
        }
        var timer = setTimeout(run, FALLBACK_MS);
        try {
            global.requestAnimationFrame(function () {
                clearTimeout(timer);
                run();
            });
        } catch (e) {
            // No requestAnimationFrame at all (a non-browser harness, or a
            // browser API missing for some other reason). The timer still
            // settles this, so the caller is never stranded - the same
            // reasoning terminal-layout-wait.js's own catch uses.
            clearTimeout(timer);
            run();
        }
        return {
            cancel: function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
            },
        };
    }

    global.ToastRenderBatch = {
        FALLBACK_MS: FALLBACK_MS,
        schedule: schedule,
    };
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[ToastRenderBatch Module] Exported as window.ToastRenderBatch');
