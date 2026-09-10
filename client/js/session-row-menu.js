/**
 * Session row ACTION MENU - the definition half.
 * ----------------------------------------------------------------------
 * The vertical three-dot control on a session row, and the five items
 * behind it. This file is PURE: it takes a row payload and returns
 * strings. Nothing here touches the document beyond escaping, so every
 * claim it makes is provable without a browser. Opening, focus and the
 * keyboard live in client/js/session-row-menu-open.js; what each item
 * DOES lives in client/js/session-row-menu-actions.js.
 *
 * WHY A MENU AGAIN, AFTER ONE WAS REMOVED. Commit ad359bc took a kebab
 * off the row and put pin and close back inline, because by then the
 * menu held four controls the owner did not want in it. This is not that
 * menu coming back: the CONTENTS are different and so is what it
 * replaces. It carries rename, fork, new-session-in-folder, mute and
 * close - four of which have never had a control on a row at all - and
 * it takes the place of the live row's close X, which is the one thing
 * it inherits. PIN STAYS INLINE. A dead row is untouched: it keeps its
 * inline restart and remove and gets no menu, because none of these five
 * items is the thing a stopped session needs.
 *
 * IDENTITY IS CAPTURED, NOT LOOKED UP. Every fact an item needs - the
 * tmux name, the live session id, the label, ownership, the rename
 * verdict and the mute state - is stamped on the trigger when the row is
 * PAINTED, and read off it once when the menu OPENS. From then on the
 * open menu holds a frozen snapshot. This matters because the sidebar
 * repaints itself every five seconds and the launchpad repaints on its
 * own poll: an item that re-read the DOM on activation could find a row
 * that had been rebuilt, reordered, or replaced by a different session
 * that reused the same tmux name, and would then run against whatever
 * was under the cursor rather than what the user opened the menu on.
 *
 * SHORTCUT LETTERS ARE PART OF THE DEFINITION, not a decoration. Each
 * item owns its letter here, the panel renders it, and the key handler
 * in the open module matches on the same table - so a letter cannot be
 * shown for one item and bound to another. They are unique by
 * construction and ``uniqueShortcuts()`` says so out loud.
 *
 * AN UNAVAILABLE ITEM IS STILL RENDERED, STILL FOCUSABLE, AND CARRIES
 * ITS REASON. Hiding it would make the menu change shape between rows
 * and leave a keyboard user wondering which entry moved; disabling it
 * silently would leave them pressing a key that does nothing. So it
 * paints, it takes focus, it states why in text an assistive technology
 * reads, and it refuses to activate.
 *
 * No dependencies beyond an optional SessionSidebarRows for escaping and
 * an optional KebabIcon for the glyph. Must load BEFORE
 * session-row-menu-actions.js and session-row-menu-open.js, and before
 * session-sidebar-rows.js and launchpad.js paint anything.
 */

console.log('[SessionRowMenu Module] Loading...');

(function () {
    'use strict';

    /** DOM contract. Read by the other two halves and by the tests. */
    var TRIGGER_ATTR = 'data-row-menu';
    var TRIGGER_CLASS = 'session-row-menu-trigger';
    var PANEL_ID = 'session-row-menu-panel';
    var PANEL_CLASS = 'session-row-menu';
    var ITEM_CLASS = 'session-row-menu__item';
    var ITEM_ATTR = 'data-row-menu-item';
    var DISABLED_ATTR = 'data-row-menu-disabled';
    var SEPARATOR_CLASS = 'session-row-menu__sep';
    var KEY_CLASS = 'session-row-menu__key';
    var LABEL_CLASS = 'session-row-menu__label';
    var REASON_CLASS = 'session-row-menu__reason';

    /**
     * The five items, in render order, each with the letter that runs it.
     *
     * ``enabled`` and ``reason`` take the captured context and answer for
     * THAT row. ``reason`` is only consulted when ``enabled`` is false,
     * and must return a sentence a user can act on, never a code.
     *
     * ``separatorBefore`` is true on exactly one item. Close is the only
     * destructive entry here and it sits apart from the four that are
     * not, so a mis-aimed keystroke or thumb lands on empty space rather
     * than on the control that kills a process.
     * @type {Array<object>}
     */
    var ITEMS = [
        {
            id: 'rename',
            shortcut: 'R',
            separatorBefore: false,
            label: function () { return 'rename'; },
            enabled: function (ctx) { return !!ctx.renameable; },
            reason: function (ctx) {
                return ctx.renameReason
                    || 'cannot rename: this session has no live backend to send the change to';
            },
        },
        {
            id: 'fork',
            shortcut: 'F',
            separatorBefore: false,
            label: function () { return 'fork session'; },
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
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
        {
            id: 'close',
            shortcut: 'C',
            separatorBefore: true,
            label: function () { return 'close session'; },
            enabled: function () { return true; },
            reason: function () { return ''; },
        },
    ];

    /**
     * Description: HTML-escape for an attribute, routed through
     *   SessionSidebarRows so this module owns no second escaper. The
     *   local fallback exists only for the load orders that do not have
     *   that module (the node tests load this file alone).
     * Inputs: value (any). Output: string.
     */
    function esc(value) {
        if (window.SessionSidebarRows
            && typeof window.SessionSidebarRows.esc === 'function') {
            return window.SessionSidebarRows.esc(value).replace(/"/g, '&quot;');
        }
        var div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;');
    }

    /**
     * Description: the mute state this row should PAINT, which is not
     *   always the field on the payload. A toggle the user just made is
     *   held in an in-memory override so the label does not flip back on
     *   the next repaint while the server-side field catches up; the
     *   payload is what answers for every row the user has not touched.
     *
     *   An ABSENT field reads false. That is the old-server case named in
     *   the contract, and it is also what a payload that simply does not
     *   carry the field yet looks like. False means "no suppression is
     *   recorded", which is the safe direction: a session whose alerts we
     *   cannot confirm are muted keeps alerting.
     * Inputs: name (string) - tmux session name. payload (boolean|
     *   undefined|null) - ``notifications_muted`` off the row.
     * Output: boolean.
     * Example: mutedFor('cloude_api', undefined) -> false
     */
    var muteOverride = Object.create(null);

    function mutedFor(name, payload) {
        if (name && Object.prototype.hasOwnProperty.call(muteOverride, name)) {
            return !!muteOverride[name];
        }
        return payload === true;
    }

    /**
     * Description: record what this browser now believes about a
     *   session's mute state, so the next repaint paints the label the
     *   user just chose rather than the one the last poll carried.
     *   Passing null FORGETS the override, which is what a rollback does
     *   when the row's own payload was the truth all along.
     * Inputs: name (string), muted (boolean|null).
     * Output: void.
     */
    function setMuteOverride(name, muted) {
        if (!name) return;
        if (muted === null) { delete muteOverride[name]; return; }
        muteOverride[name] = !!muted;
    }

    /**
     * Description: the frozen identity of one row, built from its payload
     *   at PAINT time. Every field an item can need is in here, because
     *   the whole point is that nothing is looked up again later.
     *
     *   `renameable` mirrors each surface's own rename verdict rather
     *   than being re-derived, so the menu cannot offer a rename the row
     *   itself says is impossible. The caller passes it in.
     * Inputs:
     *   r (object) - one row payload (a merged sidebar row, or a
     *     launchpad running-session row; the fields read are common to
     *     both).
     *   opts (object|null) - {surface (string), renameable (boolean),
     *     renameReason (string)}.
     * Output: object - the context, all primitives.
     * Example:
     *   contextFromRow({name: 'cloude_api', created_by_cloude: true},
     *                  {surface: 'sidebar', renameable: true})
     */
    function contextFromRow(r, opts) {
        var row = r || {};
        var o = opts || {};
        var owned = !!row.created_by_cloude;
        var sid = row.session_id || null;
        var forkable = owned && !!row.name;
        return {
            name: row.name || '',
            label: (row.label != null && String(row.label)) || '',
            sessionId: sid,
            surface: o.surface || 'sidebar',
            owned: owned,
            status: row.status || 'unknown',
            renameable: !!o.renameable,
            renameReason: o.renameReason || '',
            forkable: forkable,
            forkReason: forkable
                ? ''
                : 'cannot fork: cloudecode did not create this session, so it has '
                  + 'no recorded conversation to branch from',
            muted: mutedFor(row.name, row.notifications_muted),
        };
    }

    /**
     * Description: the trigger button, carrying the whole captured
     *   context in data attributes. It is a real ``<button>`` with
     *   ``aria-haspopup="menu"`` and ``aria-expanded``, so it is operable
     *   by Enter and Space without this module handling either.
     *
     *   ``tabindex="-1"`` matches the row's other inline controls: the
     *   sidebar list owns the tab stop and moves focus between rows
     *   itself. The menu's own items are the tab-reachable things once it
     *   is open.
     * Inputs: ctx (object) - from contextFromRow.
     * Output: string - HTML for one button.
     */
    function triggerHtml(ctx) {
        var c = ctx || {};
        var shown = c.label || c.name;
        return (
            '<button type="button" class="' + TRIGGER_CLASS + '" '
            + TRIGGER_ATTR + '="' + esc(c.name) + '" '
            + 'data-row-menu-label="' + esc(c.label) + '" '
            + 'data-row-menu-session-id="' + esc(c.sessionId || '') + '" '
            + 'data-row-menu-surface="' + esc(c.surface) + '" '
            + 'data-row-menu-owned="' + (c.owned ? '1' : '0') + '" '
            + 'data-row-menu-status="' + esc(c.status) + '" '
            + 'data-row-menu-renameable="' + (c.renameable ? '1' : '0') + '" '
            + 'data-row-menu-rename-reason="' + esc(c.renameReason) + '" '
            + 'data-row-menu-forkable="' + (c.forkable ? '1' : '0') + '" '
            + 'data-row-menu-fork-reason="' + esc(c.forkReason) + '" '
            + 'data-row-menu-muted="' + (c.muted ? '1' : '0') + '" '
            + 'tabindex="-1" aria-haspopup="menu" aria-expanded="false" '
            + 'aria-controls="' + PANEL_ID + '" '
            + 'title="session actions" '
            + 'aria-label="' + esc('session actions for ' + shown) + '">'
            + (window.KebabIcon ? window.KebabIcon.svg(16) : '')
            + '</button>'
        );
    }

    /**
     * Description: read the captured context back off a rendered trigger.
     *   THE ONE PLACE the open module learns what row it is acting on.
     * Inputs: el (Element) - a rendered trigger.
     * Output: object|null - the context, or null with no element.
     */
    function contextFromTrigger(el) {
        if (!el || typeof el.getAttribute !== 'function') return null;
        function attr(n) { return el.getAttribute(n) || ''; }
        return {
            name: attr(TRIGGER_ATTR),
            label: attr('data-row-menu-label'),
            sessionId: attr('data-row-menu-session-id') || null,
            surface: attr('data-row-menu-surface') || 'sidebar',
            owned: attr('data-row-menu-owned') === '1',
            status: attr('data-row-menu-status') || 'unknown',
            renameable: attr('data-row-menu-renameable') === '1',
            renameReason: attr('data-row-menu-rename-reason'),
            forkable: attr('data-row-menu-forkable') === '1',
            forkReason: attr('data-row-menu-fork-reason'),
            muted: attr('data-row-menu-muted') === '1',
        };
    }

    /**
     * Description: resolve every item against one context - its label
     *   now, whether it can run now, and why not when it cannot.
     * Inputs: ctx (object). Output: Array<object>.
     * Example: itemsFor(ctx)[3].label -> 'mute notifications'
     */
    function itemsFor(ctx) {
        var c = ctx || {};
        return ITEMS.map(function (item) {
            var ok = !!item.enabled(c);
            return {
                id: item.id,
                shortcut: item.shortcut,
                separatorBefore: !!item.separatorBefore,
                label: item.label(c),
                enabled: ok,
                reason: ok ? '' : (item.reason(c) || ''),
            };
        });
    }

    /**
     * Description: whether the shortcut letters are all distinct. Stated
     *   as a function rather than trusted, because the failure it guards
     *   is silent: two items sharing a letter would render two identical
     *   hints and the key would only ever reach the first.
     * Inputs: none. Output: boolean.
     */
    function uniqueShortcuts() {
        var seen = Object.create(null);
        for (var i = 0; i < ITEMS.length; i++) {
            var k = String(ITEMS[i].shortcut).toUpperCase();
            if (seen[k]) return false;
            seen[k] = true;
        }
        return true;
    }

    /**
     * Description: the panel's inner markup for one context.
     *
     *   A disabled item keeps ``tabindex="0"`` and gains
     *   ``aria-disabled="true"`` rather than the ``disabled`` attribute.
     *   A natively disabled button is skipped by focus entirely, so the
     *   explanation would be unreachable by exactly the users who most
     *   need it. The reason is rendered as TEXT inside the item and
     *   referenced by ``aria-describedby``, so it is announced rather
     *   than left in a tooltip a keyboard never opens.
     * Inputs: ctx (object). Output: string - HTML.
     */
    function panelHtml(ctx) {
        var c = ctx || {};
        return itemsFor(c).map(function (item, i) {
            var sep = item.separatorBefore
                ? '<div class="' + SEPARATOR_CLASS + '" role="separator"></div>'
                : '';
            var reasonId = PANEL_ID + '-reason-' + i;
            var reason = (!item.enabled && item.reason)
                ? '<span class="' + REASON_CLASS + '" id="' + reasonId + '">'
                  + esc(item.reason) + '</span>'
                : '';
            return sep
                + '<button type="button" class="' + ITEM_CLASS + '" role="menuitem" '
                + ITEM_ATTR + '="' + esc(item.id) + '" '
                + 'data-row-menu-key="' + esc(item.shortcut) + '" '
                + 'tabindex="0" '
                + (item.enabled
                    ? ''
                    : ('aria-disabled="true" ' + DISABLED_ATTR + '="1" '
                       + 'aria-describedby="' + reasonId + '" '
                       + 'title="' + esc(item.reason) + '" '))
                + '>'
                + '<span class="' + LABEL_CLASS + '">' + esc(item.label) + '</span>'
                + '<span class="' + KEY_CLASS + '" aria-hidden="true">'
                + esc(item.shortcut) + '</span>'
                + reason
                + '</button>';
        }).join('');
    }

    /**
     * Description: the item id one letter runs, or null. Case-insensitive
     *   because a user holding shift for a capital letter means the same
     *   thing; MODIFIERS are the caller's problem, not this table's.
     * Inputs: key (string) - a KeyboardEvent.key value.
     * Output: string|null - an item id.
     */
    function itemIdForKey(key) {
        if (typeof key !== 'string' || key.length !== 1) return null;
        var want = key.toUpperCase();
        for (var i = 0; i < ITEMS.length; i++) {
            if (ITEMS[i].shortcut === want) return ITEMS[i].id;
        }
        return null;
    }

    window.SessionRowMenu = {
        TRIGGER_ATTR: TRIGGER_ATTR,
        TRIGGER_CLASS: TRIGGER_CLASS,
        PANEL_ID: PANEL_ID,
        PANEL_CLASS: PANEL_CLASS,
        ITEM_CLASS: ITEM_CLASS,
        ITEM_ATTR: ITEM_ATTR,
        DISABLED_ATTR: DISABLED_ATTR,
        SEPARATOR_CLASS: SEPARATOR_CLASS,
        KEY_CLASS: KEY_CLASS,
        LABEL_CLASS: LABEL_CLASS,
        REASON_CLASS: REASON_CLASS,
        ITEMS: ITEMS,
        esc: esc,
        mutedFor: mutedFor,
        setMuteOverride: setMuteOverride,
        contextFromRow: contextFromRow,
        contextFromTrigger: contextFromTrigger,
        triggerHtml: triggerHtml,
        itemsFor: itemsFor,
        panelHtml: panelHtml,
        itemIdForKey: itemIdForKey,
        uniqueShortcuts: uniqueShortcuts,
    };
})();

console.log('[SessionRowMenu Module] Exported as window.SessionRowMenu');
