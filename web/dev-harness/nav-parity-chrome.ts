/**
 * MEASURING THE RAIL'S CHROME: everything between the top of the rail
 * and the top of the first card. SCAFFOLDING.
 *
 * `nav-parity-measure.ts` answers "are the two renderers drawing the
 * same CARD". This answers a different question the same way - with
 * boxes rather than an opinion - because the owner's first complaint is
 * about the space ABOVE the cards, and no card measurement can see it.
 *
 * THE GAP IS A SUM, NOT A NUMBER, WHICH IS WHY EACH TERM IS REPORTED.
 * It is made by the rail's own padding, the filter input, the order
 * control's margin, and a filter note that is supposed to collapse when
 * there is nothing to disclose. Reporting only the total would say the
 * gap is 46px and leave the next reader to guess which of the four to
 * change. A COLLAPSED NOTE THAT DID NOT COLLAPSE is invisible in a
 * total and obvious in the terms.
 *
 * IT READS WHAT THE CASCADE RESOLVED. Same discipline as the card
 * measurement next door: nothing here reads a stylesheet, because a rule
 * can be present and outranked.
 */

/** One element in the chrome, as the browser resolved it. */
export interface ChromePart {
    /** Which element, in words. */
    readonly what: string;
    /** Its resolved `display`. `none` means it costs no space. */
    readonly display: string;
    /** Its own height, or 0 when it is not displayed. */
    readonly height: number;
    /** Resolved `margin`, as 'top right bottom left'. */
    readonly margin: string;
    /** Its top edge, relative to the rail's own top. */
    readonly top: number;
    /** Its bottom edge, relative to the rail's own top. */
    readonly bottom: number;
}

/** Everything measured above the first card. */
export interface ChromeBoxes {
    /** Which renderer produced it. */
    readonly which: string;
    /** The rail's resolved padding. */
    readonly navPadding: string;
    /** One entry per chrome element, in document order. */
    readonly parts: readonly ChromePart[];
    /** The first card's top edge, relative to the rail's own top. */
    readonly firstCardTop: number;
    /**
     * The bare gap between the last chrome element that costs space and
     * the first card. THE NUMBER THE COMPLAINT IS ABOUT.
     */
    readonly gapAboveFirstCard: number;
}

/** Round to two decimals so a float tail cannot read as a difference. */
function px(n: number): number {
    return Math.round(n * 100) / 100;
}

/** The chrome elements, in the order the rail paints them. */
const PARTS: readonly (readonly [string, string])[] = [
    ['filter', '.archive-nav__filter'],
    ['order', '.archive-nav__order'],
    ['filter-note', '.archive-nav__filter-note'],
    ['level', '.archive-nav__level--merged'],
];

/**
 * Measure one mounted rail's chrome.
 *
 * Description: every edge is reported RELATIVE TO THE RAIL'S OWN TOP, so
 *   a number means the same thing wherever on the page the column was
 *   parked. An element the rail did not render is reported as absent
 *   rather than skipped: a missing filter note and a collapsed one are
 *   different findings and a skipped row cannot tell them apart.
 * Inputs: which - a name for the column. nav - the mounted `.archive-nav`.
 * Output: the measurements.
 * Example: measureChrome('svelte rail', nav).gapAboveFirstCard
 */
export function measureChrome(which: string, nav: HTMLElement): ChromeBoxes {
    const navTop = nav.getBoundingClientRect().top;
    const parts: ChromePart[] = [];
    for (const [what, selector] of PARTS) {
        const el = nav.querySelector<HTMLElement>(selector);
        if (!el) {
            parts.push({
                what, display: 'ABSENT', height: 0, margin: 'n/a',
                top: 0, bottom: 0,
            });
            continue;
        }
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        parts.push({
            what,
            display: style.display,
            height: px(box.height),
            margin: [style.marginTop, style.marginRight,
                style.marginBottom, style.marginLeft].join(' '),
            top: px(box.top - navTop),
            bottom: px(box.bottom - navTop),
        });
    }
    const card = nav.querySelector<HTMLElement>('.archive-nav__node--project');
    const firstCardTop = card ? px(card.getBoundingClientRect().top - navTop) : 0;
    // The last part that actually costs space. A `display: none` note
    // must not be the thing the gap is measured from, or a note that
    // correctly collapsed would report a negative gap.
    let lastSolidBottom = 0;
    for (const part of parts) {
        if (part.what === 'level') continue;
        if (part.display === 'none' || part.display === 'ABSENT') continue;
        lastSolidBottom = Math.max(lastSolidBottom, part.bottom);
    }
    return {
        which, navPadding: getComputedStyle(nav).padding, parts,
        firstCardTop, gapAboveFirstCard: px(firstCardTop - lastSolidBottom),
    };
}

/**
 * Render a chrome measurement as plain text lines.
 *
 * Description: printed rather than logged, for the same reason the card
 *   report is: the answer has to survive being looked at in a
 *   screenshot.
 * Inputs: boxes - one measured chrome.
 * Output: the lines, ready to join.
 * Example: reportChrome(measureChrome('rail', nav)).join('\n')
 */
export function reportChrome(boxes: ChromeBoxes): readonly string[] {
    const lines: string[] = [];
    lines.push(`${boxes.which}: rail padding ${boxes.navPadding}`);
    for (const part of boxes.parts) {
        lines.push(`  ${part.what.padEnd(12)} ${part.display.padEnd(8)} `
            + `h ${String(part.height).padStart(7)}  `
            + `top ${String(part.top).padStart(7)} bottom ${String(part.bottom).padStart(7)}  `
            + `margin ${part.margin}`);
    }
    lines.push(`  first card top ${boxes.firstCardTop}, `
        + `BARE GAP ABOVE THE FIRST CARD ${boxes.gapAboveFirstCard}px`);
    return lines;
}
