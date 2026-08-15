/**
 * Terminal Module - Handles xterm.js terminal and WebSocket PTY connection
 */

console.log('[Terminal Module] Loading...');

/**
 * Default xterm palette — used if window.Themes hasn't initialized yet
 * (e.g. /api/v1/themes failed AND no synchronous fallback ran). Phase 4-5:
 * the actual theme assigned to xterm comes from
 *   Themes.getActiveGlobal()?.xterm ?? DEFAULT_XTERM_THEME
 * at construction time, then the registry's xtermThemeChange listener
 * swaps it on subsequent applyGlobal()/applySession()/clearSession() calls.
 *
 * Keep these values in lock-step with the Claude fallback in registry.js
 * and the :root block in client/css/styles.css. If one drifts the others
 * should follow on the same commit.
 */
const DEFAULT_XTERM_THEME = {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
};

class Terminal {
    constructor() {
        this.ws = null;
        this.term = null;
        this.fitAddon = null;
        this.sessionActive = false;

        // Auto-reconnect tracking
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.maxReconnectAttempts = 5;
        this.isReconnecting = false;

        // WebSocket keepalive
        this.keepaliveInterval = null;

        // Single-writer queue for PTY data
        this.queue = [];
        this.flushing = false;

        // Auto-scroll behavior
        this.autoScrollEnabled = true;
        this._programmaticScrollLock = 0;
        this.resizeDebounceTimer = null;

        // Track last-sent dims so we only log + ship when they actually
        // change. Multiple event sources (window.resize + visualViewport +
        // ResizeObserver + orientationchange) can all fire for a single
        // physical layout change; dedupe at the sendResize gate.
        this.lastSentCols = null;
        this.lastSentRows = null;

        // ResizeObserver tracking the xterm container. Listener-lifetime is
        // tied to the Terminal object; cleaned up in destroy paths.
        this._resizeObserver = null;

        // UI elements. Delete is no longer reachable from the session
        // header (moved to the conversation sidebar + launcher — see
        // session-sidebar.js) so there is no destroySessionBtn to track
        // here. detachSessionBtn stays: Detach is the safe exit and
        // remains the only session-exit control in the header.
        this.detachSessionBtn = null;
        this.statusEl = null;
        this.sessionInfoEl = null;

        // Reconnect-by-name guard (feat/safe-session-lifecycle). Set once
        // per disconnect episode so a WS close carrying app code 4404
        // ("server doesn't know this session_id") triggers exactly ONE
        // name-based re-adopt attempt instead of looping. Reset back to
        // false whenever a WS successfully opens.
        this._reconnectByNameAttempted = false;

        // Outage recovery (fix/restart-reconnect). A server restart does
        // NOT emit close code 4404 - the socket dies with an ordinary
        // abnormal-close code while the old process exits and the new one
        // is not listening yet. `_restartWatch` is the lazily built
        // ServerRestartWatch that polls /health for that case;
        // `_restartWatchActive` makes the wait single-flight so a burst
        // of closes cannot stack loops. Those two are the ONLY pieces of
        // state this path owns - nothing here records "a restart
        // recovery is in progress", because nothing reads it.
        this._restartWatch = null;
        this._restartWatchActive = false;
    }

    /**
     * Initialize terminal
     */
    async init() {
        console.log('Terminal: Initializing xterm.js');

        this.detachSessionBtn = document.getElementById('detachSessionBtn');
        this.statusEl = document.getElementById('statusText');
        this.sessionInfoEl = document.getElementById('sessionInfo');

        // Add detach session handler — the non-destructive exit. Wired
        // purely via addEventListener (no inline onclick) so this button
        // never risks the double-invoke class of bug an onclick + a
        // listener on the same element can produce.
        if (this.detachSessionBtn) {
            this.detachSessionBtn.addEventListener('click', () => this.detachSession());
        }

        // Wait for xterm.js to load from CDN
        await this.waitForXterm();

        this.initTerminal();
    }

    /**
     * Wait for xterm.js CDN scripts to load
     */
    async waitForXterm() {
        const maxWait = 10000; // 10 seconds max
        const checkInterval = 50; // Check every 50ms
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
            // Check if all xterm.js modules are loaded (use window.Terminal to avoid shadowing)
            const terminalLoaded = typeof window.Terminal !== 'undefined' && window.Terminal !== Terminal;
            const fitLoaded = typeof FitAddon !== 'undefined' && typeof FitAddon.FitAddon !== 'undefined';
            const webglLoaded = typeof WebglAddon !== 'undefined' && typeof WebglAddon.WebglAddon !== 'undefined';
            const unicodeLoaded = typeof Unicode11Addon !== 'undefined' && typeof Unicode11Addon.Unicode11Addon !== 'undefined';

            if (terminalLoaded && fitLoaded && webglLoaded && unicodeLoaded) {
                console.log('Terminal: xterm.js loaded', {
                    windowTerminal: typeof window.Terminal,
                    FitAddon: typeof FitAddon?.FitAddon,
                    WebglAddon: typeof WebglAddon?.WebglAddon,
                    Unicode11Addon: typeof Unicode11Addon?.Unicode11Addon
                });
                return;
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        console.error('Terminal: xterm.js failed to load', {
            windowTerminal: typeof window.Terminal,
            FitAddon: typeof FitAddon,
            WebglAddon: typeof WebglAddon,
            Unicode11Addon: typeof Unicode11Addon
        });
        throw new Error('xterm.js failed to load from CDN');
    }

    /**
     * Initialize xterm.js terminal
     */
    initTerminal() {
        console.log('Terminal: Creating xterm Terminal instance', {
            windowTerminal: typeof window.Terminal,
            localTerminal: typeof Terminal,
            isXtermTerminal: window.Terminal !== Terminal
        });

        // Use window.Terminal to get xterm.js Terminal, not our wrapper class
        const XTerminal = window.Terminal;

        // Phase 4-5: theme drawn from registry. If Themes hasn't initialized
        // yet (registry init is post-auth) we fall back to DEFAULT_XTERM_THEME.
        // The `xtermThemeChange` subscription below picks up subsequent
        // applyGlobal/applySession/clearSession calls and swaps the palette
        // live without re-creating the Terminal.
        const initialXtermTheme =
            (window.Themes && window.Themes.getActiveGlobal && window.Themes.getActiveGlobal()?.xterm)
            || DEFAULT_XTERM_THEME;

        this.term = new XTerminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"SF Mono", monospace',
            fontWeight: 'normal',
            fontWeightBold: 'bold',
            allowTransparency: false,
            theme: initialXtermTheme,
            allowProposedApi: true,
            convertEol: false,
            scrollback: 50000,
            windowsMode: false
        });

        console.log('Terminal: Terminal instance created', {
            term: this.term,
            hasLoadAddon: typeof this.term?.loadAddon,
            allMethods: this.term ? Object.getOwnPropertyNames(Object.getPrototypeOf(this.term)).filter(m => typeof this.term[m] === 'function').slice(0, 20) : []
        });

        if (typeof this.term.loadAddon !== 'function') {
            console.error('Terminal methods available:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.term)));
            throw new Error(`Terminal instance has no loadAddon method. Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(this.term)).join(', ')}`);
        }

        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);

        // Load WebGL renderer (hardened against context loss).
        //
        // iOS Safari (and any GPU under memory pressure) can drop the WebGL
        // context at any time. Without an onContextLoss handler the xterm
        // viewport silently goes black and stays that way for the rest of
        // the session. The recovery path is documented by the xterm.js
        // maintainers since 2021:
        //   1. dispose() the addon — it cannot recover the lost context
        //   2. xterm transparently falls back to its built-in DOM renderer
        //      (the renderer in use when no canvas/webgl addon is loaded)
        //
        // We don't auto-reload a fresh WebglAddon here: a context-loss
        // event implies system pressure, and re-creating the GL context
        // is what got us into trouble in the first place. The DOM renderer
        // is slower but stable, which is the right tradeoff under pressure.
        // A page reload (user-initiated) is the clean path back to WebGL.
        try {
            this._webglAddon = new WebglAddon.WebglAddon();
            this.term.loadAddon(this._webglAddon);
            this._webglAddon.onContextLoss(() => {
                console.warn('Terminal: WebGL context lost — disposing addon, falling back to DOM renderer');
                try { this._webglAddon.dispose(); } catch (_) { /* idempotent */ }
                this._webglAddon = null;
            });
        } catch (e) {
            console.warn('Terminal: WebGL addon unavailable — using DOM renderer', e);
            this._webglAddon = null;
        }

        // Load Unicode 11 addon
        try {
            const unicode11Addon = new Unicode11Addon.Unicode11Addon();
            this.term.loadAddon(unicode11Addon);
            this.term.unicode.activeVersion = '11';
        } catch (e) {
            console.warn('Unicode11 addon not available', e);
        }

        this.term.open(document.getElementById('terminal'));

        // Phase 4-5: subscribe to theme palette changes from the registry.
        // applyGlobal() / applySession() / clearSession() all funnel through
        // here. xterm.js (with WebglAddon since 2021) listens to its own
        // optionsChanged event and re-uploads the glyph atlas automatically
        // — we do NOT need to call term.refresh() preemptively. If stale
        // paint is observed empirically we add an explicit refresh here,
        // but the spec calls out the YAGNI on this and current xterm
        // versions handle it cleanly.
        if (window.Themes && typeof window.Themes.onXtermThemeChange === 'function') {
            this._unsubscribeXtermTheme = window.Themes.onXtermThemeChange((newXtermTheme) => {
                if (!this.term || !newXtermTheme) return;
                try {
                    this.term.options.theme = newXtermTheme;
                } catch (e) {
                    console.warn('Terminal: failed to apply xterm theme', e);
                }
            });
        }

        // Wire Shift+Enter interceptor. Handler body lives in
        // _applyKeyHandlers() so we can re-attach after term.reset()
        // (xterm wipes the custom key handler during core reset on
        // session swap, which would otherwise leave Shift+Enter dead).
        this._applyKeyHandlers();

        // Wire the capture-phase wheel interceptor (see _applyWheelHandler).
        // DOM listener on term.element survives term.reset() since the
        // element isn't recreated, so a single attachment is sufficient.
        this._applyWheelHandler();

        // IMG-PASTE — wire image-paste pipeline. Both the paste listener
        // (DOM event on #terminal container) and the mobile attach button
        // are attached to the document/container, NOT to xterm's custom
        // handler slot, so term.reset() during session swap does not wipe
        // them — single attachment in initTerminal() is sufficient.
        this._applyPasteHandler();
        this._applyImageAttachButton();

        // TOUCH-SELECT — long-press drag selection + floating copy button
        // on coarse-pointer devices. Implementation lives in touch-select.js
        // (loaded after clipboard.js); it no-ops on fine pointers so
        // desktop is untouched. Listeners ride on #terminal / document,
        // so term.reset() during session swap does not wipe them.
        this._applyTouchSelection();

        // Terminal-screen tool strip: copy-output sheet, per-session theme
        // picker, per-session music opt-in. Same load-order guarantee as
        // the hooks above — the modules are loaded before initTerminal()
        // runs, and the guards inside cover a failed static fetch.
        this._applyTerminalTools();

        // Handle terminal input
        this.term.onData(data => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Convert special symbols for mobile keyboard shortcuts
                if (data === '¥') {
                    data = '\n';  // Yen = Newline
                } else if (data === '€') {
                    data = '\t';  // Euro = Tab
                } else if (data === '￡' || data === '£') {
                    data = '\x1b[Z';  // Pound = Shift+Tab
                }
                // Send input as binary frame
                this.ws.send(new TextEncoder().encode(data));
            }
        });

        // ---- Dynamic resize pipeline ----
        //
        // All four sources funnel into a single 100ms debounced callback:
        //   window.resize            - desktop viewport / browser window
        //   orientationchange        - mobile device rotation
        //   visualViewport.resize    - mobile keyboard popup / browser chrome
        //                              show+hide / pinch-zoom. Provides more
        //                              accurate viewport dims than window
        //                              on iOS Safari.
        //   ResizeObserver           - ANY layout change of the xterm
        //                              container (sidebar collapse, split
        //                              view, CSS transitions, font load).
        //
        // Single debounce gate means redundant fires during one layout
        // change collapse to a single fit()+sendResize() call, and the
        // sendResize dedup further suppresses duplicate frames when the
        // cell grid hasn't actually changed. Graceful degradation: if any
        // API is unavailable (old browser) the remaining listeners still
        // catch their share of events.
        const scheduleResize = (source) => {
            if (this.resizeDebounceTimer) {
                clearTimeout(this.resizeDebounceTimer);
            }
            this.resizeDebounceTimer = setTimeout(() => {
                if (this.fitAddon && this.term) {
                    this.fitAddon.fit();
                    this.sendResize(source);
                }
            }, 100);
        };

        window.addEventListener('resize', () => scheduleResize('window.resize'));
        window.addEventListener('orientationchange', () => scheduleResize('orientationchange'));

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => scheduleResize('visualViewport.resize'));
        }

        const termContainer = document.getElementById('terminal');
        if (termContainer && typeof ResizeObserver !== 'undefined') {
            try {
                this._resizeObserver = new ResizeObserver(() => scheduleResize('ResizeObserver'));
                this._resizeObserver.observe(termContainer);
            } catch (e) {
                console.warn('Terminal: ResizeObserver setup failed', e);
            }
        }

        // Setup scroll event listener for auto-scroll detection
        this.setupScrollListener();

        // Auto-scroll terminal to bottom on focus (mobile keyboard fix)
        const terminalElement = document.getElementById('terminal');
        if (terminalElement) {
            terminalElement.addEventListener('focus', () => {
                const container = document.querySelector('.terminal-container');
                if (container) {
                    setTimeout(() => {
                        container.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    }, 100);
                }
            }, true);

            terminalElement.addEventListener('click', () => {
                const container = document.querySelector('.terminal-container');
                if (container && window.innerWidth <= 768) {
                    setTimeout(() => {
                        container.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    }, 100);
                }
            });
        }

        this.term.writeln('\x1b[1;32mCloude Code Terminal\x1b[0m');
        this.term.writeln('');
        this.term.writeln('\x1b[2;37mKeyboard shortcuts:\x1b[0m');
        this.term.writeln('  ¥  = Newline (Enter)');
        this.term.writeln('  €  = Tab');
        this.term.writeln('  £  = Shift+Tab');
        this.term.writeln('');
        this.term.writeln('Waiting for session...\n');
    }

    /**
     * Attach the Shift+Enter custom key handler to the current xterm
     * instance. Called from initTerminal() on first boot and from every
     * term.reset() site on session swap — xterm's core reset wipes the
     * custom key event handler slot, so without re-attachment Shift+Enter
     * silently goes back to default (submit) behavior for the rest of
     * the session's life.
     *
     * Payload: 2-byte ESC+CR (`\x1b\r`) — the VSCode / Alacritty
     * convention documented by Claude Code's /terminal-setup guide for
     * "insert newline without submitting". Claude Code's Ink input
     * parser recognizes ESC+CR as Meta+Enter without requiring kitty
     * keyboard protocol negotiation (which CSI u `\x1b[13;2u` depends
     * on, and which our node-pty/tmux stack does not reliably forward).
     */
    _applyKeyHandlers() {
        if (!this.term) return;
        this.term.attachCustomKeyEventHandler((ev) => {
            // CLIPBOARD — copy chord (Cmd+C / Ctrl+Shift+C with an active
            // selection → system clipboard). Logic lives in clipboard.js
            // (loaded after this file; guard covers a failed static fetch).
            // Returns true only when it consumed the event — bare Ctrl+C
            // (SIGINT) always falls through untouched.
            if (window.ClipboardTools && window.ClipboardTools.handleCopyChord(ev, this)) {
                return false;
            }
            if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey &&
                !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                ev.preventDefault();
                ev.stopPropagation();
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const bytes = new Uint8Array([0x1b, 0x0d]);  // \x1b\r — VSCode/Alacritty pattern from Claude Code's /terminal-setup docs
                    console.log('[SHIFT-ENTER] sending ESC+CR (\\x1b\\r), bytes:', bytes);
                    this.ws.send(bytes);
                }
                return false;  // swallow the event so xterm doesn't also emit \r
            }
            return true;  // all other keys pass through to default handling
        });
    }

    /**
     * Attach a capture-phase wheel listener that scrolls xterm's own
     * scrollback instead of letting xterm translate the wheel into cursor
     * (up/down arrow) keystrokes — which it does on the alternate screen
     * buffer (active during a Claude Code TUI), where Claude reads those
     * arrows as "cycle previous prompts" and the scrollback never moves.
     * Capture phase + stopPropagation runs before xterm's own bubble-phase
     * wheel handler, so the arrow-key path never fires.
     */
    _applyWheelHandler() {
        if (!this.term || !this.term.element || this._wheelHandlerAttached) return;
        this.term.element.addEventListener('wheel', (e) => {
            if (e.deltaY === 0) return;
            // Marks a user gesture so a write landing mid-scroll cannot
            // chase the viewport back down (terminal-scroll.js). The old
            // `autoScrollEnabled = false` here was a point fix for the
            // same race that only ever covered the wheel, never touch.
            if (window.TerminalScroll) window.TerminalScroll.noteUserScroll();
            const lines = Math.ceil(Math.abs(e.deltaY) / 40) * (e.deltaY > 0 ? 1 : -1);
            this.term.scrollLines(lines || (e.deltaY > 0 ? 1 : -1));
            e.preventDefault();
            e.stopPropagation();
        }, { capture: true });
        this._wheelHandlerAttached = true;
    }

    /**
     * IMG-PASTE — desktop clipboard paste interceptor.
     *
     * Listens on the #terminal container in capture phase so we see the
     * paste BEFORE xterm's internal handler. Iterates clipboardData.items
     * looking for the first ``kind === 'file'`` item with an ``image/*``
     * type. If found, we suppress xterm's default text paste, upload the
     * blob, and inject the returned absolute path with a trailing space
     * (NOT a newline — preserves Claude Code's native UX where the user
     * keeps typing the prompt). If no image item is present we let the
     * event fall through to xterm's text-paste path unchanged.
     *
     * Capture phase + stopPropagation matter: xterm registers its own
     * paste listener on the same container in bubble phase; without
     * capture-first interception the text-paste path would still fire
     * for an image (which xterm renders as the literal text "[object
     * File]" garbage in the prompt buffer).
     */
    _applyPasteHandler() {
        const container = document.getElementById('terminal');
        if (!container) return;
        container.addEventListener('paste', async (e) => {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            let imageItem = null;
            for (const item of items) {
                if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
                    imageItem = item;
                    break;
                }
            }
            if (!imageItem) return;

            e.preventDefault();
            e.stopPropagation();
            const blob = imageItem.getAsFile();
            if (!blob) return;

            await this._uploadAndInjectImage(blob, imageItem.type);
        }, true);
    }

    /**
     * IMG-PASTE — mobile / iOS attach-button hook point.
     *
     * iOS Safari does NOT reliably fire ``paste`` events for image data
     * outside focused contenteditable elements, so we surface an explicit
     * 📎 button (gated to ``pointer: coarse`` via CSS). All wiring lives
     * in clipboard.js (``ClipboardTools.wireAttachButton``): the button
     * opens a menu with "paste from clipboard" (clipboard image → the
     * existing ``_uploadAndInjectImage`` flow, clipboard text → injected
     * as terminal input) and "attach image" (the original hidden
     * file-input picker). This method only locates the DOM nodes and
     * hands them over.
     *
     * The file input has ``accept="image/*,image/heic,image/heif"`` so
     * the OS picker offers both Photos library + Files; the server
     * rejects HEIC at validation time with a "convert to PNG/JPEG"
     * message (intentional v1 scope).
     */
    _applyImageAttachButton() {
        const btn = document.getElementById('cloude-image-attach-button');
        const input = document.getElementById('cloude-image-attach-input');
        if (!btn || !input) return;

        // clipboard.js is loaded right after this file and initTerminal()
        // only runs after the async xterm CDN wait, so ClipboardTools is
        // always defined here in practice; the guard covers a failed
        // static fetch (button simply goes inert rather than throwing).
        if (window.ClipboardTools && typeof window.ClipboardTools.wireAttachButton === 'function') {
            window.ClipboardTools.wireAttachButton(this, btn, input);
        }
    }

    /**
     * TOUCH-SELECT — long-press selection hook point.
     *
     * Hands the Terminal wrapper to touch-select.js, which wires the
     * long-press → drag → floating-copy flow on coarse-pointer devices.
     * Same load-order guarantee as _applyImageAttachButton(): touch-select.js
     * is loaded right after this file and initTerminal() only runs after
     * the async xterm CDN wait; the guard covers a failed static fetch
     * (touch selection simply goes inert rather than throwing).
     */
    _applyTouchSelection() {
        if (window.TouchSelect && typeof window.TouchSelect.init === 'function') {
            window.TouchSelect.init(this);
        }
    }

    /**
     * Wire the terminal-screen tool strip.
     *
     * Three session-scoped controls, all mounted in index.html and wired
     * here once: the copy-output sheet (copy-output.js), the per-session
     * theme picker and the per-session music opt-in (both in
     * session-theme-menu.js). Buttons live outside #terminal so
     * term.reset() on a session swap cannot wipe the handlers; each
     * module guards its own re-entry.
     *
     * @returns {void}
     */
    _applyTerminalTools() {
        const copyBtn = document.getElementById('terminalCopyBtn');
        if (copyBtn && window.CopyOutput) {
            window.CopyOutput.wireButton(this, copyBtn);
        }

        const themeBtn = document.getElementById('sessionThemeBtn');
        const audioBtn = document.getElementById('sessionAudioBtn');
        if (window.SessionThemeMenu) {
            window.SessionThemeMenu.wire(this, themeBtn, audioBtn);
        }
    }

    /**
     * IMG-PASTE — shared upload + path-injection routine.
     *
     * Trailing SPACE (not Enter) is intentional: Claude Code's CLI
     * auto-attaches any absolute image path that appears in its prompt
     * buffer once the user submits, so we want the path to land in the
     * buffer with a space separator and let the user keep typing their
     * prompt. Auto-Enter would submit a path-only message and waste the
     * round-trip.
     */
    async _uploadAndInjectImage(blob, mimeType) {
        this._showStatusPill('Uploading image...', 'info');
        try {
            // Multi-session: scope the upload to THIS tab's session so the
            // image lands in the right project's working dir.
            const sessionId = this._sessionId();
            const result = await window.API.uploadImage(blob, mimeType, sessionId);
            this.insertText(result.path + ' ');
            this._showStatusPill('Pasted: ' + result.filename, 'success');
        } catch (err) {
            console.error('[IMG-PASTE] upload failed', err);
            this._showStatusPill('Upload failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
        }
    }

    /**
     * IMG-PASTE — inline status pill.
     *
     * Lazy-creates the pill the first time it is needed. The element is
     * positioned ``fixed`` near the top center via CSS, so its DOM
     * insertion point is irrelevant. Auto-dismisses after 3s for
     * info/success and 5s for errors so the user has time to read the
     * failure reason.
     */
    _showStatusPill(message, kind) {
        let pill = document.getElementById('cloude-status-pill');
        if (!pill) {
            pill = document.createElement('div');
            pill.id = 'cloude-status-pill';
            pill.className = 'cloude-status-pill';
            document.body.appendChild(pill);
        }
        pill.textContent = message;
        pill.dataset.kind = kind || 'info';
        pill.classList.add('visible');
        if (this._statusPillTimeout) clearTimeout(this._statusPillTimeout);
        this._statusPillTimeout = setTimeout(() => {
            pill.classList.remove('visible');
        }, kind === 'error' ? 5000 : 3000);
    }

    /**
     * Enqueue PTY data for writing
     */
    enqueue(bytes) {
        this.queue.push(bytes);
        if (!this.flushing) {
            this.flushing = true;
            requestAnimationFrame(() => this.flush());
        }
    }

    /**
     * Flush queued PTY data
     */
    flush() {
        let total = 0;
        for (const c of this.queue) total += c.length;
        const merged = new Uint8Array(total);
        let o = 0;
        while (this.queue.length) {
            const c = this.queue.shift();
            merged.set(c, o);
            o += c.length;
        }
        // SCROLLBACK — sample the viewport position BEFORE the write. See
        // terminal-scroll.js for why this cannot be a flag mutated by a
        // debounced scroll listener: the write always won that race, so
        // the view snapped back to the bottom while output was streaming
        // and the user could never stay scrolled up.
        const follow = window.TerminalScroll
            ? window.TerminalScroll.shouldFollowOutput(this.term)
            : this.autoScrollEnabled;

        this.term.write(merged, () => {
            this.flushing = false;

            if (follow && this.term) {
                this.term.scrollToBottom();
            }

            if (this.queue.length) requestAnimationFrame(() => this.flush());
        });
    }

    /**
     * SCROLLBACK — hand the #terminal container to terminal-scroll.js,
     * which observes touch/wheel gestures so a write cannot yank the
     * viewport out from under a drag.
     *
     * This replaces a debounced `.xterm-viewport` scroll listener that
     * tried to infer intent AFTER the fact. Whether to chase output is
     * now measured from the xterm buffer immediately before each write
     * (see flush()), so there is no longer any state to keep in sync and
     * no timer that a write can beat.
     *
     * @returns {void}
     */
    setupScrollListener() {
        const container = document.getElementById('terminal');
        if (window.TerminalScroll && container) {
            window.TerminalScroll.init(container);
        }
    }

    _forceScrollToBottom(holdMs = 400) {
        if (!this.term) return;
        this._programmaticScrollLock++;
        this.autoScrollEnabled = true;
        // Reconnect/replay repaint is an explicit "back to live" intent —
        // drop any gesture latch so the pins below are not suppressed.
        if (window.TerminalScroll) window.TerminalScroll.pinToBottom(this.term);
        const pin = () => {
            if (!this.term) return;
            try { this.term.scrollToBottom(); } catch (_) { /* */ }
            const vp = document.querySelector('.xterm-viewport');
            if (vp) vp.scrollTop = vp.scrollHeight;
        };
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                pin();
                setTimeout(pin, 50);
                setTimeout(pin, 150);
                setTimeout(() => {
                    pin();
                    this._programmaticScrollLock = Math.max(0, this._programmaticScrollLock - 1);
                }, holdMs);
            });
        });
    }

    /**
     * Check if viewport is scrolled to bottom
     */
    isScrolledToBottom(viewport) {
        if (!viewport) return true;
        const threshold = 10; // pixels from bottom
        return (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= threshold;
    }

    /**
     * Scroll to bottom and re-enable auto-scroll (for D-pad)
     */
    scrollToBottomAndEnableAutoScroll() {
        if (!this.term) return;
        this.autoScrollEnabled = true;
        // Clears the gesture latch too — this is an explicit "back to
        // live" intent and must beat a latch left by the user's last
        // drag, which would otherwise suppress the next few writes.
        if (window.TerminalScroll) {
            window.TerminalScroll.pinToBottom(this.term);
        } else {
            this.term.scrollToBottom();
        }
    }

    /**
     * Send resize event to server.
     *
     * Dedups on (cols, rows) so the four-source funnel doesn't ship
     * redundant frames when a layout event fires but the cell grid
     * didn't actually change (zoom-neutral pinch, background chrome
     * collapse that stays within the same cell count, etc.).
     *
     * @param {string} source - Origin tag for the [TERM-RESIZE] log line.
     *   Values: 'window.resize' | 'orientationchange' |
     *   'visualViewport.resize' | 'ResizeObserver' | 'handshake' |
     *   'ws.onopen'. Defaults to 'unknown' for callers that don't tag.
     * @param {boolean} force - Bypass the dedup gate. Used by the
     *   request_dims handshake so the server always gets a fresh frame
     *   on reconnect even if the grid happens to match the last send.
     */
    sendResize(source = 'unknown', force = false) {
        if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.term)) return;

        const cols = this.term.cols;
        const rows = this.term.rows;

        if (!force && cols === this.lastSentCols && rows === this.lastSentRows) {
            return;
        }

        this.ws.send(JSON.stringify({
            type: 'pty_resize',
            cols,
            rows,
        }));

        console.log(`[TERM-RESIZE] ${cols}x${rows} source=${source}`);

        this.lastSentCols = cols;
        this.lastSentRows = rows;
    }

    /**
     * Send key to terminal (for D-pad)
     * @param {string} keyData - ANSI escape sequence or character
     */
    sendKeyToTerminal(keyData) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(new TextEncoder().encode(keyData));
        } else {
            console.warn('Terminal: WebSocket not open, cannot send key');
        }
    }

    /**
     * Connect to session
     * @param {object} session - Session data
     * @param {object} [opts]
     * @param {string} [opts.initialScrollbackB64] - Base64-encoded bytes
     *   captured server-side from `tmux capture-pane` for the external
     *   session being adopted. Painted into xterm BEFORE the WS opens so
     *   the server's WS tailer can seek the fifo to `fifoStartOffset`
     *   without risking a tear or duplicate output. Ignored on normal
     *   (non-adopt) session creates.
     * @param {number} [opts.fifoStartOffset] - Byte offset into the
     *   pipe-pane fifo that the server's tailer should begin streaming
     *   from. Client doesn't consume this directly; it's the server's
     *   contract — we accept it for symmetry and logging only.
     */
    async connectToSession(session, opts = {}) {
        const { initialScrollbackB64 = '', fifoStartOffset = null } = opts;
        console.log('Terminal: Connecting to session:', this._unwrapSession(session).id, {
            adopted: !!initialScrollbackB64,
            fifoStartOffset,
        });

        // If a prior session was active, tear it down cleanly before painting the new one.
        // Prevents stale scrollback, stacked "[Session created...]" banners, and ghost
        // WebSocket readers competing for the same backend FIFO.
        if (this.ws) {
            try {
                // Flag so our onclose handler doesn't trigger a reconnect loop.
                this._intentionalClose = true;
                this.ws.close();
            } catch (e) {
                console.warn('Terminal: error closing prior WS:', e);
            }
            this.ws = null;
        }
        // Reset the xterm buffer and cursor. term.reset() clears scrollback +
        // alt-buffer + wraps state; term.clear() only clears the visible screen.
        // We want reset() so the VT parser starts fresh for the new session.
        if (this.term) {
            try {
                this.term.reset();
            } catch (e) {
                console.warn('Terminal: xterm reset failed:', e);
            }
            // term.reset() wipes xterm's custom key handler slot.
            // Re-attach so Shift+Enter continues to emit ESC+CR for the
            // new session instead of silently falling back to default \r.
            this._applyKeyHandlers();
        }
        this._currentSession = null;
        this.sessionActive = false;
        this.reconnectAttempts = 0;

        // Stash session on the controller so other modules (launchpad
        // self-adopt filter, debug) can introspect without refetching.
        this._currentSession = session;

        this.sessionActive = true;
        // Unwrap: `session` here is a bare Session for the normal
        // create/adopt callers, but treat it as possibly-wrapped anyway
        // (cheap, and future callers of this same method might not be).
        const inner = this._unwrapSession(session);
        this.sessionInfoEl.textContent =
            `Session: ${inner.id || 'unknown'} | PID: ${inner.pty_pid || '?'}`;

        // Enable detach button (delete lives in the sidebar/launcher now,
        // not the header — nothing to enable here for it).
        if (this.detachSessionBtn) this.detachSessionBtn.disabled = false;

        // Adopt path: paint server-captured scrollback into xterm BEFORE
        // the WS opens. Must be synchronous relative to the WS connect so
        // the VT parser state is correct when the first streamed byte
        // arrives at fifoStartOffset. atob() decodes to a binary string
        // whose charCodeAt values are the raw bytes — we MUST NOT run
        // these through TextDecoder, which would mangle non-UTF8 ANSI
        // escape bytes. xterm.write() accepts Uint8Array directly and
        // feeds the parser without re-encoding.
        if (initialScrollbackB64) {
            // Let layout settle (screen-swap CSS toggle in app.js needs a
            // paint tick before clientWidth/clientHeight read truthful
            // values). Double-rAF is the canonical "wait for layout" guard.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // Fit xterm to the container BEFORE painting scrollback so the
            // captured bytes land at the correct column width. xterm.js
            // doesn't reflow already-buffered content on resize, so painting
            // at the default 80-col geometry leaves the scrollback wrong
            // even after a later fit. If the container isn't visible yet,
            // fit() may throw or compute zeros — we swallow and continue;
            // the resize pipeline / handshake fit will still recover the
            // live screen, just not the already-painted scrollback rows.
            try {
                if (this.fitAddon && typeof this.fitAddon.fit === 'function') {
                    this.fitAddon.fit();
                }
            } catch (e) {
                console.warn('pre-paint fit failed (continuing):', e);
            }

            try {
                const bin = atob(initialScrollbackB64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) {
                    bytes[i] = bin.charCodeAt(i) & 0xff;
                }
                // Exit any alt-screen state + clear + home cursor so the captured bytes
                // paint into a known-clean screen instead of on top of stale parser
                // state (the bytes carry escape sequences relative to the tmux pane's
                // screen state at capture time — we have none of that here).
                this.term.write('\x1b[?1049l\x1b[2J\x1b[H');
                this.term.write(bytes, () => {
                    this._forceScrollToBottom();
                });
                console.log(`Terminal: painted ${bytes.length} bytes of adopt scrollback`);
                // Flag to send Ctrl+L in ws.onopen after dims handshake settles
                this._needsReplayCtrlL = true;
                this._pendingPostConnectScroll = true;
            } catch (e) {
                // Non-fatal — if the b64 is malformed we still want the
                // session to come up. The user will just miss the pre-
                // adopt scrollback, not the live stream.
                console.warn('Terminal: scrollback paint failed, continuing without it:', e);
            }
        } else {
            this.term.writeln('\x1b[1;32m[Session created - connecting to WebSocket...]\x1b[0m');
        }

        // Connect WebSocket
        setTimeout(() => this.connectWebSocket(), 500);

        // Load any locally-detected dev servers for this session
        this.loadLocalServers();
    }

    /**
     * Reconnect to an ALREADY-ACTIVE backend session.
     *
     * Used when the user returns to the launchpad while a session is
     * running and clicks "return to terminal". The backend is already
     * alive — we must NOT POST /sessions (would try to create) or
     * POST /sessions/adopt (would re-pipe-pane the tmux session). We
     * just re-open the WebSocket against the existing backend.
     *
     * Contract parity with connectToSession(): stashes the session on
     * the controller, marks it active, wires the destroy button, then
     * opens the WS on the same delay so the UI transition settles first.
     *
     * Safe to call multiple times. If a live WS is already open, we
     * do nothing beyond re-painting the status (the server stream is
     * unaffected). If xterm already holds state from the previous
     * session view, we leave it alone — returning to an existing
     * session should feel seamless, not like a reload.
     *
     * @param {object} session - Session object (shape matches what
     *   GET /sessions returns under the ``session`` key).
     */
    async reconnectToExistingSession(session) {
        console.log('Terminal: Reconnecting to existing session:', this._unwrapSession(session).id);

        // If a prior session was active, tear it down cleanly before painting the new one.
        // Prevents stale scrollback, stacked "[Session created...]" banners, and ghost
        // WebSocket readers competing for the same backend FIFO.
        if (this.ws) {
            try {
                // Flag so our onclose handler doesn't trigger a reconnect loop.
                this._intentionalClose = true;
                this.ws.close();
            } catch (e) {
                console.warn('Terminal: error closing prior WS:', e);
            }
            this.ws = null;
        }
        // Reset the xterm buffer and cursor. term.reset() clears scrollback +
        // alt-buffer + wraps state; term.clear() only clears the visible screen.
        // We want reset() so the VT parser starts fresh for the new session.
        if (this.term) {
            try {
                this.term.reset();
            } catch (e) {
                console.warn('Terminal: xterm reset failed:', e);
            }
            // term.reset() wipes xterm's custom key handler slot.
            // Re-attach so Shift+Enter continues to emit ESC+CR for the
            // new session instead of silently falling back to default \r.
            this._applyKeyHandlers();
        }
        this._currentSession = null;
        this.sessionActive = false;
        this.reconnectAttempts = 0;

        // Stash so launchpad self-adopt filter + debug can introspect.
        this._currentSession = session;
        this.sessionActive = true;

        if (this.sessionInfoEl) {
            // `session` here is the SessionInfo WRAPPER in the two real
            // callers (App.returnToExistingTerminal, fed from
            // window.API.getSession() by the launchpad's "return to
            // running session" flow and the conversation sidebar's row
            // click) — `.id`/`.pty_pid` live on `.session`, not on this
            // object directly. Reading them unwrapped is exactly the bug
            // that produced "Session: undefined | PID: ?" in the status
            // bar; _unwrapSession() is the fix.
            const inner = this._unwrapSession(session);
            this.sessionInfoEl.textContent =
                `Session: ${inner.id || 'unknown'} | PID: ${inner.pty_pid || '?'}`;
        }
        if (this.detachSessionBtn) {
            this.detachSessionBtn.disabled = false;
        }

        // Launchpad-rejoin scrollback replay — same treatment as the adopt
        // path in connectToSession(). The launchpad asks the server for
        // ``initial_scrollback_b64`` on the SessionInfo (via
        // ``getSession(..., { includeScrollback: true })``); when present we
        // paint those bytes into the freshly-reset xterm BEFORE the WS opens
        // so the user sees the pre-existing history immediately. The Ctrl+L
        // follow-up after the WS handshake (gated on ``_needsReplayCtrlL``)
        // forces the foreground app to redraw the live screen at the new
        // dims, on top of the painted history.
        const initialScrollbackB64 = session && session.initial_scrollback_b64;
        if (initialScrollbackB64) {
            // Let layout settle (screen-swap CSS toggle in app.js needs a
            // paint tick before clientWidth/clientHeight read truthful
            // values). Double-rAF is the canonical "wait for layout" guard.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // Fit xterm to the container BEFORE painting scrollback so the
            // captured bytes land at the correct column width. xterm.js
            // doesn't reflow already-buffered content on resize, so painting
            // at the default 80-col geometry leaves the scrollback wrong
            // even after a later fit. If the container isn't visible yet,
            // fit() may throw or compute zeros — we swallow and continue;
            // the resize pipeline / handshake fit will still recover the
            // live screen, just not the already-painted scrollback rows.
            try {
                if (this.fitAddon && typeof this.fitAddon.fit === 'function') {
                    this.fitAddon.fit();
                }
            } catch (e) {
                console.warn('pre-paint fit failed (continuing):', e);
            }

            try {
                const bin = atob(initialScrollbackB64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) {
                    bytes[i] = bin.charCodeAt(i) & 0xff;
                }
                // Exit any alt-screen state + clear + home cursor so the
                // captured bytes paint into a known-clean parser state.
                this.term.write('\x1b[?1049l\x1b[2J\x1b[H');
                this.term.write(bytes, () => {
                    this._forceScrollToBottom();
                });
                console.log(`Terminal: painted ${bytes.length} bytes of rejoin scrollback`);
                this._needsReplayCtrlL = true;
                this._pendingPostConnectScroll = true;
            } catch (e) {
                // Non-fatal: fall through to the clean-screen rejoin. The
                // live stream over WS still works; user just misses the
                // pre-existing history paint.
                console.warn('reconnectToExistingSession: failed to paint initial scrollback', e);
            }
        }

        // Always reopen a fresh WS after teardown above, on the same delay
        // connectToSession uses, so
        // the terminal screen transition has time to settle and the
        // fit/font readiness dance in connectWebSocket() has a stable
        // container to measure.
        setTimeout(() => this.connectWebSocket(), 500);

        // Refresh local-servers panel in case dev servers came up or
        // shut down while the user was away on the launchpad.
        this.loadLocalServers();
    }

    /**
     * Wait for fonts and layout to be ready
     */
    async waitForFontsAndLayout(container) {
        if (document.fonts?.ready) {
            try { await document.fonts.ready; } catch {}
        }
        const t0 = performance.now();
        while ((container.offsetWidth|0) === 0 || (container.offsetHeight|0) === 0) {
            if (performance.now() - t0 > 2000) break;
            await new Promise(r => setTimeout(r, 16));
        }
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
    }

    /**
     * Connect WebSocket with auth token
     */
    async connectWebSocket() {
        if (this.isReconnecting) {
            this.stopReconnecting();
            return;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Terminal: Already connected');
            return;
        }

        this.updateStatus('Connecting to terminal...');

        // Wait for fonts and layout
        const container = document.getElementById('terminal');
        await this.waitForFontsAndLayout(container);

        // Fit terminal with multiple attempts to ensure proper sizing
        this.fitAddon.fit();
        await new Promise(resolve => setTimeout(resolve, 50));
        this.fitAddon.fit();

        console.log('Terminal size:', this.term.cols, 'x', this.term.rows);

        // Open WebSocket via subprotocol auth (Item 3). JWT is carried in
        // the Sec-WebSocket-Protocol header, NOT in the URL — so no token
        // redaction is needed when logging the URL. Multi-session: the
        // session id goes in the ``?session_id=`` query param so the
        // server scopes this stream to OUR session — another tab on a
        // different session keeps its own WS undisturbed. ``_currentSession``
        // may be a bare Session ({id}) or a SessionInfo ({session:{id}}).
        const sessionId = this._sessionId();
        const wsURL = window.API.getWebSocketURL(sessionId);
        console.log('Terminal: Connecting to WebSocket:', wsURL);

        this.ws = window.API.openWebSocket(sessionId);
        this.ws.binaryType = 'arraybuffer';
        this.setupWebSocketHandlers();
    }

    /**
     * Normalize a session-shaped API payload down to the INNER Session
     * object ({id, pty_pid, working_dir, status, tmux_session, model,
     * ...}). Single normalization point for this file — every reader of
     * `.id` / `.pty_pid` / `.working_dir` etc. on a session-shaped value
     * goes through here instead of re-deriving its own `s.session || s`
     * fallback, which is how `connectToSession`'s status-bar line and
     * `reconnectToExistingSession`'s status-bar line ended up reading
     * `undefined` / `?` — they read those fields straight off whatever
     * was passed in without checking which shape it was.
     *
     * The two shapes in play, both real:
     *   - Bare `Session` — what `POST /sessions` (create) and
     *     `POST /sessions/adopt` resolve to on their own top level
     *     (callers like `App.showTerminal` already unwrap
     *     `response.session || response` before handing off, so a bare
     *     Session is what usually reaches `connectToSession`).
     *   - `SessionInfo` wrapper (`{session, tmux_session, activity_status,
     *     unread, pinned_theme, ...}`) — what `GET /sessions` and
     *     `GET /sessions/list` return. `App.returnToExistingTerminal` /
     *     `reconnectToExistingSession` are fed this wrapper directly by
     *     the launchpad's "return to running session" flow and the
     *     conversation sidebar's row-click (both call
     *     `window.API.getSession(...)` and pass the result straight
     *     through).
     *
     * IMPORTANT: fields that live on the WRAPPER itself — `tmux_session`,
     * `activity_status`, `unread`, `pinned_theme`,
     * `initial_scrollback_b64` — are NOT part of the inner Session and
     * are NOT what this helper returns. A caller that needs one of those
     * reads it from the original (possibly-wrapper) value, not from this
     * unwrapped result — see `_currentTmuxName()` below, which checks
     * the wrapper's own `tmux_session` first for exactly that reason.
     *
     * Inputs: s (object|null|undefined) - bare Session or SessionInfo.
     * Output: object - the inner Session, or `{}` if `s` is falsy, so
     *   callers can read `.id` / `.pty_pid` without a null-guard at every
     *   call site.
     */
    _unwrapSession(s) {
        if (!s) return {};
        return (s.session && typeof s.session === 'object') ? s.session : s;
    }

    /**
     * Resolve THIS tab's session id from ``_currentSession``, which may be
     * a bare Session ({id}) or a SessionInfo ({session:{id}}). Returns null
     * when not yet known (server falls back to "the" current session).
     */
    _sessionId() {
        return this._unwrapSession(this._currentSession).id || null;
    }

    /**
     * Resolve the current tmux session name from ``_currentSession``
     * (bare Session or SessionInfo shape). `tmux_session` lives on BOTH
     * shapes (the SessionInfo wrapper carries its own top-level copy, the
     * inner Session carries the canonical one) — check the raw value
     * first since it's cheaper and identical either way, then fall back
     * to the unwrapped inner Session's copy.
     */
    _currentTmuxName() {
        const s = this._currentSession;
        if (!s) return null;
        if (s.tmux_session) return s.tmux_session;
        return this._unwrapSession(s).tmux_session || null;
    }

    /**
     * v0.7.1 — swap the in-session header title span for an inline input
     * so the user can edit the session name. Triggered by the pencil
     * button next to #header-title-text. Enter/blur saves; Esc cancels.
     *
     * Idempotent: if a rename input is already showing, this is a no-op.
     */
    _enterHeaderRename() {
        const titleEl = document.getElementById('header-title-text');
        if (!titleEl) return;
        if (titleEl.style.display === 'none') return; // already editing
        const current = this._currentTmuxName();
        if (!current) return;

        // Build the input.
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'header-rename-input';
        input.className = 'header-rename-input';
        input.value = current;
        input.maxLength = 64;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'New session name');

        // Inline error label (hidden until needed). Sits below the input.
        const err = document.createElement('span');
        err.id = 'header-rename-error';
        err.className = 'header-rename-error';
        err.style.display = 'none';

        // Hide the title span + pencil button while editing.
        titleEl.style.display = 'none';
        const pencilEl = document.getElementById('header-rename-pencil');
        if (pencilEl) pencilEl.style.display = 'none';

        // Insert input + error label right after the (now hidden) title.
        titleEl.insertAdjacentElement('afterend', input);
        input.insertAdjacentElement('afterend', err);

        // Track whether we already saved/cancelled so blur after Enter
        // doesn't double-fire.
        let settled = false;

        const cleanup = () => {
            try {
                if (input.parentNode) input.parentNode.removeChild(input);
            } catch (_) { /* non-fatal */ }
            try {
                if (err.parentNode) err.parentNode.removeChild(err);
            } catch (_) { /* non-fatal */ }
            titleEl.style.display = '';
            if (pencilEl) pencilEl.style.display = '';
        };

        const cancel = () => {
            if (settled) return;
            settled = true;
            cleanup();
        };

        const save = async () => {
            if (settled) return;
            const raw = (input.value || '').trim();
            // Empty / unchanged → cancel.
            if (!raw || raw === current) {
                cancel();
                return;
            }
            // Client-side pre-flight; server is still authoritative on the
            // regex. We mirror the server regex so the user gets immediate
            // feedback without a round-trip on obvious typos.
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
                err.textContent = 'Use 1-64 chars: A-Z a-z 0-9 _ -';
                err.style.display = '';
                input.focus();
                input.select();
                return;
            }
            const sid = this._sessionId();
            if (!sid) {
                err.textContent = 'No active session';
                err.style.display = '';
                return;
            }
            settled = true;
            try {
                await window.API.renameSession(sid, raw);
                // On success the server's WS broadcast (session.renamed)
                // will repaint the header + tab title + launchpad row.
                // We tear down the input either way via _exitHeaderRename
                // (which is also invoked by the WS handler). Calling here
                // covers the case where the broadcast races us.
                cleanup();
            } catch (e) {
                settled = false; // let the user retry
                let msg = (e && e.message) ? e.message : 'Rename failed';
                // Surface common error codes more readably.
                if (/409/.test(msg) || /already in use/i.test(msg)) {
                    msg = 'Name already in use';
                } else if (/400/.test(msg) || /Invalid session name/i.test(msg)) {
                    msg = 'Invalid name';
                } else if (/404/.test(msg)) {
                    msg = 'Session not found';
                }
                err.textContent = msg;
                err.style.display = '';
                input.focus();
                input.select();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('blur', () => {
            // A blur immediately after a successful save would no-op
            // (settled=true short-circuits both branches), so we just
            // call save() — if the user blurred with an unchanged value
            // it cancels; otherwise we attempt the rename.
            save();
        });

        // Focus + select so the user can immediately type a replacement.
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    /**
     * Tear down the inline rename input (if any). Called from the WS
     * ``session.renamed`` handler so the input swaps back to display
     * mode with the new value already painted via setHeaderIdentity.
     */
    _exitHeaderRename(newName) {
        const input = document.getElementById('header-rename-input');
        const err = document.getElementById('header-rename-error');
        const titleEl = document.getElementById('header-title-text');
        const pencilEl = document.getElementById('header-rename-pencil');
        if (input && input.parentNode) {
            try { input.parentNode.removeChild(input); } catch (_) { /* */ }
        }
        if (err && err.parentNode) {
            try { err.parentNode.removeChild(err); } catch (_) { /* */ }
        }
        if (titleEl) {
            titleEl.style.display = '';
            if (newName) titleEl.textContent = newName;
        }
        if (pencilEl) pencilEl.style.display = '';
    }

    /**
     * Setup WebSocket event handlers
     */
    setupWebSocketHandlers() {
        if (!this.ws) return;

        this.ws.onopen = () => {
            console.log('Terminal: WebSocket connected');

            // Reset reconnect state
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            // Clear intentional-close flag now that a fresh WS is open —
            // any FUTURE close is a natural disconnect and should reconnect.
            this._intentionalClose = false;
            // A fresh open means whatever session_id this WS is bound to
            // (possibly a NEW one from a 4404 re-adopt) is known-good —
            // re-arm the by-name fallback for the next disconnect episode.
            this._reconnectByNameAttempted = false;
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            this.updateStatus('Connected', 'connected');

            if (this.term) {
                this.term.writeln('\x1b[1;32m[Connected to PTY terminal]\x1b[0m\n');
            }

            // v0.7.0 Part 2 — backfill any unacked toasts for THIS session
            // that fired while this browser was disconnected. Fire-and-forget;
            // failure here is logged but doesn't block the terminal coming up.
            const sidForToasts = this._sessionId();
            if (sidForToasts && window.API && window.ToastManager &&
                typeof window.API.getSessionToasts === 'function') {
                window.API.getSessionToasts(sidForToasts, { unackedOnly: true })
                    .then((toasts) => {
                        if (Array.isArray(toasts) && toasts.length) {
                            window.ToastManager.backfill(toasts);
                        }
                    })
                    .catch((err) => {
                        console.warn('[Toast] backfill failed', err && err.message);
                    });
            }

            // Send initial resize (legacy fallback path — the server's
            // request_dims handshake will also arrive and trigger a
            // handshake-tagged sendResize which dedupes if dims match).
            this.sendResize('ws.onopen');

            // DO NOT send Ctrl+L (0x0c) from the client here. The server's
            // resize handshake already writes a single 0x0c to the PTY after
            // SIGWINCH settles (src/api/websocket.py — success path ~:363,
            // degraded fallback ~:381), and that is the authoritative redraw
            // that repaints the live screen on top of our replayed scrollback
            // at the correct post-resize geometry.
            //
            // Claude Code's TUI debounces Ctrl+L: a SINGLE 0x0c forces a safe
            // redraw, but TWO within ~2s (in fullscreen/alt-screen rendering)
            // are interpreted as the `/clear` chord gesture and WIPE THE
            // CONTEXT. A client 0x0c here lands ~+50ms after WS open while the
            // server's lands ~+200ms (post dims + 150ms SIGWINCH sleep) — two
            // 0x0c <2s apart → accidental /clear on every launchpad rejoin.
            // The viewport snap-to-bottom is a purely LOCAL xterm op handled
            // below via _pendingPostConnectScroll/_forceScrollToBottom and
            // needs no wire write, so dropping this send loses nothing.
            this._needsReplayCtrlL = false;

            if (this._pendingPostConnectScroll) {
                this._pendingPostConnectScroll = false;
                this._forceScrollToBottom(800);
            }

            // Start keepalive ping
            if (this.keepaliveInterval) {
                clearInterval(this.keepaliveInterval);
            }
            this.keepaliveInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({type: "ping"}));
                }
            }, 30000);
        };

        this.ws.onmessage = (event) => {
            // Handle binary frames (PTY data)
            if (event.data instanceof ArrayBuffer) {
                this.enqueue(new Uint8Array(event.data));
                return;
            }

            // Handle JSON control messages
            try {
                const message = JSON.parse(event.data);
                this.handleWebSocketMessage(message);
            } catch (error) {
                console.error('Terminal: Failed to parse message:', error);
            }
        };

        this.ws.onerror = (error) => {
            console.error('Terminal: WebSocket error:', error);
            this.updateStatus('WebSocket error', 'error');
        };

        this.ws.onclose = (event) => {
            const closeCode = (event && typeof event.code === 'number') ? event.code : null;
            console.log('Terminal: WebSocket closed', { code: closeCode });
            this.ws = null;

            // Stop keepalive
            if (this.keepaliveInterval) {
                clearInterval(this.keepaliveInterval);
                this.keepaliveInterval = null;
            }

            // If the close was triggered by a deliberate session swap,
            // skip the disconnect banner + reconnect loop — the new
            // session's connect flow will paint its own state.
            if (this._intentionalClose) {
                console.log('Terminal: intentional close, skipping reconnect');
                this._intentionalClose = false;
                return;
            }

            if (this.term) {
                this.term.writeln('\n\x1b[1;31m[Disconnected from terminal]\x1b[0m');
            }

            // Auth-fail close from server (src/api/websocket.py — code 4401
            // is emitted when JWT verification fails on the WS handshake or
            // when the access token expires mid-stream). Don't reconnect
            // with the same stale token — that would spin the close/4401
            // loop until we exhaust maxReconnectAttempts. Instead, proactively
            // refresh first so the next openWebSocket() picks up a fresh
            // token via getToken().
            if (closeCode === 4401 && this.sessionActive && !this.isReconnecting) {
                this._handleAuthFailedClose();
                return;
            }

            // Server-forgot-session close (src/api/websocket.py — code 4404
            // is emitted when ``?session_id=`` doesn't resolve against the
            // server's in-memory session map, e.g. right after a server
            // restart: the tmux session survives on its socket, but the
            // fresh server process never heard of the ephemeral id our WS
            // was scoped to). Retrying with the SAME id via the normal
            // attemptReconnect() below would just hit 4404 again on every
            // attempt until maxReconnectAttempts. Try re-resolving by the
            // stable tmux NAME once instead — see _attemptReconnectByName().
            // Guarded so this fires at most once per disconnect episode
            // (flag clears on the next successful ws.onopen).
            if (closeCode === 4404 && this.sessionActive && !this.isReconnecting
                && !this._reconnectByNameAttempted) {
                this._reconnectByNameAttempted = true;
                // Capture the name this tab is bound to RIGHT NOW, before
                // any await can rebind it, and hand it down so the adopt
                // guard has a fixed reference point to compare against.
                this._attemptReconnectByName(this._currentTmuxName());
                return;
            }

            // OUTAGE close. This is the case neither branch above covers:
            // the socket dies with an ordinary abnormal-close code (1006
            // refused/aborted, 1001 going away, 1012 service restart, ...)
            // and nothing ever sends 4404, so the bounded id-based loop
            // below spends all five attempts against something that is
            // not answering. The close code alone does NOT tell us WHY -
            // a restarting server, a dead proxy and the user's wifi
            // dropping all look identical here - so this branch only
            // claims "possible outage" and _handlePossibleOutage() does
            // the narrowing with a health probe and navigator.onLine.
            // Gated on ServerRestartWatch being loaded so a missing
            // script degrades to the pre-existing behavior rather than
            // throwing inside onclose.
            if (this.sessionActive && !this.isReconnecting && !this._restartWatchActive
                && window.ServerRestartWatch
                && window.ServerRestartWatch.isOutageCloseCode(closeCode)) {
                this._handlePossibleOutage();
                return;
            }

            // Attempt auto-reconnect if session still active
            if (this.sessionActive && !this.isReconnecting) {
                this.attemptReconnect();
            }
        };
    }

    /**
     * Handle WebSocket messages
     */
    handleWebSocketMessage(message) {
        const type = message.type;

        if (type === 'log') {
            if (this.term && message.content) {
                this.term.writeln(`\x1b[1;33m${message.content}\x1b[0m`);
            }
        } else if (type === 'local_server_detected') {
            // Plan v3.2 — A dev server was detected on the host and
            // confirmed as a live TCP listener. Merge into local state
            // and re-render.
            if (this.term && message.url) {
                this.term.writeln(`\x1b[1;36m[Local server detected: ${message.url}]\x1b[0m`);
            }
            this._mergeLocalServer({ port: message.port, url: message.url });
        } else if (type === 'local_server_lost') {
            // The janitor sweep stopped seeing this listener — drop it.
            this._dropLocalServer(message.port);
        } else if (type === 'error') {
            if (this.term) {
                this.term.writeln(`\x1b[1;31m[Error: ${message.message}]\x1b[0m`);
            }
        } else if (type === 'pong') {
            console.log('Terminal: Received pong');
        } else if (type === 'toast.new') {
            // v0.7.0 Part 2 — new toast fired for this session. Hand to
            // ToastManager which dedupes by id, animates entry, and
            // applies the per-session accent color from message.toast.color.
            if (window.ToastManager && message && message.toast) {
                window.ToastManager.add(message.toast);
            }
        } else if (type === 'toast.ack') {
            // Another browser (or this one's POST) acked a toast. Dismiss
            // the local card without re-syncing to the server.
            if (window.ToastManager && message && message.toast_id) {
                window.ToastManager.dismiss(message.toast_id, { syncToServer: false });
            }
        } else if (type === 'session.renamed') {
            // v0.7.1 — server broadcast: this session was renamed (could be
            // us OR another browser tab that initiated the PATCH). Update
            // local copies + the in-session header + the browser tab title
            // when the rename targets THIS attached session. We always
            // poke the launchpad poller so it refreshes immediately rather
            // than waiting on its 5s tick.
            try {
                const myId = this._sessionId();
                const sess = this._currentSession;
                if (message && message.session_id === myId && sess && message.new_name) {
                    // Update the in-memory session record so the rest of the
                    // controller (active-name resolver, header re-paint on
                    // reconnect) sees the new value immediately.
                    if (sess.session && typeof sess.session === 'object') {
                        sess.session.tmux_session = message.new_name;
                    }
                    sess.tmux_session = message.new_name;
                    if (typeof window.setHeaderIdentity === 'function') {
                        window.setHeaderIdentity({
                            icon: 'cloude',
                            title: message.new_name,
                        });
                    }
                    if (typeof window.setPageTitle === 'function') {
                        window.setPageTitle(message.new_name);
                    }
                    // If a rename input is showing in the header, swap it
                    // back to display mode so the user sees the new name
                    // reflected even when the broadcast originated here.
                    if (typeof this._exitHeaderRename === 'function') {
                        this._exitHeaderRename(message.new_name);
                    }
                }
                // Force the launchpad to re-render its running-sessions
                // list immediately (it polls every 5s, but a rename should
                // appear instantly).
                if (window.Launchpad && typeof window.Launchpad.loadRunningSessions === 'function') {
                    try { window.Launchpad.loadRunningSessions(); } catch (_) { /* non-fatal */ }
                }
            } catch (err) {
                console.warn('Terminal: session.renamed handling failed:', err);
            }
        } else if (type === 'request_dims') {
            // Server-driven resize handshake. Fit and reply IMMEDIATELY —
            // bypass the 100ms debounce because the server is waiting in
            // a bounded timeout window (2s). Any debounce here would eat
            // into that budget and risk the server proceeding with stale
            // birth dims.
            if (this.fitAddon && this.term) {
                try {
                    this.fitAddon.fit();
                } catch (e) {
                    console.warn('[TERM-RESIZE] handshake fit failed', e);
                }
                this.sendResize('handshake', true /* force: always ship on handshake */);
            }
        }
    }

    /**
     * Attempt to reconnect WebSocket
     */
    attemptReconnect() {
        if (!this.sessionActive || this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.log('Terminal: Max reconnect attempts reached');
                this.updateStatus('Connection failed', 'error');
                if (this.term) {
                    this.term.writeln('\n\x1b[1;31m[Reconnection failed after ' + this.maxReconnectAttempts + ' attempts]\x1b[0m');
                }
            }
            this.stopReconnecting();
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 16000);

        console.log(`Terminal: Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        this.updateStatus('Reconnecting...');

        if (this.term) {
            this.term.writeln(`\n\x1b[1;33m[Reconnecting... Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}]\x1b[0m`);
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connectWebSocket();
        }, delay);
    }

    /**
     * Stop reconnection attempts
     */
    stopReconnecting() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
    }

    /**
     * Recover from a WS close carrying app code 4404 ("unknown session") by
     * resolving the session's stable TMUX SESSION NAME instead of its
     * ephemeral session_id. The name survives a server restart; the id
     * does not, because the fresh server process has no memory of it.
     *
     * Strategy: ask the server (via ``GET /sessions/attachable``, and as a
     * belt-and-suspenders check ``GET /sessions/list``) whether a tmux
     * session with our name still exists.
     *   - Found -> genuinely "server forgot, tmux remembers": re-adopt it
     *     (``POST /sessions/adopt``, which never 409s in the multi-session
     *     model) and resume via reconnectToExistingSession() — same
     *     scrollback-repaint + WS-reopen path the launchpad's manual
     *     rejoin uses.
     *   - Not found -> genuinely gone (destroyed by another client, tmux
     *     process died, etc). Do NOT retry and do NOT synthesize a new
     *     session — mark the session ended and let the user start fresh
     *     from the launchpad, exactly like a normal destroy.
     *
     * Runs at most once per disconnect episode (call site in
     * setupWebSocketHandlers() gates on ``_reconnectByNameAttempted``,
     * which resets on the next successful ws.onopen) so a persistently
     * unreachable server can't spin this in a loop; a failure inside this
     * method (network/API error, not "session missing") falls back to the
     * normal bounded id-based attemptReconnect() so we don't just give up
     * on a transient blip.
     *
     * Inputs: boundTmuxName (string|null, optional) - the tmux name this
     *   tab was bound to at the MOMENT the disconnect episode began,
     *   captured by the caller before any await. It is what gives
     *   _assertAdoptTargetUnchanged() its teeth: without it the guard can
     *   only compare a value read here against itself a few awaits later,
     *   which misses a rebind that happened during a long outage wait.
     *   Omitted (deep-link/legacy callers) it falls back to "now".
     * Output: Promise<void>. Side effects: either re-opens a bound WS via
     *   reconnectToExistingSession(), marks sessionActive=false and fires
     *   'session-destroyed' when the tmux session is gone, or defers to
     *   attemptReconnect() on lookup failure / no resolvable name.
     * Example: invoked from ws.onclose when event.code === 4404.
     */
    async _attemptReconnectByName(boundTmuxName = null) {
        const tmuxName = boundTmuxName || this._currentTmuxName();
        if (!tmuxName || !window.API || typeof window.API.listAttachableSessions !== 'function') {
            // Can't resolve by name — degrade to the pre-existing bounded
            // id-based retry loop rather than doing nothing.
            this.attemptReconnect();
            return;
        }

        this.isReconnecting = true;
        this.updateStatus('Reconnecting...');
        if (this.term) {
            this.term.writeln('\n\x1b[1;33m[Connection restored, looking up session by name...]\x1b[0m');
        }

        let stillAlive = false;
        try {
            const attachable = await window.API.listAttachableSessions();
            stillAlive = Array.isArray(attachable) && attachable.some(s => s && s.name === tmuxName);
        } catch (err) {
            console.warn('Terminal: attachable lookup failed during 4404 recovery:', err);
            // Transient failure (network, auth) — not proof the session is
            // gone. Fall back to the bounded id-based loop.
            this.isReconnecting = false;
            this.attemptReconnect();
            return;
        }

        if (!stillAlive) {
            // Second look: maybe another tab already re-adopted it (races
            // are possible with multiple browser tabs on the same
            // session) so it now shows up as a LIVE backend rather than
            // an attachable one. Only then do we conclude "truly gone".
            try {
                if (window.API && typeof window.API.listSessions === 'function') {
                    const live = await window.API.listSessions();
                    stillAlive = Array.isArray(live) && live.some((info) => {
                        const name = info && (info.tmux_session
                            || (info.session && info.session.tmux_session));
                        return name === tmuxName;
                    });
                }
            } catch (err) {
                console.warn('Terminal: list-sessions lookup failed during 4404 recovery:', err);
            }
        }

        this.isReconnecting = false;

        if (!stillAlive) {
            console.log('Terminal: 4404 recovery found no live tmux session named', tmuxName);
            this.sessionActive = false;
            this.stopReconnecting();
            this.updateStatus('Session ended', 'error');
            if (this.term) {
                this.term.writeln('\x1b[1;31m[Session no longer exists — start a new one from the launchpad]\x1b[0m');
            }
            window.dispatchEvent(new CustomEvent('session-destroyed'));
            return;
        }

        try {
            console.log('Terminal: re-adopting', tmuxName, 'after server restart');
            // EXPLICIT NO-CREATE INVARIANT. This recovery resolves an
            // EXISTING tmux session or gives up; adoptSession() is the
            // only mutating call it may make, and it may only ever be
            // handed the name we disconnected from. A previous bug in the
            // deep-link resolver fell through to createSession() and
            // spawned duplicate tmux sessions (see
            // tests/test_deeplink_resolver.node.mjs) - this assertion
            // makes the equivalent mistake here fail loudly instead.
            this._assertAdoptTargetUnchanged(tmuxName);
            const result = await window.API.adoptSession(tmuxName, true);
            const sessionWithScrollback = Object.assign(
                {}, result.session, { initial_scrollback_b64: result.initial_scrollback_b64 }
            );
            await this.reconnectToExistingSession(sessionWithScrollback);
        } catch (err) {
            console.error('Terminal: re-adopt after 4404 failed:', err);
            // Adopt failed for a reason other than "doesn't exist" (tmux
            // busy, transient 500, etc) — fall back to the bounded
            // id-based loop rather than silently giving up.
            this.attemptReconnect();
        }
    }

    /**
     * Guard the one mutating call the recovery paths are allowed to make.
     * Adopting anything other than the tmux name this tab was already
     * bound to would either steal another session or, worse, materialize
     * a second one - the duplicate-session class of bug. Throws instead
     * of proceeding, so the caller's catch turns it into a bounded retry
     * rather than a silent spawn.
     *
     * WHAT MAKES IT REAL: `tmuxName` is the name captured at the START of
     * the disconnect episode (ws.onclose, or before the health wait in
     * _handlePossibleOutage) and threaded through as
     * _attemptReconnectByName's `boundTmuxName`. This method compares it
     * against `_currentTmuxName()` read NOW, after the lookups and after
     * a wait that can run for minutes. If the tab was rebound to another
     * session in that window - the launchpad opened a different one, a
     * deep link resolved elsewhere - the two disagree and the adopt is
     * refused. Compare a freshly-read name against itself and the guard
     * is decorative; the capture point is the entire mechanism.
     *
     * Inputs: tmuxName (string) - the name about to be adopted, captured
     *   before the episode's awaits.
     * Output: void. Throws Error when the name is empty or no longer
     *   matches this tab's session.
     * Example: this._assertAdoptTargetUnchanged('cloude_my-project');
     */
    _assertAdoptTargetUnchanged(tmuxName) {
        if (!tmuxName) {
            throw new Error('Terminal: refusing to adopt without a tmux name');
        }
        const current = this._currentTmuxName();
        if (current && current !== tmuxName) {
            throw new Error(
                `Terminal: refusing to adopt "${tmuxName}" - this tab is bound to "${current}"`
            );
        }
    }

    /**
     * Lazily build (and memoize) the ServerRestartWatch used to poll
     * /health while the server is down. One instance per Terminal so its
     * lifetime matches the session it recovers.
     *
     * Inputs: none.
     * Output: ServerRestartWatch.
     * Example: const watch = this._serverRestartWatch();
     */
    _serverRestartWatch() {
        if (!this._restartWatch) {
            this._restartWatch = new window.ServerRestartWatch();
        }
        return this._restartWatch;
    }

    /**
     * Recover from a WS close that carries the OUTAGE signature: a code
     * that is none of 4400/4401 (auth, handled by _handleAuthFailedClose)
     * or 4404 (unknown session, handled by _attemptReconnectByName),
     * while the server is not reachable.
     *
     * HONESTY ABOUT THE CAUSE. A browser cannot see why a socket died.
     * A restarting server, a dead reverse proxy and the user's wifi
     * dropping all produce the same close code and the same failed
     * fetch, so this method never asserts "the server restarted". It
     * splits out the ONE case it can actually decide, and is explicit
     * about the rest:
     *   - navigator.onLine === false: the failure is provably LOCAL. We
     *     send no probe (it cannot succeed, and its failure would tell us
     *     nothing about the server), say "no network connection", and the
     *     watch does not spend its ceiling on time we were offline.
     *   - otherwise: we say only "no answer from server", which is the
     *     whole of what we know.
     *
     * Sequence:
     *   1. If the client is online, probe /health once. If it answers,
     *      this was an ordinary blip - hand straight back to the bounded
     *      id-based attemptReconnect() loop, unchanged behavior. (While
     *      offline we skip this and go straight to waiting.)
     *   2. Otherwise paint the waiting state (deliberately distinct from
     *      the ordinary "reconnecting", and distinct again for offline)
     *      and poll /health with backoff up to the watch's ceiling.
     *   3. When the server answers, re-resolve the session BY TMUX NAME
     *      through the existing _attemptReconnectByName() machinery. That
     *      method already handles found / not-found / transient-failure,
     *      and never creates a session.
     *
     * Never revives a session the user deliberately detached or deleted:
     * both set sessionActive=false before closing, which is the abort
     * predicate handed to the watch AND is re-checked before the
     * re-resolve.
     *
     * Inputs: none.
     * Output: Promise<void>. Side effects: status/banner updates, and on
     *   success the same WS re-open _attemptReconnectByName() performs.
     * Example: invoked from ws.onclose when the close code is not
     *   4400/4401/4404.
     */
    async _handlePossibleOutage() {
        const watch = this._serverRestartWatch();
        const status = window.ServerRestartWatch.STATUS;
        const result = window.ServerRestartWatch.RESULT;
        // The identity to restore, captured BEFORE the wait (which can
        // run for minutes). This is what makes the adopt guard real.
        const boundTmuxName = this._currentTmuxName();
        const offlineAtClose = watch.isClientOffline();
        let outcome = null;

        this._restartWatchActive = true;
        try {
            if (!offlineAtClose && await watch.probe()) {
                // Server is answering: this close was not an outage. Fall
                // back to the pre-existing bounded retry.
                console.log('Terminal: server is answering, treating close as a transient blip');
                if (this.sessionActive && !this.isReconnecting) {
                    this._restartWatchActive = false;
                    this.attemptReconnect();
                }
                return;
            }

            if (offlineAtClose) {
                console.log('Terminal: this client is offline, waiting for the network');
                this.updateStatus(status.OFFLINE);
                if (this.term) {
                    this.term.writeln('\n\x1b[1;33m[no network connection on this device, waiting for it to come back...]\x1b[0m');
                }
            } else {
                console.log('Terminal: no answer from the server, waiting for it to become reachable');
                this.updateStatus(status.WAITING);
                if (this.term) {
                    this.term.writeln('\n\x1b[1;33m[no answer from the server, it may be restarting or unreachable. waiting...]\x1b[0m');
                }
            }

            // Track which banner is showing so a transition (wifi comes
            // back but the server is still silent, or the reverse) is
            // repainted instead of leaving stale copy on screen.
            let showingOffline = offlineAtClose;
            outcome = await watch.waitForServer({
                shouldAbort: () => !this.sessionActive,
                onAttempt: ({ attempt, elapsedMs, clientOffline }) => {
                    if (clientOffline !== showingOffline) {
                        showingOffline = clientOffline;
                        this.updateStatus(clientOffline ? status.OFFLINE : status.WAITING);
                    }
                    if (attempt > 1 && attempt % 5 === 0 && this.term) {
                        const secs = Math.round(elapsedMs / 1000);
                        this.term.writeln(clientOffline
                            ? '\x1b[1;33m[still no network connection on this device]\x1b[0m'
                            : `\x1b[1;33m[still no answer from the server, ${secs}s]\x1b[0m`);
                    }
                },
            });
        } finally {
            this._restartWatchActive = false;
        }

        if (outcome === result.ABORTED || !this.sessionActive) {
            // The user detached or deleted while we were waiting. Leave
            // the session alone: no probe loop, no re-adopt, no revival.
            console.log('Terminal: outage wait aborted, session is no longer active');
            this.stopReconnecting();
            return;
        }

        if (outcome === result.TIMEOUT) {
            // Note this is a reachability statement, not a diagnosis: the
            // ceiling only counts time we were online and got no answer.
            console.warn('Terminal: server stayed unreachable through the watch ceiling');
            this.stopReconnecting();
            this.updateStatus(status.UNREACHABLE, 'error');
            if (this.term) {
                this.term.writeln('\n\x1b[1;31m[still cannot reach the server, reload once it is back]\x1b[0m');
            }
            return;
        }

        // Server answered. Re-resolve by the stable tmux NAME - the id we
        // held is meaningless if the process restarted.
        console.log('Terminal: server is reachable again, re-resolving session by name');
        this.updateStatus(status.BACK);
        // Set BEFORE the await, deliberately. _attemptReconnectByName()
        // re-opens the WS on success, and that ws.onopen resets this flag
        // to false - which is exactly what we want, since the next
        // disconnect episode deserves its own by-name attempt. Setting it
        // after the await would clobber that reset and permanently
        // disable 4404 recovery for this tab. Its job here is only to
        // stop the 4404 close that the re-opened socket can itself
        // produce (session vanished between probe and adopt) from running
        // a second, identical lookup while this one is still in flight.
        this._reconnectByNameAttempted = true;
        await this._attemptReconnectByName(boundTmuxName);
    }

    /**
     * Handle a WS close caused by server-side auth failure (code 4401).
     * Refresh the access token BEFORE the next reconnect attempt so the
     * fresh WS handshake carries a valid JWT — otherwise reconnects would
     * loop on 4401 until maxReconnectAttempts and force a TOTP re-prompt.
     *
     * Uses API._singleFlightRefresh when available so a concurrent HTTP
     * 401 path that's already rotating doesn't burn the refresh chain.
     */
    async _handleAuthFailedClose() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        this.updateStatus('Refreshing auth...');

        let refreshed = false;
        try {
            const api = window.API;
            if (api && typeof api._singleFlightRefresh === 'function') {
                refreshed = await api._singleFlightRefresh();
            } else if (window.Auth && typeof window.Auth.refresh === 'function') {
                refreshed = await window.Auth.refresh();
            }
        } catch (e) {
            console.warn('Terminal: refresh during 4401 reconnect threw', e);
            refreshed = false;
        }

        this.isReconnecting = false;

        if (refreshed === true) {
            console.log('Terminal: refresh ok after 4401, reconnecting');
            this.attemptReconnect();
            return;
        }
        if (refreshed === 'network-error') {
            console.warn('Terminal: refresh network error after 4401, short-delay retry');
            if (this.term) {
                this.term.writeln('\x1b[1;33m[Network blip — retrying in 4s]\x1b[0m');
            }
            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                if (this.sessionActive) this._handleAuthFailedClose();
            }, 4000);
            return;
        }
        console.warn('Terminal: refresh failed after 4401, escalating to re-auth');
        if (window.API && typeof window.API.handleUnauthorized === 'function') {
            window.API.handleUnauthorized();
        } else {
            window.dispatchEvent(new CustomEvent('auth-required'));
        }
    }

    /**
     * Resolve the tmux session name to query the local-servers endpoint
     * for. Returns null when no session is active or the name can't be
     * read (e.g. fresh session view, server not yet replied).
     */
    _activeSessionName() {
        const sess = this._currentSession;
        if (!sess) return null;
        return sess.tmux_session || sess.id || null;
    }

    /**
     * Load locally-detected dev servers for the active session and paint
     * them into the Local Servers panel. Detection is server-side only;
     * this call is a pure read.
     */
    async loadLocalServers() {
        const name = this._activeSessionName();
        if (!name) {
            this._localServers = [];
            this._renderLocalServers();
            return;
        }
        try {
            const list = await window.API.getLocalServers(name);
            this._localServers = Array.isArray(list) ? list : [];
            this._renderLocalServers();
        } catch (error) {
            console.error('Terminal: Error loading local servers:', error);
        }
    }

    /**
     * Merge a single local-server entry into local state (idempotent on
     * port). Triggered by the `local_server_detected` WS event.
     */
    _mergeLocalServer(entry) {
        if (!entry || !entry.port) return;
        if (!Array.isArray(this._localServers)) this._localServers = [];
        const idx = this._localServers.findIndex(s => s.port === entry.port);
        if (idx === -1) {
            this._localServers.push({ port: entry.port, url: entry.url });
        } else {
            this._localServers[idx] = { ...this._localServers[idx], url: entry.url };
        }
        this._localServers.sort((a, b) => a.port - b.port);
        this._renderLocalServers();
    }

    /**
     * Drop a local-server entry by port. Triggered by `local_server_lost`.
     */
    _dropLocalServer(port) {
        if (!Array.isArray(this._localServers)) return;
        this._localServers = this._localServers.filter(s => s.port !== port);
        this._renderLocalServers();
    }

    /**
     * Repaint the Local Servers panel from `this._localServers`. Hides
     * the container when no entries are tracked.
     */
    _renderLocalServers() {
        const container = document.getElementById('localServersContainer');
        const list = document.getElementById('localServersList');
        if (!container || !list) return;

        const entries = Array.isArray(this._localServers) ? this._localServers : [];
        if (entries.length === 0) {
            container.style.display = 'none';
            list.innerHTML = '';
            return;
        }
        container.style.display = 'block';
        list.innerHTML = entries.map(entry => `
            <div class="local-server-item">
                <span class="local-server-port">${entry.port}</span>
                <a class="local-server-url" href="${entry.url}" target="_blank" rel="noopener">${entry.url}</a>
            </div>
        `).join('');
    }

    /**
     * Destroy session
     *
     * Description: kills the tmux session and terminates the Claude
     * process for THIS tab's session. Irreversible for the running
     * process (the transcript JSONL under ~/.claude/projects is not
     * touched and survives independently). Confirms first via
     * SessionRowActions.confirm(), which routes to the one
     * App.showConfirmModal() the whole app uses and supplies the shared
     * close-session copy; Detach (detachSession(), below) is
     * intentionally NOT gated by a confirmation because it is safe and
     * reversible. NOT wired to the session header (deleting is no longer
     * reachable while inside a session) — callers are App.logout() and
     * the conversation sidebar's delete-this-session row
     * (session-sidebar.js), plus the launcher's own kill path for other
     * sessions.
     *
     * Inputs:
     *   action (string|null) - SessionRowActions.ACTION_CLOSE or
     *     ACTION_REMOVE, picking which confirm copy the user sees.
     *     Defaults to ACTION_CLOSE for callers that are unambiguously a
     *     close (App.logout()). The sidebar passes the action its row
     *     actually painted, so a stopped own-tab row confirms as a remove
     *     rather than claiming to terminate a process that already
     *     exited. The server teardown below is identical either way:
     *     which one it is, is a statement about the session's state, not
     *     about a different operation.
     * Output: Promise<void>. No-op if the user cancels the confirm modal.
     */
    async destroySession(action = null) {
        const name = this._currentTmuxName() || (this._currentSession && this._currentSession.id) || 'this session';
        // Same confirm copy as every other close control in the app -
        // client/js/session-row-actions.js owns the wording so the
        // sidebar row, the launcher row, and this path cannot describe
        // the same operation three different ways.
        if (!window.SessionRowActions) {
            // Load-order bug. Refuse rather than destroy a session with no
            // confirmation, or invent a second confirmation path.
            console.error('Terminal: SessionRowActions missing, refusing to destroy');
            return;
        }
        const confirmed = await window.SessionRowActions.confirm(
            action || window.SessionRowActions.ACTION_CLOSE, name);
        if (!confirmed) {
            return;
        }

        try {
            this.updateStatus('Destroying session...');

            // Multi-session: destroy THIS tab's session only — other tabs'
            // sessions are untouched.
            const sessionId = this._sessionId();
            await window.API.destroySession(sessionId);

            // v0.7.0 Part 2 — drop any ghost toasts for the destroyed
            // session. Server-side state is already gone with the session,
            // so we don't sync; just clear our local UI.
            if (sessionId && window.ToastManager &&
                typeof window.ToastManager.dismissBySession === 'function') {
                window.ToastManager.dismissBySession(sessionId);
            }

            this.sessionActive = false;
            this.stopReconnecting();

            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            if (this.detachSessionBtn) this.detachSessionBtn.disabled = true;
            this.sessionInfoEl.textContent = 'No active session';

            if (this.term) {
                this.term.clear();
                this.term.writeln('\x1b[1;31mSession destroyed\x1b[0m\n');
            }

            // Trigger session-destroyed event
            window.dispatchEvent(new CustomEvent('session-destroyed'));

        } catch (error) {
            console.error('Terminal: Error destroying session:', error);
            this.updateStatus('Error: ' + error.message, 'error');
        }
    }

    /**
     * Detach from the current session WITHOUT killing tmux.
     *
     * Description: the non-destructive counterpart to destroySession() —
     * calls API.detachSession() so the server tears down its Python-side
     * handles (reader task, idle watcher, pipe-pane) for THIS tab's
     * session while leaving the tmux session running. The user can later
     * re-adopt it from the launchpad's "attachable" list, unlike
     * destroySession() which is permanent.
     * Inputs: none (reads this._sessionId() for the active session).
     * Output: Promise<void>. Side effects: closes the local WS
     *   (marked intentional so onclose does not reconnect), clears the
     *   xterm view, sets sessionActive=false, and navigates back to the
     *   launchpad via the same 'session-destroyed' event destroySession()
     *   uses (the launchpad treats both as "no longer my active tab").
     * Example: wired to #detachSessionBtn's click handler in init().
     */
    async detachSession() {
        try {
            this.updateStatus('Detaching session...');

            const sessionId = this._sessionId();
            await window.API.detachSession(sessionId);

            // Mark false BEFORE closing the socket so onclose's reconnect
            // (and the 4404 name-based fallback) both see sessionActive
            // === false and do nothing — an intentionally detached
            // session must never be silently re-adopted.
            this.sessionActive = false;
            this.stopReconnecting();
            this._reconnectByNameAttempted = false;

            if (this.ws) {
                this._intentionalClose = true;
                this.ws.close();
                this.ws = null;
            }

            if (this.detachSessionBtn) this.detachSessionBtn.disabled = true;
            this.sessionInfoEl.textContent = 'No active session';

            if (this.term) {
                this.term.clear();
                this.term.writeln('\x1b[1;33mSession detached — still running, re-adopt it from the launchpad\x1b[0m\n');
            }

            // Reuse the same event destroySession() fires — both mean
            // "this tab no longer owns an active session"; the launchpad
            // doesn't need to distinguish detach from delete to react.
            window.dispatchEvent(new CustomEvent('session-destroyed'));

        } catch (error) {
            console.error('Terminal: Error detaching session:', error);
            this.updateStatus('Error: ' + error.message, 'error');
        }
    }

    /**
     * Leave the terminal view for the launcher WITHOUT detaching or
     * destroying the session server-side (the Home control's counterpart
     * to detachSession()/destroySession()).
     *
     * Description: the tmux session and the server's in-memory session
     *   record both stay alive; only the browser-side WebSocket is closed,
     *   using the SAME `_intentionalClose` flag connectToSession() /
     *   reconnectToExistingSession() already set when swapping sessions,
     *   so onclose skips the "[Disconnected]" banner and the reconnect
     *   loop. `sessionActive` is deliberately left untouched (true) —
     *   unlike detach/destroy this is not an exit, it is a screen change,
     *   and the code path that runs on return (reconnectToExistingSession(),
     *   used by both the launchpad's running-session row click and
     *   App.returnToExistingTerminal()) already force-closes any stale WS
     *   and repaints fresh scrollback from the server, so leaving the
     *   socket open would cost nothing functionally — closing it here only
     *   saves battery/data while the tab sits on the launcher.
     * Inputs: none.
     * Output: void.
     * Example: called from App.goHome(), wired to #homeBtn's click handler.
     */
    pauseForHome() {
        if (this.ws) {
            try {
                this._intentionalClose = true;
                this.ws.close();
            } catch (e) {
                console.warn('Terminal: error closing WS on Home:', e);
            }
            this.ws = null;
        }
        if (this.keepaliveInterval) {
            clearInterval(this.keepaliveInterval);
            this.keepaliveInterval = null;
        }
    }

    /**
     * Insert text into terminal without pressing Enter
     * Used for slash commands
     */
    insertText(text) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('Terminal: Cannot insert text - WebSocket not connected');
            return;
        }

        // Send text to terminal without newline
        this.ws.send(new TextEncoder().encode(text));

        console.log('Terminal: Inserted text:', text);
    }

    /**
     * Update status
     */
    updateStatus(text, className) {
        if (this.statusEl) {
            this.statusEl.setAttribute('data-status', text);
            // aria-label mirrors the ::after tooltip text so screen readers
            // get the same live state a sighted hover shows.
            this.statusEl.setAttribute('aria-label', text);
            this.statusEl.className = 'status ' + className;
        }
    }
}

// Export singleton instance
window.TerminalController = new Terminal();
console.log('[Terminal Module] Exported as window.TerminalController:', window.TerminalController);
