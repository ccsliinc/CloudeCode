/**
 * Themes Registry - client-side theme manifest store + apply pipeline.
 *
 * Phase 2 surface (per spec sections "Architecture B" / "Architecture G"):
 *   - Themes.init()                  fetch /api/v1/themes, apply persisted global
 *   - Themes.applyGlobal(id)         set <html data-theme>, write CSS vars on :root,
 *                                    fire xterm listeners, persist to localStorage
 *   - Themes.applySessionScope(ctx)  set the terminal's theme inputs (the
 *                                    session's pin and its agent) and paint
 *                                    the resolved answer
 *   - Themes.applySession(agentType) agent-only form of the above
 *   - Themes.clearSession()          leave session scope; restore global xterm
 *   - Themes.getActiveGlobal()       active global manifest (the PAGE theme)
 *   - Themes.getActiveTerminalManifest()  the manifest the TERMINAL wears
 *   - Themes.listAll()               all manifests (built-ins first)
 *   - Themes.onXtermThemeChange(cb)  subscribe to xterm palette changes
 *
 * THE PAGE AND THE TERMINAL ARE TWO SURFACES WITH ONE OWNER EACH. The page
 * is applyTheme()/paintCssVars() on :root. The terminal is
 * paintTerminalScope() on #terminal-screen plus the xterm palette, resolved
 * from the session's pin over its agent by resolveTerminalThemeId(). Nothing
 * else may write either surface; a second writer is the 2026-09-09 defect
 * where a pinned terminal reverted to its agent's colours on re-entry.
 *
 * Auth: fetches with Bearer token via window.Auth (matches the rest of the app).
 * Fallback: if /api/v1/themes fails for ANY reason, a hardcoded Claude manifest is
 *           injected so the page still renders.
 * No localStorage cache of the manifest list (DAR cut).
 * No-FOUC: callers should set <html data-theme="..."> from localStorage SYNCHRONOUSLY
 *          before init() resolves - see app.js for that early-paint hook.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'cloude.theme';
    var DEFAULT_THEME_ID = 'claude';
    // Phase 9: 3-state allowlist for theme effects.js scripts.
    // Shape: { [themeId]: true | false }. Missing key = "ask".
    var JS_ALLOWLIST_KEY = 'cloude.themeJsAllowlist';
    // Last-applied palette, cached so the PRE-AUTH login screen can paint
    // the user's theme. `GET /api/v1/themes` is behind require_auth, so
    // before login there is no manifest to read and `data-theme` alone
    // paints nothing - no stylesheet in this app keys off that attribute.
    // Shape: {"id": "<themeId>", "cssVars": { "--x": "y", ... }}.
    var VARS_CACHE_KEY = 'cloude.theme.vars';

    // Hardcoded fallback so the page survives a missing/broken endpoint. This
    // MUST stay in lock-step with client/css/themes/claude/theme.json - the
    // values come from the :root block in styles.css. If those drift, the
    // fallback drifts; on real boot the endpoint wins so this only matters
    // when /api/v1/themes is down.
    var CLAUDE_FALLBACK = {
        id: 'claude',
        name: 'Claude',
        description: 'The original coral-on-dark Cloude Code look.',
        author: 'Cloude Code',
        version: '1.0.0',
        source: 'builtin',
        cssVars: {},  // empty → no overrides → :root defaults from styles.css apply
        xterm: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
            black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
            blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
            brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
            brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
            brightCyan: '#29b8db', brightWhite: '#ffffff'
        }
    };

    // Module state
    var manifests = new Map();          // id -> ThemeManifest
    var activeGlobalId = DEFAULT_THEME_ID;
    // THE TERMINAL HAS EXACTLY ONE THEME OWNER, AND THESE THREE VARIABLES
    // ARE IT. Until 2026-09-09 the terminal had TWO writers racing each
    // other: theme-navigation.js painted the session's pin, and app.js then
    // called applySession(agent_type) which painted the AGENT's manifest
    // over the top. A session pinned to snes came back claude-coloured on
    // re-entry (measured: background #3A3A40 -> #1e1e1e, cyan #3CC4B5 ->
    // #11a8cd) while the page chrome stayed snes, because only the terminal
    // had a second writer. The two inputs are now recorded separately and
    // the ANSWER is derived from them in one place, resolveTerminalThemeId(),
    // so there is no longer a later call that can disagree with an earlier
    // one.
    //   sessionPinnedThemeId - the explicit choice: a server-side pin, or a
    //     theme the user picked from the in-session picker this instant.
    //   sessionAgentFallback - the agent's own theme, used ONLY when there
    //     is no explicit choice. This is the pre-existing applySession()
    //     behaviour, deliberately preserved.
    //   activeTerminalThemeId - the resolved answer currently painted, or
    //     null when the global theme governs the terminal. Replaces the old
    //     `activeSessionAgent`, and feeds applyTheme()'s legacy xterm gate
    //     unchanged: "a session-scoped palette is on screen".
    var sessionPinnedThemeId = null;
    var sessionAgentFallback = null;
    var activeTerminalThemeId = null;
    // SESSION-IDENTITY-V2 - name of the currently-active session, set by
    // app.js when transitioning to/from the terminal screen. When non-null
    // applyGlobal() PATCHes the server-side pinned theme INSTEAD of writing
    // localStorage, so per-session pins survive reloads without polluting
    // the user's "default" theme.
    var activeSessionName = null;
    var xtermListeners = [];
    var initialized = false;
    // name -> value last painted onto :root by paintCssVars, through
    // ThemeVarWriter. Tracked as VALUES, not just names, so a re-apply of
    // the SAME theme (or the same value under a different theme id) can
    // skip the setProperty call entirely rather than only skipping the
    // removal loop; see theme-var-writer.js's own header for why removal
    // itself is never gated on this.
    var appliedCssVarValues = {};
    // Phase 4-5: name -> value currently set INLINE on #terminal-screen
    // via paintTerminalScope(). Cleared (to {}) on clearSession() so we
    // don't leak orphaned vars across session swaps. Tracked as values
    // for the same reason as appliedCssVarValues above.
    var sessionAppliedVarValues = {};
    // Phase 4-5: replay gate. While `replay_in_progress` is true (set by
    // the WS replay path elsewhere), terminal-scope paints are deferred
    // and run once the flag clears. Prevents mid-replay theme flicker when
    // bytes are still being painted into xterm at session-attach time. The
    // flag itself is owned by the replay code; this module only consumes it.
    //
    // WHAT IS DEFERRED IS THE PAINT, NOT A THEME ID. The queue used to hold
    // the agentType of each deferred call and replay the last one. A queued
    // id is a decision made in the past: if the user switches session or
    // picks a different theme while replay runs, draining that id repaints
    // the theme they just left. Deferring a BOOLEAN and re-resolving from
    // the current inputs on drain cannot go stale, because the answer is
    // derived after the wait rather than before it.
    var replayInProgress = false;
    var terminalScopePaintDeferred = false;

    /**
     * Read the stored global theme id (sync, safe at any time).
     */
    function getStoredThemeId() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            return v && typeof v === 'string' ? v : DEFAULT_THEME_ID;
        } catch (_) {
            return DEFAULT_THEME_ID;
        }
    }

    /**
     * Description: remember a theme's palette so the next page load can
     *   paint it before the manifest endpoint is reachable. Keyed WITH the
     *   theme id, so a cache written for one theme can never be painted
     *   for another.
     * Inputs: themeId (string). cssVars (object) - the manifest's vars.
     * Output: void. Storage failures are ignored; the cache is an
     *   optimisation and its absence is a supported state.
     * Example: cacheThemeVars('terminal', {'--color-bg': '#000000'})
     */
    // The exact bytes this tab last wrote to VARS_CACHE_KEY, so a
    // re-apply of a theme already cached (routine: applyTheme() runs on
    // every navigation, not only on a real switch) skips the write
    // entirely rather than paying a redundant localStorage.setItem for
    // bytes already sitting there. Scoped to this tab only: a change
    // written by ANOTHER tab in between is not something this variable
    // can see, but that is the pre-existing cross-tab behaviour of a
    // best-effort pre-auth cache (last write always wins regardless),
    // not something this skip makes any worse.
    var lastCachedThemeVarsJson = null;

    function cacheThemeVars(themeId, cssVars) {
        try {
            var json = JSON.stringify({ id: themeId, cssVars: cssVars || {} });
            if (json === lastCachedThemeVarsJson) return;
            localStorage.setItem(VARS_CACHE_KEY, json);
            lastCachedThemeVarsJson = json;
        } catch (_) { /* quota or private mode - not fatal */ }
    }

    /**
     * Description: read back a cached palette, but ONLY if it was written
     *   for the theme that is stored now. A mismatch means the user
     *   switched themes in another tab, or the cache predates a rename;
     *   either way painting it would show a palette nobody chose.
     * Inputs: themeId (string) - the theme the cache must belong to.
     * Output: object - the cssVars, or {} when there is no usable cache.
     */
    function readCachedThemeVars(themeId) {
        try {
            var raw = localStorage.getItem(VARS_CACHE_KEY);
            if (!raw) return {};
            var parsed = JSON.parse(raw);
            if (!parsed || parsed.id !== themeId) return {};
            var vars = parsed.cssVars;
            if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return {};
            return vars;
        } catch (_) {
            // Corrupt JSON is the same as no cache: fall back to defaults
            // rather than throwing on the pre-auth path.
            return {};
        }
    }

    /**
     * Resolve auth header from window.Auth if available. Returns {} if not yet
     * initialized - the endpoint will then 401 and we fall back to the bundled
     * Claude manifest. Caller will retry post-auth via Themes.init().
     */
    function authHeaders() {
        var headers = { 'Accept': 'application/json' };
        try {
            if (window.Auth && typeof window.Auth.getAccessToken === 'function') {
                var tok = window.Auth.getAccessToken();
                if (tok) headers['Authorization'] = 'Bearer ' + tok;
            } else if (window.Auth && typeof window.Auth.getToken === 'function') {
                var tok2 = window.Auth.getToken();
                if (tok2) headers['Authorization'] = 'Bearer ' + tok2;
            }
        } catch (_) { /* fall through to no-auth */ }
        return headers;
    }

    /**
     * Fetch the manifest list from the server. Returns [] on any failure
     * (caller wires up the Claude fallback).
     */
    async function fetchManifests() {
        try {
            var res = await fetch('/api/v1/themes', {
                method: 'GET',
                headers: authHeaders(),
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!res.ok) {
                console.warn('Themes: /api/v1/themes returned HTTP ' + res.status + ' - using fallback');
                return [];
            }
            var data = await res.json();
            if (!Array.isArray(data)) {
                console.warn('Themes: /api/v1/themes returned non-array - using fallback');
                return [];
            }
            return data;
        } catch (err) {
            console.warn('Themes: /api/v1/themes fetch failed - using fallback', err);
            return [];
        }
    }

    /**
     * Load manifests into the in-memory map. Falls back to CLAUDE_FALLBACK if
     * the endpoint produced nothing OR if it produced rows that don't include
     * a "claude" entry (we always need a baseline).
     */
    async function loadManifests() {
        manifests.clear();
        var rows = await fetchManifests();
        rows.forEach(function (m) {
            if (m && typeof m.id === 'string') manifests.set(m.id, m);
        });
        if (!manifests.has(DEFAULT_THEME_ID)) {
            manifests.set(DEFAULT_THEME_ID, CLAUDE_FALLBACK);
        }
    }

    /**
     * Apply a manifest's cssVars to :root. Tracks names applied so the next
     * apply() can unset stale ones cleanly (otherwise switching from a theme
     * that overrode --foo to one that doesn't would leave --foo orphaned).
     */
    function paintCssVars(cssVars) {
        var rootStyle = document.documentElement.style;
        // ThemeVarWriter removes every stale name unconditionally and
        // sets only the names whose VALUE actually changed - a re-apply
        // of a theme already on screen (routine: applyGlobal() runs on
        // every navigation, not only on a real switch) costs zero
        // setProperty calls instead of a full ~30-variable palette
        // reapplied unchanged, which is real recalculation for a change
        // that never happened.
        var applied = window.ThemeVarWriter
            ? window.ThemeVarWriter.applyVarDiff(rootStyle, appliedCssVarValues, cssVars)
            : null;
        if (applied) {
            appliedCssVarValues = applied.values;
            return;
        }
        // Missing dependency: degrade to the old always-write behaviour
        // rather than silently painting nothing.
        console.error('[Themes] MISSING DEPENDENCY: window.ThemeVarWriter. ' +
            'Load client/js/theme-var-writer.js BEFORE this file.');
        var nextVars = cssVars || {};
        var nextNames = Object.keys(nextVars);
        var nextSet = new Set(nextNames);
        Object.keys(appliedCssVarValues).forEach(function (name) {
            if (!nextSet.has(name)) rootStyle.removeProperty(name);
        });
        var values = {};
        nextNames.forEach(function (name) {
            var v = String(nextVars[name]);
            try { rootStyle.setProperty(name, v); } catch (_) { /* ignore bad vars */ }
            values[name] = v;
        });
        appliedCssVarValues = values;
    }

    function fireXtermChange(xtermPalette) {
        xtermListeners.forEach(function (cb) {
            try { cb(xtermPalette); } catch (e) { console.error('Themes: xterm listener threw', e); }
        });
    }

    // -----------------------------------------------------------------------
    // Phase 9 - theme effects.js loader + consent prompt
    //
    // User-authored effects.js is loaded same-origin per the LAN-only threat
    // model - see spec section "Context" (Architecture F: Pluggability
    // Surface) for the security reasoning. Bundled themes ALSO go through
    // this gate (belt-and-suspenders) so a malicious diff that ships a
    // bundled effects.js still requires explicit user consent on first run.
    //
    // 3-state localStorage allowlist (key: cloude.themeJsAllowlist):
    //   true  → load and run silently
    //   false → skip silently
    //   missing → prompt the user (Allow once / Always / Never)
    // -----------------------------------------------------------------------

    // Track scripts we've already injected so a re-applyGlobal() of the same
    // theme doesn't re-execute the FX (xterm listeners would double-fire).
    var loadedEffectsScripts = new Set();   // Set<themeId>
    // Currently-mounted effects module (the one whose init() has run and
    // whose destroy() must be called when we swap themes). Distinct from
    // loadedEffectsScripts (which is the in-flight + completed loader cache):
    // a module can be "loaded" but not "active" if its theme has been swapped
    // away. We need the module REFERENCE, not just the id, to call destroy().
    var activeEffectsModule = null;         // { destroy?: Function } | null
    var activeEffectsThemeId = null;        // themeId the active module belongs to
    // Coalesce concurrent prompts: if applyGlobal fires twice in a row before
    // the user clicks, don't stack two modals on top of each other.
    var pendingConsentForTheme = null;      // themeId currently awaiting click
    var consentResolveQueue = [];           // pending Promises for the same theme

    function readJsAllowlist() {
        try {
            var raw = localStorage.getItem(JS_ALLOWLIST_KEY);
            if (!raw) return {};
            var parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function writeJsAllowlistEntry(themeId, value) {
        try {
            var current = readJsAllowlist();
            current[themeId] = !!value;
            localStorage.setItem(JS_ALLOWLIST_KEY, JSON.stringify(current));
        } catch (_) { /* localStorage full or disabled - non-fatal */ }
    }

    /**
     * Build + render the consent modal. Returns a Promise<'once'|'always'|'never'>.
     * Modal is theme-styled via existing .modal-* classes (uses --color-bg,
     * --color-accent, etc. from the currently-active theme so it never looks
     * out of place).
     *
     * Coalesces: if a prompt is already on-screen for the same themeId, the
     * caller piggybacks on it rather than stacking another modal.
     */
    function showConsentModal(manifest) {
        if (pendingConsentForTheme === manifest.id) {
            return new Promise(function (resolve) { consentResolveQueue.push(resolve); });
        }
        pendingConsentForTheme = manifest.id;

        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.setAttribute('data-modal', 'theme-effects-consent');
            // Inline z-index bump in case another modal-overlay is mid-display.
            overlay.style.zIndex = '10001';

            // Use the same DOM shape as showConfirmModal in app.js so it picks
            // up theme styles automatically. Three buttons here instead of two.
            var safeName = String(manifest.name || manifest.id).replace(/[<>&"']/g, function (c) {
                return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c];
            });
            overlay.innerHTML = (
                '<div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="theme-fx-title">' +
                '  <div class="modal-header" id="theme-fx-title">' +
                '    Theme effects script' +
                '  </div>' +
                '  <div class="modal-body">' +
                '    <div class="modal-message">' +
                '      Theme &ldquo;' + safeName + '&rdquo; ships a JavaScript module ' +
                '      (<code>effects.js</code>) that will run in this page.' +
                '    </div>' +
                '    <div class="modal-description">' +
                '      Allow it to run? This choice can be revoked by clearing ' +
                '      the <code>cloude.themeJsAllowlist</code> entry in localStorage.' +
                '    </div>' +
                '  </div>' +
                '  <div class="modal-footer">' +
                '    <button class="modal-btn modal-btn-secondary" data-action="never">Never</button>' +
                '    <button class="modal-btn modal-btn-secondary" data-action="once">Allow once</button>' +
                '    <button class="modal-btn modal-btn-primary" data-action="always">Always allow</button>' +
                '  </div>' +
                '</div>'
            );

            function finish(decision) {
                try { document.body.removeChild(overlay); } catch (_) {}
                pendingConsentForTheme = null;
                resolve(decision);
                // Drain any queued resolvers waiting on the same prompt.
                var pending = consentResolveQueue.slice();
                consentResolveQueue = [];
                pending.forEach(function (r) {
                    try { r(decision); } catch (_) {}
                });
            }

            overlay.addEventListener('click', function (e) {
                var btn = e.target.closest('button[data-action]');
                if (!btn) return;
                finish(btn.getAttribute('data-action'));
            });

            document.body.appendChild(overlay);
            // Default focus on the safest option ("Allow once" - no persistence).
            var onceBtn = overlay.querySelector('button[data-action="once"]');
            if (onceBtn) { try { onceBtn.focus(); } catch (_) {} }
        });
    }

    /**
     * Resolve the URL for a theme asset. Bundled themes live under the static
     * mount; user themes live under the /themes mount. The server stamps
     * `source` so this is unambiguous.
     */
    function effectsUrlFor(manifest) {
        var file = manifest.effects;
        if (!file || typeof file !== 'string') return null;
        // Defensive: forbid path traversal in a user-supplied filename.
        if (file.indexOf('..') !== -1 || file.indexOf('/') !== -1) {
            console.warn('Themes: rejecting effects path with traversal/slash:', file);
            return null;
        }
        var base = (manifest.source === 'user')
            ? '/themes/'
            : '/static/css/themes/';
        return base + encodeURIComponent(manifest.id) + '/' + encodeURIComponent(file);
    }

    /**
     * Load the effects module via dynamic import() and call its exported
     * init(). Same-origin so it inherits the existing `script-src 'self'`
     * CSP - no nonce needed.
     *
     * effects.js files are authored as ES modules (export function init()),
     * so a classic <script src=> tag would SyntaxError on `export` and
     * never run. dynamic import() loads them as modules AND gives us the
     * exported namespace so we can invoke init() ourselves - without it
     * the module would parse cleanly but do nothing (no top-level side
     * effects in our bundled FX files).
     *
     * Tracks loaded modules so re-applyGlobal() of the same theme is a
     * no-op (init() is idempotent itself, but we save a network round-trip).
     */
    function injectEffectsScript(manifest) {
        if (loadedEffectsScripts.has(manifest.id)) return;
        var url = effectsUrlFor(manifest);
        if (!url) return;
        loadedEffectsScripts.add(manifest.id);
        import(url).then(function (mod) {
            var initFn = (mod && typeof mod.init === 'function')
                ? mod.init
                : (mod && mod.default && typeof mod.default.init === 'function')
                    ? mod.default.init
                    : null;
            if (!initFn) {
                console.warn('Themes: effects module for', manifest.id, 'has no init() export');
                return;
            }
            try {
                initFn({ themeContext: { id: manifest.id, manifest: manifest } });
                // Race guard: by the time import() resolves, the user may have
                // already swapped to another theme. If this module's theme is
                // no longer active, destroy it immediately rather than letting
                // it leak (canvas + RAF would persist forever).
                if (activeGlobalId !== manifest.id) {
                    try {
                        if (mod && typeof mod.destroy === 'function') mod.destroy();
                        else if (mod && mod.default && typeof mod.default.destroy === 'function') mod.default.destroy();
                    } catch (e2) {
                        console.warn('Themes: stale effects destroy() threw for', manifest.id, e2);
                    }
                    loadedEffectsScripts.delete(manifest.id);
                    return;
                }
                // Resolve the destroyable handle (top-level export OR default).
                var destroyableMod = (mod && typeof mod.destroy === 'function')
                    ? mod
                    : (mod && mod.default && typeof mod.default.destroy === 'function')
                        ? mod.default
                        : null;
                activeEffectsModule = destroyableMod;
                activeEffectsThemeId = manifest.id;
                console.log('Themes: effects loaded for', manifest.id, '→', url);
            } catch (e) {
                console.warn('Themes: effects init() threw for', manifest.id, e);
            }
        }).catch(function (err) {
            // Roll back so a transient failure can be retried on next applyGlobal.
            loadedEffectsScripts.delete(manifest.id);
            console.warn('Themes: effects.js failed to load for', manifest.id, url, err);
        });
    }

    /**
     * Decide whether to load a manifest's effects.js, prompting the user on
     * first encounter. Returns a Promise<void>; never throws to caller - any
     * failure degrades to "skip the script" so the CSS theme still applies.
     */
    async function maybeLoadEffects(manifest) {
        if (!manifest || !manifest.effects) return;
        if (loadedEffectsScripts.has(manifest.id)) return;

        // Bundled themes ship with the app - they ARE our code, not third-party.
        // The consent prompt exists to gate user-authored themes dropped into
        // the /themes mount. Forcing users to click through a modal for a
        // theme we shipped in the repo is friction with no security upside
        // (an attacker who can ship a malicious bundled effects.js can also
        // ship a malicious registry.js). Per DAR + spec, bypass for builtins.
        if (manifest.source === 'builtin') {
            injectEffectsScript(manifest);
            return;
        }

        var allowlist = readJsAllowlist();
        var entry = allowlist[manifest.id];
        if (entry === true) {
            injectEffectsScript(manifest);
            return;
        }
        if (entry === false) {
            console.log('Themes: effects.js skipped per user allowlist for', manifest.id);
            return;
        }

        // Unknown - prompt.
        var decision;
        try {
            decision = await showConsentModal(manifest);
        } catch (e) {
            console.warn('Themes: consent modal failed, skipping effects', e);
            return;
        }
        if (decision === 'always') {
            writeJsAllowlistEntry(manifest.id, true);
            injectEffectsScript(manifest);
        } else if (decision === 'once') {
            // Don't persist. Inject this run only.
            injectEffectsScript(manifest);
        } else {
            // 'never' (or unknown - fail-closed)
            writeJsAllowlistEntry(manifest.id, false);
        }
    }

    /**
     * SESSION-IDENTITY-V2 - set / clear the active-session name. Called by
     * app.js on screen transitions (showTerminal sets, showLaunchpad/Auth
     * clears). When set, applyGlobal() routes persistence to the server
     * via PATCH /api/v1/sessions/<name>/theme INSTEAD of localStorage
     * (v0.7.0+ - project-scoped via <working_dir>/.cc.theme).
     */
    function setActiveSession(name) {
        activeSessionName = name || null;
    }

    /**
     * The tmux session name currently in theme scope, or null on the
     * launchpad / auth screens. Read by the per-session theme picker so
     * it can key its own state (audio opt-in) off the same STABLE
     * identifier the server pins themes against.
     *
     * @returns {string|null}
     */
    function getActiveSession() {
        return activeSessionName;
    }

    /**
     * SESSION-IDENTITY-V2 - pure DOM/effects apply. No persistence side-effects.
     * Returns true on success, false if id is unknown. The shared paint
     * pipeline used by both the user-driven applyGlobal() (which then
     * persists) and the screen-transition restore path in app.js (which
     * MUST NOT persist - it's just re-painting whatever was already chosen).
     *
     * @param {string} themeId
     * @param {object} [opts]
     * @param {boolean} [opts.persist] - if true, write the choice to
     *   localStorage as the new global default. Server-side per-session
     *   pinning is handled by applyGlobal() which calls this internally;
     *   this primitive intentionally does NOT touch the server.
     * @param {boolean} [opts.forXterm] - three-state xterm-repaint override:
     *   - true       → ALWAYS fire fireXtermChange regardless of the resolved
     *                  terminal theme.
     *                  Use when the caller is the authoritative source for the
     *                  session's terminal palette (session theme picker, session
     *                  attach with pinned_theme).
     *   - false      → NEVER fire fireXtermChange. Use when the caller knows a
     *                  subsequent call (e.g. applySession) will paint the
     *                  terminal and wants to avoid an intermediate flash.
     *   - undefined  → preserve legacy gate (fire iff no resolved terminal
     *                  theme is painted).
     *                  This keeps every pre-existing caller's behavior intact.
     */
    function applyTheme(themeId, opts) {
        var m = manifests.get(themeId);
        if (!m) {
            console.warn('Themes.applyTheme: unknown theme id ' + themeId + ' - keeping current');
            return false;
        }
        // Tear down the previously-active effects module if we're switching
        // AWAY from a theme that mounted one (e.g. Matrix → Claude). Without
        // this the matrix-rain canvas + RAF leak across the swap and only a
        // page refresh clears them. Skip when re-applying the same theme so
        // we don't destroy-then-init a still-good mount.
        if (activeEffectsModule && activeEffectsThemeId !== themeId) {
            try {
                if (typeof activeEffectsModule.destroy === 'function') {
                    activeEffectsModule.destroy();
                }
            } catch (e) {
                console.warn('Themes: previous effects destroy() threw for', activeEffectsThemeId, e);
            }
            // Drop loader cache for the outgoing theme so a future re-apply
            // re-fetches and re-inits cleanly (init() is idempotent but the
            // module-level state in effects.js needs a fresh init pass).
            loadedEffectsScripts.delete(activeEffectsThemeId);
            activeEffectsModule = null;
            activeEffectsThemeId = null;
        }
        document.documentElement.dataset.theme = themeId;
        paintCssVars(m.cssVars || {});
        activeGlobalId = themeId;
        // Cache the palette we just proved good, so the next visit's login
        // screen can paint it before /themes is reachable.
        cacheThemeVars(themeId, m.cssVars || {});

        if (opts && opts.persist === true) {
            try { localStorage.setItem(STORAGE_KEY, themeId); } catch (_) { /* ignore */ }
        }

        // Xterm repaint policy (three-state, opt-in override):
        //   opts.forXterm === true   → always fire (session theme picker /
        //                              session-attach with pinned_theme).
        //   opts.forXterm === false  → never fire (caller will paint via
        //                              applySession in a follow-up step).
        //   opts.forXterm undefined  → legacy gate: fire only when no session
        //                              scope is active. When a session theme
        //                              IS active it owns the terminal palette;
        //                              switching the global default shouldn't
        //                              repaint it mid-session.
        var forXterm = opts && Object.prototype.hasOwnProperty.call(opts, 'forXterm')
            ? opts.forXterm
            : undefined;
        var shouldFireXterm = forXterm === true
            || (forXterm === undefined && !activeTerminalThemeId);
        if (shouldFireXterm) {
            fireXtermChange(m.xterm || {});
        }

        // Phase 9: gated effects.js loader. Fire-and-forget so the call
        // stays sync from the caller's perspective; the modal/script-load
        // resolves asynchronously without blocking the CSS theme swap.
        if (m.effects) {
            maybeLoadEffects(m).catch(function (e) {
                console.warn('Themes: maybeLoadEffects rejected', e);
            });
        }

        // v0.7.0+ - per-theme background audio plumbing.
        // Optional `audio` manifest field; null = silence current track.
        // ThemeAudio gracefully no-ops when the field is absent or the
        // referenced asset fails to load (404 / CORS / codec).
        if (window.ThemeAudio && typeof window.ThemeAudio.setTheme === 'function') {
            try {
                window.ThemeAudio.setTheme(m.audio || null);
            } catch (e) {
                console.warn('Themes: ThemeAudio.setTheme threw', e);
            }
        }
        return true;
    }

    /**
     * v0.7.0 - PATCH the project-scoped theme for an active session.
     *
     * Hits ``PATCH /api/v1/sessions/{name}/theme`` with body
     * ``{theme_id}``; the server persists to ``<working_dir>/.cc.theme``
     * so two browsers / two machines see the same theme.
     *
     * Best-effort: failures are logged but never throw to the caller -
     * the DOM paint already succeeded; persistence is recoverable.
     * Server returns the updated SessionInfo; we don't consume it
     * (the local DOM is already the source of truth for this paint).
     *
     * Signature kept identical to the v0.6.x shape so existing callers
     * (applyGlobal) don't break.
     */
    function pinThemeForSession(sessionName, themeId) {
        try {
            var url = '/api/v1/sessions/' + encodeURIComponent(sessionName) + '/theme';
            var headers = authHeaders();
            headers['Content-Type'] = 'application/json';
            fetch(url, {
                method: 'PATCH',
                headers: headers,
                credentials: 'same-origin',
                body: JSON.stringify({ theme_id: themeId })
            }).then(function (res) {
                if (!res.ok) {
                    console.warn('Themes.pinThemeForSession: HTTP ' + res.status + ' for ' + sessionName);
                }
            }).catch(function (err) {
                console.warn('Themes.pinThemeForSession: network error', err);
            });
        } catch (err) {
            console.warn('Themes.pinThemeForSession: threw before fetch', err);
        }
    }

    /**
     * Apply a global theme. Returns true on success, false if id is unknown.
     *
     * Persistence is context-aware (SESSION-IDENTITY-V2):
     *   - activeSessionName SET    → PATCH the server-side pinned theme.
     *                                localStorage is NOT touched, so swapping
     *                                themes mid-session doesn't clobber the
     *                                user's "default" theme.
     *   - activeSessionName NULL   → write to localStorage cloude.theme as
     *                                the new global default, original behavior.
     *
     * Fires xtermThemeChange listeners with the manifest's xterm palette
     * UNLESS a session-scoped theme is active (then the session palette wins).
     */
    function applyGlobal(themeId) {
        // When the user picks a theme while inside a session, the pick IS
        // this session's explicit choice - the same kind of fact a stored
        // pin is. Recording it as one (rather than only firing xterm once
        // and moving on) is what makes leaving and coming back show the
        // same terminal: the resolver below reads the same input on the
        // pick and on every later re-entry.
        //
        // BEFORE 2026-09-09 this passed forXterm:true and stopped there.
        // That repainted the xterm palette but left #terminal-screen's
        // data-session-theme and inline CSS vars owned by the AGENT, so the
        // terminal's palette and its CSS scope disagreed from the moment of
        // the pick - measured: palette snes, scope claude. Now the paint
        // goes through the one terminal writer, which moves both together.
        var inSession = !!activeSessionName;
        var ok = applyTheme(themeId, {
            persist: !inSession,
            // forXterm:false inside a session - paintTerminalScope() below
            // is the terminal's only writer and ALWAYS fires, so firing
            // here too would be an intermediate flash of the page palette.
            // Outside a session, leave it undefined so the legacy gate
            // fires xterm normally.
            forXterm: inSession ? false : undefined
        });
        if (!ok) return false;
        if (inSession) {
            sessionPinnedThemeId = themeId;
            paintTerminalScope();
            pinThemeForSession(activeSessionName, themeId);
        }
        return true;
    }

    /**
     * Description: decide which theme governs the TERMINAL right now. The
     *   one and only resolution; every terminal paint reads it.
     * Inputs: none - reads sessionPinnedThemeId and sessionAgentFallback.
     * Output: string|null - a theme id known to the registry, or null when
     *   no session-scoped theme applies and the global theme governs the
     *   terminal too.
     * Example: pin 'snes' + agent 'claude' → 'snes'
     *
     * AN EXPLICIT CHOICE OUTRANKS A FALLBACK, and an id the registry does
     * not know is not a choice. A pin naming an uninstalled theme drops
     * through to the agent rather than painting nothing, for the same
     * reason theme-navigation.js falls back to the global theme on an
     * unknown pin: keeping the previous session's palette on screen is the
     * defect, not the safe option.
     */
    function resolveTerminalThemeId() {
        if (sessionPinnedThemeId && manifests.has(sessionPinnedThemeId)) {
            return sessionPinnedThemeId;
        }
        if (sessionAgentFallback && manifests.has(sessionAgentFallback)) {
            return sessionAgentFallback;
        }
        return null;
    }

    /**
     * Description: the manifest whose xterm palette the terminal should be
     *   showing right now - the resolved session theme, or the global theme
     *   when no session theme applies.
     * Inputs: none.
     * Output: object|null - a theme manifest, or null when even the global
     *   theme is unknown (registry not initialised).
     *
     * Exported because terminal.js SEEDS a brand-new xterm Terminal from it.
     * Seeding from getActiveGlobal() instead was the third face of this bug:
     * a terminal constructed while a session theme was already resolved came
     * up wearing the page's palette until the next paint happened to fire.
     */
    function getActiveTerminalManifest() {
        var resolved = resolveTerminalThemeId();
        if (resolved && manifests.has(resolved)) return manifests.get(resolved);
        return manifests.get(activeGlobalId) || null;
    }

    /**
     * Description: paint the resolved terminal theme - CSS scope and xterm
     *   palette together. THE ONLY writer of either.
     * Inputs: none - reads the resolution above.
     * Output: string|null - the theme id painted, null when the terminal
     *   fell back to the global theme, and null when the paint was deferred
     *   behind the replay gate.
     *
     * Deferral re-resolves on drain rather than replaying a captured id, so
     * a paint that waited out a replay cannot overwrite a newer choice made
     * while it waited.
     */
    function paintTerminalScope() {
        if (replayInProgress) {
            terminalScopePaintDeferred = true;
            console.log('Themes: replay in progress, terminal theme paint deferred');
            return null;
        }
        var themeId = resolveTerminalThemeId();
        if (!themeId) {
            // No session theme applies: strip the scope and hand the
            // terminal back to the global theme. Reached by an unpinned
            // session whose agent has no manifest, by a null/unknown agent,
            // and by leaving the terminal entirely.
            stripTerminalScope();
            return null;
        }
        var m = manifests.get(themeId);
        var el = document.getElementById('terminal-screen');
        if (el) {
            // 1. Mark the screen so per-theme theme.css blocks engage.
            el.dataset.sessionTheme = themeId;

            // 2. Sync inline cssVars: unset stale, apply current. Same
            //    diff-set pattern as paintCssVars() but scoped to the
            //    element instead of :root, so the global theme on
            //    documentElement is untouched. THE DIFF IS WHAT REMOVES A
            //    PREVIOUS OWNER'S VARIABLES: when the pin takes the scope
            //    off the agent, every var the agent set and the pin does
            //    not define is removed here rather than left orphaned -
            //    ThemeVarWriter's removal loop is UNCONDITIONAL, never
            //    gated on whether any value also changed, so a "skip the
            //    unchanged sets" optimisation cannot reintroduce this
            //    bug. Only a value that is IDENTICAL to what is already
            //    inline skips its setProperty call.
            var nextVars = (m && m.cssVars) || {};
            var applied = window.ThemeVarWriter
                ? window.ThemeVarWriter.applyVarDiff(el.style, sessionAppliedVarValues, nextVars)
                : null;
            var nextNames;
            if (applied) {
                sessionAppliedVarValues = applied.values;
                nextNames = Object.keys(applied.values);
            } else {
                console.error('[Themes] MISSING DEPENDENCY: window.ThemeVarWriter. ' +
                    'Load client/js/theme-var-writer.js BEFORE this file.');
                nextNames = Object.keys(nextVars);
                var nextSet = new Set(nextNames);
                Object.keys(sessionAppliedVarValues).forEach(function (name) {
                    if (!nextSet.has(name)) {
                        try { el.style.removeProperty(name); } catch (_) { /* ignore */ }
                    }
                });
                var values = {};
                nextNames.forEach(function (name) {
                    var v = String(nextVars[name]);
                    try { el.style.setProperty(name, v); } catch (_) { /* ignore bad var */ }
                    values[name] = v;
                });
                sessionAppliedVarValues = values;
            }
            console.log('Themes: terminal theme ' + themeId + ' (' + nextNames.length + ' inline vars)');
        } else {
            // The screen is not in the DOM yet. That costs the CSS scope,
            // which the next paint restores, and it must NOT cost the
            // palette: refusing to colour the terminal because a div is
            // missing is the same "paints nothing" failure this module
            // exists to remove.
            console.warn('Themes: #terminal-screen not found - palette applied, CSS scope skipped');
        }

        activeTerminalThemeId = themeId;

        // 3. Push the resolved palette to subscribers (terminal.js assigns
        //    it to term.options.theme through the opacity adapter).
        if (m && m.xterm) {
            fireXtermChange(m.xterm);
        }
        return themeId;
    }

    /**
     * Description: remove the terminal's session scope and hand its palette
     *   back to the active global theme. Internal half of clearSession():
     *   it undoes the PAINT without forgetting the session's inputs.
     * Inputs: none.
     * Output: void.
     */
    function stripTerminalScope() {
        var el = document.getElementById('terminal-screen');
        if (el) {
            if (el.dataset.sessionTheme) delete el.dataset.sessionTheme;
            // Wipe every inline cssVar we put there. Track-and-remove
            // (vs. style.cssText = '') so we don't clobber any inline
            // styles that other code may legitimately set on the element.
            // Unconditional, same as ThemeVarWriter's own removal loop -
            // stripping the scope entirely is not a "value unchanged"
            // case that could ever be skipped.
            Object.keys(sessionAppliedVarValues).forEach(function (name) {
                try { el.style.removeProperty(name); } catch (_) { /* ignore */ }
            });
        }
        sessionAppliedVarValues = {};
        activeTerminalThemeId = null;
        var g = manifests.get(activeGlobalId);
        if (g && g.xterm) fireXtermChange(g.xterm);
    }

    /**
     * Description: set the terminal's theme inputs for the session being
     *   entered, and paint the resolved answer.
     * Inputs: context (object|null) -
     *   - pinnedTheme (string|null) - the session's EXPLICIT theme: its
     *     server-side pin. Null when the session has none.
     *   - agentType (string|null) - the session's agent, used as the
     *     fallback when there is no explicit pin. Null/unknown is fine and
     *     means "the global theme governs the terminal too".
     * Output: string|null - the theme id painted, or null when the terminal
     *   fell back to the global theme (or the paint was deferred).
     * Example: applySessionScope({pinnedTheme: 'snes', agentType: 'claude'})
     *          → 'snes'
     *
     * THIS IS THE SEAM THE BUG CAME THROUGH. Navigation used to paint the
     * pin and then app.js separately called applySession(agent_type), so
     * the last writer won and the last writer was the agent. Both inputs
     * now arrive in ONE call and the winner is decided by
     * resolveTerminalThemeId(), which cannot be re-litigated by a later
     * caller because there is no later caller.
     */
    function applySessionScope(context) {
        var c = context || {};
        sessionPinnedThemeId = c.pinnedTheme || null;
        sessionAgentFallback = c.agentType || null;
        return paintTerminalScope();
    }

    /**
     * Description: set the terminal scope from an agent alone, with no
     *   explicit session pin. Preserved as the registry's long-standing
     *   entry point; applySessionScope() is what navigation calls.
     * Inputs: agentType (string|null) - the session's agent id. Null or an
     *   id no manifest matches hands the terminal to the global theme,
     *   which is this function's documented behaviour and is unchanged.
     * Output: string|null - the theme id painted, or null.
     * Example: applySession('claude') === 'claude'
     */
    function applySession(agentType) {
        return applySessionScope({ agentType: agentType });
    }

    /**
     * Description: leave session theme scope entirely - forget the
     *   session's pin and agent, strip the scope off #terminal-screen and
     *   revert xterm to the active global palette. Called when navigating
     *   to a screen that is not a session.
     * Inputs: none.
     * Output: void.
     */
    function clearSession() {
        sessionPinnedThemeId = null;
        sessionAgentFallback = null;
        terminalScopePaintDeferred = false;
        stripTerminalScope();
    }

    /**
     * Description: replay-gate setter, called by the WS replay path:
     *   setReplayInProgress(true)  before painting buffered scrollback
     *   setReplayInProgress(false) once the buffer is drained.
     * Inputs: flag (boolean).
     * Output: void.
     *
     * On the trailing edge a deferred terminal paint RE-RESOLVES from the
     * current inputs rather than replaying the id that was current when it
     * was deferred, so a theme the user has since navigated away from can
     * never arrive late and overwrite the one they are looking at.
     */
    function setReplayInProgress(flag) {
        var was = replayInProgress;
        replayInProgress = !!flag;
        if (was && !replayInProgress && terminalScopePaintDeferred) {
            terminalScopePaintDeferred = false;
            console.log('Themes: replay finished - painting the current terminal theme');
            paintTerminalScope();
        }
    }

    function getActiveGlobal() {
        return manifests.get(activeGlobalId) || null;
    }

    /**
     * List all manifests, built-ins first then user themes. Each group sorted
     * by name (case-insensitive).
     */
    function listAll() {
        var rows = Array.from(manifests.values());
        rows.sort(function (a, b) {
            var aBuilt = (a.source === 'builtin') ? 0 : 1;
            var bBuilt = (b.source === 'builtin') ? 0 : 1;
            if (aBuilt !== bBuilt) return aBuilt - bBuilt;
            return (a.name || a.id).toLowerCase().localeCompare((b.name || b.id).toLowerCase());
        });
        return rows;
    }

    function onXtermThemeChange(cb) {
        if (typeof cb !== 'function') return function () {};
        xtermListeners.push(cb);
        return function () {
            var idx = xtermListeners.indexOf(cb);
            if (idx >= 0) xtermListeners.splice(idx, 1);
        };
    }

    /**
     * One-shot init - fetches manifests, applies the persisted global theme.
     * Idempotent: subsequent calls re-fetch (useful after auth) but never
     * double-apply listeners or break state.
     */
    async function init() {
        await loadManifests();
        var stored = getStoredThemeId();
        // If the stored id isn't in the manifest list (e.g. user uninstalled
        // a theme), fall back to claude.
        if (!manifests.has(stored)) stored = DEFAULT_THEME_ID;
        applyGlobal(stored);
        initialized = true;
        console.log('Themes: initialized - ' + manifests.size + ' manifest(s), active=' + activeGlobalId);
    }

    window.Themes = {
        init: init,
        applyGlobal: applyGlobal,
        applyTheme: applyTheme,
        setActiveSession: setActiveSession,
        getActiveSession: getActiveSession,
        applySession: applySession,
        // The navigation entry point: pin and agent together, resolved once.
        applySessionScope: applySessionScope,
        clearSession: clearSession,
        setReplayInProgress: setReplayInProgress,
        getActiveGlobal: getActiveGlobal,
        // Which theme the TERMINAL should be showing - the resolved session
        // theme, or the global theme when none applies. terminal.js seeds a
        // new xterm Terminal from this rather than from getActiveGlobal(),
        // so a terminal built while a session theme is resolved comes up
        // wearing that theme instead of the page's.
        getActiveTerminalManifest: getActiveTerminalManifest,
        resolveTerminalThemeId: resolveTerminalThemeId,
        listAll: listAll,
        onXtermThemeChange: onXtermThemeChange,
        // Expose constants for the selector + tests
        STORAGE_KEY: STORAGE_KEY,
        DEFAULT_THEME_ID: DEFAULT_THEME_ID,
        // The user's own global choice, read through the one function that
        // owns both STORAGE_KEY and the default. Exported for
        // theme-navigation.js, which restores this theme whenever the
        // navigation target has no pin of its own. Before it was exported,
        // app.js open-coded `localStorage.getItem('cloude.theme') || 'claude'`
        // in three places.
        getStoredThemeId: getStoredThemeId,
        // Sync helper used by app.js to set <html data-theme> BEFORE init()
        // fetches anything - kills FOUC for repeat visitors.
        applyStoredThemeIdSync: function () {
            var id = getStoredThemeId();
            document.documentElement.dataset.theme = id;
            // The attribute alone renders NOTHING: no stylesheet here keys
            // off [data-theme]. Themes are delivered as cssVars painted
            // inline on :root from a manifest behind require_auth, so
            // without this the login screen showed the :root defaults out
            // of styles.css under every theme.
            //
            // paintCssVars is the same painter init() uses and it tracks
            // the names it applied, so when the real manifest arrives a
            // moment later it diffs against this set and unsets anything
            // stale. A cache that is missing, corrupt, or written for a
            // different theme yields {} and leaves the defaults standing -
            // which is exactly the old behaviour, so a first-ever visit is
            // no worse than before.
            paintCssVars(readCachedThemeVars(id));
            return id;
        },
        get initialized() { return initialized; }
    };
})();
