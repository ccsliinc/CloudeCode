/**
 * The mark-unread control, as the first real plugin.
 *
 * WHAT THIS IS A RE-SEAT OF, NOT A REDESIGN OF. `client/js/session-status-ui.js`
 * builds this control (`markUnreadHtml`) and `client/js/session-sidebar-clicks.js`
 * ran it (`onMarkUnreadClick`). The sidebar row's overflow menu had the
 * control hardcoded into its item list. Those hardcoded halves were
 * deleted in the same commit that added this file: the menu now asks the
 * registry, and this is what answers. The label strings, the two glyphs,
 * the class names, the aria state and the PATCH are the shipped ones,
 * moved rather than rewritten, and `session-card-actions.test.ts` compares
 * this contribution's markup against the real legacy builder attribute by
 * attribute so the two cannot drift.
 *
 * THE LAUNCHPAD'S COPY IS UNTOUCHED. `client/js/launchpad.js` draws the
 * same control on its running-sessions rows through the same
 * `markUnreadHtml`, with its own handler (`_handleMarkUnread`). That
 * screen has not been migrated, so it keeps its path; the equivalence
 * test is what keeps the two surfaces painting the same control.
 *
 * THE FLAG STAYS THE GATE. `ui.show_mark_unread_control` (config.json,
 * served on `GET /api/v1/features`, cached by `client/js/ui-flags.js`) is
 * read by `enabled`, so switching the control off is still one config
 * key and does not mean unregistering anything. A missing flag reads as
 * ON, which is `ui-flags.js`'s own rule: a probe that could not run must
 * never be the reason a control disappears.
 */
import type {
    Contribution,
    Plugin,
    PluginContext,
    SessionCardAction,
    SessionCardRow,
} from '../types';

/** The config key on `GET /api/v1/features`'s `ui` block. */
export const FLAG = 'show_mark_unread_control';

/** The contribution id. Travels into the DOM as `data-plugin-action`. */
export const ACTION_ID = 'mark-unread';

/**
 * Envelope glyph, "not flagged unread" - a plain outline. Byte for byte
 * `envelopeOutlineSvg()` in `client/js/session-status-ui.js`; no `stroke`
 * colour is set on the paths, so the caller's CSS `color` drives it
 * through `currentColor` and the icon recolors with the theme.
 */
const ENVELOPE_OUTLINE =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">'
    + '<rect x="2" y="3.5" width="12" height="9" rx="1.25" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M2.5 4.25L8 8.5L13.5 4.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

/**
 * Envelope glyph, "flagged unread" - the same outline plus a solid
 * notification dot, so the two states differ by SHAPE and not by colour
 * alone. Byte for byte `envelopeFilledSvg()` in session-status-ui.js.
 */
const ENVELOPE_FILLED =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">'
    + '<rect x="2" y="3.5" width="12" height="9" rx="1.25" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M2.5 4.25L8 8.5L13.5 4.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="12.5" cy="3.5" r="2.5" fill="currentColor" stroke="var(--color-bg, #000)" stroke-width="0.75"/>'
    + '</svg>';

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

/** The action's payload: how it paints, and what it does. */
const action: SessionCardAction = {
    /**
     * The label names the action, not the state - "clear unread flag"
     * when it is set, "mark unread for followup" when it is not.
     * Inputs: row. Output: string.
     */
    label(row: SessionCardRow): string {
        return row.unread ? 'clear unread flag' : 'mark unread for followup';
    },

    /** The glyph for the row's current state. Inputs: row. Output: string. */
    icon(row: SessionCardRow): string {
        return row.unread ? ENVELOPE_FILLED : ENVELOPE_OUTLINE;
    },

    /**
     * The class list the stylesheets key on. `session-row-menu.css` and
     * `session-sidebar-density.css` both select `.mark-unread-toggle`,
     * and the `--active` modifier is what colours a set flag, so these
     * two strings are load bearing and not decoration.
     * Inputs: row. Output: string.
     */
    className(row: SessionCardRow): string {
        return row.unread
            ? 'mark-unread-toggle mark-unread-toggle--active'
            : 'mark-unread-toggle';
    },

    /**
     * `aria-pressed` exposes the toggled state to assistive tech, which a
     * CSS class alone does not. The two `data-` attributes are the ones
     * the shipped control carries; they are kept so this surface and the
     * launchpad's unmigrated copy paint the identical element.
     * Inputs: row. Output: attribute map.
     */
    attrs(row: SessionCardRow): Readonly<Record<string, string>> {
        const pressed = row.unread ? 'true' : 'false';
        return {
            'aria-pressed': pressed,
            'data-mark-unread': row.name,
            'data-unread-current': pressed,
        };
    },

    /**
     * Toggle the flag server-side, then repaint.
     *
     * Description: the body of the deleted `onMarkUnreadClick`. The next
     *   state is derived from the row the control was painted from, so
     *   the PATCH sends the opposite of what the user is looking at
     *   without re-reading the DOM. The repaint is the caller's, through
     *   `context.refresh()`, because waiting a full poll tick with no
     *   visual feedback feels broken.
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
    // The row menu paints pin, then this, then group, then the
    // destructive control. 10 leaves room either side without
    // renumbering anything when a neighbour arrives.
    order: 10,
    /**
     * Read as `!== false`, so an unknown flag shows the control. See the
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
