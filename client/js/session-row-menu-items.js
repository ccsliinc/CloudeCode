/**
 * THE ROW ACTION MENU'S ITEM TABLE, extracted from
 * client/js/session-row-menu.js for the project's 500-line rule. This is
 * a LIFT, not a redesign: the table below is byte-identical to the one
 * that lived there, and session-row-menu.js still re-exports it as
 * `SessionRowMenu.ITEMS`, so no caller and no test had to change the name
 * of anything.
 *
 * It is data, not behaviour - each entry is an id, a shortcut letter and
 * three predicates over the captured context. The module that renders and
 * resolves them is session-row-menu.js; the module that runs a chosen one
 * is session-row-menu-actions.js.
 *
 * Load order: BEFORE session-row-menu.js, which reads this at definition
 * time and falls back to an empty table if it is missing (an empty menu
 * is a visible nothing; a thrown error takes the sidebar with it).
 */

console.log('[SessionRowMenuItems Module] Loading...');

(function () {
    /**
     * The eight items, in render order, each with the letter that runs it.
     *
     * RECONCILED 2026-09-10, and the shape is the owner's ruling rather
     * than either side's design: "merge not take everything". Four items
     * come from adam's menu (rename, fork, new session in folder, mute),
     * three from ours (mark unread, move to group, restart the agent),
     * and close is the one both sides already had. See `.claude/TODO.md`,
     * "1.2 merge decisions (owner)" decisions 2 and 3.
     *
     * ``available`` decides whether the item is RENDERED AT ALL;
     * ``enabled`` decides whether a rendered item can run. They are two
     * questions and collapsing them would break both callers:
     *   - mark unread must VANISH when ``ui.show_mark_unread_control``
     *     is off (decision 2's one gate), and a disabled-but-visible
     *     control would still advertise a feature the operator turned
     *     off.
     *   - a rename that cannot run must STAY VISIBLE and say why, which
     *     is the whole point of the aria-disabled treatment below.
     *
     * ``reason`` is only consulted when ``enabled`` is false, and must
     * return a sentence a user can act on, never a code.
     *
     * ``separatorBefore`` is true on exactly one item. RESTART AND CLOSE
     * SIT BELOW IT because both end the process that is running right
     * now - restart kills the pane and respawns it, so on a live row it
     * is every bit as destructive as close, and it only ever appears on
     * a live row (a dead row draws inline restart and remove, and no
     * menu at all). A mis-aimed keystroke or thumb lands on empty space
     * rather than on either.
     * @type {Array<object>}
     */
    var ITEMS = [
        {
            id: 'rename',
            shortcut: 'R',
            separatorBefore: false,
            label: function () { return 'rename'; },
            available: function () { return true; },
            enabled: function (ctx) { return !!ctx.renameable; },
            reason: function (ctx) {
                return ctx.renameReason
                    || 'cannot rename: this session has no live backend to send the change to';
            },
        },
        {
            id: 'mark-unread',
            shortcut: 'U',
            separatorBefore: false,
            // OURS. The label states the RESULT of activating it, so it
            // flips with the row's current flag exactly as the inline
            // control's title did.
            label: function (ctx) {
                return ctx.unread ? 'clear unread flag' : 'mark unread for followup';
            },
            // THE ONE GATE, asked rather than re-implemented: the surface
            // stamps this from SessionStatusUI.markUnreadHtml() returning
            // empty, so `ui.show_mark_unread_control` hides the menu item
            // and the inline control together and there is no second
            // place to remember. See client/js/ui-flags.js.
            available: function (ctx) { return !!ctx.markUnreadAvailable; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'move-to-group',
            shortcut: 'G',
            separatorBefore: false,
            // OURS. Only the sidebar files sessions into groups, so the
            // launchpad stamps this false rather than offering an item
            // that would open a picker with nothing behind it.
            label: function () { return 'move to group'; },
            available: function (ctx) { return !!ctx.groupable; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'fork',
            shortcut: 'F',
            separatorBefore: false,
            label: function () { return 'fork session'; },
            available: function () { return true; },
            enabled: function (ctx) { return !!ctx.forkable; },
            reason: function (ctx) {
                return ctx.forkReason
                    || 'cannot fork: cloudecode did not create this session, so it '
                    + 'has no recorded conversation to branch from';
            },
        },
        {
            id: 'new-in-folder',
            shortcut: 'N',
            separatorBefore: false,
            label: function () { return 'new session in folder'; },
            available: function () { return true; },
            // ALWAYS OFFERED, and that is a measured choice rather than
            // an oversight. The folder is read from the stored session
            // record when the item is ACTIVATED, not when the row is
            // painted, so at paint time nothing here knows whether one
            // will be found. Painting it disabled would be a claim
            // nobody checked; a lookup that comes back empty says so
            // then, naming the session it could not place.
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'mute',
            shortcut: 'M',
            separatorBefore: false,
            label: function (ctx) {
                return ctx.muted ? 'unmute notifications' : 'mute notifications';
            },
            available: function () { return true; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'restart',
            shortcut: 'T',
            separatorBefore: true,
            // OURS, AND THIS IS DECISION 3. A live row offers restart;
            // adam's branch had removed it and the owner ruled it back on
            // 2026-09-09. Availability is DERIVED FROM SessionRowActions
            // .actionsFor() rather than from a second status list, so the
            // row and the menu cannot come to disagree - an `unknown` row
            // gets no restart here for the same reason it never had one
            // inline: a control that kills a running process is not
            // something to offer on a guess.
            label: function () { return 'restart the agent'; },
            available: function (ctx) { return !!ctx.restartable; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'close',
            shortcut: 'C',
            separatorBefore: false,
            label: function () { return 'close session'; },
            available: function () { return true; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
    ];
    window.SessionRowMenuItems = { ITEMS: ITEMS };
})();

console.log('[SessionRowMenuItems Module] Exported as window.SessionRowMenuItems');
