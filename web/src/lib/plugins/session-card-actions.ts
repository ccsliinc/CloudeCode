/**
 * The `session-card-action` surface, as its first consumer uses it:
 * describe the enabled items for one row, and run one of them by id.
 *
 * WHY THIS EMITS DESCRIPTORS AND NOT HTML. The only consumer today is
 * the session row action menu, and since 1.2.1 that menu is a
 * DECLARATIVE TABLE: `client/js/session-row-menu-items.js` holds the
 * native entries as data, `session-row-menu.js::itemsFor` resolves them
 * against a captured row context, and `panelHtml` renders every one of
 * them as the same `<button role="menuitem">`. A contribution that
 * returned its own markup would paint a control that does not look like
 * its neighbours, does not join the arrow-key focus ring, and carries no
 * shortcut letter for the key handler to find. So a contribution
 * returns exactly what the native table returns - id, shortcut, label,
 * order - and the menu draws it.
 *
 * THIS REPLACED AN HTML RENDERER, and the deleted half is worth naming
 * so it is not rebuilt by accident: `actionHtml` and a local `escapeAttr`
 * used to emit a `<span role="button">` carrying a glyph, a class list
 * and `data-mark-unread`, matching `session-status-ui.js::markUnreadHtml`
 * attribute for attribute. That equivalence was load bearing while the
 * sidebar row menu concatenated the same control the launchpad drew
 * inline; it stopped being true of the sidebar the moment 1.2.1 made
 * that menu uniform. The launchpad still draws the inline control
 * through `markUnreadHtml` and is untouched by any of this.
 *
 * THE ID IS THE RETURN TRIP. The menu writes the item id into
 * `data-row-menu-item` like any other item, and hands it back to
 * `runSessionCardAction`. That is what makes this surface more than
 * decoration: without it, `run` would be a field nothing reads.
 *
 * `enabled` IS CHECKED TWICE, ON PURPOSE. Once when the items are
 * described, and again in `runSessionCardAction`. A menu is built from a
 * row's state and can sit open across a poll or a flag change, so an
 * item on screen is not proof the action still applies. Checking only at
 * render would make the flag a paint-time suggestion rather than a gate.
 */
import { surfacesOf } from './registry';
import type { PluginContext, SessionCardRow } from './types';

/** One item a contribution offers, in the shape the row menu's table uses. */
export interface SessionCardMenuItem {
    /** The contribution id. Travels as `data-row-menu-item` and back. */
    readonly id: string;
    /** The single uppercase letter that runs it. */
    readonly shortcut: string;
    /** The label for this row, right now. */
    readonly label: string;
    /** Where it sorts among the menu's native items. */
    readonly order: number;
}

/**
 * Every enabled `session-card-action` for one row, in registry order.
 *
 * Description: THE ONE CALL THE MENU MAKES TO PAINT. Published as
 *   `window.CloudeWeb.sessionCardMenuItems`. Never null, possibly empty -
 *   an empty list is what the flag being off looks like, and the caller
 *   must be able to tell that from a bundle that failed to load, which
 *   is why the caller guards for the FUNCTION's absence rather than for
 *   an empty result.
 * Inputs: row - the session; context - flags and the repaint callback.
 * Output: SessionCardMenuItem[].
 * Example:
 *   sessionCardMenuItems({name: 'cloude_api', unread: false},
 *                        {flags: {}, refresh: () => {}})
 */
export function sessionCardMenuItems(
    row: SessionCardRow,
    context: PluginContext,
): SessionCardMenuItem[] {
    return surfacesOf('session-card-action')
        .filter((c) => c.enabled(context))
        .map((c) => ({
            id: c.id,
            shortcut: c.payload.shortcut,
            label: c.payload.label(row),
            order: c.order ?? 0,
        }));
}

/**
 * Run one `session-card-action` by id.
 *
 * Description: the return trip for the item id. Returns false when no
 *   contribution carries that id or when it is not enabled right now, so
 *   a caller can tell "this menu item is not mine" from "I ran it"
 *   rather than guessing from an absence of errors. Published as
 *   `window.CloudeWeb.runSessionCardAction`.
 * Inputs: id - the item id off the panel; row; context.
 * Output: Promise<boolean> - true only when an action actually ran.
 * Example: await runSessionCardAction('mark-unread', row, context)
 */
export async function runSessionCardAction(
    id: string,
    row: SessionCardRow,
    context: PluginContext,
): Promise<boolean> {
    const found = surfacesOf('session-card-action').find((c) => c.id === id);
    if (!found) return false;
    if (!found.enabled(context)) return false;
    await found.payload.run(row, context);
    return true;
}
