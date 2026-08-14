// Main app bootstrap — extracted from index.html for CSP compliance (script-src 'self').

// SESSION-IDENTITY-V2 — header identity asset. Single source of truth so the
// path is editable from one spot (e.g. swap to .png on platforms without SVG).
const HEADER_BRAND_ICON_URL = '/static/assets/cloude-icon.svg';
const HEADER_BRAND_EMOJI = '☁️'; // ☁️ cloud emoji

/**
 * SESSION-IDENTITY-V2 — swap the header icon + title in one DOM operation.
 *
 * @param {{ icon: 'brand' | 'cloude', title: string }} opts
 *   icon='brand' → cloud emoji (launchpad / auth)
 *   icon='cloude' → CloudeCode brand SVG (terminal)
 *   title → text content of the title span (alongside the .version chip)
 */
function setHeaderIdentity(opts) {
    var iconEl = document.getElementById('header-icon');
    var textEl = document.getElementById('header-title-text');
    if (iconEl) {
        if (opts.icon === 'cloude') {
            // Use an <img> rather than inlining the SVG so the asset can be
            // swapped without re-editing markup, and so the browser caches it.
            iconEl.innerHTML = '<img src="' + HEADER_BRAND_ICON_URL + '" alt="" />';
        } else {
            iconEl.innerHTML = '';
            iconEl.textContent = HEADER_BRAND_EMOJI;
        }
    }
    if (textEl) {
        textEl.textContent = opts.title || 'Cloude Code';
    }
    // v0.7.2 — when we're painting a session identity (icon='cloude'),
    // make the title span itself the click target for inline rename.
    // On the launchpad / auth screens we unwire so the affordance never
    // bleeds across screen transitions.
    if (opts.icon === 'cloude') {
        _wireHeaderTitleRename();
    } else {
        _unwireHeaderTitleRename();
    }
}

/**
 * v0.7.2 — Mount a small pencil button next to ``#header-title-text`` for
 * inline rename. The button is idempotent (re-wiring does not double-mount).
 * Click handler delegates to TerminalController which owns the rename input state.
 */
function _wireHeaderTitleRename() {
    const titleEl = document.getElementById('header-title-text');
    if (!titleEl) return;
    // Drop legacy editable behavior on the title text itself
    titleEl.classList.remove('header-title-editable');
    titleEl.removeAttribute('title');
    // Mount a small pencil button next to the title (idempotent)
    let pencilEl = document.getElementById('header-rename-pencil');
    if (!pencilEl) {
        pencilEl = document.createElement('span');
        pencilEl.id = 'header-rename-pencil';
        pencilEl.className = 'header-rename-pencil';
        pencilEl.setAttribute('role', 'button');
        pencilEl.setAttribute('tabindex', '0');
        pencilEl.setAttribute('title', 'rename');
        pencilEl.textContent = '✎'; // ✎
        titleEl.insertAdjacentElement('afterend', pencilEl);
    }
    const trigger = (e) => {
        e.stopPropagation();
        if (window.TerminalController && typeof window.TerminalController._enterHeaderRename === 'function') {
            window.TerminalController._enterHeaderRename();
        }
    };
    pencilEl.onclick = trigger;
    pencilEl.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') trigger(e);
    };
}

function _unwireHeaderTitleRename() {
    const titleEl = document.getElementById('header-title-text');
    if (titleEl) {
        titleEl.classList.remove('header-title-editable');
        titleEl.removeAttribute('title');
        titleEl.onclick = null;
    }
    const pencilEl = document.getElementById('header-rename-pencil');
    if (pencilEl && pencilEl.parentNode) pencilEl.parentNode.removeChild(pencilEl);
}

/**
 * v0.7.1 — Browser tab title sync.
 *
 * The page title reflects whichever session is active for the user's
 * current screen. On the launchpad / auth screens it falls back to the
 * brand. On the terminal screen we use ``<name> — Cloude Code`` so the
 * window title in a multi-tab browser is identifiable at a glance
 * (matches the convention used by VS Code, IntelliJ, etc.).
 *
 * Called from:
 *   - showTerminal / returnToExistingTerminal — paint session name
 *   - showLaunchpad — clear back to brand
 *   - terminal.js WS handler on session.renamed — live-update for the
 *     attached session
 *
 * @param {?string} sessionName  Session name or null/empty to reset.
 */
function setPageTitle(sessionName) {
    var brand = 'Cloude Code';
    if (sessionName && String(sessionName).trim()) {
        document.title = String(sessionName).trim() + ' — ' + brand;
    } else {
        document.title = brand;
    }
}
// Expose so terminal.js's WS message handler can call it without
// reaching into the app instance.
window.setPageTitle = setPageTitle;

/**
 * App Controller - Manages application state and screen transitions
 */
class AppController {
    /**
     * Inline SVG markup for the two states of the header audio toggle.
     * Single source of truth so `_wireAudioToggle()`'s paint() never has
     * more than one place that decides what the icon looks like. 16x16,
     * stroke="currentColor", stroke-width 1.5 — same conventions as the
     * detach/logout/delete icons so the header reads as one icon family.
     * Speaker shape is shared; unmuted adds two sound-wave arcs, muted
     * adds an X across the same spot — same silhouette, different
     * "sound coming out" mark, so the two states are unmistakable at
     * 16x16 without relying on color alone.
     * @type {{muted: string, unmuted: string}}
     */
    static get AUDIO_ICON_SVG() {
        return {
            muted:
                '<path d="M6.25 5.25L3.5 7.35H2V9.15H3.5L6.25 11.25V5.25Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
                '<path d="M9.5 6.25L13 9.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                '<path d="M13 6.25L9.5 9.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
            unmuted:
                '<path d="M6.25 5.25L3.5 7.35H2V9.15H3.5L6.25 11.25V5.25Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
                '<path d="M9 6.6C9.5 7 9.8 7.45 9.8 8C9.8 8.55 9.5 9 9 9.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                '<path d="M10.8 5.2C11.7 6 12.2 6.9 12.2 8C12.2 9.1 11.7 10 10.8 10.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        };
    }

    constructor() {
        this.currentScreen = null;
        this.logoutBtn = null;
        // No destroyBtn: delete is no longer reachable from the session
        // header (see the conversation sidebar + launcher rows instead).
        this.detachBtn = null;
        // Home: go back to the launcher without touching the session
        // (see goHome()). Same visibility wiring as detachBtn.
        this.homeBtn = null;
        // Health poller state. Poll every 15s against /health so the
        // top-right status dot reflects server reachability on the
        // auth + launchpad screens. The terminal screen manages the
        // same dot via its WS updateStatus() calls, so the poller
        // yields whenever currentScreen === 'terminal'.
        this._healthPollerInterval = null;
    }

    /**
     * Initialize application
     */
    async init() {
        console.log('App: Initializing');

        this.logoutBtn = document.getElementById('logoutBtn');
        this.detachBtn = document.getElementById('detachSessionBtn');
        this.homeBtn = document.getElementById('homeBtn');

        // Phase 2: paint persisted theme id onto <html> SYNCHRONOUSLY before
        // any async work — kills FOUC for repeat visitors. The full manifest
        // (cssVars + xterm) loads post-auth via Themes.init() below; until
        // then the :root defaults from styles.css already render claude.
        if (window.Themes && typeof window.Themes.applyStoredThemeIdSync === 'function') {
            try { window.Themes.applyStoredThemeIdSync(); } catch (_) { /* no-op */ }
        }

        // v0.7.0+ — initialize per-theme background-music plumbing and wire
        // the header 🔊 / 🔇 toggle button. Default state is muted; the first
        // click is the user-gesture that grants AudioContext autoplay.
        if (window.ThemeAudio && typeof window.ThemeAudio.init === 'function') {
            try { window.ThemeAudio.init(); } catch (_) { /* no-op */ }
        }
        this._wireAudioToggle();

        // Setup event listeners
        this.setupEventListeners();

        // Initialize auth module (always needed first)
        window.Auth.init();

        // Kick off server health polling before auth resolves — the
        // /health endpoint is unauthenticated, so the dot works on the
        // auth screen too.
        this._startHealthPoller();

        // Check if user is authenticated
        if (window.Auth.isAuthenticated()) {
            console.log('App: User has token, verifying...');
            const isValid = await window.Auth.verifyToken();
            if (isValid) {
                // Phase 2: load full theme manifests + mount selector BEFORE
                // launchpad render or any deep-link resolves. Failure here is
                // non-fatal — registry has its own claude fallback.
                await this._initThemes();
                this.showLaunchpad();
            } else {
                console.log('App: Token invalid, showing auth');
                this.showAuth();
            }
        } else {
            console.log('App: No token, showing auth');
            this.showAuth();
        }
    }

    /**
     * Phase 2: bring up the theme registry and mount the header selector.
     * Called post-auth so the manifest fetch goes through with a valid
     * Bearer token. Idempotent — safe to call again on re-auth.
     */
    async _initThemes() {
        if (!window.Themes) return;
        try {
            await window.Themes.init();
        } catch (e) {
            console.warn('App: Themes.init failed — registry will use fallback', e);
        }
        try {
            const controls = document.querySelector('.header .controls');
            if (controls && window.ThemeSelector) {
                window.ThemeSelector.mount(controls);
            }
        } catch (e) {
            console.warn('App: ThemeSelector.mount failed', e);
        }
    }

    /**
     * v0.7.0+ — bind the header audio toggle button to ThemeAudio.toggleMute().
     * The icon (speaker+waves / speaker+X), `aria-pressed`, and tooltip all
     * reflect the current mute state. Idempotent — only wires once.
     *
     * The icon is inline SVG, not an emoji: emoji render in full system
     * color from the platform font and ignore `stroke="currentColor"`,
     * which broke the otherwise-monotone header icon family (detach,
     * logout, delete all inherit their color from the theme). Swapping
     * the toggled `<svg>` child to one of AppController.AUDIO_ICON_SVG keeps this
     * button in the same 16x16 / stroke-1.5 / currentColor family as its
     * neighbors — there is no code path left that writes an emoji here.
     */
    _wireAudioToggle() {
        const btn = document.getElementById('audioToggleBtn');
        if (!btn || btn._audioToggleWired) return;
        btn._audioToggleWired = true;
        // The <svg> wrapper itself lives in index.html (viewBox, size,
        // fill="none") — only its <path> children are swapped here, so
        // we never touch the button's own attributes (title/aria-label
        // are set separately below) or risk emitting a bare <path> as a
        // direct button child (invalid outside an <svg> namespace).
        const svg = btn.querySelector('svg');

        const paint = () => {
            const muted = window.ThemeAudio ? window.ThemeAudio.isMuted() : true;
            const label = muted ? 'Enable theme music' : 'Mute theme music';
            if (svg) {
                svg.innerHTML = muted
                    ? AppController.AUDIO_ICON_SVG.muted
                    : AppController.AUDIO_ICON_SVG.unmuted;
            }
            btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
            btn.setAttribute('data-tooltip', label);
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
        };
        paint();

        btn.addEventListener('click', () => {
            if (!window.ThemeAudio) return;
            try { window.ThemeAudio.toggleMute(); } catch (e) {
                console.warn('App: ThemeAudio.toggleMute threw', e);
            }
            paint();
        });
    }

    /**
     * Start the server-health poller. Idempotent — safe to call more
     * than once. Fires an initial probe immediately, then every 15s.
     */
    _startHealthPoller() {
        if (this._healthPollerInterval) return;
        this._healthPollerInterval = setInterval(() => this._pollHealth(), 15000);
        this._pollHealth();
    }

    /**
     * Probe GET /health and paint the top-right status dot.
     *
     * States:
     *   - green (.connected): HTTP 200
     *   - red (.error):       network error, timeout, or non-2xx
     *   - orange (default):   initial state before first probe
     *
     * Yields to the terminal screen's WS updateStatus() by returning
     * early when currentScreen === 'terminal' — otherwise the 15s
     * tick would clobber the live WS status (e.g. "Connected").
     */
    async _pollHealth() {
        if (this.currentScreen === 'terminal') return;
        const statusEl = document.getElementById('statusText');
        if (!statusEl) return;
        try {
            const r = await fetch('/health', { method: 'GET', cache: 'no-store' });
            let text;
            if (r.ok) {
                statusEl.className = 'status connected';
                text = 'server OK';
            } else {
                statusEl.className = 'status error';
                text = `server error · HTTP ${r.status}`;
            }
            statusEl.setAttribute('data-status', text);
            // aria-label mirrors the ::after tooltip text so screen readers
            // get the same live state a sighted hover shows.
            statusEl.setAttribute('aria-label', text);
        } catch (err) {
            statusEl.className = 'status error';
            const text = `server unreachable · ${err && err.message ? err.message : err}`;
            statusEl.setAttribute('data-status', text);
            statusEl.setAttribute('aria-label', text);
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Auth events
        window.addEventListener('authenticated', () => {
            console.log('App: User authenticated');
            // Bring up the theme registry post-auth (for the TOTP-flow path
            // that doesn't go through init()'s `if (verifyToken())` branch).
            this._initThemes().finally(() => this.showLaunchpad());
        });

        window.addEventListener('auth-required', () => {
            console.log('App: Auth required');
            this.showAuth();
        });

        window.addEventListener('logged-out', () => {
            console.log('App: User logged out');
            this.showAuth();
        });

        // Session events. The `detail` payload may include adopt-path
        // extras (`initialScrollbackB64`, `fifoStartOffset`) when the
        // launchpad dispatched after adopting an external session —
        // forward the whole thing so showTerminal() can plumb to the
        // terminal controller's connectToSession() opts.
        window.addEventListener('session-created', (e) => {
            console.log('App: Session created', e.detail);
            this.showTerminal(e.detail.session, {
                initialScrollbackB64: e.detail.initialScrollbackB64,
                fifoStartOffset: e.detail.fifoStartOffset,
            });
        });

        window.addEventListener('session-destroyed', () => {
            console.log('App: Session destroyed');
            this.showLaunchpad();
        });

        // Title click - navigate back to launchpad (only from terminal)
        const appTitle = document.getElementById('appTitle');
        appTitle.addEventListener('click', () => {
            if (this.currentScreen === 'terminal') {
                console.log('App: Title clicked, navigating to launchpad');
                this.showLaunchpad();
            }
        });

        // Home button - same "leave without touching the session"
        // navigation as the title click above, wired separately so it has
        // its own visible, tappable affordance (the title click has no
        // visual cue and is useless on a phone).
        if (this.homeBtn) {
            this.homeBtn.addEventListener('click', () => this.goHome());
        }
    }

    /**
     * Home: return to the launcher while leaving the current session
     * fully attached and running server-side.
     *
     * Description: never calls API.detachSession() or destroySession(),
     *   and never touches TerminalController.sessionActive — the session
     *   stays adopted on the server exactly as if the user had done
     *   nothing, so it keeps appearing in GET /sessions/list (not just
     *   /attachable) and clicking its launcher row reconnects immediately
     *   via TerminalController.reconnectToExistingSession(), the same
     *   path the launcher's existing "return to running session" row
     *   click already uses. Closes the browser-side WebSocket first (via
     *   TerminalController.pauseForHome()) purely to save battery/data
     *   while the session sits unattended on the launcher screen — the
     *   return path force-closes and reopens the socket regardless, so
     *   this costs nothing functionally on re-entry. No confirmation: this
     *   is pure navigation, not a destructive action.
     * Inputs: none.
     * Output: void. No-op if not currently on the terminal screen (the
     *   button is hidden everywhere else, but this guards direct calls).
     */
    goHome() {
        if (this.currentScreen !== 'terminal') return;
        console.log('App: Home clicked, returning to launcher (session stays attached)');
        if (window.TerminalController && typeof window.TerminalController.pauseForHome === 'function') {
            window.TerminalController.pauseForHome();
        }
        this.showLaunchpad();
    }

    /**
     * Show auth screen
     */
    showAuth() {
        console.log('App: Showing auth screen');
        this.hideAllScreens();
        document.getElementById('auth-screen').classList.add('active');
        this.logoutBtn.classList.add('hidden');
        if (this.detachBtn) this.detachBtn.classList.add('hidden');
        if (this.homeBtn) this.homeBtn.classList.add('hidden');
        if (window.SessionSidebar) window.SessionSidebar.hide();
        this.currentScreen = 'auth';
        // Leaving the terminal: drop any session-scoped theme so xterm
        // and the terminal screen revert to the global theme on next entry.
        if (window.Themes && typeof window.Themes.clearSession === 'function') {
            window.Themes.clearSession();
        }
        // SESSION-IDENTITY-V2 — clear active-session pin scope and restore
        // the user's global localStorage theme + brand identity.
        if (window.Themes) {
            if (typeof window.Themes.setActiveSession === 'function') {
                window.Themes.setActiveSession(null);
            }
            if (typeof window.Themes.applyTheme === 'function') {
                var stored = null;
                try { stored = localStorage.getItem('cloude.theme'); } catch (_) { /* ignore */ }
                window.Themes.applyTheme(stored || 'claude', { persist: false });
            }
        }
        setHeaderIdentity({ icon: 'brand', title: 'Cloude Code' });
        // v0.7.1 — auth screen has no session context; reset tab title.
        setPageTitle(null);
        // Outbound URL sync: no session context on the auth screen either.
        if (window.Router && typeof window.Router.resetToLauncher === 'function') {
            window.Router.resetToLauncher();
        }
    }

    /**
     * Show launchpad screen
     */
    showLaunchpad() {
        console.log('App: Showing launchpad screen');
        this.hideAllScreens();
        document.getElementById('launchpad-screen').classList.add('active');
        this.logoutBtn.classList.remove('hidden');
        if (this.detachBtn) this.detachBtn.classList.add('hidden');
        if (this.homeBtn) this.homeBtn.classList.add('hidden');
        if (window.SessionSidebar) window.SessionSidebar.hide();
        this.currentScreen = 'launchpad';
        // Leaving the terminal: drop the session theme so the launchpad
        // chrome renders under pure global-theme rules and so the next
        // session entry re-applies cleanly from a known baseline.
        if (window.Themes && typeof window.Themes.clearSession === 'function') {
            window.Themes.clearSession();
        }
        // SESSION-IDENTITY-V2 — leave per-session pin scope and restore
        // the global localStorage theme + brand identity on the launchpad.
        if (window.Themes) {
            if (typeof window.Themes.setActiveSession === 'function') {
                window.Themes.setActiveSession(null);
            }
            if (typeof window.Themes.applyTheme === 'function') {
                var stored = null;
                try { stored = localStorage.getItem('cloude.theme'); } catch (_) { /* ignore */ }
                window.Themes.applyTheme(stored || 'claude', { persist: false });
            }
        }
        setHeaderIdentity({ icon: 'brand', title: 'Cloude Code' });
        // v0.7.1 — back on the launchpad, no active session; reset tab title.
        setPageTitle(null);
        // Outbound URL sync: leaving a session (detach/delete) or just
        // navigating here resets the address bar to `/` so a refresh
        // lands on the launcher, not a stale/gone session URL. No-ops if
        // a deep-link target is still pending delivery — see
        // Router.resetToLauncher()'s doc comment.
        if (window.Router && typeof window.Router.resetToLauncher === 'function') {
            window.Router.resetToLauncher();
        }

        // Hide D-pad on launchpad
        if (window.DPad) {
            window.DPad.hide();
        }

        // Hide slash command button on launchpad
        if (window.SlashCommandsModal) {
            window.SlashCommandsModal.hide();
        }

        // Initialize launchpad if first time
        if (!window.Launchpad.launchpadScreen) {
            window.Launchpad.init();
        }

        // Reload projects
        window.Launchpad.loadProjects();
    }

    /**
     * Show terminal screen
     * @param {object} session - Session data from the backend
     * @param {object} [opts]
     * @param {string} [opts.initialScrollbackB64] - Adopt-path: base64
     *   scrollback bytes to paint into xterm before the WS opens.
     * @param {number} [opts.fifoStartOffset] - Adopt-path: fifo byte
     *   offset the server's tailer will start from. Passed through for
     *   symmetry/logging; not directly consumed by the client.
     */
    async showTerminal(session, opts = {}) {
        console.log('App: Showing terminal screen');
        // Outbound URL sync: capture whether we were ALREADY viewing a
        // session before this call flips currentScreen below. Deciding
        // push-vs-replace off the PREVIOUS screen is what tells "entering
        // a session from the launcher" (push — Back should return to the
        // launcher) apart from "switching to a different session while
        // already in one" (replace — the sidebar's adopt-not-yet-
        // attached flow calls showTerminal() too; we don't want Back to
        // have to click through every session the user visited).
        var cameFromTerminal = this.currentScreen === 'terminal';
        this.hideAllScreens();
        document.getElementById('terminal-screen').classList.add('active');
        this.logoutBtn.classList.remove('hidden');
        if (this.detachBtn) this.detachBtn.classList.remove('hidden');
        if (this.homeBtn) this.homeBtn.classList.remove('hidden');
        this.currentScreen = 'terminal';

        // SESSION-IDENTITY-V2 — enter per-session theme scope. Subsequent
        // ThemeSelector swaps will PATCH the server-side pin instead of
        // writing localStorage. Use tmux_session (canonical bare tmux name) or
        // session.name. Do NOT fall through to session.id — that's
        // "adopted:<name>" for adopted sessions, which the backend rejects
        // and causes the PATCH to 404, silently breaking pin persistence.
        var sessionName = (session && (session.tmux_session || session.name)) || null;
        if (window.Themes && typeof window.Themes.setActiveSession === 'function') {
            window.Themes.setActiveSession(sessionName);
        }
        // Outbound URL sync: reuses Router's SAME slug/encoding scheme
        // build_deep_link() (server) and parseCurrentPath() (inbound
        // router) already use — see Router.enterSession()'s doc comment
        // and _deepLinkSlug()'s below for why the name gets stripped
        // first.
        this._syncSessionUrl(sessionName, cameFromTerminal);
        // Session sidebar: reveal the hamburger and tell it which session
        // is now attached (so its row list can mark this one active).
        if (window.SessionSidebar) {
            window.SessionSidebar.show();
            window.SessionSidebar.setActiveSession(session && session.id, sessionName);
        }
        // If a pinned theme came back on the session payload, paint it WITHOUT
        // persisting (server is already authoritative on the pin). forXterm:true
        // forces the xterm repaint regardless of activeSessionAgent ordering —
        // the freshly-attached session must immediately have its terminal
        // palette styled (not just the page chrome).
        if (session && session.pinned_theme && window.Themes
            && typeof window.Themes.applyTheme === 'function') {
            window.Themes.applyTheme(session.pinned_theme, { persist: false, forXterm: true });
        }
        // Header identity: brand icon + session name as title.
        setHeaderIdentity({
            icon: 'cloude',
            title: sessionName || 'session'
        });
        // v0.7.1 — reflect the attached session in the browser tab title.
        setPageTitle(sessionName);

        // Phase 4-5: scope the terminal screen + xterm palette to this
        // session's agent theme. If session.agent_type is null/undefined
        // (Phase 6 hasn't shipped yet, or the agent is unknown to the
        // theme registry), applySession() falls through to clearSession()
        // — meaning the global theme also rules the terminal. That's the
        // desired fallback: no flicker, no broken-state.
        if (window.Themes && typeof window.Themes.applySession === 'function') {
            window.Themes.applySession(session && session.agent_type);
        }

        // Initialize terminal if first time
        if (!window.TerminalController.term) {
            await window.TerminalController.init();
        }

        // Initialize D-pad (mobile only)
        if (window.DPad && !window.DPad.floatingButton) {
            window.DPad.init();
        }

        // Show D-pad on terminal screen
        if (window.DPad) {
            window.DPad.show();
        }

        // Initialize slash commands modal
        if (window.SlashCommandsModal && !window.SlashCommandsModal.button) {
            await window.SlashCommandsModal.init((command) => {
                // Insert command into terminal without Enter
                window.TerminalController.insertText(command);
            }, session && session.working_dir);
        }

        // Show slash command button on terminal screen
        if (window.SlashCommandsModal) {
            window.SlashCommandsModal.show();
        }

        // Connect terminal to session. Adopt-path opts (scrollback,
        // fifo offset) are forwarded through — a plain new-session
        // create leaves them undefined and connectToSession treats
        // that as a normal (non-adopt) path.
        window.TerminalController.connectToSession(session, opts);
    }

    /**
     * Return to an ALREADY-ACTIVE terminal session without creating or
     * adopting anything. Used by the launchpad's active-session banner
     * when the user clicks "return to terminal" after navigating away
     * via the logo.
     *
     * The screen-transition side of this mirrors showTerminal() exactly
     * (so D-pad/slash-commands/header buttons land in the same state),
     * but the terminal-controller side calls reconnectToExistingSession
     * instead of connectToSession — the backend is already alive and a
     * POST /sessions would either error (single-session invariant) or
     * silently birth a new unrelated pane.
     *
     * @param {object} session - Session object (from GET /sessions).
     */
    async returnToExistingTerminal(session) {
        console.log('App: Returning to existing terminal', session && session.id);
        // Outbound URL sync: see showTerminal()'s identical comment —
        // same push-vs-replace rule, off the screen we were on BEFORE
        // this call. Callers: the launchpad's active-session banner
        // (currentScreen 'launchpad' → push) and the conversation
        // sidebar's row click (currentScreen already 'terminal' →
        // replace, since the sidebar only shows while in a session).
        var cameFromTerminal = this.currentScreen === 'terminal';
        this.hideAllScreens();
        document.getElementById('terminal-screen').classList.add('active');
        this.logoutBtn.classList.remove('hidden');
        if (this.detachBtn) this.detachBtn.classList.remove('hidden');
        if (this.homeBtn) this.homeBtn.classList.remove('hidden');
        this.currentScreen = 'terminal';

        // SESSION-IDENTITY-V2 — same wiring as showTerminal(). The session
        // arg here is typically a SessionInfo (carries tmux_session +
        // pinned_theme at the top level); fall back to nested .session for
        // older callers that pass the inner Session row.
        var inner = (session && session.session) ? session.session : session;
        var sessionName = (session && (session.tmux_session || session.name))
            || (inner && (inner.tmux_session || inner.name))
            || null;
        var pinnedTheme = (session && session.pinned_theme)
            || (inner && inner.pinned_theme)
            || null;
        if (window.Themes && typeof window.Themes.setActiveSession === 'function') {
            window.Themes.setActiveSession(sessionName);
        }
        // Outbound URL sync: same encoding Router.enterSession() shares
        // with build_deep_link() (server) and the inbound router parser.
        this._syncSessionUrl(sessionName, cameFromTerminal);
        // Session sidebar: same wiring as showTerminal().
        if (window.SessionSidebar) {
            var activeSid = (inner && inner.id) || (session && session.id) || null;
            window.SessionSidebar.show();
            window.SessionSidebar.setActiveSession(activeSid, sessionName);
        }
        if (pinnedTheme && window.Themes && typeof window.Themes.applyTheme === 'function') {
            // forXterm:true — see showTerminal() for rationale. Re-entry to an
            // already-running session must immediately repaint the xterm pane,
            // not just page chrome.
            window.Themes.applyTheme(pinnedTheme, { persist: false, forXterm: true });
        }
        setHeaderIdentity({
            icon: 'cloude',
            title: sessionName || 'session'
        });
        // v0.7.1 — sync browser tab title to the re-entered session.
        setPageTitle(sessionName);

        // Phase 4-5: re-scope to the session's theme on re-entry. Same
        // null-tolerant semantics as showTerminal() — agent_type may be
        // missing in pre-Phase-6 builds; registry handles the fallback.
        var agentType = (session && session.agent_type)
            || (inner && inner.agent_type)
            || null;
        if (window.Themes && typeof window.Themes.applySession === 'function') {
            window.Themes.applySession(agentType);
        }

        // First-time init if the user never hit showTerminal() this page load
        // (e.g. refreshed directly onto launchpad while session was running).
        if (!window.TerminalController.term) {
            await window.TerminalController.init();
        }
        if (window.DPad && !window.DPad.floatingButton) {
            window.DPad.init();
        }
        if (window.DPad) {
            window.DPad.show();
        }
        if (window.SlashCommandsModal && !window.SlashCommandsModal.button) {
            await window.SlashCommandsModal.init((command) => {
                window.TerminalController.insertText(command);
            }, session && session.working_dir);
        }
        if (window.SlashCommandsModal) {
            window.SlashCommandsModal.show();
        }

        window.TerminalController.reconnectToExistingSession(session);
    }

    /**
     * Hide all screens
     */
    hideAllScreens() {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
    }

    /**
     * Logout
     */
    async logout() {
        // Show confirmation modal
        const confirmed = await this.showConfirmModal(
            'logout',
            'are you sure you want to logout?',
            'any active session will be destroyed.'
        );

        if (confirmed) {
            // Destroy active session if exists
            if (window.TerminalController.sessionActive) {
                try {
                    await window.TerminalController.destroySession();
                } catch (error) {
                    console.error('App: Error destroying session during logout:', error);
                }
            }

            // Logout
            window.Auth.logout();
        }
    }

    /**
     * Show confirmation modal.
     *
     * This is the SINGLE confirmation-modal implementation for the whole
     * app — every destructive action (logout, delete session, delete
     * project, kill running session, reset server) routes through this
     * one function so there is exactly one modal to read, style, and
     * test. `LaunchpadController.showConfirmModal()` is a thin delegate
     * to this method, kept only so existing launchpad call sites don't
     * need to reach across modules.
     *
     * Description: builds a modal overlay with title/message/optional
     *   details and two buttons, and resolves once the user picks one
     *   or dismisses it. Escape, the cancel button, and a click on the
     *   overlay backdrop are all treated as cancel — every dismissal
     *   path resolves false, never true, so a destructive action can
     *   only fire from an explicit confirm click.
     * Inputs:
     *   title (string) - modal title, shown as "» <title>".
     *   message (string) - main message body.
     *   details (string|null) - optional secondary line (e.g. "this
     *     cannot be undone").
     *   primaryLabel (string) - label for the confirming button.
     *   secondaryLabel (string) - label for the cancelling button.
     * Output: Promise<boolean> - true only on an explicit confirm click.
     *
     * Security: title/message/details are attacker-reachable in some
     * callers (e.g. an interpolated session or project name that
     * ultimately traces back to hand-edited config or a tmux name) —
     * escaped here, once, at the shared sink, rather than trusting every
     * caller to pre-escape its own interpolated values.
     */
    showConfirmModal(title, message, details = null, primaryLabel = 'confirm', secondaryLabel = 'cancel') {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const safeTitle = this._escapeHtml(title);
            const safeMessage = this._escapeHtml(message);
            const safeDetails = details ? this._escapeHtml(details) : null;

            // Create modal content
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» ${safeTitle}</div>
                    <div class="modal-body">
                        <div class="modal-message">${safeMessage}</div>
                        ${safeDetails ? `<div class="modal-description">${safeDetails}</div>` : ''}
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="modal-cancel">${this._escapeHtml(secondaryLabel)}</button>
                        <button class="modal-btn modal-btn-primary" id="modal-confirm">${this._escapeHtml(primaryLabel)}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const confirmBtn = overlay.querySelector('#modal-confirm');
            const cancelBtn = overlay.querySelector('#modal-cancel');

            // Handle Escape key
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            });

            // Handle confirm button
            confirmBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(true);
            });

            // Handle cancel button
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(false);
            });

            // Handle click outside modal
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            });

            // Focus confirm button
            setTimeout(() => confirmBtn.focus(), 100);
        });
    }

    /**
     * Update the address bar to reflect the session now on screen (the
     * outbound half of the deep-link feature — see router.js's
     * `enterSession()`/`buildSessionPath()` for the inbound half this
     * reuses).
     *
     * Description: `sessionName` is the canonical `tmux_session` value,
     *   which for a Cloude-owned session carries the `cloude_` prefix
     *   (`src/core/tmux_backend.py`'s `SESSION_PREFIX`) — but the
     *   deep-link resolver (`Launchpad.openProjectByName`) matches
     *   against the launcher's PROJECT name, which is always stored
     *   WITHOUT that prefix (see `Launchpad._handleAttachRunningSession`'s
     *   `cleanName` stripping when it auto-adds an adopted session to
     *   Recent Projects). Stripping here — via the launchpad's own
     *   `_deriveRunningSessionDisplayName()`, reused rather than
     *   re-implemented — is what makes a hard refresh on the resulting
     *   URL actually resolve back to the same project; skipping it would
     *   put `cloude_<name>` in the address bar, which
     *   `openProjectByName()` would never match against any project's
     *   bare `name` and the refresh would silently land on the launcher
     *   instead.
     * Inputs:
     *   sessionName (string|null) - tmux_session (or bare name) for the
     *     session now on screen. No-op if falsy.
     *   replace (boolean) - forwarded to Router.enterSession() as
     *     `{replace}` — see showTerminal()/returnToExistingTerminal()'s
     *     `cameFromTerminal` comment for the push-vs-replace reasoning.
     * Output: void.
     */
    _syncSessionUrl(sessionName, replace) {
        if (!sessionName || !window.Router || typeof window.Router.enterSession !== 'function') {
            return;
        }
        var slug = (window.Launchpad && typeof window.Launchpad._deriveRunningSessionDisplayName === 'function')
            ? window.Launchpad._deriveRunningSessionDisplayName(sessionName)
            : sessionName;
        window.Router.enterSession(slug, { replace: !!replace });
    }

    /**
     * Escape HTML special characters for safe interpolation into modal
     * markup built via innerHTML.
     * Inputs: str (any) - value to escape; stringified first.
     * Output: string - HTML-escaped text.
     */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }
}

// Create app instance
const App = new AppController();
// Expose on window so other modules (launchpad active-session banner,
// future deep-link targets) can call App.returnToExistingTerminal
// without re-wiring via custom events.
window.App = App;

// Initialize on load
window.addEventListener('load', () => {
    App.init();
    // Item 9: kick off deep-link router AFTER App.init() so the
    // auth state is already being resolved. router.js listens
    // for the `authenticated` event to deliver stashed targets.
    if (window.Router && typeof window.Router.init === 'function') {
        window.Router.init();
    }
});
