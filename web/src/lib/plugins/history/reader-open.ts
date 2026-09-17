/**
 * OPENING A TRANSCRIPT, PAGING IT FORWARD, AND LANDING ON A DEEP-LINKED
 * LINE: the three verbs that drive `reader-load.ts`'s pure reducers
 * against a live client and a live scroller.
 *
 * Ported from `client/js/archive-screen-reader.js`, which was its own
 * file because the composition root was over this repo's 500-line cap
 * with it inline. The same is true here, and the seam is the same: this
 * is the ONE place that turns a transcript id into the inputs the reader
 * renders.
 *
 * THE STATE IS NOT HELD HERE. Svelte's `$state` lives in the component,
 * so this takes a reader and a writer for the spine rather than owning
 * it. That keeps the reactive graph in one file and the ORCHESTRATION in
 * this one, and it means every branch below is testable by handing it
 * two plain functions.
 *
 * A DEEP LINK ASKS THE SERVER FOR THE WINDOW IT WANTS. Before
 * `start_line` existed, a deep link fetched page one and then reported
 * it could not reach the line, which was honest and useless.
 *
 * No DOM beyond the scroller it is handed, and no framework.
 */
import {
    appendSpine, applySpine, fetchSpine, loadingSpine, nextStartLine,
    type SpineState,
} from './reader-load';
import { indexOfLine, type ProgressRun, type ReaderItem } from './reader-rows';
import { READER_OK } from './reader-vocab';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { VirtualList } from './reader-virtual';

/** What the open/paging verbs need from the reader. */
export interface OpenContext {
    readonly client: ArchiveClient;
    readonly outcome: OutcomeClassifier;
    readonly transcriptId: number | string;
    /** Rows per request. */
    readonly pageRows: number;
    /** The geometry engine, for the deep-link scroll. */
    readonly list: VirtualList;
    /** Read the current spine state. */
    spine(): SpineState;
    /** Replace the spine state. */
    setSpine(next: SpineState): void;
    /** The current grouped items. */
    items(): readonly ReaderItem[];
    /** Open one progress run by its `from` line number. */
    expandRun(from: number): void;
    /** Re-seed the geometry after an expansion changed the layout. */
    reseed(): void;
    /** The scroller, or null before it is bound. */
    scroller(): HTMLElement | null;
    /** Re-read the live scroll geometry. */
    readGeometry(): void;
    /** Drop every cached body, because this is a NEW transcript. */
    resetForNewTranscript(): void;
}

/** The three verbs. */
export interface OpenApi {
    open(lineNo: number | null): Promise<string>;
    loadMore(): Promise<string>;
    revealLine(line: number): boolean;
}

/**
 * Build the open/paging verbs for one reader instance.
 *
 * Inputs: ctx - the client, the geometry and the reader's accessors.
 * Output: an OpenApi.
 * Example: const o = createOpenApi(ctx); await o.open(null);
 */
export function createOpenApi(ctx: OpenContext): OpenApi {
    /**
     * Put a deep-linked line on screen.
     *
     * Description: a line inside a COLLAPSED run is in the spine and is
     *   NOT on screen. Scrolling to the run without expanding it would
     *   put the reader in the right place and show them a collapsed
     *   block instead of the line they asked for - a landing that
     *   MEASURES as a success and is not one.
     * Inputs: line - the line number to reveal.
     * Output: true when the line was found; FALSE when the loaded rows do
     *   not hold it, which the caller must not treat as a landing.
     */
    function revealLine(line: number): boolean {
        let at = indexOfLine(ctx.items(), line);
        if (at === null) return false;
        if (at.inRun) {
            const run = ctx.items()[at.item] as ProgressRun;
            ctx.expandRun(run.from);
            ctx.reseed();
            at = indexOfLine(ctx.items(), line) || at;
        }
        const sc = ctx.scroller();
        if (sc) sc.scrollTop = ctx.list.offsetOf(at.item);
        ctx.readGeometry();
        return true;
    }

    /**
     * Open one transcript from scratch. Everything before it is dropped.
     *
     * Description: a NEW transcript shares nothing with the old one - a
     *   `line_no` can numerically coincide across two files and mean
     *   different rows - so the cache and the expansions are cleared
     *   before anything is fetched.
     * Inputs: lineNo - open at this line, or null for the first page.
     * Output: the outcome token.
     */
    async function open(lineNo: number | null): Promise<string> {
        ctx.resetForNewTranscript();
        ctx.setSpine(loadingSpine(ctx.spine()));
        const fetched = await fetchSpine(
            ctx.client, ctx.transcriptId, lineNo, ctx.pageRows,
        );
        const next = applySpine(ctx.spine(), fetched, ctx.outcome);
        ctx.setSpine(next);
        if (next.token === READER_OK && lineNo !== null && lineNo !== undefined) {
            revealLine(lineNo);
        }
        return next.token;
    }

    /**
     * Append the next forward page.
     *
     * Description: SECRET MASKING - appended rows go through the same
     *   reseed, paint and `entryFor` path as the first page, so the
     *   masker applies to them identically. EXPANSIONS ARE NOT RESET,
     *   because an append is the SAME transcript and throwing away the
     *   runs a person opened is data loss from their point of view.
     * Output: the outcome token, or a sentence naming why there was no
     *   position to page from. Never a silent no-op.
     */
    async function loadMore(): Promise<string> {
        const start = nextStartLine(ctx.spine().rows);
        if (start.next === undefined) return start.reason as string;
        const page = await ctx.client.listArchiveLines(ctx.transcriptId, {
            limit: ctx.pageRows, startLine: start.next,
        });
        const next = appendSpine(ctx.spine(), page, ctx.outcome);
        ctx.setSpine(next);
        return next.token;
    }

    return { open, loadMore, revealLine };
}
