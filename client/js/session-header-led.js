/**
 * Session Header LED - the status light beside the session name in the
 * terminal header.
 *
 * THE SCREEN YOU ARE ACTUALLY LOOKING AT HAD NO LIGHT ON IT. The sidebar
 * row, the launchpad card and the project tree all painted an LED for
 * every session; the terminal header - the one surface that is on screen
 * the whole time you are working in a session - showed only the name. So
 * the status of the session you are IN was the one status you had to open
 * a list to read, which is exactly backwards.
 *
 * IT RENDERS THROUGH `SessionStatusUI.dotHtml`, NOT ITS OWN MARKUP. That
 * is the whole design: every surface in this app already delegates to
 * that one seam (which in turn delegates to `StatusLed`), so the header
 * inherits the two-ring model, the colours, the legend copy and any
 * future change to them without a second implementation to keep in step.
 * A header that drew its own dot would drift within a release.
 *
 * IT IS FED BY THE SIDEBAR'S FETCH, from one call site at the end of
 * `session-sidebar-fetch.js`'s `load()`. The row it reads is the merged
 * row the sidebar just built, so the header and the sidebar row for the
 * same session are painted from one object and cannot disagree by
 * construction.
 *
 * AND IT HAS A FALLBACK POLL, BECAUSE THAT FETCH STOPS. The sidebar
 * polls only while its drawer is OPEN, and the drawer is shut for most
 * of the time anyone spends in a session - which is exactly when this
 * light is the only status on screen. A light that freezes is worse than
 * no light, because a frozen light still looks like a measurement. So
 * this module arms its own timer at the sidebar's own cadence and the
 * tick stands down whenever the drawer is open: AT MOST ONE POLLER,
 * EVER, which is what keeps two surfaces from landing on different
 * phases and disagreeing. With no session attached it fetches nothing at
 * all and drops the light, so the launchpad and the archive cost zero
 * requests.
 *
 * WHAT IT DOES WHEN THERE IS NO ROW. It removes the light. An absent row
 * means this tab is not attached to a session (the launchpad, the archive)
 * or the poll could not name it, and a stale light left behind on the
 * header would be a claim about a session that is not on screen.
 *
 * Must load AFTER session-status-ui.js (it calls into it) and it has no
 * other dependency. Loading it before status-led.js is harmless: dotHtml
 * falls back to the legacy dot when the LED module is missing, and this
 * module never inspects what came back.
 */

console.log('[SessionHeaderLed Module] Loading...');

(function () {
    /** Element id for the light this module owns. @type {string} */
    const LED_ID = 'header-session-led';

    /** Where the light is inserted, and what it is inserted before. */
    const TITLE_ID = 'header-title-text';

    /**
     * The row describing one tmux session, out of the sidebar's list.
     *
     * Description: PURE. Matches on the literal tmux name, which is the
     *   durable identity - a session id dies on detach and is not what
     *   the header knows about itself. Returns null rather than a
     *   default row: "no row for this session" is a real outcome and the
     *   caller renders nothing for it, instead of painting an `unknown`
     *   light that would look like a measurement.
     * Inputs:
     *   rows (Array<object>|null) - merged sidebar rows.
     *   tmuxName (string|null) - the session this tab is attached to.
     * Output:
     *   object|null - the matching row, or null.
     * Example:
     *   rowFor([{name: 'cloude_a'}], 'cloude_a').name // 'cloude_a'
     */
    function rowFor(rows, tmuxName) {
        if (!tmuxName || !Array.isArray(rows)) return null;
        for (const row of rows) {
            if (row && row.name === tmuxName) return row;
        }
        return null;
    }

    /**
     * The light's markup for one row, or '' when there is nothing to say.
     *
     * Description: PURE, and the only place this module decides anything.
     *   Hands `dotHtml` the SAME signals object the sidebar row passes -
     *   `unread` drives the inner dot and `startup_gate` the whole
     *   light, neither of which a status string can express, and
     *   `status_source` is what
     *   puts "via hooks" / "via transcript" in the tooltip. `size` is set
     *   here because the header is a larger type context than a sidebar
     *   row; everything else about the light comes from the shared seam.
     * Inputs:
     *   row (object|null) - a merged sidebar row.
     * Output:
     *   string - HTML for one inline element, or '' for no row.
     * Example:
     *   ledHtmlFor({status: 'idle', unread: false}) // '<span ...>'
     */
    function ledHtmlFor(row) {
        if (!row || !window.SessionStatusUI) return '';
        return window.SessionStatusUI.dotHtml(row.status, {
            unread: !!row.unread,
            startup_gate: row.startup_gate,
            status_source: row.status_source,
            size: '10px',
        });
    }

    /**
     * Paint (or remove) the header light for the attached session.
     *
     * Description: idempotent - called on every poll tick, and writes to
     *   the DOM only when the markup it would produce differs from what
     *   is already there. That matters more here than in a list: the
     *   header is inside `#appTitle`, whose width budget
     *   `header-title-fit.js` recomputes from its children, so rewriting
     *   an unchanged light every few seconds would re-run that
     *   measurement for nothing.
     *
     *   THE LIGHT SITS BEFORE THE TITLE TEXT, inside the same `<h1>`, so
     *   it rides the header's centring and stays glued to the name at
     *   every width - the same reasoning the help button's comment in
     *   index.html gives for living there rather than beside it.
     * Inputs:
     *   rows (Array<object>|null) - merged sidebar rows.
     *   tmuxName (string|null) - the session this tab is attached to.
     * Output:
     *   void.
     * Example:
     *   SessionHeaderLed.update(rows, 'cloude_CloudeCode');
     */
    function update(rows, tmuxName) {
        const titleEl = document.getElementById(TITLE_ID);
        if (!titleEl || !titleEl.parentNode) return;
        const existing = document.getElementById(LED_ID);
        const html = ledHtmlFor(rowFor(rows, tmuxName));

        if (!html) {
            if (existing && existing.parentNode) {
                existing.parentNode.removeChild(existing);
            }
            return;
        }

        if (existing) {
            if (existing.innerHTML !== html) existing.innerHTML = html;
            return;
        }
        const holder = document.createElement('span');
        holder.id = LED_ID;
        holder.className = 'header-session-led';
        holder.innerHTML = html;
        titleEl.parentNode.insertBefore(holder, titleEl);
    }

    /**
     * Remove the header light outright.
     *
     * Description: for a screen change that is not a session - the
     *   launchpad, the archive, the auth screen. Leaving the light up
     *   would attach a session's status to a header that is naming
     *   something else. Idempotent.
     * Inputs: none.
     * Output: void.
     * Example: SessionHeaderLed.clear();
     */
    function clear() {
        const existing = document.getElementById(LED_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    /**
     * How often the fallback poll runs, in ms.
     *
     * Description: the SAME cadence as the sidebar's own poll, because
     *   it is standing in for exactly that poll and a different number
     *   would make the header visibly lag the list on some ticks. Read
     *   off the sidebar controller when it is loaded so there is one
     *   definition, with a literal fallback for the case where this
     *   module is loaded on its own (a test harness).
     * @returns {number}
     */
    function pollMs() {
        const sidebar = window.SessionSidebar;
        const C = sidebar && sidebar.constructor;
        return (C && typeof C.POLL_MS === 'number') ? C.POLL_MS : 5000;
    }

    /**
     * Turn one live SessionInfo into the row shape `ledHtmlFor` reads.
     *
     * Description: PURE. The field names are the sidebar's, deliberately,
     *   so the fallback path and the poll-fed path hand `ledHtmlFor` the
     *   same object and cannot diverge in what they express. Note the
     *   two-level payload trap this codebase is full of: `tmux_session`,
     *   `activity_status`, `unread`, `startup_gate` and `status_source`
     *   are all on the WRAPPER, not on `.session`.
     * Inputs: info (object) - one SessionInfo from GET /sessions/list.
     * Output: object - {name, status, unread, startup_gate, status_source}.
     * Example: rowFromInfo({tmux_session: 'a', activity_status: 'idle'})
     */
    function rowFromInfo(info) {
        const i = info || {};
        return {
            name: i.tmux_session || null,
            status: i.activity_status || 'unknown',
            unread: !!i.unread,
            startup_gate: i.startup_gate,
            status_source: i.status_source,
        };
    }

    /** The fallback poll's timer handle, or null. @type {any} */
    let timer = null;

    /**
     * One fallback tick: paint the header when nothing else is going to.
     *
     * Description: AT MOST ONE POLLER, EVER. The sidebar's poll runs only
     *   while its drawer is open, so with the drawer shut the header
     *   would otherwise freeze at whatever the last open drawer left
     *   behind - which is worse than no light, because a frozen light
     *   still looks like a measurement. This tick therefore covers
     *   exactly the gap: it returns immediately while the sidebar's
     *   drawer is OPEN (its fetch already calls `update` on every tick)
     *   and while no session is attached (the launchpad and the archive,
     *   where it also drops the light rather than leaving a previous
     *   session's status under a header naming something else).
     *
     *   `isOpen` is the gate rather than a poll flag because it is the
     *   condition the sidebar's own timer is started and stopped on, and
     *   it is already public - the alternative was a second accessor on
     *   a file sitting at its 500-line budget.
     * Inputs: none.
     * Output: Promise<void> - never rejects; a failed poll leaves the
     *   last painted light alone rather than blanking it, because a
     *   failed request is not evidence the session changed.
     */
    async function tick() {
        const sidebar = window.SessionSidebar;
        if (!sidebar || typeof sidebar.activeTmuxName !== 'function') return;
        const name = sidebar.activeTmuxName();
        if (!name) {
            clear();
            return;
        }
        if (sidebar.isOpen) return;
        if (!window.API || typeof window.API.listSessions !== 'function') return;
        try {
            const live = await window.API.listSessions();
            const rows = (Array.isArray(live) ? live : []).map(rowFromInfo);
            update(rows, name);
        } catch (err) {
            console.warn('SessionHeaderLed: poll tick failed:', err && err.message);
        }
    }

    /**
     * Arm the fallback poll. Idempotent.
     *
     * Description: self-arming at module load rather than wired from a
     *   screen-change handler, because every screen this app has already
     *   tells the sidebar which session is attached (or that none is),
     *   and that is the only fact this poll needs. One place decides,
     *   nothing else has to remember to call anything.
     * Inputs: none.
     * Output: void.
     * Example: SessionHeaderLed.start();
     */
    function start() {
        if (timer) return;
        timer = setInterval(() => { tick(); }, pollMs());
    }

    /**
     * Stop the fallback poll. Idempotent. For tests and teardown.
     * Inputs: none. Output: void.
     */
    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    window.SessionHeaderLed = {
        rowFor, rowFromInfo, ledHtmlFor, update, clear, start, stop, LED_ID,
    };
    if (typeof setInterval === 'function' && typeof document !== 'undefined') {
        start();
    }
    console.log('[SessionHeaderLed Module] Exported as window.SessionHeaderLed');
})();
