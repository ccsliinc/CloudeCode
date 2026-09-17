/**
 * THE READER'S DOM READS: a painted row's real height, the anti-jump
 * reconcile, and bringing a selected row into view.
 *
 * Ported from the DOM half of `client/js/archive-virtual-list.js`, split
 * out for the same reason slice 6 split `tlist-measure.svelte.ts` off
 * `tlist-window.ts`: MEASUREMENT IS THE HALF OF VIRTUALISATION THAT IS
 * EASY TO FAKE and therefore has to be readable on its own. A constant
 * row height would make every test pass and every real transcript wrong,
 * because a row's height is driven by its own `body_chars` and two
 * adjacent rows routinely differ by a factor of ten. Keeping the reads
 * in one small file is what makes "nothing here is a constant" checkable
 * at a glance.
 *
 * NULL IS NOT ZERO. A zero would be written into the offset table as a
 * real correction and collapse the row to invisible; an unmeasurable row
 * keeps its estimate instead. That asymmetry is the whole of
 * `measuredHeight`.
 *
 * THE SCROLLPORT IS GIVEN, NEVER FOUND. Nothing here calls `closest()`,
 * `document.querySelector` or reads `window.innerHeight`. The component
 * takes its scrolling ancestor as a prop and hands it here, which is
 * what makes the whole reader mountable into a shell that does not exist
 * yet.
 */
import type { MeasurementResult, VirtualList, ReaderWindow } from './reader-virtual';

/**
 * Fallback viewport height when the scroller reports `clientHeight` 0,
 * which happens while detached.
 *
 * Description: a zero viewport would render one row and look BROKEN
 *   rather than unmounted, so the detached case is NAMED with a usable
 *   number instead of silently producing one.
 */
export const FALLBACK_VIEWPORT_PX = 600;

/**
 * A rendered row's height, or null when it cannot be measured.
 *
 * Description: NULL IS NOT ZERO - see the file header.
 * Inputs: node - a painted row.
 * Output: pixels, or null for could-not-measure.
 * Example: measuredHeight(rowEl) // -> 219.23
 */
export function measuredHeight(node: Element | null | undefined): number | null {
    if (!node) return null;
    if (typeof node.getBoundingClientRect === 'function') {
        const r = node.getBoundingClientRect();
        if (r && Number.isFinite(r.height) && r.height > 0) return r.height;
    }
    const oh = (node as HTMLElement).offsetHeight;
    if (Number.isFinite(oh) && oh > 0) return oh;
    return null;
}

/**
 * The scroller's usable height, with the detached case named.
 *
 * Inputs: scroller - the scrolling ancestor, or null.
 * Output: pixels. Never zero.
 * Example: viewportHeight(null) // -> 600
 */
export function viewportHeight(scroller: Element | null | undefined): number {
    const h = scroller ? (scroller as HTMLElement).clientHeight : 0;
    return Number.isFinite(h) && h > 0 ? h : FALLBACK_VIEWPORT_PX;
}

/**
 * The scroller's current offset, 0 while detached.
 *
 * Inputs: scroller - the scrolling ancestor, or null.
 * Output: pixels.
 */
export function scrollTopOf(scroller: Element | null | undefined): number {
    const t = scroller ? (scroller as HTMLElement).scrollTop : 0;
    return Number.isFinite(t) ? t : 0;
}

/**
 * Read the painted rows' real heights into the list, apply them, and pay
 * the anti-jump debt.
 *
 * Description: NORMATIVE - the scrollTop compensation happens HERE, in
 *   the SAME CALL as the height write, before paint. Deferring it
 *   produces a visible one-frame leap, which reads as a bug rather than
 *   as scrolling. The caller still owns the spacer height; this only
 *   reports the new total.
 *
 *   IT READS `data-index`, WHICH IS THE ONE ATTRIBUTE THE TEMPLATE OWES
 *   IT. A child with no usable index is skipped rather than guessed at,
 *   because writing a measurement onto a guessed row corrupts the offset
 *   table for a row nobody measured.
 * Inputs: list - the geometry engine. windowEl - holds the painted rows.
 *   win - the window just painted. scroller - the scrolling ancestor;
 *   null leaves the returned delta UNPAID, which the caller must treat
 *   as a refusal rather than as a zero.
 * Output: the measurement result, delta included.
 * Example: reconcileMeasured(list, windowEl, win, scroller)
 *   // -> {delta: -12.5, applied: 3, totalHeight: 109574.06}
 */
export function reconcileMeasured(
    list: VirtualList,
    windowEl: Element | null | undefined,
    win: ReaderWindow,
    scroller: Element | null | undefined,
): MeasurementResult {
    const kids = windowEl ? windowEl.children : ([] as unknown as HTMLCollection);
    for (let k = 0; k < kids.length; k += 1) {
        const node = kids[k];
        if (!node || typeof node.getAttribute !== 'function') continue;
        const idx = parseInt(node.getAttribute('data-index') || '', 10);
        if (!Number.isInteger(idx)) continue;
        const h = measuredHeight(node);
        if (h !== null) list.measure(idx, h);
    }
    const r = list.applyMeasurements(win.firstVisible);
    if (r.delta !== 0 && scroller) {
        const top = scrollTopOf(scroller);
        (scroller as HTMLElement).scrollTop = top + r.delta;
    }
    return r;
}

/**
 * Scroll just enough to bring one row fully into view.
 *
 * Description: it does NOTHING when the row is already visible, because
 *   scrolling on every keypress fights the person reading.
 * Inputs: list - the geometry engine. scroller - the scrolling ancestor.
 *   index - the row to reveal; a non-integer or negative index means
 *   nothing is selected and is a no-op. viewportPx - the usable height.
 * Output: true when scrollTop was written, false when the row was
 *   already visible or the inputs could not be evaluated.
 * Example: scrollRowIntoView(list, scroller, 412, 800) // -> true
 */
export function scrollRowIntoView(
    list: VirtualList,
    scroller: Element | null | undefined,
    index: number,
    viewportPx: number,
): boolean {
    if (!scroller || !Number.isInteger(index) || index < 0) return false;
    if (!Number.isFinite(viewportPx) || viewportPx <= 0) return false;
    const top = list.offsetOf(index);
    const bottom = top + list.heightOf(index);
    const viewTop = scrollTopOf(scroller);
    const el = scroller as HTMLElement;
    if (top < viewTop) { el.scrollTop = top; return true; }
    if (bottom > viewTop + viewportPx) {
        el.scrollTop = bottom - viewportPx;
        return true;
    }
    return false;
}

/**
 * Watch a scrollport for scroll and resize, calling back on each.
 *
 * Description: returns a teardown, so a `$effect` can hand it straight
 *   back. `ResizeObserver` is used WHEN PRESENT and its absence is not
 *   an error: without it the viewport is re-read on scroll and on every
 *   repaint, which is late rather than wrong, and a reader that threw
 *   because a browser lacked an observer would be a worse failure than a
 *   slightly stale height.
 * Inputs: port - the scrolling ancestor, or null. onChange - called
 *   after every event.
 * Output: a teardown. Safe to call when nothing was attached.
 * Example: $effect(() => watchScroller(port, () => schedule()));
 */
export function watchScroller(
    port: Element | null | undefined,
    onChange: () => void,
): () => void {
    if (!port) return () => {};
    port.addEventListener('scroll', onChange, { passive: true });

    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver;
    const ro = RO ? new RO(onChange) : null;
    if (ro) ro.observe(port);

    return () => {
        port.removeEventListener('scroll', onChange);
        if (ro) ro.disconnect();
    };
}
