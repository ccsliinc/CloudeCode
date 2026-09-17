/**
 * THE MEASUREMENT FRAME: one coalesced pass that reads the painted rows'
 * real heights, applies them, and pays the anti-jump scroll debt.
 *
 * WHY IT IS A COALESCED FRAME AND NOT AN EFFECT PER ROW. A burst of
 * resolved body fetches would otherwise reconcile once each, and every
 * reconcile is a layout read across the whole window. One pass per
 * animation frame is the whole point, and the guard that makes it one is
 * held here so there is exactly one of it per reader.
 *
 * THE DEBT IS PAID INSIDE THE SAME CALL AS THE HEIGHT WRITE.
 * `reconcileMeasured` writes `scrollTop` before returning; see
 * `reader-virtual.ts` for why deferring it to a later frame is WORSE
 * than not compensating at all. Nothing in this file may move that
 * write later.
 *
 * THE SCHEDULER IS INJECTED. It is the third `app-screen` gap (see
 * `TranscriptReader.svelte`'s header): jsdom fires no real animation
 * frame, so a reader reaching for the global would leave its own
 * measurement pass unmeasured in every test.
 */
import {
    reconcileMeasured, scrollTopOf, viewportHeight,
} from './reader-measure.svelte';
import type { VirtualList } from './reader-virtual';

/** What the frame pass needs from the reader. */
export interface FrameContext {
    /** The geometry engine. */
    readonly list: VirtualList;
    /** The scroller, or null before it is bound. */
    scroller(): HTMLElement | null;
    /** The element holding the painted rows, or null. */
    windowEl(): HTMLElement | null;
    /** The scroll offset the window was last derived against. */
    scrollTop(): number;
    /** The viewport height the window was last derived against. */
    viewport(): number;
    /** Publish a corrected content height and re-read the scroll offset. */
    applied(totalHeight: number, scrollTop: number): void;
    /** Run one frame. Injected so a test can drive it synchronously. */
    raf(fn: () => void): void;
}

/** The frame pass. */
export interface FramePass {
    /** Queue one measurement pass, coalescing repeats into one. */
    schedule(): void;
    /** Read the scroller's live geometry. */
    geometry(): { scrollTop: number; viewport: number };
}

/**
 * Build the measurement frame for one reader instance.
 *
 * Inputs: ctx - the reader's geometry, elements and scheduler.
 * Output: a FramePass.
 * Example: const f = createFramePass(ctx); f.schedule();
 */
export function createFramePass(ctx: FrameContext): FramePass {
    /** Whether one pass is already queued. THE COALESCING GUARD. */
    let queued = false;

    function schedule(): void {
        if (queued) return;
        queued = true;
        ctx.raf(() => {
            queued = false;
            const w = ctx.list.windowFor(ctx.scrollTop(), ctx.viewport() || 0);
            const r = reconcileMeasured(ctx.list, ctx.windowEl(), w, ctx.scroller());
            // NOTHING APPLIED, NOTHING PUBLISHED. Re-publishing an
            // unchanged height would re-derive the window on every frame
            // for as long as the reader is open.
            if (r.applied > 0) {
                // The delta was already written to scrollTop INSIDE
                // reconcileMeasured, in the same call. Re-read it so the
                // window derives from what the scroller actually holds.
                ctx.applied(r.totalHeight, scrollTopOf(ctx.scroller()));
            }
        });
    }

    return {
        schedule,
        geometry: () => ({
            scrollTop: scrollTopOf(ctx.scroller()),
            viewport: viewportHeight(ctx.scroller()),
        }),
    };
}
