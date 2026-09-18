/**
 * HOW TALL IS A CARD, AND WHAT GIVES WAY WHEN THE RAIL IS NARROW.
 *
 * SCAFFOLDING. Imported only by `nav-parity.ts`, which is imported only
 * by `nav-parity.html`. Nothing under `web/src/` can see it.
 *
 * WHY IT IS SEPARATE FROM `nav-parity-measure.ts`. That file answers ONE
 * question - do the Svelte rail and the vanilla rail lay out identically
 * - and every field on it exists to make a DISAGREEMENT legible. This
 * one answers a different question, about a change the two are now
 * deliberately expected to disagree on: the counts and the date share a
 * line here and do not there. Folding them together would leave the
 * parity report printing an expected difference as a defect.
 *
 * TRUNCATION IS THE MEASUREMENT THAT MATTERS, NOT THE HEIGHT. Height is
 * easy and was never in doubt: two lines become one, the card gets
 * shorter. The real risk in merging the runs is that the DATE gets
 * ellipsised, because it is the value the rail's default order is built
 * on and a card ordered by a number it does not show asks the reader to
 * take the ordering on trust. So both runs are checked, at both widths,
 * on every row - and `scrollWidth > clientWidth` is a valid test here
 * for exactly the reason the shared stylesheet gives: both are BLOCKS of
 * inline text with one line and one ellipsis, not flex containers, which
 * is the arrangement that measures clean while looking chopped.
 *
 * TWO WIDTHS, AND THE NARROW ONE IS THE ONE THAT DECIDES. 320px is what
 * the owner is actually looking at; a wide measurement on its own would
 * report a layout that works everywhere it is not being used.
 */

/** One card, measured at one rail width. */
export interface DensityRow {
    /** Position in the level. */
    readonly index: number;
    /** The `li`'s own height, to two decimals. */
    readonly nodeHeight: number;
    /** The clickable face's height, without the card's own margin. */
    readonly faceHeight: number;
    /** Did the counts run have to ellipsise? */
    readonly countsTruncated: boolean;
    /** Did the date have to ellipsise? THE ONE THAT MUST STAY FALSE. */
    readonly whenTruncated: boolean;
    /** How many pixels of counts text did not fit. 0 when it all did. */
    readonly countsOverflowPx: number;
    /** The date's text, so a truncation names the row it happened on. */
    readonly whenText: string;
    /** The label text, likewise. */
    readonly label: string;
}

/** Every card in one level, at one rail width. */
export interface DensityReport {
    readonly which: string;
    readonly widthPx: number;
    readonly rows: readonly DensityRow[];
    readonly minHeight: number;
    readonly maxHeight: number;
    readonly medianHeight: number;
    readonly countsTruncated: number;
    readonly whenTruncated: number;
    /** True when the counts and the date resolved onto the same line. */
    readonly oneLine: boolean;
}

/** Round to two decimals so a float tail cannot read as a difference. */
function px(n: number): number {
    return Math.round(n * 100) / 100;
}

/** The middle value, or 0 for an empty list. */
function median(values: readonly number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    // Indexed reads are widened to `number | undefined` under
    // noUncheckedIndexedAccess. The bounds are known here, but asserting
    // that in the types is cheaper than pretending with a `!`.
    const upper = sorted[mid] ?? 0;
    const lower = sorted[mid - 1] ?? upper;
    return sorted.length % 2 ? upper : px((lower + upper) / 2);
}

/**
 * Is this element's own inline content wider than the box holding it?
 *
 * Description: valid ONLY on a block of inline text with `overflow:
 *   hidden`, which is what both runs measured here are. On a flex
 *   container whose CHILDREN overflow it reads equal while the row is
 *   visibly chopped, which is the trap the shared stylesheet records.
 * Inputs: el - the element, or null.
 * Output: how many pixels did not fit; 0 when everything did.
 * Example: overflowOf(counts)   // -> 14
 */
function overflowOf(el: Element | null): number {
    if (!el) return 0;
    const over = el.scrollWidth - el.clientWidth;
    return over > 0 ? over : 0;
}

/**
 * Measure every card in one rendered level at one rail width.
 *
 * Description: it SETS the width and reads back what the browser
 *   resolved, rather than trusting the number it set - a rail whose
 *   ancestor constrains it would otherwise be reported at a width it
 *   never had. Nothing is restored here; the caller owns the element and
 *   decides what it is left at.
 * Inputs: which - a name for the column. nav - the rail element whose
 *   width is being set. level - the `ul` holding the cards.
 *   widthPx - the rail width to measure at.
 * Output: the report.
 * Example: measureDensity('svelte', nav, level, 320)
 */
export function measureDensity(
    which: string, nav: HTMLElement, level: HTMLElement, widthPx: number,
): DensityReport {
    nav.style.width = `${widthPx}px`;
    nav.style.flex = `0 0 ${widthPx}px`;
    const rows: DensityRow[] = [];
    const items = level.querySelectorAll<HTMLElement>('li');
    let sameLine = 0;
    items.forEach((li, index) => {
        const face = li.querySelector<HTMLElement>('.archive-nav__card-main');
        const counts = li.querySelector<HTMLElement>('.archive-nav__counts');
        const when = li.querySelector<HTMLElement>('.archive-nav__when');
        const label = li.querySelector<HTMLElement>('.archive-nav__label');
        if (counts && when
            && Math.abs(counts.getBoundingClientRect().top
                - when.getBoundingClientRect().top) < 3) {
            sameLine += 1;
        }
        rows.push({
            index,
            nodeHeight: px(li.getBoundingClientRect().height),
            faceHeight: px(face ? face.getBoundingClientRect().height : 0),
            countsTruncated: overflowOf(counts) > 0,
            whenTruncated: overflowOf(when) > 0,
            countsOverflowPx: px(overflowOf(counts)),
            whenText: (when?.textContent || '').trim(),
            label: (label?.textContent || '').trim(),
        });
    });
    const heights = rows.map((r) => r.nodeHeight);
    return {
        which,
        widthPx,
        rows,
        minHeight: heights.length ? px(Math.min(...heights)) : 0,
        maxHeight: heights.length ? px(Math.max(...heights)) : 0,
        medianHeight: median(heights),
        countsTruncated: rows.filter((r) => r.countsTruncated).length,
        whenTruncated: rows.filter((r) => r.whenTruncated).length,
        // Every card, or it is not a one-line layout.
        oneLine: rows.length > 0 && sameLine === rows.length,
    };
}

/**
 * Print one report as lines a person reads.
 *
 * Description: THE DATE TRUNCATING IS CALLED OUT AS A FAILURE and named
 *   row by row, because it is the one outcome that makes this layout
 *   wrong rather than merely tight. A counts run truncating is expected
 *   and is reported as a count.
 * Inputs: report - one measured level.
 * Output: the lines.
 * Example: reportDensity(measureDensity(...)).join('\n')
 */
export function reportDensity(report: DensityReport): readonly string[] {
    const lines: string[] = [
        `${report.which} at ${report.widthPx}px, ${report.rows.length} cards`,
        `  card height   min ${report.minHeight}  median ${report.medianHeight}`
        + `  max ${report.maxHeight}`,
        `  counts and date on one line: ${report.oneLine ? 'yes, every card' : 'NO'}`,
        `  counts ellipsised: ${report.countsTruncated} of ${report.rows.length}`
        + '  (expected, and the session figure is never what is cut)',
        `  date ellipsised:   ${report.whenTruncated} of ${report.rows.length}`
        + `  ${report.whenTruncated ? '<-- FAILURE, the date must never be cut' : '(correct)'}`,
    ];
    const cut = report.rows.filter((r) => r.whenTruncated).slice(0, 5);
    for (const row of cut) {
        lines.push(`    row ${row.index} "${row.label}" lost its date "${row.whenText}"`);
    }
    const worst = [...report.rows]
        .sort((a, b) => b.countsOverflowPx - a.countsOverflowPx)[0];
    if (worst && worst.countsOverflowPx > 0) {
        lines.push(`    widest counts overflow ${worst.countsOverflowPx}px `
            + `on row ${worst.index} "${worst.label}"`);
    }
    return lines;
}
