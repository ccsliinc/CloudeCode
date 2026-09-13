/**
 * The plugin surface vocabulary: five surfaces, and the payload each one
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
 * WHY FIVE. The first four are the extension points
 * `.claude/notes/svelte-migration-launchpad.md` section 6 named, and the
 * four the launchpad carve is already shaped around. The bar this file
 * set for a fifth was "arrives with its first consumer or not at all: a
 * surface with no reader is a guess about a screen nobody has written
 * yet, and this project has paid for that shape before."
 *
 * `app-screen` CLEARED THAT BAR BEFORE IT WAS ADDED. Its first consumer
 * is the history browser, whose routing it is built from rather than
 * built for: `client/js/archive-deeplink.js` already owned inbound
 * parsing, outbound building, the ordered pattern list and the
 * three-way answer, and `client/js/router.js` already delegated to it.
 * The surface is the EXTRACTION of a shape that was working, which is
 * why it arrives with its hardest part already measured.
 *
 * TWO OF THE FIVE ARE PROVEN. `session-card-action` has a real
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
    | 'status-source'
    | 'app-screen';

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
 *       label: (r) => (r.unread ? 'clear unread' : 'mark unread'),
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

/**
 * What a screen's `parse` may answer. THREE OUTCOMES, NEVER TWO.
 *
 * Description: `no-match` means this is not our path at all and the host
 *   should keep looking. `cannot-determine` means it IS our path and it
 *   is malformed, which must produce a visible, specific error naming
 *   the offending segment. A silent redirect to the prefix root tells
 *   the sender their link was fine and shows the recipient something
 *   else. `client/js/archive-deeplink.js` measured why: `session_ref`
 *   "journal" belongs to fourteen different transcripts.
 */
export type ScreenRouteResult<Route> =
    | { readonly ok: true; readonly route: Route }
    | { readonly ok: false; readonly token: 'no-match'; readonly reason?: string }
    | { readonly ok: false; readonly token: 'cannot-determine';
        readonly reason: string };

/**
 * The one way a screen talks to the server: a fetch scoped to the
 * prefixes its contribution declared.
 *
 * Description: THE CAPABILITY, NOT A CLIENT. The host builds this from
 *   the contribution's own `apiPrefixes` and hands it to `mount`. A
 *   plugin never sees `window.API` and never sees `fetch`, so the set of
 *   routes it can reach is the set it declared, printed on its card and
 *   readable in one line of its own source.
 *
 *   IT IS HANDED TO `mount` AND NOT PUT ON `PluginContext`, WHICH IS A
 *   DEVIATION FROM THE SCOPE AND IS DELIBERATE. `PluginContext` is
 *   shared with four other surfaces, none of which declares a grant. A
 *   granted client on the shared context would either hand those four an
 *   UNGRANTED one, which is the unbounded access this design exists to
 *   refuse, or hand them one granted nothing, which is a field that
 *   throws for four surfaces out of five. A capability belongs to the
 *   contribution it was granted to, so it arrives with control.
 *
 *   A REFUSAL IS NEVER A 404. `call` rejects with a `GrantRefusedError`
 *   before any request leaves the browser. A 404 is a resolved response
 *   carrying a status; the two are structurally different rather than
 *   differently worded, so a caller that only catches can still tell
 *   them apart. See `screen-api.ts`.
 */
/**
 * What one call through the granted client resolves to.
 *
 * Description: THE ENVELOPE SHAPE, AND IT IS THE ONE THE WHOLE ARCHIVE
 *   READ SURFACE SPEAKS. Every archive route answers a COMPLETE,
 *   renderable envelope on a non-2xx as well as on a 200: measured on
 *   the live server, `GET /archive/transcripts/99999` is HTTP 404
 *   carrying `result_status: 'not_found'` and the row that explains it.
 *   Those are findings a person has to read, not errors, so the shape
 *   carries the status beside the body rather than throwing the body
 *   away on the way to a rejection.
 *
 *   IT NEVER ARRIVES AS A REJECTION. A network failure, a body that is
 *   not JSON and a deadline expiry all RESOLVE, with `envelope` null and
 *   `transportError` naming what happened, because "the server did not
 *   answer" is a finding a screen must render and a rejected promise is
 *   how a finding becomes an unhandled console line nobody sees.
 *
 *   `refusedByGrant` IS THE ONE THING NO HTTP ANSWER CAN PRODUCE. A
 *   capability refusal never reaches the network, so it has no status
 *   and no headers - but a null `httpStatus` alone is also what a dead
 *   network produces, and the two are not the same problem. The flag
 *   says which, positively, so nobody has to infer a security refusal
 *   from an absent number or parse it out of a message string.
 * Example:
 *   const r = await client.getArchiveTranscript(99999);
 *   // r.httpStatus === 404, r.envelope.result_status === 'not_found'
 */
export interface EnvelopeResult {
    /** The parsed body, or null when there was none to parse. */
    readonly envelope: unknown;
    /** The HTTP status, or null when no HTTP answer was received. */
    readonly httpStatus: number | null;
    /** The response headers, or null. Read by the export preflight. */
    readonly headers: { get(name: string): string | null } | null;
    /** Why there is no envelope, or null when the server answered. */
    readonly transportError: string | null;
    /**
     * True only when the granted client refused the path. Never true for
     * anything the server said, including a 404.
     */
    readonly refusedByGrant: boolean;
}

export interface ScreenApi {
    /**
     * Call one path under `/api/v1`, e.g. '/archive/projects'.
     * Inputs: path - relative to `/api/v1`, leading slash. init - passed
     *   to the underlying client unchanged.
     * Output: Promise of whatever the host's client resolves to.
     *   REJECTS with a `GrantRefusedError` when the path, after
     *   normalisation, is outside the grant.
     */
    call(path: string, init?: Record<string, unknown>): Promise<unknown>;
    /**
     * The prefixes this client actually holds, for a refusal to name and
     * for a catalog card to print. A copy; mutating it grants nothing.
     */
    readonly grants: readonly string[];
}

/**
 * A whole screen with its own URL namespace, mounted into the shell.
 *
 * Description: THE THIRD KIND OF THING A PLUGIN CAN BE. A
 *   `session-card-action` is a control, a `launchpad-panel` is a
 *   component in somebody else's screen, and this is a screen. It owns
 *   one path prefix, both directions of the URL for everything under
 *   it, and one container element.
 *
 *   BOTH DIRECTIONS, DELIBERATELY. `parse` reads the address bar and
 *   `buildPath` writes it. A feature that owned only the inbound half
 *   would leave the outbound half somewhere else, and the two would
 *   drift: the screen would show one thing and the address bar another,
 *   which is the failure `archive-screen.js` and `router.js` split
 *   between them before this surface existed and had to coordinate by
 *   hand.
 */
export interface AppScreen<Route = unknown> {
    /**
     * The single leading path segment this screen owns, with no
     * slashes, e.g. 'archive'. Unique across the registry: a second
     * contribution claiming a taken prefix is refused the same way a
     * duplicate contribution id is, whole-plugin, and for the same
     * reason.
     *
     * MATCHED COMPONENT-WISE AND NEVER BY `startsWith`. A prefix of
     * 'archive' owns `/archive` and `/archive/...` and does NOT own
     * `/archived-thing`, for the same reason `project_directory.py`
     * gives: `/Users/jsugamelevil` must not read as living under
     * `/Users/jsugamele`.
     */
    readonly routePrefix: string;
    /** The id of the container element in `client/index.html`. */
    readonly screenId: string;
    /** Label for whatever control opens it. Never empty. */
    readonly title: string;
    /**
     * Read the address bar.
     *
     * Description: `search` is the raw query string. A screen that reads
     *   it MUST allowlist rather than denylist: a parameter invented
     *   later is then dropped by default instead of published by
     *   default. The archive's own allowlist is what keeps an opaque
     *   resume cursor out of a shared link.
     *
     *   IT MAY NOT THROW, AND THE HOST DOES NOT TRUST THAT IT WILL NOT.
     *   A screen whose `parse` throws is skipped with a logged refusal
     *   and navigation continues for every other screen. See
     *   `screens.ts`.
     * Inputs: path - the pathname. search - the raw query string.
     * Output: ScreenRouteResult<Route>.
     */
    parse(path: string, search: string): ScreenRouteResult<Route>;
    /**
     * Write the address bar. The inverse of a successful `parse`.
     * Output: the path, or null when the route cannot be built. NEVER a
     *   fallback path: handing back the prefix root for an unbuildable
     *   route is the silent redirect `parse` refuses, moved to the other
     *   end.
     */
    buildPath(route: Route): string | null;
    /**
     * Put the screen in its container. Called at most once per page
     * life, with the granted client for this contribution.
     * Inputs: container - the element `screenId` resolved to. route -
     *   the first route parsed for this screen. context - flags and
     *   repaint. api - the capability built from `apiPrefixes`.
     */
    mount(container: Element, route: Route, context: PluginContext,
          api: ScreenApi): void;
    /**
     * A route change WITHIN this screen while it is already mounted.
     * Separate from `mount` because a deep link to a line number must
     * not remount the reader and lose its position.
     */
    show(route: Route): void;
    /** The screen is being left. It stays mounted; the host hides it. */
    hide(): void;
    /**
     * API path prefixes under `/api/v1` this screen is granted, e.g.
     * ['/archive', '/features']. An empty array is a screen that talks
     * to no server. The host enforces it; declaring it is not the same
     * as being trusted with it.
     */
    readonly apiPrefixes: readonly string[];
}

/** Map a surface name to the payload a contribution to it carries. */
export interface SurfacePayloads {
    'session-card-action': SessionCardAction;
    'launchpad-panel': LaunchpadPanel;
    'sidebar-item': SidebarItem;
    'status-source': StatusSource;
    'app-screen': AppScreen;
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
