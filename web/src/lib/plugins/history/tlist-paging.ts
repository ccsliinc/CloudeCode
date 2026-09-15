/**
 * THE TRANSCRIPT LIST'S PAGING: one scope, an opaque keyset cursor, and
 * the three-outcome `has_more` this list has always refused to flatten.
 *
 * THE MEASURED PROBLEM IT EXISTS TO SURVIVE (live server, 2026-08-31).
 * 19,588 of 21,039 transcripts (93.1 percent) are `session_ref_scheme =
 * 'agent'` sidechain files; only 1,451 are `uuid`-scheme, and 19 of
 * THOSE carry a session_ref that is not a UUID at all (literal values
 * like `audit` and `journal`). Project 12 alone holds 3,416. Somebody
 * looking for a conversation they had is reading a list that is 93
 * percent noise.
 *
 * THE SCHEME FILTER IS THE SERVER'S. Choosing a scheme RELOADS the
 * listing with the filter on the request, so what comes back is the
 * project narrowed, not the fetched page narrowed, and paging continues
 * inside the filtered set. The fuzzy filter is the CLIENT's and can only
 * see what has been fetched. The two are never applied in the same place
 * and never described in one sentence, because a second invisible copy
 * of the server's rule could disagree with the counts the note quotes.
 *
 * `has_more` IS A THREE-OUTCOME FIELD. The server returns `null` on
 * every failure path - measured, the budget_exhausted search answered
 * `"has_more": null`. `null` is not `false`. The load-more control is
 * offered on `=== true` and nothing else; `null` renders "whether there
 * is more: NOT KNOWN". Treating null as false claims the end of a list
 * that was never read.
 *
 * `session_ref` IS NOT AN IDENTITY. Measured: `journal` names 14
 * different transcripts, `audit` 5, `agent-a877057` 4. Every key and
 * callback here carries `transcript_id`; `session_ref` reaches the DOM
 * only as display text.
 *
 * NO DOM AND NO SVELTE. This module is the state machine; the component
 * renders whatever it answers. Ported from
 * client/js/archive-transcript-list.js, minus everything that built an
 * element.
 */
import { PAGE_SIZE } from './tlist-vocab';
import { wireScheme, type FilterMeta, type TranscriptRowData } from './tlist-row';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** Which listing is on screen, and how big the server said it is. */
export interface ListScope {
    /** 'project' pages a project; 'unattributed' pages a corpus's orphans. */
    readonly kind: 'project' | 'unattributed';
    /** The project id, or the corpus id for the unattributed listing. */
    readonly id: number | string | null;
    /** The server's count for this scope, or null when it did not say. */
    readonly inScope: number | null;
}

/** Everything one page application can change. Replaced, never mutated. */
export interface PagingState {
    /** Rows fetched so far, in server order, appended page by page. */
    readonly rows: readonly TranscriptRowData[];
    /** The keyset cursor for the next page, or null when there is none. */
    readonly nextCursor: string | null;
    /** `has_more` AS RECEIVED. Three-valued; null means the server did not say. */
    readonly hasMore: boolean | null;
    /** The server's `meta.filters` from the last RENDERABLE page, or null. */
    readonly filters: FilterMeta | null;
    /** The scope these rows belong to. */
    readonly scope: ListScope;
    /**
     * The outcome token of the last page, e.g. 'ok', 'partial',
     * 'budget_exhausted'. `'loading'` while a request is in flight and
     * `'idle'` before the first one.
     */
    readonly token: string;
    /**
     * The envelope to render INSTEAD of (or beneath) the rows, or null
     * when the last page was fully renderable.
     */
    readonly outcomeEnvelope: unknown;
    /** Why there is no envelope, or null when the server answered. */
    readonly transportError: string | null;
    /** True when the outcome block sits BENEATH rows rather than replacing them. */
    readonly keepRows: boolean;
}

/** The state a list starts in, before anything has been asked. */
export function emptyPaging(scope?: ListScope): PagingState {
    return {
        rows: [],
        nextCursor: null,
        hasMore: null,
        filters: null,
        scope: scope || { kind: 'project', id: null, inScope: null },
        token: 'idle',
        outcomeEnvelope: null,
        transportError: null,
        keepRows: false,
    };
}

/**
 * Apply one page response to the paging state.
 *
 * Description: PURE. It takes the state and the envelope and answers the
 *   next state, so the whole of the paging contract is testable without
 *   a network, a document or a component.
 *
 *   THE MALFORMED-CURSOR CASE MUST NOT SILENTLY RESTART. A client paging
 *   3,416 rows that restarts on its own renders duplicates forever, so a
 *   non-renderable outcome CLEARS the cursor and keeps whatever rows are
 *   already on screen, and the two recovery paths are offered to the
 *   user as explicit actions instead.
 * Inputs: state - the current paging state. result - one EnvelopeResult
 *   from the granted archive client. outcome - the injected classifier.
 * Output: the next paging state.
 * Example:
 *   const next = applyPage(emptyPaging(), r, window.ArchiveOutcome);
 *   next.token // -> 'ok'
 */
export function applyPage(
    state: PagingState,
    result: EnvelopeResult,
    outcome: OutcomeClassifier,
): PagingState {
    const envelope = result.transportError ? null : result.envelope;
    const classified = outcome.classify(envelope);

    if (!outcome.isRenderable(classified.token)) {
        return {
            ...state,
            token: classified.token,
            nextCursor: null,
            hasMore: null,
            outcomeEnvelope: result.transportError ? null : result.envelope,
            transportError: result.transportError,
            keepRows: state.rows.length > 0,
        };
    }

    const page = (envelope as { result?: unknown } | null)?.result;
    const appended = Array.isArray(page) ? (page as TranscriptRowData[]) : [];
    const meta = classified.meta || {};
    const paging = (meta as { paging?: unknown }).paging;
    const pagingObj = paging && typeof paging === 'object'
        ? paging as { next_cursor?: unknown }
        : {};
    const filtersRaw = (meta as { filters?: unknown }).filters;
    const scopeCount = (meta as { unattributed_transcript_count?: unknown })
        .unattributed_transcript_count;

    return {
        ...state,
        rows: state.rows.concat(appended),
        nextCursor: typeof pagingObj.next_cursor === 'string'
            ? pagingObj.next_cursor
            : null,
        hasMore: outcome.hasMore(envelope),
        filters: filtersRaw && typeof filtersRaw === 'object'
            ? filtersRaw as FilterMeta
            : null,
        scope: typeof scopeCount === 'number' && state.scope.kind === 'unattributed'
            ? { ...state.scope, inScope: scopeCount }
            : state.scope,
        token: classified.token,
        // A `partial` IS renderable and its rows are real, so they are
        // kept AND the envelope is rendered beneath them. That is one
        // state, not two, which is why `keepRows` travels with it.
        outcomeEnvelope: classified.token === 'partial' ? envelope : null,
        transportError: null,
        keepRows: classified.token === 'partial',
    };
}

/**
 * Issue one page request for a scope.
 *
 * Description: the ONLY place that decides which route a scope maps to.
 *   The unattributed route takes no scheme filter, so the control is
 *   hidden for that scope rather than sent and silently ignored - a
 *   control that does nothing is worse than no control.
 * Inputs: client - the granted archive client. scope - which listing.
 *   scheme - the UI filter value. cursor - the keyset cursor, or null
 *   for page one.
 * Output: the envelope result. It RESOLVES on every path, including a
 *   dead network, because `EnvelopeResult` carries the failure rather
 *   than rejecting with it.
 * Example: await fetchPage(client, scope, 'uuid', null)
 */
export function fetchPage(
    client: ArchiveClient,
    scope: ListScope,
    scheme: string,
    cursor: string | null,
): Promise<EnvelopeResult> {
    if (scope.kind === 'unattributed') {
        return client.listArchiveUnattributed(scope.id as number | string, {
            limit: PAGE_SIZE,
            cursor,
        });
    }
    return client.listArchiveTranscripts(scope.id as number | string, {
        limit: PAGE_SIZE,
        cursor,
        sessionRefScheme: wireScheme(scheme),
    });
}

/**
 * Whether a "load more" request may be issued at all.
 *
 * Description: REFUSES when the previous response supplied no cursor,
 *   rather than re-requesting page one, which would duplicate rows. Its
 *   own function so the button's disabled state and the request guard
 *   read the same rule.
 * Inputs: state - the paging state.
 * Output: true when `loadMore` would actually fetch something.
 * Example: canLoadMore(emptyPaging()) // -> false
 */
export function canLoadMore(state: PagingState): boolean {
    return typeof state.nextCursor === 'string' && state.nextCursor.length > 0;
}

/**
 * The footer's sentence, and whether a load-more control may be drawn.
 *
 * Description: THREE OUTCOMES FROM ONE THREE-VALUED FIELD, and the
 *   button is offered on `true` ALONE. `false` states a measured end;
 *   `null` states an unknown out loud, because the server not answering
 *   `has_more` is not the server answering that there is nothing more.
 * Inputs: hasMore - as received. loaded - rows on screen, already
 *   formatted by the caller so this module needs no formatter.
 * Output: what the footer should say and whether to offer the control.
 * Example: describeFooter(null, '3,416').offerMore // -> false
 */
export function describeFooter(
    hasMore: boolean | null,
    loaded: string,
): { readonly offerMore: boolean; readonly text: string; readonly unknown: boolean } {
    if (hasMore === true) {
        return { offerMore: true, text: `Load ${PAGE_SIZE} more`, unknown: false };
    }
    if (hasMore === false) {
        return {
            offerMore: false,
            unknown: false,
            text: `End of the list. All ${loaded} rows in this scope have `
                + 'been loaded.',
        };
    }
    return {
        offerMore: false,
        unknown: true,
        text: `Whether there is more beyond these ${loaded} rows: NOT KNOWN. `
            + 'The server did not answer has_more, which is not the same as '
            + 'answering that there is nothing more.',
    };
}
