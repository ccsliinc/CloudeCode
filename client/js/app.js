// Main app bootstrap — extracted from index.html for CSP compliance (script-src 'self').

// SESSION-IDENTITY-V2 — header identity asset. Single source of truth so the
// path is editable from one spot (e.g. swap to .png on platforms without SVG).
const HEADER_BRAND_ICON_URL = '/static/assets/cloude-icon.svg';
const HEADER_BRAND_EMOJI = '☁️'; // ☁️ cloud emoji

/**
 * SESSION-IDENTITY-V2 — swap the header icon + title in one DOM operation.
 *
 * @param {{ icon: 'brand' | 'cloude', title: string, subheader?: string|null }} opts
 *   icon='brand' → cloud emoji (launchpad / auth)
 *   icon='cloude' → CloudeCode brand SVG (terminal)
 *   title → text content of the title span (alongside the .version chip)
 *   subheader → HOME-HEADER-CONSOLIDATION: when present, the header grows a
 *     second row under `.header-row` carrying this text, and `.header-row`
 *     (the wrapper around toggle/title/controls — see its CSS comment)
 *     switches to the `.header--home` grid layout so the title is
 *     genuinely centred regardless of `.controls` width. Omitted/null on
 *     every other screen, which removes the row and reverts to the plain
 *     flex layout. Only the launchpad screen passes this — see
 *     showLaunchpad() below.
 */
function setHeaderIdentity(opts) {
    var iconEl = document.getElementById('header-icon');
    var textEl = document.getElementById('header-title-text');
    // `.header--home` is applied to `.header-row`, NOT `.header` itself —
    // `#home-subheader` must stay OUTSIDE the element h1's own
    // header-title-fit.js measures its siblings against, or its
    // full-width second row gets subtracted from the title's shrink
    // budget and silently truncates it mid-word. See `.header-row`'s CSS
    // comment for the incident this fixed.
    var headerRowEl = document.querySelector('.header-row');
    var subheaderEl = document.getElementById('home-subheader');
    if (headerRowEl && subheaderEl) {
        if (opts.subheader) {
            headerRowEl.classList.add('header--home');
            // DELIBERATELY A DIFFERENT CLASS NAME from the one on
            // .header-row, not a duplicate. `.header--home { display: grid }`
            // in styles.css is a bare class selector — it matches ANY
            // element carrying that class. Reusing the exact same name on
            // <body> once made the whole page body a grid container
            // instead of a flex column (bodyDisplay: 'grid', header
            // collapsed to grid-content width ~517px instead of 1280px —
            // caught by the Playwright measurement harness).
            // `home-header-active` exists purely so
            // --home-subheader-extra (styles.css) reaches --header-h
            // consumers outside .header, e.g. .fab-menu-notice. Keep this
            // toggle in lockstep with the .header-row one above.
            document.body.classList.add('home-header-active');
            subheaderEl.textContent = opts.subheader;
            subheaderEl.hidden = false;
        } else {
            headerRowEl.classList.remove('header--home');
            document.body.classList.remove('home-header-active');
            subheaderEl.hidden = true;
        }
    }
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
        // Route through HeaderTitleFit so a long session name is
        // MIDDLE-elided (keeping the distinguishing tail) rather than
        // end-truncated by CSS. Falls back to a plain write when the
        // module is absent - the CSS ellipsis still prevents overflow.
        var fullTitle = opts.title || 'Cloude Code';
        if (window.HeaderTitleFit) {
            window.HeaderTitleFit.setTitle(fullTitle);
        } else {
            textEl.textContent = fullTitle;
        }
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
    constructor() {
        this.currentScreen = null;
        this.logoutBtn = null;
        // No destroyBtn: delete is no longer reachable from the session
        // header (see the conversation sidebar + launcher rows instead).
        // NO detachBtn either. Detach moved into the session editor FAB
        // (session-editor-menu.js): it acts on the SESSION, so it belongs
        // with the session-scoped control, not in the app-scoped header
        // that also mounts on the launchpad where there is no session.
        // NO homeBtn. Clicking #appTitle is the one home control; see
        // the DismissGuard wiring in _wireControls() and goHome().
        // Settings gear — visible whenever authenticated (launchpad AND
        // terminal), hidden pre-auth. Same visibility wiring as
        // logoutBtn, not gated to a single screen.
        this.settingsBtn = null;
        // Claude-config editor button — same always-visible-when-authenticated
        // wiring as settingsBtn (config applies whether or not a session
        // is open).
        this.configEditorBtn = null;
        // Health poller state. Poll every 15s against /health so the
        // top-right status dot reflects server reachability on the
        // auth + launchpad screens. The terminal screen manages the
        // same dot via its WS updateStatus() calls, so the poller
        // yields whenever currentScreen === 'terminal'.
        this._healthPollerInterval = null;
        // MutationObserver mirroring #statusText's data-status into the
        // home bar's label. Created once, in _observeStatusText().
        this._statusTextObserver = null;
    }

    /**
     * Move the ONE connection-light node to the screen that is showing.
     *
     * WHY MOVE AND NOT CLONE: `#statusText` is written by id from two
     * places (this class's `_pollHealth()` and TerminalController's
     * `updateStatus()`). A second copy would need a second writer and
     * would drift, which is the same reasoning header-menu.js records for
     * re-parenting header controls instead of mirroring them.
     *
     * THE LIGHT IS NEVER IN THE HEADER. It used to return to
     * `.header .controls` on the auth and terminal screens; it does not
     * any more. The header row is actions, the light is state, and the
     * rule is "the light lives in the screen's bottom furniture, or
     * nowhere".
     *
     * HOME SCREEN: into `#home-bar-status` in `.home-bar`, beside a
     * visible text label - the light is app-scoped state and the bar has
     * the room to say what it means.
     *
     * TERMINAL SCREEN: into `#terminal-status-bar`, a small fixed chip
     * pinned to the bottom-left corner - clear of the FAB column on the
     * right, so it does not read as a third icon stacked under the
     * session tools. The terminal screen has no full bottom bar by
     * construction (it is not paying vertical space back for chrome), but
     * mid-session is exactly when a dropped socket matters most, so the
     * light gets this minimal bar of its own rather than disappearing.
     * `position: fixed` means it still costs zero vertical layout space.
     *
     * AUTH SCREEN: also parked in `#terminal-status-bar`, which
     * terminal-tools.css hides on that screen. No bar, no light - the
     * stated rule, applied honestly. The auth screen reports its own
     * failures inline.
     *
     * @param {'auth'|'launchpad'|'terminal'} screen - Screen being shown.
     * @returns {void}
     */
    _placeStatusLight(screen) {
        const el = document.getElementById('statusText');
        if (!el) return;
        const target = screen === 'launchpad'
            ? document.getElementById('home-bar-status')
            : document.getElementById('terminal-status-bar');
        if (!target || el.parentElement === target) return;
        if (screen === 'launchpad') {
            // Before the label span, so the dot leads the pair.
            target.insertBefore(el, target.firstChild);
        } else {
            target.appendChild(el);
        }
        this._syncStatusLabel();
    }

    /**
     * Copy `#statusText`'s current `data-status` into the home bar label.
     *
     * The attribute stays the single source of truth; this only renders
     * it somewhere a touch user can read without hovering.
     *
     * @returns {void}
     */
    _syncStatusLabel() {
        const label = document.getElementById('home-bar-status-text');
        if (!label) return;
        const el = document.getElementById('statusText');
        label.textContent = el ? (el.getAttribute('data-status') || '') : '';
    }

    /**
     * Watch `#statusText` so the home bar label can never go stale.
     *
     * An observer rather than a call added to each writer: there are two
     * writers today (`_pollHealth()` here and TerminalController's
     * `updateStatus()`) and the next one would have to remember. Watching
     * the attribute means the label follows whoever wrote it.
     *
     * @returns {void}
     */
    _observeStatusText() {
        if (this._statusTextObserver) return;
        const el = document.getElementById('statusText');
        if (!el || typeof MutationObserver !== 'function') return;
        this._statusTextObserver = new MutationObserver(() => this._syncStatusLabel());
        this._statusTextObserver.observe(el, { attributes: true, attributeFilter: ['data-status'] });
    }

    /**
     * Initialize application
     */
    async init() {
        console.log('App: Initializing');

        this.logoutBtn = document.getElementById('logoutBtn');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.configEditorBtn = document.getElementById('configEditorBtn');
        this._observeStatusText();

        // Phase 2: paint persisted theme id onto <html> SYNCHRONOUSLY before
        // any async work — kills FOUC for repeat visitors. The full manifest
        // (cssVars + xterm) loads post-auth via Themes.init() below; until
        // then the :root defaults from styles.css already render claude.
        if (window.Themes && typeof window.Themes.applyStoredThemeIdSync === 'function') {
            try { window.Themes.applyStoredThemeIdSync(); } catch (_) { /* no-op */ }
        }

        // Initialize per-theme background-music plumbing. There is no
        // app-level audio control to wire: audio is session-only, gated
        // solely by the session editor FAB's "play music" row. init() also
        // runs the settings migration that drops the retired master switch.
        if (window.ThemeAudio && typeof window.ThemeAudio.init === 'function') {
            try { window.ThemeAudio.init(); } catch (_) { /* no-op */ }
        }

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
     * Phase 2: bring up the theme registry. Called post-auth so the
     * manifest fetch goes through with a valid Bearer token. Idempotent —
     * safe to call again on re-auth.
     *
     * feat/settings-screen: no longer mounts a `<select>` into the
     * header — the theme chooser moved into the settings panel (gear
     * icon; see settings-panel.js's renderAppearanceSection /
     * mountThemeSlot, which calls window.ThemeSelector.mount() itself
     * the first time the panel opens). Only the registry needs to be
     * live at boot; the picker DOM is built lazily on demand.
     */
    async _initThemes() {
        if (!window.Themes) return;
        try {
            await window.Themes.init();
        } catch (e) {
            console.warn('App: Themes.init failed — registry will use fallback', e);
        }
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

        // Title click - go home. THE ONLY HOME CONTROL NOW.
        //
        // #homeBtn is gone: the title already did this, and two controls
        // for one navigation is a control the header cannot afford at
        // phone width. It calls goHome() rather than showLaunchpad(),
        // which is the behaviour the button carried and the title did
        // NOT - goHome() also pauses the terminal's WebSocket via
        // pauseForHome(). Wiring the title to bare showLaunchpad() while
        // deleting the button would have silently dropped that pause.
        //
        // Routed through DismissGuard.onContainerActivate, not a bare
        // click listener. #appTitle is also the mount point for the
        // rename pencil and the inline rename input (see
        // TerminalController._enterHeaderRename): with a bare listener,
        // clicking into the rename field navigated away from the session
        // mid-edit. Only a click on the title chrome itself counts as
        // "go back". Do not replace this with addEventListener.
        // See client/js/dismiss-guard.js.
        const appTitle = document.getElementById('appTitle');
        window.DismissGuard.onContainerActivate(appTitle, () => {
            if (this.currentScreen === 'terminal') {
                console.log('App: Title clicked, returning to launcher');
                this.goHome();
            }
        });

        // Settings gear — click wiring only; visibility is toggled
        // alongside logoutBtn in showAuth/showLaunchpad/showTerminal.
        if (this.settingsBtn) {
            this.settingsBtn.addEventListener('click', () => {
                if (window.SettingsPanel) window.SettingsPanel.open(this.settingsBtn);
            });
        }

        // Claude-config editor gear-neighbor — click wiring only;
        // visibility toggled alongside settingsBtn in showAuth/
        // showLaunchpad/showTerminal.
        if (this.configEditorBtn) {
            this.configEditorBtn.addEventListener('click', () => {
                if (window.ConfigEditorPanel) window.ConfigEditorPanel.open(this.configEditorBtn);
            });
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
        if (this.settingsBtn) this.settingsBtn.classList.add('hidden');
        if (this.configEditorBtn) this.configEditorBtn.classList.add('hidden');
        if (window.SessionSidebar) window.SessionSidebar.hide();
        this.currentScreen = 'auth';
        this._placeStatusLight('auth');
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
        // Leaving session scope re-opens the per-session music gate. Without
        // this the detached session's opt-in (OFF by default) keeps vetoing
        // the header "app sound" switch on the home screen, silently. Must
        // run AFTER setActiveSession(null) - it reads the active session.
        if (window.SessionThemeMenu && typeof window.SessionThemeMenu.syncForSession === 'function') {
            window.SessionThemeMenu.syncForSession();
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
        if (this.settingsBtn) this.settingsBtn.classList.remove('hidden');
        if (this.configEditorBtn) this.configEditorBtn.classList.remove('hidden');
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
        // Leaving session scope re-opens the per-session music gate. Without
        // this the detached session's opt-in (OFF by default) keeps vetoing
        // the header "app sound" switch on the home screen, silently. Must
        // run AFTER setActiveSession(null) - it reads the active session.
        if (window.SessionThemeMenu && typeof window.SessionThemeMenu.syncForSession === 'function') {
            window.SessionThemeMenu.syncForSession();
        }
        // HOME-HEADER-CONSOLIDATION: the launchpad title + prompt used to be
        // a standalone block at the top of .launchpad-container (see
        // launchpad.js renderLaunchpadUI). It now lives in the header
        // itself, centred, with the prompt as a second row underneath —
        // reclaims the vertical space the standalone block used to cost.
        setHeaderIdentity({
            icon: 'brand',
            title: 'Cloude Code Launcher',
            subheader: 'select a project or create a new project'
        });
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

        // The home bar only exists once the launchpad markup is rendered,
        // which is why this is here and not beside the currentScreen
        // assignment above like the other two screens.
        this._placeStatusLight('launchpad');

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
        if (this.settingsBtn) this.settingsBtn.classList.remove('hidden');
        if (this.configEditorBtn) this.configEditorBtn.classList.remove('hidden');
        this.currentScreen = 'terminal';
        this._placeStatusLight('terminal');

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
        // Per-session music: apply THIS session's opt-in (default off) so
        // music never carries over from the session we just left. Must run
        // after setActiveSession above — it keys off the tmux session name.
        if (window.SessionThemeMenu && typeof window.SessionThemeMenu.syncForSession === 'function') {
            window.SessionThemeMenu.syncForSession();
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
        if (this.settingsBtn) this.settingsBtn.classList.remove('hidden');
        if (this.configEditorBtn) this.configEditorBtn.classList.remove('hidden');
        this.currentScreen = 'terminal';
        this._placeStatusLight('terminal');

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
