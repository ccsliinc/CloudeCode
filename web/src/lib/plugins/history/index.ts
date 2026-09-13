/**
 * The history browser plugin. THIS FILE IS ITS ENTIRE PUBLIC SHAPE.
 *
 * WHAT THE APP MAY RELY ON, AND NOTHING ELSE: the plugin id, the
 * contributions, the `routePrefix` and the `apiPrefixes`. Everything
 * else under `web/src/lib/plugins/history/` is private to this module.
 * The moment something outside imports `history/route` or
 * `history/crumb`, the boundary is gone and nobody notices until the
 * next port. `import-direction.test.ts` is what says so out loud, and it
 * was written in this slice precisely because during a rewrite it is
 * nearly free and afterwards it is near impossible - by then there are
 * violations, and each one is an argument.
 *
 * THE ARROW POINTS OUTWARD ONLY. This module may depend on the host's
 * published seams - `../types`, `../registry`, `../screen-api`. The host
 * may depend only on the `Plugin` object below. It may not import from
 * `launchpad/`, `sessions/` or `terminal-search/`, because a feature
 * that reaches sideways into another feature is not extractable, and
 * section 10 of the scope wants this directory to be liftable some day.
 *
 * THE HOST IS INJECTED, NOT REACHED FOR. `createHistoryPlugin` takes the
 * shell host and the transport. `historyPlugin` below is the one the
 * bundle ships, built against the browser. A test builds its own with a
 * double and never touches `window`, which is item 3 of the scope's
 * "free now" list: no new host globals inside a ported component.
 */
import { createHistoryScreen, type HistoryScreen, type ScreenShellHost,
         LABEL } from './screen';
import { API_PREFIXES } from './screen';
import { createScreenApi, type ApiTransport } from '../screen-api';
import { createArchiveClient, type ArchiveClient } from './client';
import type { Plugin } from '../types';

/** The plugin id. Unique across the registry; a second one is refused. */
export const HISTORY_PLUGIN_ID = 'history-browser';

/** The `app-screen` contribution id. Travels into every log line. */
export const HISTORY_SCREEN_ID = 'history-screen';

/** A built plugin and the screen behind it, so a caller can reach both. */
export interface HistoryPlugin {
    /** What `register()` takes. The only thing the host may depend on. */
    readonly plugin: Plugin;
    /** The entry points and the availability gate, for the legacy tree. */
    readonly screen: HistoryScreen;
    /**
     * THE ARCHIVE READ SURFACE, built on the SAME granted client the
     * screen holds. It is published because the twenty-five legacy call
     * sites in slices 3 and 5 to 9 still reach it through
     * `API.prototype`; `archive-api-install.ts` is what puts it there
     * and is the only thing outside this module that may take it. Those
     * slices delete their own call sites, and the last one deletes this
     * line.
     */
    readonly client: ArchiveClient;
}

/**
 * Build the history browser plugin against a host.
 *
 * Description: the granted client handed to the screen here is built
 *   from the SAME `API_PREFIXES` the contribution declares, so the
 *   client the availability probe uses before any mount and the client
 *   the host builds at mount time hold identical grants. There is no
 *   moment at which this module holds a wider capability than its
 *   contribution printed.
 * Inputs: host - the running app. transport - what makes a call once the
 *   grant passes.
 * Output: HistoryPlugin.
 * Example: const { plugin, screen } = createHistoryPlugin(host, call);
 *          register(plugin);
 */
export function createHistoryPlugin(
    host: ScreenShellHost, transport: ApiTransport,
): HistoryPlugin {
    const api = createScreenApi(API_PREFIXES, transport, HISTORY_SCREEN_ID);
    const screen = createHistoryScreen(host, api);
    // ONE GRANTED CLIENT, TWO READERS. The availability probe and the
    // thirteen archive endpoints hold the SAME `api`, so there is no
    // moment at which one half of this module can reach a path the
    // other's grant does not cover, and the contribution's declared
    // `apiPrefixes` is the whole of what either can do.
    const client = createArchiveClient(api);
    const plugin: Plugin = {
        id: HISTORY_PLUGIN_ID,
        contributions: [{
            id: HISTORY_SCREEN_ID,
            surface: 'app-screen',
            /**
             * ALWAYS TRUE, AND THAT IS NOT THE AVAILABILITY GATE. This
             * answers "does this contribution apply", which for a screen
             * with a URL namespace is always yes: a deep link to
             * /archive on a server with the archive switched off must
             * still reach THIS screen, so that it can say the archive is
             * off. Returning false here would make the path fall through
             * to the launcher, which is the silent redirect the whole
             * route design refuses. Whether the feature is switched ON is
             * a three-state MEASUREMENT and lives in
             * `./availability.ts`; see its header for why it cannot be a
             * flag.
             */
            enabled: () => true,
            payload: screen.payload,
        }],
    };
    return { plugin, screen, client };
}

/**
 * THE CRUMB RENDERER, RE-EXPORTED BECAUSE THE SCREEN BODY IS STILL
 * LEGACY. `client/js/archive-screen.js` paints the breadcrumb and is
 * slice 3, so until then it needs this function. It comes out through
 * THIS file rather than by letting anything import `history/route`
 * directly, which is the boundary `import-direction.test.ts` pins: the
 * public shape may GROW an export, and nothing outside may reach past
 * it. Slice 3 deletes this line along with the caller.
 */
export { renderCrumb } from './crumb-render';
export { CRUMB_ROOT_LABEL } from './route';
export { LABEL, API_PREFIXES };
export { createArchiveClient };
export type { ArchiveClient };
export type { HistoryScreen, ScreenShellHost };
export type { ArchiveRoute } from './route';
