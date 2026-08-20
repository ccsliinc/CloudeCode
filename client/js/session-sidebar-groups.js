/**
 * Session sidebar GROUPS - the section headers that split the list into a
 * pinned band and everything else.
 *
 * The request was "pinned items should be a new group on top and for now
 * the other group is still sorted in time order", pointing at the Claude
 * Code sidebar as the model: section headers as their own ROWS, muted,
 * each with a collapse chevron, reading as structure rather than content.
 *
 * THIS IS PRESENTATION OVER A MODEL THAT ALREADY KNOWS ABOUT PINNING.
 * `client/js/session-sidebar-arrangement.js` has always partitioned the
 * list into a pinned band and a rest band and returned them concatenated
 * with `is_pinned` stamped on each row. Nothing here re-decides that, and
 * nothing here stores a second copy of it. This module draws the seam the
 * model already had, and adds exactly one new piece of state - which
 * sections are folded - which rides the SAME storage envelope.
 *
 * TWO RULES ABOUT WHEN A HEADER EXISTS AT ALL, and they are different:
 *
 *   1. AN EMPTY PINNED GROUP RENDERS NOTHING. Not a header with no rows
 *      under it: nothing. A bare header for a band the user has never put
 *      anything in is chrome that asks a question nobody asked.
 *   2. WITH NOTHING PINNED, THE REST RENDERS UNGROUPED TOO. Headers exist
 *      to SEPARATE. With one band there is nothing to separate it from,
 *      so a lone "other" header over the entire list would be a label
 *      pretending to be a division. The seam appears when there is a seam.
 *
 * THE ONE EXCEPTION IS A DRAG IN FLIGHT. While a row is being dragged the
 * pinned group is drawn even when empty, because it is the drop target
 * that pins - and a target that only exists once you have already hit it
 * cannot be hit. Steady state is still rule 1: the moment the drag ends,
 * an empty pinned group disappears again.
 *
 * A COLLAPSED GROUP DOES NOT RENDER ITS ROWS - it does not render them
 * hidden. `client/js/session-sidebar-reorder.js` reads the visible order
 * straight off the DOM with `querySelectorAll('.session-sidebar-row')`,
 * which finds a `hidden` element just as happily as a visible one, so
 * folding a section that still held its rows would leave every reorder
 * and every drag computing positions against rows nobody can see. The
 * remembered order survives regardless: `mergeOrder()` keeps names it is
 * not shown in the slots they already hold.
 *
 * Must load AFTER session-sidebar-rows.js and BEFORE session-sidebar.js.
 */

console.log('[SessionSidebarGroups Module] Loading...');

(function () {
    /**
     * The section keys, top to bottom. `pinned` is first because that is
     * the whole request; `other` is everything the user has not pinned.
     * @type {Array<string>}
     */
    const KEYS = ['pinned', 'other'];

    /**
     * Human label per section key. Lowercase, matching the app's UI voice
     * and the panel's own "conversations" title.
     * @type {Object<string, string>}
     */
    const LABELS = { pinned: 'pinned', other: 'other' };

    /**
     * Description: the chevron that shows and toggles a section's fold.
     *   Presentational only - `aria-expanded` on the button carries the
     *   real state, so the fold is never shape-only. The rotation lives in
     *   CSS keyed off that same attribute, so the glyph cannot disagree
     *   with the state it is drawn from.
     * Inputs: none.
     * Output: string - HTML for one `<svg>`.
     */
    function chevronHtml() {
        return (
            '<span class="session-sidebar-group__chevron" aria-hidden="true">'
            + '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" '
            + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
            + 'stroke-linejoin="round"><path d="M4 2l4 4-4 4"/></svg></span>'
        );
    }

    /**
     * Description: one section header, drawn as a row of the list rather
     *   than as a caption floating above it. It is a real `<button>` so
     *   the fold is operable by keyboard and reachable by tab, and it
     *   carries `aria-expanded` plus `aria-controls` pointing at the body
     *   it opens.
     * Inputs: key (string) - one of KEYS. count (number) - rows in the
     *   section, shown so a folded section still says how much it hides.
     *   collapsed (boolean).
     * Output: string - HTML.
     * Example: headerHtml('pinned', 2, false)
     */
    function headerHtml(key, count, collapsed) {
        const esc = window.SessionSidebarRows.esc;
        const label = LABELS[key] || key;
        const bodyId = `session-sidebar-group-body-${esc(key)}`;
        const verb = collapsed ? 'Expand' : 'Collapse';
        const title = `${verb} the ${label} group (${count} `
            + `${count === 1 ? 'conversation' : 'conversations'})`;
        return (
            `<button type="button" class="session-sidebar-group__header" `
            + `data-group-toggle="${esc(key)}" `
            + `aria-expanded="${collapsed ? 'false' : 'true'}" `
            + `aria-controls="${bodyId}" `
            + `title="${esc(title)}" aria-label="${esc(title)}">`
            + chevronHtml()
            + `<span class="session-sidebar-group__label">${esc(label)}</span>`
            + `<span class="session-sidebar-group__count">${count}</span>`
            + '</button>'
        );
    }

    /**
     * Description: one whole section - header plus, when it is open, its
     *   rows. A folded section emits an EMPTY body element rather than no
     *   body at all, so `aria-controls` always resolves to something real
     *   and the drop target for a drag survives the fold.
     * Inputs: key (string), rows (Array<object>), density (string),
     *   collapsed (boolean).
     * Output: string - HTML.
     */
    function sectionHtml(key, rows, density, collapsed) {
        const esc = window.SessionSidebarRows.esc;
        const bodyId = `session-sidebar-group-body-${esc(key)}`;
        const body = collapsed
            ? ''
            : rows.map((r) => window.SessionSidebarRows.rowHtml(r, density)).join('');
        return (
            `<div class="session-sidebar-group" role="group" data-group="${esc(key)}" `
            + `data-collapsed="${collapsed ? '1' : '0'}" data-count="${rows.length}">`
            + headerHtml(key, rows.length, collapsed)
            + `<div class="session-sidebar-group__body" id="${bodyId}">${body}</div>`
            + '</div>'
        );
    }

    /**
     * Description: split arranged rows into the two bands. `is_pinned` is
     *   stamped by `SessionSidebarArrangement.arrange()`, which is the one
     *   place that decides it; this only reads it.
     * Inputs: rows (Array<object>) - already arranged, pinned band first.
     * Output: object - {pinned (Array<object>), other (Array<object>)}.
     */
    function split(rows) {
        const list = Array.isArray(rows) ? rows : [];
        return {
            pinned: list.filter((r) => !!r.is_pinned),
            other: list.filter((r) => !r.is_pinned),
        };
    }

    /**
     * Description: the grouped body of the list, or the ungrouped rows
     *   when there is no seam to draw. See the file docblock for the two
     *   rules and the one drag exception.
     * Inputs: rows (Array<object>) - arranged rows, pinned band first.
     *   density (string). arrangement (object|null) - the arrangement
     *   state, read for its `collapsed` list only. opts (object) -
     *   {dragging (boolean)}, which forces the empty pinned group to be
     *   drawn as a drop target.
     * Output: string - HTML.
     * Example: SessionSidebarGroups.bodyHtml(rows, 'cozy', state, {})
     */
    function bodyHtml(rows, density, arrangement, opts) {
        const bands = split(rows);
        const dragging = !!(opts && opts.dragging);
        const folded = (arrangement && Array.isArray(arrangement.collapsed))
            ? arrangement.collapsed
            : [];
        const isFolded = (key) => folded.indexOf(key) !== -1;
        if (bands.pinned.length === 0 && !dragging) {
            return bands.other.map((r) => window.SessionSidebarRows.rowHtml(r, density)).join('');
        }
        return (
            sectionHtml('pinned', bands.pinned, density, isFolded('pinned'))
            + sectionHtml('other', bands.other, density, isFolded('other'))
        );
    }

    window.SessionSidebarGroups = {
        bodyHtml, sectionHtml, headerHtml, chevronHtml, split, KEYS, LABELS,
    };
    console.log('[SessionSidebarGroups Module] Exported as window.SessionSidebarGroups');
})();
