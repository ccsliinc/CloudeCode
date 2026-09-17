/**
 * VARIABLE-HEIGHT WINDOWING for the transcript reader. Ported from
 * `client/js/archive-virtual-list.js`, arithmetic for arithmetic.
 *
 * WHY THIS IS A SCROLL HANDLER AND NOT AN IntersectionObserver PER ROW.
 * The largest transcript in this corpus is 30,805 lines (id 5767,
 * measured 2026-08-31). One observer per row is 30,805 live compositor
 * registrations, each with its own root-margin geometry, and creating
 * them all blocks the main thread on the exact transcript the feature
 * exists to open. The rejection is structural, not a preference. This
 * engine is a binary search over a Float64Array plus a forward walk:
 * O(log N) to find the window and O(visible) to fill it, and neither
 * term depends on N.
 *
 * WHY IT IS NOT slice 6's `tlist-window.ts`. That module bounds a list
 * of UNIFORM rows from ONE measured height, which is correct there and
 * would be a fabricated measurement here: a transcript row's height is
 * driven by its own `body_chars`, so two adjacent rows routinely differ
 * by a factor of ten. Slice 5 already found that a media query nearly
 * doubles a row; this file never assumes a constant at all. HEIGHTS ARE
 * SEEDED FROM `body_chars` ON THE SPINE and then CORRECTED by real
 * measurements taken off painted rows.
 *
 * THE SCROLLBAR IS HONEST. Total height starts as the sum of estimates
 * and converges as real rows are measured. It is never rounded to a
 * pretty number and no page count is published, because a page count
 * over variable-height rows is a number nobody computed.
 *
 * THE ANTI-JUMP RULE IS THE HARD PART. Every estimate is wrong. When a
 * row ABOVE the viewport turns out to be taller or shorter than its
 * estimate, every row below it moves and the content under the reader's
 * eyes leaps. On a 30,805-line document that loses their place
 * permanently. So `applyMeasurements()` returns the exact pixel delta
 * contributed by rows STRICTLY ABOVE the first visible row, and the
 * caller MUST add it to scrollTop in the SAME frame, before paint.
 * Deferring it to a later frame is worse than not compensating at all,
 * because a one-frame leap reads as a bug rather than as scrolling.
 *
 * NO DOM IN THIS FILE, AND NO SVELTE. It is pure geometry over typed
 * arrays, so the whole windowing algorithm is testable by calling it
 * rather than by measuring a render, and no rendering path can reach
 * around it. The DOM reads live in `reader-measure.svelte.ts`.
 */

/**
 * Gutter plus the role/timestamp line every row carries even when its
 * body is a placeholder. Pixels.
 */
export const ROW_CHROME_PX = 34;

/**
 * Characters that fit on one wrapped line at the reader's monospace
 * measure. Used ONLY to turn `body_chars` into a height guess, never as
 * a rendered width.
 */
export const CHARS_PER_LINE = 96;

/** Rendered line box height in the reader's monospace stack. Pixels. */
export const LINE_HEIGHT_PX = 18;

/**
 * A body is collapsed to at most this height until the reader opens it.
 *
 * Description: this is what keeps the estimate honest at the extremes.
 *   Without it, line 62 of transcript 19243 (54,376,859 chars, measured)
 *   would estimate at roughly 10 million pixels and the scrollbar would
 *   stop resolving every other line in the file.
 */
export const COLLAPSED_MAX_PX = 240;

/**
 * Extra height, on top of ROW_CHROME_PX, for a row whose body was not
 * fetched: the size line plus whatever action the gate offers. Fixed,
 * because there is no body to measure.
 */
export const PLACEHOLDER_EXTRA_PX = 44;

/** Rows rendered above and below the visible window. */
export const OVERSCAN_ROWS = 12;

/**
 * A measured height must differ from the current estimate by more than
 * this before it counts as a correction. Sub-pixel churn from fractional
 * line boxes is not a correction, and treating it as one produces an
 * endless reconcile loop.
 */
export const HEIGHT_EPSILON_PX = 0.5;

/**
 * Fixed height of a COLLAPSED progress run row. Collapsed runs
 * participate in the offset table as ordinary single rows, so expanding
 * one is just a height correction.
 */
export const PROGRESS_ROW_PX = 30;

/** The spine fields the estimator reads. It reads nothing else. */
export interface EstimatableRow {
    readonly kind?: unknown;
    readonly body_chars?: unknown;
    readonly body_state?: unknown;
}

/**
 * Height guess for one spine row, before its body has ever been fetched
 * or measured.
 *
 * Description: driven by `body_chars`, which is present on the spine
 *   even with include_bodies=false (verified live 2026-08-31), so no
 *   fetch is needed to lay out the file.
 * Inputs: row - a spine row. Reads `body_chars`, `body_state` and
 *   `kind` only.
 * Output: pixels, always finite and >= ROW_CHROME_PX.
 * Example: estimateHeight({body_state: 'included', body_chars: 960})
 *   // -> 34 + 18 * ceil(960/96) = 214
 */
export function estimateHeight(row: EstimatableRow | null | undefined): number {
    if (!row || typeof row !== 'object') {
        return ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX;
    }
    if (row.kind === 'progress-run') return PROGRESS_ROW_PX;

    const chars = row.body_chars;
    // A row with no usable char count is a placeholder, not a zero
    // height row. A zero height row is invisible and unclickable, which
    // is a could-not-evaluate rendered as nothing.
    if (!Number.isFinite(chars) || (chars as number) < 0) {
        return ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX;
    }
    // Anything the reader will not render inline gets the fixed
    // placeholder height regardless of how enormous it is.
    if (row.body_state === 'withheld_too_large') {
        return ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX;
    }
    const lines = Math.ceil((chars as number) / CHARS_PER_LINE);
    return Math.min(COLLAPSED_MAX_PX, ROW_CHROME_PX + LINE_HEIGHT_PX * lines);
}

/**
 * Read one cell of a Float64Array as a number.
 *
 * Description: `noUncheckedIndexedAccess` types every indexed read as
 *   `number | undefined`, which is right for a sparse array and wrong
 *   for a Float64Array, whose cells are all present and all zero by
 *   construction. THE ZERO FALLBACK IS THEREFORE UNREACHABLE FOR AN
 *   IN-RANGE INDEX and is what an out-of-range one answers, which is the
 *   same thing the JavaScript would have done with NaN except that zero
 *   keeps the offset table monotonic. Written once rather than cast at
 *   each of the fourteen call sites, so the reasoning sits in one place.
 * Inputs: arr - the array. i - the index.
 * Output: the cell, or 0 when the index is out of range.
 * Example: cell(Float64Array.of(3, 4), 1) // -> 4
 */
function cell(arr: Float64Array, i: number): number {
    const v = arr[i];
    return v === undefined ? 0 : v;
}

/**
 * Height guess for one LAID-OUT item, run or line.
 *
 * Description: an EXPANDED run estimates as its children stacked plus
 *   its own chrome; a collapsed one is a single fixed row. That is why
 *   expanding is an ordinary height correction rather than a second
 *   layout mode, and why the windowing engine needs no notion of a run.
 * Inputs: item - a line or a run. rowsOf - the run's children, or null
 *   for a line. expanded - whether the run is open.
 * Output: pixels, always finite and positive.
 * Example: estimateItem(run, run.rows, true)
 */
export function estimateItem(
    item: EstimatableRow | null | undefined,
    rowsOf: readonly EstimatableRow[] | null,
    expanded: boolean,
): number {
    if (rowsOf && expanded) {
        let sum = 0;
        for (const child of rowsOf) sum += estimateHeight(child);
        return sum + PROGRESS_ROW_PX;
    }
    return estimateHeight(item);
}

/**
 * Index of the last row whose top is <= y. Binary search over a
 * monotonically non-decreasing offset table.
 *
 * Inputs: offsets - length N+1; offsets[N] is the total content height.
 *   y - a pixel position in content space.
 * Output: a row index clamped to [0, N-1].
 * Example: rowAt(Float64Array.of(0, 10, 30, 60), 25) // -> 1
 */
export function rowAt(offsets: Float64Array, y: number): number {
    let lo = 0;
    let hi = offsets.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cell(offsets, mid) <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** What `windowFor` answers. `last` is INCLUSIVE. */
export interface ReaderWindow {
    /** First row to render, overscan included. */
    readonly first: number;
    /** Last row to render, INCLUSIVE, overscan included. -1 when empty. */
    readonly last: number;
    /** First row genuinely on screen. The anti-jump PIVOT. */
    readonly firstVisible: number;
    /** Last row genuinely on screen. */
    readonly lastVisible: number;
    /** Pixel offset of `first`, for the translate. */
    readonly offsetTop: number;
    /** The honest content height. */
    readonly totalHeight: number;
}

/** What `applyMeasurements` answers. */
export interface MeasurementResult {
    /**
     * Pixels the caller MUST add to scrollTop in the SAME frame. See the
     * file header: deferring it is worse than not paying it.
     */
    readonly delta: number;
    /** How many rows changed height. */
    readonly applied: number;
    /** Lowest index rebuilt, -1 when none. */
    readonly lowestChanged: number;
    /** The new content height. */
    readonly totalHeight: number;
}

/** The windowing engine for one list of rows. */
export interface VirtualList {
    setCount(count: number, estimate?: ((index: number) => number) | null): void;
    windowFor(scrollTop: number, viewportHeight: number): ReaderWindow;
    measure(index: number, px: number): boolean;
    applyMeasurements(firstVisibleIndex: number): MeasurementResult;
    totalHeight(): number;
    offsetOf(index: number): number;
    heightOf(index: number): number;
    count(): number;
    pendingCount(): number;
    offsets(): Float64Array;
}

/** What `createList` takes. */
export interface VirtualListOptions {
    /** Rows above and below the viewport. Defaults to OVERSCAN_ROWS. */
    readonly overscan?: number;
    /** The default estimator, used when `setCount` is given none. */
    readonly estimate?: ((index: number) => number) | null;
}

/**
 * Build the windowing engine for one list of rows.
 *
 * Description: holds two Float64Arrays and nothing else. It does not
 *   know what a row looks like and never touches the DOM.
 * Inputs: options - overscan and a default estimator.
 * Output: a VirtualList.
 * Example:
 *   const vl = createList({});
 *   vl.setCount(30805, (i) => estimateHeight(spine[i]));
 *   vl.windowFor(120000, 800);
 */
export function createList(options?: VirtualListOptions): VirtualList {
    const opts = options || {};
    const overscan = Number.isFinite(opts.overscan)
        ? opts.overscan as number : OVERSCAN_ROWS;

    let heights = new Float64Array(0);
    let offsets = new Float64Array(1);
    /** index -> measured height, waiting for the next flush. */
    const pending = new Map<number, number>();

    /**
     * Rebuild `offsets` from index `from` forward.
     *
     * Description: O(N-k) over a Float64Array, microseconds at N =
     *   30,805. A Fenwick tree would be asymptotically nicer and would
     *   make the anti-jump arithmetic considerably harder to get right;
     *   revisit past roughly 500,000 rows.
     */
    function rebuild(from: number): void {
        let i = from < 0 ? 0 : from;
        for (; i < heights.length; i += 1) {
            offsets[i + 1] = cell(offsets, i) + cell(heights, i);
        }
    }

    function setCount(count: number, estimate?: ((index: number) => number) | null): void {
        const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
        const est = typeof estimate === 'function'
            ? estimate
            : (typeof opts.estimate === 'function' ? opts.estimate : null);
        heights = new Float64Array(n);
        offsets = new Float64Array(n + 1);
        // Pending measurements refer to indices that may no longer mean
        // the same row, so they are dropped rather than reapplied.
        pending.clear();
        for (let i = 0; i < n; i += 1) {
            const h = est ? est(i) : (ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX);
            // A non-finite or negative estimate would corrupt every
            // offset after it and silently break the binary search's
            // monotonicity precondition. Fall back rather than store it.
            heights[i] = Number.isFinite(h) && h > 0
                ? h : (ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX);
        }
        rebuild(0);
    }

    /**
     * Which rows to render for a given scroll position.
     *
     * Description: `first`/`last` include the overscan;
     *   `firstVisible`/`lastVisible` do not. BOTH ARE NEEDED: the render
     *   window is the wide one, and the anti-jump pivot is the narrow
     *   one. Paying the delta against the wide one would compensate for
     *   rows nobody can see.
     */
    function windowFor(scrollTop: number, viewportHeight: number): ReaderWindow {
        const n = heights.length;
        if (n === 0) {
            return {
                first: 0, last: -1, firstVisible: 0, lastVisible: -1,
                offsetTop: 0, totalHeight: 0,
            };
        }
        const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
        const vh = Number.isFinite(viewportHeight) && viewportHeight > 0
            ? viewportHeight : 0;

        const firstVisible = rowAt(offsets, top);
        let lastVisible = firstVisible;
        // Forward walk until the accumulated height covers the viewport.
        // Bounded by the viewport, never by N.
        while (lastVisible + 1 < n && cell(offsets, lastVisible + 1) < top + vh) {
            lastVisible += 1;
        }
        const first = Math.max(0, firstVisible - overscan);
        const last = Math.min(n - 1, lastVisible + overscan);
        return {
            first, last, firstVisible, lastVisible,
            offsetTop: cell(offsets, first),
            totalHeight: cell(offsets, n),
        };
    }

    /**
     * Record a real measured height for one row.
     *
     * Description: does NOT rebuild anything. Corrections accumulate and
     *   are applied once per animation frame by `applyMeasurements`.
     *   Batching is what keeps a measurement storm from thrashing layout
     *   once per row.
     * Output: true if accepted as a pending correction; false if out of
     *   range, not finite, or within HEIGHT_EPSILON_PX of the current.
     */
    function measure(index: number, px: number): boolean {
        if (!Number.isInteger(index) || index < 0 || index >= heights.length) {
            return false;
        }
        if (!Number.isFinite(px) || px < 0) return false;
        if (Math.abs(px - cell(heights, index)) <= HEIGHT_EPSILON_PX) return false;
        pending.set(index, px);
        return true;
    }

    /**
     * Apply every pending measurement and report the scroll compensation
     * the caller owes.
     *
     * Description: NORMATIVE - if `delta` is non-zero the caller MUST do
     *   `scroller.scrollTop += delta` in the SAME frame, before paint.
     *   `delta` is the sum of corrections for rows STRICTLY ABOVE
     *   `firstVisibleIndex`; those rows move every subsequent row by
     *   exactly that much, and adding it back is what stops the content
     *   leaping under the reader's eyes. Rows at or below the pivot are
     *   under the reader's eyes and their corrections must NOT be
     *   compensated, because those rows are supposed to grow downward.
     */
    function applyMeasurements(firstVisibleIndex: number): MeasurementResult {
        const n = heights.length;
        if (pending.size === 0) {
            return {
                delta: 0, applied: 0, lowestChanged: -1,
                totalHeight: n ? cell(offsets, n) : 0,
            };
        }
        const pivot = Number.isInteger(firstVisibleIndex) ? firstVisibleIndex : 0;
        let delta = 0;
        let lowest = Infinity;
        let applied = 0;

        pending.forEach((px, index) => {
            const was = cell(heights, index);
            if (Math.abs(px - was) <= HEIGHT_EPSILON_PX) return;
            heights[index] = px;
            applied += 1;
            if (index < lowest) lowest = index;
            if (index < pivot) delta += (px - was);
        });
        pending.clear();

        if (applied === 0) {
            return {
                delta: 0, applied: 0, lowestChanged: -1,
                totalHeight: n ? cell(offsets, n) : 0,
            };
        }
        rebuild(lowest);
        return { delta, applied, lowestChanged: lowest, totalHeight: cell(offsets, n) };
    }

    return {
        setCount,
        windowFor,
        measure,
        applyMeasurements,
        totalHeight: () => (heights.length ? cell(offsets, heights.length) : 0),
        offsetOf: (index: number) => {
            if (!Number.isInteger(index) || index < 0 || index >= offsets.length) {
                return 0;
            }
            return cell(offsets, index);
        },
        heightOf: (index: number) => {
            if (!Number.isInteger(index) || index < 0 || index >= heights.length) {
                return 0;
            }
            return cell(heights, index);
        },
        count: () => heights.length,
        pendingCount: () => pending.size,
        offsets: () => offsets,
    };
}
