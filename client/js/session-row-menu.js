/**
 * Session row ACTION MENU - the definition half.
 * ----------------------------------------------------------------------
 * The vertical three-dot control on a session row, and the eight items
 * behind it - seven from the table next door and one from the plugin
 * registry. This file is PURE: it takes a row payload and returns
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
 * ONE OF THE ITEMS IS A PLUGIN, AND THE MENU CANNOT TELL. Mark unread
 * is no longer an entry in the table next door: it is the first
 * contribution on the compiled tree's `session-card-action` surface
 * (web/src/lib/plugins/mark-unread/), merged into ITEMS by `itemsFor` and
 * rendered by `panelHtml` as the same button as its seven neighbours,
 * with the same shortcut hint and the same place in the focus ring. The
 * ONE bridge is client/js/session-row-menu-plugins.js; this file names it
 * once, in `pluginItemsFor`, and there is no hardcoded copy of that item
 * behind it. The owner's 2026-09-10 superset ruling is unchanged - the
 * item still sits second, still says the same two sentences, and still
 * vanishes when `ui.show_mark_unread_control` is off. Only the list it
 * comes from moved.
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
 * No dependencies beyond an optional SessionSidebarRows for escaping, an
 * optional KebabIcon for the trigger's glyph and an optional
 * SessionRowMenuIcons for each item's prefix icon. Must load BEFORE
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
    var ICON_CLASS = 'session-row-menu__icon';

    /**
     * The eight items, in render order. LIFTED OUT to
     * client/js/session-row-menu-items.js for the 500-line rule; see that
     * file for the table itself and for why each item is shaped as it is.
     * Re-exported below as `SessionRowMenu.ITEMS`, unchanged, so nothing
     * that reads it had to move.
     * @type {Array<object>}
     */
    var ITEMS = (window.SessionRowMenuItems
        && window.SessionRowMenuItems.ITEMS) || [];

    /**
     * Description: the plugin-contributed menu items for one row, through
     *   client/js/session-row-menu-plugins.js - THE ONE BRIDGE. This
     *   module names it here and nowhere else; the module itself is what
     *   reports an absent bundle, and it has no fallback copy of anything.
     * Inputs: row (object) - anything carrying `name` and `unread`.
     * Output: Array<{id, shortcut, label, order}> - empty without a bridge.
     */
    function pluginItemsFor(row) {
        var bridge = window.SessionRowMenuPlugins;
        if (!bridge || typeof bridge.menuItems !== 'function') return [];
        return bridge.menuItems(row) || [];
    }

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
        var status = row.status || 'unknown';
        // DERIVED, NEVER RE-LISTED. SessionRowActions.actionsFor is the
        // one place that decides which controls a status gets, so asking
        // it is what keeps decision 3's live-row restart and this menu
        // from drifting apart. No module here keeps a second status list.
        var actions = (window.SessionRowActions
            && typeof window.SessionRowActions.actionsFor === 'function')
            ? window.SessionRowActions.actionsFor(status)
            : [];
        var restartable = actions.indexOf(
            window.SessionRowActions ? window.SessionRowActions.ACTION_RESTART : 'restart'
        ) !== -1;
        // THE PLUGIN ITEMS THIS ROW OFFERS, CAPTURED LIKE EVERY OTHER
        // FACT. Which contributions are enabled is decided HERE, at paint
        // time, and the ids ride the trigger with the rest of the frozen
        // snapshot - so a menu opened five seconds later offers what the
        // row was painted with, exactly as `restartable` and `muted` do.
        var pluginItems = pluginItemsFor(row).map(function (i) {
            return i.id;
        }).join(',');
        var groupable = (o.surface || 'sidebar') === 'sidebar'
            && !!window.SessionSidebarGroupActions;
        return {
            name: row.name || '',
            label: (row.label != null && String(row.label)) || '',
            sessionId: sid,
            surface: o.surface || 'sidebar',
            owned: owned,
            status: status,
            unread: !!row.unread,
            restartable: restartable,
            pluginItems: pluginItems,
            groupable: groupable,
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
            + 'data-row-menu-unread="' + (c.unread ? '1' : '0') + '" '
            + 'data-row-menu-restartable="' + (c.restartable ? '1' : '0') + '" '
            + 'data-row-menu-plugin-items="' + esc(c.pluginItems || '') + '" '
            + 'data-row-menu-groupable="' + (c.groupable ? '1' : '0') + '" '
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
            unread: attr('data-row-menu-unread') === '1',
            restartable: attr('data-row-menu-restartable') === '1',
            pluginItems: attr('data-row-menu-plugin-items'),
            groupable: attr('data-row-menu-groupable') === '1',
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
        var out = ITEMS.filter(function (item) {
            // An item with no `available` predicate is always rendered,
            // so a new entry cannot vanish by forgetting to write one.
            return typeof item.available !== 'function' || !!item.available(c);
        }).map(function (item) {
            var ok = !!item.enabled(c);
            return {
                id: item.id,
                order: item.order,
                shortcut: item.shortcut,
                separatorBefore: !!item.separatorBefore,
                label: item.label(c),
                enabled: ok,
                reason: ok ? '' : (item.reason(c) || ''),
            };
        });
        // THE MERGE, AND THE ONLY PLACE THE TWO LISTS MEET. A plugin item
        // is offered when it was captured on the trigger (the frozen
        // snapshot, `ctx.pluginItems`) AND the registry still reports it
        // enabled now - the same double check the registry itself does
        // between describing an action and running it, for the same
        // reason: a menu can sit open across a poll or a flag change.
        //
        // A plugin item is never `separatorBefore` and never disabled.
        // The separator is the native table's one statement about which
        // items end a running process, and nothing on this surface does
        // that; an item that could not run would need a reason sentence,
        // and a contribution has no way to say one yet.
        var captured = String(c.pluginItems || '').split(',');
        pluginItemsFor(c).forEach(function (item) {
                if (captured.indexOf(item.id) === -1) return;
                out.push({
                    id: item.id,
                    order: item.order,
                    shortcut: item.shortcut,
                    separatorBefore: false,
                    label: item.label,
                    enabled: true,
                    reason: '',
                });
            });
        // Sorted on (order, id) so the result is TOTAL: it does not depend
        // on which list an item came from, on registration sequence, or on
        // array position here.
        out.sort(function (a, b) {
            if (a.order !== b.order) return a.order - b.order;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });
        return out;
    }

    /**
     * Description: whether the shortcut letters are all distinct. Stated
     *   as a function rather than trusted, because the failure it guards
     *   is silent: two items sharing a letter would render two identical
     *   hints and the key would only ever reach the first.
     * Inputs: none. Output: boolean.
     */
    function uniqueShortcuts(ctx) {
        // OVER THE MERGED LIST when a context is given, because a
        // contribution can collide with the native table and a check that
        // only read ITEMS would never see it.
        var list = ctx ? itemsFor(ctx) : ITEMS;
        var seen = Object.create(null);
        for (var i = 0; i < list.length; i++) {
            var k = String(list[i].shortcut).toUpperCase();
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
     *
     *   Each item is prefixed with an icon from SessionRowMenuIcons,
     *   keyed on the item's own id so it cannot drift from the item it
     *   sits beside. ``aria-hidden`` lives on the glyph itself (built by
     *   that module); the icon span carries none of the accessible name,
     *   which stays on the label text alone.
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
            var icon = '<span class="' + ICON_CLASS + '">'
                + (window.SessionRowMenuIcons
                    ? window.SessionRowMenuIcons.svg(item.id, 14) : '')
                + '</span>';
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
                + icon
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
    function itemIdForKey(key, ctx) {
        if (typeof key !== 'string' || key.length !== 1) return null;
        var want = key.toUpperCase();
        // THE MERGED LIST, NOT THE NATIVE TABLE. A plugin item's letter is
        // rendered beside its label by panelHtml, so a key handler reading
        // only ITEMS would paint a hint it could never honour. With no
        // context there is nothing to resolve a contribution's label
        // against, so the native table is all that can be answered for.
        var list = ctx ? itemsFor(ctx) : ITEMS;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].shortcut).toUpperCase() === want) return list[i].id;
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
        ICON_CLASS: ICON_CLASS,
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
