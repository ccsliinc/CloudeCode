/**
 * Launchpad Module - Project selection UI with terminal aesthetic
 */

console.log('[Launchpad Module] Loading...');

class Launchpad {
    constructor() {
        this.launchpadScreen = null;
        // GUARD (deep-link duplicate-session regression fix): set true
        // for the duration of openProjectByName()'s resolution. selectProject()
        // checks this flag and refuses to create a session while it's set -
        // see openProjectByName()'s docstring and selectProject()'s guard
        // clause. This makes "deep-link resolution never creates" an
        // enforced invariant rather than an implicit property of call
        // order, so a future edit that re-wires openProjectByName() into
        // selectProject() fails loudly instead of silently regressing.
        this._resolvingDeepLink = false;
        //
        // EVERYTHING ELSE THIS CONSTRUCTOR USED TO SET NOW LIVES IN THE
        // COMPILED TREE, and reading it here would be a second copy.
        // `projects`, `projectsListingOk`, `_archivedFetchOk`,
        // `projectAuthority`, `projectPresence`, `runningSessions`,
        // `runningSessionsListing`, the three attribution structures and
        // their latch, `sessionRecords` and `_workStampByName` are all
        // ACCESSOR PROPERTIES on the prototype now, delegating to
        // web/src/lib/sessions/store.svelte.ts. The comments that
        // documented them went with them, to the field that holds the
        // value. See the block at the bottom of this file.
    }



    /**
     * Initialize launchpad screen
     */
    init() {
        this.launchpadScreen = document.getElementById('launchpad-screen');
        this.renderLaunchpadUI();
        // Wire the inline "+ new" speed-dial FAB. Markup was just injected
        // by renderLaunchpadUI() into the right side of the "running
        // sessions" section heading row; the 6 sub-actions route back
        // into the same handlers the old inline "new project" section used.
        this.setupNewFab();
        this.bindHeaderHelpToggle();
        // Note: loadProjects() will be called by App.showLaunchpad()
        this._startRunningSessionsPoller();
    }

    /**
     * Wire the inline "+ new" speed-dial FAB.
     *
     * Markup is injected by renderLaunchpadUI() into the right side of
     * the "running sessions" section heading row (#new-fab). Six
     * sub-actions route into the same handlers the old inline "new
     * project" section used - no logic duplicated. Idempotent: safe to
     * call multiple times (guarded by a flag).
     *
     * Because the FAB lives inside #launchpad-screen, it shows/hides
     * naturally with the screen - no separate visibility plumbing
     * required from app.js.
     *
     * Behaviors:
     *   • Trigger click toggles .new-fab--open + aria-expanded
     *   • Backdrop click and ESC close the menu
     *   • Item click invokes the routed handler then closes
     */
    setupNewFab() {
        if (this._newFabWired) return;
        const fab = document.getElementById('new-fab');
        const trigger = document.getElementById('new-fab-trigger');
        const backdrop = document.getElementById('new-fab-backdrop');
        if (!fab || !trigger || !backdrop) {
            console.warn('Launchpad: new-fab markup missing - skipping wire');
            return;
        }

        // Map the FAB's data-action attrs onto our existing handlers.
        // Wrapped so `this` resolves correctly inside the dispatch table.
        const actions = {
            // SLICE 6 MOVED EVERY ONE OF THESE. The FAB itself is slice
            // 7's, so the dispatch table is what crosses the seam for
            // now: one call each, at the exact line the old method ran.
            'new-claude-project': () => this._web('a new project cannot be started')
                ?.startNewClaudeProject(),
            'new-session':        () => this._web('a new session cannot be started')
                ?.startSessionInExistingProject(),
            // No 'open-folder' entry: this table is keyed by the FAB's
            // data-action attributes and no menu item carries that action
            // any more. openProjectFromFolder() is still very much alive -
            // startNewClaudeProject() calls it directly as its third
            // choice - so only the dead dispatch key is gone, not the flow.
            'connect-openclaw':   () => this._web('openclaw cannot be launched')
                ?.createNewSession('openclaw'),
            'connect-hermes':     () => this._web('hermes cannot be launched')
                ?.createNewSession('hermes'),
            'new-console':        () => this.createConsoleSession(),
        };

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleNewFab();
        });

        // Item dispatch via delegation - survives any future re-render
        fab.querySelectorAll('.new-fab__item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.getAttribute('data-action');
                const fn = actions[action];
                if (typeof fn === 'function') {
                    this.closeNewFab();
                    // Defer the handler so the close animation gets a frame
                    // to start before any modal opens on top of it.
                    setTimeout(fn, 0);
                } else {
                    console.warn('Launchpad: unknown FAB action', action);
                    this.closeNewFab();
                }
            });
        });

        backdrop.addEventListener('click', () => this.closeNewFab());

        // ESC closes when open
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && fab.classList.contains('new-fab--open')) {
                this.closeNewFab();
            }
        });

        // Click-outside closes (ignore clicks inside the FAB itself)
        document.addEventListener('click', (e) => {
            if (!fab.classList.contains('new-fab--open')) return;
            if (fab.contains(e.target)) return;
            this.closeNewFab();
        });

        this._newFabWired = true;
        console.log('Launchpad: new-fab wired');
    }

    /**
     * Wire the header's "?" control to the launchpad help disclosure.
     *
     * Description: item 48 moves the CONTROL to the top right of the
     *   header; the help panel itself does not move - it stays the first
     *   child of ``.launchpad-container`` where it already is, and stays
     *   a native ``<details>``. The in-pane ``<summary>`` is still in the
     *   markup (it is what makes the element a disclosure at all) but is
     *   visually hidden by CSS, so there is exactly ONE control and it is
     *   the header one. The button is bound once and resolves the
     *   ``<details>`` at click time, because ``renderLaunchpadUI()``
     *   replaces that element on every render while the header button
     *   outlives all of them.
     * Inputs: none (reads ``#launchpad-help-btn`` and the current
     *   ``.adopt-disclosure``).
     * Output: boolean - true when the control was found and wired, false
     *   when the header button is absent (nothing is claimed either way
     *   about the help panel).
     * Example: lp.bindHeaderHelpToggle();
     */
    bindHeaderHelpToggle() {
        const btn = document.getElementById('launchpad-help-btn');
        if (!btn) {
            console.warn('Launchpad: header help button missing - help control not wired');
            return false;
        }
        if (btn.__boundHelpToggle) return true;
        btn.__boundHelpToggle = true;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const details = document.querySelector('#launchpad-screen .adopt-disclosure');
            if (!details) return;
            const next = !details.open;
            details.open = next;
            btn.setAttribute('aria-expanded', String(next));
            if (next) details.scrollIntoView({ block: 'nearest' });
        });
        return true;
    }

    /**
     * Toggle the FAB open/closed (helper used by trigger click).
     */
    toggleNewFab() {
        const fab = document.getElementById('new-fab');
        if (!fab) return;
        if (fab.classList.contains('new-fab--open')) {
            this.closeNewFab();
        } else {
            this.openNewFab();
        }
    }

    /**
     * Place the fan-out menu against the "+" trigger.
     *
     * `.new-fab__menu` is `position: fixed` (see the placement note in
     * client/css/styles.css), so this is the only thing that decides
     * where it lands. AnchorPopover puts it ABOVE the trigger with their
     * right edges flush, drops it below only when there is no room
     * above, and clamps into the visual viewport either way - which is
     * what makes it impossible for `.launchpad-scroll` to clip it no
     * matter how low the heading has been scrolled.
     *
     * Right-edge-flush is load-bearing: the pills share a right edge
     * (`align-items: flex-end`) and each row is `row-reverse` so the
     * icons form a single straight column under the "+". Any placement
     * rule that moved the menu's right edge off the trigger's would
     * break that alignment.
     *
     * @returns {void}
     */
    placeNewFabMenu() {
        const trigger = document.getElementById('new-fab-trigger');
        const menu = document.querySelector('#new-fab .new-fab__menu');
        if (!trigger || !menu || !window.AnchorPopover) return;
        window.AnchorPopover.place(menu, trigger);
    }

    /**
     * Open the FAB menu (idempotent).
     */
    openNewFab() {
        const fab = document.getElementById('new-fab');
        const trigger = document.getElementById('new-fab-trigger');
        const backdrop = document.getElementById('new-fab-backdrop');
        if (!fab || !trigger || !backdrop) return;
        // Measure and place BEFORE the open class lands, so the menu
        // animates in at its final position rather than sliding there.
        // The items are laid out (opacity 0 and a transform, neither of
        // which affects layout) so the menu measures its true size here.
        this.placeNewFabMenu();
        fab.classList.add('new-fab--open');
        // A viewport change while the menu is open (rotation, iOS URL bar
        // collapse, a scroll driven by the keyboard) moves the trigger
        // out from under a fixed menu. Re-place instead of drifting.
        if (!this._newFabReposition) {
            this._newFabReposition = () => this.placeNewFabMenu();
        }
        window.addEventListener('resize', this._newFabReposition);
        window.addEventListener('scroll', this._newFabReposition, true);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', this._newFabReposition);
            window.visualViewport.addEventListener('scroll', this._newFabReposition);
        }
        trigger.setAttribute('aria-expanded', 'true');
        backdrop.hidden = false;
        backdrop.setAttribute('data-open', '1');
        // Make menu items focusable when open
        fab.querySelectorAll('.new-fab__item').forEach(it => it.setAttribute('tabindex', '0'));
    }

    /**
     * Close the FAB menu (idempotent - also called from app.js when
     * the launchpad screen is being torn down).
     */
    closeNewFab() {
        const fab = document.getElementById('new-fab');
        const trigger = document.getElementById('new-fab-trigger');
        const backdrop = document.getElementById('new-fab-backdrop');
        if (!fab) return;
        fab.classList.remove('new-fab--open');
        if (this._newFabReposition) {
            window.removeEventListener('resize', this._newFabReposition);
            window.removeEventListener('scroll', this._newFabReposition, true);
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', this._newFabReposition);
                window.visualViewport.removeEventListener('scroll', this._newFabReposition);
            }
        }
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (backdrop) {
            backdrop.removeAttribute('data-open');
            // Hide after the fade-out so it doesn't intercept clicks
            setTimeout(() => { backdrop.hidden = true; }, 200);
        }
        fab.querySelectorAll('.new-fab__item').forEach(it => it.setAttribute('tabindex', '-1'));
    }

    /**
     * Start the one 5s running-sessions tick.
     *
     * SLICE 3 MOVED THE TIMER, AND THE POINT IS THE HALF THAT DID NOT
     * EXIST HERE. This method used to call ``setInterval`` and store the
     * handle purely as an idempotence flag; the word ``clearInterval``
     * appeared NOWHERE in this file, so the tick outlived every teardown
     * there has ever been. It lives in web/src/lib/sessions/poller.ts
     * now, with ``stopRunningSessionsPoller()`` below as its other half.
     *
     * THE TWO GATES ARE UNCHANGED and still read the same globals. A tick
     * is skipped when the user is not signed in, so we do not hammer
     * /sessions with anonymous requests before the OTP flow completes,
     * and skipped when the launchpad is not the screen on display -
     * ``CloudeWeb.launchpadIsVisible()``, which is a different thing
     * from a hidden tab. That predicate lived in
     * client/js/project-list-render-guard.js until slice 4 deleted that
     * file; it is in web/src/lib/sessions/poller.ts now, beside the tick
     * it gates. Nothing this tick fetches is read anywhere but
     * the launchpad's own two lists, so while the terminal or the archive
     * is up it was spending four HTTP requests and two full DOM rebuilds
     * every five seconds to update a screen nobody could see. A SKIP IS
     * NOT A STOP: the interval keeps running and the next tick re-asks,
     * so returning to the screen resumes with nothing to restart, and
     * App.showLaunchpad() ends in loadProjects() anyway.
     *
     * The tick's WORK is passed in. It refetches, and it re-mounts the
     * project tree - which is idempotent and paints nothing, because that
     * tree READS the store. Only the running-sessions list is still a
     * repaint, until slice 5.
     */
    _startRunningSessionsPoller() {
        const web = this._web('the running-sessions poller cannot start');
        if (!web) return;
        web.startSessionPolling(() => this.loadRunningSessions());
        console.log('Launchpad: running-sessions poller started (5s)');
    }

    /**
     * Stop that tick and clear its interval.
     *
     * THE LINE THIS FILE NEVER HAD. Idempotent. Nothing in the legacy
     * shell calls it yet, because the legacy shell has no teardown - the
     * launchpad is created once and lives for the page. It exists so the
     * timer has an owner that can end it, which is what slice 7's shell
     * will use, and so the behaviour is provable rather than asserted.
     */
    stopRunningSessionsPoller() {
        const web = this._web('the running-sessions poller cannot stop');
        if (!web) return;
        web.stopSessionPolling();
    }

    /**
     * Load and display projects, then refresh the running-sessions list.
     *
     * SLICE 3: THIS IS A SEQUENCER NOW AND HOLDS NOTHING. The fetch, the
     * two sidecars and all three three-outcome latches live in
     * web/src/lib/sessions/store.svelte.ts; what stays here is the order
     * the still-legacy renderers are called in.
     *
     * RE-RENDERS ON FAILURE, and that is not defensive noise. Without it
     * the archived notice keeps whatever the last SUCCESSFUL fetch
     * painted - a confident "showing archived: N" sitting on screen after
     * the request that would have told you failed. The count and the
     * failure render identically then, which is the exact false green the
     * three-outcome notice exists to remove. Measured 2026-09-06 in the
     * live browser: the state went to false and the screen kept reading
     * "showing archived: 1".
     */
    async loadProjects() {
        const web = this._web('the project list cannot load');
        if (web) {
            const result = await web.loadProjects(web.archivedProjectsVisible());
            if (!result.ok && result.error) this.showError(result.error);
            this.renderProjectList();
        }
        // Refresh running sessions in parallel with the projects view.
        // Failure is non-fatal and handled inside loadRunningSessions.
        this.loadRunningSessions();
        // S9 - RECENT is datastore-backed, not a live probe, so it does
        // not need the 5s running-sessions poller; refreshed here (home
        // screen load) and after any restart action. It is a Svelte
        // component now (web/src/lib/launchpad/RecentSessions.svelte),
        // which fetches as it mounts exactly as loadRecentSessions() did
        // and also owns the count, the archive filter and the section's
        // own visibility.
        if (window.CloudeWeb) {
            window.CloudeWeb.launchpad.mountRecentSessions();
        } else {
            console.error('Launchpad: compiled bundle not loaded, the recent sessions section cannot mount');
        }
        // STAGE C, and the one line the launchpad hands to the compiled
        // tree. The card is a Svelte component now (web/src/lib/launchpad/
        // AttributionPrompt.svelte); it fetches its own question set as it
        // mounts, exactly as loadAttributionPrompt() did. Independent of the
        // project load: a failure there must not stop the projects rendering,
        // and a failure here must not swallow the question set.
        if (window.CloudeWeb) {
            window.CloudeWeb.launchpad.mountAttributionPrompt();
        } else {
            console.error('Launchpad: compiled bundle not loaded, the attribution prompt cannot mount');
        }
    }

    /**
     * Refetch the unified "running sessions" list and repaint both lists.
     *
     * SLICE 3: A SEQUENCER. The two-endpoint merge, the six fields that
     * are never ``||``-defaulted, the dead-pane filter, the three-outcome
     * listing latch, the attribution join, the work-stamp index and the
     * sort are all in web/src/lib/sessions/. What stays here is the pair
     * of render calls, because both renderers are still legacy - the
     * running list is slice 5 and the project tree is slice 4.
     */
    async loadRunningSessions() {
        const web = this._web('the running sessions cannot load');
        if (!web) return;
        await web.loadRunningSessions();
        this.renderRunningSessions();
        this.renderProjectList();
    }

    /**
     * Refetch the stored session records alone.
     *
     * SLICE 3: A DELEGATE. Kept as a method because the RECENT row
     * actions call ``Launchpad.loadSessionAttribution`` by name after a
     * fork or an archive, which refreshes the tree without re-probing
     * tmux. Same join, same work index, same three-outcome latch.
     */
    async loadSessionAttribution() {
        const web = this._web('session attribution cannot load');
        if (!web) return;
        await web.loadSessionAttribution();
    }

    /**
     * The compiled tree's launchpad namespace, or null with a loud line.
     *
     * THE GUARD IS LOUD BECAUSE A SILENT ONE IS A FALSE GREEN.
     * client/index.html loads the bundle as a deferred module, so in a
     * browser it is always there by the time a screen renders. It is
     * absent in a node harness that loads this file alone, and it would
     * be absent if the bundle ever failed to load. Returning null rather
     * than throwing keeps one missing bundle from rejecting the promise
     * every caller awaits and taking the whole home screen down; saying
     * so on the console is what stops that reading as "nothing to do".
     *
     * @param {string} what - what will not happen, named in the log line.
     * @returns {object|null}
     */
    _web(what) {
        if (window.CloudeWeb && window.CloudeWeb.launchpad) {
            return window.CloudeWeb.launchpad;
        }
        console.error('Launchpad: compiled bundle not loaded, ' + what);
        return null;
    }

    /**
     * Show the app's ONE confirmation modal.
     *
     * WHY THIS SURVIVED SLICE 6 as a one-line forward. `providers.js:476`
     * calls `window.Launchpad.showConfirmModal`, and `providers.js` is
     * slice 7's. The implementation is not here and never was: the modal
     * belongs to `App.showConfirmModal`, and the compiled tree's
     * `confirm` reaches the same one. So there is still exactly one
     * confirmation modal in this app, and this method is the last legacy
     * pointer at it.
     *
     * @param {string} title
     * @param {string} message
     * @param {string} [details]
     * @param {string} [primaryLabel='confirm']
     * @param {string} [secondaryLabel='cancel']
     * @returns {Promise<boolean>} true only when confirmed. Cancel is
     *   ALWAYS a no-op; a caller must never map false to a destructive
     *   action.
     */
    showConfirmModal(title, message, details = null, primaryLabel = 'confirm', secondaryLabel = 'cancel') {
        const web = this._web('a confirmation cannot be shown');
        if (!web) return Promise.resolve(false);
        return web.confirm(title, message, details, primaryLabel, secondaryLabel);
    }

    /**
     * Create a plain "console" tmux session in ~/ running $SHELL.
     *
     * WHY THIS SURVIVED SLICE 6 as a one-line forward.
     * `client/js/terminal-commands-panel.js:256` calls
     * `window.Launchpad.createConsoleSession({terminalCommandId})`, and
     * that panel is not part of this screen's migration. The flow itself
     * is web/src/lib/launchpad/create-flow.ts.
     *
     * @param {{terminalCommandId?: string}} [options] - only the command
     *   ID travels; the command text is read from config.json server-side
     *   and is never accepted from the client.
     * @returns {Promise<void>}
     */
    async createConsoleSession(options = {}) {
        const web = this._web('a console session cannot be created');
        if (!web) return;
        await web.createConsoleSession(options || {});
    }


    /**
     * Best-effort: get current xterm cell-grid dims from the live Terminal
     * instance so we can pass them to POST /sessions. Returns {} when the
     * terminal isn't ready yet (the server falls back to its own defaults
     * and the WS handshake reshapes shortly after anyway).
     */
    _getTerminalDims() {
        if (window.TerminalMetrics
                && typeof window.TerminalMetrics.currentGrid === 'function') {
            return window.TerminalMetrics.currentGrid();
        }
        // Module missing (load-order regression). Send nothing rather
        // than a guess; the server falls back to its own defaults.
        console.warn('Launchpad: TerminalMetrics unavailable for dims');
        return {};
    }

    /**
     * Paint the running-sessions list.
     *
     * SLICE 5: ONE LINE. The 220-line string builder, the JSON signature
     * diff it carried, the delegated click binder and the four row-action
     * handlers are gone. The list is
     * web/src/lib/launchpad/RunningSessions.svelte, which READS the store
     * rather than being told to paint, so a tick writes only the values
     * that actually moved.
     *
     * IDEMPOTENT, because every caller calls it on a tick. `ensurePanel`
     * is a no-op once a live panel is mounted on the current
     * `#running-sessions-list` element, so the 5s poll costs one map
     * lookup.
     *
     * THE BUSY GUARD WENT WITH IT. `client/js/session-list-busy-guard.js`
     * existed only to SKIP this paint while an inline rename input was
     * open or a row menu was up, because the `innerHTML` write under
     * either destroyed what the user was doing. A component's rows are
     * not rebuilt, so there is nothing to destroy and nothing to skip -
     * which also means a status change now lands WHILE a menu is open,
     * which the guard could not do.
     */
    renderRunningSessions() {
        const web = this._web('the running sessions list cannot mount');
        if (!web) return;
        web.mountRunningSessions();
    }


    /**
     * Strip the ``cloude_`` prefix from tmux session names for display.
     *
     * SLICE 5: A SHIM, AND THE RULE LIVES IN THE COMPILED TREE.
     * `client/js/app.js:1403` derives a deep-link slug from this, reusing
     * the launchpad's display rule rather than reimplementing it, and it
     * is the one caller outside the surface slice 5 moved. It stays
     * reachable under this name until slice 7 deletes this file.
     *
     * Inputs: tmuxName (string).
     * Output: string - the stripped name, or the input unchanged when the
     *   bundle is missing, which is already the answer for every
     *   non-cloude name.
     */
    _deriveRunningSessionDisplayName(tmuxName) {
        const web = this._web('a session display name cannot be derived');
        if (!web) return tmuxName;
        return web.displayNameFor(tmuxName);
    }

    /**
     * Best-effort read of the currently-active backend's tmux session name.
     * Used for the self-adopt UI filter and the session-collision modal copy.
     * Returns null when no session is active or the controller isn't wired
     * up yet.
     */
    _getActiveSessionName() {
        try {
            const t = window.TerminalController;
            if (t && t.sessionActive && t._currentSession && t._currentSession.tmux_session) {
                return t._currentSession.tmux_session;
            }
        } catch (_) { /* non-fatal */ }
        return null;
    }

    /**
     * HTML-escape helper. Session names come from the tmux daemon and are
     * technically user-controlled - any embedded `<`, `>`, `"`, `'`, `&`
     * in a name would break innerHTML.
     *
     * NOTHING IN THIS FILE CALLS IT ANY MORE, and it stays anyway.
     * `providers.js:83` does (`window.Launchpad._escapeHtml`), and
     * `providers.js` is slice 7's. Slice 6 deleted the four copies that
     * were on this screen: the three local `const escapeHtml` closures
     * inside the edit, name and clone modals, which Svelte's `{expr}`
     * interpolation makes unnecessary, and the one that used to be
     * injected into `window.FolderPickerModal.open()`, which has carried
     * its own default since it was extracted. Do not add a fifth.
     */
    _escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Jump straight into an already-active running session's terminal.
     *
     * Description: extracted from the running-sessions row click handler
     *   (Task 5 / deep-link fix) so the SAME pre-fit + scrollback-capture
     *   dance is reachable from both a mouse click and a resolved
     *   `/session/<name>` deep link - the two paths must not drift apart.
     *   Pre-shows the terminal screen, measures THIS client's true
     *   cols/rows via a fit BEFORE the capture (a mismatch garbles
     *   older scrollback on a differently-sized client), then fetches
     *   the session with scrollback and hands off to
     *   `App.returnToExistingTerminal()`.
     * Inputs:
     *   rowSessionId (string|null) - server-side session id of the
     *     already-active backend to jump to.
     * Output: Promise<void>. Shows a launchpad error on failure.
     */
    async _returnToActiveRunningSession(rowSessionId) {
        try {
            // 1. Pre-show terminal screen so xterm can measure layout.
            //    hideAllScreens lives on window.App; the optional
            //    chain guards against an early-boot race where App
            //    isn't fully constructed yet (shouldn't happen on a
            //    user-triggered click, but it's free defense).
            window.App && window.App.hideAllScreens
                ? window.App.hideAllScreens()
                : document.querySelectorAll('.screen').forEach((s) =>
                      s.classList.remove('active')
                  );
            const termScreen = document.getElementById('terminal-screen');
            if (termScreen) termScreen.classList.add('active');
            // 2. First-time init of xterm if the user never visited
            //    the terminal this page load (e.g. refresh on launchpad).
            if (window.TerminalController && !window.TerminalController.term) {
                await window.TerminalController.init();
            }
            // 3. Yield two animation frames so the layout actually
            //    flushes before fitAddon measures the container.
            await new Promise((r) =>
                requestAnimationFrame(() => requestAnimationFrame(r))
            );
            // 4. Fit + read measured geometry. Wrap in try/catch -
            //    fit can throw if the container isn't laid out yet;
            //    we tolerate and fall back to 0 (server treats 0 as
            //    "skip pre-resize").
            let cols = 0;
            let rows = 0;
            try {
                if (
                    window.TerminalController &&
                    window.TerminalController.fitAddon &&
                    typeof window.TerminalController.fitAddon.fit === 'function'
                ) {
                    window.TerminalController.fitAddon.fit();
                }
                cols =
                    (window.TerminalController &&
                        window.TerminalController.term &&
                        window.TerminalController.term.cols) ||
                    0;
                rows =
                    (window.TerminalController &&
                        window.TerminalController.term &&
                        window.TerminalController.term.rows) ||
                    0;
            } catch (fitErr) {
                // Tolerated - fall through with 0/0; server skips
                // the pre-resize and behavior is identical to the
                // pre-fix path for THIS request (same-width clients
                // are unaffected anyway).
                console.warn('rejoin pre-fit failed', fitErr);
            }

            const info = await window.API.getSession(rowSessionId, {
                includeScrollback: true,
                cols,
                rows,
            });
            if (info) {
                window.App.returnToExistingTerminal(info);
            }
        } catch (err) {
            this.showError('failed to return to terminal: ' + (err.message || err));
        }
    }

    /**
     * Adopt flow for a not-yet-attached running tmux session (row click).
     *
     * Multi-session: this is purely additive - adopting this tmux session
     * does NOT detach or kill any other session. On adopt success, dispatch
     * `session-created` with the adopt-specific detail payload
     * (initialScrollbackB64, fifoStartOffset, adopted:true) so
     * App.showTerminal() can plumb scrollback into the terminal controller.
     */
    async _handleAttachRunningSession(tmuxName) {
        try {
            const response = await window.API.adoptSession(tmuxName, true);
            const session = response.session || response;
            // THE ADOPT RESPONSE HAS NO LABEL, and the header and tab
            // title are both resolved from one.
            //
            // Session (src/models.py) carries the tmux handle, not the
            // user's chosen name, so attaching this way titled the tab
            // "ScratchLab-4_fork" while entering the SAME session from the
            // sidebar - which passes the listing row - titled it "Refactor
            // spike (round 2)". Same session, two names, depending on how
            // you got there.
            //
            // The label is already in hand: the listing row was what we
            // matched to decide to attach at all. Carry it across rather
            // than widening the Session model, and never overwrite a label
            // the response did supply.
            if (session && !session.label) {
                const known = (this.runningSessions || []).find(
                    r => r.name === tmuxName
                );
                if (known && known.label) session.label = known.label;
            }
            const initialScrollbackB64 = response.initial_scrollback_b64 || '';
            const fifoStartOffset = typeof response.fifo_start_offset === 'number'
                ? response.fifo_start_offset
                : null;

            // Auto-add adopted session to Recent Projects so the user can
            // relaunch it after tmux dies. Mirrors the create-flow pattern
            // (lines 1164-1177). Skip if working_dir is missing (shouldn't
            // happen for adopted sessions but defensive).
            if (session && session.working_dir) {
                try {
                    // Strip the `cloude_` tmux-namespace prefix that
                    // session_manager.py adds when minting the tmux name -
                    // otherwise Recent Projects ends up storing
                    // `cloude_<name>`, and the next launch double-prefixes
                    // it to `cloude_cloude_<name>`. The display name in
                    // Recent Projects should be the bare project name.
                    const rawName = session.tmux_session || tmuxName;
                    const cleanName = rawName.replace(/^cloude_/, '');
                    await window.API.createProject({
                        name: cleanName,
                        path: session.working_dir,
                        description: ''
                    });
                } catch (error) {
                    // If project already exists, that's ok - continue anyway
                    if (!error.message.includes('already exists')) {
                        console.error('Launchpad: Failed to save adopted project:', error);
                    }
                }

                // Repaint the project tree from the list we just changed.
                // renderProjectList() draws from the cached this.projects, and
                // the 5s poller repaints from that cache without ever refilling
                // it - so without this the new project stays invisible until some
                // other action reloads. Guarded on its own: the session was
                // created, and a failed repaint must not read as a failed create.
                try {
                    await this.loadProjects();
                } catch (error) {
                    console.error('Launchpad: Failed to refresh projects after session create:', error);
                }
            }

            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session, initialScrollbackB64, fifoStartOffset, adopted: true }
            }));
        } catch (err) {
            this.showError(`attach failed: ${err.message || err}`);
        }
    }

    /**
     * Render launchpad UI structure
     */
    renderLaunchpadUI() {
        // TWO CHILDREN, ONE OF WHICH SCROLLS. #launchpad-screen is a flex
        // column that does not scroll; .launchpad-scroll takes the
        // leftover height and scrolls, and .home-bar sits below it and
        // does not shrink. That split is what makes the bar a real bottom
        // bar rather than the last thing in the scrolled content, and it
        // is why the bar can never overlap a project row or the "+" FAB's
        // fan-out menu: they are in different boxes. See
        // client/css/home-bar.css.
        this.launchpadScreen.innerHTML = `
            <div class="launchpad-scroll">
            <div class="launchpad-container">
                <!-- HOME-HEADER-CONSOLIDATION: the "Cloude Code Launcher"
                     title + "select a project or create a new project"
                     prompt used to render here as their own block
                     (.launchpad-header / .launchpad-prompt). They now live
                     in the top header itself (App.showLaunchpad() ->
                     setHeaderIdentity(), client/js/app.js), centred, with
                     the prompt as the header's second row. Do not re-add
                     them here - that would restore the standalone block's
                     vertical cost this change removed. -->

                <!-- LAUNCHPAD HELP. Lives at the TOP of the pane, under the
                     launcher title and its subtitle - NOT in the running-sessions
                     heading row where the adopt-only version of this used to sit.
                     Two reasons it moved there originally: (a) the running-sessions
                     section is display:none until a session exists, so the one
                     explanation of how to adopt a session you started yourself was
                     hidden from exactly the user who had not started one yet;
                     (b) as a bordered text "?" pill it was the only non-SVG glyph
                     on the pane and read as a different weight from every icon
                     around it. It has since grown from "how to adopt" into the
                     app's one general help surface (adopting, wrappers, slash
                     commands) because there is nowhere else on this screen a
                     stuck user would look - see docs/help-content-audit.md for
                     what was wrong with the old copy and why each section reads
                     the way it does now.
                     The marker is an inline SVG in the same family as the
                     .new-fab__icon set: viewBox "0 0 24 24" with stroke-width
                     1.8 as a PRESENTATION ATTRIBUTE on the svg, inherited by
                     the paths. Do not move stroke-width into a CSS svg rule -
                     a presentation attribute on a child path beats it, which
                     has silently defeated stroke restyles here twice.
                     It stays a native details/summary, never a button: the
                     bare "button { width: 36px; height: 36px }" reset in
                     styles.css would force a 36px box on it (40px under the
                     480px media query) and a class only overrides the properties
                     it actually declares.
                     NOTE FOR ANY FUTURE EDIT OF THIS BLOCK: no backticks in
                     here. The whole return value is a template literal, so a
                     backtick in a comment ends the string and takes the module
                     out with it. Also: no em dashes or en dashes in the rendered
                     copy itself (project style rule) - use a period or a colon. -->
                <!-- STAGE C: the session-attribution prompt. The Svelte
                     component web/src/lib/launchpad/AttributionPrompt.svelte
                     is mounted into this container from loadProjects(). It
                     sits ABOVE the help disclosure and above the project list
                     because it is a question, not a status line, and a
                     question below the fold is a question nobody answers. The
                     container is always present and always EMPTY when there is
                     nothing to ask, so an empty prompt costs no layout. -->
                <div id="attribution-prompt" class="attribution-prompt-slot"></div>

                <details class="adopt-disclosure">
                    <summary aria-label="help: adopting sessions, wrappers, and slash commands" title="help">
                        <svg class="adopt-disclosure__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/>
                            <line x1="12" y1="17.5" x2="12" y2="17.5"/>
                        </svg>
                    </summary>
                    <div class="adopt-disclosure-body">
                        <p><strong>adopting a session you started yourself</strong></p>
                        <p>you don't have to launch through cloude. <em>any</em> tmux session on the <code>cloude</code> socket with <code>claude</code> running inside it shows up here, adoptable. start one yourself in any terminal:</p>
                        <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork; claude</code></pre>
                        <p>it shows up in this list tagged <code>EXTERNAL</code>. click it to adopt. that tag is worked out fresh each time this list loads by checking which tmux session names cloude itself created, not stored on the session, so give it a few seconds after adopting elsewhere before you trust it. note the <code>-L cloude</code> flag: a plain <code>tmux new -s mywork</code> lives on the default socket and never appears here.</p>
                        <p>to launch claude in one line so the pane survives claude exiting:</p>
                        <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork "claude --dangerously-skip-permissions; exec \$SHELL"</code></pre>
                        <p>the <code>exec \$SHELL</code> part keeps the pane alive with a shell prompt after claude exits.</p>
                        <p>if you already have a launcher function (e.g. <code>cld</code>) defined in your <code>~/.zshrc</code> or <code>~/.bashrc</code>, run it through an interactive shell so it resolves:</p>
                        <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork "\$SHELL -ic 'cld; exec \$SHELL'"</code></pre>
                        <p>full <code>cld</code> setup in the <a href="https://github.com/Adoom666/CloudeCode#before-you-start-three-things-that-will-bite-you" target="_blank" rel="noopener">README</a>.</p>

                        <p><strong>wrappers and launch wrappers are the same thing</strong></p>
                        <p>settings names the tab <code>wrappers</code>; the panel inside it titles the same section <code>launch wrappers</code>. both mean one object: a named shell command tied to one agent family (claude, codex, hermes, openclaw, or shell) that runs when a session launches. there is no second, different kind of wrapper hiding anywhere.</p>
                        <p>configure them under settings, wrappers tab. pick one per family as the default, or choose a different one at launch time from the new-session picker. a family with no wrappers falls back to its static legacy command, shown collapsed under "advanced: legacy &lt;family&gt; command" inside that family's group.</p>

                        <p><strong>slash commands</strong></p>
                        <p>open the slash command list from the <code>/</code> control next to the terminal input (or the d-pad). the row above the terminal shows your starred favorites as tappable chips. star a command in the list to add it there; until you star anything, the row shows a small built-in default set, not your own picks.</p>
                    </div>
                </details>

                <!-- CREATE CONTROL. It lives HERE, in its own always-present
                     row, and NOT inside a section title, because it is a
                     GLOBAL action whose lifetime must not depend on any one
                     list's contents.

                     It used to be a child of #running-sessions-section's
                     title row. That section is display:none while the user
                     has zero sessions, so on a fresh install the only
                     control that creates a project or a session measured
                     0x0 and a brand-new user could not create anything at
                     all - the button that makes your first session only
                     existed once you already had one. The button was in the
                     DOM the whole time with visibility:visible, so every
                     markup assertion passed against the broken build; only
                     getBoundingClientRect() and a walk up the ancestor
                     chain could see it. See scripts/verify_fresh_install.py,
                     which measures exactly that and ships with a --legacy
                     positive control that re-parents it back here to prove
                     the check can fail.

                     Do NOT move this back inside a section. If it needs to
                     sit visually beside a heading, style this row - do not
                     re-parent the control. -->
                <div class="launchpad-actions" id="launchpad-actions">
                    <div class="new-fab" id="new-fab">
                            <button class="new-fab__trigger" id="new-fab-trigger" type="button" aria-label="New" title="New" aria-haspopup="menu" aria-expanded="false">
                                <svg class="new-fab__plus" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                                    <line x1="12" y1="5" x2="12" y2="19"/>
                                    <line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                            </button>
                            <div class="new-fab__menu" role="menu" aria-label="New session actions">
                                <!-- TOP ITEM. "create new project" was the
                                     claude entrypoint without ever saying so.
                                     It is named for what it makes, and it
                                     carries the app's OWN icon file
                                     (client/assets/icons/header-icon.png, the
                                     same asset the header uses) rather than a
                                     glyph traced by hand. Never redraw a mark
                                     here; if an asset you need does not exist,
                                     say so instead of approximating one. -->
                                <button class="new-fab__item" type="button" role="menuitem" data-action="new-claude-project" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <img class="new-fab__icon-img" src="/static/assets/icons/header-icon.png" srcset="/static/assets/icons/header-icon.png 1x, /static/assets/icons/header-icon@2x.png 2x" alt="" />
                                    </span>
                                    <span class="new-fab__label">new claude project</span>
                                </button>
                                <!-- SECOND ITEM. Adds a session to a project
                                     that already exists. It never creates a
                                     project, and with no projects to choose
                                     from it says so rather than opening an
                                     empty picker. -->
                                <button class="new-fab__item" type="button" role="menuitem" data-action="new-session" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="3" y="4" width="18" height="16" rx="2"/>
                                            <line x1="12" y1="9" x2="12" y2="15"/>
                                            <line x1="9" y1="12" x2="15" y2="12"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">new session</span>
                                </button>
                                <!-- NO "open from folder" ITEM HERE ANY MORE.
                                     Opening a folder already on disk is one
                                     of the three ways to start a claude
                                     project, not a peer of starting one, so
                                     it is now the third choice inside "new
                                     claude project" above (see
                                     startNewClaudeProject). Do not restore
                                     it here: two entry points to the same
                                     flow is what this removed. -->
                                <button class="new-fab__item" type="button" role="menuitem" data-action="connect-openclaw" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4"/>
                                            <path d="M6 3l-2 2"/>
                                            <path d="M6 3l2 2"/>
                                            <path d="M18 21l-2-2"/>
                                            <path d="M18 21l2-2"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">connect to openclaw</span>
                                </button>
                                <button class="new-fab__item" type="button" role="menuitem" data-action="connect-hermes" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">connect to hermes</span>
                                </button>
                                <button class="new-fab__item" type="button" role="menuitem" data-action="new-console" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="4 7 9 12 4 17"/>
                                            <line x1="12" y1="18" x2="20" y2="18"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">new console</span>
                                </button>
                            </div>
                    </div>
                </div>

                <!-- THE ARCHIVE ROW USED TO BE HERE AND IS GONE ON
                     PURPOSE. It was a full-width .project-item card
                     with a title and a description, plus its own section
                     heading - four lines of vertical space above the
                     project list, spent on every visit to the launchpad
                     to buy back a destination that otherwise had no
                     entry point at all. The entry point is now the
                     #archiveBtn ICON in the header (see index.html and
                     header-menu.js's HEADER_INLINE_CONTROL_IDS), which
                     is reachable from EVERY screen rather than only this
                     one, and costs no body space anywhere.
                     Do not re-add a row here: there would then be two
                     doors to keep gated on the same feature switch, and
                     the launchpad one is the one that has to be
                     rediscovered each time it drifts. -->
                <div id="running-sessions-section" class="launchpad-section running-sessions-section" style="display:none;">
                    <div class="launchpad-section-title launchpad-section-title--row">
                        <button type="button" class="launchpad-section-toggle" id="running-sessions-toggle" aria-expanded="true" aria-controls="running-sessions-list">
                            <span class="launchpad-section-chevron" aria-hidden="true">►</span>
                            <span class="launchpad-section-title__text">running sessions</span>
                            <span class="launchpad-section-count" id="running-sessions-count" data-listing-ok="1"></span>
                        </button>
                    </div>
                    <div id="running-sessions-list"></div>
                </div>

                <!-- RECENT (S9) - datastore-backed, NOT a live tmux probe.
                     Every row here is lifecycle='stopped' read straight
                     from the sessions table. The list, the count, the
                     archive filter and this section's own visibility are
                     all owned by web/src/lib/launchpad/RecentSessions.svelte;
                     only the heading below is still legacy markup, because
                     initSectionDisclosures() binds the collapse to it.
                     Hidden via display:none when empty, same convention as
                     the running sessions section above. -->
                <div id="recent-sessions-section" class="launchpad-section recent-sessions-section" style="display:none;">
                    <div class="launchpad-section-title">
                        <button type="button" class="launchpad-section-toggle" id="recent-sessions-toggle" aria-expanded="true" aria-controls="recent-sessions-list">
                            <span class="launchpad-section-chevron" aria-hidden="true">►</span>
                            <span class="launchpad-section-title__text">recent</span>
                            <span class="launchpad-section-count" id="recent-sessions-count" data-state="ok"></span>
                        </button>
                        <!-- SHOW-DELETED. The only route to a session
                             record the user deleted. Without it those
                             rows exist in the database and on the wire
                             and are reachable from nowhere, which is how
                             a deleted row took a live conversation with
                             it on 2026-09-07. Same shape and same
                             styling as the projects control beside it,
                             different verb: a session's archive is a
                             soft DELETE, not a shelf. -->
                        <button type="button" class="launchpad-archived-toggle" id="recent-show-deleted-toggle" aria-pressed="false" title="show archived sessions">
                            <span class="launchpad-archived-toggle__box" aria-hidden="true"></span>
                            <span class="launchpad-archived-toggle__label">show archived</span>
                        </button>
                    </div>
                    <div id="recent-sessions-list"></div>
                </div>

                <!-- "new project" actions live in the inline speed-dial FAB
                     to the right of the "running sessions" heading. Wired in setupNewFab(). -->

                <div class="launchpad-section" id="projects-section">
                    <div class="launchpad-section-title">
                        <button type="button" class="launchpad-section-toggle" id="projects-section-toggle" aria-expanded="true" aria-controls="project-list">
                            <span class="launchpad-section-chevron" aria-hidden="true">►</span>
                            projects
                        </button>
                        <!-- SHOW-ARCHIVED. Permanently visible, never
                             conditional on there BEING archived projects,
                             and that is the whole discoverability
                             guarantee: knowing whether any exist would
                             need a second fetch of the very rows the
                             toggle excludes, so the control announces
                             itself instead. An archived project is
                             therefore always exactly one click from
                             being on screen, and one more from being
                             restored - archive can never become a place
                             work quietly disappears to. -->
                        <button type="button" class="launchpad-archived-toggle" id="projects-show-archived-toggle" aria-pressed="false" title="show archived projects">
                            <span class="launchpad-archived-toggle__box" aria-hidden="true"></span>
                            <span class="launchpad-archived-toggle__label">show archived</span>
                        </button>
                    </div>
                    <div id="project-list" class="project-list">
                        <div class="launchpad-empty">loading projects...</div>
                    </div>
                </div>

                <!-- NO "SERVER MANAGEMENT" SECTION HERE ANY MORE. Its one
                     control, "reset server", is now the "restart server"
                     row of the home bar's server-controls menu below
                     (client/js/server-controls-menu.js). It is in ONE
                     place, not two. A collapsible section plus a
                     full-width button was a lot of the home screen's
                     vertical budget for a control pressed roughly never. -->
                </div>
            </div>

            <!-- THE HOME BAR. A flex row whose direct children are its
                 items: everything before .home-bar__spacer hugs the left
                 edge, everything after it the right. Adding an item later
                 is adding one child on the side it belongs to - there is
                 no slot table and no layout to rewrite.

                 HOME SCREEN ONLY. This markup is rendered into
                 #launchpad-screen and nowhere else, so it cannot appear on
                 the terminal screen, which spends its vertical pixels on
                 the terminal. -->
            <div class="home-bar" role="toolbar" aria-label="home bar">
                <button type="button" id="server-controls-btn" class="home-bar__btn"
                        aria-haspopup="menu" aria-expanded="false"
                        aria-label="server controls" title="server controls">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" stroke="currentColor" stroke-width="1.5"/>
                        <path d="M13 8c0-.38-.04-.75-.12-1.1l1.34-.98-1.5-2.6-1.55.62a5.05 5.05 0 0 0-1.9-1.1L9.05 1h-3l-.22 1.84c-.7.24-1.35.62-1.9 1.1l-1.55-.62-1.5 2.6 1.34.98a5.1 5.1 0 0 0 0 2.2l-1.34.98 1.5 2.6 1.55-.62c.55.48 1.2.86 1.9 1.1L6.05 15h3l.22-1.84c.7-.24 1.35-.62 1.9-1.1l1.55.62 1.5-2.6-1.34-.98c.08-.35.12-.72.12-1.1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                    </svg>
                </button>
                <!-- Connection light, LEFT group. The dot itself is NOT in
                     this markup on purpose: this is a MOUNT POINT, not a
                     copy. The one #statusText node lives in the header on
                     the auth and terminal screens and is moved in here by
                     App._placeStatusLight() while the home screen is up,
                     the same node-moving rule header-menu.js follows,
                     because it is addressed by id by app.js and
                     terminal.js. The label is written from that node's
                     data-status by App._observeStatusText(), so the string
                     still has exactly one author. -->
                <span class="home-bar__status" id="home-bar-status">
                    <span class="home-bar__status-text" id="home-bar-status-text"></span>
                </span>
                <span class="home-bar__spacer" aria-hidden="true"></span>
                <span class="home-bar__version" id="home-bar-version"></span>
                <a class="home-bar__link" href="https://nyedis.ai" target="_blank" rel="noopener noreferrer"
                   aria-label="nyedis.ai" title="nyedis.ai">
                        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 986 937" role="img" aria-label="Black bird silhouette">
                            <path d="M 409.0 883.5 L 408.5 882.0 L 458.5 804.0 L 489.5 748.0 L 488.0 747.5 L 453.0 783.5 L 437.0 797.5 L 403.0 823.5 L 377.0 839.5 L 376.5 838.0 L 398.5 816.0 L 438.5 771.0 L 469.5 732.0 L 478.5 718.0 L 474.0 719.5 L 436.0 750.5 L 388.0 785.5 L 394.5 766.0 L 409.5 739.0 L 408.0 738.5 L 386.0 753.5 L 377.0 758.5 L 375.5 758.0 L 382.5 743.0 L 394.5 725.0 L 410.5 705.0 L 410.5 703.0 L 374.0 704.5 L 361.0 702.5 L 360.5 701.0 L 409.0 681.5 L 481.0 647.5 L 520.0 625.5 L 546.0 607.5 L 565.5 589.0 L 570.5 580.0 L 570.5 576.0 L 561.0 575.5 L 542.0 580.5 L 545.5 574.0 L 560.5 556.0 L 594.0 522.5 L 632.5 489.0 L 630.0 487.5 L 588.0 488.5 L 551.0 493.5 L 516.0 500.5 L 529.5 487.0 L 532.5 480.0 L 532.0 473.5 L 515.0 472.5 L 491.0 468.5 L 451.0 455.5 L 435.5 448.0 L 452.0 439.5 L 456.5 435.0 L 456.0 433.5 L 420.0 426.5 L 402.0 420.5 L 394.5 416.0 L 427.0 414.5 L 442.0 411.5 L 445.0 410.5 L 445.0 408.5 L 399.0 408.5 L 375.0 406.5 L 333.0 400.5 L 305.5 393.0 L 306.0 391.5 L 309.0 391.5 L 344.0 394.5 L 429.0 395.5 L 461.0 394.5 L 461.0 392.5 L 426.0 390.5 L 378.0 384.5 L 302.0 370.5 L 249.0 358.5 L 180.0 339.5 L 138.0 331.5 L 75.0 314.5 L 34.0 299.5 L 19.0 291.5 L 15.5 287.0 L 18.0 285.5 L 173.5 287.0 L 173.0 285.5 L 125.0 275.5 L 91.0 264.5 L 68.0 252.5 L 59.5 244.0 L 59.0 238.5 L 134.0 251.5 L 227.5 271.0 L 225.5 266.0 L 218.0 259.5 L 181.5 238.0 L 185.0 237.5 L 297.0 264.5 L 434.0 294.5 L 546.0 316.5 L 613.0 326.5 L 613.5 325.0 L 607.0 320.5 L 591.0 312.5 L 561.0 301.5 L 509.0 287.5 L 450.0 276.5 L 449.5 275.0 L 483.0 262.5 L 505.0 257.5 L 534.0 253.5 L 600.0 252.5 L 625.0 255.5 L 632.5 255.0 L 622.0 245.5 L 609.0 239.5 L 588.0 233.5 L 551.5 228.0 L 568.0 220.5 L 585.0 217.5 L 612.0 217.5 L 644.0 221.5 L 692.0 232.5 L 737.0 247.5 L 741.0 247.5 L 747.0 241.5 L 754.0 237.5 L 771.0 233.5 L 797.0 235.5 L 814.0 240.5 L 827.0 246.5 L 841.5 259.0 L 844.5 265.0 L 845.5 281.0 L 843.5 288.0 L 836.5 301.0 L 824.5 316.0 L 805.0 334.5 L 782.0 351.5 L 769.5 365.0 L 761.5 379.0 L 761.5 390.0 L 765.0 393.5 L 767.0 393.5 L 778.0 388.5 L 795.0 383.5 L 807.0 381.5 L 827.0 381.5 L 852.0 387.5 L 865.0 393.5 L 879.0 402.5 L 904.5 426.0 L 925.5 454.0 L 946.5 492.0 L 957.5 518.0 L 961.5 532.0 L 944.0 513.5 L 932.0 503.5 L 923.0 497.5 L 903.0 488.5 L 889.0 485.5 L 873.0 485.5 L 853.0 490.5 L 839.0 497.5 L 829.0 504.5 L 814.5 519.0 L 783.5 561.0 L 754.5 604.0 L 737.5 635.0 L 737.5 659.0 L 740.0 661.5 L 765.0 671.5 L 816.0 696.5 L 826.0 699.5 L 843.0 709.5 L 857.0 720.5 L 879.5 743.0 L 894.5 762.0 L 895.5 768.0 L 881.0 780.5 L 879.5 771.0 L 875.5 764.0 L 870.0 758.5 L 856.5 750.0 L 847.5 731.0 L 834.0 716.5 L 821.0 708.5 L 808.0 704.5 L 799.0 704.5 L 800.0 700.5 L 780.0 689.5 L 722.0 666.5 L 716.5 662.0 L 715.5 650.0 L 710.0 643.5 L 705.0 641.5 L 688.0 641.5 L 683.5 644.0 L 682.5 651.0 L 689.0 666.5 L 752.0 692.5 L 793.0 711.5 L 808.0 722.5 L 824.5 738.0 L 834.5 751.0 L 840.5 762.0 L 838.5 766.0 L 828.0 772.5 L 816.0 774.5 L 815.5 762.0 L 811.5 753.0 L 805.5 744.0 L 794.0 732.5 L 786.0 729.5 L 777.0 728.5 L 765.0 729.5 L 764.5 728.0 L 768.0 724.5 L 774.0 722.5 L 774.5 721.0 L 767.0 719.5 L 734.0 699.5 L 701.0 684.5 L 681.0 679.5 L 670.0 679.5 L 668.5 671.0 L 664.0 665.5 L 657.0 663.5 L 651.0 664.5 L 646.5 669.0 L 643.5 677.0 L 645.5 705.0 L 644.5 753.0 L 643.5 756.0 L 641.0 756.5 L 637.5 748.0 L 633.0 742.5 L 627.0 739.5 L 620.5 740.0 L 623.5 754.0 L 623.5 772.0 L 620.5 790.0 L 616.0 803.5 L 614.5 795.0 L 611.0 789.5 L 603.0 783.5 L 595.0 782.5 L 593.5 798.0 L 589.5 812.0 L 581.5 826.0 L 567.0 840.5 L 564.5 841.0 L 566.5 830.0 L 566.5 816.0 L 565.5 807.0 L 564.0 806.5 L 549.5 828.0 L 532.0 845.5 L 514.0 858.5 L 512.5 858.0 L 519.5 849.0 L 523.5 840.0 L 526.5 828.0 L 526.0 823.5 L 503.0 844.5 L 479.0 860.5 L 487.5 844.0 L 495.5 819.0 L 501.5 788.0 L 500.0 786.5 L 461.5 835.0 L 427.0 869.5 L 409.0 883.5 Z" fill="currentColor"/>
                        </svg>
                    </a>
                </div>
            `;

        // Event listeners
        // Note: the 6 speed-dial actions (new claude project / new
        // session / open-folder / openclaw / hermes / console) are wired in
        // setupNewFab() - the inline speed-dial sits to the right of the
        // "running sessions" section heading on the launchpad screen.

        this.renderHomeBarVersion();
        this.wireServerControls();

        this.initSectionDisclosures();

        // Note: loadProjects() will be called by App.showLaunchpad().
        // Running-sessions row/X click handlers land in Task 10 via event
        // delegation on #running-sessions-list.
    }

    /**
     * Stamp the app version into the home bar's chip.
     *
     * `#home-bar-version` is a mount point, not the version text itself:
     * client/js/version-footer.js owns the string (a real version, or
     * "version unknown" when the resolver could not determine one - see
     * that file for why the unresolved case is named rather than left
     * blank) and this markup is built at runtime, so it has no
     * server-rendered content of its own to stamp. The same call
     * produces the sidebar footer's version line
     * (VersionFooter.sidebarFooterHtml() in
     * client/js/session-sidebar-rows.js), so the two placements can
     * never show two different strings.
     *
     * @returns {void}
     */
    renderHomeBarVersion() {
        const mount = document.getElementById('home-bar-version');
        if (!mount) return;
        mount.innerHTML = window.VersionFooter
            ? window.VersionFooter.versionSpanHtml() : '';
    }

    /**
     * Wire the home bar's server-controls trigger to its menu.
     *
     * The menu itself (rows, icons, what each row does) lives in
     * client/js/server-controls-menu.js and rides the shared FabMenu
     * plumbing. Wiring is idempotent, so a re-render that mints a fresh
     * button cannot double-bind the click.
     *
     * @returns {void}
     */
    wireServerControls() {
        const btn = document.getElementById('server-controls-btn');
        if (!btn) return;
        if (window.ServerControlsMenu && typeof window.ServerControlsMenu.wire === 'function') {
            window.ServerControlsMenu.wire(btn);
            return;
        }
        // The module is a plain script with no load guarantee relative to
        // this render. Say so rather than leaving a dead button: a
        // control that does nothing when pressed is the worse failure.
        btn.disabled = true;
        btn.setAttribute('title', 'server controls unavailable');
        console.warn('Launchpad: ServerControlsMenu not loaded; server controls disabled');
    }

    /**
     * Wire up the launchpad section headings ("running sessions",
     * "recent" and "projects") as real collapsible disclosures. Collapsed
     * state persists per-section in localStorage under
     * `cloude.launchpad.collapsed`, following the same convention as
     * `cloude.theme` / `cloude.audio.volume`.
     *
     * THE "recent" ENTRY WAS MISSING FROM THIS LIST. `#recent-sessions-toggle`
     * has rendered as a real `<button>` with `aria-expanded` since b1365a2,
     * but nothing ever attached a click listener to it - clicking it did
     * literally nothing, which reads on screen as a chevron stuck open and
     * a section that will not collapse. It was never a repaint clobbering
     * a collapse; there was no collapse behavior to clobber. Fixed by
     * listing it here like its two siblings, so it gets the exact same
     * click handler, persistence and re-apply-on-render behavior they do.
     *
     * There used to be a fourth, "server management". Its one control now
     * lives in the home bar's server-controls menu.
     */
    initSectionDisclosures() {
        const collapsedState = this.getLaunchpadCollapsedState();
        const sections = [
            { id: 'running-sessions', toggleId: 'running-sessions-toggle', contentId: 'running-sessions-list' },
            { id: 'recent-sessions', toggleId: 'recent-sessions-toggle', contentId: 'recent-sessions-list' },
            { id: 'recent-projects', toggleId: 'projects-section-toggle', contentId: 'project-list' },
        ];

        sections.forEach(({ id, toggleId, contentId }) => {
            const toggle = document.getElementById(toggleId);
            const content = document.getElementById(contentId);
            if (!toggle || !content) return;

            this.setSectionExpanded(toggle, content, !collapsedState[id]);

            toggle.addEventListener('click', () => {
                const nowExpanded = toggle.getAttribute('aria-expanded') !== 'true';
                this.setSectionExpanded(toggle, content, nowExpanded);
                this.setLaunchpadSectionCollapsed(id, !nowExpanded);
            });
        });

        // BOTH archive filters are wired by the components that own
        // them now: the RECENT one by RecentSessions.svelte and the
        // PROJECTS one by ProjectTree.svelte, each through its own
        // chrome module. Their disclosure toggles are still listed
        // above, because the headings they live in are legacy markup
        // until a later slice.
    }



    /**
     * Apply expanded/collapsed visual + a11y state to one disclosure toggle
     * and its content region.
     *
     * Uses `style.display` rather than the `hidden` attribute: `.project-list`
     * sets `display: flex` in the stylesheet, which (author origin) would
     * win the cascade over the UA `[hidden] { display: none }` rule and
     * silently no-op the collapse for that section.
     *
     * @param {HTMLElement} toggle - the <button> heading control
     * @param {HTMLElement} content - the region it shows/hides
     * @param {boolean} expanded - true to show content, false to collapse
     */
    setSectionExpanded(toggle, content, expanded) {
        toggle.setAttribute('aria-expanded', String(expanded));
        content.style.display = expanded ? '' : 'none';
    }

    /**
     * Read the persisted collapsed-state map for launchpad sections.
     *
     * @returns {Object<string, boolean>} section id -> collapsed
     */
    getLaunchpadCollapsedState() {
        try {
            const raw = localStorage.getItem('cloude.launchpad.collapsed');
            return raw ? JSON.parse(raw) : {};
        } catch (err) {
            console.warn('Launchpad: failed to read collapsed-section state:', err);
            return {};
        }
    }

    /**
     * Persist one section's collapsed flag into the shared state map.
     *
     * @param {string} sectionId - e.g. "running-sessions"
     * @param {boolean} collapsed
     */
    setLaunchpadSectionCollapsed(sectionId, collapsed) {
        const state = this.getLaunchpadCollapsedState();
        state[sectionId] = collapsed;
        try {
            localStorage.setItem('cloude.launchpad.collapsed', JSON.stringify(state));
        } catch (err) {
            console.warn('Launchpad: failed to persist collapsed-section state:', err);
        }
    }










    /**
     * Mount the project tree.
     *
     * SLICE 4, AND THIS IS THE WHOLE METHOD NOW. It used to build the
     * markup, ask `window.ProjectListRenderGuard` whether writing it was
     * worth doing, and on a yes write `#project-list.innerHTML` and
     * re-register every per-row listener. Sixteen methods,
     * `_lastProjectListSig` and that guard module were all deleted in the
     * same commit.
     *
     * THE MOUNT IS IDEMPOTENT, WHICH IS WHY EVERY CALLER STILL WORKS.
     * `ensurePanel` is a no-op once a live panel sits on the element that
     * currently carries the id, so the 5s tick and the five other call
     * sites cost one map lookup each. The tree updates because it READS
     * the store, not because anything told it to paint.
     *
     * @returns {void}
     */
    renderProjectList() {
        const web = this._web('the project tree cannot mount');
        if (web) web.mountProjectTree();
    }



    // THE SERVER-RESTART CONTROL WAS REMOVED HERE, deliberately.
    //
    // restartServer() called API.resetServer() -> POST /api/v1/server/reset
    // -> reset.sh from the server's own root. reset.sh has never shipped in
    // macOS/package.json's build.extraResources, so on a packaged install
    // that endpoint returned a 500 naming the missing file, every time. The
    // control existed only to teach the user the app was broken.
    //
    // Shipping the script would not have fixed it: a process restart belongs
    // to whatever SUPERVISES the process, and the python server never
    // supervises itself. The full argument, and where each install shape's
    // real restart lives, is at the removal site in src/api/routes.py.
    //
    // If this comes back, it comes back as an action the supervisor performs.

    /**
     * Connect to existing session
     */
    async connectToExistingSession() {
        try {
            this.updateStatus('connecting to existing session...');
            const data = await window.API.getSession();
            const session = data.session || data;

            console.log('Launchpad: Connecting to existing session:', session);

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session }
            }));
        } catch (error) {
            console.error('Launchpad: Failed to get existing session:', error);
            this.showError('failed to connect: ' + error.message);
        }
    }

    /**
     * Detach from the existing session (tmux keeps running) and create a
     * fresh one. Mirror of ``detachAndOpenProject`` for the "new project"
     * path - prior session lingers and can be re-adopted later.
     */
    async detachAndCreateNew(agentType = null) {
        try {
            this.updateStatus('detaching from current session...');
            await window.API.detachSession();

            // Wait a moment, then create new. Same race-avoidance rationale
            // as ``detachAndOpenProject``. Honor the agentType so the
            // re-create lands on the same CLI the user originally picked.
            setTimeout(() => {
                // SLICE 6: one entry point for both, and `agentType` null
                // is what tells it to let the provider picker and then
                // the server's own fallback chain decide.
                const web = this._web('the replacement session cannot be created');
                if (web) web.createNewSession(agentType || null);
            }, 500);
        } catch (error) {
            console.error('Launchpad: Failed to detach session:', error);
            this.showError('failed to detach session: ' + error.message);
        }
    }

    /**
     * Canonical tmux-name <-> URL-slug matcher - the ONE place that decides
     * whether a decoded deep-link slug refers to a given running session.
     *
     * Description: used by BOTH directions of the deep-link feature so
     *   they can never drift apart:
     *     - OUTBOUND (build): `App._syncSessionUrl()` in app.js calls
     *       `_deriveRunningSessionDisplayName()` directly to turn a live
     *       `tmux_session` (e.g. `cloude_claude-config-sync-2`) into the
     *       URL slug (`claude-config-sync-2`).
     *     - INBOUND (resolve): this method calls the SAME
     *       `_deriveRunningSessionDisplayName()` on every candidate row
     *       and compares against the decoded slug - exact match first,
     *       then case-insensitive fallback.
     *   Previously these two directions used the same helper already, so
     *   a prefix-stripping mismatch was ruled out as the root cause of
     *   the duplicate-session regression (see openProjectByName()'s
     *   docstring) - but keeping the comparison here, in one function,
     *   means that stays true by construction instead of by coincidence.
     * SYMMETRIC WITH THE DISPLAY TITLE TOO, not only the slug. The
     * outbound URL this app builds (`App._syncSessionUrl`) always uses
     * the tmux-derived slug, never the title - but a deep link built
     * some other way (a pasted title, a fork label copied from the
     * header: `<parent title>(fork)`, `src/core/session_fork.py`
     * `fork_label`) names the SAME session and must resolve to it. Both
     * `/sessions/attachable` and `/sessions/list` rows carry `label`
     * (`AttachableSession.label` / `SessionInfo.session` - the row's
     * `sessions.title`), so once the slug match misses, the title is
     * checked against that field before giving up.
     * Inputs:
     *   slug (string) - decoded, validated name from the URL. Despite
     *     the parameter name this may be a slug OR a display title.
     * Output: the matching row from `this.runningSessions`, or
     *   `undefined` if none matches.
     */
    _findRunningSessionBySlug(slug) {
        const rows = this.runningSessions || [];
        const bySlug = rows.find(s => this._deriveRunningSessionDisplayName(s.name) === slug)
            || rows.find(s => (this._deriveRunningSessionDisplayName(s.name) || '').toLowerCase() === String(slug).toLowerCase());
        if (bySlug) return bySlug;

        const wanted = String(slug).trim();
        if (!wanted) return undefined;
        return rows.find(s => typeof s.label === 'string' && s.label.trim() === wanted)
            || rows.find(s => typeof s.label === 'string' && s.label.trim().toLowerCase() === wanted.toLowerCase());
    }

    /**
     * Open a project OR an adopted session by name (used by the deep-link
     * router, Item 9; extended for adopted sessions as part of the deep-link
     * fix; REORDERED as part of the duplicate-session regression fix below).
     *
     * ROOT CAUSE of the duplicate-session regression: this method used to
     * check `this.projects` (launcher entries) FIRST and, on a match, call
     * `selectProject()` - which unconditionally calls
     * `window.API.createSession()`. `create_session()` server-side
     * (src/core/session_manager.py) deliberately NEVER attaches to an
     * existing tmux session for a project click - "a project click must
     * ALWAYS spawn a NEW session... the user runs multiple concurrent
     * sessions per directory" - so on a name collision it silently mints
     * `<name>-2`, `<name>-3`, etc. and returns THAT. A deep link to a
     * project that already had a live tmux session therefore always
     * created a fresh duplicate rather than reattaching, and the browser
     * ended up on the newly-created session's URL. The name<->slug
     * mapping itself (`_deriveRunningSessionDisplayName`, see
     * `_findRunningSessionBySlug()` above) was already shared correctly
     * between build and resolve - it was never reached, because the
     * launcher-project branch returned first.
     *
     * FIX: live sessions are now resolved FIRST, and a launcher-project
     * match is no longer used to justify creating a session for a deep
     * link at all - see the GUARD note below.
     *
     * Resolution order:
     *   1. `GET /sessions/list` / `GET /sessions/attachable` (via
     *      `loadRunningSessions()`) for a LIVE session whose slug
     *      matches (`_findRunningSessionBySlug()`) - this covers both an
     *      already-adopted session (jump straight to its terminal) and
     *      an un-adopted but running tmux session (adopt it via the same
     *      path as a running-sessions row click). NEITHER branch creates
     *      anything.
     *   2. Nothing matches anywhere → the router's error banner (NOT a
     *      browser `alert()`, which is easy to miss/dismiss unnoticed) via
     *      `Router.rejectTarget()`, which also cleans the URL back to `/`.
     *
     * GUARD: this method deliberately does NOT fall back to
     * `this.projects` / `selectProject()` on a miss, even though a
     * launcher project with that name may exist - doing so would call
     * `createSession()`, which is exactly the regression above. Deep-link
     * resolution must never create a session; a launcher-project name
     * match with no corresponding live tmux session is indistinguishable
     * from "nothing to reattach to" and is reported the same way. As a
     * second line of defense, `selectProject()` itself refuses to run
     * while `this._resolvingDeepLink` is set (see its guard clause), so
     * even a future refactor that re-wires this method into
     * `selectProject()` fails loudly instead of silently regressing.
     * Inputs: name (string) - decoded, regex-validated slug from the URL.
     * Output: Promise<void>.
     */
    async openProjectByName(name) {
        console.log('Launchpad: openProjectByName:', name);

        this._resolvingDeepLink = true;
        try {
            // Refresh the running-sessions list so we aren't racing the 5s
            // poller - a deep link can arrive well before the first poll
            // tick, and can also be a session with no launcher project
            // entry at all (external/adopted).
            // A LISTING THAT DID NOT RUN IS NOT AN EMPTY LISTING, and
            // treating it as one is what made deep links unreliable.
            //
            // On a COLD page load this resolve can fire before the session
            // list is fetchable - auth has just settled, the first poll
            // has not happened. loadRunningSessions() records that as
            // `runningSessionsListing.ok === false`; it does NOT throw. So
            // the old single attempt proceeded with an empty row set,
            // found nothing, and rejected the URL.
            //
            // The symptom was baffling because ONE class of name survived:
            // a slug that is also a launcher PROJECT fell through to the
            // project branch below and opened anyway. So /session/Foo
            // worked when Foo was a project, and every other session -
            // Foo-2, Foo-3, any fork, anything renamed - bounced to `/`
            // with "No active session", which reads like a broken session
            // rather than a lookup that never got to look.
            //
            // Retry only while we CANNOT DETERMINE. A listing that ran and
            // genuinely returned nothing is an answer, and we take it.
            let session = null;
            for (let attempt = 0; attempt < 5; attempt += 1) {
                try {
                    await this.loadRunningSessions();
                } catch (err) {
                    console.warn('Launchpad: loadRunningSessions during deep-link resolve failed:', err);
                }
                session = this._findRunningSessionBySlug(name);
                if (session) break;
                const listing = this.runningSessionsListing || { ok: true };
                if (listing.ok) break;   // it looked, and there is nothing
                console.warn(
                    'Launchpad: session listing unavailable during deep-link resolve '
                    + `(attempt ${attempt + 1}), reason=${listing.reason || 'unknown'}`
                );
                await new Promise(r => setTimeout(r, 300));
            }

            if (session) {
                console.log('Launchpad: deep-link resolved to running session:', session.name);
                if (session.is_active) {
                    await this._returnToActiveRunningSession(session.session_id || null);
                } else {
                    await this._handleAttachRunningSession(session.name);
                }
                return;
            }

            // No live session anywhere - GUARD (see docstring above): do
            // NOT consult this.projects to create one. Show the actual
            // banner, not a silent bounce to `/` and not a browser
            // alert() (Task 5 / deep-link fix).
            console.warn('Launchpad: deep-link target not found among live sessions:', name);
            if (window.Router && typeof window.Router.rejectTarget === 'function') {
                window.Router.rejectTarget(name);
            } else {
                this.showError(`session not found: ${name}`);
            }
        } finally {
            this._resolvingDeepLink = false;
        }
    }

    /**
     * Select and open existing project.
     * @param {object} project
     * @param {{model: string|null}|undefined} [providerChoice] - Pass a
     *   already-resolved choice when the caller gated its own pre-session
     *   side effect (e.g. persisting a new project entry) on the provider
     *   modal first - avoids prompting the user twice. Omit to have this
     *   function show the modal itself (existing-project paths).
     */
    async selectProject(project, providerChoice = undefined) {
        console.log('Launchpad: Selecting project:', project.name);

        // GUARD: never create a session while resolving a deep link (see
        // the `_resolvingDeepLink` docstring in the constructor and
        // `openProjectByName()`'s docstring). This is what makes the
        // "deep-link resolution must never create" invariant explicit in
        // code rather than an accident of call order - openProjectByName()
        // no longer calls this method at all, but this clause exists so a
        // future refactor that re-wires them together fails loudly (a
        // thrown error surfaced to the deep-link error banner) instead of
        // silently spawning a duplicate tmux session again.
        if (this._resolvingDeepLink) {
            const err = new Error(
                `refusing to create a session for ${project.name} while resolving a deep link`
            );
            console.error('Launchpad: BLOCKED create-session during deep-link resolution:', err);
            if (window.Router && typeof window.Router.rejectTarget === 'function') {
                window.Router.rejectTarget(project.name);
            }
            throw err;
        }

        try {
            // Gate: pick claude vs an OpenRouter model BEFORE opening the
            // project. null = user cancelled the whole launch - abort
            // cleanly, no session created, no error toast.
            if (providerChoice === undefined) {
                providerChoice = await this.showProviderModal();
                if (!providerChoice) {
                    console.log('Launchpad: Provider selection cancelled');
                    return;
                }
            }

            // Show loading state
            this.updateStatus(`opening ${project.name}...`);

            // Create session with project path (no template copying for existing projects).
            // Include current xterm cell grid dims so the tmux pane is birthed
            // at the right size - see the "new project" path for rationale.
            const _dims = this._getTerminalDims();
            const payload = {
                working_dir: project.path,
                auto_start_claude: true,
                copy_templates: false,
                project_name: project.name,
                // See _createNewSessionInner's identical comment: the
                // label becomes claude's `--name` as well as the row
                // title, so opening an existing project names the
                // session on both sides at once.
                label: project.name,
                ..._dims
            };
            // Omit for claude (server default); set for an OpenRouter model.
            if (providerChoice.model) {
                payload.model = providerChoice.model;
            }
            // feat/launch-wrappers - see _createNewSessionInner's identical
            // comment; this path has no explicit agentType to defer to.
            if (providerChoice.wrapperId) {
                payload.agent_type = providerChoice.wrapperId;
            } else if (providerChoice.agentType) {
                // Pinned family row; see _createNewSessionInner's comment.
                payload.agent_type = providerChoice.agentType;
            }
            const session = await window.API.createSession(payload);

            console.log('Launchpad: Project session created:', session);

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session, project }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to open project:', error);

            // If a session already exists, SWAP to the project the user just
            // clicked. The old tmux session is DETACHED (not destroyed) so
            // it keeps running on the server and reappears in the
            // running-sessions list / banner for rejoin.
            if (error.message.includes('already running')) {
                this.detachAndOpenProject(project);
            } else {
                this.showError(`failed to open ${project.name}: ${error.message}`);
            }
        }
    }

    /**
     * Detach from the existing session (tmux keeps running) and open the
     * selected project in a fresh session. The prior session lingers on
     * the tmux side and shows up in the Adopt list tagged as cloude-owned,
     * so the user can rejoin it later without losing any state.
     */
    async detachAndOpenProject(project) {
        try {
            this.updateStatus('detaching from current session...');
            await window.API.detachSession();

            // Wait a moment, then open project. The brief delay lets the
            // server finish clearing its backend handles before the new
            // create-session call lands - avoids a race where we try to
            // create while the old backend is still tearing down.
            setTimeout(() => this.selectProject(project), 500);
        } catch (error) {
            console.error('Launchpad: Failed to detach session:', error);
            this.showError('failed to detach session: ' + error.message);
        }
    }

    /**
     * Update status message
     */
    updateStatus(message) {
        const statusEl = document.getElementById('statusText');
        if (statusEl) {
            statusEl.setAttribute('data-status', message);
            // aria-label mirrors the ::after tooltip text so screen readers
            // get the same live state a sighted hover shows.
            statusEl.setAttribute('aria-label', message);
        }
        console.log('Launchpad:', message);
    }

    /**
     * Show error message
     */
    /**
     * Say out loud why a project row refused to open, and name the path.
     *
     * THREE OUTCOMES, kept distinct on purpose. 'missing' is a measured
     * fact - the folder is not there. 'unreachable' is the third state:
     * the presence probe could not reach the path, which is NOT evidence
     * the project is gone, and telling the user it is missing would invent
     * a verdict nobody measured. Anything else reaching here means the row
     * was disabled for a reason this function does not know about, and it
     * says exactly that rather than guessing.
     *
     * @param {object|undefined} project - The project the row stands for.
     * @param {HTMLElement} item - The row element, used only as a fallback
     *   source for the path when the project object is unavailable.
     * @returns {void}
     */
    _explainRefusedProject(project, item) {
        const path = (project && (project.root || project.path))
            || (item && item.dataset ? item.dataset.path : '')
            || 'an unrecorded path';
        const row = (project && project.root && this.projectPresence.get(project.root))
            || null;
        const state = row ? row.presence : 'unchecked';

        if (state === 'missing') {
            this.showError(
                `"${project && project.name ? project.name : 'this project'}" ` +
                `was not opened: its folder does not exist at ${path}.\n\n` +
                `Nothing was started and nothing was changed. Either restore ` +
                `the folder at that path, edit the project to point at where ` +
                `it lives now, or archive the project.`
            );
            return;
        }
        if (state === 'unreachable') {
            const detail = (row && row.presence_detail) || 'reason unknown';
            this.showError(
                `"${project && project.name ? project.name : 'this project'}" ` +
                `was not opened: CANNOT DETERMINE whether ${path} exists ` +
                `(${detail}).\n\n` +
                `This is NOT a report that the folder is gone - the check ` +
                `could not run. Nothing was started and nothing was changed.`
            );
            return;
        }
        this.showError(
            `"${project && project.name ? project.name : 'this project'}" ` +
            `was not opened, and the reason was not recorded (presence ` +
            `state "${state}" for ${path}).\n\n` +
            `Nothing was started and nothing was changed. This is a bug in ` +
            `the app, not something you did.`
        );
    }

    showError(message) {
        /**
         * Surface an error WITHOUT blocking the page.
         *
         * Description: this used a native ``alert()``, and three other
         *   places in this file already documented that errors should be
         *   inline "(no alert())" while the alert stayed put. It is not a
         *   style problem. A native alert HALTS the page: timers stop, the
         *   poller stops, and nothing else can run until a human dismisses
         *   it. The fork refusal found that the hard way - the server
         *   answered 409 correctly with a clear reason, the client picked
         *   the right branch, and the whole app then froze on the modal
         *   that was supposed to be telling you about it. An error message
         *   that stops the program is worse than the error.
         *
         *   Deliberately NOT routed through ToastManager: that surface is
         *   for server-pushed session toasts with ack semantics, and a
         *   dismiss there syncs to the server. A local client-side error
         *   has nothing to acknowledge and no server record to update.
         * Inputs: message (string).
         * Output: void.
         * Example: lp.showError('cannot fork: no conversation to branch');
         */
        console.error('Launchpad Error:', message);
        try {
            let host = document.getElementById('launchpad-error-stack');
            if (!host) {
                host = document.createElement('div');
                host.id = 'launchpad-error-stack';
                document.body.appendChild(host);
            }
            const card = document.createElement('div');
            card.className = 'launchpad-error-card';
            card.setAttribute('role', 'alert');
            const text = document.createElement('span');
            text.className = 'launchpad-error-text';
            // textContent, never innerHTML: this string can carry a server
            // detail, a filesystem path or an exception message, none of
            // which is ours to trust as markup.
            text.textContent = message;
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'launchpad-error-dismiss';
            close.setAttribute('aria-label', 'dismiss this error');
            close.textContent = '\u00d7';
            const remove = () => { if (card.parentNode) card.parentNode.removeChild(card); };
            close.addEventListener('click', remove);
            card.appendChild(text);
            card.appendChild(close);
            host.appendChild(card);
            // Auto-dismiss, but generously: an error you cannot re-read is
            // an error you cannot act on.
            setTimeout(remove, 12000);
        } catch (err) {
            // The reporter must never become the fault. If the DOM is not
            // there to write into, the console line above already ran.
            console.error('Launchpad: could not render error banner:', err);
        }
    }
}

/**
 * THE SESSION DATA LAYER LIVES IN THE COMPILED TREE NOW, AND THIS IS THE
 * SEAM. Slice 3 of the launchpad migration moved thirteen methods and
 * every field they wrote into web/src/lib/sessions/. What is left here is
 * a set of ACCESSOR PROPERTIES that read and write that one store.
 *
 * WHY ACCESSORS RATHER THAN EDITING EVERY READER. Roughly forty places in
 * this file still say `this.runningSessions` or `this.projects`, and all
 * of them belong to renderers slices 4 and 5 will delete outright. A
 * property is the change that makes every one of those a store read
 * TODAY, in one place, without touching a line of markup - so there is
 * exactly one data path during the overlap, rather than a legacy copy
 * that drifts from the store between ticks. That drift is the whole
 * failure this slice exists to prevent.
 *
 * THERE IS NO FALLBACK OBJECT BEHIND THEM, DELIBERATELY. An accessor that
 * quietly fell back to a local field when the bundle was missing would be
 * a SECOND data owner: it would work, it would look right, and the two
 * copies would answer differently the moment anything wrote to one. So a
 * missing bundle throws here, loudly and by name. In a browser it cannot
 * happen - client/index.html loads the bundle as a deferred module above
 * this file's consumers. In a node harness it means the harness has to
 * evaluate client/dist/app.js in its sandbox, which is what
 * tests/helpers/cloude-web-sandbox.mjs is for, and which is strictly
 * better than a stub: those tests then exercise the REAL store.
 *
 * SETTERS EXIST BECAUSE THE FIELDS WERE WRITABLE. A test that used to say
 * `lp.runningSessions = rows` still says exactly that, and it now writes
 * the store. Removing the setters would make the seam one-directional and
 * force every one of those tests to learn a second API for no gain.
 */
const SESSION_STORE_FIELDS = [
    // The project list and its three latches.
    ['projects', 'projects'],
    ['projectsListingOk', 'projectsListingOk'],
    ['_archivedFetchOk', 'archivedFetchOk'],
    ['projectAuthority', 'projectAuthority'],
    ['projectPresence', 'projectPresence'],
    // The running rows, and this tick's verdict on the two probes.
    ['runningSessions', 'runningSessions'],
    ['runningSessionsListing', 'runningSessionsListing'],
    // The attribution join: both rungs, the refusal set and the latch.
    ['sessionAttribution', 'sessionAttribution'],
    ['sessionAttributionByInstance', 'sessionAttributionByInstance'],
    ['sessionAttributionAmbiguous', 'sessionAttributionAmbiguous'],
    ['sessionAttributionListingOk', 'sessionAttributionListingOk'],
    ['sessionAttributionListingDetail', 'sessionAttributionListingDetail'],
    ['sessionRecords', 'sessionRecords'],
    ['_workStampByName', 'workStampByName'],
];

/**
 * The one store, or a throw naming what is missing.
 *
 * @returns {object} window.CloudeWeb.launchpad.sessions
 */
function sessionStoreOrThrow() {
    const web = window.CloudeWeb;
    if (web && web.launchpad && web.launchpad.sessions) {
        return web.launchpad.sessions;
    }
    throw new Error(
        'Launchpad: the compiled bundle is not loaded, so the session store '
        + 'cannot be read. In a browser client/index.html loads it; in a node '
        + 'harness see tests/helpers/cloude-web-sandbox.mjs.'
    );
}

for (const [legacyName, storeName] of SESSION_STORE_FIELDS) {
    Object.defineProperty(Launchpad.prototype, legacyName, {
        configurable: true,
        enumerable: true,
        get() {
            return sessionStoreOrThrow()[storeName];
        },
        set(value) {
            sessionStoreOrThrow()[storeName] = value;
        },
    });
}

// Export singleton instance
window.Launchpad = new Launchpad();
console.log('[Launchpad Module] Exported as window.Launchpad:', window.Launchpad);
