/**
 * OPENING, PAGING AND DRILLING for the conversation view.
 *
 * SAME SPLIT SLICE 7 MADE, for the same reason. `reader-open.ts` took
 * the reader's orchestration out of its component so the state could
 * stay in the reactive graph while the sequencing became two plain
 * functions a test can call. This does that for the chat view, and it is
 * what keeps `ChatView.svelte` under this project's 500-line guideline.
 *
 * THE STALE-RESPONSE TICKET LIVES HERE, which is the whole point of the
 * module. Every navigation takes a new ticket; a response whose ticket no
 * longer matches is DISCARDED rather than rendered, because a late answer
 * painted over the current level is a wrong conversation that looks
 * entirely plausible - the reader has no way to tell that the turns in
 * front of them belong to the subagent they left two clicks ago.
 *
 * DRILLING RE-FETCHES, IT DOES NOT CACHE. A subagent is a transcript and
 * is read exactly as its parent was. Caching the chain would mean a level
 * rendered from a snapshot taken before the reader drilled, and nothing
 * would say which levels were stale.
 *
 * No DOM beyond the one scroll write the caller hands in, no framework.
 */
import {
    appendTurns, applyTurns, emptyChat, fetchTurns, loadingChat, noRouteEnvelope,
    TOKEN_CANNOT_DETERMINE, type ChatState,
} from './chat-load';
import type { ChatStack } from './chat-stack';
import type { SubagentControl } from './chat-subagents';
import type { SubagentTarget } from './chat-props';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';

/** The answer when a response arrived for a level nobody is on any more. */
export const SUPERSEDED = 'superseded';
/** The answer when there is no cursor to ask a further page with. */
export const NO_CURSOR = 'no-cursor';
/** The answer when a control the server could not link was activated. */
export const NOT_OPENABLE = 'not-openable';

/** What the open API needs from the view. */
export interface ChatOpenContext {
    readonly client: ArchiveClient;
    readonly outcome: OutcomeClassifier;
    readonly pageTurns: number;
    /** The drill chain. */
    readonly stack: ChatStack;
    /** The state the view holds. */
    state(): ChatState;
    /** Replace it. */
    setState(next: ChatState): void;
    /** Forget every open panel and return to the top of the new level. */
    resetForLevel(): void;
    /** Rebuild the geometry from the current items. */
    reseed(): void;
    /** Queue one measurement pass. */
    schedule(): void;
    /** The chain moved. */
    chainMoved(): void;
    /** Tell a host where the chain now is, when one asked. */
    announce(target: SubagentTarget | null, depth: number): void;
}

/** The four navigation verbs. */
export interface ChatOpenApi {
    /** Start a NEW chain at one transcript and load it. */
    open(transcriptId: number | string, label: string | null): Promise<string>;
    /** Load whatever level the chain currently names. */
    loadCurrent(): Promise<string>;
    /** Append the next page of the level being shown. */
    loadMore(): Promise<string>;
    /** Descend into one subagent. */
    drillInto(control: SubagentControl): Promise<string>;
    /** Go back up to one level, dropping everything below it. */
    goUp(index: number): Promise<string> | null;
}

/**
 * The ordinal a control claims, as a number, or null.
 *
 * Description: parsed from the rendered `data-ordinal` rather than from
 *   the row, because that attribute carries the word `unknown` whenever
 *   the ordering basis could not be established - and a rank nobody
 *   measured must not reach the breadcrumb as a number.
 * Inputs: control.
 * Output: the rank, or null.
 */
function ordinalOf(control: SubagentControl): number | null {
    return /^[0-9]+$/.test(control.ordinalData) ? Number(control.ordinalData) : null;
}

/**
 * Build the navigation for one conversation view.
 *
 * Inputs: ctx - the view's state, chain and scheduling hooks.
 * Output: a ChatOpenApi.
 * Example: const nav = createChatOpenApi(ctx); await nav.open(4, 'main');
 */
export function createChatOpenApi(ctx: ChatOpenContext): ChatOpenApi {
    /** THE STALE-RESPONSE GUARD. See the file header. */
    let ticket = 0;

    async function loadCurrent(): Promise<string> {
        const level = ctx.stack.current();
        ticket += 1;
        const mine = ticket;
        ctx.resetForLevel();

        if (!level || level.transcriptId === null) {
            ctx.setState({
                ...emptyChat(),
                token: TOKEN_CANNOT_DETERMINE,
                envelope: noRouteEnvelope(
                    'unknown', null, 'no transcript id for this level',
                ),
            });
            ctx.reseed();
            return TOKEN_CANNOT_DETERMINE;
        }

        ctx.setState(loadingChat());
        ctx.reseed();
        const result = await fetchTurns(ctx.client, level.transcriptId, {
            limit: ctx.pageTurns,
        });
        if (mine !== ticket) return SUPERSEDED;
        const next = applyTurns(level.transcriptId, result, ctx.outcome);
        ctx.setState(next);
        ctx.reseed();
        ctx.schedule();
        return next.token;
    }

    async function loadMore(): Promise<string> {
        const level = ctx.stack.current();
        const held = ctx.state();
        if (!level || level.transcriptId === null || held.cursor === null) {
            return NO_CURSOR;
        }
        const mine = ticket;
        const result = await fetchTurns(ctx.client, level.transcriptId, {
            limit: ctx.pageTurns, cursor: held.cursor,
        });
        // A page that arrived for a level the reader has left is dropped
        // whole: appending it would interleave two conversations.
        if (mine !== ticket) return SUPERSEDED;
        const next = appendTurns(ctx.state(), result, ctx.outcome);
        ctx.setState(next);
        ctx.reseed();
        ctx.schedule();
        return next.token;
    }

    return {
        open(transcriptId: number | string, label: string | null): Promise<string> {
            // Opening from a list is a NEW QUESTION, not a step deeper
            // into the previous one, so the chain is reset rather than
            // pushed.
            ctx.stack.reset({ transcriptId, label });
            ctx.chainMoved();
            return loadCurrent();
        },

        loadCurrent,
        loadMore,

        drillInto(control: SubagentControl): Promise<string> {
            // A run the server could not link is disabled AND carries
            // `data-openable="false"`. Checking the FACT rather than
            // trusting the attribute means a synthetic click cannot drill
            // into a transcript that was never identified.
            if (!control.openable || control.transcriptId === null) {
                return Promise.resolve(NOT_OPENABLE);
            }
            ctx.stack.push({
                transcriptId: control.transcriptId,
                label: control.name,
                agentId: control.agentId,
                ordinal: ordinalOf(control),
            });
            ctx.chainMoved();
            ctx.announce({
                transcriptId: control.transcriptId,
                agentId: control.agentId,
                label: control.name,
                ordinal: ordinalOf(control),
            }, ctx.stack.depth());
            return loadCurrent();
        },

        goUp(index: number): Promise<string> | null {
            // An index naming no level is a NO-OP, not a truncation to
            // nothing: a chain with no root cannot say which transcript
            // it lost.
            if (ctx.stack.truncateTo(index) === null) return null;
            ctx.chainMoved();
            ctx.announce(null, ctx.stack.depth());
            return loadCurrent();
        },
    };
}
