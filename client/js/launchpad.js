/**
 * Launchpad Module - Project selection UI with terminal aesthetic
 */

console.log('[Launchpad Module] Loading...');

class Launchpad {
    constructor() {
        this.launchpadScreen = null;
        this.projects = [];
        // Attachable (external) tmux sessions on the `cloude` socket.
        // Populated by loadAttachableSessions(); empty array means either
        // "not loaded yet" or "loaded and none exist" — the render pass
        // uses the DOM state (loading vs empty-list) to disambiguate.
        this.attachableSessions = [];
    }

    /**
     * Initialize launchpad screen
     */
    init() {
        this.launchpadScreen = document.getElementById('launchpad-screen');
        this.renderLaunchpadUI();
        // Note: loadProjects() will be called by App.showLaunchpad()
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
     * Load and display projects
     */
    async loadProjects() {
        try {
            this.projects = await window.API.getProjects();
            this.renderProjectList();
        } catch (error) {
            console.error('Launchpad: Failed to load projects:', error);
            this.showError('failed to load projects: ' + error.message);
        }
        // Refresh attachable sessions in parallel with the projects view.
        // Failure here is non-fatal — it just means the adopt section shows
        // its empty state instead of listing external sessions.
        this.loadAttachableSessions();
        // Refresh the "session running" banner. The user may have
        // destroyed / timed-out the session from another tab between
        // launchpad visits, so every entry re-fetches authoritatively.
        this.refreshActiveSessionBanner();
    }

    /**
     * Fetch current-session state from the server and repaint the
     * active-session banner accordingly.
     *
     * The server's ``GET /sessions`` returns 404 when no session exists;
     * ``API.getCurrentSession()`` translates that to null so we can treat
     * "no session" as a normal state instead of an error. On any other
     * error we log and hide the banner — better a missing banner than a
     * broken launchpad.
     */
    async refreshActiveSessionBanner() {
        let info = null;
        try {
            info = await window.API.getCurrentSession();
        } catch (error) {
            console.warn('Launchpad: active-session fetch failed, hiding banner:', error && error.message);
            info = null;
        }
        this.renderActiveSessionBanner(info);
    }

    /**
     * Paint (or hide) the active-session banner at the top of the
     * launchpad. Pass null/undefined to hide.
     *
     * Display-name rules:
     *   - If info.tmux_session is present, use it (works for both owned
     *     and adopted sessions — matches what the user typed at
     *     ``tmux new -s <name>``).
     *   - Else if session.id starts with ``adopted:``, strip the prefix.
     *   - Else fall back to the basename of working_dir (matches the
     *     menu-bar health endpoint's convention).
     *   - Final fallback: session.id as-is.
     */
    renderActiveSessionBanner(info) {
        const banner = document.getElementById('active-session-banner');
        if (!banner) return;

        const session = info && (info.session || info) || null;
        if (!info || !session || !session.id) {
            banner.hidden = true;
            return;
        }

        let displayName = info.tmux_session || null;
        if (!displayName && typeof session.id === 'string' && session.id.startsWith('adopted:')) {
            displayName = session.id.slice('adopted:'.length);
        }
        if (!displayName && session.working_dir) {
            const parts = session.working_dir.split('/').filter(Boolean);
            displayName = parts.length ? parts[parts.length - 1] : session.working_dir;
        }
        if (!displayName) displayName = session.id;

        const backendLabel = info.session_backend || 'unknown';
        const nameEl = banner.querySelector('.active-session-name');
        const cwdEl = banner.querySelector('.active-session-cwd');
        const backendEl = banner.querySelector('.active-session-backend');
        if (nameEl) nameEl.textContent = displayName;
        if (cwdEl) cwdEl.textContent = session.working_dir || '';
        if (backendEl) backendEl.textContent = `backend: ${backendLabel}`;

        // Stash the fresh session on the button handlers' closure source
        // so clicks always act on the latest state (prevents stale-session
        // races if the user leaves the launchpad open for a long time).
        this._activeSession = session;

        banner.hidden = false;
    }

    /**
     * "Return to terminal" click handler. Delegates to App, which owns
     * screen-transition state — we just pass the session and let App
     * re-open the WS against the existing backend.
     */
    async handleReturnToTerminal() {
        const session = this._activeSession;
        if (!session) {
            console.warn('Launchpad: return clicked but no active session cached');
            this.refreshActiveSessionBanner();
            return;
        }
        if (window.App && typeof window.App.returnToExistingTerminal === 'function') {
            await window.App.returnToExistingTerminal(session);
        } else {
            console.error('Launchpad: App.returnToExistingTerminal unavailable');
        }
    }

    /**
     * "End session" click handler. Reuses the shared confirmation-modal
     * pattern and the existing destroy-session API. On success we hide
     * the banner (and the user stays on the launchpad to pick what's next).
     */
    async handleEndActiveSession() {
        const session = this._activeSession;
        const label = (session && (session.id || '')).replace(/^adopted:/, '') || 'this session';
        const confirmed = await this.showConfirmModal(
            'end session',
            `are you sure you want to end "${this._escapeHtml(label)}"?`,
            'the tmux pane will be killed. any unsaved shell state will be lost.'
        );
        if (!confirmed) return;

        try {
            this.updateStatus('ending session...');
            await window.API.destroySession();
            this._activeSession = null;
            // Refresh both projects (LRU ordering) and banner. Keep the
            // adopt list in sync too — once the active backend is gone,
            // any previously-filtered external session may reappear.
            await this.loadProjects();
        } catch (error) {
            console.error('Launchpad: failed to end session:', error);
            this.showError('failed to end session: ' + (error.message || error));
        }
    }

    /**
     * Fetch externally-started tmux sessions that can be adopted and
     * refresh the "Adopt an external session" panel.
     *
     * Fails soft: on any error we clear the list and let the empty-state
     * render explain the situation. Never throws to the caller — the
     * launchpad's main flow should work even if this endpoint 500s.
     */
    async loadAttachableSessions() {
        try {
            const sessions = await window.API.listAttachableSessions();
            // Defensive filter: even though the server already excludes the
            // currently-active backend, we also drop any row whose name
            // matches the live session. Covers races where the server
            // responded before our own session was registered.
            const activeName = this._getActiveSessionName();
            this.attachableSessions = (sessions || []).filter(
                s => !activeName || s.name !== activeName
            );
        } catch (error) {
            console.error('Launchpad: Failed to load attachable sessions:', error);
            this.attachableSessions = [];
        }
        this.renderAttachableList();
    }

    /**
     * Best-effort read of the currently-active backend's tmux session name.
     * Used for the self-adopt UI filter. Returns null when no session is
     * active or the controller isn't wired up yet.
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
     * HTML-escape helper used by adopt section renderer. Session names come
     * from the tmux daemon and are technically user-controlled — any
     * embedded `<`, `>`, `"`, `'`, `&` in a name would break innerHTML.
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
     * Render the "Adopt an external session" panel.
     *
     * Three states handled:
     *   - empty: friendly prompt explaining how to make sessions appear
     *   - populated: one row per session with attach button
     * The disclosure (`<details>`) above the list is static and rendered
     * once in renderLaunchpadUI — we only repaint the list body here.
     */
    renderAttachableList() {
        const listEl = document.getElementById('adopt-list');
        if (!listEl) return;

        if (!this.attachableSessions || this.attachableSessions.length === 0) {
            listEl.innerHTML = `
                <div class="launchpad-empty">
                    no external sessions detected<br>
                    <small style="color: #666;">start one with <code>tmux -L cloude new -s &lt;name&gt;</code></small>
                </div>
            `;
            return;
        }

        listEl.innerHTML = this.attachableSessions.map((s) => {
            const name = this._escapeHtml(s.name);
            const windows = typeof s.window_count === 'number' ? s.window_count : '?';
            const rel = this._formatRelativeTime(s.created_at_epoch);
            return `
                <div class="project-item adopt-item" data-name="${name}">
                    <div class="project-name">» ${name}</div>
                    <div class="project-description">${windows} window${windows === 1 ? '' : 's'} · created ${rel}</div>
                    <button class="modal-btn modal-btn-primary adopt-attach-btn" data-name="${name}">attach</button>
                </div>
            `;
        }).join('');

        // Wire attach buttons. Stop propagation so clicking the button
        // doesn't also bubble to the row click (if we ever add one).
        listEl.querySelectorAll('.adopt-attach-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const name = btn.dataset.name;
                if (name) await this.handleAttachClick(name);
            });
        });
    }

    /**
     * Attach-button click handler.
     *
     * Flow:
     *   1. If a session is active (cheap local check + server-authoritative
     *      cross-check), prompt for teardown confirmation.
     *   2. Call the adopt endpoint — server handles the destroy + rebirth.
     *   3. On success, dispatch `session-created` with the adopt-specific
     *      detail payload so App.showTerminal() can plumb scrollback to
     *      the terminal controller.
     *   4. On 409, surface an actionable error — another session appeared
     *      between our check and the server's view of the world.
     */
    async handleAttachClick(name) {
        console.log('Launchpad: attach click for', name);

        // Check active session. Local flag is cheap; if set OR the server
        // says we have one, we must confirm teardown.
        let hasActive = !!(window.TerminalController && window.TerminalController.sessionActive);
        let activeDesc = null;
        try {
            const data = await window.API.getSession();
            const s = (data && (data.session || data)) || null;
            if (s && s.id) {
                hasActive = true;
                activeDesc = s.tmux_session || s.id || null;
            }
        } catch (err) {
            // 404 = no active session; anything else we treat conservatively
            // as "no confirmation needed" only if the local flag is also false.
            if (!hasActive) {
                console.log('Launchpad: getSession() non-OK while checking active; treating as no active session', err && err.message);
            }
        }

        if (hasActive) {
            const descSuffix = activeDesc ? ` "${this._escapeHtml(activeDesc)}"` : '';
            const ok = await this.showConfirmModal(
                'end current session?',
                `attaching to "${this._escapeHtml(name)}" will end your current session${descSuffix}.`,
                'your current session\'s tmux pane will be killed. the external session you\'re adopting keeps running — detaching from the web UI later will not kill it.'
            );
            if (!ok) {
                console.log('Launchpad: adopt cancelled by user');
                return;
            }
        }

        try {
            this.updateStatus(`adopting ${name}...`);
            const response = await window.API.adoptSession(name, hasActive);
            console.log('Launchpad: adopt succeeded', response);

            const session = response.session || response;
            const initialScrollbackB64 = response.initial_scrollback_b64 || '';
            const fifoStartOffset = typeof response.fifo_start_offset === 'number'
                ? response.fifo_start_offset
                : null;

            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session, initialScrollbackB64, fifoStartOffset, adopted: true }
            }));
        } catch (error) {
            console.error('Launchpad: adopt failed:', error);
            // 409 = race between our local check and the server's view.
            // The server's message is already descriptive; surface it.
            if (error && /409|confirm_teardown|Active session/i.test(error.message || '')) {
                this.showError('another session is active — refresh and try again, or destroy the current session first.');
            } else {
                this.showError(`failed to adopt "${name}": ${error.message || error}`);
            }
        }
    }

    /**
     * Render launchpad UI structure
     */
    renderLaunchpadUI() {
        this.launchpadScreen.innerHTML = `
            <div class="launchpad-container">
                <div class="launchpad-header">☁️ Cloude Code Launcher</div>
                <div class="launchpad-prompt">select a project or create a new project</div>

                <div class="active-session-banner" id="active-session-banner" hidden>
                    <div class="active-session-info">
                        <div class="active-session-title" title="Your browser has detached but the tmux session is still alive on the server. Click Return to re-attach and continue streaming.">⏸ session running: <span class="active-session-name"></span></div>
                        <div class="active-session-meta">
                            <span class="active-session-cwd"></span>
                            <span class="active-session-sep"> · </span>
                            <span class="active-session-backend"></span>
                        </div>
                    </div>
                    <div class="active-session-actions">
                        <button class="modal-btn modal-btn-primary active-session-return" id="active-session-return">return to terminal</button>
                        <button class="modal-btn modal-btn-secondary active-session-end" id="active-session-end">end session</button>
                    </div>
                </div>

                <div class="launchpad-section">
                    <div class="launchpad-section-title">► new project</div>
                    <button class="new-session-btn" id="new-session-btn">
                        <span>⚡</span>
                        <span>create new project</span>
                    </button>
                    <button class="new-session-btn" id="open-folder-btn">
                        <span>📁</span>
                        <span>open project from folder</span>
                    </button>
                </div>

                <div class="launchpad-section" id="launchpad-adopt">
                    <div class="launchpad-section-title">
                        ► adopt an external session
                        <details class="adopt-disclosure">
                            <summary>?</summary>
                            <div class="adopt-disclosure-body">
                                <p>Only sessions started under <code>tmux -L cloude</code> appear here. Start a plain session with <code>tmux -L cloude new -s &lt;name&gt;</code>.</p>
                                <p>To launch claude in one line, pipe it in as the pane's root command:</p>
                                <pre class="adopt-disclosure-code"><code>tmux -L cloude new -s mywork "claude --dangerously-skip-permissions; exec $SHELL"</code></pre>
                                <p>The <code>exec $SHELL</code> trick keeps the pane alive with a shell prompt after claude exits — otherwise the pane closes with claude.</p>
                            </div>
                        </details>
                    </div>
                    <div id="adopt-list" class="project-list">
                        <div class="launchpad-empty">scanning for external sessions...</div>
                    </div>
                </div>

                <div class="launchpad-section" id="projects-section">
                    <div class="launchpad-section-title">► existing projects</div>
                    <div id="project-list" class="project-list">
                        <div class="launchpad-empty">loading projects...</div>
                    </div>
                </div>

                <div class="launchpad-section">
                    <div class="launchpad-section-title">► server management</div>
                    <button class="reset-server-btn" id="reset-server-btn">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M13 8C13 10.7614 10.7614 13 8 13C5.23858 13 3 10.7614 3 8C3 5.23858 5.23858 3 8 3C9.87677 3 11.5 4.01207 12.3284 5.5" stroke="#d77757" stroke-width="1.5" stroke-linecap="round"/>
                            <path d="M12 2.5V5.5H9" stroke="#d77757" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <span>reset server</span>
                    </button>
                </div>

                <div class="launchpad-footer">
                    <a href="https://DrinkBlackMarket.com" target="_blank" rel="noopener noreferrer">
                        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 827 814">
                            <path d="M 399 0 C 407.91 0 416.82 0 426 0 C 426.33 135.63 426.66 271.26 427 411 C 434.618 399.649 609.473 128.537 618 115 C 623.377 115.567 639.725 123.44 640.891 125.816 C 641.048 128.963 453.608 418.363 448 427 C 456.264 422.984 679.016 303.482 680 303 C 683.164 304.101 691.507 315.724 691.953 316.398 C 692.347 316.993 452.689 452.704 450 456 C 451.044 456.081 520.653 476.354 526 478 C 525.715 486.257 523.179 493.875 519 501 C 515.688 502.397 442.202 479.4 426 474 C 426 489.84 426 505.68 426 522 C 417.09 522 408.18 522 399 522 C 398.67 506.16 398.34 490.32 398 474 C 390.373 476.347 308.499 502.028 305.633 501.866 C 303.451 500.709 296.607 482.74 297 478 C 298.107 477.671 371.612 454.981 374 454 C 372.855 453.413 138.231 328.154 131 324 C 131.362 318.049 141.707 304.675 143 303 C 148.977 304.654 374.147 426.136 377 427 C 367.051 411.432 183.948 128.542 184.196 125.953 C 185.641 122.443 202.468 115.478 207 115 C 207.49 115.777 207.49 115.777 207.991 116.57 C 211.17 121.608 396.858 409.287 398 411 C 398.33 275.37 398.66 139.74 399 0 Z" fill="#d77757" transform="matrix(0.999974, 0.007264, -0.007264, 0.999974, 0, 0)"/>
                            <path d="M 7 529 C 14.866 529.557 387.15 649.223 392.79 651.283 C 405.483 655.806 415.028 657.457 427.526 652.007 C 432.7 649.9 817.501 528.914 820 529 C 821.207 532.556 826.648 553.159 826 556 C 792.238 566.782 490.79 662.27 463 671 C 465.852 672.901 797.149 777.901 826 787 C 826.922 791.046 820.856 811.478 820 814 C 813.295 813.418 411.629 687.261 406 689 C 404.991 689.303 11 814 7 814 C 5.793 810.444 0.352 789.841 1 787 C 36.966 775.49 337.27 680.359 364 672 C 361.079 670.052 28.79 564.73 1 556 C -0.082 552.02 6.144 531.522 7 529 Z" fill="#d77757" transform="matrix(0.999974, 0.007264, -0.007264, 0.999974, -0.000025, -0.000024)"/>
                        </svg>
                    </a>
                </div>
            </div>
        `;

        // Event listeners
        document.getElementById('new-session-btn').addEventListener('click', () => {
            this.createNewSession();
        });

        document.getElementById('open-folder-btn').addEventListener('click', () => {
            this.openProjectFromFolder();
        });

        document.getElementById('reset-server-btn').addEventListener('click', () => {
            this.resetServer();
        });

        // Active-session banner buttons. Wired once at UI-render time;
        // refreshActiveSessionBanner() just shows/hides and repopulates
        // the name/cwd/backend spans — no need to re-bind on every load.
        const returnBtn = document.getElementById('active-session-return');
        if (returnBtn) {
            returnBtn.addEventListener('click', () => this.handleReturnToTerminal());
        }
        const endBtn = document.getElementById('active-session-end');
        if (endBtn) {
            endBtn.addEventListener('click', () => this.handleEndActiveSession());
        }

        // Note: loadProjects() will be called by App.showLaunchpad()
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
                    <button class="project-delete-btn" data-name="${project.name}" title="Delete project">×</button>
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
                // Don't open project if clicking delete button
                if (e.target.classList.contains('project-delete-btn')) {
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
    }

    /**
     * Delete a project
     */
    async deleteProject(projectName) {
        try {
            // Show confirmation modal
            const confirmed = await this.showConfirmModal(
                'delete project',
                `are you sure you want to delete "${projectName}"?`,
                'this will only remove it from the launcher. the actual files will not be deleted.'
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
     * Reset the server
     */
    async resetServer() {
        try {
            // Show confirmation modal
            const confirmed = await this.showConfirmModal(
                'reset server',
                'are you sure you want to reset the server?',
                'this will stop and restart the server. any active sessions will be terminated.'
            );

            if (!confirmed) {
                return;
            }

            // Show loading state
            this.updateStatus('resetting server...');

            // Call reset API
            await window.API.resetServer();

            console.log('Launchpad: Server reset initiated');

            // Show success message
            this.updateStatus('server reset initiated - reconnecting...');

            // Wait a moment for the server to restart, then reload the page
            setTimeout(() => {
                window.location.reload();
            }, 3000);

        } catch (error) {
            console.error('Launchpad: Failed to reset server:', error);
            this.showError('failed to reset server: ' + error.message);
        }
    }

    /**
     * Show confirmation modal
     * @param {string} title - Modal title
     * @param {string} message - Main message
     * @param {string} [details] - Additional details (optional)
     * @param {string} [primaryLabel='confirm'] - Label for the primary (destructive / intent) button
     * @param {string} [secondaryLabel='cancel'] - Label for the safe no-op button
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled. Cancel is ALWAYS a no-op — callers must never map cancel to a destructive action.
     */
    showConfirmModal(title, message, details = null, primaryLabel = 'confirm', secondaryLabel = 'cancel') {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            // Create modal content
            overlay.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">» ${title}</div>
                    <div class="modal-body">
                        <div class="modal-message">${message}</div>
                        ${details ? `<div class="modal-description">${details}</div>` : ''}
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
     * Create new project with auto-generated workspace
     */
    async createNewSession() {
        console.log('Launchpad: Creating new project');

        try {
            // Show modal to get project details
            const projectDetails = await this.showProjectNameModal();

            if (!projectDetails) {
                console.log('Launchpad: Project creation cancelled');
                return; // User cancelled
            }

            // Show loading state
            this.updateStatus('creating new project...');

            // Create session with auto-generated path and template copying.
            // Include current xterm cell grid dims so the tmux pane is
            // birthed at the right size (avoids the 132x40 default → resize
            // flash before the WS handshake reshapes it).
            const _dims = this._getTerminalDims();
            const session = await window.API.createSession({
                auto_start_claude: true,
                copy_templates: true,
                ..._dims
            });

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
            // "create a new project". Primary = carry out that intent
            // (destroy + create). Cancel = safe no-op. Rejoin the running
            // session via the banner's "return to terminal" button.
            if (error.message.includes('already running')) {
                const currentName = this._getCurrentSessionLabel() || 'running session';
                const confirmed = await this.showConfirmModal(
                    'switch session?',
                    `creating a new project will end your current session "${this._escapeHtml(currentName)}".`,
                    'the tmux session will be killed. to keep it instead, cancel and use "return to terminal" on the banner above.',
                    'create new session',
                    'cancel'
                );
                if (confirmed) {
                    this.destroyAndCreateNew();
                }
                // Cancelled → deliberate no-op.
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
     * Destroy existing session and create new one
     */
    async destroyAndCreateNew() {
        try {
            this.updateStatus('destroying old session...');
            await window.API.destroySession();

            // Wait a moment, then create new
            setTimeout(() => this.createNewSession(), 500);
        } catch (error) {
            console.error('Launchpad: Failed to destroy session:', error);
            this.showError('failed to destroy session: ' + error.message);
        }
    }

    /**
     * Open a project by name (used by the deep-link router, Item 9).
     *
     * The router already validated the name against a strict regex, but
     * we re-verify membership in `this.projects` before calling into
     * `selectProject` — if the user clicks a deep link for a project
     * that was deleted / renamed, we surface a clear error instead of
     * calling the backend with an unknown path.
     *
     * This method is idempotent and safe to call before `loadProjects()`
     * completes — it waits up to ~2s for the project list to populate,
     * which is normally ready within one tick of `App.showLaunchpad()`.
     */
    async openProjectByName(name) {
        console.log('Launchpad: openProjectByName:', name);

        // Wait for the project list if it hasn't loaded yet. App.showLaunchpad
        // calls loadProjects() inline; this handles the race where the
        // router fires right after auth but before loadProjects resolves.
        const deadline = Date.now() + 2000;
        while ((!this.projects || this.projects.length === 0) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 50));
        }

        // Match by exact name first, then case-insensitive fallback.
        let project = (this.projects || []).find(p => p.name === name);
        if (!project) {
            project = (this.projects || []).find(
                p => p.name && p.name.toLowerCase() === name.toLowerCase()
            );
        }

        if (!project) {
            console.warn('Launchpad: deep-link project not found:', name);
            this.showError(`project not found: ${name}`);
            return;
        }

        await this.selectProject(project);
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

            // Open the project
            await this.selectProject({
                name: savedName,
                path: selectedPath,
                description: details.description || null,
            });
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
                await window.API.createProject({ name: attempt, path, description });
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
                        <div class="folder-picker-path" id="folder-picker-path">loading...</div>
                        <div class="folder-picker-toolbar">
                            <button class="folder-picker-toolbar-btn" id="folder-picker-up" title="go to parent directory">⬆ up</button>
                            <button class="folder-picker-toolbar-btn" id="folder-picker-home" title="go to home directory">🏠 home</button>
                        </div>
                        <div class="folder-picker-list" id="folder-picker-list">
                            <div class="folder-picker-empty">loading...</div>
                        </div>
                        <div class="modal-description">
                            select a folder, then click "open here" to use it as the project root.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary" id="folder-picker-cancel">cancel</button>
                        <button class="modal-btn modal-btn-primary" id="folder-picker-confirm">open here</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const pathEl = overlay.querySelector('#folder-picker-path');
            const listEl = overlay.querySelector('#folder-picker-list');
            const upBtn = overlay.querySelector('#folder-picker-up');
            const homeBtn = overlay.querySelector('#folder-picker-home');
            const confirmBtn = overlay.querySelector('#folder-picker-confirm');
            const cancelBtn = overlay.querySelector('#folder-picker-cancel');

            let currentPath = null;
            let currentParent = null;

            const close = (value) => {
                document.body.removeChild(overlay);
                resolve(value);
            };

            const loadPath = async (targetPath) => {
                listEl.innerHTML = '<div class="folder-picker-empty">loading...</div>';
                try {
                    const data = await window.API.browseDirectory(targetPath);
                    currentPath = data.path;
                    currentParent = data.parent;
                    pathEl.textContent = data.path;
                    upBtn.disabled = !data.parent;

                    if (!data.entries || data.entries.length === 0) {
                        listEl.innerHTML = '<div class="folder-picker-empty">no subfolders here</div>';
                        return;
                    }

                    listEl.innerHTML = data.entries.map(entry => `
                        <div class="folder-picker-item" data-path="${entry.path.replace(/"/g, '&quot;')}">
                            <span class="folder-picker-icon">📁</span>
                            <span class="folder-picker-name">${entry.name}</span>
                        </div>
                    `).join('');

                    listEl.querySelectorAll('.folder-picker-item').forEach(item => {
                        item.addEventListener('click', () => {
                            loadPath(item.dataset.path);
                        });
                    });
                } catch (error) {
                    console.error('Launchpad: Folder browse failed:', error);
                    listEl.innerHTML = `<div class="folder-picker-empty">error: ${error.message}</div>`;
                }
            };

            upBtn.addEventListener('click', () => {
                if (currentParent) {
                    loadPath(currentParent);
                }
            });

            homeBtn.addEventListener('click', () => {
                loadPath('~');
            });

            confirmBtn.addEventListener('click', () => {
                if (currentPath) {
                    close(currentPath);
                }
            });

            cancelBtn.addEventListener('click', () => close(null));

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    close(null);
                }
            });

            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') close(null);
            });

            // Start at the server's default location
            loadPath(null);

            setTimeout(() => confirmBtn.focus(), 100);
        });
    }

    /**
     * Select and open existing project
     */
    async selectProject(project) {
        console.log('Launchpad: Selecting project:', project.name);

        try {
            // Show loading state
            this.updateStatus(`opening ${project.name}...`);

            // Create session with project path (no template copying for existing projects).
            // Include current xterm cell grid dims so the tmux pane is birthed
            // at the right size — see the "new project" path for rationale.
            const _dims = this._getTerminalDims();
            const session = await window.API.createSession({
                working_dir: project.path,
                auto_start_claude: true,
                copy_templates: false,
                ..._dims
            });

            console.log('Launchpad: Project session created:', session);

            // Trigger session-created event
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: { session, project }
            }));

        } catch (error) {
            console.error('Launchpad: Failed to open project:', error);

            // If a session already exists, offer to SWAP to the project the
            // user just clicked. Primary button = user's stated intent
            // (open the new project, which requires killing the old tmux
            // session). Cancel = strict no-op: stays on the launchpad, the
            // banner still shows the running session, user can rejoin it
            // via the banner's "Return to terminal" button if they want.
            if (error.message.includes('already running')) {
                const currentName = this._getCurrentSessionLabel() || 'running session';
                const confirmed = await this.showConfirmModal(
                    'switch session?',
                    `opening "${this._escapeHtml(project.name)}" will end your current session "${this._escapeHtml(currentName)}".`,
                    'the tmux session will be killed. to keep it instead, cancel and use "return to terminal" on the banner above.',
                    `open ${project.name}`,
                    'cancel'
                );
                if (confirmed) {
                    this.destroyAndOpenProject(project);
                }
                // Cancelled → deliberate no-op. Do NOT destroy, do NOT
                // reconnect. User stays on launchpad with banner intact.
            } else {
                this.showError(`failed to open ${project.name}: ${error.message}`);
            }
        }
    }

    /**
     * Best-effort label for the running server-side session, used by the
     * session-collision modal copy. Prefers the cached banner session
     * (freshest, includes tmux_session name), falls back to the terminal
     * controller's local cache. Returns null if nothing is known.
     */
    _getCurrentSessionLabel() {
        try {
            const s = this._activeSession;
            if (s) {
                if (s.tmux_session) return s.tmux_session;
                if (typeof s.id === 'string') return s.id.replace(/^adopted:/, '');
            }
            const name = this._getActiveSessionName();
            if (name) return name;
        } catch (_) { /* non-fatal */ }
        return null;
    }

    /**
     * Destroy existing session and open project
     */
    async destroyAndOpenProject(project) {
        try {
            this.updateStatus('destroying old session...');
            await window.API.destroySession();

            // Wait a moment, then open project
            setTimeout(() => this.selectProject(project), 500);
        } catch (error) {
            console.error('Launchpad: Failed to destroy session:', error);
            this.showError('failed to destroy session: ' + error.message);
        }
    }

    /**
     * Update status message
     */
    updateStatus(message) {
        const statusEl = document.getElementById('statusText');
        if (statusEl) {
            statusEl.setAttribute('data-status', message);
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
