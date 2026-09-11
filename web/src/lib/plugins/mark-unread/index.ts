/**
 * The mark-unread item, as the first real plugin.
 *
 * WHAT THIS IS A RE-SEAT OF, NOT A REDESIGN OF. `client/js/
 * session-row-menu-items.js` carried mark unread as a hardcoded entry in
 * its table, `session-row-menu.js` decided its availability by asking
 * `SessionStatusUI.markUnreadHtml` whether it returned empty, and
 * `session-row-menu-actions.js::runMarkUnread` ran it by fabricating a
 * detached element for `SessionSidebarClicks.onMarkUnreadClick`. All
 * four of those were deleted in the same commit that added this file:
 * the menu now asks the registry, and this is what answers.
 *
 * THE LABELS ARE THE SHIPPED ONES, BYTE FOR BYTE - "clear unread flag"
 * and "mark unread for followup", the same two strings the deleted table
 * entry returned and the same two `markUnreadHtml` still puts in a
 * control's `title`. Slice 5 moved them into the string catalog;
 * `session-card-actions.test.ts` loads that real builder and compares, so
 * the catalog and the legacy module cannot come to say different words
 * for one action.
 *
 * THE SHORTCUT IS `U` AND THE ORDER PUTS IT SECOND, which is where the
 * owner's 2026-09-10 superset ruling placed it: rename, mark unread,
 * move to group, fork, new session in folder, mute, separator, restart,
 * close. Nothing about that ruling changed here; only the list the item
 * comes from moved.
 *
 * THE LAUNCHPAD'S SECOND COPY IS GONE AS OF SLICE 5. `client/js/
 * launchpad.js` used to draw its own inline envelope control through
 * `markUnreadHtml`, with its own handler (`_handleMarkUnread`), because
 * that screen had not been migrated. The running-sessions card is a
 * component now and it renders THIS contribution, so the flag is read
 * once, by this `enabled`, for both surfaces.
 *
 * THE FLAG STAYS THE GATE. `ui.show_mark_unread_control` (config.json,
 * served on `GET /api/v1/features`, cached by `client/js/ui-flags.js`) is
 * read by `enabled`, so switching the control off is still one config
 * key and does not mean unregistering anything. A missing flag reads as
 * ON, which is `ui-flags.js`'s own rule: a probe that could not run must
 * never be the reason a control disappears.
 */
import { t } from '../../i18n/index.svelte';
import { RUNNING_SESSION_KEYS } from '../../../../../client/js/labels/running-session.js';
import type {
    Contribution,
    Plugin,
    PluginContext,
    SessionCardAction,
    SessionCardRow,
} from '../types';

/** The config key on `GET /api/v1/features`'s `ui` block. */
export const FLAG = 'show_mark_unread_control';

/** The contribution id. Travels into the DOM as `data-row-menu-item`. */
export const ACTION_ID = 'mark-unread';

/** The API surface this action needs off the legacy tree. */
interface UnreadApi {
    setSessionUnread(tmuxName: string, unread: boolean): Promise<unknown>;
}

/**
 * The live `window.API`, or null when it is not there.
 *
 * Description: resolved at CALL time, not at import time. The bundle is
 *   loaded as a deferred module and this file is imported for its
 *   registration side effect, so reading `window.API` while the module
 *   body runs would capture whatever the legacy tree had published by
 *   then. It also gives the test a seam with no globals to install.
 * Inputs: none. Output: UnreadApi | null.
 */
function unreadApi(): UnreadApi | null {
    const api = (globalThis as { API?: UnreadApi }).API;
    return api && typeof api.setSessionUnread === 'function' ? api : null;
}

/** The action's payload: what the item says, and what it does. */
const action: SessionCardAction = {
    /** The letter the row menu renders and binds. Inputs: none. */
    shortcut: 'U',

    /**
     * The label names the RESULT of activating it, not its state.
     *
     * THROUGH THE CATALOG SINCE SLICE 5, because the running-sessions card
     * renders this contribution as an inline control and every
     * user-visible string on that surface goes through the string layer.
     * The reactive `t` is used rather than the plain one: a contribution
     * is described at paint time inside a component, so it repaints on a
     * locale change like everything beside it.
     *
     * THE WORDS ARE UNCHANGED, and ../session-card-actions.test.ts holds
     * them against the real `SessionStatusUI.markUnreadHtml` so the two
     * cannot drift.
     * Inputs: row. Output: string.
     */
    label(row: SessionCardRow): string {
        return t(row.unread
            ? RUNNING_SESSION_KEYS.unreadClear
            : RUNNING_SESSION_KEYS.unreadSet);
    },

    /**
     * Toggle the flag server-side, then repaint.
     *
     * Description: the body of the deleted `onMarkUnreadClick`. The next
     *   state is derived from the row the item was described from, so
     *   the PATCH sends the opposite of what the user is looking at
     *   without re-reading the DOM - the frozen snapshot the row menu
     *   captured at paint time, which is the whole point of that model.
     *   The repaint is the caller's, through `context.refresh()`, because
     *   waiting a full poll tick with no visual feedback feels broken.
     *
     *   A FAILED PATCH IS LOGGED AND SWALLOWED, deliberately: the next
     *   poll reconciles the row either way, and there is nothing useful
     *   for a menu item to rethrow into.
     * Inputs: row; context. Output: Promise<void>.
     */
    async run(row: SessionCardRow, context: PluginContext): Promise<void> {
        const api = unreadApi();
        if (!api) {
            console.error('[plugins] mark-unread: window.API is not available');
            return;
        }
        try {
            await api.setSessionUnread(row.name, !row.unread);
        } catch (err) {
            console.error('[plugins] mark-unread failed:', err);
            return;
        }
        await context.refresh();
    },
};

/** The one contribution, on the one proven surface. */
const contribution: Contribution<'session-card-action'> = {
    id: ACTION_ID,
    surface: 'session-card-action',
    // SECOND IN THE MENU, per the superset ruling. The native table runs
    // rename 100, move-to-group 300, fork 400, new-in-folder 500, mute
    // 600, restart 700, close 800; 200 is the gap left for this item and
    // leaves room either side without renumbering anything.
    order: 200,
    /**
     * Read as `!== false`, so an unknown flag shows the item. See the
     * module docblock: a probe that could not run must not hide a
     * shipped capability.
     * Inputs: context. Output: boolean.
     */
    enabled(context: PluginContext): boolean {
        return context.flags[FLAG] !== false;
    },
    payload: action,
};

/** The plugin, registered by `builtin.ts`. */
export const markUnreadPlugin: Plugin = {
    id: 'mark-unread',
    contributions: [contribution],
};
