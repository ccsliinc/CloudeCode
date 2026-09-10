/**
 * The plugin surface vocabulary: four surfaces, and the payload each one
 * carries.
 *
 * WHAT A PLUGIN IS HERE, AND WHAT IT IS NOT. A plugin is a TypeScript
 * module in this tree, imported by `builtin.ts` and compiled into
 * `client/dist/app.js`. It is BUILD TIME ONLY. There is no loader, no
 * manifest schema, no permissions model, no marketplace and no settings
 * page, and none of those are omissions to be filled in later by
 * accident. The reason is `script-src 'self'`: this app's CSP forbids
 * remote script, inline script and `eval`, so "fetch a plugin and run
 * it" has no implementation in a browser tab, only a CSP relaxation
 * pretending to be one. The owner's framing for the whole migration,
 * verbatim: "lean and mean. kiss."
 *
 * THEMES ARE A SEPARATE, OLDER, WORKING SYSTEM AND ARE NOT THIS. A theme
 * is a JSON manifest under `client/css/themes/<id>/theme.json` (26 of
 * them bundled) or under the user themes directory, scanned server-side
 * by `GET /themes`, with an optional consent-gated `effects.js`. Nothing
 * here duplicates, replaces or wraps that. If a contribution ever needs
 * to recolor something, it belongs in a theme manifest, not on this
 * registry.
 *
 * WHY FOUR AND NOT MORE. These are the four extension points
 * `.claude/notes/svelte-migration-launchpad.md` section 6 named, and the
 * four the launchpad carve is already shaped around. A fifth surface
 * arrives with its first consumer or not at all: a surface with no
 * reader is a guess about a screen nobody has written yet, and this
 * project has paid for that shape before.
 *
 * ONLY ONE OF THE FOUR IS PROVEN. `session-card-action` has a real
 * consumer (the sidebar row overflow menu) and a real contribution (the
 * mark-unread control). The other three carry the SMALLEST payload their
 * eventual consumer plainly needs, and their shape is not settled - the
 * first real consumer settles it, and is expected to change these types
 * rather than work around them.
 */
import type { Component } from 'svelte';

/**
 * The four extension points. A string union, not an enum, so a surface
 * name is the same value in the type system and in the emitted bundle.
 */
export type PluginSurface =
    | 'session-card-action'
    | 'launchpad-panel'
    | 'sidebar-item'
    | 'status-source';

/**
 * What a contribution is allowed to know about the app when it decides
 * whether it applies and when it runs.
 *
 * Description: deliberately two fields. `flags` is the owner's own
 *   show/hide switches, as `client/js/ui-flags.js` caches them from
 *   `GET /api/v1/features`; `refresh` is how an action that changed
 *   server state asks the surface that called it to repaint. A
 *   contribution gets no other ambient access: everything else it needs
 *   arrives as an argument.
 *
 *   FLAGS DEFAULT ON, AND THE ABSENCE OF A KEY MEANS ON. That is not a
 *   convenience, it is `ui-flags.js`'s documented rule carried through
 *   unchanged: a probe that could not run, an older server, an
 *   unparseable config on the server side all leave a control exactly
 *   where the user last saw it. Turning "I could not tell" into "hide
 *   it" is how a capability disappears without anyone deciding to remove
 *   it. Read a flag as `flags[name] !== false`, never as `flags[name]`.
 */
export interface PluginContext {
    /** Feature flags by their config key, e.g. `show_mark_unread_control`. */
    readonly flags: Readonly<Record<string, boolean>>;
    /**
     * Repaint the surface that invoked the action. The caller supplies
     * it, so the sidebar refreshes the sidebar and a future card
     * refreshes the card, with no contribution knowing which it is in.
     */
    refresh(): void | Promise<void>;
}

/**
 * The one session a `session-card-action` acts on.
 *
 * Description: TWO FIELDS, because two fields is what the only consumer
 *   reads. Unread is keyed by tmux NAME server-side (`PATCH
 *   /sessions/{name}/unread`), not by session id, so the name is the
 *   identifier here and not a display string. When a second action needs
 *   `status` or `is_pinned`, it adds the field along with the code that
 *   reads it; a field added ahead of its reader is a field that will be
 *   wrong by the time anyone reads it.
 */
export interface SessionCardRow {
    /** Literal tmux session name. The key every session API call takes. */
    readonly name: string;
    /** The row's current unread flag, as the surface painted it. */
    readonly unread: boolean;
}

/**
 * A control offered on a session row or session card.
 *
 * Description: A MENU ITEM DESCRIPTOR PLUS ONE EFFECT. The only consumer
 *   is the session row action menu (`client/js/session-row-menu.js` and
 *   its `-items` / `-open` / `-actions` halves), and that menu renders
 *   every item ITSELF, as one uniform `<button role="menuitem">` carrying
 *   a label and a shortcut letter. So a contribution supplies the two
 *   things the menu cannot derive - what the item SAYS and which letter
 *   runs it - and nothing about how it is drawn.
 *
 *   THIS SHAPE IS A RE-PORT, AND THE OLD ONE IS WORTH RECORDING. Until
 *   the 1.2.1 rebase this interface carried `icon`, `className` and
 *   `attrs`, because the menu it was written against concatenated raw
 *   HTML from whichever module owned each control. 1.2.1 replaced that
 *   with the declarative table above, and a contribution that still
 *   emitted its own `<span role="button">` with an SVG in it would paint
 *   a control that looks nothing like the other seven items, takes no
 *   part in the menu's arrow-key focus ring, and carries no shortcut -
 *   invisible to `itemIdForKey`. Those three fields were therefore
 *   DELETED rather than left unread. The glyph did not disappear from the
 *   app with them: `client/js/session-status-ui.js::markUnreadHtml` still
 *   draws the inline envelope for the launchpad's own rows, which is a
 *   surface nothing here has migrated.
 *
 *   THE FUNCTION TAKES THE ROW BECAUSE THESE CONTROLS ARE STATEFUL. The
 *   mark-unread item's label flips with `row.unread`; a static label
 *   field would have forced the menu to special-case it immediately.
 * Example:
 *   const a: SessionCardAction = {
 *       shortcut: 'U',
 *       label: (r) => (r.unread ? 'clear unread flag' : 'mark unread'),
 *       run: async (r, ctx) => { await patch(r); await ctx.refresh(); },
 *   };
 */
export interface SessionCardAction {
    /**
     * The single letter that runs this item from the keyboard, uppercase.
     * It is rendered beside the label AND matched by the menu's key
     * handler off the same value, so a letter cannot be shown for one
     * item and bound to another. It must not collide with a letter the
     * native table already uses (R, G, F, N, M, T, C at the time of
     * writing); `SessionRowMenu.uniqueShortcuts()` is what says so out
     * loud over the merged list.
     */
    readonly shortcut: string;
    /** Visible label. States the RESULT of activating it. Never empty. */
    label(row: SessionCardRow): string;
    /** Do the thing. Repaint by awaiting `context.refresh()`. */
    run(row: SessionCardRow, context: PluginContext): void | Promise<void>;
}

/**
 * A panel mounted into the launchpad shell.
 *
 * Description: UNPROVEN. Section 6 promised "one `panels.ts` array of
 *   `{id, component}` in mount order", and the registry already supplies
 *   both id and order, so all that is left is which container the panel
 *   goes in and what to mount there. Every mount still goes through
 *   `mount.ts`; this type does not add a second mount path.
 */
export interface LaunchpadPanel {
    /** The `id` of the element in `client/index.html` to mount into. */
    readonly containerId: string;
    /** The Svelte component. `mountPanel` is what actually mounts it. */
    readonly component: Component;
}

/**
 * A row offered in the session sidebar that is not a session.
 *
 * Description: UNPROVEN, and the thinnest of the four. Section 6 said
 *   nothing about its shape beyond the name, so it carries a label, a
 *   glyph and an effect and nothing else until a real consumer asks for
 *   more.
 */
export interface SidebarItem {
    /** The row's visible text. */
    readonly label: string;
    /** The glyph, as a self-contained `<svg>` string. */
    readonly icon: string;
    /** What activating the row does. */
    run(context: PluginContext): void | Promise<void>;
}

/**
 * An extra opinion about what a session's status light should read.
 *
 * Description: UNPROVEN. Section 6's rule is that every dot renders
 *   through one function (`StatusLed.ledStateFor`), and that choke point
 *   is what this would extend. `resolve` returns null to ABSTAIN, which
 *   is the only safe default: this app's whole status model rests on
 *   "not having looked is not evidence of absence", so a source that
 *   cannot answer must say so rather than return a resting state.
 *   Nothing yet decides how a returned state ranks against the hook,
 *   transcript, seed and tmux tiers, and that ordering - not this type -
 *   is the hard part of the surface.
 */
export interface StatusSource {
    /** A status key for this tmux session, or null to abstain. */
    resolve(tmuxName: string): string | null;
}

/** Map a surface name to the payload a contribution to it carries. */
export interface SurfacePayloads {
    'session-card-action': SessionCardAction;
    'launchpad-panel': LaunchpadPanel;
    'sidebar-item': SidebarItem;
    'status-source': StatusSource;
}

/**
 * One thing a plugin contributes to one surface.
 *
 * Description: `enabled` is what lets a shipped contribution be switched
 *   off without being unregistered. That distinction matters: the
 *   mark-unread control is gated by a config flag the owner can flip at
 *   any time, and a registry that could only express "present" would
 *   have made that flag a build-time decision.
 */
export interface Contribution<K extends PluginSurface = PluginSurface> {
    /**
     * Unique within its surface. On `session-card-action` it travels into
     * the DOM as the row menu's own `data-row-menu-item` - the same
     * attribute every native item carries, because a contribution is
     * rendered as one of them - and back out again to find `run`. So it
     * must be stable across releases, safe in an attribute value, and
     * must not collide with a native item id.
     */
    readonly id: string;
    /** Which surface this contributes to. */
    readonly surface: K;
    /**
     * Sort key, low first. Defaults to 0. Ties break on `id`, so the
     * order is total and does not depend on registration sequence.
     *
     * ON THE `session-card-action` SURFACE THIS IS THE MENU POSITION,
     * shared with the row menu's own native table, which numbers itself
     * 100, 300, 400, 500, 600, 700, 800. The gaps are deliberate: a
     * contribution picks a number in one rather than renumbering
     * anything. There is only this one sort key, not a second one on the
     * payload.
     */
    readonly order?: number;
    /** Whether this applies right now. Called on every render and run. */
    enabled(context: PluginContext): boolean;
    /** The surface-specific half. */
    readonly payload: SurfacePayloads[K];
}

/**
 * A registered plugin: an id and the contributions it makes.
 *
 * Description: one plugin may contribute to several surfaces, which is
 *   why the contributions carry their own surface rather than the plugin
 *   declaring one.
 */
export interface Plugin {
    /** Unique across the whole registry. A second one is refused. */
    readonly id: string;
    /** What it contributes. May be empty, which registers nothing. */
    readonly contributions: readonly Contribution[];
}
