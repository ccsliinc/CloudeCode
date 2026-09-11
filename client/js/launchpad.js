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
            'new-claude-project': () => this.startNewClaudeProject(),
            'new-session':        () => this.startSessionInExistingProject(),
            // No 'open-folder' entry: this table is keyed by the FAB's
            // data-action attributes and no menu item carries that action
            // any more. openProjectFromFolder() is still very much alive -
            // startNewClaudeProject() calls it directly as its third
            // choice - so only the dead dispatch key is gone, not the flow.
            'connect-openclaw':   () => this.createNewSessionWithAgent('openclaw'),
            'connect-hermes':     () => this.createNewSessionWithAgent('hermes'),
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



    /**
     * ARCHIVE a project: retire it from the list, keep everything.
     *
     * THE ONLY DESTRUCTIVE-SHAPED CONTROL ON A PROJECT ROW. There used
     * to be a hard-delete trash button beside this one; it is gone from
     * the UI (owner's instruction, 2026-09-08: "sessions and projects
     * can be archived not deleted"). This hides the row and is undone in
     * one click, never removes it.
     *
     * IT DOES NOT TOUCH THE PROJECT'S SESSIONS. That is stated to the
     * user, not just to the server: a user who believes archiving might
     * take his running sessions with it will not use the feature, and a
     * user who believes it will not when it does has lost work. The
     * server writes only this project's ``archived_at`` - see
     * src/core/project_archive.py.
     *
     * @param {string} projectName
     * @returns {Promise<void>}
     */
    async archiveProject(projectName) {
        try {
            const confirmed = await this.showConfirmModal(
                'archive project',
                `archive "${projectName}"?`,
                'it leaves this list but is kept in full. its sessions are NOT archived and keep working. the folder on disk is not touched. turn on "show archived" to bring it back.',
                'archive',
                'cancel'
            );
            if (!confirmed) return;

            await window.API.archiveProject(projectName);
            await this.loadProjects();
        } catch (error) {
            console.error('Launchpad: failed to archive project:', error);
            this.showError('failed to archive project: '
                + (error && error.message ? error.message : 'the server could not be reached'));
        }
    }

    /**
     * UNARCHIVE a project: put it back in the default list.
     *
     * No confirm. Archiving is the destructive-shaped direction (it takes
     * something off the screen); restoring only ever adds a row back, and
     * a confirm on a harmless, self-evident, instantly-reversible action
     * is friction that teaches people to click through dialogs.
     *
     * @param {string} projectName
     * @returns {Promise<void>}
     */
    async unarchiveProject(projectName) {
        try {
            await window.API.unarchiveProject(projectName);
            await this.loadProjects();
        } catch (error) {
            console.error('Launchpad: failed to restore project:', error);
            this.showError('failed to restore project: '
                + (error && error.message ? error.message : 'the server could not be reached'));
        }
    }

    /**
     * Open the edit-project modal for ``project`` and persist any changes.
     *
     * Display name only - the folder on disk is never touched.
     */
    async editProject(project) {
        try {
            const result = await this.showEditProjectModal(project);
            if (!result) {
                return; // user cancelled
            }

            const { name: newName, description: newDescription } = result;
            const nameChanged = newName !== project.name;
            const descChanged = (newDescription || '') !== (project.description || '');

            if (!nameChanged && !descChanged) {
                return; // nothing to do
            }

            this.updateStatus(`updating ${project.name}...`);

            const fields = {};
            if (nameChanged) fields.newName = newName;
            if (descChanged) fields.description = newDescription;

            await window.API.updateProject(project.name, fields);

            console.log('Launchpad: Project updated:', project.name, '→', newName);

            // Refresh the list so the row reflects the new label
            await this.loadProjects();

            this.updateStatus('project updated');
        } catch (error) {
            console.error('Launchpad: Failed to update project:', error);
            this.showError('failed to update project: ' + error.message);
        }
    }

    /**
     * Show the edit-project modal pre-filled with the current name and
     * description. Resolves with ``{name, description}`` on save, or
     * ``null`` on cancel/escape/click-outside.
     *
     * Inline 409 conflicts are reported via ``API.updateProject`` rejecting
     * with an error whose ``message`` contains "already exists" - handled
     * by ``editProject`` via ``showError``.
     */
    showEditProjectModal(project) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const escapeHtml = (s) => String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» edit project</div>
                    <div class="modal-body">
                        <div class="modal-input-group">
                            <div class="modal-label">folder</div>
                            <div class="folder-picker-path">${escapeHtml(project.path)}</div>
                            <div class="modal-description">
                                the folder on disk is never renamed - only the launcher label changes.
                            </div>
                        </div>
                        <div class="modal-input-group">
                            <label class="modal-label">project name</label>
                            <input
                                type="text"
                                class="modal-input"
                                id="edit-project-name"
                                value="${escapeHtml(project.name)}"
                                autocomplete="off"
                            />
                        </div>
                        <div class="modal-input-group">
                            <label class="modal-label">description (optional)</label>
                            <input
                                type="text"
                                class="modal-input"
                                id="edit-project-description"
                                placeholder="e.g., Building an AI-powered chatbot"
                                value="${escapeHtml(project.description || '')}"
                                autocomplete="off"
                            />
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="edit-modal-cancel">cancel</button>
                        <button class="modal-btn modal-btn-primary" id="edit-modal-save">save</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const nameInput = overlay.querySelector('#edit-project-name');
            const descInput = overlay.querySelector('#edit-project-description');
            const saveBtn = overlay.querySelector('#edit-modal-save');
            const cancelBtn = overlay.querySelector('#edit-modal-cancel');

            // Focus name input and select existing content
            setTimeout(() => {
                nameInput.focus();
                nameInput.select();
            }, 100);

            const submit = () => {
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.focus();
                    return;
                }
                const description = descInput.value.trim();
                document.body.removeChild(overlay);
                resolve({ name, description });
            };

            const cancel = () => {
                document.body.removeChild(overlay);
                resolve(null);
            };

            // Enter on name → move to description; Enter on description → submit
            nameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (nameInput.value.trim()) {
                        descInput.focus();
                    }
                }
            });
            descInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                }
            });

            // Escape cancels
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    cancel();
                }
            });

            saveBtn.addEventListener('click', submit);
            cancelBtn.addEventListener('click', cancel);

            // Click outside cancels
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cancel();
                }
            });
        });
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
     * Show confirmation modal.
     *
     * Thin delegate to `App.showConfirmModal()` - that is the ONE
     * confirmation-modal implementation in the app (title/message
     * escaping, Escape/cancel/click-outside handling, focus management
     * all live there). Kept as a same-named method here purely so the
     * launchpad's existing call sites (delete project, kill running
     * session, reset server) don't need to change; do not re-implement
     * the modal here.
     * @param {string} title - Modal title
     * @param {string} message - Main message
     * @param {string} [details] - Additional details (optional)
     * @param {string} [primaryLabel='confirm'] - Label for the primary (destructive / intent) button
     * @param {string} [secondaryLabel='cancel'] - Label for the safe no-op button
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled. Cancel is ALWAYS a no-op - callers must never map cancel to a destructive action.
     */
    showConfirmModal(title, message, details = null, primaryLabel = 'confirm', secondaryLabel = 'cancel') {
        return window.App.showConfirmModal(title, message, details, primaryLabel, secondaryLabel);
    }

    /**
     * Present a one-of-N choice as a modal and resolve the chosen key.
     *
     * Description: the shared list-picker behind "new claude project" and
     *   "new session". Reuses the folder-picker visual language already
     *   in this file (``.folder-picker-list`` / ``.folder-picker-item``)
     *   rather than inventing a second kind of list. A row may be
     *   DISABLED with a stated reason, which is how a project whose
     *   presence is 'missing' or 'unreachable' stays VISIBLE and NAMED
     *   while refusing to be opened, matching the row treatment on the
     *   home screen itself. When there is nothing to choose from, the
     *   caller's own message is shown instead of an empty box, because
     *   "you have none" and "I could not find out" are different answers
     *   and the caller is the only one that knows which it has.
     * Inputs: options ({title: string, hint?: string, items:
     *   Array<{key: string, label: string, sub?: string,
     *   disabled?: boolean, reason?: string}>, emptyMessage?: string,
     *   emptyKind?: string}).
     * Output: Promise<?string> - the chosen item's key, or null when the
     *   user cancelled or there was nothing selectable.
     * Example: const how = await lp._showChoiceModal({title: 'new claude
     *   project', items: [{key: 'empty', label: 'start empty'}]});
     */
    _showChoiceModal(options) {
        const {
            title = 'choose',
            hint = 'up/down to move . enter to choose . esc to cancel',
            items = [],
            emptyMessage = null,
            emptyKind = 'info',
        } = options || {};
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            const rowsHtml = items.length
                ? items.map((it, i) => {
                    const cls = it.disabled
                        ? 'folder-picker-item folder-picker-item-disabled'
                        : 'folder-picker-item';
                    const sub = it.disabled && it.reason
                        ? `<div class="folder-picker-item-sub">${this._escapeHtml(it.reason)}</div>`
                        : (it.sub ? `<div class="folder-picker-item-sub">${this._escapeHtml(it.sub)}</div>` : '');
                    return `<div class="${cls}" data-choice-index="${i}"${it.disabled ? ' aria-disabled="true"' : ''}>`
                        + `<div class="folder-picker-item-label">${this._escapeHtml(it.label)}</div>${sub}</div>`;
                }).join('')
                : `<div class="folder-picker-empty folder-picker-empty--${this._escapeHtml(emptyKind)}">${this._escapeHtml(emptyMessage || 'nothing to choose from')}</div>`;
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">&raquo; ${this._escapeHtml(title)}</div>
                    <div class="modal-body">
                        <div class="folder-picker-list" tabindex="-1">${rowsHtml}</div>
                        <div class="modal-description">${this._escapeHtml(items.length ? hint : 'esc to close')}</div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" data-choice-cancel>${items.length ? 'cancel' : 'ok'}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const rowEls = Array.from(overlay.querySelectorAll('.folder-picker-item'));
            const selectable = rowEls
                .map((el, i) => (items[i] && !items[i].disabled ? i : -1))
                .filter((i) => i >= 0);
            let active = selectable.length ? selectable[0] : -1;

            const paint = () => {
                rowEls.forEach((el, i) => {
                    el.classList.toggle('folder-picker-item-active', i === active);
                });
                if (active >= 0 && rowEls[active]) {
                    rowEls[active].scrollIntoView({ block: 'nearest' });
                }
            };
            const close = (value) => {
                document.removeEventListener('keydown', onKey, true);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(value);
            };
            const step = (dir) => {
                if (!selectable.length) return;
                const at = selectable.indexOf(active);
                const next = at < 0 ? 0 : (at + dir + selectable.length) % selectable.length;
                active = selectable[next];
                paint();
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
                if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); return; }
                if (e.key === 'Enter') {
                    e.preventDefault(); e.stopPropagation();
                    if (active >= 0 && items[active] && !items[active].disabled) close(items[active].key);
                }
            };
            document.addEventListener('keydown', onKey, true);
            rowEls.forEach((el, i) => {
                el.addEventListener('click', () => {
                    if (!items[i] || items[i].disabled) return;
                    close(items[i].key);
                });
            });
            overlay.querySelector('[data-choice-cancel]').addEventListener('click', () => close(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
            paint();
        });
    }

    /**
     * The "new claude project" entrypoint, with clone-from-github AND
     * open-from-folder folded in as options.
     *
     * Description: "create new project" never said which agent it was
     *   creating for, and cloning a repo sat beside it as a peer even
     *   though a clone IS a new claude project, just one whose contents
     *   arrive from a remote. This asks how the project should start,
     *   then routes into the three existing flows unchanged - no launch
     *   logic is duplicated or reimplemented here.
     *
     *   "open an existing folder" joined this list for the same reason
     *   the clone did: all three make a claude project, and they differ
     *   only in where the folder comes from - made fresh, cloned from a
     *   remote, or already on disk. It used to be a peer of "new claude
     *   project" in the top-level add menu, which put a THIRD entry point
     *   in front of the user for a decision that is really one branch
     *   inside a single flow. Each option routes straight into the method
     *   that already implemented it, so this method holds no launch logic
     *   of its own and there is nothing here to drift.
     *
     * Inputs: none.
     * Output: Promise<void> - resolves once the chosen flow finishes, or
     *   immediately when the user cancels.
     * Example: await lp.startNewClaudeProject();
     */
    async startNewClaudeProject() {
        const how = await this._showChoiceModal({
            title: 'new claude project',
            items: [
                { key: 'empty', label: 'start empty', sub: 'a fresh working folder' },
                { key: 'clone', label: 'clone from github', sub: 'start from an existing repository' },
                { key: 'folder', label: 'open an existing folder', sub: 'a folder already on this machine' },
            ],
        });
        if (how === 'empty') return this.createNewSession();
        if (how === 'clone') return this.showCloneFromGithubModal();
        if (how === 'folder') return this.openProjectFromFolder();
        return undefined;
    }

    /**
     * The "new session" entrypoint: add a session to a project that
     * ALREADY exists, and never create one.
     *
     * Description: three outcomes, kept distinct. If the project list was
     *   never read successfully (``projectsListingOk === false``) it says
     *   CANNOT DETERMINE and refuses, because an empty list after a failed
     *   fetch is not evidence that there are no projects. If the list WAS
     *   read and is genuinely empty, it says so and points at "new claude
     *   project" instead of opening an empty picker. Otherwise it offers
     *   the projects, with 'missing' and 'unreachable' rows visible,
     *   named and refused exactly as they are on the home screen.
     * Inputs: none.
     * Output: Promise<void>.
     * Example: await lp.startSessionInExistingProject();
     */
    async startSessionInExistingProject() {
        if (this.projectsListingOk === false) {
            await this._showChoiceModal({
                title: 'new session',
                items: [],
                emptyMessage: 'CANNOT DETERMINE which projects you have: the project list could not be read. '
                    + 'This is not a claim that you have none.',
                emptyKind: 'unknown',
            });
            return;
        }
        const projects = this.projects || [];
        if (projects.length === 0) {
            await this._showChoiceModal({
                title: 'new session',
                items: [],
                emptyMessage: 'no claude projects yet. use "new claude project" to make one first.',
                emptyKind: 'info',
            });
            return;
        }
        const items = projects.map((p) => {
            const presenceRow = (p.root && this.projectPresence.get(p.root))
                || this.projectPresence.get(p.path);
            const presence = presenceRow ? presenceRow.presence : 'unchecked';
            const reason = presence === 'missing'
                ? 'MISSING - folder not found'
                : (presence === 'unreachable'
                    ? `CANNOT DETERMINE - ${(presenceRow && presenceRow.presence_detail) || 'reason unknown'}`
                    : null);
            return {
                key: p.name,
                label: p.name,
                sub: p.path,
                disabled: presence === 'missing' || presence === 'unreachable',
                reason,
            };
        });
        const chosen = await this._showChoiceModal({
            title: 'new session in which project',
            items,
        });
        if (!chosen) return;
        const project = projects.find((p) => p.name === chosen);
        if (!project) return;
        await this.selectProject(project);
    }

    /**
     * Create new project with auto-generated workspace.
     * Default behavior - server falls back to ProjectConfig.agent_type
     * or "claude". Does NOT send agent_type in the payload.
     */
    async createNewSession() {
        return this._createNewSessionInner(null);
    }

    /**
     * Create new project pinned to a specific agent (openclaw, hermes, codex).
     * Sends agent_type in the createSession payload so the backend spawns
     * the matching CLI (configured in src/config.py AgentsConfig).
     */
    async createNewSessionWithAgent(agentType) {
        return this._createNewSessionInner(agentType);
    }

    /**
     * Create a plain "console" tmux session in ~/ running $SHELL - no
     * Claude/codex/hermes/openclaw. For quick shell work straight from the
     * launchpad.
     *
     * Auto-generates a name (console-<base36 ts>) - no modal prompt, since
     * a bare shell isn't a "project" in the conventional sense. Still
     * registers a Recent Projects entry so a killed pane can be relaunched
     * the same way every other create path works.
     *
     * @param {{terminalCommandId?: string}} [options] - when
     *   terminalCommandId is set (settings > terminal tab, "run"), the
     *   server types that configured command into the new pane once the
     *   shell is up. Only the ID travels: the command text is read from
     *   config.json server-side and never accepted from the client, and
     *   nothing is exec'd outside this visible tmux pane. See
     *   src/core/terminal_commands.py.
     */
    async createConsoleSession(options = {}) {
        const terminalCommandId = options.terminalCommandId || null;
        console.log('Launchpad: Creating new console session', terminalCommandId || '');

        const sessionName = `console-${Date.now().toString(36)}`;

        try {
            this.updateStatus('creating new console...');

            const _dims = this._getTerminalDims();
            const payload = {
                auto_start_claude: true,   // server gates on this to spawn the command
                copy_templates: false,
                project_name: sessionName,
                working_dir: '~',          // server-side os.path.expanduser
                agent_type: 'shell',
                ...(terminalCommandId ? { terminal_command_id: terminalCommandId } : {}),
                ..._dims
            };
            const session = await window.API.createSession(payload);

            console.log('Launchpad: New console created:', session);

            // Auto-add the project entry (mirrors _createNewSessionInner).
            try {
                await window.API.createProject({
                    name: sessionName,
                    path: session.working_dir,
                    description: 'console session',
                });
            } catch (error) {
                if (!error.message.includes('already exists')) {
                    console.error('Launchpad: Failed to save console project:', error);
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

            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to create console session:', error);
            if (error.message && error.message.includes('already running')) {
                // Reuse the same detach-and-create handoff the agent paths use.
                this.detachAndCreateNew('shell');
            } else {
                this.showError('failed to create console: ' + (error.message || error));
            }
        }
    }

    /**
     * Inner implementation for createNewSession / createNewSessionWithAgent.
     * @param {string|null} agentType - 'openclaw' | 'hermes' | 'codex' | null
     *   When null, agent_type is OMITTED from the payload (preserves server
     *   fallback behavior for the default "+ new project" FAB action).
     */
    async _createNewSessionInner(agentType = null) {
        console.log('Launchpad: Creating new project', agentType ? `(agent: ${agentType})` : '');

        try {
            // Gate: pick claude vs an OpenRouter model BEFORE asking for a
            // project name. Keyboard-first, defaults to the last choice -
            // this is the hot path of every launch so it must be
            // dismissable in one keystroke. null = user cancelled the
            // whole launch.
            const providerChoice = await this.showProviderModal();
            if (!providerChoice) {
                console.log('Launchpad: Provider selection cancelled');
                return;
            }

            // Show modal to get project details. Title reflects the agent
            // so users know which CLI is about to spawn in the new pane.
            const modalTitle = agentType
                ? `name this ${agentType} project`
                : 'name this project';

            // The name has to be usable as a folder name, because it now
            // IS one. An illegal name is refused and re-asked with what
            // was typed still in the field - never silently rewritten,
            // which would make a folder the user did not ask for.
            let projectDetails = null;
            let prefillName = '';
            for (;;) {
                projectDetails = await this.showProjectNameModal({
                    title: modalTitle,
                    defaultName: prefillName,
                });
                if (!projectDetails) {
                    console.log('Launchpad: Project creation cancelled');
                    return; // User cancelled
                }
                const nameVerdict = window.ProjectCreateFolder.validateName(projectDetails.name);
                if (nameVerdict.ok) break;
                this.showError(nameVerdict.message);
                prefillName = projectDetails.name;
            }

            // The folder step. Until this shipped nothing asked where the
            // project should live, so the server fell back to naming the
            // directory after a random session id (".../ses_5a756046").
            // Cancelling here cancels the launch: no session, no folder.
            const folderChoice = await window.ProjectCreateFolder.choose({
                name: projectDetails.name,
            });
            if (!folderChoice) {
                console.log('Launchpad: Project folder selection cancelled');
                return;
            }

            // Show loading state
            this.updateStatus(
                agentType
                    ? `creating new ${agentType} project...`
                    : 'creating new project...'
            );

            // Create session with auto-generated path and template copying.
            // Include current xterm cell grid dims so the tmux pane is
            // birthed at the right size (avoids the 132x40 default → resize
            // flash before the WS handshake reshapes it).
            const _dims = this._getTerminalDims();
            const payload = {
                auto_start_claude: true,
                copy_templates: true,
                project_name: projectDetails.name,
                // The chosen PARENT, not the composed path. The server
                // joins it to project_name itself and canonicalises with
                // realpath, so the directory it creates and the row's
                // working_dir carry the long spelling of a symlinked
                // parent rather than whatever the client happened to
                // display. See src/core/project_directory.py.
                project_parent_dir: folderChoice.parent,
                // ONE NAME, SET AT BIRTH. The server turns a non-empty
                // label into `--name <label>` on the launch command, so
                // the row title and the name claude calls itself are the
                // same string from the first frame. Without it this flow
                // launched claude with no name at all and the TUI status
                // line showed the directory instead.
                label: projectDetails.name,
                ..._dims
            };
            // Only include agent_type when explicitly set, so the server's
            // existing fallback chain (ProjectConfig.agent_type → "claude")
            // continues to work for the default "new-project" button.
            // feat/launch-wrappers - a wrapper choice from the provider
            // modal (providerChoice.wrapperId) ONLY applies when no
            // explicit agentType was already forced by the caller (e.g.
            // the openclaw/hermes/codex quick-connect buttons) - those
            // win outright, matching the pre-wrappers precedence for
            // agent_type.
            if (agentType) {
                payload.agent_type = agentType;
            } else if (providerChoice.wrapperId) {
                payload.agent_type = providerChoice.wrapperId;
            } else if (providerChoice.agentType) {
                // A PINNED FAMILY ROW (codex / hermes / openclaw). The
                // family name IS the agent_type, exactly as the reserved
                // quick-connect buttons above have always posted it, so
                // the server resolves it through the same path. Ranked
                // below wrapperId only because the two are mutually
                // exclusive by construction - the picker returns one or
                // the other, never both.
                payload.agent_type = providerChoice.agentType;
            }
            // Omit for claude (server default); set for an OpenRouter model.
            if (providerChoice.model) {
                payload.model = providerChoice.model;
            }
            const session = await window.API.createSession(payload);

            console.log('Launchpad: New project created:', session);

            // Save project to config with the actual path from the session
            try {
                await window.API.createProject({
                    name: projectDetails.name,
                    path: session.working_dir,
                    description: projectDetails.description || null
                });
                console.log('Launchpad: Project saved to config');
            } catch (error) {
                // If project already exists, that's ok - continue anyway
                if (!error.message.includes('already exists')) {
                    console.error('Launchpad: Failed to save project:', error);
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

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to create session:', error);

            // If a session already exists, the user's stated intent was
            // "create a new project" - carry it out immediately. The prior
            // tmux session is detached (not killed) and stays available in
            // the running-sessions list / banner for rejoin.
            if (error.message.includes('already running')) {
                this.detachAndCreateNew(agentType);
            } else {
                this.showError('failed to create session: ' + error.message);
            }
        }
    }

    /**
     * Show modal to prompt for project name and description
     * @param {object} [options]
     * @param {string} [options.defaultName] - Prefill the name input
     * @param {string} [options.title] - Override the modal title
     * @param {string} [options.confirmLabel] - Override the confirm button label
     * @param {string} [options.pathHint] - Display the path being added as a hint
     * @returns {Promise<{name: string, description: string}|null>} Project details or null if cancelled
     */
    showProjectNameModal(options = {}) {
        const {
            defaultName = '',
            title = 'name this project',
            confirmLabel = 'create session',
            pathHint = null,
        } = options;

        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const escapeHtml = (s) => String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const pathHintHtml = pathHint
                ? `<div class="modal-input-group"><div class="modal-label">folder</div><div class="folder-picker-path">${escapeHtml(pathHint)}</div></div>`
                : '';

            // Create modal content
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» ${escapeHtml(title)}</div>
                    <div class="modal-body">
                        ${pathHintHtml}
                        <div class="modal-input-group">
                            <label class="modal-label">project name</label>
                            <input
                                type="text"
                                class="modal-input"
                                id="modal-project-name"
                                placeholder="e.g., My Awesome Project"
                                value="${escapeHtml(defaultName)}"
                                autocomplete="off"
                            />
                            <div class="modal-description">
                                give your project a memorable name. you can reconnect to it later from the launcher.
                            </div>
                        </div>
                        <div class="modal-input-group">
                            <label class="modal-label">description (optional)</label>
                            <input
                                type="text"
                                class="modal-input"
                                id="modal-project-description"
                                placeholder="e.g., Building an AI-powered chatbot"
                                autocomplete="off"
                            />
                            <div class="modal-description">
                                add a short description to help remember what this project is about.
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="modal-cancel">cancel</button>
                        <button class="modal-btn modal-btn-primary" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const nameInput = overlay.querySelector('#modal-project-name');
            const descInput = overlay.querySelector('#modal-project-description');
            const confirmBtn = overlay.querySelector('#modal-confirm');
            const cancelBtn = overlay.querySelector('#modal-cancel');

            // Focus name input and select existing content if prefilled
            setTimeout(() => {
                nameInput.focus();
                if (defaultName) {
                    nameInput.select();
                }
            }, 100);

            // Handle Enter key on name input (moves to description)
            nameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (nameInput.value.trim()) {
                        descInput.focus();
                    }
                }
            });

            // Handle Enter key on description input (submits)
            descInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const name = nameInput.value.trim();
                    if (name) {
                        const description = descInput.value.trim();
                        document.body.removeChild(overlay);
                        resolve({ name, description });
                    } else {
                        nameInput.focus();
                    }
                }
            });

            // Handle Escape key
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    document.body.removeChild(overlay);
                    resolve(null);
                }
            });

            // Handle confirm button
            confirmBtn.addEventListener('click', () => {
                const name = nameInput.value.trim();
                if (name) {
                    const description = descInput.value.trim();
                    document.body.removeChild(overlay);
                    resolve({ name, description });
                } else {
                    nameInput.focus();
                }
            });

            // Handle cancel button
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(null);
            });

            // Handle click outside modal
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Show the "clone from github" modal - collects URL + parent dir +
     * description, calls the backend ``POST /projects/clone`` endpoint
     * (which runs ``gh repo clone``), then refreshes the project list and
     * lands the user in a session pointed at the freshly cloned folder.
     *
     * Errors are surfaced inline (no alert()) and mapped from HTTP status:
     *   401 → gh auth failed
     *   404 → repo not found / no access
     *   409 → folder or project name collision
     *   503 → gh CLI missing on server
     *   504 → clone took >5 min
     *   other → server-provided detail text.
     */
    async showCloneFromGithubModal() {
        // Gate: pick claude vs an OpenRouter model BEFORE showing the clone
        // form. The backend's POST /projects/clone both clones the repo to
        // disk AND persists the project entry in one shot, so that request
        // must never fire before the user has committed to launching -
        // null = cancelled, back to the launchpad, nothing touched.
        const providerChoice = await this.showProviderModal();
        if (!providerChoice) {
            console.log('Launchpad: Provider selection cancelled');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const escapeHtml = (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        overlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">» clone from github</div>
                <div class="modal-body">
                    <div class="modal-input-group">
                        <label class="modal-label">github repo url</label>
                        <input
                            type="text"
                            class="modal-input"
                            id="modal-clone-url"
                            placeholder="https://github.com/owner/repo or owner/repo"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        <div class="modal-description">
                            paste the full url or use gh shorthand (owner/repo). server runs <code>gh repo clone</code> - gh must be authenticated.
                        </div>
                    </div>
                    <div class="modal-input-group">
                        <label class="modal-label">parent directory</label>
                        <input
                            type="text"
                            class="modal-input"
                            id="modal-clone-parent"
                            placeholder="~/projects"
                            value="~/projects"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        <div class="modal-description">
                            the cloned folder will be created inside this directory.
                        </div>
                    </div>
                    <div class="modal-input-group">
                        <label class="modal-label">description (optional)</label>
                        <input
                            type="text"
                            class="modal-input"
                            id="modal-clone-description"
                            placeholder="e.g., upstream library i'm patching"
                            autocomplete="off"
                        />
                    </div>
                    <div class="modal-description" id="modal-clone-status" style="display:none;"></div>
                </div>
                <div class="modal-footer">
                    <button class="modal-btn modal-btn-secondary" id="modal-clone-cancel">cancel</button>
                    <button class="modal-btn modal-btn-primary" id="modal-clone-confirm">clone &amp; open</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const urlInput = overlay.querySelector('#modal-clone-url');
        const parentInput = overlay.querySelector('#modal-clone-parent');
        const descInput = overlay.querySelector('#modal-clone-description');
        const confirmBtn = overlay.querySelector('#modal-clone-confirm');
        const cancelBtn = overlay.querySelector('#modal-clone-cancel');
        const statusEl = overlay.querySelector('#modal-clone-status');

        let busy = false;

        const closeModal = () => {
            if (overlay.parentNode) {
                document.body.removeChild(overlay);
            }
        };

        const setStatus = (msg, isError = false) => {
            statusEl.style.display = msg ? 'block' : 'none';
            statusEl.textContent = msg;
            statusEl.style.color = isError ? '#d77757' : '';
        };

        const mapErrorToMessage = (error) => {
            // api.js throws Error(errorData.detail || `HTTP <code>`). Match
            // on signature substrings the backend embeds in its detail text.
            const msg = String(error && error.message || error || '');
            const lower = msg.toLowerCase();
            if (lower.includes('not authenticated') || lower.includes('auth/network') || lower.includes('gh auth login')) {
                return 'gh CLI not authenticated. run `gh auth login` in a terminal on the server.';
            }
            if (lower.includes('repository not found') || lower.includes('repo not found') || lower.startsWith('not found')) {
                return 'repo not found or no access. check the url and your gh auth scopes.';
            }
            if (lower.includes('already exists')) {
                return 'folder or project name already exists.';
            }
            if (lower.includes('gh cli not') || lower.includes('install with `brew install gh`')) {
                return 'gh CLI not installed on server. install with `brew install gh`.';
            }
            if (lower.includes('timed out') || lower.includes('timeout')) {
                return 'clone timed out after 5 minutes.';
            }
            // Strip a bare "HTTP NNN" prefix if api.js fell back to it.
            const cleaned = msg.replace(/^HTTP\s+\d{3}:?\s*/i, '').trim();
            return cleaned || 'clone failed.';
        };

        const submit = async () => {
            if (busy) return;
            const repoUrl = urlInput.value.trim();
            if (!repoUrl) {
                setStatus('paste a github url first.', true);
                urlInput.focus();
                return;
            }
            const parentDir = parentInput.value.trim() || '~/projects';
            const description = descInput.value.trim();

            busy = true;
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            urlInput.disabled = true;
            parentInput.disabled = true;
            descInput.disabled = true;
            setStatus('cloning... (may take a minute)');

            try {
                const project = await window.API.cloneProjectFromGithub({
                    repoUrl,
                    parentDir,
                    description: description || undefined,
                });
                // Success - refresh project list, close modal, open session
                // in the cloned dir. selectProject does the heavy lifting.
                await this.loadProjects();
                closeModal();
                // Provider already chosen above - pass it through so
                // selectProject doesn't prompt a second time.
                await this.selectProject({
                    name: project.name,
                    path: project.path,
                    description: project.description || null,
                }, providerChoice);
            } catch (error) {
                console.error('Launchpad: clone-from-github failed:', error);
                setStatus(mapErrorToMessage(error), true);
                busy = false;
                confirmBtn.disabled = false;
                cancelBtn.disabled = false;
                urlInput.disabled = false;
                parentInput.disabled = false;
                descInput.disabled = false;
            }
        };

        // Focus url input.
        setTimeout(() => urlInput.focus(), 100);

        // Enter on url → focus parent. Enter on parent → focus desc.
        // Enter on desc → submit. Escape anywhere → cancel.
        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (urlInput.value.trim()) parentInput.focus();
            }
        });
        parentInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                descInput.focus();
            }
        });
        descInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !busy) {
                closeModal();
            }
        });

        confirmBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => {
            if (!busy) closeModal();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !busy) closeModal();
        });
    }

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
                if (agentType) {
                    this.createNewSessionWithAgent(agentType);
                } else {
                    this.createNewSession();
                }
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
     * Open a project by picking a folder via the server-side filesystem browser,
     * then save it to the project list (history) before opening.
     */
    async openProjectFromFolder() {
        console.log('Launchpad: Opening project from folder');

        try {
            const selectedPath = await this.showFolderPickerModal();
            if (!selectedPath) {
                console.log('Launchpad: Folder selection cancelled');
                return;
            }

            // Derive a default name from the folder basename
            const defaultName = selectedPath.split('/').filter(Boolean).pop() || selectedPath;

            // Ask the user to confirm/adjust name + description
            const details = await this.showProjectNameModal({
                defaultName,
                title: 'add project',
                confirmLabel: 'open project',
                pathHint: selectedPath,
            });
            if (!details) {
                console.log('Launchpad: Project metadata entry cancelled');
                return;
            }

            // Gate: pick claude vs an OpenRouter model BEFORE persisting
            // anything. null = user cancelled the whole launch - abort
            // cleanly with no project entry written to config.json (avoids
            // orphaning a project row for a session that was never created).
            const providerChoice = await this.showProviderModal();
            if (!providerChoice) {
                console.log('Launchpad: Provider selection cancelled');
                return;
            }

            this.updateStatus(`adding ${details.name}...`);

            // Save to projects config so it shows up in history.
            // If the name collides, append a short suffix until it's unique.
            const savedName = await this.saveProjectWithUniqueName({
                name: details.name,
                path: selectedPath,
                description: details.description || null,
            });

            // Refresh project list so the new entry shows up at the top
            await this.loadProjects();

            // Open the project (provider already chosen above - pass it
            // through so selectProject doesn't prompt a second time).
            await this.selectProject({
                name: savedName,
                path: selectedPath,
                description: details.description || null,
            }, providerChoice);
        } catch (error) {
            console.error('Launchpad: Failed to open project from folder:', error);
            this.showError('failed to open folder: ' + error.message);
        }
    }

    /**
     * Try to save a project, appending a suffix if the name already exists.
     * Returns the name that was actually saved, or the original name if the
     * project already existed (we treat that as success).
     */
    async saveProjectWithUniqueName({ name, path, description }) {
        let attempt = name;
        for (let i = 0; i < 20; i++) {
            try {
                await window.API.createProject({
                    name: attempt,
                    path,
                    description,
                });
                return attempt;
            } catch (error) {
                if (!error.message || !error.message.includes('already exists')) {
                    throw error;
                }
                // If an existing project already has this path, reuse it
                const existing = this.projects.find(p => p.path === path);
                if (existing) {
                    return existing.name;
                }
                attempt = `${name} (${i + 2})`;
            }
        }
        throw new Error('could not find a unique name for this project');
    }

    /**
     * Show a folder-picker modal that browses the server filesystem.
     * Resolves with the chosen absolute path, or null if cancelled.
     *
     * The modal itself lives in client/js/folder-picker-modal.js; this is
     * the delegate. It reads no controller state beyond the escaper it
     * passes in, which is why it was the unit that could come out.
     */
    showFolderPickerModal() {
        return window.FolderPickerModal.open({
            escapeHtml: (s) => this._escapeHtml(s)
        });
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
