/**
 * TerminalScrollbackPaint - paint the server's captured screen into
 * xterm before the socket opens, exactly once, from one place.
 *
 * WHY IT IS ITS OWN MODULE. Both session entry paths in terminal.js -
 * `connectToSession` (the adopt) and `reconnectToExistingSession` (the
 * launchpad rejoin) - carried a byte-for-byte copy of this sequence,
 * comments included, differing only in the words in their log lines.
 * Gotcha 7 in CLAUDE.md is what copy-pasted entry-path code does to this
 * project: three copies of a theme restore each applied a theme and none
 * reset one. Two copies of a VT-parser reset are the same shape with a
 * worse failure, because the halves of this sequence are ORDERED and a
 * fix applied to one copy leaves the other painting into stale parser
 * state.
 *
 * THE ORDER IS THE WHOLE THING, and every step is here for a measured
 * reason.
 *
 * FIRST, LAYOUT SETTLES, BOUNDED. The screen-swap toggle needs a paint
 * tick before the container has a box to measure. That wait is raced
 * against a timer by terminal-layout-wait.js, never a bare
 * `requestAnimationFrame` await: a browser does not run rAF callbacks
 * for a tab it is not painting, and this sits ABOVE the WebSocket
 * connect, so a bare wait here does not delay the session, it cancels it
 * (gotcha 9, measured at 35 minutes).
 *
 * SECOND, THE GRID IS MEASURED. xterm does not reflow already-buffered
 * content on resize, so scrollback painted at the default 80 columns
 * stays wrong forever, even after a later fit corrects the live screen.
 * The measurement goes through `TerminalMetrics.guardedFit`, which
 * refuses when xterm.css has not applied: a cell measured before the
 * stylesheet lands produces a plausible-looking grid matching nothing on
 * screen, which is the phone rendering incident CLAUDE.md records under
 * the CDN removal. A refusal is NOT fatal here - the captured rows will
 * be laid out wrong and the live screen still recovers on the handshake
 * fit - so it is logged and the paint continues, which is what the raw
 * `fit()` inside a try/catch used to achieve by accident.
 *
 * THIRD, THE PARSER IS PUT IN A KNOWN STATE. The captured bytes carry
 * escape sequences written relative to the tmux pane's screen state at
 * capture time, and this xterm has none of that state. `ESC[?1049l`
 * (leave the alternate screen), `ESC[2J` (erase) and `ESC[H` (home) give
 * them the clean screen they were written against.
 *
 * FOURTH, THE BYTES GO IN AS BYTES. `atob` yields a binary string whose
 * `charCodeAt` values ARE the raw octets; running them through
 * `TextDecoder` mangles every non-UTF8 ANSI escape byte. `term.write`
 * takes a Uint8Array and feeds the parser without re-encoding, so the
 * decode is a hand-rolled loop on purpose.
 *
 * Loaded as a plain script, no build step. Exposes
 * `window.TerminalScrollbackPaint`.
 */

console.log('[TerminalScrollbackPaint Module] Loading...');

(function (global) {
    'use strict';

    /**
     * Description: decode a base64 capture into the raw octets xterm's
     *   parser expects. Separate and pure so the "never TextDecoder"
     *   rule is testable without a terminal.
     * Inputs: b64 (string) - the server's `initial_scrollback_b64`.
     * Output: Uint8Array - one byte per character of the decoded string.
     * Example: decodeCapture(btoa('\x1b[H')) // Uint8Array [27, 91, 72]
     */
    function decodeCapture(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i) & 0xff;
        }
        return bytes;
    }

    /**
     * Description: run the whole pre-connect paint for one entry path.
     *   The caller supplies the controller and says which path it is, for
     *   the log line, and nothing else differs between them.
     * Inputs:
     *   controller (object) - the TerminalController: `.term`,
     *     `.fitAddon`, `._forceScrollToBottom()`.
     *   b64 (string) - the captured screen, base64.
     *   what (string) - 'adopt' or 'rejoin', for the log line only.
     * Output: Promise<string> - a named outcome, never a throw:
     *   'painted'     - the bytes are in the parser. The caller should
     *                   set its Ctrl+L replay and post-connect scroll flags.
     *   'nothing'     - there was no capture to paint.
     *   'decode_failed' - the base64 was malformed. NON-FATAL on purpose:
     *                   the user misses the pre-existing history, not the
     *                   live stream, and failing the connect over it
     *                   would turn a cosmetic loss into a dead session.
     * Example:
     *   const r = await TerminalScrollbackPaint.paint(this, b64, 'adopt');
     *   if (r === 'painted') { this._needsReplayCtrlL = true; }
     */
    async function paint(controller, b64, what) {
        if (!controller || !controller.term || !b64) return 'nothing';

        // 1. Layout, bounded. See the module header: a bare rAF await
        //    here cancels the connect below it in an unpainted tab.
        await (global.TerminalLayoutWait
            ? global.TerminalLayoutWait.settleFrames(2)
            : Promise.resolve());

        // 2. The grid, measured through the guard. A refusal is logged
        //    and does not stop the paint.
        fitBeforePaint(controller, what);

        // 3 and 4. Clean parser state, then the raw octets.
        try {
            var bytes = decodeCapture(b64);
            controller.term.write('\x1b[?1049l\x1b[2J\x1b[H');
            controller.term.write(bytes, function () {
                if (typeof controller._forceScrollToBottom === 'function') {
                    controller._forceScrollToBottom();
                }
            });
            console.log('Terminal: painted ' + bytes.length + ' bytes of '
                + (what || 'session') + ' scrollback');
            return 'painted';
        } catch (err) {
            console.warn('Terminal: ' + (what || 'session')
                + ' scrollback paint failed, continuing without it:', err);
            return 'decode_failed';
        }
    }

    /**
     * Description: take the pre-paint measurement, through the guard that
     *   refuses an untrustworthy cell. Never throws: this is a quality
     *   improvement to the captured rows, not a precondition for the
     *   session coming up.
     * Inputs:
     *   controller (object) - the TerminalController.
     *   what (string) - for the log line.
     * Output: boolean - true when the grid was measured.
     */
    function fitBeforePaint(controller, what) {
        var metrics = global.TerminalMetrics;
        if (metrics && typeof metrics.guardedFit === 'function') {
            var r = metrics.guardedFit(controller);
            if (!r.fitted) {
                console.warn('Terminal: pre-paint fit skipped, reason=' + r.reason
                    + ' path=' + (what || 'session'));
            }
            return r.fitted;
        }
        // Module missing (load-order regression). An unfitted paint is
        // worse than an unguarded one, so fall back rather than skip.
        try {
            if (controller.fitAddon && typeof controller.fitAddon.fit === 'function') {
                controller.fitAddon.fit();
                return true;
            }
        } catch (err) {
            console.warn('pre-paint fit failed (continuing):', err);
        }
        return false;
    }

    global.TerminalScrollbackPaint = {
        paint: paint,
        decodeCapture: decodeCapture
    };
}(typeof window !== 'undefined' ? window : globalThis));

console.log('[TerminalScrollbackPaint Module] Exported as window.TerminalScrollbackPaint');
