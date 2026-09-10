/**
 * Session sidebar ROW MARKUP - the HTML for one conversation row, and
 * the repaint signature that decides whether a repaint is needed at all.
 *
 * Split out of client/js/session-sidebar.js for the project's 500-line
 * rule, and along the same seam the repo already uses for row internals:
 * client/js/session-row-actions.js owns the destructive control,
 * client/js/session-status-ui.js owns the status dot and the mark-unread
 * toggle, and client/js/session-row-menu.js owns the kebab those two now
 * fold into. This module is the row that composes them, nothing else -
 * it holds no state and touches no DOM, it only returns strings.
 *
 * PIN IS INLINE, EVERY OTHER ACTION IS IN THE MENU (owner's ruling,
 * 2026-09-10). A live row draws the pin toggle and one three-dot
 * trigger; rename, mark unread, move to group, fork, new session in
 * folder, mute, restart and close are items inside it. A DEAD row draws
 * inline restart and remove and no menu. `pinButtonHtml` is exported and
 * must stay exported.
 *
 * NO GROUP CHIP. "no i dont need to see the group name in the item. its
 * in the group i can see the group on the sidebar." The display half is
 * gone; the action half is the menu's `move to group` item.
 *
 * WHAT EACH DENSITY DRAWS (see client/js/session-sidebar-density.js for
 * the modes and where the preference lives):
 *   compact   grip, dot, name, pin, menu (restart/remove when dead)
 *   cozy      the above plus the tmux/external badge  (DEFAULT)
 *   detailed  the above, with the badge moved DOWN to a second line that
 *             also carries the session's age
 *
 * NO AGENT-FAMILY PILL, AT ANY DENSITY. "i dont think we need the pills
 * in the sidebar take out for now." The HOME screen still draws one from
 * its own builder in client/js/launchpad.js, which nothing here feeds.
 *
 * REMOVING IT ALSO REMOVED A REAL DEFECT whose shape recurs: this
 * builder put a literal `~` before a guessed family AND
 * `.family-pill--guess::before` adds another, so it rendered `~~claude`
 * while every DOM assertion read a correct `~claude`. A test that reads
 * DOM text cannot see a `::before`; only a rendered pixel can, which is
 * why scripts/verify_sidebar_sessions.py was what could have caught it.
 *
 * DETAILED'S SECOND LINE carries the tmux/external badge moved down off
 * the first line, plus the age it already had.
 *
 * ROW HEIGHTS ARE DECLARED, NOT EMERGENT: removing a glyph would
 * otherwise shorten the row, so session-sidebar-density.css pins a
 * `min-height` per density rather than letting the line's contents
 * decide it.
 *
 * A RESTART CONTROL IS EMITTED for a row whose status is `dead`. It
 * SUPERSEDES an older rule saying the sidebar could not know a session
 * was stopped rather than unknown. Both halves of that rule stopped
 * being true: `session-sidebar-fetch.js` `mergeLiveRow()` overwrites
 * `status` with the server's `activity_status` for every session this
 * app holds a backend for, and that value is `resolve_pane_status()`
 * reading tmux's own `#{pane_dead}` - so `dead` is a MEASUREMENT, while
 * a probe-only row still carries `unknown` and
 * `SessionRowActions.actionsFor` refuses to treat `unknown` as stopped.
 * And restart cannot produce "two of it": it runs `tmux respawn-pane`
 * against the pane already there (src/core/session_respawn.py), never
 * passes `-k`, and tmux REFUSES respawn-pane on a live pane without it.
 *
 * The destructive control (close vs remove) is unchanged and still comes
 * from SessionRowActions.
 *
 * Must load AFTER session-status-ui.js, session-row-actions.js and
 * session-listing-state.js, and BEFORE session-sidebar.js runs.
 */

console.log('[SessionSidebarRows Module] Loading...');

(function () {
    /**
     * Description: HTML-escape a value for safe interpolation.
     * Inputs: value (any). Output: string.
     */
    function esc(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    /**
     * Description: whether this row's session can be renamed, as THREE
     *   states rather than a boolean, plus the sentence that says why.
     *
     *   This mirrors LaunchpadController._renderRenamePencilHtml exactly,
     *   on the same two fields, because a session must not be renameable
     *   on one surface and not on the other. The two fields answer
     *   DIFFERENT questions and neither one alone is the answer:
     *   `session_id` is only populated by the /sessions/list merge, so it
     *   really means "is there a live backend for this right now", while
     *   `created_by_cloude` is about ORIGIN and is genuinely NULLABLE -
     *   the server fills it from an ownership map that can simply have no
     *   entry for a name.
     *
     *     'renameable'  a session id is known. The rename endpoint is
     *                   keyed on it, so the edit can actually be sent.
     *     'unavailable' no session id, but ownership IS known, so the
     *                   precondition can be stated precisely: open it
     *                   (ours) or adopt it (external).
     *     'unknown'     no session id AND ownership is null. CANNOT
     *                   DETERMINE. `== null` catches null and undefined
     *                   and nothing else, deliberately - `!r.x` would
     *                   fold the genuine unknown into "external" and
     *                   invent an answer nobody measured.
     *
     *   The state is stamped on the row as `data-rename-state`, which is
     *   what client/js/session-sidebar-rename.js gates the inline editor
     *   on. A row that cannot be renamed must not silently accept an edit
     *   that is going to fail.
     * Inputs: r (object) - one merged session row.
     * Output: object - {state (string), reason (string)}.
     * Example: renameState({session_id: null, created_by_cloude: null})
     *   // {state: 'unknown', reason: 'CANNOT DETERMINE ...'}
     */
    function renameState(r) {
        if (r && r.session_id) {
            return { state: 'renameable', reason: 'double-click to rename (or F2)' };
        }
        if (!r || r.created_by_cloude == null) {
            return {
                state: 'unknown',
                reason: 'cannot rename: CANNOT DETERMINE whether this session is yours,'
                    + ' so whether it can be renamed is unknown',
            };
        }
        return {
            state: 'unavailable',
            reason: r.created_by_cloude
                ? 'cannot rename until this session is open - click the row to open it'
                : 'cannot rename until this session is adopted - click the row to adopt it',
        };
    }

    /**
     * Description: the drag grip. Its own control rather than the whole
     *   row, because the row's click already means "switch to this
     *   conversation" - see client/js/session-sidebar-reorder.js.
     * Inputs: name (string). Output: string - HTML.
     */
    function gripHtml(name) {
        return (
            `<span class="session-sidebar-row-grip" data-grip-session="${esc(name)}" ` +
            'aria-hidden="true" title="drag to reorder (or Alt+Up / Alt+Down)">' +
            '<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">' +
            '<circle cx="2.5" cy="3" r="1.2" fill="currentColor"/>' +
            '<circle cx="7.5" cy="3" r="1.2" fill="currentColor"/>' +
            '<circle cx="2.5" cy="7" r="1.2" fill="currentColor"/>' +
            '<circle cx="7.5" cy="7" r="1.2" fill="currentColor"/>' +
            '<circle cx="2.5" cy="11" r="1.2" fill="currentColor"/>' +
            '<circle cx="7.5" cy="11" r="1.2" fill="currentColor"/>' +
            '</svg></span>'
        );
    }

    /**
     * Description: the per-row pin toggle. `aria-pressed` carries the real
     *   state; the glyph is presentational, so the state is never
     *   shape-only.
     * Inputs: name (string), pinned (boolean). Output: string - HTML.
     */
    function pinButtonHtml(name, pinned) {
        const label = pinned ? `Unpin ${name}` : `Pin ${name} to the top`;
        return (
            `<button type="button" class="session-sidebar-row-pin" data-pin-session="${esc(name)}" ` +
            `aria-pressed="${pinned ? 'true' : 'false'}" tabindex="-1" ` +
            `aria-label="${esc(label)}" title="${pinned ? 'unpin' : 'pin to top'}">` +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-2-4V4H7v9l-2 4z"/>' +
            '</svg></button>'
        );
    }

    /**
     * Description: stable fingerprint of everything the rendered rows
     *   actually show, so the 5s poll tick can skip a DOM rewrite that
     *   would thrash focus and scroll position. Density, pin state and
     *   position are all things the row SHOWS, so all three are in here -
     *   leaving any of them out means a change the user just made does
     *   not paint until something unrelated happens to move.
     * Inputs: rows (Array<object>), density (string), listing (object|null),
     *   missing (Array<string>), groups (object|null) - {collapsed
     *   (Array<string>), dragging (boolean)}, both of which change what
     *   is on screen and therefore both of which must be in here.
     * Output: string.
     */
    function signature(rows, density, listing, missing, groups) {
        return JSON.stringify({
            density: density || 'cozy',
            // A FOLDED SECTION DRAWS NO ROWS AT ALL, so folding one is
            // the largest change this list can make to itself. It has to
            // be in the signature or the fold does not paint until a poll
            // tick happens to differ for some other reason. Same for the
            // drag flag, which is what makes an empty pinned group appear
            // as a drop target.
            collapsed: (groups && Array.isArray(groups.collapsed))
                ? groups.collapsed.slice()
                : [],
            dragging: !!(groups && groups.dragging),
            listing: listing && !listing.ok
                ? ['unavailable', listing.reason || '', listing.detail || '']
                : ['ok'],
            missing: (missing || []).slice(),
            // NO EXPLICIT INDEX HERE, AND THAT IS DELIBERATE. An earlier
            // version carried the array index as a field to make the
            // signature position-sensitive. It is provably redundant:
            // this maps in order and JSON.stringify preserves array
            // order, so two different orderings of the same rows already
            // serialise differently. The index is fully determined by the
            // position it was meant to witness, so it could never change
            // a comparison - and a mutation that deleted it was
            // unkillable by construction. What position-sensitivity
            // actually requires is that this never sorts or normalises
            // the row order before serialising it.
            rows: (rows || []).map((r) => ({
                name: r.name,
                // THE ROW'S TEXT IS THE LABEL, so it must be here or a
                // rename repaints nothing. `name` cannot stand in: a
                // rename moves ONLY the label and leaves the handle put,
                // so the field the diff watched is the one a rename no
                // longer touches. The editor forces a repaint by clearing
                // `_lastSig` - but the 5s poller and another tab's
                // `session.renamed` come through this diff.
                label: r.label || null,
                status: r.status || 'unknown',
                // The tooltip is part of the paint: without this, a row
                // whose status stopped being hook-fed keeps claiming
                // "via hooks" until some other field happens to differ.
                statusSource: r.status_source || 'none',
                active: !!r.is_active,
                thisTab: !!r.is_this_tab,
                unread: !!r.unread,
                pinned: !!r.is_pinned,
                // The row DRAWS its rename state, in the title on the
                // name and in a data attribute the editor gates on, so a
                // session gaining or losing a live backend has to repaint
                // the row. Leaving it out meant a session that had just
                // opened kept telling the user it could not be renamed
                // until something unrelated happened to change.
                rename: renameState(r).state,
                // The BADGE is drawn at cozy and detailed, so a change of
                // ownership has to repaint. It used to be implied by
                // fields the family pill carried; those are gone.
                badge: !!r.created_by_cloude,
                // The age is only DRAWN at detailed density, and what is
                // drawn is the coarse label ("3h"), not the epoch. Keying
                // on the epoch would repaint every poll tick for a field
                // nobody is looking at; keying on the label at every
                // density would do the same at cozy, where there is no
                // age on screen at all. The signature must track what the
                // row SHOWS, which is why this is conditional.
                age: (density === 'detailed') ? ageLabel(r.created_at_epoch) : null,
                theme: r.pinned_theme || null,
                // punchlist 19 - the "needs a keypress" badge appears and
                // disappears on its own, without any other field on the
                // row changing: a session parked on its trust prompt has
                // the same name, label, status and ownership before and
                // after somebody answers it. Leaving this out would mean
                // the badge painted on whichever poll tick happened to
                // differ for an unrelated reason, and then stayed on
                // screen after the prompt was answered. Normalized, so an
                // absent field and an explicit 'unknown' are one value.
                startup: window.SessionStartupGate
                    ? window.SessionStartupGate.normalize(r.startup_gate)
                    : 'unknown',
                // Same trap as `startup`: a dropped socket moves nothing
                // else the server reports, so the row would never repaint.
                transport: window.SessionTransport
                    ? window.SessionTransport.stateFor(r.name) : 'unknown',
            })),
        });
    }

    /**
     * Description: a short relative age, e.g. "3h". Empty string when the
     *   row carries no creation epoch - an unknown age renders as nothing
     *   rather than as "0s", which would be a number nobody measured.
     * Inputs: epoch (number|null|undefined) - seconds since the epoch.
     * Output: string.
     */
    function ageLabel(epoch) {
        if (!epoch || typeof epoch !== 'number') return '';
        const secs = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs / 60)}m`;
        if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
        return `${Math.floor(secs / 86400)}d`;
    }

    /**
     * Description: the notice shown when a stored arrangement existed and
     *   could not be read. The list falls back to its default order, and
     *   this says so - presenting the default silently would tell the user
     *   it is the arrangement he chose.
     * Inputs: arrangement (object|null) - {status, reason}.
     * Output: string - HTML, or ''.
     */
    function arrangementNoticeHtml(arrangement) {
        if (!arrangement || arrangement.status !== 'unreadable') return '';
        const reason = esc(arrangement.reason || 'reason unknown');
        return (
            '<div class="session-sidebar-notice" role="status" data-arrangement-state="unreadable">' +
            '<div class="session-sidebar-notice__title">CANNOT LOAD your saved order</div>' +
            `<div class="session-sidebar-notice__detail">${reason}. showing the default order ` +
            'until you pin or move something.</div>' +
            '</div>'
        );
    }

    /**
     * Description: build the full list markup for the sidebar body.
     *
     *   AN EMPTY LIST AND AN UNREADABLE ONE MUST NOT LOOK THE SAME. With a
     *   listing that answered, zero rows means the user has no other
     *   conversations and the list says so. With a listing that did NOT
     *   answer, zero rows means nothing at all, and rendering the
     *   confident empty state would be a claim the app cannot support -
     *   and would contradict the CANNOT DETERMINE block the home screen is
     *   rendering from the same failed probe at the same moment.
     * Inputs: rows (Array<object>), density (string), listing (object|null)
     *   - {ok, reason, detail}, missing (Array<string>),
     *   arrangement (object|null) - {status, reason, collapsed},
     *   opts (object|null) - {dragging (boolean)}, passed straight
     *   through to client/js/session-sidebar-groups.js, which is the only
     *   thing that reads it.
     * Output: string - HTML.
     */
    function listHtml(rows, density, listing, missing, arrangement, opts) {
        const attention = window.SessionListingState
            ? window.SessionListingState.attentionHtml(listing)
            : '';
        const notice = arrangementNoticeHtml(arrangement);
        // EVERYTHING BELOW THE ROWS lives in one module. The key and the
        // version ride EVERY branch, including the two that draw no rows;
        // the remembered-slots note rides the row branch alone, because
        // it is about rows that are missing FROM IT.
        const foot = window.SessionSidebarFooter;
        const footer = foot ? foot.html() : '';
        if (!rows || rows.length === 0) {
            if (listing && !listing.ok) return notice + attention + footer;
            const empty = '<div class="session-sidebar-empty">no other conversations</div>';
            return notice + empty + footer;
        }
        const body = window.SessionSidebarGroups
            ? window.SessionSidebarGroups.bodyHtml(rows, density, arrangement, opts)
            : rows.map((r) => rowHtml(r, density)).join('');
        return notice + attention + body
            + (foot ? foot.missingNoteHtml(missing) : '') + footer;
    }


    /**
     * Description: build one row at the given density. The dot, the theme
     *   swatch and the kebab all come from shared modules, so this row
     *   and the launcher's running-session row are the same controls
     *   with the same tooltips and confirm copy.
     *
     *   `is_pinned`, `unread` and `status` are stamped on the KEBAB even
     *   though nothing on the row draws them any more - the menu is built
     *   from those attributes, so they are still things the row carries
     *   and are still keyed in ``signature`` above.
     * Inputs: r (object) - one merged session row.
     *   density (string) - 'compact' | 'cozy' | 'detailed'.
     * Output: string - HTML.
     */
    function rowHtml(r, density) {
        const mode = density || 'cozy';
        // THE SIGNALS ARGUMENT IS NOT OPTIONAL HERE. `unread` and the
        // startup gate drive the LED's OUTER ring, and a bare status
        // string cannot express either: `idle` + unread renders a steady
        // halo, which is exactly how a session the user had just marked
        // unread painted as read while the field on the row said true.
        const dot = window.SessionStatusUI
            ? window.SessionStatusUI.dotHtml(r.status, {
                unread: !!r.unread,
                startup_gate: r.startup_gate,
                status_source: r.status_source,
                // A fact about THIS BROWSER that no server response can
                // report. See client/js/session-transport.js.
                transport: window.SessionTransport
                    ? window.SessionTransport.stateFor(r.name) : 'unknown' })
            : '';
        // punchlist 19 - "needs a keypress". Empty string for both 'ready'
        // and 'unknown', so this adds nothing to a normal row. It rides
        // at EVERY density including compact, unlike the tmux/external
        // badge: that badge is redundant with the row's own styling,
        // while this one is the only thing on screen saying the session
        // has not started. A density setting must not be able to hide it.
        const startupGate = window.SessionStartupGate
            ? window.SessionStartupGate.indicatorHtml(r.startup_gate)
            : '';
        // TWO STRINGS, NOT INTERCHANGEABLE. `name` is the tmux handle,
        // for the ATTRIBUTES - grip, pin, group filing, delete and
        // reorder all key on it, so it must never be a label. `display` is what
        // a HUMAN reads, from the one resolver in session-label.js. This
        // row rendered the handle over a `label` its payload has carried
        // since the feature landed, so "Media Compression" showed as
        // "cloude_Media". Outcome 3 (null) falls back to the handle: a
        // blank where a name goes is worse than either.
        const name = esc(r.name);
        const resolved = window.SessionLabel
            ? window.SessionLabel.resolve(r)
            : null;
        const display = resolved === null ? name : esc(resolved);
        const badge = r.created_by_cloude ? 'tmux' : 'external';
        const sidAttr = r.session_id ? ` data-session-id="${esc(r.session_id)}"` : '';
        const themeAttrs = window.SessionThemeTint
            ? window.SessionThemeTint.attrs(r.pinned_theme)
            : '';
        // The session-theme cue, and the only thing that carries it. It
        // used to be an accent ring on the row's own box, which is the
        // box `[data-active="1"]` uses for selection - so a session
        // pinned to the host theme read as the selected row. See
        // client/js/session-theme-tint.js. Empty for all three
        // not-themed cases.
        const themeSwatch = window.SessionThemeTint
            ? window.SessionThemeTint.swatchHtml(r.pinned_theme)
            : '';
        // Pin stays inline: it is a state the eye reads at a glance.
        const pin = pinButtonHtml(r.name, !!r.is_pinned);
        const rename = renameState(r);
        // MENU OR INLINE, NEVER BOTH, and `offersMenu` is derived from
        // `actionsFor` rather than from a second status list, so the row
        // and the menu cannot disagree. A dead row keeps inline restart
        // and remove (decision 4 sends it to Recent, so this is only the
        // honest rendering of one the reaper has not taken yet).
        const offersMenu = !!(window.SessionRowActions
            && window.SessionRowActions.offersMenu(r.status));
        const rowAction = (window.SessionRowActions && !offersMenu)
            ? window.SessionRowActions.html(
                r.status, r.name, 'session-sidebar-row-delete')
            : '';
        // Identity is captured HERE, at paint time: the list repaints
        // every five seconds and an item that resolved its row later
        // could act on whatever had taken its place.
        const rowMenu = (offersMenu && window.SessionRowMenu)
            ? window.SessionRowMenu.triggerHtml(
                window.SessionRowMenu.contextFromRow(r, {
                    surface: 'sidebar',
                    renameable: rename.state === 'renameable',
                    renameReason: rename.state === 'renameable' ? '' : rename.reason,
                }))
            : '';
        // The badge is the first thing to go when the user asks for thin
        // rows: "tmux" vs "external" is already carried by the row's
        // ownership styling, so at compact it is the most redundant glyph
        // on the row. At DETAILED it moves to the second line rather than
        // being dropped, which is what keeps that line about something -
        // the family pill used to sit there and no longer exists.
        const badgeHtml = `<span class="session-sidebar-row-badge">${badge}</span>`;
        const age = ageLabel(r.created_at_epoch);
        const secondLine = mode === 'detailed'
            ? ('<div class="session-sidebar-row-meta">'
                + badgeHtml
                + (age ? `<span class="session-sidebar-row-age">${esc(age)}</span>` : '')
                + '</div>')
            : '';
        const inlineBadge = (mode === 'cozy') ? badgeHtml : '';
        return (
            `<div class="session-sidebar-row" data-name="${name}" ` +
            `data-active="${r.is_this_tab ? '1' : '0'}" ` +
            `data-pinned="${r.is_pinned ? '1' : '0'}" ` +
            `data-rename-state="${rename.state}" ` + (window.SessionSidebarFetch ? window.SessionSidebarFetch.workAttr(r) : '') +
            `role="option" aria-selected="${r.is_this_tab ? 'true' : 'false'}" ` +
            `tabindex="-1"${sidAttr}${themeAttrs}>` +
            '<div class="session-sidebar-row-main">' +
            gripHtml(r.name) +
            dot +
            // `data-row-name` stays the HANDLE: nothing reads its value
            // (it is the rename module's `closest()` target), and an
            // identity-shaped attribute should not carry a label. The
            // TEXT is the display value; they differ on purpose.
            `<span class="session-sidebar-row-name" data-row-name="${name}" ` +
            `title="${esc(rename.reason)}">${display}</span>` +
            // After the name, not before it: the name column starts at
            // the same x on every row whether or not it is themed, so a
            // themed row does not make the list ragged. It is also the
            // full width of the name away from the status dot, which is
            // the other coloured mark on the row.
            themeSwatch +
            startupGate +
            inlineBadge +
            pin +
            rowAction +
            rowMenu +
            '</div>' +
            secondLine +
            '</div>'
        );
    }

    window.SessionSidebarRows = {
        listHtml, rowHtml, signature, esc, gripHtml, renameState,
        pinButtonHtml, ageLabel, arrangementNoticeHtml,
    };
    console.log('[SessionSidebarRows Module] Exported as window.SessionSidebarRows');
})();
