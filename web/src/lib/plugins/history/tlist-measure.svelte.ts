/**
 * THE THREE NUMBERS THE WINDOW NEEDS, MEASURED OFF THE REAL PAGE.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT. Two reasons, and the second is
 * the one that matters. First, `TranscriptList.svelte` is at this
 * project's 500-line guideline and measurement is plainly its own job.
 * Second, measurement is the half of virtualisation that is EASY TO FAKE
 * and therefore has to be readable on its own: a constant row height
 * would make every test pass and every phone wrong, because
 * `client/css/archive-tlist.css`'s 769px media query forces four of the
 * row's eight spans to `flex: 0 0 100%` and roughly doubles its height.
 * Keeping the reads in one small file is what makes "nothing here is a
 * constant" checkable at a glance.
 *
 * ZERO IS A REFUSAL, NOT A MEASUREMENT, and it is passed on as such.
 * `computeWindow` treats a non-positive height as "not measured" and
 * renders the whole list, which is the vanilla behaviour. So an
 * unlaid-out row, a `display: none` pane, a detached node and a
 * browser that has not painted yet all degrade to the status quo rather
 * than to a list with rows missing.
 *
 * THE SCROLLPORT IS GIVEN, NEVER FOUND. Nothing here calls `closest()`,
 * `document.querySelector` or reads `window.innerHeight`. The component
 * takes its scrolling ancestor as a prop and hands it here, which is
 * what makes the whole list mountable into a shell that does not exist
 * yet.
 */

/** The gap between rows, px, as `.archive-tlist__rows` declares it. */
import { ROW_GAP_PX } from './tlist-window';

/** What a live measurement holds. All zero until something is read. */
export interface Measurements {
    /** The scrollport's visible height, px. 0 means not measured. */
    viewportHeight: number;
    /** The scrollport's scroll offset, px. */
    scrollTop: number;
    /** One row's height INCLUDING its gap, px. 0 means not measured. */
    rowHeight: number;
}

/**
 * Read a scrollport's two live numbers into `into`.
 *
 * Description: a plain write rather than a return, so the caller owns the
 *   reactive state and this module owns only the reading. A null port
 *   ZEROES both, because "there is no scrollport" and "the scrollport is
 *   600 tall" must not produce the same window.
 * Inputs: port - the scrolling ancestor, or null. into - the state to write.
 * Output: void.
 * Example: readScrollport(el, m)  // m.viewportHeight === el.clientHeight
 */
export function readScrollport(
    port: Element | null | undefined,
    into: Measurements,
): void {
    if (!port) {
        into.viewportHeight = 0;
        into.scrollTop = 0;
        return;
    }
    const el = port as HTMLElement;
    into.viewportHeight = el.clientHeight || 0;
    into.scrollTop = el.scrollTop || 0;
}

/**
 * Measure one real row's height off the rendered list.
 *
 * Description: reads the FIRST element carrying `data-transcript-id`,
 *   which is a real row and never a spacer - the spacers deliberately
 *   carry no attributes a query could confuse for a row.
 *
 *   A ZERO IS DISCARDED RATHER THAN RECORDED. Zero is what an unlaid-out
 *   or hidden row reports, and recording it would make every later window
 *   refuse to narrow. Keeping the previous reading instead means a stale
 *   height narrows slightly wrong, where a zero height stops narrowing at
 *   all - and slightly wrong is recoverable on the next paint.
 * Inputs: list - the `<ul>`, or null. previous - the height on record.
 * Output: the height to use, including one row gap.
 * Example: measureRowHeight(ul, 0)  // -> 64 for a 54px row
 */
export function measureRowHeight(
    list: Element | null | undefined,
    previous: number,
): number {
    if (!list) return previous;
    const row = list.querySelector('li[data-transcript-id]');
    if (!row) return previous;
    const h = (row as HTMLElement).offsetHeight;
    if (!(h > 0)) return previous;
    return h + ROW_GAP_PX;
}

/**
 * Watch a scrollport for scroll and resize, re-reading on each.
 *
 * Description: returns a teardown, so a `$effect` can hand it straight
 *   back. `ResizeObserver` is used WHEN PRESENT and its absence is not an
 *   error: without it the viewport is re-read on scroll and on every
 *   repaint, which is late rather than wrong, and a list that threw
 *   because a browser lacked an observer would be a worse failure than a
 *   slightly stale height.
 * Inputs: port - the scrolling ancestor, or null. onChange - called after
 *   every read.
 * Output: a teardown function. Safe to call when nothing was attached.
 * Example: $effect(() => watchScrollport(port, () => read()));
 */
export function watchScrollport(
    port: Element | null | undefined,
    onChange: () => void,
): () => void {
    if (!port) return () => {};
    onChange();
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
