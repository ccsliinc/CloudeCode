/**
 * THE BRIDGE BETWEEN THE ROW MENU AND THE COMPILED PLUGIN REGISTRY, and
 * the only one. Two entry points because there are two moments - paint
 * and run - and each of them has exactly one caller:
 *
 *   menuItems(row)      <- session-row-menu.js::itemsFor and
 *                          ::contextFromRow
 *   run(id, row)        <- session-row-menu-actions.js::run
 *
 * There is deliberately NO third path and no hardcoded fallback. Until
 * this file existed, mark unread was a hardcoded entry in
 * session-row-menu-items.js, an availability probe against
 * SessionStatusUI.markUnreadHtml in session-row-menu.js, and a
 * fabricated proxy element handed to SessionSidebarClicks
 * .onMarkUnreadClick in session-row-menu-actions.js. All three were
 * deleted. If the registry offers nothing, the menu shows nothing: a
 * fallback copy would make the registry decorative and would hide
 * exactly the failure the guard below reports.
 *
 * THE GUARD GUARDS THE FUNCTION, NOT THE RESULT. An empty list is a
 * legitimate answer - it is what `ui.show_mark_unread_control: false`
 * looks like - so an absent bundle has to be told apart from a gate
 * doing its job. In a browser the bundle is always there:
 * client/index.html loads client/dist/app.js as a deferred module before
 * any row is painted. It is absent only in a Node harness that forgot to
 * load it, and a harness quietly measuring a menu with a shipped item
 * missing from it is the false green this project keeps paying for.
 *
 * Load order: BEFORE session-row-menu.js. No dependency of its own
 * beyond the optional `window.CloudeWeb` and `window.UIFlags`.
 */

console.log('[SessionRowMenuPlugins Module] Loading...');

(function () {
    'use strict';

    /**
     * Description: the flags half of a PluginContext, from the one gate.
     *
     *   FLAGS DEFAULT ON, AND ABSENCE MEANS ON. `UIFlags` answers its own
     *   default until its probe lands and whenever it cannot run at all,
     *   so a failed read never takes a control away - client/js/ui-flags.js
     *   is where that rule is written down, and this carries it rather
     *   than restating it in the plugin.
     * Inputs: none.
     * Output: object - flags by config key.
     */
    function flags() {
        return {
            show_mark_unread_control: window.UIFlags
                ? window.UIFlags.showMarkUnreadControl()
                : true,
        };
    }

    /**
     * Description: the context a contribution is judged by while the menu
     *   is being DESCRIBED. A paint has nothing to repaint, so `refresh`
     *   is a stated no-op rather than a callback the pure menu module has
     *   no business holding.
     * Inputs: none.
     * Output: object - {flags, refresh}, as
     *   web/src/lib/plugins/types.ts::PluginContext.
     */
    function renderContext() {
        return { flags: flags(), refresh: function () {} };
    }

    /**
     * Description: the context an ACTIVATED item runs in. Same flags, and
     *   a real repaint - the surface the menu was opened on, forced past
     *   its poll signature guard the way every other row action does.
     * Inputs: ctx (object) - the menu's captured context, for `surface`.
     * Output: object - {flags, refresh}.
     * Example: runContext({surface: 'sidebar'})
     */
    function runContext(ctx) {
        var c = ctx || {};
        return {
            flags: flags(),
            refresh: function () {
                var actions = window.SessionRowMenuActions;
                if (actions && typeof actions.repaintSurface === 'function') {
                    actions.repaintSurface(c);
                }
            },
        };
    }

    /**
     * Description: every enabled `session-card-action` contribution for
     *   one row, as menu item descriptors.
     * Inputs: row (object) - {name (string), unread (boolean)}.
     * Output: Array<{id, shortcut, label, order}> - possibly empty.
     * Example: menuItems({name: 'cloude_api', unread: false})
     */
    function menuItems(row) {
        var web = window.CloudeWeb;
        if (!web || typeof web.sessionCardMenuItems !== 'function') {
            console.error(
                '[SessionRowMenuPlugins] window.CloudeWeb.sessionCardMenuItems '
                + 'is missing - every plugin-contributed menu item is absent');
            return [];
        }
        return web.sessionCardMenuItems(
            { name: (row && row.name) || '', unread: !!(row && row.unread) },
            renderContext()) || [];
    }

    /**
     * Description: run one contribution by its item id. Answers whether
     *   anything ran, so the caller can tell "not a plugin item" from
     *   "ran it" rather than guessing from an absence of errors.
     * Inputs: id (string) - the item id off the activated element.
     *   ctx (object) - the menu's captured context.
     * Output: Promise<boolean>.
     * Example: await SessionRowMenuPlugins.run('mark-unread', ctx)
     */
    function run(id, ctx) {
        var web = window.CloudeWeb;
        if (!web || typeof web.runSessionCardAction !== 'function') {
            console.error(
                '[SessionRowMenuPlugins] window.CloudeWeb.runSessionCardAction '
                + 'is missing - "' + id + '" cannot run');
            return Promise.resolve(false);
        }
        var c = ctx || {};
        return Promise.resolve(web.runSessionCardAction(
            id, { name: c.name || '', unread: !!c.unread }, runContext(c)));
    }

    window.SessionRowMenuPlugins = {
        flags: flags,
        renderContext: renderContext,
        runContext: runContext,
        menuItems: menuItems,
        run: run,
    };
})();

console.log('[SessionRowMenuPlugins Module] Exported as window.SessionRowMenuPlugins');
