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

/**
 * SLICE 4'S PUBLIC SHAPE, FOR THE SEAM AND FOR NOBODY ELSE. State, the
 * key map, the help modal and the formatters are ported, and eight
 * modules belonging to slices 3 and 5 to 9 still reach them as
 * `window.ArchiveState` / `ArchiveKeys` / `ArchiveKeysHelp` /
 * `ArchiveFormat`. `../archive-state-install.ts` is the ONE thing
 * outside this directory allowed to take them, and it publishes those
 * names. Everything comes out through THIS file rather than by letting
 * anything import `history/state` directly, which is the boundary
 * `import-direction.test.ts` pins: the public shape may GROW an export,
 * and nothing outside may reach past it. Slices 5 to 9 delete these
 * lines along with their callers.
 */
export { createArchiveState, initial as archiveInitialState, DEADLINES_MS,
         ROW_KEY, IDLE, LOADING } from './state';
export type { ArchiveStateModule, ArchiveStateShape, ArchiveActionMessage,
              OutcomeClassifier, ViewSlice, Reason } from './state';
export { ACTIONS, NAMED_KEYS, PLAIN_KEYS, bindings, createSelection,
         hasCommandModifier, resolve, resolveEscape } from './keys';
export type { ArchiveAction, Binding, KeyContext, KeyLike, Selection } from './keys';
export { openHelp, buildHelpTable, HELP_MODAL_ATTR, HELP_MODAL_NAME,
         HELP_ROOT_CLASS, HELP_CLOSE_ACTION } from './keys-help';
export type { HelpHandle, ModalStackLike, OpenHelpOptions } from './keys-help';
export { archiveFormat, formatBytes, formatChars, formatCount,
         formatTimestamp, formatRelativeAge, abbreviateSha, shortenSlug,
         renderTranscriptHeader, NOT_KNOWN, SLUG_MAX_CHARS,
         SHA_ABBREV_CHARS } from './format';

/**
 * SLICE 6, THE TRANSCRIPT LIST. Published here for the same reason the
 * block above is: `import-direction.test.ts` pins that nothing outside
 * `history/` reaches past this file, so a composition root mounts
 * `TranscriptList` through the package rather than by path.
 *
 * IT IS DELIBERATELY NOT WIRED TO A SCREEN. Slice 3, the archive screen
 * SHELL, is not being built - Adam is replacing the entire application
 * shell (issue #175) and a shell built days before it is replaced is
 * wasted motion. So this list is a SHELL-INDEPENDENT component with no
 * mount site yet: it takes its container, its scrollport, its client and
 * its scope from whoever mounts it, and assumes nothing about what is
 * around it.
 */
export { default as TranscriptList } from './TranscriptList.svelte';
export { default as TranscriptRow } from './TranscriptRow.svelte';
export { default as TranscriptListFilter } from './TranscriptListFilter.svelte';
export { default as TranscriptListFooter } from './TranscriptListFooter.svelte';
export {
    CLASS as TLIST_CLASS, COLUMNS as TLIST_COLUMNS, PAGE_SIZE, ROOT_CLASS,
    SCHEME_DEFS, SCHEME_FILTERS, DEFAULT_SCHEME, TITLE_SOURCES,
    TITLE_SOURCE_NONE, TITLE_SOURCE_UNKNOWN, UNESTABLISHED_ATTRIBUTION,
} from './tlist-vocab';
export type { SchemeDef, TitleSourceDef, FuzzyColumn } from './tlist-vocab';
export {
    activeSchemeLabel, describeFilter, displayTitle, fuzzyNote,
    isUnestablished, nextScheme, rowValue, titleSource, wireScheme,
} from './tlist-row';
export type { TranscriptRowData, FilterMeta, DisplayTitle } from './tlist-row';
export {
    applyPage, canLoadMore, describeFooter, emptyPaging, fetchPage,
} from './tlist-paging';
export type { ListScope, PagingState } from './tlist-paging';
export {
    computeWindow, renderedCount, maxRendered, scrollToShow,
    DEFAULT_OVERSCAN, ROW_GAP_PX,
} from './tlist-window';
export type { RenderWindow, WindowInput } from './tlist-window';
export { isFiltering, visibleRows } from './tlist-fuzzy';
export type {
    FuzzyMatcher, MatchSpan, SpanMap, LabelSegment, RankedRow,
} from './tlist-fuzzy';
