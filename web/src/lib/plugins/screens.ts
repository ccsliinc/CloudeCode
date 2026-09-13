/**
 * The `app-screen` surface, as the router uses it: walk the registered
 * screens for a path, and drive one screen's mount / show / hide.
 *
 * WHAT THIS REPLACED. `client/js/router.js` hardcoded `ARCHIVE_PREFIX`,
 * a `parseArchivePath` that delegated to one named global, and a
 * `deliverArchiveRoute` helper. That worked, and it could only ever work
 * for one screen. This holds a list. The risk in trading a hardcoded
 * branch for a generic walk is that a bug in the walk breaks a route the
 * branch could not, which is why the ported deeplink suites run against
 * THIS walk and not only against the parser underneath it.
 *
 * A THROWING SCREEN IS CONTAINED, AND IT DEGRADES TO `no-match` RATHER
 * THAN TO `cannot-determine`. That choice is the whole of the
 * containment. `cannot-determine` STOPS the walk, by design, so that a
 * malformed path belonging to a known prefix cannot fall through to some
 * other screen that happens to accept it. A throw mapped onto that token
 * would therefore take navigation down for every screen after the bad
 * one, wearing a mask that reads correct in the log. Mapping it to
 * `no-match` - the "keep looking" answer - is the only mapping that
 * actually contains it.
 *
 * A MALFORMED ANSWER IS THE SAME FAULT AS A THROW. A screen that returns
 * undefined, a non-object, or an `ok: false` carrying a token this host
 * does not know is not obeying the contract any more than one that
 * threw. It gets the identical treatment: named refusal, logged, treated
 * as `no-match`. The host validates the shape rather than trusting it,
 * because a plugin is exactly the code the host did not write.
 *
 * THE PREFIX IS MATCHED BY THE HOST, COMPONENT-WISE, BEFORE `parse` IS
 * CALLED. `routePrefix` is declared as one leading segment, so the
 * registry can own the match and a screen never sees a path outside its
 * own namespace. That makes the duplicate-prefix refusal mean something,
 * keeps a buggy screen's blast radius inside its own prefix, and stops
 * `/archived-thing` reaching the screen that owns `/archive`. The
 * screen's own `parse` still answers `no-match` for a foreign path - the
 * ported archive parser does exactly that and its suite asserts it - so
 * this is a second guard, not a replacement for the first.
 */
import { surfacesOf } from './registry';
import { createScreenApi, type ApiTransport } from './screen-api';
import type { AppScreen, Contribution, PluginContext, ScreenRouteResult } from './types';

/** The outcome of walking every registered screen for one path. */
export type ScreenWalkResult =
    /** One screen claimed it. `route` is that screen's own route object. */
    | { readonly ok: true; readonly contribution: Contribution<'app-screen'>;
        readonly route: unknown }
    /** The path belongs to a known prefix and is malformed. STOPS the walk. */
    | { readonly ok: false; readonly token: 'cannot-determine';
        readonly contribution: Contribution<'app-screen'>; readonly reason: string }
    /** No registered screen owns this path. The caller keeps looking. */
    | { readonly ok: false; readonly token: 'no-match'; readonly reason: string };

/** The leading segment of a path, or '' when there is none. */
function firstSegment(path: string): string {
    const segs = (typeof path === 'string' ? path : '').split('/').filter((s) => s !== '');
    return segs.length > 0 ? (segs[0] as string) : '';
}

/**
 * Does this screen own this path, by whole leading segment?
 *
 * Description: exact segment equality, never `startsWith`, so a prefix
 *   of 'archive' owns `/archive` and `/archive/t/5` and does NOT own
 *   `/archived-thing`.
 * Inputs: screen, path. Output: boolean.
 * Example: ownsPath({routePrefix: 'archive'}, '/archived-thing') // false
 */
export function ownsPath(screen: AppScreen, path: string): boolean {
    const prefix = String(screen?.routePrefix ?? '');
    if (prefix === '') return false;
    return firstSegment(path) === prefix;
}

/**
 * Is this a result shape the contract allows?
 *
 * Description: the host does not trust a plugin's return value. Anything
 *   that is not one of the three documented shapes is a contract
 *   violation and is handled as one.
 * Inputs: r - whatever `parse` returned. Output: boolean.
 */
function isWellFormed(r: unknown): r is ScreenRouteResult<unknown> {
    if (!r || typeof r !== 'object') return false;
    const v = r as Record<string, unknown>;
    if (v.ok === true) return 'route' in v;
    if (v.ok !== false) return false;
    if (v.token === 'no-match') return true;
    return v.token === 'cannot-determine' && typeof v.reason === 'string';
}

/**
 * Ask every registered, enabled screen whether it owns this path.
 *
 * Description: walks in registry order (the total order `surfacesOf`
 *   already imposes), calls `parse` only on a screen whose prefix
 *   matches, and returns the FIRST `ok`. A `cannot-determine` stops the
 *   walk and is returned with its reason and the screen that raised it.
 *   A screen that throws or answers off-contract is skipped with a
 *   logged refusal and the walk continues.
 * Inputs: path - the pathname. search - the raw query string.
 *         context - consulted through each contribution's `enabled`.
 * Output: ScreenWalkResult.
 * Example:
 *   walkScreens('/archive/t/5767', '', ctx)
 *   // -> {ok: true, contribution: history, route: {view: 'line', ...}}
 */
export function walkScreens(
    path: string,
    search: string,
    context: PluginContext,
): ScreenWalkResult {
    for (const contribution of surfacesOf('app-screen')) {
        const screen = contribution.payload;
        let applies = false;
        try {
            applies = contribution.enabled(context) && ownsPath(screen, path);
        } catch (err) {
            console.error(
                `[plugins] screen "${contribution.id}" threw from enabled(); `
                + 'it is skipped and navigation continues', err);
            continue;
        }
        if (!applies) continue;

        let answer: unknown;
        try {
            answer = screen.parse(path, search);
        } catch (err) {
            // CONTAINED, AND DEGRADED TO "KEEP LOOKING". See the header:
            // treating this as cannot-determine would stop the walk and
            // take navigation down for every screen behind this one.
            console.error(
                `[plugins] screen "${contribution.id}" threw from parse("${path}"); `
                + 'it is skipped and navigation continues for every other screen',
                err);
            continue;
        }
        if (!isWellFormed(answer)) {
            console.error(
                `[plugins] screen "${contribution.id}" answered off-contract for `
                + `"${path}"; it is skipped and navigation continues`, answer);
            continue;
        }
        if (answer.ok) {
            return { ok: true, contribution, route: answer.route };
        }
        if (answer.token === 'cannot-determine') {
            return { ok: false, token: 'cannot-determine', contribution,
                     reason: answer.reason };
        }
        // `no-match` from a screen whose prefix DID match: it disagrees
        // with the registry about its own namespace. Rare and legal;
        // keep walking.
    }
    return { ok: false, token: 'no-match',
             reason: `no registered screen owns "${path}"` };
}

/** What is remembered about a screen the host has already mounted. */
interface MountedScreen {
    /** The element it was mounted into, so a replaced container is caught. */
    container: Element;
    /** The payload, so `show` and `hide` reach the same object. */
    screen: AppScreen;
}

/** Mounted screens, keyed by contribution id. */
const mounted = new Map<string, MountedScreen>();

/** Which screen is currently visible, or null. Exactly one, or none. */
let visible: string | null = null;

/**
 * How this host actually reaches the document and the network.
 *
 * Description: injected rather than read off globals so a test drives
 *   the whole lifecycle without a browser and without a `window` stub
 *   that would have to be kept honest by hand.
 */
export interface ScreenHost {
    /** Resolve a container by id. Returns null when it is not present. */
    getElement(id: string): Element | null;
    /** Make a granted call. Wrapped per screen by `createScreenApi`. */
    transport: ApiTransport;
}

/**
 * Deliver a parsed route to its screen: mount it the first time, show it
 * every time after that, and hide whatever was visible before.
 *
 * Description: THE LIFECYCLE, AND `hide` IS NOT `unmount`. Unmounting on
 *   leave would throw away the reader's scroll position, the rail's
 *   loaded state and the transcript list's filter, all of which the user
 *   expects back. The screen element is hidden the way every other
 *   screen in this app is hidden, and the mount is kept.
 *
 *   A MISSING CONTAINER IS A WARNED NO-OP, NOT A THROW. That is
 *   `mount.ts`'s rule, unchanged: a container that has not been written
 *   yet is a normal early-boot state, and a silent return would make a
 *   mis-spelled `screenId` look like a screen that chose to render
 *   nothing.
 *
 *   A MOUNT THAT THROWS LEAVES NOTHING RECORDED. The record is written
 *   only after `mount` returns, so a screen whose setup raised is not
 *   remembered as mounted - it gets a fresh `mount` next time rather
 *   than a `show` against a half-built object.
 * Inputs: contribution - from `walkScreens`. route - its route object.
 *         context - flags and repaint. host - document and network.
 * Output: boolean - true when the screen is on screen.
 * Example: deliverRoute(result.contribution, result.route, ctx, host)
 */
export function deliverRoute(
    contribution: Contribution<'app-screen'>,
    route: unknown,
    context: PluginContext,
    host: ScreenHost,
): boolean {
    const screen = contribution.payload;
    const id = contribution.id;
    const container = host.getElement(screen.screenId);
    if (!container) {
        console.warn(
            `[plugins] screen "${id}" has no element with id `
            + `"${screen.screenId}"; nothing was shown`);
        return false;
    }

    if (visible !== null && visible !== id) hideScreen(visible);

    const held = mounted.get(id);
    // THE TEST IS THE ELEMENT, NOT THE ID. A legacy parent can replace a
    // container wholesale; the recorded mount then points at detached
    // nodes and the screen is invisible while still holding live state.
    // Same rule `mount.ts::ensurePanel` already applies, for the same
    // reason.
    if (held && held.container === container) {
        try {
            screen.show(route);
        } catch (err) {
            console.error(`[plugins] screen "${id}" threw from show()`, err);
            return false;
        }
        visible = id;
        return true;
    }

    const api = createScreenApi(screen.apiPrefixes ?? [], host.transport, id);
    try {
        screen.mount(container, route, context, api);
    } catch (err) {
        console.error(`[plugins] screen "${id}" threw from mount()`, err);
        return false;
    }
    mounted.set(id, { container, screen });
    visible = id;
    return true;
}

/**
 * Hide one mounted screen, keeping its mount.
 * Inputs: id - the contribution id. Output: boolean - true when it was
 *   mounted and `hide` was called.
 */
export function hideScreen(id: string): boolean {
    const held = mounted.get(id);
    if (!held) return false;
    try {
        held.screen.hide();
    } catch (err) {
        console.error(`[plugins] screen "${id}" threw from hide()`, err);
    }
    if (visible === id) visible = null;
    return true;
}

/**
 * Hide whichever screen is currently visible, if any.
 *
 * Description: what a host calls when it is about to show a screen this
 *   registry does not own - the launcher, a session terminal. Without
 *   it, leaving a plugin screen by a route the plugin never sees would
 *   leave that screen believing it is still on display.
 * Inputs: none. Output: the id hidden, or null.
 */
export function hideVisibleScreen(): string | null {
    if (visible === null) return null;
    const id = visible;
    hideScreen(id);
    return id;
}

/**
 * The screen currently on display, or null.
 * Inputs: none. Output: string | null.
 */
export function visibleScreen(): string | null {
    return visible;
}

/**
 * Forget every mount. FOR TESTS, and named so it reads as one.
 *
 * Description: the module holds process-wide state on purpose - there is
 *   one document - so a test that mounts needs a way back to the
 *   starting position. It calls no `hide`: a test that wants the hide
 *   observed calls it itself, and a reset that fired lifecycle callbacks
 *   would make the state it is clearing observable from the thing it is
 *   clearing it for.
 * Inputs: none. Output: void.
 */
export function resetMountedScreens(): void {
    mounted.clear();
    visible = null;
}
