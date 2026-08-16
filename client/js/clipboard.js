/**
 * Clipboard Tools (clipboard paste + terminal copy chord)
 * ----------------------------------------------------------------------
 * Two features, wired into terminal.js through two hook points (this
 * file is loaded right AFTER terminal.js in index.html; terminal.js
 * only calls in at runtime, after the async xterm CDN wait, so
 * window.ClipboardTools is always defined by then):
 *
 *  1. PASTE FROM CLIPBOARD - reads the LOCAL device clipboard via
 *     navigator.clipboard.read(): the first image/* item routes through
 *     the existing Terminal#_uploadAndInjectImage() flow; otherwise
 *     text/plain (or the readText() fallback) is injected via
 *     Terminal#insertText() - the same binary WebSocket path as
 *     term.onData - sent as ONE frame so the server's >256B
 *     bracketed-paste heuristic in tmux_backend.py treats large pastes
 *     correctly.
 *
 *     Clipboard API realities: read()/readText() require a secure
 *     context + permission. On LAN http (non-localhost) the API can be
 *     entirely undefined, and where present it can reject with
 *     NotAllowedError. Every path degrades to the existing status pill
 *     pointing at the keyboard paste path - nothing throws unhandled.
 *     pasteFromClipboard() is only ever invoked from a menu tap, i.e.
 *     inside a user gesture, which the permission model requires.
 *
 *     THE MENU THAT USED TO LIVE HERE IS GONE. The paperclip FAB owned a
 *     two-item popup (paste / attach image) while a second folded strip
 *     over the terminal's top-right corner owned copy / theme / music.
 *     Both are now rows of the single session tools menu in
 *     client/js/terminal-tools-menu.js, which calls the two functions
 *     exported below. This file no longer builds or positions any UI.
 *
 *  2. COPY CHORD - Terminal#_applyKeyHandlers()' xterm custom key
 *     handler calls handleCopyChord() first for every key event.
 *     Cmd+C (mac) / Ctrl+Shift+C (win/linux) WITH an active xterm
 *     selection writes the selection to the system clipboard and
 *     swallows the event. Bare Ctrl+C is NEVER intercepted - it must
 *     reach the pty as SIGINT (0x03). The selection is left in place
 *     after copy (macOS Terminal behavior: selection stays).
 */

(function () {
    'use strict';

    /* =================================================================
     * Copy chord
     * ================================================================= */

    /**
     * Called from xterm's attachCustomKeyEventHandler closure for EVERY
     * key event. Returns true only when the event was consumed (the
     * caller then returns false so xterm drops it). Anything that is
     * not a copy chord — including bare Ctrl+C — falls straight through
     * to xterm's default handling.
     */
    function handleCopyChord(ev, term) {
        if (ev.type !== 'keydown') return false;
        if ((ev.key || '').toLowerCase() !== 'c') return false;

        // Cmd+C (mac) or Ctrl+Shift+C (win/linux). Bare Ctrl+C (no shift)
        // is deliberately excluded — that chord is SIGINT and must reach
        // the pty untouched.
        const isCopyChord =
            (ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) ||
            (ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey);
        if (!isCopyChord) return false;

        if (!term.term || typeof term.term.hasSelection !== 'function' || !term.term.hasSelection()) {
            return false; // nothing selected — let the key pass through
        }

        ev.preventDefault();
        ev.stopPropagation();
        writeSystemClipboard(term, term.term.getSelection());
        return true;
    }

    /**
     * Fire-and-forget clipboard write. Success is silent (matches macOS
     * Terminal — the selection staying put is the confirmation); failure
     * surfaces via the existing status pill. Never throws.
     */
    function writeSystemClipboard(term, text) {
        if (!text) return;
        // Routed through CopyCompat: over plain http (Tailscale / LAN)
        // navigator.clipboard is entirely undefined, and the old code
        // dead-ended there with "clipboard unavailable". CopyCompat falls
        // back to execCommand, which is not secure-context gated.
        window.CopyCompat.copyText(text).then((result) => {
            if (!result.ok) {
                term._showStatusPill('copy blocked by browser — use the system copy shortcut', 'error');
            }
        });
    }

    /* =================================================================
     * Image file input
     * ================================================================= */

    /**
     * Wire the hidden image file input. The picker itself is opened by
     * the "attach image" row of the session tools menu; this only owns
     * what happens once a file comes back.
     *
     * @param {object} term - the Terminal wrapper.
     * @param {HTMLInputElement} input - the hidden file input.
     * @returns {void}
     */
    function wireFileInput(term, input) {
        if (!input || input._clipboardWired) return;
        input._clipboardWired = true;
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            await term._uploadAndInjectImage(file, file.type || 'image/jpeg');
            input.value = '';
        });
    }

    /* =================================================================
     * Paste from local clipboard
     * ================================================================= */

    /**
     * Reads the LOCAL device clipboard. Only called from the menu tap
     * (user gesture) to satisfy clipboard-permission rules.
     *
     * Order: rich read() first — an image wins when present (mirrors
     * the desktop paste interceptor in terminal.js). Text comes from
     * the same rich items when available, else the readText() fallback.
     * Any denial or API absence degrades to a status-pill message
     * pointing at the keyboard paste path. Never throws.
     */
    async function pasteFromClipboard(term) {
        const canRead = !!(navigator.clipboard && typeof navigator.clipboard.read === 'function');
        const canReadText = !!(navigator.clipboard && typeof navigator.clipboard.readText === 'function');

        if (!canRead && !canReadText) {
            term._showStatusPill('paste unavailable on this connection — use cmd+v / ctrl+v in the terminal', 'error');
            return;
        }

        if (canRead) {
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const imageType = (item.types || []).find((t) => t.indexOf('image/') === 0);
                    if (imageType) {
                        const blob = await item.getType(imageType);
                        await term._uploadAndInjectImage(blob, imageType);
                        return;
                    }
                }
                for (const item of items) {
                    if ((item.types || []).indexOf('text/plain') !== -1) {
                        const blob = await item.getType('text/plain');
                        injectText(term, await blob.text());
                        return;
                    }
                }
                term._showStatusPill('clipboard is empty', 'info');
                return;
            } catch (err) {
                // Permission denied / unsupported MIME — fall through to
                // the text-only path before giving up.
            }
        }

        if (canReadText) {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    injectText(term, text);
                } else {
                    term._showStatusPill('clipboard is empty', 'info');
                }
                return;
            } catch (err) {
                // Fall through to the blocked message below.
            }
        }

        term._showStatusPill('paste blocked by browser — use cmd+v / ctrl+v in the terminal', 'error');
    }

    /**
     * Inject clipboard text exactly as if pasted: ONE binary WebSocket
     * frame via the existing Terminal#insertText() (the same send path
     * term.onData uses) so the server's >256B bracketed-paste heuristic
     * sees the whole paste as a single payload.
     */
    function injectText(term, text) {
        if (!text) {
            term._showStatusPill('clipboard is empty', 'info');
            return;
        }
        if (!term.ws || term.ws.readyState !== WebSocket.OPEN) {
            term._showStatusPill('terminal not connected', 'error');
            return;
        }
        term.insertText(text);
        term._showStatusPill('pasted from clipboard', 'success');
    }

    window.ClipboardTools = {
        handleCopyChord,
        pasteFromClipboard,
        wireFileInput,
    };
})();
