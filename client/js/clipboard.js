/**
 * Clipboard Tools (paperclip menu + terminal copy chord)
 * ----------------------------------------------------------------------
 * Two features, wired into terminal.js through two hook points (this
 * file is loaded right AFTER terminal.js in index.html; terminal.js
 * only calls in at runtime, after the async xterm CDN wait, so
 * window.ClipboardTools is always defined by then):
 *
 *  1. PAPERCLIP MENU — Terminal#_applyImageAttachButton() hands the 📎
 *     button + hidden file input to wireAttachButton(). The button now
 *     opens a small fixed-position menu:
 *       - "paste from clipboard" — reads the LOCAL device clipboard via
 *         navigator.clipboard.read(): the first image/* item routes
 *         through the existing Terminal#_uploadAndInjectImage() flow;
 *         otherwise text/plain (or the readText() fallback) is injected
 *         via Terminal#insertText() — the same binary WebSocket path as
 *         term.onData — sent as ONE frame so the server's >256B
 *         bracketed-paste heuristic in tmux_backend.py treats large
 *         pastes correctly.
 *       - "attach image" — the original hidden-file-input picker.
 *
 *     Clipboard API realities: read()/readText() require a secure
 *     context + permission. On LAN http (non-localhost) the API can be
 *     entirely undefined, and where present it can reject with
 *     NotAllowedError. Every path degrades to the existing status pill
 *     pointing at the keyboard paste path — nothing throws unhandled.
 *     pasteFromClipboard() is only ever invoked from the menu tap, i.e.
 *     inside a user gesture, which the permission model requires.
 *
 *  2. COPY CHORD — Terminal#_applyKeyHandlers()' xterm custom key
 *     handler calls handleCopyChord() first for every key event.
 *     Cmd+C (mac) / Ctrl+Shift+C (win/linux) WITH an active xterm
 *     selection writes the selection to the system clipboard and
 *     swallows the event. Bare Ctrl+C is NEVER intercepted — it must
 *     reach the pty as SIGINT (0x03). The selection is left in place
 *     after copy (macOS Terminal behavior: selection stays).
 */

(function () {
    'use strict';

    /** Singleton menu element + bound dismiss handlers (one menu max). */
    let menuEl = null;
    let menuAnchorBtn = null;
    let onDocPointer = null;
    let onDocKey = null;

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
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).catch(() => {
                term._showStatusPill('copy blocked by browser — use the system copy shortcut', 'error');
            });
        } else {
            term._showStatusPill('clipboard unavailable on this connection', 'error');
        }
    }

    /* =================================================================
     * Paperclip menu
     * ================================================================= */

    /**
     * Replaces the stock 📎 wiring. The hidden file input keeps the
     * original change-handler behavior (the "attach image" path); the
     * button now opens the menu instead of acting immediately.
     */
    function wireAttachButton(term, btn, input) {
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            await term._uploadAndInjectImage(file, file.type || 'image/jpeg');
            input.value = '';
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (menuEl) {
                closeMenu();
            } else {
                openMenu(term, btn, input);
            }
        });
    }

    function openMenu(term, btn, input) {
        closeMenu();

        menuEl = document.createElement('div');
        menuEl.className = 'cloude-attach-menu';
        menuEl.setAttribute('role', 'menu');

        menuEl.appendChild(menuItem('paste from clipboard', () => {
            closeMenu();
            pasteFromClipboard(term);
        }));
        menuEl.appendChild(menuItem('attach image', () => {
            closeMenu();
            input.click();
        }));

        document.body.appendChild(menuEl);
        positionMenu(menuEl, btn);
        menuAnchorBtn = btn;

        // Dismiss on any outside tap or Escape. Deferred one tick so the
        // tap that opened the menu doesn't immediately close it again.
        // Taps on the 📎 button itself are excluded here — the button's
        // own click handler toggles the menu, and pointerdown (capture)
        // fires before click, so dismissing on button taps would make
        // every re-tap close+reopen instead of closing.
        onDocPointer = (e) => {
            if (!menuEl) return;
            if (menuEl.contains(e.target)) return;
            if (menuAnchorBtn && menuAnchorBtn.contains(e.target)) return;
            closeMenu();
        };
        onDocKey = (e) => {
            if (e.key === 'Escape') closeMenu();
        };
        setTimeout(() => {
            document.addEventListener('pointerdown', onDocPointer, true);
            document.addEventListener('keydown', onDocKey, true);
        }, 0);
    }

    function menuItem(label, onPick) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cloude-attach-menu__item';
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', onPick);
        return item;
    }

    /**
     * Anchor the menu directly above the 📎 button, right-aligned to it,
     * clamped fully inside the VISIBLE viewport.
     *
     * Uses left/top taken straight from the button's viewport rect so the
     * menu and the measurement always live in the same coordinate space.
     * (The previous version positioned via right/bottom computed from
     * window.innerWidth/innerHeight minus the rect — on iOS Safari the
     * layout and visual viewports diverge whenever the URL bar collapses,
     * the keyboard opens, or the page is pinch/auto-zoomed, which made
     * that subtraction produce out-of-range offsets and parked the menu
     * at the bottom-left corner, half off-screen.)
     *
     * Clamp bounds come from window.visualViewport when available (the
     * actually-visible area under keyboard/zoom), offset into layout
     * coordinates via offsetLeft/offsetTop so position:fixed resolves
     * correctly; falls back to innerWidth/innerHeight elsewhere. Even a
     * bogus rect can no longer push the menu off-screen — worst case it
     * lands flush against a screen edge with an 8px margin.
     */
    function positionMenu(el, btn) {
        const rect = btn.getBoundingClientRect();
        const vp = window.visualViewport || null;
        const vw = vp ? vp.width : window.innerWidth;
        const vh = vp ? vp.height : window.innerHeight;
        const offL = vp ? vp.offsetLeft : 0;
        const offT = vp ? vp.offsetTop : 0;
        const MARGIN = 8;

        const w = el.offsetWidth;
        const h = el.offsetHeight;

        // Preferred spot: above the button, right edges aligned. If there
        // is no room above, drop below the button instead.
        let left = rect.right - w;
        let top = rect.top - h - MARGIN;
        if (top < offT + MARGIN) top = rect.bottom + MARGIN;

        left = Math.min(Math.max(left, offL + MARGIN), offL + vw - w - MARGIN);
        top = Math.min(Math.max(top, offT + MARGIN), offT + vh - h - MARGIN);

        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function closeMenu() {
        if (onDocPointer) {
            document.removeEventListener('pointerdown', onDocPointer, true);
            onDocPointer = null;
        }
        if (onDocKey) {
            document.removeEventListener('keydown', onDocKey, true);
            onDocKey = null;
        }
        if (menuEl) {
            menuEl.remove();
            menuEl = null;
        }
        menuAnchorBtn = null;
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
        wireAttachButton,
    };
})();
