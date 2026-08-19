/**
 * Session Sidebar Module - the user's working set of SESSIONS, available
 * from every screen.
 *
 * Mounted from a hamburger button at the top-left of the header. It used
 * to appear only on the terminal screen; it is now available on the HOME
 * screen too, and can be pinned there, because switching between the
 * conversations you are working on is not a thing you only want to do
 * once you are already inside one of them. The home screen keeps its own
 * project-to-session tree - this bar is not a project browser and does
 * not try to be one.
 *
 * THE FOUR SIBLING MODULES, and why this file is not all of them:
 *   session-sidebar-fetch.js        two endpoints -> one row list, plus
 *                                   the verdict about whether the probe
 *                                   answered at all
 *   session-sidebar-arrangement.js  which sessions are pinned, and the
 *                                   order the user put them in
 *   session-sidebar-reorder.js      the keyboard and pointer interactions
 *                                   that change that arrangement
 *   session-sidebar-density.js      how much each row says
 *   session-sidebar-rows.js         the row markup
 *   session-sidebar-pin.js          pinning the BAR docked open
 * This file owns the panel: open, close, poll, paint, and route a click.
 *
 * TWO DIFFERENT PINS LIVE HERE. Pinning the BAR (docked, no backdrop) is
 * session-sidebar-pin.js. Pinning a SESSION (sorted to the top band) is
 * session-sidebar-arrangement.js. The user asked for both, in separate
 * sentences, so neither name was free to mean the other.
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

        // Last painted rows + verdict, so a repaint triggered by a local
        // change (pin, move, density) does not have to wait for a fetch.
        this._rows = [];
        this._listing = { ok: true, reason: null, detail: null };
        this._missing = [];

        this._activeSessionId = null;
        this._activeTmuxName = null;
    }

    /**
     * Storage key for open/closed persistence - follows the app's existing
     * localStorage convention (cloude.theme, cloude.audio.volume).
     * @type {string}
     */
    static get STORAGE_KEY() { return 'cloude.session.sidebar'; }

    /**
     * Poll cadence while the panel is open. Matches the launchpad's
     * Running Sessions poller (5s) so status freshness is consistent
     * across both surfaces.
     * @type {number}
     */
    static get POLL_MS() { return 5000; }

    /**
     * Description: wire DOM elements + event listeners once, and load the
     *   persisted arrangement and density. Idempotent.
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
            // A PINNED bar is part of the layout, not something overlaid
            // that Escape should sweep away - see session-sidebar-pin.js.
            if (e.key !== 'Escape' || !this.isOpen) return;
            if (window.SessionSidebarPin && window.SessionSidebarPin.isEffectivelyPinned()) return;
            this.close();
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
        if (window.SessionSidebarArrangement) window.SessionSidebarArrangement.load();
        if (window.SessionSidebarPin) window.SessionSidebarPin.init();
        if (window.SessionSidebarDensity) window.SessionSidebarDensity.init();
        if (window.SessionSidebarReorder) window.SessionSidebarReorder.init();
        console.log('SessionSidebar: wired');
    }

    /**
     * Description: reveal the hamburger toggle and re-open the panel if it
     *   was open on a prior visit. Called on entering the terminal screen
     *   AND the home screen - the bar is available on both, which is why
     *   this takes no screen argument: there is nothing screen-specific
     *   left in it.
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
        } else if (window.SessionSidebarPin) {
            window.SessionSidebarPin.apply();
        }
    }

    /**
     * Description: hide the hamburger toggle and close the panel, WITHOUT
     *   clearing the persisted open/closed preference. That distinction is
     *   the whole reason `close()` takes an argument: leaving a screen is
     *   not the user closing the bar, and treating it as one meant a
     *   pinned-open bar came back closed after one round trip through the
     *   home screen.
     * Inputs: none.
     * Output: void.
     */
    hide() {
        this.close({ persist: false });
        if (this.toggleBtn) this.toggleBtn.classList.add('hidden');
    }

    /**
     * Description: record which session is currently attached so the row
     *   list can mark it active and the click handler can no-op on a
     *   self-click.
     * Inputs: sessionId (string|null), tmuxName (string|null).
     * Output: void.
     */
    setActiveSession(sessionId, tmuxName) {
        this._activeSessionId = sessionId || null;
        this._activeTmuxName = tmuxName || null;
        if (this.isOpen) this._fetchAndRender();
    }

    /** Description: toggle open/closed. Inputs: none. Output: void. */
    toggle() {
        if (this.isOpen) this.close(); else this.open();
    }

    /**
     * Description: open the panel, start the poller, persist the open
     *   state, and fetch immediately so the list is not stale for up to
     *   POLL_MS.
     * Inputs: none.
     * Output: void.
     */
    open() {
        if (!this.panel) return;
        this.isOpen = true;
        this.panel.classList.add('session-sidebar-panel--open');
        this.panel.setAttribute('aria-hidden', 'false');
        this.backdrop.hidden = false;
        this.toggleBtn.setAttribute('aria-expanded', 'true');
        try { localStorage.setItem(SessionSidebarController.STORAGE_KEY, '1'); } catch (_) { /* ignore */ }
        if (window.SessionSidebarDensity) window.SessionSidebarDensity.apply();
        if (window.SessionSidebarPin) window.SessionSidebarPin.apply();
        this._fetchAndRender();
        this._startPoll();
    }

    /**
     * Description: close the panel and stop polling.
     * Inputs: opts (object) - {persist (boolean)}, default true. Pass
     *   `{persist: false}` when the bar is being taken off screen for a
     *   reason that is not the user closing it.
     * Output: void.
     */
    close(opts) {
        if (!this.panel) return;
        const persist = !opts || opts.persist !== false;
        this.isOpen = false;
        this.panel.classList.remove('session-sidebar-panel--open');
        this.panel.setAttribute('aria-hidden', 'true');
        this.backdrop.hidden = true;
        if (this.toggleBtn) this.toggleBtn.setAttribute('aria-expanded', 'false');
        if (persist) {
            try { localStorage.setItem(SessionSidebarController.STORAGE_KEY, '0'); } catch (_) { /* ignore */ }
        }
        if (window.SessionSidebarPin) window.SessionSidebarPin.apply();
        this._stopPoll();
    }

    /**
     * Description: close the bar after a conversation switch, unless it is
     *   pinned open. Every switch path routes through this rather than
     *   calling close() directly, so "pinned means it stays put" is
     *   decided in exactly one place.
     * Inputs: none. Output: void.
     */
    _closeAfterSwitch() {
        if (window.SessionSidebarPin) window.SessionSidebarPin.closeAfterSwitch();
        else this.close();
    }

    /** Description: start the poll timer. Inputs: none. Output: void. */
    _startPoll() {
        if (this._pollInterval) return;
        this._pollInterval = setInterval(() => {
            this._fetchAndRender().catch((err) => {
                console.warn('SessionSidebar: poll tick failed:', err);
            });
        }, SessionSidebarController.POLL_MS);
    }

    /** Description: stop the poll timer. Inputs: none. Output: void. */
    _stopPoll() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    /**
     * Description: fetch the merged session list and repaint. A poll tick
     *   that lands mid-drag is dropped rather than applied: reordering the
     *   list out from under a finger that is holding a row is a data race
     *   the user can see.
     * Inputs: none.
     * Output: Promise<void>.
     */
    async _fetchAndRender() {
        if (window.SessionSidebarReorder && window.SessionSidebarReorder.isDragging()) return;
        const result = await window.SessionSidebarFetch.load(this._activeTmuxName);
        this._listing = result.listing;
        this._rows = result.rows;
        this.repaint();
    }

    /**
     * Description: apply the user's arrangement to the last fetched rows
     *   and paint. Separate from the fetch so a pin, a move or a density
     *   change repaints instantly instead of waiting for the next poll.
     *
     *   The signature diff that skips a no-op DOM rewrite now includes the
     *   arrangement and the density, because both are things the row
     *   SHOWS; leaving them out meant a pin the user just clicked did not
     *   paint until something unrelated happened to change.
     * Inputs: none.
     * Output: void.
     */
    repaint() {
        if (!this.listEl) return;
        const arrangement = window.SessionSidebarArrangement;
        const density = window.SessionSidebarDensity
            ? window.SessionSidebarDensity.currentMode()
            : 'cozy';
        let rows = this._rows;
        let missing = [];
        if (arrangement) {
            const arranged = arrangement.arrange(this._rows);
            rows = arranged.rows;
            missing = arranged.missing;
        }
        this._missing = missing;
        const state = arrangement ? arrangement.current() : null;
        const sig = window.SessionSidebarRows.signature(rows, density, this._listing, missing)
            + (state ? `|${state.status}` : '');
        if (sig === this._lastSig) return;
        this._lastSig = sig;
        this.listEl.setAttribute('data-listing-ok', this._listing.ok ? '1' : '0');
        this.listEl.setAttribute('data-order-missing', String(missing.length));
        this.listEl.setAttribute('data-arrangement-state', state ? state.status : 'default');
        this.listEl.setAttribute('data-density', density);
        this.listEl.innerHTML = window.SessionSidebarRows.listHtml(
            rows, density, this._listing, missing, state,
        );
        if (window.SessionSidebarReorder) window.SessionSidebarReorder.afterRender();
    }

    /**
     * Description: legacy entry point kept so any caller that hands rows
     *   in still works; stores them and repaints through the one path.
     * Inputs: rows (Array<object>). Output: void.
     */
    render(rows) {
        this._rows = Array.isArray(rows) ? rows : [];
        this.repaint();
    }

    /**
     * Description: route a click inside the list. Order matters: every
     *   nested control must claim the click before the row-level switch
     *   handler sees it, or clicking pin would also navigate.
     * Inputs: e (MouseEvent).
     * Output: Promise<void>.
     */
    async _onRowClick(e) {
        if (window.SessionSidebarReorder && window.SessionSidebarReorder.onPinClick(e)) return;

        const actionEl = window.SessionRowActions
            ? e.target.closest(`[${window.SessionRowActions.ATTR_ACTION}]`)
            : null;
        if (actionEl) {
            e.stopPropagation();
            await this._onRowActionClick(actionEl);
            return;
        }

        const toggleEl = e.target.closest('[data-mark-unread]');
        if (toggleEl) {
            e.stopPropagation();
            await this._onMarkUnreadClick(toggleEl);
            return;
        }

        // A click that landed on the grip was a drag gesture, not a
        // switch - the pointer handlers own it.
        if (e.target.closest('[data-grip-session]')) return;

        const rowEl = e.target.closest('.session-sidebar-row');
        if (!rowEl) return;
        await this.activateRow(rowEl);
    }

    /**
     * Description: switch to the conversation a row names. Reuses the same
     *   two paths the launchpad uses (return-to-active vs adopt-external)
     *   so behaviour is identical regardless of the surface clicked from.
     *   Public because the keyboard path (Enter on a focused row) needs
     *   the same entry point a click takes.
     * Inputs: rowEl (Element) - a `.session-sidebar-row`.
     * Output: Promise<void>.
     */
    async activateRow(rowEl) {
        const name = rowEl && rowEl.dataset.name;
        if (!name || name === this._activeTmuxName) {
            this._closeAfterSwitch();
            return;
        }
        const sessionId = rowEl.dataset.sessionId || null;
        try {
            // A row carries session_id only when it came from
            // GET /sessions/list - it is bound to a live backend and can
            // be rejoined directly. No session_id means attachable-only
            // and must go through the adopt flow instead.
            if (sessionId) {
                const info = await window.API.getSession(sessionId, { includeScrollback: true });
                if (info) {
                    this._closeAfterSwitch();
                    window.App.returnToExistingTerminal(info);
                }
                return;
            }
            const response = await window.API.adoptSession(name, true);
            const session = response.session || response;
            this._closeAfterSwitch();
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
     * Description: toggle the manual unread flag for one row and re-render
     *   immediately (optimistic - the next poll tick reconciles either
     *   way, but a full POLL_MS with no visual feedback feels broken).
     * Inputs: toggleEl (Element) - the `[data-mark-unread]` span clicked.
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
     * Description: run a row's destructive action - close a running
     *   session (X) or remove a stopped one (trash). Which action the row
     *   painted is read back off the button, so the confirm always matches
     *   the control the user clicked.
     *
     *   THIS tab's own active session delegates straight to
     *   `TerminalController.destroySession(action)` - avoids a double
     *   confirm and a stale-WS state only that method knows how to avoid.
     *   The row's action is PASSED THROUGH rather than dropped: this
     *   branch used to call it with no argument, so an own-tab row painted
     *   with a trash still confirmed with the close copy and claimed a
     *   process was about to be terminated when it had already exited.
     * Inputs: btnEl (Element) - the clicked `[data-session-action]` button.
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
}

window.SessionSidebar = new SessionSidebarController();
console.log('[SessionSidebar Module] Exported as window.SessionSidebar');
