/**
 * THE RENDER WINDOW: which rows of a long list are actually in the DOM,
 * and how much empty space stands in for the rest.
 *
 * WHAT THE ORIGINAL GUARANTEED, STATED PRECISELY, BECAUSE IT IS NOT WHAT
 * THE FILE NAMES SUGGEST. `client/js/archive-row-cache.js` is a keyed
 * DOM node cache and its only consumer is `archive-reader.js`, NOT the
 * transcript list. Measured: `grep -rln ArchiveRowCache client/` returns
 * the reader and nothing else. So the transcript list shipped with NO
 * bound at all - `archive-transcript-list.js`'s `paint()` does
 * `rowList.textContent = ''` and then builds a fresh `<li>` with eight
 * child spans for EVERY loaded row, on every repaint, including a
 * repaint caused by one keystroke in a fuzzy input.
 *
 * The cache's two guarantees, which ARE worth carrying across:
 *   G1 REUSE. `get(key, signature, build)` returns the same node object
 *     without calling `build` when the recorded signature matches. A
 *     mismatch or a miss always builds. The signature is not checked
 *     alongside the lookup, it IS the lookup.
 *   G2 BOUND. After `retain(activeKeys)` the map holds only those keys,
 *     so scrolling a 30,805-line transcript top to bottom cannot
 *     accumulate one detached subtree per line ever seen.
 *
 * HOW THEY ARE PRESERVED HERE, WHICH IS NOT BY PORTING THE MAP. G1 is
 * Svelte's, for free and better: a KEYED `{#each}` moves DOM nodes
 * rather than rebuilding them, and fine-grained reactivity updates only
 * the text nodes whose source changed, where the cache could only reuse
 * a node wholesale or rebuild it wholesale. Re-implementing a Map of
 * detached nodes beside Svelte's own would be two things owning one
 * subtree. G2 is what Svelte does NOT give: a keyed each over 3,416 rows
 * is 3,416 rows of DOM. G2 needs a WINDOW, and the cache's own header
 * says so out loud - "Nothing here decides how big in view is - that is
 * the virtual list's overscan, upstream of this file." This module is
 * that upstream. It is the piece the transcript list never had.
 *
 * NO DOM, NO FRAMEWORK, NO CLOCK. Every function is pure arithmetic, so
 * the bound is testable by calling it rather than by measuring a render.
 *
 * ROW HEIGHT IS MEASURED BY THE CALLER AND NEVER ASSUMED HERE. The rows
 * are not uniform: `.archive-tlist__open` wraps its eight spans, and
 * `client/css/archive-tlist.css`'s phone-width media query forces four
 * of them to `flex: 0 0 100%`, so one row is roughly twice as tall
 * there. A constant would be a fabricated measurement. `computeWindow`
 * therefore REFUSES to narrow when it has not been given a usable
 * height - see the refusal below.
 */

/** The `gap` between rows, in px, declared by `.archive-tlist__rows`. */
export const ROW_GAP_PX = 10;

/**
 * Rows kept rendered beyond each edge of the viewport.
 *
 * Description: the cost of a too-small overscan is a blank band during a
 *   fast scroll; the cost of a too-large one is DOM nodes. Eight is two
 *   to three rows more than a flick typically travels between animation
 *   frames at this row height, and it keeps the bound small enough that
 *   the difference from the unbounded case is obvious in a test.
 */
export const DEFAULT_OVERSCAN = 8;

/** What `computeWindow` answers. */
export interface RenderWindow {
    /** Index of the first row to render. 0 when nothing is scrolled past. */
    readonly first: number;
    /** Index of the LAST row to render, inclusive. -1 when count is 0. */
    readonly last: number;
    /** Height, in px, of the spacer standing in for rows before `first`. */
    readonly padTop: number;
    /** Height, in px, of the spacer standing in for rows after `last`. */
    readonly padBottom: number;
    /**
     * Whether a usable row height was supplied. False means the window
     * is the WHOLE list because nothing was measured, which is a refusal
     * to guess and not a bound.
     */
    readonly measured: boolean;
}

/** What `computeWindow` needs to answer. All of it measured by the caller. */
export interface WindowInput {
    /** Rows in the list. */
    readonly count: number;
    /** The scroll container's `scrollTop`, in px. */
    readonly scrollTop: number;
    /** The scroll container's visible height, in px. */
    readonly viewportHeight: number;
    /**
     * One row's height in px INCLUDING its gap, measured off a real
     * rendered row. Zero, negative or non-finite means "not measured".
     */
    readonly rowHeight: number;
    /** Rows kept beyond each edge. Defaults to DEFAULT_OVERSCAN. */
    readonly overscan?: number;
}

/** Is this a real, usable, positive measurement? */
function isUsable(n: unknown): boolean {
    return typeof n === 'number' && isFinite(n) && n > 0;
}

/** Clamp `n` into [lo, hi]. Both bounds inclusive. */
function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/**
 * The whole list, as a window. The refusal value.
 *
 * Description: returned whenever the inputs cannot support narrowing.
 *   RENDERING EVERYTHING IS THE SAFE ANSWER AND RENDERING NOTHING IS
 *   NOT: an unmeasured pane that narrowed to a guessed subset would show
 *   a short list where a long one exists, silently, and look like a
 *   server that returned fewer rows. Falling back to every row
 *   reproduces exactly the behaviour the vanilla list already had, so
 *   the worst case of this module is the status quo.
 * Inputs: count - rows in the list.
 * Output: a window covering every row, with `measured` false.
 */
function wholeList(count: number): RenderWindow {
    return {
        first: 0,
        last: count - 1,
        padTop: 0,
        padBottom: 0,
        measured: false,
    };
}

/**
 * Which rows to render, and how much empty space stands in for the rest.
 *
 * Description: THE BOUND THIS EXISTS FOR is that the number of rendered
 *   rows depends on the VIEWPORT and the overscan, and not on `count`.
 *   `renderedCount(computeWindow(...))` is therefore the same number for
 *   50 rows and for 50,000, which is the property
 *   `tlist-window.test.ts` asserts directly rather than timing.
 *
 *   IT REFUSES RATHER THAN GUESSES. A row height that was never measured
 *   (zero, negative, NaN, absent) or a viewport that was never measured
 *   yields the whole list and `measured: false`. "Not having measured is
 *   not evidence the list is short." In practice the first paint of page
 *   one is unbounded and every paint after it is bounded, because a
 *   height is measured off that first paint - and `PAGE_SIZE` is 50, so
 *   there is no reachable state in which a first paint is large.
 *
 *   THE GAP ARITHMETIC IS HERE AND NOT IN THE TEMPLATE. Each spacer is a
 *   flex child of a `gap: 10px` column, so a PRESENT spacer contributes
 *   its own height PLUS one gap to the scroll height. Its height is
 *   reduced by one gap to compensate, floored at zero. A spacer of zero
 *   height is not rendered at all, which is why the floor is safe: the
 *   only case it could distort is one where nothing is drawn.
 * Inputs: input - count, scroll position, viewport, measured row height.
 * Output: the window, with its two spacer heights.
 * Example:
 *   computeWindow({count: 5000, scrollTop: 0, viewportHeight: 600,
 *                  rowHeight: 60, overscan: 8})
 *   // -> first 0, last 17, padTop 0, padBottom ~298,790, measured true
 */
export function computeWindow(input: WindowInput): RenderWindow {
    const count = isUsable(input.count) ? Math.floor(input.count) : 0;
    if (count <= 0) {
        return { first: 0, last: -1, padTop: 0, padBottom: 0, measured: false };
    }
    if (!isUsable(input.rowHeight) || !isUsable(input.viewportHeight)) {
        return wholeList(count);
    }

    const rowHeight = input.rowHeight;
    const overscan = isUsable(input.overscan)
        ? Math.floor(input.overscan as number)
        : DEFAULT_OVERSCAN;
    const scrollTop = isUsable(input.scrollTop) ? input.scrollTop : 0;

    const firstVisible = Math.floor(scrollTop / rowHeight);
    const visibleRows = Math.ceil(input.viewportHeight / rowHeight) + 1;

    const first = clamp(firstVisible - overscan, 0, count - 1);
    const last = clamp(firstVisible + visibleRows + overscan, 0, count - 1);

    return {
        first,
        last,
        padTop: spacerHeight(first * rowHeight, first > 0),
        padBottom: spacerHeight(
            (count - 1 - last) * rowHeight,
            last < count - 1,
        ),
        measured: true,
    };
}

/**
 * One spacer's own height, with its flex gap discounted.
 *
 * Description: a spacer that is RENDERED is a flex child and therefore
 *   contributes one `gap` on top of whatever height it declares, so its
 *   declared height is one gap short of the space it is standing in for.
 *   A spacer that is not rendered contributes nothing and gets zero.
 * Inputs: raw - the space the hidden rows would have occupied, in px.
 *   present - whether the spacer will actually be rendered.
 * Output: the height to declare, never negative.
 */
function spacerHeight(raw: number, present: boolean): number {
    if (!present || raw <= 0) return 0;
    const adjusted = raw - ROW_GAP_PX;
    return adjusted > 0 ? adjusted : 0;
}

/**
 * How many rows a window puts in the DOM.
 *
 * Description: the number the bound test asserts. Separate from
 *   `computeWindow` so a test states the property it is checking rather
 *   than recomputing `last - first + 1` and risking the same off-by-one
 *   in the assertion as in the code.
 * Inputs: w - a window.
 * Output: the count of rendered rows, 0 for an empty list.
 * Example: renderedCount({first: 0, last: 17, ...}) // -> 18
 */
export function renderedCount(w: RenderWindow): number {
    if (w.last < w.first) return 0;
    return w.last - w.first + 1;
}

/**
 * The upper bound on rendered rows, given a viewport and an overscan.
 *
 * Description: what `renderedCount` may never exceed on a MEASURED
 *   window, derived from the same two inputs `computeWindow` uses and
 *   from nothing about `count`. Stating it as its own function is what
 *   lets the test compare a measured render against a bound rather than
 *   against a number somebody typed.
 * Inputs: viewportHeight - px. rowHeight - px. overscan - rows.
 * Output: the maximum rows a measured window may contain.
 * Example: maxRendered(600, 60, 8) // -> 27
 */
export function maxRendered(
    viewportHeight: number,
    rowHeight: number,
    overscan: number = DEFAULT_OVERSCAN,
): number {
    if (!isUsable(viewportHeight) || !isUsable(rowHeight)) {
        return Number.POSITIVE_INFINITY;
    }
    const over = isUsable(overscan) ? Math.floor(overscan) : DEFAULT_OVERSCAN;
    return Math.ceil(viewportHeight / rowHeight) + 2 + 2 * over;
}

/**
 * Keep a selected index inside the window, so a keyboard cursor is never
 * pointed at a row that is not in the DOM.
 *
 * Description: the cursor from `keys.ts::createSelection` holds a COUNT
 *   and an INDEX and no rows, which is what lets a selection survive its
 *   row scrolling out of the render window. That is the right design and
 *   it leaves one job here: when the user MOVES the cursor, the window
 *   has to follow it, or `j` past the bottom edge selects a row that
 *   cannot be seen or focused.
 *
 *   IT ANSWERS A SCROLL POSITION, NOT A WINDOW, so the caller sets
 *   `scrollTop` and lets the existing measured path recompute. One
 *   function deciding the window means a scroll driven by the keyboard
 *   and a scroll driven by the wheel cannot disagree.
 * Inputs: index - the selected row, -1 for none. scrollTop, viewportHeight,
 *   rowHeight - as measured. Output: the scrollTop that brings `index`
 *   into view, or the current one when it already is, or null when
 *   nothing was measured and no answer is available.
 * Example: scrollToShow(40, 0, 600, 60) // -> 1860, the row's bottom edge
 */
export function scrollToShow(
    index: number,
    scrollTop: number,
    viewportHeight: number,
    rowHeight: number,
): number | null {
    if (index < 0) return null;
    if (!isUsable(rowHeight) || !isUsable(viewportHeight)) return null;
    const top = isUsable(scrollTop) ? scrollTop : 0;
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < top) return rowTop;
    if (rowBottom > top + viewportHeight) return rowBottom - viewportHeight;
    return top;
}
