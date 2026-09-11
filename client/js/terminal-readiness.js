/**
 * TerminalReadiness - the two BOUNDED waits that stand between a click
 * and a connected terminal, measured rather than slept.
 *
 * There are exactly two things the connect path has to know before it
 * opens a socket: that xterm and its addons have loaded at all, and that
 * the terminal's grid can be measured from a container that really has a
 * box. Both used to be answered by waiting a fixed number of
 * milliseconds and hoping; both are observable, and both are answered
 * here.
 *
 * WHAT IT REPLACES. `connectWebSocket()` used to fit, sleep 50 ms, and
 * fit again. The second fit existed because the first might have been
 * taken before layout settled - which is a real concern and was being
 * answered with a guess. `TerminalMetrics.guardedFit` already returns a
 * VERDICT, `{fitted, reason}`, so the question can be asked directly:
 * retry while it is refusing, stop the moment it succeeds, and give up
 * on a bound. On a working box the first attempt succeeds and the 50 ms
 * is simply gone.
 *
 * THE INVARIANT THE OLD SLEEP WAS STANDING IN FOR, said out loud: THE
 * CONNECT MAY ONLY BE ISSUED ONCE THE CONTAINER HAS BEEN MEASURED
 * SUCCESSFULLY. This module is what establishes that, and its return
 * value is what lets the caller say so in a log line instead of
 * assuming it.
 *
 * THE BOUND IS NOT OPTIONAL AND IT IS NOT A FLOOR. An unbounded wait for
 * a measurement turns a stylesheet that never arrives into a session
 * that never opens, which is strictly worse than the grid being wrong -
 * the server's dimension handshake reshapes the pane on the first real
 * paint anyway, and that is the same path a device rotation already
 * takes. So the expiry is a warn-level log and a `false` verdict, never
 * a throw and never a refusal to connect.
 *
 * setTimeout, NEVER requestAnimationFrame. A browser does not run rAF
 * callbacks for a tab it is not painting, and this sits directly above
 * the WebSocket connect - a bare frame wait here does not slow the
 * session down, it cancels it. That is gotcha 9 in CLAUDE.md, measured
 * at 35 minutes of a terminal stuck on "Connecting to terminal...". The
 * cost of using a timer instead is that an unpainted tab spends the full
 * bound and connects with an unmeasured grid, which is exactly what we
 * want it to do.
 *
 * WHY IT REFUSES RATHER THAN GUESSING. `guardedFit` declines when
 * xterm.css has not applied or when the proposed grid is implausible. A
 * fit taken from an unstyled cell produces a working-looking terminal
 * whose cols and rows match nothing on screen, and `sendResize` would
 * then reflow the real tmux pane to that grid. That is the phone
 * rendering incident CLAUDE.md records under the CDN removal, and it is
 * why "fit anyway after the bound" is not on offer here: the caller
 * connects with the LAST KNOWN GOOD grid, not with a fresh guess.
 *
 * Loaded as a plain script, no build step. Exposes
 * `window.TerminalReadiness`.
 */

console.log('[TerminalReadiness Module] Loading...');

(function (global) {
    'use strict';

    /**
     * How long to keep asking for a trustworthy measurement, in ms.
     * Chosen as the 500 ms the connect path used to sleep unconditionally,
     * so the WORST case is exactly what shipped while the common case
     * becomes immediate. It is a ceiling, not a target.
     * @type {number}
     */
    var BOUND_MS = 500;

    /**
     * Gap between attempts, in ms. Short enough that a stylesheet landing
     * mid-wait is picked up on the next tick rather than at the end of
     * the bound.
     * @type {number}
     */
    var RETRY_MS = 16;

    /**
     * Description: take a trustworthy measurement of the terminal's grid,
     *   retrying while the guard refuses, bounded.
     * Inputs:
     *   controller (object) - a TerminalController with `.fitAddon` and
     *     `.term`.
     *   opts (object) - optional overrides: `boundMs`, `retryMs`, `now`
     *     (a function returning ms, for tests).
     * Output: Promise<{fitted: boolean, reason: string, attempts: number,
     *   waitedMs: number}>. `fitted` false means NO trustworthy
     *   measurement was taken and the previous grid still stands; the
     *   caller connects anyway and says so. `reason` is guardedFit's own
     *   word for why, or 'no-metrics' when the guard module is absent.
     * Example:
     *   const r = await TerminalReadiness.measure(this);
     *   if (!r.fitted) console.warn('connecting unmeasured', r);
     */
    async function measure(controller, opts) {
        var o = opts || {};
        var bound = typeof o.boundMs === 'number' ? o.boundMs : BOUND_MS;
        var gap = typeof o.retryMs === 'number' ? o.retryMs : RETRY_MS;
        var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
        var started = now();
        var attempts = 0;
        var reason = 'no-metrics';

        var metrics = global.TerminalMetrics;
        if (!metrics || typeof metrics.guardedFit !== 'function') {
            // Load-order regression. Fall back to the raw fit rather than
            // leaving the terminal unsized, and say the measurement was
            // not guarded so a reader is not told it was.
            try {
                if (controller && controller.fitAddon
                    && typeof controller.fitAddon.fit === 'function') {
                    controller.fitAddon.fit();
                    return { fitted: true, reason: 'unguarded', attempts: 1,
                        waitedMs: now() - started };
                }
            } catch (err) {
                console.warn('TerminalReadiness: unguarded fit failed', err);
            }
            return { fitted: false, reason: reason, attempts: 0,
                waitedMs: now() - started };
        }

        for (;;) {
            attempts += 1;
            var verdict = metrics.guardedFit(controller);
            if (verdict.fitted) {
                return { fitted: true, reason: verdict.reason, attempts: attempts,
                    waitedMs: now() - started };
            }
            reason = verdict.reason;
            if (now() - started >= bound) break;
            await sleep(gap);
        }

        console.warn('TerminalReadiness: no trustworthy measurement inside the bound,'
            + ' connecting with the grid we have', { reason: reason,
                attempts: attempts, boundMs: bound });
        return { fitted: false, reason: reason, attempts: attempts,
            waitedMs: now() - started };
    }

    /**
     * Description: wait on a TIMER, which a backgrounded tab still runs.
     * Inputs: ms (number).
     * Output: Promise<void>.
     */
    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    /**
     * Description: the two waits that stand between "the screen was
     *   swapped" and "the container can be measured": the terminal font,
     *   and a non-zero box. BOTH ARE BOUNDED AND NEITHER MAY REFUSE - a
     *   font that never resolves or a tab that is never painted must
     *   still produce a session, because the server's dimension handshake
     *   reshapes the pane on the first real paint regardless.
     * Inputs: container (Element|null) - the terminal host element.
     * Output: Promise<{fonts: string, sized: boolean, timedOut: boolean}>.
     *   `fonts` is 'ready' | 'timed_out' | 'unavailable'; the last means
     *   nothing could be asked, which is not the same as nothing to wait
     *   for. `timedOut` true means the tab was probably not being painted.
     * Example: await TerminalReadiness.waitForContainer(el);
     */
    async function waitForContainer(container) {
        var fonts = 'unavailable';
        // TerminalMetrics.waitForFonts bounds the wait so a font that
        // never resolves cannot hang the terminal forever. See that
        // module for why document.fonts.ready alone is weaker than it
        // looks.
        if (global.TerminalMetrics && global.TerminalMetrics.waitForFonts) {
            await global.TerminalMetrics.waitForFonts();
            fonts = 'ready';
        } else if (global.document && global.document.fonts
                && global.document.fonts.ready) {
            try {
                await global.document.fonts.ready;
                fonts = 'ready';
            } catch (err) {
                console.warn('TerminalReadiness: document.fonts.ready rejected', err);
                fonts = 'timed_out';
            }
        }
        var r = global.TerminalLayoutWait
            ? await global.TerminalLayoutWait.waitForLayout(container)
            : null;
        if (r && r.timedOut) {
            console.warn('Terminal: layout wait timed out, connecting anyway', r);
        }
        return { fonts: fonts, sized: !!(r && r.sized), timedOut: !!(r && r.timedOut) };
    }

    // ------------------------------------------------------ xterm load

    /** How long to wait for the vendored xterm bundle, in ms. */
    var XTERM_LOAD_TIMEOUT_MS = 10000;
    /** Gap between load checks, in ms. */
    var XTERM_POLL_MS = 50;

    /**
     * Description: are xterm and all three addons this app uses actually
     *   on the page? Pure and synchronous, so the condition the wait
     *   below is built on is testable on its own.
     *
     *   `shadowed` IS NOT OPTIONAL. terminal.js declares its own class
     *   named `Terminal`, so before the vendored bundle loads,
     *   `window.Terminal` IS that class rather than xterm's. The caller
     *   passes it in and we check `window.Terminal` is something else;
     *   without that, the load check answers true against the app's own
     *   class and the terminal is built on it.
     * Inputs: shadowed (Function|undefined) - the caller's own class that
     *   may be occupying `window.Terminal`.
     * Output: {loaded: boolean, missing: string[]} - `missing` names what
     *   is not there, so the failure log says which script did not land
     *   rather than only that something did not.
     * Example: xtermLoaded(MyTerminalClass) // {loaded:false, missing:['Terminal']}
     */
    function xtermLoaded(shadowed) {
        var missing = [];
        if (typeof global.Terminal === 'undefined'
            || (shadowed !== undefined && global.Terminal === shadowed)) {
            missing.push('Terminal');
        }
        if (typeof global.FitAddon === 'undefined'
            || typeof global.FitAddon.FitAddon === 'undefined') missing.push('FitAddon');
        if (typeof global.WebglAddon === 'undefined'
            || typeof global.WebglAddon.WebglAddon === 'undefined') missing.push('WebglAddon');
        if (typeof global.Unicode11Addon === 'undefined'
            || typeof global.Unicode11Addon.Unicode11Addon === 'undefined') {
            missing.push('Unicode11Addon');
        }
        return { loaded: missing.length === 0, missing: missing };
    }

    /**
     * Description: wait for the vendored xterm bundle, bounded, then
     *   THROW if it never arrives. This is the one readiness wait that
     *   fails loudly rather than degrading, and deliberately: there is no
     *   terminal to degrade into, and the error path is what tells the
     *   user xterm did not load instead of leaving a blank pane.
     *   Polled on a TIMER, so a backgrounded tab still resolves it.
     * Inputs: shadowed (Function|undefined) - see xtermLoaded.
     *   opts (object) - optional `timeoutMs`, `pollMs`, `now`.
     * Output: Promise<void>. Rejects with an Error naming what is missing.
     * Example: await TerminalReadiness.waitForXterm(Terminal);
     */
    async function waitForXterm(shadowed, opts) {
        var o = opts || {};
        var timeout = typeof o.timeoutMs === 'number' ? o.timeoutMs : XTERM_LOAD_TIMEOUT_MS;
        var poll = typeof o.pollMs === 'number' ? o.pollMs : XTERM_POLL_MS;
        var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
        var started = now();
        var status = xtermLoaded(shadowed);
        while (!status.loaded) {
            if (now() - started >= timeout) {
                console.error('Terminal: xterm.js failed to load', { missing: status.missing });
                throw new Error('xterm.js failed to load: ' + status.missing.join(', '));
            }
            await sleep(poll);
            status = xtermLoaded(shadowed);
        }
        console.log('Terminal: xterm.js loaded in ' + (now() - started) + 'ms');
    }

    global.TerminalReadiness = {
        BOUND_MS: BOUND_MS,
        RETRY_MS: RETRY_MS,
        XTERM_LOAD_TIMEOUT_MS: XTERM_LOAD_TIMEOUT_MS,
        XTERM_POLL_MS: XTERM_POLL_MS,
        measure: measure,
        waitForContainer: waitForContainer,
        xtermLoaded: xtermLoaded,
        waitForXterm: waitForXterm
    };
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[TerminalReadiness Module] Exported as window.TerminalReadiness');
