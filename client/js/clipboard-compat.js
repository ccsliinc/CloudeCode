/**
 * Clipboard compatibility layer.
 * ----------------------------------------------------------------------
 * `navigator.clipboard` is gated on a SECURE CONTEXT. This app is served
 * over plain http on a Tailscale/LAN hostname, which is not one, so the
 * whole API is absent - not merely permission-denied, but `undefined`.
 * Measured in a real browser against this server on 2026-08-15:
 *
 *   http://<lan-ip>:5001  -> isSecureContext false, navigator.clipboard
 *                            undefined, navigator.clipboard.writeText
 *                            undefined, document.execCommand present
 *   http://127.0.0.1:5001 -> isSecureContext true, full clipboard API
 *
 * localhost is exempted from the secure-context rule, so testing on
 * 127.0.0.1 hides the bug completely. Every existing copy path in the
 * app dead-ended on the absent API with "clipboard unavailable on this
 * connection", which is why the login code could not be copied on a
 * phone.
 *
 * Three tiers, best first:
 *   1. `navigator.clipboard.writeText` - secure contexts.
 *   2. `document.execCommand('copy')` over a temporary selection - NOT
 *      gated on a secure context, but requires an active user gesture,
 *      so callers must invoke this synchronously from a click/tap
 *      handler and must not await anything first.
 *   3. neither worked -> resolve `manual`, and the caller shows the text
 *      preselected so the user can copy with the OS long-press menu.
 *
 * Tier 2 selects a contenteditable DIV holding a real text node.
 *
 * MEASURED FAILURE, real browser, 2026-08-16. The first version used a
 * textarea whose value was assigned through `.value`. Such a textarea has
 * NO child nodes, so `Range.selectNodeContents()` over it yields an EMPTY
 * range, and nothing was ever focused. That did not error: the `copy`
 * event fired with `getSelection().toString() === ''` and
 * `document.activeElement` still the chip button, `execCommand('copy')`
 * returned TRUE, the browser faithfully copied nothing, and the caller
 * announced "copied". A false success is worse than a dead end - the user
 * taps, is told it worked, and pastes an empty clipboard. That is the
 * "clicking it does nothing" report.
 *
 * Two things retire that whole class:
 *   - a focused selection over a real text node, so the copy event fires
 *     at all (iOS also honors this, unlike `select()` on a readonly
 *     input, which was the original reason for the Range);
 *   - a one-shot `copy` listener writing the exact string through
 *     `clipboardData.setData`, so what lands on the clipboard cannot
 *     drift from what was asked for and a copy event that never fires is
 *     DETECTABLE. Success is reported only when that listener ran.
 */
(function () {
    'use strict';

    /**
     * Is the async clipboard API usable in this context?
     *
     * @returns {boolean}
     */
    function hasAsyncClipboard() {
        return !!(navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
    }

    /**
     * Build the throwaway element the copy selection lives in.
     *
     * A DIV with a real text child, not a textarea: a Range can only
     * select nodes that exist, and `textarea.value = x` creates none.
     * Position is fixed inside the viewport at near-zero opacity rather
     * than display:none or a far negative offset, because an unrendered
     * element cannot hold a selection. font-size 16px keeps iOS Safari
     * from zooming when it takes focus.
     *
     * @param {string} text - the exact text to hold.
     * @returns {HTMLDivElement} already appended to the document body.
     */
    function makeCopySource(text) {
        var el = document.createElement('div');
        el.setAttribute('aria-hidden', 'true');
        el.setAttribute('contenteditable', 'true');
        el.style.cssText =
            'position:fixed;top:0;left:0;max-width:1px;max-height:1px;' +
            'overflow:hidden;padding:0;border:none;outline:none;' +
            'opacity:0.01;font-size:16px;white-space:pre;' +
            '-webkit-user-select:text;user-select:text;';
        el.appendChild(document.createTextNode(text));
        document.body.appendChild(el);
        return el;
    }

    /**
     * Put the document selection over an element's whole contents and
     * give it focus, which is what makes the browser fire a copy event.
     *
     * @param {HTMLElement} el - an element with real text children.
     * @returns {boolean} true when a non-empty selection resulted.
     */
    function selectAll(el) {
        if (typeof el.focus === 'function') {
            try {
                el.focus({ preventScroll: true });
            } catch (err) {
                el.focus();
            }
        }
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || typeof document.createRange !== 'function') return false;
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString().length > 0;
    }

    /**
     * Tier 2: copy through `document.execCommand('copy')`.
     *
     * Must be called synchronously inside a user gesture. Never trusts
     * execCommand's return value on its own - see the header comment for
     * the measured case where it returned true having copied nothing.
     *
     * @param {string} text - the exact text to place on the clipboard.
     * @returns {boolean} true only when a copy event actually fired and
     *   carried this text.
     */
    function copyViaExecCommand(text) {
        var el = makeCopySource(text);
        var wrote = false;

        /**
         * @param {ClipboardEvent} e
         * @returns {void}
         */
        function onCopy(e) {
            if (e.clipboardData && typeof e.clipboardData.setData === 'function') {
                e.clipboardData.setData('text/plain', text);
                e.preventDefault();
            }
            // Even without clipboardData the selection IS the text, so
            // the native copy is correct. Either way the event proves the
            // browser acted on our selection.
            wrote = true;
        }

        var reported = false;
        document.addEventListener('copy', onCopy, true);
        try {
            selectAll(el);
            reported = document.execCommand('copy');
        } catch (err) {
            console.warn('CopyCompat: execCommand copy threw', err);
            reported = false;
        } finally {
            document.removeEventListener('copy', onCopy, true);
            var sel = window.getSelection ? window.getSelection() : null;
            if (sel) sel.removeAllRanges();
            el.remove();
        }
        return !!(reported && wrote);
    }

    /**
     * Copy text to the system clipboard, degrading as far as the browser
     * allows. Never rejects.
     *
     * Call it synchronously from a click handler: tier 2 needs the user
     * gesture still to be active, and awaiting anything first spends it.
     *
     * @param {string} text - the text to place on the clipboard.
     * @returns {Promise<{ok: boolean, method: string}>} method is one of
     *   'async' (navigator.clipboard), 'exec' (execCommand) or 'manual'
     *   (nothing worked; show the text for the user to copy by hand).
     *   `ok` is false only for 'manual' and for empty input.
     */
    function copyText(text) {
        if (!text) {
            return Promise.resolve({ ok: false, method: 'manual' });
        }

        // Tier 2 first when there is no async API at all, so the gesture
        // is not spent on a promise that cannot resolve.
        if (!hasAsyncClipboard()) {
            var did = copyViaExecCommand(text);
            return Promise.resolve({ ok: did, method: did ? 'exec' : 'manual' });
        }

        return navigator.clipboard.writeText(text).then(function () {
            return { ok: true, method: 'async' };
        }).catch(function () {
            // Present but refused (permissions policy, focus loss). The
            // gesture may still be live, so tier 2 is worth one attempt.
            var ok = copyViaExecCommand(text);
            return { ok: ok, method: ok ? 'exec' : 'manual' };
        });
    }

    window.CopyCompat = {
        copyText: copyText,
        hasAsyncClipboard: hasAsyncClipboard,
        copyViaExecCommand: copyViaExecCommand
    };
})();
