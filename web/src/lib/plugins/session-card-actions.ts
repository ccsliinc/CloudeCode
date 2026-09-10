/**
 * The `session-card-action` surface, as its first consumer uses it:
 * render the enabled actions for one row, and run one of them by id.
 *
 * WHY THIS EMITS AN HTML STRING. The only consumer today is
 * `client/js/session-row-menu.js`, which builds its panel by setting
 * `innerHTML` on a holder and then decorating the children. Handing it
 * elements would mean rewriting that menu, which is a later slice. The
 * CONTRIBUTION itself is pure data (label, icon, class, attrs), so the
 * same values render as elements the day a Svelte card wants them - the
 * string lives here, in the adapter, not in the plugin.
 *
 * THE ID TRAVELS THROUGH THE DOM AND BACK. `data-plugin-action` is
 * written by this renderer, never by a plugin, and it is how a click on
 * a rendered control finds the `run` that belongs to it. That is the
 * whole reason the surface is more than decoration: without the return
 * trip, `run` would be a field nothing reads and the legacy handler
 * would still own the behaviour.
 *
 * `enabled` IS CHECKED TWICE, ON PURPOSE. Once when rendering, and again
 * in `runSessionCardAction`. A menu is built from a row's state and can
 * sit open across a poll or a flag change, so a fragment on screen is
 * not proof the action still applies. Checking only at render would make
 * the flag a paint-time suggestion rather than a gate.
 */
import { surfacesOf } from './registry';
import type { PluginContext, SessionCardAction, SessionCardRow } from './types';

/** One rendered action, ready for a caller that paints HTML. */
export interface RenderedSessionCardAction {
    /** The contribution id, as written into `data-plugin-action`. */
    readonly id: string;
    /** The control's markup, one element. */
    readonly html: string;
}

/**
 * Escape a value for an HTML attribute.
 *
 * Description: the same five replacements, in the same order, as
 *   `escapeAttr` in `client/js/session-status-ui.js`. It is copied rather
 *   than imported because that file is a browser IIFE with no export, and
 *   the equivalence test in `session-card-actions.test.ts` loads the real
 *   one and compares output so the two cannot drift unnoticed. `&` must
 *   stay first or an escaped entity gets escaped a second time.
 * Inputs: value - anything. Output: string, safe inside double quotes.
 * Example: escapeAttr('a"b') -> 'a&quot;b'
 */
export function escapeAttr(value: unknown): string {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render one action for one row.
 *
 * Description: a `<span role="button" tabindex="0">`, which is the shape
 *   every control on this surface has today and the shape the row menu's
 *   `decorateItem` expects to re-label (it reads the `title` and
 *   overrides the role to `menuitem`). Attribute ORDER here is this
 *   function's, not the contribution's: no stylesheet, assistive
 *   technology or handler in this app selects on attribute order.
 * Inputs: id - the contribution id; action - the contribution's payload;
 *   row - the session the control acts on.
 * Output: string - one element.
 * Example:
 *   actionHtml('mark-unread', markUnread, {name: 'cloude_api', unread: false})
 */
export function actionHtml(
    id: string,
    action: SessionCardAction,
    row: SessionCardRow,
): string {
    const label = action.label(row);
    const attrs = action.attrs(row);
    const extra = Object.keys(attrs)
        .map((key) => ` ${key}="${escapeAttr(attrs[key])}"`)
        .join('');
    return (
        `<span class="${escapeAttr(action.className(row))}" `
        + 'role="button" tabindex="0" '
        + `title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" `
        + `data-plugin-action="${escapeAttr(id)}"${extra}>`
        + `${action.icon(row)}</span>`
    );
}

/**
 * Every enabled `session-card-action` for one row, in registry order.
 *
 * Description: THE ONE CALL A LEGACY RENDERER MAKES. Published as
 *   `window.CloudeWeb.sessionCardActions`.
 * Inputs: row - the session; context - flags and the repaint callback.
 * Output: RenderedSessionCardAction[] - possibly empty, never null.
 * Example:
 *   sessionCardActions({name: 'cloude_api', unread: false},
 *                      {flags: {}, refresh: () => {}})
 */
export function sessionCardActions(
    row: SessionCardRow,
    context: PluginContext,
): RenderedSessionCardAction[] {
    return surfacesOf('session-card-action')
        .filter((c) => c.enabled(context))
        .map((c) => ({ id: c.id, html: actionHtml(c.id, c.payload, row) }));
}

/**
 * Run one `session-card-action` by id.
 *
 * Description: the return trip for `data-plugin-action`. Returns false
 *   when no contribution carries that id or when it is not enabled right
 *   now, so a caller can tell "this menu item is not mine" from "I ran
 *   it" rather than guessing from an absence of errors. Published as
 *   `window.CloudeWeb.runSessionCardAction`.
 * Inputs: id - the contribution id off the element; row; context.
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
