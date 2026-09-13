/**
 * The archive screen's single state object and its reducer. PORTED from
 * `client/js/archive-state.js`, deleted in the same commit.
 *
 * WHAT THIS FILE IS FOR. Every view on the archive screen is in exactly
 * one named state at any moment. There is no implicit default and no
 * state meaning "still figuring it out". The vocabulary is the six
 * outcome tokens from `archive-outcome.js` plus exactly two states that
 * are not outcomes - `idle` and `loading` - and the reducer is the only
 * thing permitted to move a view between them.
 *
 * ONE STORE, KEYED BY ROUTE, WHICH IS ITEM 4 OF THE SCOPE'S 8.5 LIST AND
 * IS WHAT SLICES 5 TO 9 INHERIT. Not four stores per endpoint. A second
 * store is how two parts of one screen come to disagree about which
 * transcript is open, and the launchpad migration made this same call
 * and it held.
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD.
 *
 *   1. EVERY `loading` CARRIES A DEADLINE. A spinner with no terminal
 *      condition is a state that can never fail, which is the single
 *      worst defect shape available: a verification step that cannot
 *      report a problem. `REQUEST` stamps `deadlineAt`, and `TICK` past
 *      it turns the view into `transport-error` with the reason "no
 *      response in <n>s". A view can therefore always answer "what
 *      happened", even when nothing happened.
 *
 *   2. A RESPONSE ONLY LANDS ON A `loading` VIEW. Anything else is a
 *      response to a request this state object never made - a late
 *      arrival from a superseded query, or a bug. It is dropped rather
 *      than applied, because applying it silently overwrites the view a
 *      person is currently reading with the answer to a question they
 *      already moved on from.
 *
 *   3. `partial` NEVER BECOMES A SUCCESS WITHOUT AN EXPLICIT RESUME.
 *      `partial` means "I did not finish looking". The only two legal
 *      moves out of it are RESUME (continue where the scan stopped,
 *      keeping the rows already found) and REQUEST (a brand new
 *      question, which discards them). There is no path by which a
 *      partial quietly becomes an `ok`, because that would report 2,615
 *      unread transcripts as searched.
 *
 * THE DEADLINE TABLE IS NOT DECLARED HERE ANY MORE, AND THAT IS A DRY
 * FIX THE PORT MADE VISIBLE. The vanilla module carried its own
 * `DEADLINES_MS` with the same five numbers `api-archive.js` carried as
 * `ARCHIVE_TIMEOUTS`. Two tables of the same measurements is one edit
 * away from a `loading` view whose deadline disagrees with the request's
 * own abort timer - a spinner that expires before or after the thing it
 * is waiting for. Slice 2 made `./client-query.ts` the single source, so
 * this imports it. The export name `DEADLINES_MS` is kept because the
 * legacy callers and their suites hold it.
 *
 * THE OUTCOME CLASSIFIER IS INJECTED, NOT REACHED FOR. The vanilla
 * reducer called `window.ArchiveOutcome.classify` inline.
 * `archive-outcome.js` is slice 9 and still vanilla, and a host global
 * inside this directory is what `import-direction.test.ts` refuses. So
 * `createArchiveState` takes the classifier and the seam supplies the
 * real one. That also makes the reducer testable without a global, which
 * it was not before.
 *
 * No fetching. No DOM. No timers - `TICK` is fed in, so a test can
 * advance time without waiting for it.
 */
import { ARCHIVE_TIMEOUTS } from './client-query';

/**
 * Request deadlines in milliseconds, per request class.
 *
 * Re-exported from the client's table rather than re-declared; see the
 * header. Each number is a measured server timing with headroom.
 */
export const DEADLINES_MS: Readonly<Record<string, number>> = {
    ...ARCHIVE_TIMEOUTS,
};

/** The two states that are not outcome tokens. */
export const IDLE = 'idle';
export const LOADING = 'loading';

/**
 * Which key on each view slice holds its result rows, so RESUME can
 * append and REQUEST can clear without the reducer special-casing five
 * view names in five places.
 */
export const ROW_KEY: Readonly<Record<string, string>> = {
    nav: 'hosts',
    list: 'rows',
    reader: 'spine',
    search: 'hits',
};

/** One reason a view is in the state it is in. */
export interface Reason {
    readonly subject: string;
    readonly reason: string;
}

/** A view slice. Open-ended because each view adds its own fields. */
export interface ViewSlice {
    token: string;
    reasons: Reason[];
    deadlineAt: number | null;
    requestClass: string | null;
    resuming: boolean;
    [key: string]: unknown;
}

/** The whole archive screen state. */
export interface ArchiveStateShape {
    [view: string]: unknown;
}

/** What the reducer needs from `archive-outcome.js`. Injected. */
export interface OutcomeClassifier {
    classify(envelope: unknown): {
        token: string; reasons: Reason[]; meta?: Record<string, unknown> | null;
    };
    isRenderable(token: string): boolean;
    hasMore(envelope: unknown): boolean | null;
}

/** Every action the reducer accepts. */
export interface ArchiveActionMessage {
    readonly type?: string;
    readonly view?: string;
    readonly route?: unknown;
    readonly requestClass?: string;
    readonly at?: number;
    readonly patch?: Record<string, unknown>;
    readonly envelope?: unknown;
    readonly reason?: unknown;
}

/**
 * Build a view slice with the fields every view shares.
 * Inputs: extra - view-specific fields. Output: ViewSlice.
 */
function viewSlice(extra: Record<string, unknown>): ViewSlice {
    return {
        token: IDLE,
        reasons: [],
        deadlineAt: null,
        requestClass: null,
        resuming: false,
        ...extra,
    };
}

/**
 * The state every archive screen starts in.
 *
 * Description: mirrors the design doc's D.4 object exactly.
 * Inputs: none.
 * Output: a fresh state, safe to mutate by the caller only through
 *   `reduce`.
 */
export function initial(): ArchiveStateShape {
    return {
        route: { view: 'root', hostId: null, corpusId: null,
                 projectId: null, transcriptId: null, lineNo: null },
        nav: viewSlice({ hosts: [], expanded: {} }),
        list: viewSlice({ projectId: null, rows: [], nextCursor: null, hasMore: null }),
        reader: viewSlice({ transcriptId: null, header: null, spine: [],
                            spineComplete: false }),
        search: viewSlice({ q: '', scope: null, hits: [], scan: null,
                            resumeCursor: null }),
        exportUI: viewSlice({ transcriptId: null, headers: null }),
        // Exactly one permitted value in v1. The slot exists so the
        // reader renders "NOT CHECKED" rather than rendering nothing,
        // and so the next implementer sees the gap instead of inventing
        // an absence.
        liveSession: { token: 'not-checked' },
    };
}

/** Shallow-copy the state with one view slice replaced. The reducer is pure. */
function withView(
    state: ArchiveStateShape, view: string, slice: unknown,
): ArchiveStateShape {
    return { ...state, [view]: slice };
}

/** Shallow-copy one view slice with fields overridden. */
function patchSlice(slice: ViewSlice, patch: Record<string, unknown>): ViewSlice {
    return { ...slice, ...patch } as ViewSlice;
}

/**
 * Pull the rows out of an envelope for a given view.
 *
 * Description: only ever called on a renderable outcome, so `result` is
 *   a real collection or a real object. A non-array `result` (the
 *   single-object routes, e.g. one transcript) is WRAPPED, so the row
 *   key always holds an array and no consumer has to test.
 * Inputs: envelope, view. Output: rows, possibly empty.
 */
function rowsFrom(envelope: unknown, view: string): unknown[] {
    if (!ROW_KEY[view]) return [];
    const r = (envelope as { result?: unknown } | null)?.result;
    if (Array.isArray(r)) return r;
    if (r === null || r === undefined) return [];
    return [r];
}

/**
 * Read `meta.scan.resume_cursor`, the only thing that makes a `partial`
 * continuable.
 */
function resumeCursorFrom(meta: Record<string, unknown> | null | undefined): string | null {
    const scan = meta && (meta as { scan?: unknown }).scan;
    if (!scan || typeof scan !== 'object') return null;
    const cursor = (scan as { resume_cursor?: unknown }).resume_cursor;
    return typeof cursor === 'string' ? cursor : null;
}

/** Read `meta.paging.next_cursor`. */
function nextCursorFrom(meta: Record<string, unknown> | null | undefined): string | null {
    const paging = meta && (meta as { paging?: unknown }).paging;
    if (!paging || typeof paging !== 'object') return null;
    const cursor = (paging as { next_cursor?: unknown }).next_cursor;
    return typeof cursor === 'string' ? cursor : null;
}

/** What `createArchiveState` returns. */
export interface ArchiveStateModule {
    initial(): ArchiveStateShape;
    reduce(state: ArchiveStateShape, action: ArchiveActionMessage): ArchiveStateShape;
    readonly DEADLINES_MS: Readonly<Record<string, number>>;
    readonly ROW_KEY: Readonly<Record<string, string>>;
    readonly IDLE: string;
    readonly LOADING: string;
}

/**
 * Build the state module against an outcome classifier.
 *
 * Description: a factory rather than a module singleton so the reducer
 *   can be exercised without a global, and so `archive-outcome.js` -
 *   which is slice 9 and still vanilla - is injected rather than reached
 *   for from inside this directory.
 * Inputs: outcome - the classifier.
 * Output: ArchiveStateModule.
 * Example: const S = createArchiveState(window.ArchiveOutcome);
 *          S.reduce(S.initial(), {type:'REQUEST', view:'search',
 *                                 requestClass:'search', at:0});
 */
export function createArchiveState(outcome: OutcomeClassifier): ArchiveStateModule {
    /**
     * The whole transition table. Pure: same inputs, same output, no
     * clock read and no I/O.
     *
     * Inputs: state - from `initial()` or a prior `reduce()`.
     *   action - one of:
     *   {type:'ROUTE', route}
     *     Replace the route. Touches no view.
     *   {type:'REQUEST', view, requestClass, at, patch}
     *     A NEW question. Clears the view's rows, sets `loading` and
     *     stamps deadlineAt = at + DEADLINES_MS[requestClass]. Legal
     *     from every token, including `partial` - asking something new
     *     is always allowed, it just discards the incomplete answer.
     *   {type:'RESUME', view, at}
     *     Continue a stopped scan. LEGAL ONLY FROM `partial`, and only
     *     when the view holds a resumeCursor. Keeps the rows already
     *     found and sets resuming=true so the next response appends.
     *   {type:'RESPONSE', view, envelope, at}
     *     Apply a server envelope. DROPPED unless the view is `loading`.
     *   {type:'TRANSPORT_ERROR', view, reason}
     *     The fetch itself failed. Always accepted; a dead network is
     *     news whatever the view was doing.
     *   {type:'TICK', view, at}
     *     Feed the clock in. Expires an overdue `loading`.
     *   {type:'RESET', view}
     *     Back to idle, rows cleared.
     * Output: a NEW state, or the SAME object when the action was
     *   rejected. IDENTITY IS THE SIGNAL: `next === prev` means nothing
     *   moved, which a caller can assert on.
     */
    function reduce(
        state: ArchiveStateShape, action: ArchiveActionMessage,
    ): ArchiveStateShape {
        if (!action || typeof action !== 'object') return state;
        const type = action.type;

        if (type === 'ROUTE') {
            return withView(state, 'route', action.route || state.route);
        }

        const view = action.view;
        if (!view || !state[view] || view === 'route' || view === 'liveSession') {
            return state;
        }
        const slice = state[view] as ViewSlice;
        const rowKey = ROW_KEY[view];

        if (type === 'RESET') {
            const cleared = patchSlice(slice, {
                token: IDLE, reasons: [], deadlineAt: null,
                requestClass: null, resuming: false,
            });
            if (rowKey) cleared[rowKey] = [];
            return withView(state, view, cleared);
        }

        if (type === 'REQUEST') {
            const cls = action.requestClass as string;
            const ms = DEADLINES_MS[cls];
            // An undeclared request class would be a loading state with
            // no deadline, which is exactly the shape invariant 1
            // forbids.
            if (typeof ms !== 'number') return state;
            let started = patchSlice(slice, action.patch || {});
            started = patchSlice(started, {
                token: LOADING,
                reasons: [],
                requestClass: cls,
                deadlineAt: (action.at as number) + ms,
                resuming: false,
            });
            if (rowKey) started[rowKey] = [];
            return withView(state, view, started);
        }

        if (type === 'RESUME') {
            // Invariant 3. `partial` is the ONLY token a resume is
            // meaningful from, and a partial the server gave no
            // resume_cursor for is not continuable at all.
            if (slice.token !== 'partial') return state;
            if (!slice.resumeCursor) return state;
            const resumed = patchSlice(slice, {
                token: LOADING,
                requestClass: slice.requestClass || 'search',
                deadlineAt: (action.at as number)
                    + (DEADLINES_MS[slice.requestClass as string] || DEADLINES_MS.search!),
                resuming: true,
            });
            return withView(state, view, resumed);
        }

        if (type === 'TRANSPORT_ERROR') {
            return withView(state, view, patchSlice(slice, {
                token: 'transport-error',
                reasons: [{ subject: view,
                            reason: String(action.reason || 'the request failed') }],
                deadlineAt: null,
                resuming: false,
            }));
        }

        if (type === 'TICK') {
            if (slice.token !== LOADING || slice.deadlineAt === null) return state;
            if ((action.at as number) < slice.deadlineAt) return state;
            const waited = Math.round(
                (DEADLINES_MS[slice.requestClass as string] || 0) / 1000);
            return withView(state, view, patchSlice(slice, {
                token: 'transport-error',
                reasons: [{ subject: view, reason: 'no response in ' + waited + 's' }],
                deadlineAt: null,
                resuming: false,
            }));
        }

        if (type === 'RESPONSE') {
            // Invariant 2. A response that did not answer an outstanding
            // request is dropped, not applied.
            if (slice.token !== LOADING) return state;

            const classified = outcome.classify(action.envelope);
            const meta = classified.meta;
            const landed = patchSlice(slice, {
                token: classified.token,
                reasons: classified.reasons,
                deadlineAt: null,
                resuming: false,
            });

            if (rowKey) {
                const incoming = outcome.isRenderable(classified.token)
                    ? rowsFrom(action.envelope, view) : [];
                landed[rowKey] = slice.resuming
                    ? (slice[rowKey] as unknown[]).concat(incoming) : incoming;
            }
            if (view === 'search') {
                landed.scan = (meta && (meta as { scan?: unknown }).scan) || null;
                landed.resumeCursor = resumeCursorFrom(meta);
            }
            if (view === 'list') {
                landed.nextCursor = nextCursorFrom(meta);
                landed.hasMore = outcome.hasMore(action.envelope);
            }
            if (view === 'reader') {
                // A spine is complete only on a plain `ok`. `partial`
                // means the far end was never read, so claiming
                // completeness there would hide the missing tail.
                landed.spineComplete = classified.token === 'ok';
            }
            return withView(state, view, landed);
        }

        return state;
    }

    return { initial, reduce, DEADLINES_MS, ROW_KEY, IDLE, LOADING };
}
