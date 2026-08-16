/**
 * Launchpad Module - Project selection UI with terminal aesthetic
 */

console.log('[Launchpad Module] Loading...');

class Launchpad {
    constructor() {
        this.launchpadScreen = null;
        this.projects = [];
        // Running tmux sessions on the `cloude` socket. Populated by
        // loadRunningSessions() — a merged view of:
        //   (a) the currently-active backend (from GET /sessions), and
        //   (b) attachable/external sessions (from GET /sessions/attachable).
        // Each row carries an is_active flag so the render pass can style
        // the live one differently without a second DOM query.
        this.runningSessions = [];
        // GUARD (deep-link duplicate-session regression fix): set true
        // for the duration of openProjectByName()'s resolution. selectProject()
        // checks this flag and refuses to create a session while it's set —
        // see openProjectByName()'s docstring and selectProject()'s guard
        // clause. This makes "deep-link resolution never creates" an
        // enforced invariant rather than an implicit property of call
        // order, so a future edit that re-wires openProjectByName() into
        // selectProject() fails loudly instead of silently regressing.
        this._resolvingDeepLink = false;
    }

    /**
     * Initialize launchpad screen
     */
    init() {
        this.launchpadScreen = document.getElementById('launchpad-screen');
        this.renderLaunchpadUI();
        // Wire the inline "+ new" speed-dial FAB. Markup was just injected
        // by renderLaunchpadUI() into the right side of the "recent
        // projects" section heading row; the 3 sub-actions route back
        // into the same handlers the old inline "new project" section used.
        this.setupNewFab();
        // Note: loadProjects() will be called by App.showLaunchpad()
        this._startRunningSessionsPoller();
    }

    /**
     * Wire the inline "+ new" speed-dial FAB.
     *
     * Markup is injected by renderLaunchpadUI() into the right side of
     * the "recent projects" section heading row (#new-fab). Three
     * sub-actions route into the same handlers the old inline "new
     * project" section used — no logic duplicated. Idempotent: safe to
     * call multiple times (guarded by a flag).
     *
     * Because the FAB lives inside #launchpad-screen, it shows/hides
     * naturally with the screen — no separate visibility plumbing
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
            console.warn('Launchpad: new-fab markup missing — skipping wire');
            return;
        }

        // Map the FAB's data-action attrs onto our existing handlers.
        // Wrapped so `this` resolves correctly inside the dispatch table.
        const actions = {
            'new-project':      () => this.createNewSession(),
            'open-folder':      () => this.openProjectFromFolder(),
            'clone-github':     () => this.showCloneFromGithubModal(),
            'connect-openclaw': () => this.createNewSessionWithAgent('openclaw'),
            'connect-hermes':   () => this.createNewSessionWithAgent('hermes'),
            'new-console':      () => this.createConsoleSession(),
        };

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleNewFab();
        });

        // Item dispatch via delegation — survives any future re-render
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
     * Open the FAB menu (idempotent).
     */
    openNewFab() {
        const fab = document.getElementById('new-fab');
        const trigger = document.getElementById('new-fab-trigger');
        const backdrop = document.getElementById('new-fab-backdrop');
        if (!fab || !trigger || !backdrop) return;
        fab.classList.add('new-fab--open');
        trigger.setAttribute('aria-expanded', 'true');
        backdrop.hidden = false;
        backdrop.setAttribute('data-open', '1');
        // Make menu items focusable when open
        fab.querySelectorAll('.new-fab__item').forEach(it => it.setAttribute('tabindex', '0'));
    }

    /**
     * Close the FAB menu (idempotent — also called from app.js when
     * the launchpad screen is being torn down).
     */
    closeNewFab() {
        const fab = document.getElementById('new-fab');
        const trigger = document.getElementById('new-fab-trigger');
        const backdrop = document.getElementById('new-fab-backdrop');
        if (!fab) return;
        fab.classList.remove('new-fab--open');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (backdrop) {
            backdrop.removeAttribute('data-open');
            // Hide after the fade-out so it doesn't intercept clicks
            setTimeout(() => { backdrop.hidden = true; }, 200);
        }
        fab.querySelectorAll('.new-fab__item').forEach(it => it.setAttribute('tabindex', '-1'));
    }

    /**
     * Kick off a 5s interval that re-fetches the running-sessions list.
     *
     * Idempotent — guarded by ``this._runningPollInterval`` so repeated
     * calls (e.g. re-entering the launchpad after a session swap) don't
     * stack multiple intervals. Auth-gated per tick: skips the fetch
     * entirely when the user isn't logged in, so we don't hammer /sessions
     * with anonymous requests before the OTP flow completes.
     *
     * Runs forever; does not pause on tab hide — external tmux sessions
     * born while the tab is backgrounded should still surface the moment
     * the user returns.
     */
    _startRunningSessionsPoller() {
        if (this._runningPollInterval) return;
        this._runningPollInterval = setInterval(() => {
            if (!(window.Auth && typeof window.Auth.isAuthenticated === 'function' && window.Auth.isAuthenticated())) {
                return;
            }
            this.loadRunningSessions().catch(err => {
                console.warn('Launchpad: running-sessions poll tick failed:', err);
            });
        }, 5000);
        console.log('Launchpad: running-sessions poller started (5s)');
    }

    /**
     * Best-effort: get current xterm cell-grid dims from the live Terminal
     * instance so we can pass them to POST /sessions. Returns {} when the
     * terminal isn't ready yet (the server falls back to its own defaults
     * and the WS handshake reshapes shortly after anyway).
     */
    _getTerminalDims() {
        try {
            const t = window.TerminalController && window.TerminalController.term;
            if (t && typeof t.cols === 'number' && typeof t.rows === 'number'
                    && t.cols > 0 && t.rows > 0) {
                // Try to fit first so we hand over the dims the xterm.js
                // renderer will actually use post-connect.
                try {
                    if (window.TerminalController.fitAddon) {
                        window.TerminalController.fitAddon.fit();
                    }
                } catch (_) { /* non-fatal */ }
                return { cols: t.cols, rows: t.rows };
            }
        } catch (e) {
            console.warn('Launchpad: _getTerminalDims failed', e);
        }
        return {};
    }

    /**
     * Load and display projects, then refresh the running-sessions list.
     * Both fetches are non-fatal — the projects error path shows a UI
     * error, the sessions path is logged and silently renders empty.
     */
    async loadProjects() {
        try {
            this.projects = await window.API.getProjects();
            this.renderProjectList();
        } catch (error) {
            console.error('Launchpad: Failed to load projects:', error);
            this.showError('failed to load projects: ' + error.message);
        }
        // Refresh running sessions in parallel with the projects view.
        // Failure is non-fatal and handled inside loadRunningSessions.
        this.loadRunningSessions();
    }

    /**
     * Fetch the unified "running sessions" list and repaint the section.
     *
     * Combines two server endpoints:
     *   - ``GET /sessions/attachable`` — external tmux sessions on the
     *     cloude socket, plus cloude-owned sessions NOT currently bound
     *     to an active backend (detached-but-alive).
     *   - ``GET /sessions`` — the currently-active backend, if any. The
     *     server's /attachable filter drops this row to prevent a
     *     self-adopt footgun, so we refetch and merge it in here.
     *
     * Each merged row gains an ``is_active`` flag and the list is sorted:
     * active first, then owned (cloude-created), then external; within
     * each bucket, newest first by ``created_at_epoch``.
     */
    async loadRunningSessions() {
        try {
            const list = await window.API.listAttachableSessions();
            this.runningSessions = Array.isArray(list) ? list : [];
        } catch (err) {
            // Surface the failure loud + observable in DevTools instead of
            // swallowing it — a silent catch here was masking 401s / CORS /
            // stale-cache bugs where mobile browsers would render an empty
            // section with zero diagnostic trail. Keep the [] fallback so
            // the rest of the render pipeline stays stable.
            //
            // Status extraction: the `call()` wrapper in api.js throws
            // Error("HTTP <code>") for non-401s and Error("Authentication
            // required...") for 401s after refresh fails. Parse what we
            // can from the message so the log line is actionable.
            let status = null;
            if (err && typeof err.status === 'number') {
                status = err.status;
            } else if (err && typeof err.message === 'string') {
                const m = err.message.match(/HTTP\s+(\d{3})/);
                if (m) status = parseInt(m[1], 10);
                else if (/Authentication required/i.test(err.message)) status = 401;
            }
            console.error(
                '[launchpad] loadRunningSessions failed:',
                status !== null ? `status=${status}` : '(no status)',
                err
            );
            // On 401, fire a reauth event for the auth layer to pick up.
            // NOTE: api.js:call() already dispatches `auth-required` on 401
            // after refresh fails, so this is defense-in-depth only. If
            // Auth.js doesn't listen for `cloude:reauth-needed` that's fine
            // — `auth-required` remains the primary signal.
            if (status === 401) {
                try {
                    window.dispatchEvent(new CustomEvent('cloude:reauth-needed', {
                        detail: { source: 'launchpad.loadRunningSessions' }
                    }));
                } catch (_) { /* non-fatal */ }
            }
            this.runningSessions = [];
        }
        // Augment with EVERY currently-live session, which the server
        // filters out of /sessions/attachable to prevent self-adopt.
        // Multi-session: two tabs can each be on a different session, so
        // we pull the full list via GET /sessions/list (oldest first) and
        // merge each one in, tagging is_active + carrying its session id.
        try {
            let liveSessions = [];
            if (typeof window.API.listSessions === 'function') {
                liveSessions = await window.API.listSessions();
            }
            if (!Array.isArray(liveSessions) || liveSessions.length === 0) {
                // Back-compat fallback: single-session server.
                const current = await window.API.getCurrentSession();
                liveSessions = current ? [current] : [];
            }
            for (const live of liveSessions) {
                const tmuxName = live && live.tmux_session;
                if (!tmuxName) continue;
                // activity_status comes from the server's bulk tmux pane
                // query (src/core/session_status.py) — 'running' | 'idle' |
                // 'dead' | 'unknown'. Never fabricated client-side.
                const liveStatus = (live && live.activity_status) || 'unknown';
                const liveUnread = !!(live && live.unread);
                const existing = this.runningSessions.find(s => s.name === tmuxName);
                if (existing) {
                    existing.is_active = true;
                    existing.session_id = (live.session && live.session.id) || live.id || existing.session_id;
                    existing.status = liveStatus;
                    existing.unread = liveUnread;
                } else {
                    this.runningSessions.unshift({
                        name: tmuxName,
                        created_by_cloude: true,
                        created_at_epoch: live.created_at_epoch || 0,
                        window_count: 1,
                        is_active: true,
                        session_id: (live.session && live.session.id) || live.id || null,
                        status: liveStatus,
                        unread: liveUnread,
                    });
                }
            }
        } catch (err) {
            // 404 = no active session, fine
        }
        // Sort: active first, then owned, then external; within each, newest first
        this.runningSessions.sort((a, b) => {
            if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
            if (!!a.created_by_cloude !== !!b.created_by_cloude) {
                return a.created_by_cloude ? -1 : 1;
            }
            return (b.created_at_epoch || 0) - (a.created_at_epoch || 0);
        });
        this.renderRunningSessions();
    }

    /**
     * Paint (or hide) the Running Sessions section. Hides via display:none
     * when empty — opacity:0 would still capture clicks, which we don't want.
     *
     * Click handlers (row → return/adopt, X → kill) land in Task 10; this
     * pass only builds the DOM. ``data-name`` / ``data-active`` attributes
     * are the hooks event delegation will use.
     */
    renderRunningSessions() {
        const container = document.getElementById('running-sessions-list');
        if (!container) return;
        const section = document.getElementById('running-sessions-section');
        if (!this.runningSessions || this.runningSessions.length === 0) {
            // Only rewrite the DOM when transitioning into the empty state —
            // repeated renders while already empty would thrash the
            // section's display flip for no reason.
            if (this._lastRunningSig !== 'empty') {
                this._lastRunningSig = 'empty';
                if (section) section.style.display = 'none';
                container.innerHTML = '';
            }
            return;
        }
        // Signature-diff: skip the innerHTML rewrite when the set of rows
        // (name + ownership + active flag) hasn't changed. Previously the
        // 5s poller was restarting the `.running-session-row` pulse-glow
        // CSS animations every tick, which visibly flickered. Age labels
        // still need updating each tick, so we punt those through a
        // cheap text-only DOM update instead.
        const sig = JSON.stringify(this.runningSessions.map(s => ({
            name: s.name,
            owned: !!s.created_by_cloude,
            active: !!s.is_active,
            sid: s.session_id || null,
            status: s.status || 'unknown',
            unread: !!s.unread,
        })));
        if (sig === this._lastRunningSig) {
            this._updateRunningSessionAges();
            return;
        }
        this._lastRunningSig = sig;
        if (section) section.style.display = '';
        container.innerHTML = this.runningSessions.map(s => {
            const owned = !!s.created_by_cloude;
            const displayName = this._deriveRunningSessionDisplayName(s.name);
            const ageStr = s.created_at_epoch ? this._formatRelativeTime(s.created_at_epoch) : '';
            const escapedName = this._escapeHtml(s.name);
            const escapedDisplay = this._escapeHtml(displayName);
            const sidAttr = s.session_id ? ` data-session-id="${this._escapeHtml(s.session_id)}"` : '';
            // Pencil rename button — only for sessions whose id we know
            // (rename PATCH requires session_id, not the tmux name).
            // Detached-but-known rows qualify since their id is in
            // ``session_id``. External adopt-target rows (no session_id
            // until adopted) get no pencil — the user can adopt first,
            // then rename from the in-session header.
            const renamePencil = s.session_id
                ? `<span class="running-session-rename" role="button" aria-label="rename session" data-rename-sid="${this._escapeHtml(s.session_id)}" data-rename-name="${escapedName}" title="rename session">${window.SessionStatusUI ? window.SessionStatusUI.pencilIconSvg() : ''}</span>`
                : '';
            // Status dot: real activity status (running/idle/dead/unknown)
            // via the shared SessionStatusUI helper (client/js/session-status-ui.js),
            // NOT the old ownership-colored placeholder. title + aria-label
            // on the dot itself so the state is never color-only.
            const statusDot = window.SessionStatusUI
                ? window.SessionStatusUI.dotHtml(s.status)
                : '';
            const markUnread = window.SessionStatusUI
                ? window.SessionStatusUI.markUnreadHtml(s.name, !!s.unread)
                : '';
            // X (close) on a running row, trash (remove) on a stopped one,
            // never both - built by the shared SessionRowActions module so
            // the launcher, the conversation sidebar, and any future
            // session surface draw the same glyph with the same tooltip
            // for the same meaning. See client/js/session-row-actions.js.
            const rowAction = window.SessionRowActions
                ? window.SessionRowActions.html(s.status, s.name, 'running-session-kill')
                : '';
            return `
                <div class="running-session-row ${owned ? 'owned' : 'external'}" data-name="${escapedName}" data-active="${s.is_active ? '1' : '0'}"${sidAttr}>
                  <div class="running-session-top">
                    ${statusDot}
                    <span class="running-session-name">${escapedDisplay}</span>
                    ${renamePencil}
                    ${markUnread}
                    ${rowAction}
                  </div>
                  <div class="running-session-badges">
                    <span class="badge ${owned ? 'badge-tmux' : 'badge-external'}">${owned ? 'TMUX' : 'EXTERNAL'}</span>
                    ${ageStr ? `<span class="running-session-age">${this._escapeHtml(ageStr)}</span>` : ''}
                  </div>
                </div>
            `;
        }).join('');
        // Idempotent — re-calling after subsequent renders is a no-op
        // because the listener is bound to the (stable) container element,
        // not the (re-painted) row children, and the flag gates re-bind.
        this._bindRunningSessionClicks();
    }

    /**
     * Text-only age refresh — walks existing rows and rewrites just the
     * ``.running-session-age`` textContent. Used on poll ticks when the
     * row set is unchanged so we avoid the innerHTML rewrite that would
     * restart the pulse-glow CSS animations.
     *
     * Guarded for all the obvious missing-data cases: row without a
     * data-name, session no longer in the list, session without an
     * epoch, row without an age element. Any miss is a silent skip —
     * the next full render will reconcile.
     */
    _updateRunningSessionAges() {
        const rows = document.querySelectorAll('#running-sessions-list .running-session-row');
        rows.forEach(row => {
            const name = row.dataset.name;
            if (!name) return;
            const s = this.runningSessions.find(x => x.name === name);
            if (!s || !s.created_at_epoch) return;
            const ageEl = row.querySelector('.running-session-age');
            if (!ageEl) return;
            ageEl.textContent = this._formatRelativeTime(s.created_at_epoch);
        });
    }

    /**
     * Strip the ``cloude_`` prefix from tmux session names for display.
     * Non-cloude (external) names are rendered verbatim.
     */
    _deriveRunningSessionDisplayName(tmuxName) {
        if (tmuxName && tmuxName.startsWith('cloude_')) {
            return tmuxName.slice('cloude_'.length);
        }
        return tmuxName;
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
     * technically user-controlled — any embedded `<`, `>`, `"`, `'`, `&`
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
     * Format "N seconds / minutes / hours / days ago" for a unix epoch
     * timestamp. Mirrors standard UX copy for session-age display.
     */
    _formatRelativeTime(epochSeconds) {
        if (!epochSeconds || typeof epochSeconds !== 'number') return 'unknown';
        const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
        if (delta < 60) return `${delta}s ago`;
        if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
        if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
        return `${Math.floor(delta / 86400)}d ago`;
    }

    /**
     * Jump straight into an already-active running session's terminal.
     *
     * Description: extracted from the running-sessions row click handler
     *   (Task 5 / deep-link fix) so the SAME pre-fit + scrollback-capture
     *   dance is reachable from both a mouse click and a resolved
     *   `/session/<name>` deep link — the two paths must not drift apart.
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
            // 4. Fit + read measured geometry. Wrap in try/catch —
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
                // Tolerated — fall through with 0/0; server skips
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
     * Bind a single delegated click listener on #running-sessions-list.
     *
     * Event delegation over per-row listeners: avoids re-binding on every
     * render and survives DOM swaps. The `__boundRunningClicks` flag is
     * a one-shot idempotence guard — re-calling from renderRunningSessions
     * is a no-op after the first paint.
     *
     * Click target disambiguation:
     *   - the row's action button (or its SVG child) → close/remove flow
     *   - anywhere else on `.running-session-row`    → return/swap flow
     *
     * The action selector is built from SessionRowActions.ATTR_ACTION,
     * never from a literal: the same module builds the markup, so reading
     * the name from it is what makes the two sides unable to drift. There
     * is deliberately no literal fallback for a missing module, because
     * SessionRowActions.html() emits nothing in that case and there would
     * be no such element to match.
     *
     * stopPropagation on the action branch is the important bit: without
     * it the row handler would also fire and we'd race a swap against a
     * destroy.
     */
    _bindRunningSessionClicks() {
        const container = document.getElementById('running-sessions-list');
        if (!container || container.__boundRunningClicks) return;
        container.addEventListener('click', async (e) => {
            const actions = window.SessionRowActions;
            const rowActionEl = actions
                ? e.target.closest(`[${actions.ATTR_ACTION}]`)
                : null;
            const renameEl = e.target.closest('.running-session-rename');
            const markUnreadEl = e.target.closest('[data-mark-unread]');
            const rowEl = e.target.closest('.running-session-row');
            if (!rowEl) return;

            // Envelope icon path: manual mark/clear unread. Stop
            // propagation so the row click handler (return/adopt) never
            // also fires — this is a status toggle, not a navigation.
            if (markUnreadEl) {
                e.stopPropagation();
                await this._handleMarkUnread(markUnreadEl);
                return;
            }

            // X (close) / trash (remove) path: explicit destroy. Which
            // one this row painted is read back off the button rather
            // than re-derived, so the confirm copy always matches the
            // control the user actually clicked.
            if (rowActionEl) {
                e.stopPropagation();
                // `actions` is non-null here by construction: rowActionEl
                // can only be non-null when the selector above was built,
                // which requires the module.
                const name = rowActionEl.getAttribute(actions.ATTR_NAME);
                const action = rowActionEl.getAttribute(actions.ATTR_ACTION);
                const sid = rowEl.dataset.sessionId || null;
                await this._handleSessionRowAction(name, sid, action);
                return;
            }

            // Pencil icon path: inline-edit the session name. Stop
            // propagation so the row click handler (return/adopt) doesn't
            // also fire and race the edit. Only pencil buttons with a
            // ``data-rename-sid`` appear in rows with a known session_id.
            // External adopt-target rows have no pencil — the user can
            // adopt first, then rename from the in-session header.
            if (renameEl) {
                e.stopPropagation();
                const sid = renameEl.dataset.renameSid;
                const currentName = renameEl.dataset.renameName;
                if (sid) {
                    this._handleRenameRunningSession(rowEl, sid, currentName);
                }
                return;
            }

            // Row click — return or attach
            const name = rowEl.dataset.name;
            const isActive = rowEl.dataset.active === '1';
            const rowSessionId = rowEl.dataset.sessionId || null;
            if (isActive) {
                await this._returnToActiveRunningSession(rowSessionId);
                return;
            }
            // Not yet attached → adopt it as a (new, concurrent) session
            await this._handleAttachRunningSession(name);
        });
        // Keyboard activation (Enter/Space) for the mark-unread toggle -
        // it's a `role="button"` span, not a real <button>, so it needs
        // explicit key handling to be operable without a mouse.
        container.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const markUnreadEl = e.target.closest('[data-mark-unread]');
            if (!markUnreadEl) return;
            e.preventDefault();
            e.stopPropagation();
            await this._handleMarkUnread(markUnreadEl);
        });
        container.__boundRunningClicks = true;
    }

    /**
     * Toggle the manual unread flag for one running-session row.
     *
     * Description: Optimistic-ish — awaits the PATCH, then forces a
     *   re-render by invalidating the signature cache and re-fetching, so
     *   the toggle's visual state (and the finished_unread dot it may
     *   flip on/off) updates immediately rather than waiting for the next
     *   5s poll tick.
     * Inputs:
     *   toggleEl (Element) - the `[data-mark-unread]` span clicked,
     *     carrying the tmux name + current state as data-* attributes.
     * Output: Promise<void>.
     */
    async _handleMarkUnread(toggleEl) {
        const tmuxName = toggleEl.dataset.markUnread;
        if (!tmuxName) return;
        const next = toggleEl.dataset.unreadCurrent !== 'true';
        try {
            await window.API.setSessionUnread(tmuxName, next);
            this._lastRunningSig = null; // force a repaint past the sig-diff guard
            await this.loadRunningSessions();
        } catch (err) {
            console.error('[launchpad] mark-unread failed:', err);
        }
    }

    /**
     * Run the destructive row action (close a running session, or remove
     * a stopped one from the list). Both end at the same server call: a
     * stopped row has no process left to terminate, so clearing its
     * leftover tmux husk is exactly what "remove" means. The confirm copy
     * differs and is honest about that difference - see
     * client/js/session-row-actions.js.
     *
     * Inputs:
     *   tmuxName (string) - literal tmux session name.
     *   sessionId (string|null) - server session id when already known.
     *   action (string|null) - SessionRowActions.ACTION_CLOSE or
     *     ACTION_REMOVE; defaults to close.
     * Output: Promise<void>. No-op if the user cancels.
     *
     * Two server paths:
     *   1. Target IS the currently-active backend → DELETE /sessions
     *      (full destroy: tears down backend, idle watcher, tunnels,
     *      metadata; then kills tmux).
     *   2. Target is a different session → DELETE /sessions/external/{name}
     *      (direct `tmux kill-session`, no adoption). This used to be
     *      adopt-then-destroy, but adoption refuses dead panes (raised
     *      `RuntimeError("pane already dead")` in tmux_backend.attach_existing,
     *      surfacing as HTTP 500 from POST /sessions/adopt) — leaving any
     *      session whose foreground process exited permanently un-killable
     *      from the UI. The dedicated external-destroy endpoint sidesteps
     *      adoption entirely and is also idempotent if the session is
     *      already gone server-side.
     */
    /**
     * v0.7.1 — Inline-edit a running session's name from the launchpad row.
     *
     * Replaces the row's name span with a text input pre-filled with the
     * current tmux name. Enter saves (calls PATCH /sessions/{id}/name);
     * Esc cancels (restores the span). On success the server broadcasts
     * ``session.renamed`` over WS to every attached browser; we ALSO
     * force-refresh the launchpad list immediately so the new name shows
     * without waiting on the 5s poller.
     *
     * @param {HTMLElement} rowEl - The ``.running-session-row`` host.
     * @param {string} sessionId - Server-side session id (not tmux name).
     * @param {string} currentName - Current tmux name (for the input default).
     */
    _handleRenameRunningSession(rowEl, sessionId, currentName) {
        const nameEl = rowEl.querySelector('.running-session-name');
        if (!nameEl) return;
        // Idempotent — bail if an input is already showing in this row.
        if (rowEl.querySelector('.running-session-rename-input')) return;

        // Build the input + inline error label.
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'running-session-rename-input';
        input.value = currentName;
        input.maxLength = 64;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'New session name');

        const err = document.createElement('span');
        err.className = 'running-session-rename-error';
        err.style.display = 'none';

        // Hide the name span while editing.
        nameEl.style.display = 'none';

        nameEl.insertAdjacentElement('afterend', input);
        input.insertAdjacentElement('afterend', err);

        let settled = false;
        const cleanup = () => {
            try { if (input.parentNode) input.parentNode.removeChild(input); } catch (_) { /* */ }
            try { if (err.parentNode) err.parentNode.removeChild(err); } catch (_) { /* */ }
            nameEl.style.display = '';
        };
        const cancel = () => {
            if (settled) return;
            settled = true;
            cleanup();
        };
        const save = async () => {
            if (settled) return;
            const raw = (input.value || '').trim();
            if (!raw || raw === currentName) {
                cancel();
                return;
            }
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
                err.textContent = 'Use 1-64 chars: A-Z a-z 0-9 _ -';
                err.style.display = '';
                input.focus();
                input.select();
                return;
            }
            settled = true;
            // Stopping the row's swallow-click handlers is already done by
            // the caller (stopPropagation on the renameEl branch).
            try {
                await window.API.renameSession(sessionId, raw);
                cleanup();
                // Immediate refresh so the row paints the new name without
                // waiting on the 5s poller. The WS broadcast (received by
                // the terminal controller) ALSO triggers a refresh —
                // duplicate calls are idempotent; the load itself is
                // signature-diffed inside renderRunningSessions.
                await this.loadRunningSessions();
            } catch (e) {
                settled = false;
                let msg = (e && e.message) ? e.message : 'Rename failed';
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
            // Don't let row-level keyboard nav reach the container.
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('click', (e) => {
            // Clicks inside the input must not bubble to the row's
            // return/adopt handler.
            e.stopPropagation();
        });
        input.addEventListener('blur', () => { save(); });

        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    async _handleSessionRowAction(tmuxName, sessionId = null, action = null) {
        if (!tmuxName) return;
        if (!window.SessionRowActions) {
            // Load-order bug, not a user-facing state: index.html loads
            // session-row-actions.js before this file. Refuse to run a
            // destructive action without its confirm rather than fall
            // back to a second, unreviewed confirmation path.
            console.error('[launchpad] SessionRowActions missing, refusing to act');
            return;
        }
        const display = this._deriveRunningSessionDisplayName(tmuxName);
        const resolved = action || window.SessionRowActions.ACTION_CLOSE;
        // Confirm copy comes from the shared SessionRowActions module so
        // the launcher and the conversation sidebar say the same true
        // thing about the same operation. showConfirmModal escapes its
        // own arguments, so don't pre-escape `display` or it double-escapes.
        const confirmed = await window.SessionRowActions.confirm(resolved, display);
        if (!confirmed) return;
        try {
            // Resolve the session id for this tmux name if not supplied:
            // a live session bound to it must go through DELETE /sessions
            // (full teardown). External/detached → direct kill-session.
            let sid = sessionId;
            if (!sid && typeof window.API.listSessions === 'function') {
                const live = await window.API.listSessions().catch(() => []);
                const match = Array.isArray(live)
                    ? live.find(x => x && x.tmux_session === tmuxName)
                    : null;
                sid = match ? ((match.session && match.session.id) || match.id || null) : null;
            }
            if (sid) {
                await window.API.destroySession(sid);
            } else {
                await window.API.destroyExternalSession(tmuxName);
            }
        } catch (err) {
            this.showError(`${resolved} failed: ${err.message || err}`);
        }
        await this.loadRunningSessions();
    }

    /**
     * Adopt flow for a not-yet-attached running tmux session (row click).
     *
     * Multi-session: this is purely additive — adopting this tmux session
     * does NOT detach or kill any other session. On adopt success, dispatch
     * `session-created` with the adopt-specific detail payload
     * (initialScrollbackB64, fifoStartOffset, adopted:true) so
     * App.showTerminal() can plumb scrollback into the terminal controller.
     */
    async _handleAttachRunningSession(tmuxName) {
        try {
            const response = await window.API.adoptSession(tmuxName, true);
            const session = response.session || response;
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
                    // session_manager.py adds when minting the tmux name —
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
                <div class="launchpad-header">☁️ Cloude Code Launcher</div>
                <div class="launchpad-prompt">select a project or create a new project</div>

                <div id="running-sessions-section" class="launchpad-section running-sessions-section" style="display:none;">
                    <div class="launchpad-section-title launchpad-section-title--row">
                        <button type="button" class="launchpad-section-toggle" id="running-sessions-toggle" aria-expanded="true" aria-controls="running-sessions-list">
                            <span class="launchpad-section-chevron" aria-hidden="true">►</span>
                            <span class="launchpad-section-title__text">running sessions</span>
                        </button>
                        <details class="adopt-disclosure">
                            <summary>?</summary>
                            <div class="adopt-disclosure-body">
                                <p>you don't have to launch through cloude — <em>any</em> tmux session on the <code>cloude</code> socket with <code>claude</code> running inside it is adoptable from here. start one yourself in any terminal:</p>
                                <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork; claude</code></pre>
                                <p>it shows up in this list tagged <code>EXTERNAL</code> — click it to adopt. note the <code>-L cloude</code>: a plain <code>tmux new -s mywork</code> lives on the default socket and won't appear here.</p>
                                <p>to launch claude in one line so the pane survives claude exiting:</p>
                                <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork "claude --dangerously-skip-permissions; exec \$SHELL"</code></pre>
                                <p>the <code>exec \$SHELL</code> trick keeps the pane alive with a shell prompt after claude exits.</p>
                                <p>if you have a custom launcher alias (e.g. <code>cld</code>) defined in your <code>~/.zshrc</code> or <code>~/.bashrc</code>, wrap the inner command in an interactive shell:</p>
                                <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork "\$SHELL -ic 'cld; exec \$SHELL'"</code></pre>
                                <p>full setup in the <a href="https://github.com/Adoom666/CloudeCode#launching-claude-with-a-custom-alias" target="_blank" rel="noopener">README</a>.</p>
                            </div>
                        </details>
                        <div class="new-fab" id="new-fab">
                            <button class="new-fab__trigger" id="new-fab-trigger" type="button" aria-label="New" title="New" aria-haspopup="menu" aria-expanded="false">
                                <svg class="new-fab__plus" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                                    <line x1="12" y1="5" x2="12" y2="19"/>
                                    <line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                            </button>
                            <div class="new-fab__menu" role="menu" aria-label="New session actions">
                                <button class="new-fab__item" type="button" role="menuitem" data-action="new-project" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M13 2L3 12l9 9 10-10V2z"/>
                                            <circle cx="8.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">create new project</span>
                                </button>
                                <button class="new-fab__item" type="button" role="menuitem" data-action="open-folder" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">open from folder</span>
                                </button>
                                <button class="new-fab__item" type="button" role="menuitem" data-action="clone-github" tabindex="-1">
                                    <span class="new-fab__icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.04 1.53 1.04.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/>
                                        </svg>
                                    </span>
                                    <span class="new-fab__label">clone from github</span>
                                </button>
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
                    <div id="running-sessions-list"></div>
                </div>

                <!-- "new project" actions live in the inline speed-dial FAB
                     to the right of the "running sessions" heading. Wired in setupNewFab(). -->

                <div class="launchpad-section" id="projects-section">
                    <div class="launchpad-section-title">
                        <button type="button" class="launchpad-section-toggle" id="projects-section-toggle" aria-expanded="true" aria-controls="project-list">
                            <span class="launchpad-section-chevron" aria-hidden="true">►</span>
                            recent projects
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
                <span class="home-bar__spacer" aria-hidden="true"></span>
                <span class="version home-bar__version" id="home-bar-version"></span>
                <a class="home-bar__link" href="https://nyedis.ai" target="_blank" rel="noopener noreferrer"
                   aria-label="nyedis.ai" title="nyedis.ai">
                        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 986 937" role="img" aria-label="Black bird silhouette">
                            <path d="M 409.0 883.5 L 408.5 882.0 L 458.5 804.0 L 489.5 748.0 L 488.0 747.5 L 453.0 783.5 L 437.0 797.5 L 403.0 823.5 L 377.0 839.5 L 376.5 838.0 L 398.5 816.0 L 438.5 771.0 L 469.5 732.0 L 478.5 718.0 L 474.0 719.5 L 436.0 750.5 L 388.0 785.5 L 394.5 766.0 L 409.5 739.0 L 408.0 738.5 L 386.0 753.5 L 377.0 758.5 L 375.5 758.0 L 382.5 743.0 L 394.5 725.0 L 410.5 705.0 L 410.5 703.0 L 374.0 704.5 L 361.0 702.5 L 360.5 701.0 L 409.0 681.5 L 481.0 647.5 L 520.0 625.5 L 546.0 607.5 L 565.5 589.0 L 570.5 580.0 L 570.5 576.0 L 561.0 575.5 L 542.0 580.5 L 545.5 574.0 L 560.5 556.0 L 594.0 522.5 L 632.5 489.0 L 630.0 487.5 L 588.0 488.5 L 551.0 493.5 L 516.0 500.5 L 529.5 487.0 L 532.5 480.0 L 532.0 473.5 L 515.0 472.5 L 491.0 468.5 L 451.0 455.5 L 435.5 448.0 L 452.0 439.5 L 456.5 435.0 L 456.0 433.5 L 420.0 426.5 L 402.0 420.5 L 394.5 416.0 L 427.0 414.5 L 442.0 411.5 L 445.0 410.5 L 445.0 408.5 L 399.0 408.5 L 375.0 406.5 L 333.0 400.5 L 305.5 393.0 L 306.0 391.5 L 309.0 391.5 L 344.0 394.5 L 429.0 395.5 L 461.0 394.5 L 461.0 392.5 L 426.0 390.5 L 378.0 384.5 L 302.0 370.5 L 249.0 358.5 L 180.0 339.5 L 138.0 331.5 L 75.0 314.5 L 34.0 299.5 L 19.0 291.5 L 15.5 287.0 L 18.0 285.5 L 173.5 287.0 L 173.0 285.5 L 125.0 275.5 L 91.0 264.5 L 68.0 252.5 L 59.5 244.0 L 59.0 238.5 L 134.0 251.5 L 227.5 271.0 L 225.5 266.0 L 218.0 259.5 L 181.5 238.0 L 185.0 237.5 L 297.0 264.5 L 434.0 294.5 L 546.0 316.5 L 613.0 326.5 L 613.5 325.0 L 607.0 320.5 L 591.0 312.5 L 561.0 301.5 L 509.0 287.5 L 450.0 276.5 L 449.5 275.0 L 483.0 262.5 L 505.0 257.5 L 534.0 253.5 L 600.0 252.5 L 625.0 255.5 L 632.5 255.0 L 622.0 245.5 L 609.0 239.5 L 588.0 233.5 L 551.5 228.0 L 568.0 220.5 L 585.0 217.5 L 612.0 217.5 L 644.0 221.5 L 692.0 232.5 L 737.0 247.5 L 741.0 247.5 L 747.0 241.5 L 754.0 237.5 L 771.0 233.5 L 797.0 235.5 L 814.0 240.5 L 827.0 246.5 L 841.5 259.0 L 844.5 265.0 L 845.5 281.0 L 843.5 288.0 L 836.5 301.0 L 824.5 316.0 L 805.0 334.5 L 782.0 351.5 L 769.5 365.0 L 761.5 379.0 L 761.5 390.0 L 765.0 393.5 L 767.0 393.5 L 778.0 388.5 L 795.0 383.5 L 807.0 381.5 L 827.0 381.5 L 852.0 387.5 L 865.0 393.5 L 879.0 402.5 L 904.5 426.0 L 925.5 454.0 L 946.5 492.0 L 957.5 518.0 L 961.5 532.0 L 944.0 513.5 L 932.0 503.5 L 923.0 497.5 L 903.0 488.5 L 889.0 485.5 L 873.0 485.5 L 853.0 490.5 L 839.0 497.5 L 829.0 504.5 L 814.5 519.0 L 783.5 561.0 L 754.5 604.0 L 737.5 635.0 L 737.5 659.0 L 740.0 661.5 L 765.0 671.5 L 816.0 696.5 L 826.0 699.5 L 843.0 709.5 L 857.0 720.5 L 879.5 743.0 L 894.5 762.0 L 895.5 768.0 L 881.0 780.5 L 879.5 771.0 L 875.5 764.0 L 870.0 758.5 L 856.5 750.0 L 847.5 731.0 L 834.0 716.5 L 821.0 708.5 L 808.0 704.5 L 799.0 704.5 L 800.0 700.5 L 780.0 689.5 L 722.0 666.5 L 716.5 662.0 L 715.5 650.0 L 710.0 643.5 L 705.0 641.5 L 688.0 641.5 L 683.5 644.0 L 682.5 651.0 L 689.0 666.5 L 752.0 692.5 L 793.0 711.5 L 808.0 722.5 L 824.5 738.0 L 834.5 751.0 L 840.5 762.0 L 838.5 766.0 L 828.0 772.5 L 816.0 774.5 L 815.5 762.0 L 811.5 753.0 L 805.5 744.0 L 794.0 732.5 L 786.0 729.5 L 777.0 728.5 L 765.0 729.5 L 764.5 728.0 L 768.0 724.5 L 774.0 722.5 L 774.5 721.0 L 767.0 719.5 L 734.0 699.5 L 701.0 684.5 L 681.0 679.5 L 670.0 679.5 L 668.5 671.0 L 664.0 665.5 L 657.0 663.5 L 651.0 664.5 L 646.5 669.0 L 643.5 677.0 L 645.5 705.0 L 644.5 753.0 L 643.5 756.0 L 641.0 756.5 L 637.5 748.0 L 633.0 742.5 L 627.0 739.5 L 620.5 740.0 L 623.5 754.0 L 623.5 772.0 L 620.5 790.0 L 616.0 803.5 L 614.5 795.0 L 611.0 789.5 L 603.0 783.5 L 595.0 782.5 L 593.5 798.0 L 589.5 812.0 L 581.5 826.0 L 567.0 840.5 L 564.5 841.0 L 566.5 830.0 L 566.5 816.0 L 565.5 807.0 L 564.0 806.5 L 549.5 828.0 L 532.0 845.5 L 514.0 858.5 L 512.5 858.0 L 519.5 849.0 L 523.5 840.0 L 526.5 828.0 L 526.0 823.5 L 503.0 844.5 L 479.0 860.5 L 487.5 844.0 L 495.5 819.0 L 501.5 788.0 L 500.0 786.5 L 461.5 835.0 L 427.0 869.5 L 409.0 883.5 Z" fill="currentColor"/>
                        </svg>
                    </a>
                </div>
            `;

        // Event listeners
        // Note: the 3 "new project" actions (create / open-folder / clone-github)
        // are wired in setupNewFab() — the inline speed-dial sits to the right
        // of the "recent projects" section heading on the launchpad screen.

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
     * The version is resolved server-side and stamped into the
     * `cloude-app-version` meta tag by src/main.py; this markup is built
     * at runtime and so has no server-rendered token of its own. An
     * absent or empty meta leaves the chip empty, which
     * `.home-bar__version:empty` then removes from the layout - a blank
     * gap beside the bird would read as a broken control.
     *
     * @returns {void}
     */
    renderHomeBarVersion() {
        const chip = document.getElementById('home-bar-version');
        if (!chip) return;
        const meta = document.querySelector('meta[name="cloude-app-version"]');
        const version = meta ? (meta.getAttribute('content') || '').trim() : '';
        chip.textContent = version;
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
     * Wire up the two launchpad section headings ("running sessions" and
     * "recent projects") as real collapsible disclosures. Collapsed state
     * persists per-section in localStorage under
     * `cloude.launchpad.collapsed`, following the same convention as
     * `cloude.theme` / `cloude.audio.muted`.
     *
     * There used to be a third, "server management". Its one control now
     * lives in the home bar's server-controls menu.
     */
    initSectionDisclosures() {
        const collapsedState = this.getLaunchpadCollapsedState();
        const sections = [
            { id: 'running-sessions', toggleId: 'running-sessions-toggle', contentId: 'running-sessions-list' },
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
     * Render project list
     */
    renderProjectList() {
        const projectListEl = document.getElementById('project-list');

        if (this.projects.length === 0) {
            projectListEl.innerHTML = `
                <div class="launchpad-empty">
                    no projects configured yet<br>
                    <small style="color: #666;">edit config.json to add projects</small>
                </div>
            `;
            return;
        }

        // Render projects
        projectListEl.innerHTML = this.projects.map((project, index) => {
            const description = project.description || 'no description';
            return `
                <div class="project-item" data-index="${index}" data-name="${project.name}">
                    <button class="project-edit-btn" data-name="${project.name}" title="edit project" aria-label="edit project">${window.SessionStatusUI ? window.SessionStatusUI.pencilIconSvg() : ''}</button>
                    <button class="project-delete-btn" data-name="${project.name}" title="remove project from the launcher" aria-label="remove project from the launcher">${window.SessionStatusUI ? window.SessionStatusUI.trashIconSvg() : '&times;'}</button>
                    <div class="project-name">» ${project.name}</div>
                    <div class="project-path">${project.path}</div>
                    <div class="project-description">${description}</div>
                </div>
            `;
        }).join('');

        // Add click handlers for project selection
        const projectItems = projectListEl.querySelectorAll('.project-item');
        projectItems.forEach(item => {
            item.addEventListener('click', (e) => {
                // Don't open project if clicking an inline action button
                if (e.target.classList.contains('project-delete-btn') ||
                    e.target.classList.contains('project-edit-btn')) {
                    return;
                }
                const index = parseInt(item.dataset.index);
                this.selectProject(this.projects[index]);
            });
        });

        // Add click handlers for delete buttons
        const deleteButtons = projectListEl.querySelectorAll('.project-delete-btn');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent project selection
                const projectName = btn.dataset.name;
                await this.deleteProject(projectName);
            });
        });

        // Add click handlers for edit buttons
        const editButtons = projectListEl.querySelectorAll('.project-edit-btn');
        editButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent project selection
                const projectName = btn.dataset.name;
                const project = this.projects.find(p => p.name === projectName);
                if (project) {
                    this.editProject(project);
                }
            });
        });
    }

    /**
     * Delete a project
     */
    async deleteProject(projectName) {
        try {
            // Show confirmation modal
            // Trash means the same thing on a project row as on a session
            // row: forget the entry, touch nothing on disk. The copy says
            // so plainly rather than borrowing a "cannot be undone"
            // warning this action does not earn.
            const confirmed = await this.showConfirmModal(
                'remove project',
                `remove "${projectName}" from the launcher?`,
                'this only removes it from the launcher. the folder and its files on disk are not touched.',
                'remove',
                'cancel'
            );

            if (!confirmed) {
                return;
            }

            // Show loading state
            this.updateStatus(`deleting ${projectName}...`);

            // Delete project via API
            await window.API.deleteProject(projectName);

            console.log('Launchpad: Project deleted:', projectName);

            // Reload projects list
            await this.loadProjects();

            this.updateStatus('project deleted');

        } catch (error) {
            console.error('Launchpad: Failed to delete project:', error);
            this.showError('failed to delete project: ' + error.message);
        }
    }

    /**
     * Open the edit-project modal for ``project`` and persist any changes.
     *
     * Display name only — the folder on disk is never touched.
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
     * with an error whose ``message`` contains "already exists" — handled
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
                                the folder on disk is never renamed — only the launcher label changes.
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

    /**
     * Restart the web server process.
     *
     * WHY "RESTART" AND NOT "RESET". This was labelled "reset server",
     * which reads like it clears state. Traced end to end, it does not:
     * POST /api/v1/server/reset spawns reset.sh, which either asks launchd
     * to kickstart its own managed job (`launchctl kickstart -k`, the
     * macOS menu-bar app's setup) or falls back to stop.sh + start.sh.
     * stop.sh kills whatever holds port 8000; start.sh brings the FastAPI
     * process back. Nothing in that path touches tmux, the config, the
     * project list or anything on disk. It is a process restart, so the
     * control says so. The API route keeps its `/server/reset` path - the
     * name a user reads and the name on the wire are different contracts,
     * and renaming the endpoint would be a breaking change for no gain.
     *
     * The confirmation copy is held to the same standard: the tmux
     * sessions genuinely do keep running and re-attach, so it says that
     * rather than inventing a scare or a reassurance.
     *
     * @returns {Promise<void>} resolves once the reload is scheduled, or
     *   immediately if the user cancels.
     */
    async restartServer() {
        try {
            const confirmed = await this.showConfirmModal(
                'restart server',
                'restart the cloude code server?',
                'the python web server stops and starts again. your tmux sessions keep running and re-attach afterwards, so nothing you have open is lost. this browser tab loses its connection for a few seconds and then reloads itself.'
            );

            if (!confirmed) {
                return;
            }

            this.updateStatus('restarting server...');

            await window.API.resetServer();

            console.log('Launchpad: Server restart initiated');

            this.updateStatus('server restarting - reconnecting...');

            // Wait a moment for the server to come back, then reload.
            setTimeout(() => {
                window.location.reload();
            }, 3000);

        } catch (error) {
            console.error('Launchpad: Failed to restart server:', error);
            this.showError('failed to restart server: ' + error.message);
        }
    }

    /**
     * Show confirmation modal.
     *
     * Thin delegate to `App.showConfirmModal()` — that is the ONE
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
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled. Cancel is ALWAYS a no-op — callers must never map cancel to a destructive action.
     */
    showConfirmModal(title, message, details = null, primaryLabel = 'confirm', secondaryLabel = 'cancel') {
        return window.App.showConfirmModal(title, message, details, primaryLabel, secondaryLabel);
    }

    /**
     * Create new project with auto-generated workspace.
     * Default behavior — server falls back to ProjectConfig.agent_type
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
     * Create a plain "console" tmux session in ~/ running $SHELL — no
     * Claude/codex/hermes/openclaw. For quick shell work straight from the
     * launchpad.
     *
     * Auto-generates a name (console-<base36 ts>) — no modal prompt, since
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
            // project name. Keyboard-first, defaults to the last choice —
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
            const projectDetails = await this.showProjectNameModal({ title: modalTitle });

            if (!projectDetails) {
                console.log('Launchpad: Project creation cancelled');
                return; // User cancelled
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
                ..._dims
            };
            // Only include agent_type when explicitly set, so the server's
            // existing fallback chain (ProjectConfig.agent_type → "claude")
            // continues to work for the default "new-project" button.
            // feat/launch-wrappers — a wrapper choice from the provider
            // modal (providerChoice.wrapperId) ONLY applies when no
            // explicit agentType was already forced by the caller (e.g.
            // the openclaw/hermes/codex quick-connect buttons) — those
            // win outright, matching the pre-wrappers precedence for
            // agent_type.
            if (agentType) {
                payload.agent_type = agentType;
            } else if (providerChoice.wrapperId) {
                payload.agent_type = providerChoice.wrapperId;
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

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to create session:', error);

            // If a session already exists, the user's stated intent was
            // "create a new project" — carry it out immediately. The prior
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
     * Show the "clone from github" modal — collects URL + parent dir +
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
        // must never fire before the user has committed to launching —
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
                            paste the full url or use gh shorthand (owner/repo). server runs <code>gh repo clone</code> — gh must be authenticated.
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
                // Success — refresh project list, close modal, open session
                // in the cloned dir. selectProject does the heavy lifting.
                await this.loadProjects();
                closeModal();
                // Provider already chosen above — pass it through so
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
     * path — prior session lingers and can be re-adopted later.
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
     * Canonical tmux-name <-> URL-slug matcher — the ONE place that decides
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
     *       and compares against the decoded slug — exact match first,
     *       then case-insensitive fallback.
     *   Previously these two directions used the same helper already, so
     *   a prefix-stripping mismatch was ruled out as the root cause of
     *   the duplicate-session regression (see openProjectByName()'s
     *   docstring) — but keeping the comparison here, in one function,
     *   means that stays true by construction instead of by coincidence.
     * Inputs:
     *   slug (string) - decoded, regex-validated name from the URL.
     * Output: the matching row from `this.runningSessions`, or
     *   `undefined` if none matches.
     */
    _findRunningSessionBySlug(slug) {
        const rows = this.runningSessions || [];
        return rows.find(s => this._deriveRunningSessionDisplayName(s.name) === slug)
            || rows.find(s => (this._deriveRunningSessionDisplayName(s.name) || '').toLowerCase() === String(slug).toLowerCase());
    }

    /**
     * Open a project OR an adopted session by name (used by the deep-link
     * router, Item 9; extended for adopted sessions as part of the deep-link
     * fix; REORDERED as part of the duplicate-session regression fix below).
     *
     * ROOT CAUSE of the duplicate-session regression: this method used to
     * check `this.projects` (launcher entries) FIRST and, on a match, call
     * `selectProject()` — which unconditionally calls
     * `window.API.createSession()`. `create_session()` server-side
     * (src/core/session_manager.py) deliberately NEVER attaches to an
     * existing tmux session for a project click — "a project click must
     * ALWAYS spawn a NEW session... the user runs multiple concurrent
     * sessions per directory" — so on a name collision it silently mints
     * `<name>-2`, `<name>-3`, etc. and returns THAT. A deep link to a
     * project that already had a live tmux session therefore always
     * created a fresh duplicate rather than reattaching, and the browser
     * ended up on the newly-created session's URL. The name<->slug
     * mapping itself (`_deriveRunningSessionDisplayName`, see
     * `_findRunningSessionBySlug()` above) was already shared correctly
     * between build and resolve — it was never reached, because the
     * launcher-project branch returned first.
     *
     * FIX: live sessions are now resolved FIRST, and a launcher-project
     * match is no longer used to justify creating a session for a deep
     * link at all — see the GUARD note below.
     *
     * Resolution order:
     *   1. `GET /sessions/list` / `GET /sessions/attachable` (via
     *      `loadRunningSessions()`) for a LIVE session whose slug
     *      matches (`_findRunningSessionBySlug()`) — this covers both an
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
     * launcher project with that name may exist — doing so would call
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
            // poller — a deep link can arrive well before the first poll
            // tick, and can also be a session with no launcher project
            // entry at all (external/adopted).
            try {
                await this.loadRunningSessions();
            } catch (err) {
                console.warn('Launchpad: loadRunningSessions during deep-link resolve failed:', err);
            }

            const session = this._findRunningSessionBySlug(name);

            if (session) {
                console.log('Launchpad: deep-link resolved to running session:', session.name);
                if (session.is_active) {
                    await this._returnToActiveRunningSession(session.session_id || null);
                } else {
                    await this._handleAttachRunningSession(session.name);
                }
                return;
            }

            // No live session anywhere — GUARD (see docstring above): do
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
            // anything. null = user cancelled the whole launch — abort
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

            // Open the project (provider already chosen above — pass it
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
     */
    showFolderPickerModal() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            overlay.innerHTML = `
                <div class="modal-content folder-picker-modal">
                    <div class="modal-header">» select a folder</div>
                    <div class="modal-body">
                        <input type="text" class="folder-picker-path modal-input" id="folder-picker-path"
                               spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"
                               aria-label="directory path"
                               placeholder="type a path then Enter — created if it doesn't exist">
                        <div class="folder-picker-status" id="folder-picker-status" role="status" aria-live="polite"></div>
                        <div class="folder-picker-toolbar">
                            <button class="folder-picker-toolbar-btn" id="folder-picker-up" title="go to parent directory">⬆ up</button>
                            <button class="folder-picker-toolbar-btn" id="folder-picker-home" title="go to home directory">🏠 home</button>
                        </div>
                        <div class="folder-picker-list" id="folder-picker-list" tabindex="-1">
                            <div class="folder-picker-empty">loading...</div>
                        </div>
                        <div class="modal-description">
                            click a folder to enter it, or type letters to jump · ↑/↓ to move · Enter opens the highlighted folder.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="folder-picker-cancel">cancel</button>
                        <button class="modal-btn modal-btn-primary" id="folder-picker-confirm">open here</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const pathInput = overlay.querySelector('#folder-picker-path');
            const statusEl = overlay.querySelector('#folder-picker-status');
            const listEl = overlay.querySelector('#folder-picker-list');
            const upBtn = overlay.querySelector('#folder-picker-up');
            const homeBtn = overlay.querySelector('#folder-picker-home');
            const confirmBtn = overlay.querySelector('#folder-picker-confirm');
            const cancelBtn = overlay.querySelector('#folder-picker-cancel');

            let currentPath = null;
            let currentParent = null;
            let entries = [];        // current folder entries: [{name, path}]
            let activeIndex = -1;    // highlighted item index into `entries`
            let typeBuffer = '';     // type-ahead accumulator
            let typeTimer = null;    // resets the type-ahead buffer after idle

            const close = (value) => {
                document.removeEventListener('keydown', onKeyDown, true);
                if (typeTimer) clearTimeout(typeTimer);
                document.body.removeChild(overlay);
                resolve(value);
            };

            const clearStatus = () => {
                statusEl.textContent = '';
                statusEl.className = 'folder-picker-status';
            };
            const showStatus = (msg, kind) => {
                statusEl.textContent = msg;
                statusEl.className = `folder-picker-status folder-picker-status--${kind || 'info'}`;
            };

            // Highlight the entry at `idx` (clamped) and scroll it into view.
            const setActive = (idx, { scroll = true } = {}) => {
                const els = listEl.querySelectorAll('.folder-picker-item');
                if (!els.length) { activeIndex = -1; return; }
                idx = Math.max(0, Math.min(idx, els.length - 1));
                els.forEach((el, i) => el.classList.toggle('folder-picker-item-active', i === idx));
                activeIndex = idx;
                if (scroll) els[idx].scrollIntoView({ block: 'nearest' });
            };

            // Render entries + sync path bar / parent button from a browse or
            // mkdir response. Single source of "we moved into a directory".
            const navigate = (data) => {
                currentPath = data.path;
                currentParent = data.parent;
                entries = Array.isArray(data.entries) ? data.entries : [];
                pathInput.value = data.path || '';
                upBtn.disabled = !data.parent;
                activeIndex = -1;
                typeBuffer = '';
                if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }

                if (!entries.length) {
                    listEl.innerHTML = '<div class="folder-picker-empty">no subfolders here</div>';
                    return;
                }

                listEl.innerHTML = entries.map((entry, i) => `
                    <div class="folder-picker-item" data-index="${i}" data-path="${entry.path.replace(/"/g, '&quot;')}">
                        <span class="folder-picker-icon">📁</span>
                        <span class="folder-picker-name">${this._escapeHtml(entry.name)}</span>
                    </div>
                `).join('');

                listEl.querySelectorAll('.folder-picker-item').forEach(item => {
                    item.addEventListener('click', () => loadPath(item.dataset.path));
                    item.addEventListener('mousemove', () => {
                        const idx = parseInt(item.dataset.index, 10);
                        if (idx !== activeIndex) setActive(idx, { scroll: false });
                    });
                });
            };

            const loadPath = async (targetPath) => {
                listEl.innerHTML = '<div class="folder-picker-empty">loading...</div>';
                clearStatus();
                try {
                    navigate(await window.API.browseDirectory(targetPath));
                } catch (error) {
                    console.error('Launchpad: Folder browse failed:', error);
                    listEl.innerHTML = `<div class="folder-picker-empty">error: ${this._escapeHtml(error.message || String(error))}</div>`;
                }
            };

            // Enter in the path bar: browse the typed path; if it 404s
            // (doesn't exist / not a directory) auto-create it via mkdir -p
            // and navigate straight in. Other errors surface inline.
            const submitPath = async () => {
                const value = pathInput.value.trim();
                if (!value) return;
                clearStatus();
                try {
                    navigate(await window.API.browseDirectory(value));
                } catch (error) {
                    if (error && error.status === 404) {
                        try {
                            const data = await window.API.makeDirectory(value);
                            navigate(data);
                            showStatus(`created ${data.path}`, 'success');
                        } catch (mkErr) {
                            showStatus(`could not create: ${mkErr.message || mkErr}`, 'error');
                        }
                    } else {
                        showStatus(error.message || String(error), 'error');
                    }
                }
            };

            pathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    submitPath();
                }
            });

            // Modal-wide key handling (capture phase so it works no matter
            // which child holds focus). Removed on close — no listener leak.
            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    close(null);
                    return;
                }

                // While editing the path, let the input own its keystrokes
                // (typing edits the path; its own handler submits on Enter).
                if (document.activeElement === pathInput) return;

                // Don't hijack keyboard activation of a focused button.
                const ae = document.activeElement;
                if (ae && ae.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive(activeIndex < 0 ? 0 : activeIndex + 1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive(activeIndex < 0 ? entries.length - 1 : activeIndex - 1);
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (activeIndex >= 0 && entries[activeIndex]) {
                        loadPath(entries[activeIndex].path);
                    } else if (currentPath) {
                        close(currentPath);
                    }
                    return;
                }

                // Type-ahead: printable single chars only, no modifier combos.
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    typeBuffer += e.key.toLowerCase();
                    if (typeTimer) clearTimeout(typeTimer);
                    typeTimer = setTimeout(() => { typeBuffer = ''; }, 800);
                    const matchIdx = entries.findIndex(
                        en => en.name.toLowerCase().startsWith(typeBuffer)
                    );
                    if (matchIdx >= 0) setActive(matchIdx);
                }
            };
            document.addEventListener('keydown', onKeyDown, true);

            upBtn.addEventListener('click', () => {
                if (currentParent) loadPath(currentParent);
            });

            homeBtn.addEventListener('click', () => loadPath('~'));

            confirmBtn.addEventListener('click', () => {
                if (currentPath) close(currentPath);
            });

            cancelBtn.addEventListener('click', () => close(null));

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });

            // Start at the server's default location.
            loadPath(null);

            // Default focus to the LIST (not the path bar) so type-ahead works
            // immediately; clicking the path bar focuses it for direct entry.
            setTimeout(() => listEl.focus(), 100);
        });
    }

    /**
     * Select and open existing project.
     * @param {object} project
     * @param {{model: string|null}|undefined} [providerChoice] - Pass a
     *   already-resolved choice when the caller gated its own pre-session
     *   side effect (e.g. persisting a new project entry) on the provider
     *   modal first — avoids prompting the user twice. Omit to have this
     *   function show the modal itself (existing-project paths).
     */
    async selectProject(project, providerChoice = undefined) {
        console.log('Launchpad: Selecting project:', project.name);

        // GUARD: never create a session while resolving a deep link (see
        // the `_resolvingDeepLink` docstring in the constructor and
        // `openProjectByName()`'s docstring). This is what makes the
        // "deep-link resolution must never create" invariant explicit in
        // code rather than an accident of call order — openProjectByName()
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
            // project. null = user cancelled the whole launch — abort
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
            // at the right size — see the "new project" path for rationale.
            const _dims = this._getTerminalDims();
            const payload = {
                working_dir: project.path,
                auto_start_claude: true,
                copy_templates: false,
                project_name: project.name,
                ..._dims
            };
            // Omit for claude (server default); set for an OpenRouter model.
            if (providerChoice.model) {
                payload.model = providerChoice.model;
            }
            // feat/launch-wrappers — see _createNewSessionInner's identical
            // comment; this path has no explicit agentType to defer to.
            if (providerChoice.wrapperId) {
                payload.agent_type = providerChoice.wrapperId;
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
            // create-session call lands — avoids a race where we try to
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
    showError(message) {
        // For now, just log and use browser alert
        // Could be improved with a proper error UI element
        console.error('Launchpad Error:', message);
        alert(`Error: ${message}`);
    }
}

// Export singleton instance
window.Launchpad = new Launchpad();
console.log('[Launchpad Module] Exported as window.Launchpad:', window.Launchpad);
