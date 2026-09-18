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

/**
 * SLICE 5, THE NAVIGATION RAIL. Published here for the same reason the
 * block above is: `import-direction.test.ts` pins that nothing outside
 * `history/` reaches past this file, so a composition root mounts
 * `NavRail` through the package rather than by path.
 *
 * IT IS DELIBERATELY NOT WIRED TO A SCREEN, for the same reason slice 6
 * is not. It takes its container, its granted client, its outcome
 * classifier, its `onSelect`, and optionally its order storage, its
 * modal stack, its presentation overlay and its outcome renderer from
 * whoever mounts it, and assumes nothing about what is around it.
 *
 * Replaces client/js/archive-nav.js, archive-nav-row.js,
 * archive-nav-card.js, archive-nav-info.js, archive-nav-merged.js,
 * archive-nav-order.js, archive-nav-fuzzy.js, archive-nav-drill.js and
 * archive-nav-tree.js.
 */
export { default as NavRail } from './NavRail.svelte';
export { default as NavProjectCard } from './NavProjectCard.svelte';
export { default as NavNode } from './NavNode.svelte';
export { default as NavLevel } from './NavLevel.svelte';
export { default as NavInfoModal } from './NavInfoModal.svelte';
export { default as NavLabel } from './NavLabel.svelte';
export { default as NavOutcome } from './NavOutcome.svelte';
export {
    CLASS as NAV_CLASS, INFO_CLASS as NAV_INFO_CLASS, NODE_KINDS, NODE_MOD,
    ROOT_CLASS as NAV_ROOT_CLASS, INFO_ROOT_CLASS, UNATTRIBUTED_LABEL,
    UNATTRIBUTED_TITLE, UNSTYLED_PRE_EXISTING, VIEWS,
} from './nav-vocab';
export type { NodeKind, NavView } from './nav-vocab';
export {
    countFor, describeFilter as describeNavFilter, filterRows, idFor, labelFor,
    renderCount, shouldShowUnattributed, titleFor, unattributedNote,
} from './nav-row';
export type { NavRowData, UnattributedNote, UnattributedVerdict } from './nav-row';
export {
    MODES as ORDER_MODES, DEFAULT_MODE as DEFAULT_ORDER_MODE, STORAGE_KEY as ORDER_STORAGE_KEY,
    activityCell, comparatorFor, hasKey, isMode, modeFor, partition, readMode,
    sortNodes, unsortedReason, writeMode,
} from './nav-order';
export type {
    ActivityCell, ModeStore, OrderKind, OrderMode, OrderableNode, ParkedNode,
    SortResult, StoredMode, UnsortedReason,
} from './nav-order';
export { BOUNDARY_CHARS, isBoundary, match, matchRow, rank, segments } from './nav-fuzzy';
export type { FuzzyField, FuzzyHit, NavSegment, RankedNavRow } from './nav-fuzzy';
export {
    FIELDS as NAV_FUZZY_FIELDS, filterByHost, hostOptions, normalizedProjects,
    paintMerged, partitionUnattributed,
} from './nav-merged';
export type { MergedNode, MergedPaint, PaintedProject, UnattributedSplit } from './nav-merged';
export {
    SESSION_COUNTED_FIELD, SESSION_COUNT_FIELDS, SESSION_REASONS, SESSION_STATES,
    countsLine, countsTitle, presentationFor, sessionCountFor,
} from './nav-card';
export type { CountsLine, OverlayFallback, Presentation, SessionCount } from './nav-card';
export { infoField, machineRows, machinesHeading, machinesUnevaluated } from './nav-info';
// `ModalStackLike` is published above, from `keys-help.ts`. The rail
// REUSES that type rather than declaring a second name for the same host
// object, so there is nothing to re-export here.
export type { InfoField, MachineRow, MachinesHeading } from './nav-info';
export {
    HOSTS_KEY, LEVEL_FIELDS, applyLevel, childKind, emptyLevel, fetchLevel,
    levelKey, loadedCorpora, unattributedRowFor,
} from './nav-drill';
export type { DrillState, LevelState } from './nav-drill';
export { applyMerged, emptyMerged } from './nav-merged-load';
export type { MergedState } from './nav-merged-load';

/**
 * SLICE 7, THE TRANSCRIPT READER. Published here for the same reason
 * slices 5 and 6 are: `import-direction.test.ts` pins that nothing
 * outside `history/` reaches past this file, so a composition root
 * mounts `TranscriptReader` through the package rather than by path.
 *
 * IT IS DELIBERATELY NOT WIRED TO A SCREEN, for the same reason they are
 * not. It takes its client, its outcome classifier, its transcript id,
 * its optional deep-link line and its FRAME SCHEDULER from whoever
 * mounts it, and assumes nothing about what is around it. The frame
 * scheduler is the THIRD gap in the `app-screen` surface; see
 * `TranscriptReader.svelte`'s header and
 * `docs/archive-shell-contract.md`.
 *
 * Replaces client/js/archive-reader.js, archive-reader-dom.js,
 * archive-reader-body.js, archive-reader-paging.js,
 * archive-reader-select.js, archive-line-render.js,
 * archive-virtual-list.js, archive-body-cache.js, archive-body-gate.js
 * and archive-screen-reader.js. It also ports archive-mask.js, which
 * STAYS on disk because client/js/archive-chat-block.js is still a
 * consumer; see `reader-mask.ts` for why that one is a hard import here
 * rather than an injected seam.
 */
export { default as TranscriptReader } from './TranscriptReader.svelte';
export { default as ReaderRow } from './ReaderRow.svelte';
export { default as ReaderStatus } from './ReaderStatus.svelte';
export { default as ReaderBody } from './ReaderBody.svelte';
export { default as ReaderProgressRun } from './ReaderProgressRun.svelte';
export {
    ACTIONS as READER_ACTIONS, BODY_STATE, CLASS as READER_CLASS,
    FAMILIES, FAMILY_MOD, NO_ROLE_TEXT, NO_RECORD_TYPE_TEXT, NOT_REQUESTED,
    PROGRESS_RUN_MOD, RECORD_FAMILY, ROW_CLASS,
    ROOT_CLASS as READER_ROOT_CLASS, UNSTYLED_PRE_EXISTING as READER_UNSTYLED,
    WIRE_WITHHELD_TOO_LARGE,
} from './reader-vocab';
export type { BodyState, Family, ReaderAction } from './reader-vocab';
export { MASK_OK, MASK_REFUSED, SECRET_MARKER, maskBody } from './reader-mask';
export type { MaskResult, MaskOk, MaskRefused, SecretFinding } from './reader-mask';
export {
    applyMask, forbidsFetch, gateFor, reasonFrom, NEVER_FETCH,
    BODY_INLINE_MAX, BODY_RENDER_HARD_MAX, BODY_CACHE_MAX_ENTRIES,
    BODY_CACHE_MAX_CHARS, BODY_DEADLINE_MS,
} from './reader-gate';
export type { GateVerdict, GateRow, MaskApplication } from './reader-gate';
export { createBodyCache } from './reader-body-cache';
export type { BodyCache, BodyEntry, BodyRow, CacheStats } from './reader-body-cache';
export {
    createList, estimateHeight, estimateItem, rowAt,
    CHARS_PER_LINE, COLLAPSED_MAX_PX, HEIGHT_EPSILON_PX, LINE_HEIGHT_PX,
    OVERSCAN_ROWS, PLACEHOLDER_EXTRA_PX, PROGRESS_ROW_PX, ROW_CHROME_PX,
} from './reader-virtual';
export type {
    MeasurementResult, ReaderWindow, VirtualList, VirtualListOptions,
} from './reader-virtual';
export {
    bodyView, familyFor, familyModFor, groupRows, indexOfLine, isRun, itemKey,
    paintPlan, rangeText, roleLabel,
} from './reader-rows';
export type {
    BodyAction, BodyView, PaintedItem, ProgressRun, ReaderItem, RoleLabel,
    SpineRow,
} from './reader-rows';
export { createBodyPolicy } from './reader-body-policy';
export type { BodyPolicy, BodyPolicyContext } from './reader-body-policy';
export {
    createPager, DEFAULT_PAGE_ROWS, PAGE_COMPLETE, PAGE_FAILED, PAGE_NO_PAGER,
} from './reader-paging';
export type { Pager, PagerContext } from './reader-paging';
export {
    appendSpine, applySpine, emptySpine, fetchSpine, loadingSpine,
    nextStartLine, sentinelText, NEXT_LINE_STEP, TOKEN_TRANSPORT_ERROR,
} from './reader-load';
export type { NextStart, SpineFetch, SpineState } from './reader-load';
export {
    measuredHeight, reconcileMeasured, scrollRowIntoView, scrollTopOf,
    viewportHeight, watchScroller, FALLBACK_VIEWPORT_PX,
} from './reader-measure.svelte';
export { createSelectionApi, NOTHING_SELECTED } from './reader-select';
export type { SelectionApi, SelectionContext } from './reader-select';
export { createActionRouter } from './reader-actions';
export type { ActionContext } from './reader-actions';
export { createOpenApi } from './reader-open';
export type { OpenApi, OpenContext } from './reader-open';
export { createFramePass } from './reader-frame';
export type { FramePass, FrameContext } from './reader-frame';
export { headerFacts } from './reader-header';
export type { HeaderFacts, TranscriptHeaderRecord } from './reader-header';
export type { ReaderProps } from './reader-props';

/**
 * SLICE 8, THE CONVERSATION VIEW. Published here for the same reason
 * slices 5, 6 and 7 are: `import-direction.test.ts` pins that nothing
 * outside `history/` reaches past this file, so a composition root mounts
 * `ChatView` through the package rather than by path.
 *
 * IT IS DELIBERATELY NOT WIRED TO A SCREEN, for the same reason they are
 * not. It takes its client, its outcome classifier, its transcript id,
 * an optional root label and its FRAME SCHEDULER from whoever mounts it,
 * and assumes nothing about what is around it. The scheduler is the
 * THIRD gap in the `app-screen` surface, the SAME one slice 7 reported;
 * this slice found no fourth. See `chat-props.ts` and
 * `docs/archive-shell-contract.md`.
 *
 * EVERY BYTE OF BLOCK TEXT IT PAINTS GOES THROUGH `reader-gate.applyMask`
 * by way of `chat-mask.ts`, which is the one file in this family
 * permitted to read a block's text at all. That is asserted, not
 * promised: see `ChatView.commitments.test.ts`.
 *
 * Replaces client/js/archive-chat-view.js, archive-chat-screen.js,
 * archive-chat-turn.js, archive-chat-block.js, archive-chat-info.js,
 * archive-chat-subagents.js, archive-chat-stack.js,
 * archive-chat-estimate.js and archive-chat-clicks.js.
 */
export { default as ChatView } from './ChatView.svelte';
export { default as ChatTurn } from './ChatTurn.svelte';
export { default as ChatBlock } from './ChatBlock.svelte';
export { default as ChatInfo } from './ChatInfo.svelte';
export { default as ChatSubagents } from './ChatSubagents.svelte';
export { default as ChatChain } from './ChatChain.svelte';
export { default as ChatStatus } from './ChatStatus.svelte';
export {
    ACTIONS as CHAT_ACTIONS, CLASS as CHAT_CLASS, MOD as CHAT_MOD,
    COLLAPSED_BY_DEFAULT, ROLE_LABELS, TYPE_LABELS,
    UNSTYLED_PRE_EXISTING as CHAT_UNSTYLED,
    BLOCK_CLASS, CHAIN_CLASS, INFO_CLASS, SUBAGENTS_CLASS, TURN_CLASS,
    ROOT_CLASS as CHAT_ROOT_CLASS,
} from './chat-vocab';
export type { ChatAction } from './chat-vocab';
export { blockText, declaredSecrets, findingsFor, textState, TEXT_STATE } from './chat-mask';
export type {
    ChatBlockRaw, ChatBlockText, ChatTextRefused, ChatTextSafe, ChatTextUnknown,
    ChatTextWithheld, ChatTurnSecrets, TextState,
} from './chat-mask';
export {
    isRun as isChatRun, itemKey as chatItemKey, progressChipLabel,
    roleLabel as chatRoleLabel, turnBody, turnView,
} from './chat-turn';
export type {
    ChatBlockView, ChatItem, ChatTurnRaw, ChatTurnView, OpenState,
    ProgressRun as ChatProgressRun, TurnBody,
} from './chat-turn';
export {
    basisProse, expanderFor, lookupState, nameFor, order as orderSubagents,
    ordinalFor, panelFor, startOf, transcriptsOf, BASIS_PROSE, LOOKUP_FAILED,
    LOOKUP_KNOWN, ORDER_DECLARED, ORDER_DERIVED, ORDER_UNKNOWN,
} from './chat-subagents';
export type {
    Expander, OrderedRows, SubagentControl, SubagentPanel, SubagentRow,
    SubagentRowView, SubagentTranscript, SubagentTurn,
} from './chat-subagents';
export { createStack, crumbText } from './chat-stack';
export type { ChainLevel, ChainSpec, ChatStack } from './chat-stack';
export { display as chatInfoDisplay, extraKeys, infoPanel, pick as chatInfoPick, FIELDS as CHAT_INFO_FIELDS, USAGE_FIELDS as CHAT_USAGE_FIELDS } from './chat-info';
export type {
    InfoField as ChatInfoField, InfoPanel, InfoRow, InfoTurn,
} from './chat-info';
export {
    blockHeight, estimateItem as estimateChatItem, estimator as chatEstimator,
    CHARS_PER_LINE as CHAT_CHARS_PER_LINE, INFO_PANEL_PX, LINE_HEIGHT_PX as CHAT_LINE_HEIGHT_PX,
    PROGRESS_ROW_PX as CHAT_PROGRESS_ROW_PX, SUBAGENT_HEAD_PX, SUBAGENT_ROW_PX,
    TURN_CHROME_PX, TURN_MAX_PX,
} from './chat-estimate';
export {
    appendTurns, applyTurns, emptyChat, fetchTurns, groupTurns, loadingChat,
    nextCursorOf, noRouteEnvelope, sentinelText as chatSentinelText, turnsOf,
    DEFAULT_PAGE_TURNS, NO_PAGER_TEXT, TOKEN_CANNOT_DETERMINE,
} from './chat-load';
export type { ChatState } from './chat-load';
export {
    createChatOpenApi, NOT_OPENABLE, NO_CURSOR, SUPERSEDED,
} from './chat-open';
export type { ChatOpenApi, ChatOpenContext } from './chat-open';
export type { ChatProps, SubagentTarget } from './chat-props';
