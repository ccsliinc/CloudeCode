/**
 * Session sidebar ROW MARKUP - the HTML for one conversation row, and
 * the repaint signature that decides whether a repaint is needed at all.
 *
 * Split out of client/js/session-sidebar.js for the project's 500-line
 * rule, and along the same seam the repo already uses for row internals:
 * client/js/session-row-actions.js owns the destructive control and
 * client/js/session-status-ui.js owns the status dot and the mark-unread
 * toggle. This module is the row that composes them, nothing else - it
 * holds no state and touches no DOM, it only returns strings.
 *
 * WHAT EACH DENSITY DRAWS (see client/js/session-sidebar-density.js for
 * the modes and where the preference lives):
 *   compact   grip, dot, name, family pill, pin, mark-unread, delete
 *   cozy      the above plus the tmux/external badge  (DEFAULT)
 *   detailed  the above plus a second line: family pill and age
 * The FAMILY PILL is built by ONE function and emitted in ALL THREE, with
 * identical classes and identical text. Its three states must stay
 * distinguishable everywhere: `family-pill--fact` solid, `--guess` dashed
 * with a leading `~`, `--unknown` dotted italic reading "unknown family".
 * A density mode that dropped the unknown state would be hiding the one
 * the user most needs, and every session in the shipped database is
 * currently in exactly that state.
 *
 * NO RESTART CONTROL IS EMITTED HERE, AT ANY DENSITY. Sidebar rows come
 * from the attachable probe, which carries an activity status and no
 * `lifecycle` at all, so this module cannot know that a session is
 * stopped rather than unknown - and restarting something whose state you
 * could not determine is how you end up with two of it. The destructive
 * control (close vs remove) still comes from SessionRowActions, which
 * already refuses to treat `unknown` as stopped.
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
     * Description: the agent-family pill, with the three states kept
     *   visually distinct. A GUESS AND A FACT MUST NOT LOOK IDENTICAL:
     *   `fingerprint` and `derived_deepest` mean the family was inferred,
     *   and render dashed with a leading `~`; `wrapper` and
     *   `reserved_name` were read off a stored choice and render solid.
     *   Anything else is not a family we know, and renders dotted italic
     *   saying so in words rather than rendering nothing.
     *   Mirrors LaunchpadController._renderFamilyPillHtml so the same
     *   session reads the same on both surfaces.
     * Inputs: family (string|null|undefined) - resolved family name.
     *   source (string|null|undefined) - 'wrapper' | 'reserved_name' |
     *   'fingerprint' | 'derived_deepest' | 'unknown'.
     * Output: string - one `<span class="family-pill ...">`.
     * Example: familyPillHtml('codex', 'wrapper')
     *   -> '<span class="family-pill family-pill--fact" ...>codex</span>'
     */
    function familyPillHtml(family, source) {
        const src = source || 'unknown';
        const isGuess = src === 'fingerprint' || src === 'derived_deepest';
        const known = !!family && src !== 'unknown';
        const label = known ? (isGuess ? `~${family}` : family) : 'unknown family';
        const kindClass = !known
            ? 'family-pill--unknown'
            : (isGuess ? 'family-pill--guess' : 'family-pill--fact');
        const title = known
            ? (isGuess
                ? `guessed from session output (${src})`
                : `agent family: ${family}`)
            : 'could not determine which agent this session is running';
        return `<span class="family-pill ${kindClass}" data-family-source="${esc(src)}" title="${esc(title)}">${esc(label)}</span>`;
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
     *   missing (Array<string>).
     * Output: string.
     */
    function signature(rows, density, listing, missing) {
        return JSON.stringify({
            density: density || 'cozy',
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
                status: r.status || 'unknown',
                active: !!r.is_active,
                thisTab: !!r.is_this_tab,
                unread: !!r.unread,
                pinned: !!r.is_pinned,
                fam: r.agent_family || null,
                famSrc: r.agent_family_source || null,
                // The age is only DRAWN at detailed density, and what is
                // drawn is the coarse label ("3h"), not the epoch. Keying
                // on the epoch would repaint every poll tick for a field
                // nobody is looking at; keying on the label at every
                // density would do the same at cozy, where there is no
                // age on screen at all. The signature must track what the
                // row SHOWS, which is why this is conditional.
                age: (density === 'detailed') ? ageLabel(r.created_at_epoch) : null,
                theme: r.pinned_theme || null,
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
     * Description: the note naming remembered positions whose sessions are
     *   not currently running. It is deliberately not an error and not a
     *   silent drop: the slots are kept, and the count says so out loud.
     * Inputs: missing (Array<string>). Output: string - HTML, or ''.
     */
    function missingNoteHtml(missing) {
        if (!missing || !missing.length) return '';
        const n = missing.length;
        const names = esc(missing.join(', '));
        return (
            `<div class="session-sidebar-note" data-order-missing="${n}" title="${names}">` +
            `${n} remembered ${n === 1 ? 'position is' : 'positions are'} held for ` +
            `${n === 1 ? 'a session' : 'sessions'} not currently listed` +
            '</div>'
        );
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
     *   arrangement (object|null) - {status, reason}.
     * Output: string - HTML.
     */
    function listHtml(rows, density, listing, missing, arrangement) {
        const attention = window.SessionListingState
            ? window.SessionListingState.attentionHtml(listing)
            : '';
        const notice = arrangementNoticeHtml(arrangement);
        if (!rows || rows.length === 0) {
            if (listing && !listing.ok) return notice + attention;
            return notice + '<div class="session-sidebar-empty">no other conversations</div>';
        }
        const body = rows.map((r) => rowHtml(r, density)).join('');
        return notice + attention + body + missingNoteHtml(missing);
    }

    /**
     * Description: build one row at the given density. The dot, the
     *   mark-unread toggle and the destructive control all come from the
     *   shared modules, so this row and the launcher's running-session row
     *   are literally the same controls with the same tooltips and the
     *   same confirm copy.
     * Inputs: r (object) - one merged session row.
     *   density (string) - 'compact' | 'cozy' | 'detailed'.
     * Output: string - HTML.
     */
    function rowHtml(r, density) {
        const mode = density || 'cozy';
        const dot = window.SessionStatusUI ? window.SessionStatusUI.dotHtml(r.status) : '';
        const name = esc(r.name);
        const badge = r.created_by_cloude ? 'tmux' : 'external';
        const sidAttr = r.session_id ? ` data-session-id="${esc(r.session_id)}"` : '';
        const themeAttrs = window.SessionThemeTint
            ? window.SessionThemeTint.attrs(r.pinned_theme)
            : '';
        const markUnread = window.SessionStatusUI
            ? window.SessionStatusUI.markUnreadHtml(r.name, !!r.unread)
            : '';
        const rowAction = window.SessionRowActions
            ? window.SessionRowActions.html(r.status, r.name, 'session-sidebar-row-delete')
            : '';
        const pill = familyPillHtml(r.agent_family, r.agent_family_source);
        // The badge is the first thing to go when the user asks for thin
        // rows: "tmux" vs "external" is already carried by the row's
        // ownership styling, so at compact it is the most redundant glyph
        // on the row. The family pill is not redundant with anything.
        const badgeHtml = mode === 'compact'
            ? ''
            : `<span class="session-sidebar-row-badge">${badge}</span>`;
        const age = ageLabel(r.created_at_epoch);
        const secondLine = mode === 'detailed'
            ? ('<div class="session-sidebar-row-meta">'
                + pill
                + (age ? `<span class="session-sidebar-row-age">${esc(age)}</span>` : '')
                + '</div>')
            : '';
        // At detailed the pill lives on the second line; at the other two
        // it rides the first. Emitted exactly once either way.
        const inlinePill = mode === 'detailed' ? '' : pill;
        return (
            `<div class="session-sidebar-row" data-name="${name}" ` +
            `data-active="${r.is_this_tab ? '1' : '0'}" ` +
            `data-pinned="${r.is_pinned ? '1' : '0'}" ` +
            `role="option" aria-selected="${r.is_this_tab ? 'true' : 'false'}" ` +
            `tabindex="-1"${sidAttr}${themeAttrs}>` +
            '<div class="session-sidebar-row-main">' +
            gripHtml(r.name) +
            dot +
            `<span class="session-sidebar-row-name">${name}</span>` +
            inlinePill +
            badgeHtml +
            pinButtonHtml(r.name, !!r.is_pinned) +
            markUnread +
            rowAction +
            '</div>' +
            secondLine +
            '</div>'
        );
    }

    window.SessionSidebarRows = {
        listHtml, rowHtml, signature, esc, familyPillHtml, gripHtml,
        pinButtonHtml, ageLabel, missingNoteHtml, arrangementNoticeHtml,
    };
    console.log('[SessionSidebarRows Module] Exported as window.SessionSidebarRows');
})();
