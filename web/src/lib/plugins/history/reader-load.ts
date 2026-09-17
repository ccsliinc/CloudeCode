/**
 * THE READER'S FETCH LAYER, AS PURE REDUCERS. Ported from
 * `client/js/archive-screen-reader.js`, which was the reader's fetch
 * owner because the composition root was over this repo's 500-line cap
 * with it inline.
 *
 * SAME SHAPE AS SLICE 6's `tlist-paging.ts`, DELIBERATELY. That module
 * pairs a `fetchX` that only issues a request with an `applyX(state,
 * result, outcome)` that only folds one in, so the whole contract is
 * testable without a network, a document or a component. This does the
 * same for the spine, and for the same reason.
 *
 * IT DOES NOT INTERPRET `result_status`. The injected classifier is the
 * only interpreter; this reads the TOKEN that function returns, which is
 * a different thing.
 *
 * `has_more` IS THREE-VALUED and only an explicit `false` proves the
 * spine is complete. `null` renders the incomplete-spine sentinel rather
 * than an "end of transcript" nobody measured.
 *
 * A SPINE FETCHED WITH `startLine` IS A WINDOW, NOT A WHOLE FILE. Even
 * when the server says `has_more` is false, every line BEFORE the offset
 * is missing, so such a spine is never complete. Claiming otherwise
 * would be a false "you have seen it all" produced by the deep link
 * itself.
 *
 * No DOM, no framework, no globals.
 */
import { DEFAULT_PAGE_ROWS } from './reader-paging';
import { READER_LOADING } from './reader-vocab';
import type { SpineRow } from './reader-rows';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** The outcome token this module answers with when nothing came back. */
export const TOKEN_TRANSPORT_ERROR = 'transport-error';

/**
 * Distance from the last line the reader holds to the first line the
 * next page must start at.
 *
 * Description: `start_line` is a LINE NUMBER and is inclusive
 *   (`src/core/archive_start_line.py`: `start_line=7111` returns line
 *   7111 as the FIRST row), so the next window begins one past the last
 *   row already held. Named rather than written as a bare 1, so the
 *   inclusiveness is stated where the arithmetic happens.
 */
export const NEXT_LINE_STEP = 1;

/** Everything one spine load can change. Replaced, never mutated. */
export interface SpineState {
    /** The raw spine rows, in server order, appended page by page. */
    readonly rows: readonly SpineRow[];
    /**
     * Whether the last page has arrived. Only an explicit `has_more ===
     * false` on a NON-windowed request sets this true.
     */
    readonly complete: boolean;
    /** The reader's outcome token, or 'idle' / 'loading'. */
    readonly token: string;
    /** The envelope backing a failure, or null. */
    readonly envelope: unknown;
    /** The transcript header facts, or null when none has succeeded. */
    readonly header: unknown;
    /** Why there is no envelope, or null when the server answered. */
    readonly transportError: string | null;
}

/** The state a reader starts in, before anything has been asked. */
export function emptySpine(): SpineState {
    return {
        rows: [],
        complete: false,
        token: 'idle',
        envelope: null,
        header: null,
        transportError: null,
    };
}

/** The state to paint while a load is in flight. */
export function loadingSpine(state: SpineState): SpineState {
    return { ...state, token: READER_LOADING, envelope: null, transportError: null };
}

/** One spine request's two responses, paired. */
export interface SpineFetch {
    /** GET /archive/transcripts/{id}. */
    readonly head: EnvelopeResult;
    /** GET /archive/transcripts/{id}/lines. */
    readonly page: EnvelopeResult;
    /** True when the page was requested with `start_line`. */
    readonly windowed: boolean;
}

/**
 * Issue the two requests one transcript open needs.
 *
 * Description: the ONLY place a transcript id becomes network traffic. A
 *   deep link asks the SERVER for the window it wants rather than
 *   fetching page one and reporting it could not reach the line, which
 *   was honest and useless.
 * Inputs: client - the granted archive client. transcriptId. lineNo -
 *   the line to open at, or null for the first page. pageRows.
 * Output: both responses and whether the page was windowed. RESOLVES on
 *   every path, including a dead network, because `EnvelopeResult`
 *   carries the failure rather than rejecting with it.
 * Example: await fetchSpine(client, 5767, null, 500)
 */
export function fetchSpine(
    client: ArchiveClient,
    transcriptId: number | string,
    lineNo: number | null,
    pageRows: number = DEFAULT_PAGE_ROWS,
): Promise<SpineFetch> {
    const windowed = lineNo !== null && lineNo !== undefined;
    const lineOpts = windowed
        ? { limit: pageRows, startLine: lineNo }
        : { limit: pageRows };
    return Promise.all([
        client.getArchiveTranscript(transcriptId),
        client.listArchiveLines(transcriptId, lineOpts),
    ]).then(([head, page]) => ({ head, page, windowed }));
}

/**
 * Fold one spine load into the reader's state.
 *
 * Description: PURE. THREE OUTCOMES, EXPLICITLY, TWICE. A transport
 *   failure and an envelope the server could not evaluate are different
 *   from an empty transcript, and each reaches the reader as its own
 *   token rather than as an empty spine. THE HEADER IS FOLDED
 *   SEPARATELY: a header request that failed must not blank a spine that
 *   arrived, and a spine that failed must not discard a header that did.
 * Inputs: state - the current state. fetched - both responses. outcome -
 *   the injected classifier.
 * Output: the next state.
 * Example: applySpine(emptySpine(), r, outcome).token // -> 'ok'
 */
export function applySpine(
    state: SpineState,
    fetched: SpineFetch,
    outcome: OutcomeClassifier,
): SpineState {
    const { head, page, windowed } = fetched;

    // THE HEADER, ON ITS OWN. A header that could not be read leaves
    // `header` null, which renders NOTHING rather than inventing blank
    // facts - see `renderTranscriptHeader`'s own contract.
    let header: unknown = null;
    if (!head.transportError) {
        const headTok = outcome.classify(head.envelope);
        header = outcome.isRenderable(headTok.token)
            ? (head.envelope as { result?: unknown } | null)?.result ?? null
            : null;
    }

    if (page.transportError) {
        return {
            ...state,
            header,
            token: TOKEN_TRANSPORT_ERROR,
            envelope: null,
            transportError: page.transportError,
        };
    }

    const classified = outcome.classify(page.envelope);
    if (!outcome.isRenderable(classified.token)) {
        return {
            ...state,
            header,
            token: classified.token,
            envelope: page.envelope,
            transportError: null,
        };
    }

    const rows = ((page.envelope as { result?: unknown } | null)?.result
        || []) as SpineRow[];
    // A windowed spine is never complete: see the file header.
    const complete = outcome.hasMore(page.envelope) === false && !windowed;
    return {
        rows,
        complete,
        token: classified.token,
        envelope: null,
        header,
        transportError: null,
    };
}

/**
 * Fold one FORWARD page into the reader's state.
 *
 * Description: APPENDS. `complete === true` is the only input that marks
 *   the spine complete, exactly as in `applySpine`. A non-renderable
 *   outcome KEEPS the rows already held and reports the token beside
 *   them: a failed page that discarded the transcript would be a far
 *   worse answer than a failed page that says so.
 * Inputs: state, result - the /lines response. outcome.
 * Output: the next state.
 * Example: appendSpine(state, r, outcome).rows.length
 */
export function appendSpine(
    state: SpineState,
    result: EnvelopeResult,
    outcome: OutcomeClassifier,
): SpineState {
    if (result.transportError) {
        return {
            ...state,
            token: TOKEN_TRANSPORT_ERROR,
            envelope: null,
            transportError: result.transportError,
        };
    }
    const classified = outcome.classify(result.envelope);
    if (!outcome.isRenderable(classified.token)) {
        return {
            ...state,
            token: classified.token,
            envelope: result.envelope,
            transportError: null,
        };
    }
    const added = ((result.envelope as { result?: unknown } | null)?.result
        || []) as SpineRow[];
    return {
        ...state,
        rows: state.rows.concat(added),
        complete: outcome.hasMore(result.envelope) === false,
        token: classified.token,
        envelope: null,
        transportError: null,
    };
}

/** Where the next forward page starts, or why there is nowhere. */
export interface NextStart {
    /** The line to request, when one could be read. */
    readonly next?: number;
    /** Why there is none. NEVER a number and a reason together. */
    readonly reason?: string;
}

/**
 * Decide where the next forward page starts, from what the reader holds.
 *
 * Description: never a number and a reason together, so a caller cannot
 *   read a fallback out of a refusal.
 * Inputs: rows - the raw spine rows the reader holds.
 * Output: `{next}` when a position exists, or `{reason}` naming
 *   precisely why there is none.
 * Example: nextStartLine([{line_no: 499}]) // -> {next: 500}
 */
export function nextStartLine(rows: readonly SpineRow[] | null | undefined): NextStart {
    if (!Array.isArray(rows) || rows.length === 0) {
        return {
            reason: 'the reader holds no rows, so there is no position to '
                + 'page from',
        };
    }
    const last = rows[rows.length - 1];
    const lineNo = last ? last.line_no : undefined;
    if (typeof lineNo !== 'number' || !isFinite(lineNo)) {
        return {
            reason: 'the last row the reader holds carries no finite line_no ('
                + String(lineNo) + '), so the line number this page would '
                + 'continue from cannot be read',
        };
    }
    return { next: lineNo + NEXT_LINE_STEP };
}

/**
 * The sentence an incomplete spine ends with.
 *
 * Description: A PARTIAL SPINE ENDS IN A NAMED SENTINEL, NOT IN A SILENT
 *   STOP. A list that just ends looks complete.
 * Inputs: loaded - how many raw rows are held.
 * Output: the sentence.
 * Example: sentinelText(500)
 *   // -> 'More lines not loaded yet. 500 of this transcript loaded so far.'
 */
export function sentinelText(loaded: number): string {
    return `More lines not loaded yet. ${loaded} of this transcript loaded `
        + 'so far.';
}
