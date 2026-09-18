/**
 * THE CONVERSATION VIEW'S FETCH LAYER, AS PURE REDUCERS. Ported from
 * `client/js/archive-chat-screen.js`, which owned the network because
 * the view file was already over this repo's 500-line cap.
 *
 * SAME SHAPE AS SLICE 7's `reader-load.ts`, DELIBERATELY. That module
 * pairs a `fetchX` that only issues a request with an `applyX(state,
 * result, outcome)` that only folds one in, so the whole contract is
 * testable without a network, a document or a component. This does the
 * same for `/messages`, and for the same reason.
 *
 * THE MISSING ENDPOINT IS THE STATE THIS FILE EXISTS FOR. The route this
 * view reads was built in parallel with it, so "the route is not there"
 * is a real, expected, first-class outcome rather than a hypothetical.
 * It is NOT an empty conversation and NOT a generic transport error: it
 * is a could-not-determine that names the endpoint and says the server
 * has no such route. Rendering an empty chat pane would assert that a
 * transcript with 30,805 lines contains no messages, which is a verdict
 * nobody measured.
 *
 * A 404 FROM A MISSING ROUTE AND A 404 FROM A MISSING TRANSCRIPT ARE
 * DIFFERENT FINDINGS, and they are told apart STRUCTURALLY: the archive
 * routes answer a missing transcript with a COMPLETE envelope carrying
 * `result_status: 'not_found'`, while an unrouted path answers FastAPI's
 * `{"detail": "Not Found"}`, which carries no `result_status` at all. So
 * the discriminator is the presence of the envelope's own status field,
 * not the HTTP code.
 *
 * COMPLETENESS IS THREE-VALUED. `hasMore` answers null on every failure
 * path, and null is NOT false: treating it as false would end the
 * conversation on the strength of a number nobody read.
 *
 * No DOM, no framework, no globals.
 */
import { CHAT_IDLE, CHAT_LOADING } from './chat-vocab';
import { isRun, type ChatItem, type ChatTurnRaw } from './chat-turn';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** The token this module answers with when nothing came back at all. */
export const TOKEN_CANNOT_DETERMINE = 'cannot_determine';

/**
 * Turns requested per page.
 *
 * Description: deliberately smaller than the raw reader's 500-row spine
 *   page, because a turn carries its blocks inline and a page of turns
 *   is far more bytes than a page of spine rows.
 */
export const DEFAULT_PAGE_TURNS = 200;

/** Everything one load can change. Replaced, never mutated. */
export interface ChatState {
    /** The laid-out items: turns, with runs of progress records folded. */
    readonly items: readonly ChatItem[];
    /**
     * Are these ALL the turns. THREE-OUTCOME: `true` means the server
     * said there is no more, `false` means it said there is, and `null`
     * means it did not say - which is not the same as "no more" and must
     * never render as the end of a conversation.
     */
    readonly complete: boolean | null;
    /** The outcome token, or 'idle' / 'loading'. */
    readonly token: string;
    /** The envelope backing a failure or a partial, or null. */
    readonly envelope: unknown;
    /** The cursor for the next page, or null when there is none to ask. */
    readonly cursor: string | null;
    /** Why there is no envelope, or null when the server answered. */
    readonly transportError: string | null;
}

/** The state a view starts in, before anything has been asked. */
export function emptyChat(): ChatState {
    return {
        items: [],
        complete: null,
        token: CHAT_IDLE,
        envelope: null,
        cursor: null,
        transportError: null,
    };
}

/** The state to paint while a load is in flight. */
export function loadingChat(): ChatState {
    return { ...emptyChat(), token: CHAT_LOADING };
}

/**
 * Build the envelope for "this server has no such route".
 *
 * Description: SYNTHETIC because there is no envelope to classify - the
 *   server never produced one. Everything about it is stated, including
 *   that it is this client's own construction.
 * Inputs: transcriptId, httpStatus - null when nothing answered.
 *   transportError - the transport's own words, or null.
 * Output: an envelope any classifier reads as cannot_determine.
 * Example: noRouteEnvelope(4, 404, null)
 */
export function noRouteEnvelope(
    transcriptId: unknown, httpStatus: number | null, transportError: string | null,
): Record<string, unknown> {
    return {
        result: null,
        result_status: TOKEN_CANNOT_DETERMINE,
        scope_status: 'resolved',
        unevaluated: [{
            subject: `GET /archive/transcripts/${String(transcriptId)}/messages`,
            reason: `this server answered `
                + `${httpStatus === null ? 'nothing' : `HTTP ${httpStatus}`}`
                + ' with no archive envelope'
                + (transportError ? ` (${transportError})` : '')
                + '. The conversation view could not be built. This is NOT a '
                + 'claim that the transcript is empty. The raw view reads the '
                + 'same transcript from a different endpoint and is unaffected.',
        }],
        meta: {},
    };
}

/**
 * Pull the turns out of a messages envelope, whatever shape it chose.
 *
 * Description: `result` may BE the array or may hold it under `turns`;
 *   both are accepted, and neither is invented. `null` means the
 *   envelope was renderable but carried no array, which is a
 *   could-not-determine of its own rather than an empty conversation.
 * Inputs: envelope.
 * Output: the turns, or null.
 * Example: turnsOf({result: {turns: []}}) // -> []
 */
export function turnsOf(envelope: unknown): ChatTurnRaw[] | null {
    if (!envelope || typeof envelope !== 'object') return null;
    const r = (envelope as { result?: unknown }).result;
    if (Array.isArray(r)) return r as ChatTurnRaw[];
    if (r && typeof r === 'object' && Array.isArray((r as { turns?: unknown }).turns)) {
        return (r as { turns: ChatTurnRaw[] }).turns;
    }
    return null;
}

/**
 * The cursor for the next page, or null when there is none.
 *
 * Description: a cursor that is not a NON-EMPTY STRING is not a cursor,
 *   and sending one would be asking the server a question built out of
 *   whatever happened to be in that field.
 * Inputs: envelope.
 * Output: the cursor, or null.
 * Example: nextCursorOf({meta: {paging: {next_cursor: 'eyJ9'}}}) // -> 'eyJ9'
 */
export function nextCursorOf(envelope: unknown): string | null {
    const meta = (envelope as { meta?: unknown } | null)?.meta;
    if (!meta || typeof meta !== 'object') return null;
    const paging = (meta as { paging?: unknown }).paging;
    if (!paging || typeof paging !== 'object') return null;
    const c = (paging as { next_cursor?: unknown }).next_cursor;
    return (typeof c === 'string' && c !== '') ? c : null;
}

/**
 * Fold runs of consecutive `progress` turns into one chip each.
 *
 * Description: SAME RULE AS SLICE 7's `groupRows`, applied to turns.
 *   Progress records are 917,436 rows and 37.5 percent of every body in
 *   this corpus; rendering them as bubbles buries the conversation in
 *   its own telemetry. A run of ONE is left as an ordinary row, because
 *   a chip saying "1 progress record (lines 7110 to 7110)" is worse than
 *   the row it replaced.
 *
 *   THE VANILLA HAD THE MARKUP AND NEVER FED IT: `archive-chat-turn.js`
 *   renders a `progress-run` item and `archive-chat-screen.js` passed
 *   the server's rows straight through, so the chip could not appear.
 *   Folding here is what makes that renderer reachable.
 * Inputs: turns - the server's rows, in order.
 * Output: the laid-out items.
 * Example: groupTurns([p1, p2, u]).length // -> 2
 */
export function groupTurns(turns: readonly ChatTurnRaw[] | null | undefined): ChatItem[] {
    const out: ChatItem[] = [];
    if (!Array.isArray(turns)) return out;
    const isProgressAt = (k: number): boolean => turns[k]?.record_type === 'progress';

    let i = 0;
    while (i < turns.length) {
        const head = turns[i];
        if (head === undefined) { i += 1; continue; }
        if (isProgressAt(i)) {
            let j = i;
            while (j + 1 < turns.length && isProgressAt(j + 1)) j += 1;
            if (j > i) {
                out.push({
                    kind: 'progress-run',
                    from: head.line_no as number,
                    to: (turns[j] as ChatTurnRaw).line_no as number,
                    count: (j - i) + 1,
                });
                i = j + 1;
                continue;
            }
        }
        out.push(head);
        i += 1;
    }
    return out;
}

/**
 * Issue one page request.
 *
 * Description: the ONLY place a transcript id becomes network traffic
 *   for this view. RESOLVES on every path, including a dead network,
 *   because `EnvelopeResult` carries the failure rather than rejecting.
 * Inputs: client, transcriptId, opts - `limit` and an optional `cursor`.
 * Output: the response.
 * Example: await fetchTurns(client, 4, {limit: 200})
 */
export function fetchTurns(
    client: ArchiveClient,
    transcriptId: number | string,
    opts: { readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<EnvelopeResult> {
    return client.listArchiveMessages(transcriptId, {
        limit: opts.limit ?? DEFAULT_PAGE_TURNS,
        cursor: opts.cursor ?? null,
    });
}

/** Is this an archive envelope at all, or something else answering? */
function isEnvelope(env: unknown): boolean {
    return !!env && typeof env === 'object'
        && typeof (env as { result_status?: unknown }).result_status === 'string';
}

/** Turn a three-valued `has_more` into a three-valued `complete`. */
function completeFrom(more: boolean | null): boolean | null {
    if (more === false) return true;
    if (more === true) return false;
    return null;
}

/**
 * Fold one FIRST page into the view's state.
 *
 * Description: PURE. A transport failure, an unrouted path, an envelope
 *   the server could not evaluate, and a renderable envelope carrying no
 *   turns array are four different findings and each reaches the view as
 *   its own token rather than as an empty conversation.
 * Inputs: transcriptId - only so a refusal can name the endpoint.
 *   result - the response. outcome - the injected classifier.
 * Output: the next state.
 * Example: applyTurns(4, r, outcome).token // -> 'ok'
 */
export function applyTurns(
    transcriptId: unknown, result: EnvelopeResult | null, outcome: OutcomeClassifier,
): ChatState {
    const env = result ? result.envelope : null;
    if (!isEnvelope(env)) {
        return {
            ...emptyChat(),
            token: TOKEN_CANNOT_DETERMINE,
            envelope: noRouteEnvelope(
                transcriptId,
                result ? result.httpStatus : null,
                result ? result.transportError : null,
            ),
            transportError: result ? result.transportError : null,
        };
    }
    const classified = outcome.classify(env);
    if (!outcome.isRenderable(classified.token)) {
        return { ...emptyChat(), token: classified.token, envelope: env };
    }
    const rows = turnsOf(env);
    if (rows === null) {
        return {
            ...emptyChat(),
            token: TOKEN_CANNOT_DETERMINE,
            envelope: {
                result: null,
                result_status: TOKEN_CANNOT_DETERMINE,
                scope_status: 'resolved',
                unevaluated: [{
                    subject: `transcript ${String(transcriptId)} messages`,
                    reason: 'the server reported success but the response carried '
                        + 'no turns array, so what this conversation contains is '
                        + 'NOT KNOWN.',
                }],
                meta: (env as { meta?: unknown }).meta || {},
            },
        };
    }
    return {
        items: groupTurns(rows),
        complete: completeFrom(outcome.hasMore(env)),
        token: classified.token,
        // A PARTIAL keeps its envelope, because a partial answer has real
        // turns in it that the reader should see ALONGSIDE what was not
        // reached.
        envelope: classified.token === 'ok' ? null : env,
        cursor: nextCursorOf(env),
        transportError: null,
    };
}

/**
 * Fold one FURTHER page into the view's state, appending.
 *
 * Description: A FAILED PAGE DOES NOT WIPE THE CONVERSATION. It leaves
 *   the turns already on screen exactly where they are and flips
 *   completeness back to NOT KNOWN, so the sentinel tells the truth -
 *   some turns are loaded and whether there are more could not be
 *   established this time - rather than either claiming the end or
 *   blanking the pane.
 *
 *   THE FOLD IS RE-RUN OVER THE WHOLE LIST, not over the new page alone:
 *   a run of progress records at the end of the old page continues into
 *   the start of the new one, and folding the halves separately would
 *   produce two adjacent chips for one run.
 * Inputs: state, result, outcome.
 * Output: the next state.
 * Example: appendTurns(state, r, outcome).items.length
 */
export function appendTurns(
    state: ChatState, result: EnvelopeResult | null, outcome: OutcomeClassifier,
): ChatState {
    const env = result ? result.envelope : null;
    if (!isEnvelope(env)) {
        return { ...state, complete: null, transportError: result?.transportError ?? null };
    }
    const classified = outcome.classify(env);
    if (!outcome.isRenderable(classified.token)) {
        return { ...state, complete: null, envelope: env, token: classified.token };
    }
    const rows = turnsOf(env);
    if (rows === null) return { ...state, complete: null };

    const held = flattenRuns(state.items);
    return {
        ...state,
        items: groupTurns(held.concat(rows)),
        complete: completeFrom(outcome.hasMore(env)),
        token: classified.token,
        envelope: classified.token === 'ok' ? null : env,
        cursor: nextCursorOf(env),
        transportError: null,
    };
}

/**
 * The turns behind a laid-out list, with folded runs removed.
 *
 * Description: A FOLD IS LOSSY BY CONSTRUCTION here - a run chip carries
 *   only its range and its count, not the rows it replaced - so the
 *   re-fold above reconstructs a run's rows as SYNTHETIC progress turns
 *   carrying their line numbers. That is enough for `groupTurns` to
 *   re-fold them identically and it never reaches a renderer, because a
 *   run of two or more always folds back into a chip.
 * Inputs: items.
 * Output: turns, in order.
 */
function flattenRuns(items: readonly ChatItem[]): ChatTurnRaw[] {
    const out: ChatTurnRaw[] = [];
    for (const it of items) {
        if (!isRun(it)) { out.push(it as ChatTurnRaw); continue; }
        for (let n = it.from; n <= it.to; n += 1) {
            out.push({ record_type: 'progress', line_no: n });
        }
    }
    return out;
}

/**
 * The sentence a non-complete conversation ends with.
 *
 * Description: A CONVERSATION THAT JUST STOPS LOOKS FINISHED. Measured
 *   live 2026-09-01, transcript 4 answers `has_more: true` at a 400-turn
 *   page, so a reader would hit turn 400 of a much longer session with
 *   nothing on screen saying so and would reasonably conclude that was
 *   the end of it. "There is more" and "I was not told whether there is
 *   more" are different findings and only one of them justifies a pager,
 *   so they get different sentences.
 * Inputs: loaded - how many items are held. complete - the three-valued
 *   flag.
 * Output: the sentence.
 * Example: sentinelText(400, false)
 */
export function sentinelText(loaded: number, complete: boolean | null): string {
    if (complete === false) {
        return `THIS IS NOT THE END OF THE CONVERSATION. ${loaded} turn(s) `
            + 'loaded so far; the server says there are more.';
    }
    return `WHETHER THERE IS MORE: NOT KNOWN. ${loaded} turn(s) loaded. The `
        + 'server did not say whether this is the end, so this view is not '
        + 'claiming it is.';
}

/**
 * The sentence shown when there is more and no way to ask for it.
 *
 * Description: NO BUTTON WITHOUT A HANDLER. A control that cannot do
 *   anything is worse than the sentence alone, because it offers a way
 *   forward that does not exist. A server can say `has_more` without
 *   handing back a `next_cursor`, which is exactly this case.
 */
export const NO_PAGER_TEXT = 'There is no way to ask for the rest from here: '
    + 'the server reported more turns but handed back no cursor. Open the raw '
    + 'view to read past this point.';
