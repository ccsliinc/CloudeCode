/**
 * Session Sidebar Module - switch conversations without leaving the
 * terminal view.
 *
 * Mounted from a hamburger button at the top-left of the header (only
 * visible on the terminal screen, wired by app.js's showTerminal /
 * returnToExistingTerminal / showLaunchpad / showAuth). Opening it lists
 * every session (live + attachable) with a status dot; clicking a row
 * switches to that conversation in place.
 *
 * Deliberately smaller in scope than the launchpad's Running Sessions
 * list: switching, the unread flag, and the one destructive row control.
 * No inline rename - that still lives on the launchpad only, and
 * duplicating it here would be the exact "no duplicate code" violation
 * the project standards call out. The destructive control is NOT
 * duplicated either: its glyph, tooltip, and confirm copy all come from
 * the shared client/js/session-row-actions.js, so this row and the
 * launcher's row are literally the same control.
 */

console.log('[SessionSidebar Module] Loading...');

class SessionSidebarController {
    constructor() {
        this.toggleBtn = null;
        this.panel = null;
        this.backdrop = null;
        this.closeBtn = null;
        this.listEl = null;

        this.isOpen = false;
        this._wired = false;
        this._pollInterval = null;
        this._lastSig = null;

        // The currently-attached session, so the sidebar can mark its own
        // row active and skip a self-switch on click.
        this._activeSessionId = null;
        this._activeTmuxName = null;
    }

    /**
     * Storage key for open/closed persistence - follows the app's existing
     * localStorage convention (cloude.theme, cloude.audio.muted).
     * @type {string}
     */
    static get STORAGE_KEY() { return 'cloude.session.sidebar'; }

    /**
     * Poll cadence while the panel is open. Matches the launchpad's
     * Running Sessions poller (5s) so status freshness is consistent
     * across both surfaces - no separate tuning knob to keep in sync.
     * @type {number}
     */
    static get POLL_MS() { return 5000; }

    /**
     * Wire DOM elements + event listeners once. Idempotent.
     *
     * Description: Locates the hamburger toggle, panel, backdrop, close
     *   button, and list container (markup lives in client/index.html),
     *   and binds click/keydown handlers. Safe to call multiple times -
     *   guarded by `this._wired`.
     * Inputs: none.
     * Output: void.
     */
    init() {
        if (this._wired) return;
        this.toggleBtn = document.getElementById('session-sidebar-toggle');
        this.panel = document.getElementById('session-sidebar-panel');
        this.backdrop = document.getElementById('session-sidebar-backdrop');
        this.closeBtn = document.getElementById('session-sidebar-close');
        this.listEl = document.getElementById('session-sidebar-list');

        if (!this.toggleBtn || !this.panel || !this.backdrop || !this.listEl) {
            console.warn('SessionSidebar: required markup missing, skipping wire');
            return;
        }

        this.toggleBtn.addEventListener('click', () => this.toggle());
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.close());
        }
        this.backdrop.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
        this.listEl.addEventListener('click', (e) => this._onRowClick(e));
        // Keyboard activation (Enter/Space) for the mark-unread toggle -
        // it's a `role="button"` span, not a real <button>, so it needs
        // explicit key handling to be operable without a mouse.
        this.listEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const toggleEl = e.target.closest('[data-mark-unread]');
            if (!toggleEl) return;
            e.preventDefault();
            e.stopPropagation();
            this._onMarkUnreadClick(toggleEl);
        });

        this._wired = true;
        console.log('SessionSidebar: wired');
    }

    /**
     * Reveal the hamburger toggle (called on entering the terminal
     * screen). Re-opens the panel if it was open on a prior visit
     * (persisted state) so the user's layout preference survives
     * navigation.
     *
     * Inputs: none.
     * Output: void.
     */
    show() {
        this.init();
        if (!this.toggleBtn) return;
        this.toggleBtn.classList.remove('hidden');
        let stored = null;
        try { stored = localStorage.getItem(SessionSidebarController.STORAGE_KEY); } catch (_) { /* ignore */ }
        if (stored === '1' && !this.isOpen) {
            this.open();
        }
    }

    /**
     * Hide the hamburger toggle and close the panel (called on leaving
     * the terminal screen - showLaunchpad / showAuth). Does NOT clear
     * the persisted open/closed preference, only the live DOM state.
     *
     * Inputs: none.
     * Output: void.
     */
    hide() {
        this.close();
        if (this.toggleBtn) this.toggleBtn.classList.add('hidden');
    }

    /**
     * Record which session is currently attached so the row list can
     * mark it active and the row click handler can no-op on self-click.
     *
     * Inputs:
     *   sessionId (string|null) - Session.id of the attached session.
     *   tmuxName (string|null) - bare tmux session name.
     * Output: void.
     */
    setActiveSession(sessionId, tmuxName) {
        this._activeSessionId = sessionId || null;
        this._activeTmuxName = tmuxName || null;
        if (this.isOpen) this._fetchAndRender();
    }

    /** Toggle open/closed. */
    toggle() {
        if (this.isOpen) this.close(); else this.open();
    }

    /**
     * Open the panel: reveals it, starts the poller, persists the
     * open state, and does an immediate fetch so the list isn't stale
     * for up to POLL_MS on open.
     */
    open() {
        if (!this.panel) return;
        this.isOpen = true;
        this.panel.classList.add('session-sidebar-panel--open');
        this.panel.setAttribute('aria-hidden', 'false');
        this.backdrop.hidden = false;
        this.toggleBtn.setAttribute('aria-expanded', 'true');
        try { localStorage.setItem(SessionSidebarController.STORAGE_KEY, '1'); } catch (_) { /* ignore */ }
        this._fetchAndRender();
        this._startPoll();
    }

    /** Close the panel and stop polling (no point polling hidden UI). */
    close() {
        if (!this.panel) return;
        this.isOpen = false;
        this.panel.classList.remove('session-sidebar-panel--open');
        this.panel.setAttribute('aria-hidden', 'true');
        this.backdrop.hidden = true;
        if (this.toggleBtn) this.toggleBtn.setAttribute('aria-expanded', 'false');
        try { localStorage.setItem(SessionSidebarController.STORAGE_KEY, '0'); } catch (_) { /* ignore */ }
        this._stopPoll();
    }

    _startPoll() {
        if (this._pollInterval) return;
        this._pollInterval = setInterval(() => {
            this._fetchAndRender().catch((err) => {
                console.warn('SessionSidebar: poll tick failed:', err);
            });
        }, SessionSidebarController.POLL_MS);
    }

    _stopPoll() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    /**
     * Fetch the merged session list (live + attachable) and repaint.
     *
     * Description: Same two-endpoint merge the launchpad uses
     *   (GET /sessions/attachable for detached/external rows,
     *   GET /sessions/list for currently-live ones, each SessionInfo
     *   carrying `activity_status`), trimmed to what the sidebar
     *   actually renders. Both calls tolerate failure independently so
     *   a transient error on one doesn't blank the whole list.
     * Inputs: none.
     * Output: Promise<void>.
     */
    async _fetchAndRender() {
        let rows = [];
        try {
            const attachable = await window.API.listAttachableSessions();
            rows = Array.isArray(attachable) ? attachable.slice() : [];
        } catch (err) {
            console.error('SessionSidebar: listAttachableSessions failed:', err);
        }

        try {
            const live = typeof window.API.listSessions === 'function'
                ? await window.API.listSessions()
                : [];
            for (const info of (Array.isArray(live) ? live : [])) {
                const tmuxName = info && info.tmux_session;
                if (!tmuxName) continue;
                const sessionId = (info.session && info.session.id) || null;
                const status = info.activity_status || 'unknown';
                const unread = !!info.unread;
                const existing = rows.find((r) => r.name === tmuxName);
                if (existing) {
                    existing.is_active = true;
                    existing.session_id = sessionId;
                    existing.status = status;
                    existing.unread = unread;
                } else {
                    rows.unshift({
                        name: tmuxName,
                        created_by_cloude: true,
                        created_at_epoch: 0,
                        is_active: true,
                        session_id: sessionId,
                        status,
                        unread,
                    });
                }
            }
        } catch (err) {
            // No active session for this tab - fine, rows stays as-is.
        }

        // Mark this tab's own attached session (may differ from any
        // row's is_active flag if the fetch raced a switch).
        for (const row of rows) {
            row.is_this_tab = !!this._activeTmuxName && row.name === this._activeTmuxName;
        }

        rows.sort((a, b) => {
            if (!!a.is_this_tab !== !!b.is_this_tab) return a.is_this_tab ? -1 : 1;
            if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
            return (b.created_at_epoch || 0) - (a.created_at_epoch || 0);
        });

        this.render(rows);
    }

    /**
     * Paint the row list. Skips the DOM rewrite when the signature
     * (name/status/active) hasn't changed since the last render, so the
     * 5s poll tick doesn't thrash focus/scroll position while the panel
     * is open and idle.
     *
     * Inputs:
     *   rows (Array<object>) - merged + sorted session rows.
     * Output: void.
     */
    render(rows) {
        if (!this.listEl) return;

        const sig = JSON.stringify(rows.map((r) => ({
            name: r.name,
            status: r.status || 'unknown',
            active: !!r.is_active,
            thisTab: !!r.is_this_tab,
            unread: !!r.unread,
        })));
        if (sig === this._lastSig) return;
        this._lastSig = sig;

        if (rows.length === 0) {
            this.listEl.innerHTML = '<div class="session-sidebar-empty">no other conversations</div>';
            return;
        }

        this.listEl.innerHTML = rows.map((r) => {
            const dot = window.SessionStatusUI ? window.SessionStatusUI.dotHtml(r.status) : '';
            const name = this._escapeHtml(r.name);
            const badge = r.created_by_cloude ? 'tmux' : 'external';
            const sidAttr = r.session_id ? ` data-session-id="${this._escapeHtml(r.session_id)}"` : '';
            const markUnread = window.SessionStatusUI
                ? window.SessionStatusUI.markUnreadHtml(r.name, !!r.unread)
                : '';
            // X (close) on a running row, trash (remove) on a stopped
            // one, never both. Built by the shared SessionRowActions
            // module so this row and the launcher's running-session row
            // are the same control with the same tooltip and the same
            // confirm copy - see client/js/session-row-actions.js.
            const rowAction = window.SessionRowActions
                ? window.SessionRowActions.html(r.status, r.name, 'session-sidebar-row-delete')
                : '';
            return `
                <div class="session-sidebar-row" data-name="${name}" data-active="${r.is_this_tab ? '1' : '0'}"${sidAttr}>
                    ${dot}
                    <span class="session-sidebar-row-name">${name}</span>
                    <span class="session-sidebar-row-badge">${badge}</span>
                    ${markUnread}
                    ${rowAction}
                </div>
            `;
        }).join('');
    }

    /**
     * Row click: switch to that conversation. Reuses the same two paths
     * the launchpad uses (return-to-active vs adopt-external) so the
     * behavior is identical regardless of which surface the user
     * clicked from.
     *
     * Inputs:
     *   e (MouseEvent) - delegated click event from the list container.
     * Output: Promise<void>.
     */
    async _onRowClick(e) {
        // The close/remove control takes priority over everything else
        // below: it's a nested control inside the row, and clicking it
        // must never ALSO trigger a conversation switch or mark-unread
        // toggle.
        const actionEl = window.SessionRowActions
            ? e.target.closest(`[${window.SessionRowActions.ATTR_ACTION}]`)
            : null;
        if (actionEl) {
            e.stopPropagation();
            await this._onRowActionClick(actionEl);
            return;
        }

        // Mark-unread toggle takes priority over the row-switch handler
        // below — it's a nested control inside the row, and clicking it
        // must never ALSO trigger a conversation switch.
        const toggleEl = e.target.closest('[data-mark-unread]');
        if (toggleEl) {
            e.stopPropagation();
            await this._onMarkUnreadClick(toggleEl);
            return;
        }

        const rowEl = e.target.closest('.session-sidebar-row');
        if (!rowEl) return;
        const name = rowEl.dataset.name;
        if (!name || name === this._activeTmuxName) {
            // Clicking the already-attached session - nothing to do.
            this.close();
            return;
        }
        const sessionId = rowEl.dataset.sessionId || null;

        try {
            // A row carries session_id only when it came from
            // GET /sessions/list - i.e. it's bound to a live backend
            // (this tab's or another browser tab's) and can be rejoined
            // directly. No session_id means it's attachable-only (a
            // detached-but-alive or externally-started tmux session) and
            // must go through the adopt flow instead.
            if (sessionId) {
                const info = await window.API.getSession(sessionId, { includeScrollback: true });
                if (info) {
                    this.close();
                    window.App.returnToExistingTerminal(info);
                }
                return;
            }
            // Not yet attached anywhere - adopt it. Mirrors
            // launchpad._handleAttachRunningSession's core path; the
            // sidebar skips the auto-add-to-recent-projects step since
            // that's a launchpad-specific convenience, not part of
            // "switch conversations".
            const response = await window.API.adoptSession(name, true);
            const session = response.session || response;
            this.close();
            window.dispatchEvent(new CustomEvent('session-created', {
                detail: {
                    session,
                    initialScrollbackB64: response.initial_scrollback_b64 || '',
                    fifoStartOffset: typeof response.fifo_start_offset === 'number'
                        ? response.fifo_start_offset
                        : null,
                    adopted: true,
                },
            }));
        } catch (err) {
            console.error('SessionSidebar: switch failed:', err);
            alert(`Error: failed to switch conversation: ${err.message || err}`);
        }
    }

    /**
     * Toggle the manual unread flag for one row and re-render immediately
     * (optimistic — the next poll tick reconciles with the server either
     * way, but waiting a full POLL_MS for visual feedback on a click
     * would feel broken).
     *
     * Inputs:
     *   toggleEl (Element) - the `[data-mark-unread]` span that was
     *     clicked, carrying the tmux name and current state as data-*.
     * Output: Promise<void>.
     */
    async _onMarkUnreadClick(toggleEl) {
        const tmuxName = toggleEl.dataset.markUnread;
        if (!tmuxName) return;
        const next = toggleEl.dataset.unreadCurrent !== 'true';
        try {
            await window.API.setSessionUnread(tmuxName, next);
            this._lastSig = null; // force a repaint even if the poll sig matches
            await this._fetchAndRender();
        } catch (err) {
            console.error('SessionSidebar: mark-unread failed:', err);
        }
    }

    /**
     * Run a sidebar row's destructive action - close a running session
     * (X) or remove a stopped one from the list (trash). Which action the
     * row painted is read back off the button, so the confirm always
     * matches the control the user clicked.
     *
     * THIS tab's own active session delegates straight to
     * `TerminalController.destroySession(action)` - avoids a double
     * confirm dialog and a stale-WS state only that method knows how to
     * avoid (it confirms with the same shared copy, destroys, closes the
     * WS, and navigates to the launchpad). The row's action is PASSED
     * THROUGH rather than dropped: this branch used to call it with no
     * argument, so an own-tab row painted with a trash still confirmed
     * with the close copy and told the user a process was about to be
     * terminated when it had already exited. Any OTHER row confirms here
     * via the shared `SessionRowActions.confirm()` then destroys via the
     * API directly, mirroring
     * `LaunchpadController._handleSessionRowAction()`'s resolve-sid-or-
     * external logic so both surfaces behave identically; this tab's own
     * terminal is untouched, only the sidebar list re-renders.
     *
     * Inputs:
     *   btnEl (Element) - the clicked `[data-session-action]` button.
     * Output: Promise<void>. No-op if the user cancels.
     */
    async _onRowActionClick(btnEl) {
        const actions = window.SessionRowActions;
        const name = btnEl.getAttribute(actions.ATTR_NAME);
        if (!name) return;
        const action = btnEl.getAttribute(actions.ATTR_ACTION) || actions.ACTION_CLOSE;
        const rowEl = btnEl.closest('.session-sidebar-row');
        const isThisTab = !!rowEl && rowEl.dataset.active === '1';

        if (isThisTab) {
            this.close();
            await window.TerminalController.destroySession(action);
            return;
        }

        const confirmed = await actions.confirm(action, name);
        if (!confirmed) return;

        try {
            const sessionId = rowEl ? (rowEl.dataset.sessionId || null) : null;
            if (sessionId) {
                await window.API.destroySession(sessionId);
            } else {
                await window.API.destroyExternalSession(name);
            }
            this._lastSig = null; // force a repaint even if the poll sig matches
            await this._fetchAndRender();
        } catch (err) {
            console.error(`SessionSidebar: ${action} failed:`, err);
            alert(`Error: failed to ${action} conversation: ${err.message || err}`);
        }
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }
}

window.SessionSidebar = new SessionSidebarController();
console.log('[SessionSidebar Module] Exported as window.SessionSidebar');
