/**
 * Session sidebar REORDER - the interaction that puts a session where the
 * user wants it, and the pin toggle that decides which band it lives in.
 *
 * TWO INTERACTIONS, AND WHY BOTH.
 *
 * Keyboard is the PRIMARY one, not the accessibility afterthought.
 *   ArrowUp / ArrowDown      move FOCUS between rows (roving tabindex, so
 *                            the list is one tab stop, per the WAI-ARIA
 *                            practice for a vertical collection)
 *   Alt+ArrowUp / Alt+Arrow  MOVE the focused row within its band
 *   Home / End               first / last row
 *   p                        toggle the focused row's pin
 *   Enter / Space            switch to the focused session
 * The Alt modifier is doing real work: bare arrows have to stay as
 * navigation or the list stops being browsable, and Alt+Up/Down is what
 * this audience already presses to move a line in VS Code, so the gesture
 * arrives already learned. Every one of these is a REAL key event in the
 * tests, dispatched at the row, not a method call standing in for one.
 *
 * Pointer drag is the SECONDARY one, on an explicit grip handle rather
 * than the whole row, because the row's own click already means "switch
 * to this conversation" and a drag that starts anywhere on it would make
 * every mis-swipe a navigation. Built on Pointer Events, so mouse, touch
 * and pen are one code path - HTML5 drag-and-drop would have been less
 * code and silently dead on a phone.
 *
 * A MOVE NEVER CHANGES A PIN. Both interactions refuse a move that would
 * cross the pinned/unpinned boundary (the refusal itself lives in
 * client/js/session-sidebar-arrangement.js, so the two interactions cannot
 * disagree about it). Dragging a row out of the pinned band would be an
 * unpin the user never asked for and could not see themselves perform.
 *
 * FOCUS SURVIVES THE REPAINT. Every move rewrites the list's innerHTML,
 * which destroys the focused element; without restoring focus onto the
 * moved row, holding Alt+ArrowUp moves a row exactly once and then goes
 * dead. The restore is the feature, not polish.
 *
 * Announcements go to the panel's live region so a screen reader hears
 * "moved to position 2 of 6" - a reorder whose only feedback is visual is
 * not operable without a mouse in any sense that matters.
 *
 * Must load AFTER session-sidebar.js and session-sidebar-arrangement.js.
 */

console.log('[SessionSidebarReorder Module] Loading...');

(function () {
    /** Pixels a pointer must travel on the grip before it counts as a drag. */
    const DRAG_SLOP_PX = 4;

    /** The row currently holding the list's single tab stop. */
    let focusName = null;

    /** In-flight pointer drag, or null. */
    let drag = null;

    let wired = false;

    /**
     * Description: the sidebar's list container, or null before wiring.
     * Inputs: none. Output: Element|null.
     */
    function listEl() {
        const sidebar = window.SessionSidebar;
        return (sidebar && sidebar.listEl) || null;
    }

    /**
     * Description: every rendered session row, top to bottom.
     * Inputs: none. Output: Array<Element>.
     */
    function rowEls() {
        const list = listEl();
        if (!list) return [];
        return Array.prototype.slice.call(list.querySelectorAll('.session-sidebar-row'));
    }

    /**
     * Description: the tmux names of the rendered rows, top to bottom.
     *   This is what the arrangement writes: the list as the user is
     *   looking at it, never a model of it.
     * Inputs: none. Output: Array<string>.
     */
    function visibleNames() {
        return rowEls().map((el) => el.dataset.name).filter((n) => !!n);
    }

    /**
     * Description: true when a pointer drag is in progress, so the poller
     *   can hold off repainting the list out from under the user's finger.
     * Inputs: none. Output: boolean.
     */
    function isDragging() { return !!drag && drag.active; }

    /**
     * Description: put the list's single tab stop on one row and give it
     *   focus. Called after every repaint so a move does not strand focus
     *   on a destroyed element.
     * Inputs: name (string|null) - row to focus, or null to just restore
     *   the tab stop without moving focus.
     *   takeFocus (boolean) - whether to actually call focus().
     * Output: void.
     */
    function setFocusRow(name, takeFocus) {
        const rows = rowEls();
        if (!rows.length) return;
        let target = rows.find((el) => el.dataset.name === name) || null;
        if (!target) target = rows[0];
        for (const el of rows) {
            el.setAttribute('tabindex', el === target ? '0' : '-1');
        }
        focusName = target.dataset.name || null;
        if (takeFocus) target.focus();
    }

    /**
     * Description: re-establish the roving tab stop after the sidebar
     *   repaints, restoring focus only when the list already had it - so
     *   a background poll tick can never steal focus from elsewhere.
     * Inputs: none. Output: void.
     */
    function afterRender() {
        const list = listEl();
        if (!list) return;
        const hadFocus = !!document.activeElement
            && list.contains(document.activeElement);
        setFocusRow(focusName, hadFocus);
    }

    /**
     * Description: say what just happened, in the panel's live region.
     * Inputs: text (string). Output: void.
     */
    function announce(text) {
        const region = document.getElementById('session-sidebar-live');
        if (region) region.textContent = text;
    }

    /**
     * Description: repaint the list from the sidebar's cached rows and put
     *   focus back on `name`. One helper because every mutation below has
     *   to do exactly this and forgetting the focus half is the bug that
     *   makes held-key repeat stop after one press.
     * Inputs: name (string) - the row to keep focused. Output: void.
     */
    function repaintKeepingFocus(name) {
        focusName = name;
        const sidebar = window.SessionSidebar;
        if (sidebar) sidebar.repaint();
        setFocusRow(name, true);
    }

    /**
     * Description: move the named row one slot up or down within its band,
     *   persist it, repaint, and announce the new position. A refused move
     *   (band edge) announces that it was refused rather than silently
     *   doing nothing, so the user is not left pressing a dead key.
     * Inputs: name (string), delta (number) - -1 up, +1 down.
     * Output: boolean - true when the row actually moved.
     */
    function moveRow(name, delta) {
        const arrangement = window.SessionSidebarArrangement;
        if (!arrangement) return false;
        const next = arrangement.move(name, delta, visibleNames());
        if (!next) {
            announce(`${name} is already at the ${delta < 0 ? 'top' : 'bottom'} of its group`);
            return false;
        }
        repaintKeepingFocus(name);
        const rows = visibleNames();
        announce(`${name} moved to position ${rows.indexOf(name) + 1} of ${rows.length}`);
        return true;
    }

    /**
     * Description: flip the named row's pin, persist, repaint, announce.
     * Inputs: name (string). Output: boolean - the new pinned state.
     */
    function togglePinRow(name) {
        const arrangement = window.SessionSidebarArrangement;
        if (!arrangement) return false;
        const now = arrangement.togglePin(name, visibleNames());
        repaintKeepingFocus(name);
        announce(now ? `${name} pinned to the top` : `${name} unpinned`);
        return now;
    }

    /**
     * Description: keyboard handling for the row list. Returns early for
     *   anything that is not a row key so the sidebar's own Enter/Space
     *   handling for nested controls is untouched.
     * Inputs: e (KeyboardEvent). Output: void.
     */
    function onKeydown(e) {
        const row = e.target.closest && e.target.closest('.session-sidebar-row');
        if (!row || !row.dataset.name) return;
        // A nested control (pin button, grip, mark-unread, delete) owns its
        // own keys; the row-level handler must not also fire for them.
        if (e.target !== row) return;
        const name = row.dataset.name;
        const rows = rowEls();
        const idx = rows.indexOf(row);

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            if (e.altKey) { moveRow(name, step); return; }
            const next = rows[idx + step];
            if (next) setFocusRow(next.dataset.name, true);
            return;
        }
        if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            const target = e.key === 'Home' ? rows[0] : rows[rows.length - 1];
            if (target) setFocusRow(target.dataset.name, true);
            return;
        }
        if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            togglePinRow(name);
            return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const sidebar = window.SessionSidebar;
            if (sidebar) sidebar.activateRow(row);
        }
    }

    /**
     * Description: click handling for the per-row pin button. The pin is a
     *   real control inside a row whose own click switches conversations,
     *   so it stops propagation - clicking pin must never also navigate.
     * Inputs: e (MouseEvent). Output: boolean - true when handled.
     */
    function onPinClick(e) {
        const btn = e.target.closest && e.target.closest('[data-pin-session]');
        if (!btn) return false;
        e.stopPropagation();
        e.preventDefault();
        togglePinRow(btn.getAttribute('data-pin-session'));
        return true;
    }

    /**
     * Description: begin a potential grip drag. Nothing moves until the
     *   pointer has travelled DRAG_SLOP_PX, so a tap on the grip is not a
     *   zero-distance reorder.
     * Inputs: e (PointerEvent). Output: void.
     */
    function onPointerDown(e) {
        const grip = e.target.closest && e.target.closest('[data-grip-session]');
        if (!grip) return;
        const row = grip.closest('.session-sidebar-row');
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        drag = {
            name: grip.getAttribute('data-grip-session'),
            startY: e.clientY,
            active: false,
            pointerId: e.pointerId,
        };
        if (grip.setPointerCapture) {
            try { grip.setPointerCapture(e.pointerId); } catch (_) { /* not captured */ }
        }
    }

    /**
     * Description: during a grip drag, find which row the pointer is over
     *   and, when that is a different row, commit the move immediately so
     *   the list reorders live under the finger.
     * Inputs: e (PointerEvent). Output: void.
     */
    function onPointerMove(e) {
        if (!drag) return;
        if (!drag.active) {
            if (Math.abs(e.clientY - drag.startY) < DRAG_SLOP_PX) return;
            drag.active = true;
            const list = listEl();
            if (list) list.classList.add('session-sidebar-list--dragging');
        }
        const arrangement = window.SessionSidebarArrangement;
        if (!arrangement) return;
        const rows = rowEls();
        let beforeName = null;
        for (const el of rows) {
            if (el.dataset.name === drag.name) continue;
            const box = el.getBoundingClientRect();
            if (e.clientY < box.top + box.height / 2) {
                beforeName = el.dataset.name;
                break;
            }
        }
        const next = arrangement.moveBefore(drag.name, beforeName, visibleNames());
        if (!next) return;
        repaintKeepingFocus(drag.name);
    }

    /**
     * Description: end a grip drag, announcing the final position when the
     *   drag actually moved something.
     * Inputs: e (PointerEvent). Output: void.
     */
    function onPointerUp(e) {
        if (!drag) return;
        const wasActive = drag.active;
        const name = drag.name;
        drag = null;
        const list = listEl();
        if (list) list.classList.remove('session-sidebar-list--dragging');
        if (!wasActive) return;
        const rows = visibleNames();
        announce(`${name} moved to position ${rows.indexOf(name) + 1} of ${rows.length}`);
    }

    /**
     * Description: wire the list's keyboard and pointer handlers once.
     *   Bound to the stable list container rather than the rows, which are
     *   destroyed and rebuilt on every repaint.
     * Inputs: none. Output: void.
     */
    function init() {
        if (wired) return;
        const list = listEl();
        if (!list) return;
        list.addEventListener('keydown', onKeydown);
        list.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
        wired = true;
    }

    window.SessionSidebarReorder = {
        init, afterRender, moveRow, togglePinRow, onPinClick, isDragging,
        setFocusRow, visibleNames, DRAG_SLOP_PX,
    };
    console.log('[SessionSidebarReorder Module] Exported as window.SessionSidebarReorder');
})();
