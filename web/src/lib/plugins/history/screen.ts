/**
 * The history browser as an `app-screen`: the payload, and the way in
 * and out. PORTED from `client/js/archive-entry.js`'s navigation half,
 * deleted in the same commit.
 *
 * WHAT `mount` DOES IN THIS SLICE, SAID PLAINLY SO THE NEXT READER IS
 * NOT SURPRISED. The screen's BODY - the rail, the transcript list, the
 * reader, the chat view - is still `client/js/archive-screen.js` and its
 * family, and that is slice 3. So `mount` and `show` hand the route to
 * the legacy screen controller, and `hide` takes the container off
 * screen. The CONTRACT is complete and exercised; only the thing behind
 * `mount` is legacy, and slice 3 replaces the body of these three
 * functions with a Svelte mount without the host learning anything.
 *
 * THAT IS NOT A DUAL PATH, AND THE DISTINCTION MATTERS BECAUSE THE RULE
 * IS NOT NEGOTIABLE. A dual path is two implementations of one
 * behaviour, which drift. There is ONE implementation of archive routing
 * and it is this module; the legacy screen controller it calls is a
 * DIFFERENT behaviour - painting a screen - that this slice does not
 * own and does not duplicate.
 *
 * ONE IMPLEMENTATION, EVERY ENTRY POINT. The header button, the deep
 * dive from the terminal search panel, the router's inbound walk and the
 * title-click exit all reach this module. Two copies of a navigation is
 * two copies that can drift - one gains a guard, or a route parameter,
 * or a different history mode, and from then on the doors lead to subtly
 * different places with nothing to say so.
 *
 * WHY pushState AND THEN show, IN THAT ORDER. The screen controller
 * activates the screen but does not write the address bar. The router
 * refuses to clobber the URL once the path already reads `/archive`, so
 * writing it first and showing second is what keeps that guard from
 * racing this navigation.
 *
 * A FAILED pushState IS NOT A FAILED NAVIGATION. The History API throws
 * in a sandboxed iframe; the router already swallows exactly this and
 * carries on, and so does this. The screen still opens; only the address
 * bar is wrong, which is a strictly smaller problem than not opening.
 */
import { build, parse, ARCHIVE_PREFIX, ARCHIVE_ROUTE_PREFIX,
         type ArchiveRoute } from './route';
import { createAvailability, STATE_DISABLED, STATE_ENABLED,
         type ArchiveState, type Availability } from './availability';
import { createResolver, type CrumbResolver } from './crumb-resolve';
import { createTracker, type CrumbTracker } from './crumb';
import type { AppScreen, PluginContext, ScreenApi } from '../types';

/** The id of the container in `client/index.html`. */
export const SCREEN_ID = 'archive-screen';

/** Label used by every entry point, so they cannot disagree. */
export const LABEL = 'message archive';

/**
 * One line about what the archive is. It says READ-ONLY out loud because
 * that is the single most useful thing to know before clicking into a
 * browser over twenty thousand transcripts.
 */
export const DESCRIPTION =
    'browse ingested transcripts by host, project and line. read-only.';

/**
 * The routes this screen is granted, under `/api/v1`.
 *
 * `/archive` is the whole browse, read, search and export surface.
 * `/features` is the availability switch, which is NOT under `/archive`
 * because the server mounts it whether the archive is on or off - that
 * is the entire reason "off" is distinguishable from "broken", so the
 * grant has to cover a route outside the feature's own namespace. Two
 * entries, both printable on a card, neither of them a wildcard.
 */
export const API_PREFIXES: readonly string[] = ['/archive', '/features'];

/** What the screen needs from the running app. Injected, never global. */
export interface ScreenShellHost {
    /** Hand a route to the screen body. Slice 3 replaces this. */
    showScreen(route: ArchiveRoute): boolean;
    /** Leave the archive for the launcher. */
    showLauncher(): boolean;
    /** Write the address bar. Returns false when the History API refused. */
    pushPath(path: string): boolean;
    /** The current pathname, to avoid writing a path already current. */
    currentPath(): string;
    /** Put the container on screen, or take it off. */
    setVisible(container: Element, visible: boolean): void;
}

/** Everything the plugin publishes for the legacy tree to reach. */
export interface HistoryScreen {
    /** The `app-screen` payload itself. */
    readonly payload: AppScreen<ArchiveRoute>;
    /** Measure the availability switch. */
    ensure(): Promise<ArchiveState>;
    /** The last measured availability state. */
    state(): ArchiveState;
    /** Why it is in that state. */
    reason(): string;
    /** Run `fn` once availability resolves. */
    onResolved(fn: (state: ArchiveState) => void): void;
    /** Go to the archive root. Output: true when the screen was shown. */
    open(): boolean;
    /** Go to one route inside the archive. */
    openRoute(route: Partial<ArchiveRoute>): boolean;
    /** Leave the archive for the launcher. */
    close(): boolean;
    /** The crumb tracker, for the legacy screen body. Created once. */
    tracker(): CrumbTracker;
    /** The project-name resolver, for the legacy screen body, or null. */
    resolver(): CrumbResolver | null;
}

/**
 * Build the history screen against a host and a granted client.
 *
 * Description: A FACTORY, NOT A SINGLETON, for the reason `registry.ts`
 *   gives for its own: a test gets isolation without a `reset()` that
 *   would exist for nobody else, and the client it holds is the one the
 *   host granted rather than whatever is on `window` at the time.
 *
 *   THE GRANTED CLIENT ARRIVES LATE, AND THAT IS WHY `api` IS SETTABLE.
 *   `mount` is where the host hands it over, and the availability probe
 *   has to run BEFORE any mount - the header button asks whether to draw
 *   itself at all. So the screen is built with a client and `mount` may
 *   replace it with the one the host built for that mount; both are
 *   granted the same prefixes by construction, because both come from
 *   `API_PREFIXES`.
 * Inputs: host - the running app. api - the granted client.
 * Output: HistoryScreen.
 * Example: const s = createHistoryScreen(browserHost(), api); s.open();
 */
export function createHistoryScreen(host: ScreenShellHost, api: ScreenApi): HistoryScreen {
    let client: ScreenApi = api;
    let gate: Availability = createAvailability(client);
    let crumbTracker: CrumbTracker | null = null;
    let crumbResolver: CrumbResolver | null = null;
    let container: Element | null = null;

    /** Write the address bar for a route, tolerating a refusal. */
    function syncPath(route: Partial<ArchiveRoute>): void {
        const path = build(route);
        if (!path) return;
        if (host.currentPath() === path) return;
        host.pushPath(path);
    }

    function openRoute(route: Partial<ArchiveRoute>): boolean {
        if (gate.state() === STATE_DISABLED) {
            // A DEFINITE no. Every door is hidden when this is the
            // state, so reaching here means something called open()
            // anyway - a stale handler, a console call, a future caller.
            // Refusing is cheap and the alternative is a screen whose
            // every request 404s. UNKNOWN deliberately does NOT refuse:
            // nothing was measured, and turning "I could not tell" into
            // a refusal is the same false verdict in the other
            // direction.
            console.warn('[history] the message archive is switched off on '
                         + 'this server: ' + gate.reason());
            return false;
        }
        syncPath(route);
        return host.showScreen(normalise(route));
    }

    function open(): boolean {
        return openRoute({ view: 'root', query: {} });
    }

    /**
     * Leave the archive for the launcher.
     *
     * Description: THE URL IS WRITTEN HERE AND NOT LEFT TO THE LAUNCHER.
     *   The launcher's own reset REFUSES to touch the address bar while
     *   the path starts with `/archive` - a guard that exists so a cold
     *   load of /archive/t/5767 is not rewritten to `/` before anything
     *   parses it. Correct for that job, and it means a bare
     *   showLauncher() from the archive leaves `/archive` in the address
     *   bar with the launcher on screen; the next refresh silently lands
     *   the user back in the archive they just left. So the exit writes
     *   `/` for the same reason `open` writes `/archive`.
     *
     *   pushState, NOT history.back(). Back would return the user to
     *   whatever preceded the archive, which is nicer when they arrived
     *   by clicking and wrong when they arrived by typing the URL, where
     *   there is no such entry and Back leaves the app entirely. A
     *   deterministic push to `/` never strands anyone; the archive
     *   stays one Back press away either way.
     */
    function close(): boolean {
        if (host.currentPath() !== '/') host.pushPath('/');
        return host.showLauncher();
    }

    /** Fill in the fields a partial route left out. */
    function normalise(route: Partial<ArchiveRoute>): ArchiveRoute {
        return {
            view: route.view ?? 'root',
            projectId: route.projectId ?? null,
            transcriptId: route.transcriptId ?? null,
            lineNo: route.lineNo ?? null,
            query: route.query ?? {},
        };
    }

    const payload: AppScreen<ArchiveRoute> = {
        routePrefix: ARCHIVE_ROUTE_PREFIX,
        screenId: SCREEN_ID,
        title: LABEL,
        apiPrefixes: API_PREFIXES,
        parse,
        buildPath: (route) => build(route),
        mount(el, route, _context: PluginContext, granted) {
            container = el;
            // The host built this from THIS contribution's own
            // apiPrefixes. Adopting it rather than keeping the one the
            // factory was given is what makes the grant the host's
            // decision rather than this module's.
            client = granted;
            gate = createAvailability(client);
            crumbResolver = createResolver(client);
            host.setVisible(el, true);
            host.showScreen(normalise(route));
        },
        show(route) {
            if (container) host.setVisible(container, true);
            host.showScreen(normalise(route));
        },
        hide() {
            if (container) host.setVisible(container, false);
        },
    };

    return {
        payload,
        ensure: () => gate.ensure(),
        state: () => gate.state(),
        reason: () => gate.reason(),
        onResolved: (fn) => gate.onResolved(fn),
        open,
        openRoute,
        close,
        tracker: () => {
            if (!crumbTracker) crumbTracker = createTracker();
            return crumbTracker;
        },
        resolver: () => {
            if (!crumbResolver) crumbResolver = createResolver(client);
            return crumbResolver;
        },
    };
}

export { ARCHIVE_PREFIX, STATE_ENABLED };
