/**
 * THE READER'S PAGER: the single entry point for "load the next window"
 * of transcript lines, and the in-flight guard that keeps its two
 * callers from racing.
 *
 * Ported from `client/js/archive-reader-paging.js`.
 *
 * WHY THIS IS ITS OWN FILE. The paging guard is the one piece of reader
 * state with TWO independent callers - the pager button and the `m` key
 * - and a second parallel path would let a key double-fetch while the
 * button is mid-flight and append two pages out of order. Keeping the
 * guard, the button's visible states and the settle-on-reject behaviour
 * in one file makes that invariant readable in one screen.
 *
 * THREE OUTCOMES THAT ARE NOT A FETCH, AND THEY ARE NAMED STRINGS,
 * NEVER NULL: `PAGE_NO_PAGER` ("nobody wired a callback"),
 * `PAGE_COMPLETE` ("there is nothing left to load") and `PAGE_FAILED`
 * ("the page was asked for and did not come back") are three different
 * findings, and a caller that cannot tell them apart cannot report
 * honestly.
 *
 * A REJECTION CLEARS THE IN-FLIGHT STATE EXACTLY LIKE A RESOLUTION. A
 * failed page that left the button disabled would be a dead end that
 * LOOKS LIKE THE END OF THE TRANSCRIPT - the worst shape this failure
 * can take, because it is indistinguishable from success. The refusal
 * itself is rendered by the fetch owner into the pane, not by the
 * button, so the button always returns to idle.
 *
 * No DOM, no framework. The button is `TranscriptReader.svelte`'s; this
 * owns only whether one may be pressed and what pressing it does.
 */

/**
 * Rows one paging request asks for - the server's own page size for the
 * line index. The pager label states it, so nobody has to guess how far
 * one click moves.
 */
export const DEFAULT_PAGE_ROWS = 500;

/** Nobody wired a callback. Nothing was fetched. */
export const PAGE_NO_PAGER = 'no-pager';
/** There is nothing left to load. */
export const PAGE_COMPLETE = 'complete';
/** The page was asked for and did not come back. */
export const PAGE_FAILED = 'failed';

/** What the pager needs from the reader. All GETTERS; see below. */
export interface PagerContext {
    /**
     * The current callback, or null.
     *
     * Description: a GETTER rather than a captured value because a
     *   composition root may install one after construction. A captured
     *   value would go stale and nothing would say so.
     */
    onLoadMore(): (() => Promise<unknown>) | null;
    /** Whether the last page has arrived. */
    spineComplete(): boolean;
    /** Repaint, so the button's busy state becomes visible. */
    notify(): void;
}

/** The pager's public shape. */
export interface Pager {
    /** THE SINGLE ENTRY POINT for "load the next window". */
    requestMoreLines(): Promise<unknown>;
    /** Is a page in flight? Drives `disabled` and `aria-busy`. */
    isLoadingMore(): boolean;
    /** The button's label, which states the page size. */
    label(rows: number): string;
}

/**
 * Build the pager for one reader instance.
 *
 * Description: the in-flight promise is held HERE, so there is exactly
 *   one of it per reader.
 * Inputs: ctx - the reader's own getters.
 * Output: a Pager.
 * Example:
 *   const pager = createPager(ctx);
 *   await pager.requestMoreLines();   // the `m` key or the button
 */
export function createPager(ctx: PagerContext): Pager {
    /** The live paging promise, or null. THE GUARD. */
    let inFlight: Promise<unknown> | null = null;

    function requestMoreLines(): Promise<unknown> {
        if (inFlight) return inFlight;
        if (ctx.spineComplete()) return Promise.resolve(PAGE_COMPLETE);
        const onLoadMore = ctx.onLoadMore();
        if (!onLoadMore) {
            // A NAMED refusal, not a throw and not a silent no-op: a
            // composition root that forgot the wiring must be able to
            // read which of the three things happened.
            return Promise.resolve(PAGE_NO_PAGER);
        }
        const settle = (): void => { inFlight = null; ctx.notify(); };
        inFlight = Promise.resolve()
            .then(() => onLoadMore())
            .then(
                (v) => { settle(); return v; },
                () => {
                    // A rejection clears the guard exactly like a
                    // resolution. See the file header.
                    settle();
                    return PAGE_FAILED;
                },
            );
        ctx.notify();
        return inFlight;
    }

    return {
        requestMoreLines,
        isLoadingMore: () => inFlight !== null,
        label: (rows: number) => (inFlight !== null
            ? `Loading ${rows} more lines...`
            : `Load ${rows} more lines`),
    };
}
