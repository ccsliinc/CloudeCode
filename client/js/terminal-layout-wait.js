/**
 * terminal-layout-wait.js - wait for the terminal container to be
 * measurable WITHOUT betting the WebSocket on a repaint that may never
 * come.
 *
 * WHY THIS EXISTS, measured on live 2026-09-09. `connectWebSocket()`
 * opened with `await this.waitForFontsAndLayout(container)`, whose tail
 * was two bare `await new Promise(requestAnimationFrame)` calls. A
 * browser does not run rAF callbacks for a tab that is not being
 * painted, and it does not run them LATE either - it runs them when the
 * tab is painted again, which may be never. So entering a session in a
 * backgrounded tab suspended `connectWebSocket()` INSIDE the await,
 * before `window.API.openWebSocket()` was ever reached. The terminal
 * then sat with `ws === null` and `sessionActive === true` forever: no
 * socket to close, so no `onclose`, so no reconnect - the auto-reconnect
 * ladder cannot fire for a connection that was never attempted. The
 * status affordance stayed on "Connecting to terminal...", the string
 * set on the line above the await.
 *
 * The measurement: a session entered at 23:57:28Z had no WebSocket at
 * 00:02Z; a bare `requestAnimationFrame` in that tab did not fire within
 * 3000 ms while `document.visibilityState === 'hidden'`; and the
 * suspended connect completed and opened its socket the instant the tab
 * was painted, 35 minutes later.
 *
 * IT IS NOT ONLY THE TERMINAL THAT BREAKS. The WS bind is where the
 * server clears the unread flag (`SessionManager.mark_session_viewed`),
 * so a session opened this way is never marked read and the user's row
 * keeps its unread halo with nothing able to clear it. That is the
 * symptom this was found through.
 *
 * THE RULE: a layout wait may DELAY a connect, never CANCEL one. Every
 * wait here is raced against a timer, because `setTimeout` still fires
 * in a background tab (throttled to about a second, which is fine) while
 * rAF does not fire at all. A timed-out wait is reported, not thrown -
 * the caller connects with whatever geometry it has, and the resize
 * handshake corrects the grid on the first real paint, which is the same
 * path a rotation already takes.
 */
(function (global) {
    'use strict';

    /** Cap on the busy-wait for a non-zero container box, in ms. */
    var SIZE_TIMEOUT_MS = 2000;
    /** Cap on each animation-frame wait, in ms. */
    var FRAME_TIMEOUT_MS = 250;
    /** How many animation frames the caller wants before measuring. */
    var FRAME_COUNT = 2;

    /**
     * Resolve on the next animation frame, or on a timer, whichever is
     * first.
     *
     * Description: the whole point of this module. In a painted tab the
     *   rAF wins and behaviour is byte-identical to what it replaces; in
     *   an unpainted one the timer wins and the caller proceeds instead
     *   of suspending forever. Never rejects.
     * Inputs:
     *   ms (number) - the timer cap in milliseconds.
     * Output: Promise<boolean> - true if a frame was painted, false if
     *   the timer fired first.
     * Example:
     *   const painted = await nextFrameOrTimeout(250);
     */
    function nextFrameOrTimeout(ms) {
        return new Promise(function (resolve) {
            var settled = false;
            function done(painted) {
                if (settled) return;
                settled = true;
                resolve(painted);
            }
            var timer = setTimeout(function () { done(false); }, ms);
            try {
                global.requestAnimationFrame(function () {
                    clearTimeout(timer);
                    done(true);
                });
            } catch (e) {
                // No rAF at all (a non-browser harness). The timer still
                // settles this, so the caller is never stranded.
                clearTimeout(timer);
                done(false);
            }
        });
    }

    /**
     * Wait until the container has a non-zero box, then for a couple of
     * frames, without ever blocking indefinitely.
     *
     * Description: the replacement body for
     *   `TerminalController.waitForFontsAndLayout`. Reports what it got
     *   rather than asserting it got it, so a caller (and a test) can
     *   tell "measured a real box" from "gave up and connected anyway".
     * Inputs:
     *   container (Element|null) - the terminal host element. A null or
     *     detached element is not fatal; it times out like any other
     *     unmeasurable box.
     *   opts (object) - optional overrides:
     *     sizeTimeoutMs (number), frameTimeoutMs (number),
     *     frames (number), now (function) returning ms.
     * Output: Promise<{sized: boolean, framesPainted: number,
     *   timedOut: boolean, waitedMs: number}>
     *   `sized` - the container reported a non-zero box.
     *   `timedOut` - at least one wait ended on its timer, meaning the
     *     tab was probably not being painted.
     * Example:
     *   const r = await TerminalLayoutWait.waitForLayout(el);
     *   if (r.timedOut) console.warn('connecting unpainted', r);
     */
    async function waitForLayout(container, opts) {
        var o = opts || {};
        var sizeTimeout = typeof o.sizeTimeoutMs === 'number' ? o.sizeTimeoutMs : SIZE_TIMEOUT_MS;
        var frameTimeout = typeof o.frameTimeoutMs === 'number' ? o.frameTimeoutMs : FRAME_TIMEOUT_MS;
        var frames = typeof o.frames === 'number' ? o.frames : FRAME_COUNT;
        var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };

        var started = now();
        var timedOut = false;

        // Phase 1: a measurable box. Polled on a timer, NOT on rAF, for
        // the same reason as everything else here.
        var sized = hasBox(container);
        while (!sized) {
            if (now() - started > sizeTimeout) {
                timedOut = true;
                break;
            }
            await new Promise(function (r) { setTimeout(r, 16); });
            sized = hasBox(container);
        }

        // Phase 2: let layout settle. Each frame is capped on its own so
        // an unpainted tab costs `frames * frameTimeout`, not forever.
        var framesPainted = 0;
        for (var i = 0; i < frames; i++) {
            var painted = await nextFrameOrTimeout(frameTimeout);
            if (painted) framesPainted++;
            else timedOut = true;
        }

        return {
            sized: sized,
            framesPainted: framesPainted,
            timedOut: timedOut,
            waitedMs: now() - started
        };
    }

    /**
     * Let layout settle for a few frames, BOUNDED.
     *
     * Description: the drop-in replacement for the canonical
     *   `await new Promise(r => requestAnimationFrame(() =>
     *   requestAnimationFrame(r)))` layout guard. That idiom is correct
     *   in a painted tab and a PERMANENT HANG in an unpainted one, and
     *   when it sits in an async function that goes on to open the
     *   WebSocket, the connect is never even reached. Two of them did,
     *   on the adopt path and the rejoin path.
     * Inputs:
     *   frames (number) - how many frames to wait for. Default 2.
     *   timeoutMs (number) - per-frame cap. Default FRAME_TIMEOUT_MS.
     * Output: Promise<number> - how many frames actually painted, so a
     *   caller can tell a settled layout from a skipped one.
     * Example:
     *   await TerminalLayoutWait.settleFrames(2);
     */
    async function settleFrames(frames, timeoutMs) {
        var n = typeof frames === 'number' ? frames : FRAME_COUNT;
        var ms = typeof timeoutMs === 'number' ? timeoutMs : FRAME_TIMEOUT_MS;
        var painted = 0;
        for (var i = 0; i < n; i++) {
            if (await nextFrameOrTimeout(ms)) painted++;
        }
        return painted;
    }

    /**
     * True when the element reports a non-zero layout box.
     *
     * Description: `offsetWidth`/`offsetHeight` read 0 for a detached or
     *   display:none element, which is exactly the "not ready" case the
     *   caller is waiting out. A missing element answers false rather
     *   than throwing.
     * Inputs: el (Element|null).
     * Output: boolean.
     * Example: hasBox(document.getElementById('terminal'))
     */
    function hasBox(el) {
        if (!el) return false;
        return (el.offsetWidth | 0) > 0 && (el.offsetHeight | 0) > 0;
    }

    global.TerminalLayoutWait = {
        waitForLayout: waitForLayout,
        settleFrames: settleFrames,
        nextFrameOrTimeout: nextFrameOrTimeout,
        hasBox: hasBox,
        SIZE_TIMEOUT_MS: SIZE_TIMEOUT_MS,
        FRAME_TIMEOUT_MS: FRAME_TIMEOUT_MS,
        FRAME_COUNT: FRAME_COUNT
    };
}(typeof window !== 'undefined' ? window : globalThis));
