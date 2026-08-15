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
 * Tier 2 uses a contenteditable textarea and an explicit Range because
 * iOS Safari ignores `select()` on a readonly textarea.
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
     * Select the full contents of an element in a way iOS Safari honors.
     *
     * @param {HTMLTextAreaElement} el
     * @returns {void}
     */
    function selectAll(el) {
        // iOS refuses select() on readonly inputs; contenteditable plus a
        // DOM Range is the combination that works on both iOS and desktop.
        var wasReadOnly = el.readOnly;
        el.contentEditable = 'true';
        el.readOnly = false;

        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.setSelectionRange(0, el.value.length);

        el.readOnly = wasReadOnly;
    }

    /**
     * Tier 2: copy via execCommand over an offscreen textarea.
     *
     * Must be called inside a user gesture. Position is fixed at the top
     * of the viewport with near-zero opacity rather than display:none or
     * a negative offset, because a non-rendered or offscreen element
     * cannot hold a selection and the copy silently fails.
     *
     * @param {string} text
     * @returns {boolean} true when the browser reported the copy done.
     */
    function copyViaExecCommand(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('aria-hidden', 'true');
        ta.style.cssText =
            'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;' +
            'border:none;outline:none;box-shadow:none;background:transparent;' +
            'opacity:0.01;font-size:16px;';
        document.body.appendChild(ta);

        var copied = false;
        try {
            selectAll(ta);
            copied = document.execCommand('copy');
        } catch (err) {
            console.warn('CopyCompat: execCommand copy threw', err);
            copied = false;
        } finally {
            var sel = window.getSelection();
            if (sel) sel.removeAllRanges();
            ta.remove();
        }
        return copied;
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
