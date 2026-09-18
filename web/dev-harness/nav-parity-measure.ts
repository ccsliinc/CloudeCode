/**
 * MEASURING ONE RENDERED RAIL, AND COMPARING TWO OF THEM.
 *
 * SCAFFOLDING. It is imported only by `nav-parity.ts`, which is imported
 * only by `nav-parity.html`, and nothing under `web/src/` can see any of
 * the three.
 *
 * WHY BOXES AND NOT A SCREENSHOT. The question this answers is whether
 * the Svelte rail and the vanilla rail lay out identically, and two
 * screenshots that look alike prove nothing about a 1px or a 6px
 * difference at the bottom of a 77 row list. So this reads the boxes the
 * browser actually computed and prints the numbers, and a human reads a
 * verdict rather than a picture.
 *
 * IT MEASURES WHAT THE CASCADE RESOLVED, NOT WHAT THE CSS SAYS. A rule
 * can be present and outranked; a rule can be absent and inherited. Only
 * `getComputedStyle` on a node that is actually in the document answers
 * the question that was asked, which is why nothing here reads a
 * stylesheet.
 */

/** One measured row, as the browser resolved it. */
export interface RowBox {
    /** Position in the level, so two columns can be compared by index. */
    readonly index: number;
    /** `data-node-kind` off the `li`, or '' when it carries none. */
    readonly kind: string;
    /** The `li`'s own height in CSS pixels, to two decimals. */
    readonly nodeHeight: number;
    /** The `li`'s own width. Height parity alone does not imply it: the
     *  label is `white-space: nowrap`, so a narrower card truncates
     *  earlier and stays exactly as tall. */
    readonly nodeWidth: number;
    /** The `.archive-nav__row`'s height, or null when there is none. */
    readonly rowHeight: number | null;
    /** Resolved `padding` on the row, as 'top right bottom left'. */
    readonly rowPadding: string;
    /** Resolved `display` on the row. */
    readonly rowDisplay: string;
    /** Resolved `row-gap column-gap` on the row. */
    readonly rowGap: string;
    /** Resolved `font-size` on the label. */
    readonly labelFontSize: string;
    /** The label text, so a mismatch names the row it happened on. */
    readonly label: string;
}

/** Every measurement taken from one rendered level. */
export interface LevelBoxes {
    /** Which renderer produced it. */
    readonly which: string;
    /** The level's own content height. */
    readonly levelHeight: number;
    /** One entry per `li`, in document order. */
    readonly rows: readonly RowBox[];
}

/** Round to two decimals so a float tail cannot read as a difference. */
function px(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Read one element's resolved padding as a single string.
 *
 * Inputs: style - a resolved declaration.
 * Output: 'top right bottom left'.
 * Example: paddingOf(getComputedStyle(el))   // -> '5px 12px 5px 12px'
 */
function paddingOf(style: CSSStyleDeclaration): string {
    return [
        style.paddingTop, style.paddingRight,
        style.paddingBottom, style.paddingLeft,
    ].join(' ');
}

/**
 * Measure one rendered level.
 *
 * Description: it reads the level that is IN THE DOCUMENT. An element
 *   that was never attached, or one inside a `display: none` ancestor,
 *   measures zero everywhere, which would read as perfect agreement
 *   between two columns that were both invisible. So a level with no
 *   rows, or one whose height is zero, is reported as it is and the
 *   caller refuses rather than passing it.
 * Inputs: which - a name for the renderer. level - the `ul` element.
 * Output: the measurements.
 * Example: measureLevel('svelte', ul).rows.length
 */
export function measureLevel(which: string, level: HTMLElement): LevelBoxes {
    const nodes = Array.from(level.querySelectorAll<HTMLElement>('li'));
    const rows = nodes.map((node, index): RowBox => {
        const row = node.querySelector<HTMLElement>('.archive-nav__row');
        const label = node.querySelector<HTMLElement>('.archive-nav__label');
        const rowStyle = row ? getComputedStyle(row) : null;
        return {
            index,
            kind: node.getAttribute('data-node-kind') || '',
            nodeHeight: px(node.getBoundingClientRect().height),
            nodeWidth: px(node.getBoundingClientRect().width),
            rowHeight: row ? px(row.getBoundingClientRect().height) : null,
            rowPadding: rowStyle ? paddingOf(rowStyle) : 'no row',
            rowDisplay: rowStyle ? rowStyle.display : 'no row',
            rowGap: rowStyle ? `${rowStyle.rowGap} ${rowStyle.columnGap}` : 'no row',
            labelFontSize: label ? getComputedStyle(label).fontSize : 'no label',
            label: label ? (label.textContent || '') : '',
        };
    });
    return { which, levelHeight: px(level.getBoundingClientRect().height), rows };
}

/** One disagreement between the two columns, in words. */
export interface Difference {
    readonly index: number;
    readonly field: string;
    readonly left: string;
    readonly right: string;
    readonly label: string;
}

/** The fields compared, in the order they are reported. */
const COMPARED: readonly (keyof RowBox)[] = [
    'kind', 'nodeHeight', 'nodeWidth', 'rowHeight', 'rowPadding',
    'rowDisplay', 'rowGap', 'labelFontSize',
];

/**
 * Compare two measured levels.
 *
 * Description: A DIFFERENT ROW COUNT IS ITSELF THE FINDING and is
 *   reported as one difference rather than as a per-row storm, because
 *   comparing row 40 of one column against row 40 of a column that has
 *   39 says nothing about row 40. Pairs are compared only up to the
 *   shorter length.
 * Inputs: left, right - two measured levels.
 * Output: every disagreement, empty when the two agree.
 * Example: compareLevels(a, b).length === 0   // -> the rails match
 */
export function compareLevels(
    left: LevelBoxes, right: LevelBoxes,
): readonly Difference[] {
    const out: Difference[] = [];
    if (left.rows.length !== right.rows.length) {
        out.push({
            index: -1, field: 'row count', label: '',
            left: String(left.rows.length), right: String(right.rows.length),
        });
    }
    const pairs = Math.min(left.rows.length, right.rows.length);
    for (let i = 0; i < pairs; i += 1) {
        const a = left.rows[i];
        const b = right.rows[i];
        // `noUncheckedIndexedAccess` is on, so an index below the length
        // is still typed as possibly absent. Refusing here rather than
        // asserting keeps the one case that could actually happen - a
        // sparse array handed in by a future caller - a skipped pair
        // instead of a thrown page.
        if (!a || !b) continue;
        for (const field of COMPARED) {
            if (String(a[field]) !== String(b[field])) {
                out.push({
                    index: i, field: String(field), label: a.label,
                    left: String(a[field]), right: String(b[field]),
                });
            }
        }
    }
    return out;
}

/**
 * Render the verdict and the numbers into an element, as plain text.
 *
 * Description: the page prints rather than logging, so the answer
 *   survives being looked at in a screenshot and does not depend on a
 *   console anyone has to open.
 * Inputs: into - where to write. left, right - the two measured levels.
 * Output: void.
 */
export function reportInto(
    into: HTMLElement, left: LevelBoxes, right: LevelBoxes,
): void {
    const diffs = compareLevels(left, right);
    const lines: string[] = [];
    lines.push(`rows: ${left.which} ${left.rows.length}, `
        + `${right.which} ${right.rows.length}`);
    lines.push(`level height: ${left.which} ${left.levelHeight}px, `
        + `${right.which} ${right.levelHeight}px`);
    if (left.levelHeight === 0 || right.levelHeight === 0) {
        lines.push('REFUSED: a column measured zero, so nothing was compared. '
            + 'An unattached or hidden column measures zero everywhere and '
            + 'would read as perfect agreement.');
    } else if (diffs.length === 0) {
        lines.push('VERDICT: the two rails lay out identically on every '
            + 'compared field. A spacing complaint here is a RESTYLE '
            + 'REQUEST, not a port defect.');
    } else {
        lines.push(`VERDICT: ${diffs.length} disagreements. `
            + 'A spacing complaint here is a PORT DEFECT.');
        for (const d of diffs) {
            lines.push(`  row ${d.index} ${d.field}: `
                + `${left.which}=${d.left} ${right.which}=${d.right}`
                + (d.label ? `  (${d.label})` : ''));
        }
    }
    lines.push('');
    lines.push('first three rows, side by side:');
    for (let i = 0; i < Math.min(3, left.rows.length, right.rows.length); i += 1) {
        const a = left.rows[i];
        const b = right.rows[i];
        if (!a || !b) continue;
        lines.push(`  [${i}] ${left.which}: node ${a.nodeWidth}x${a.nodeHeight}px row `
            + `${a.rowHeight}px pad ${a.rowPadding} gap ${a.rowGap} `
            + `font ${a.labelFontSize}`);
        lines.push(`  [${i}] ${right.which}: node ${b.nodeWidth}x${b.nodeHeight}px row `
            + `${b.rowHeight}px pad ${b.rowPadding} gap ${b.rowGap} `
            + `font ${b.labelFontSize}`);
    }
    into.textContent = lines.join('\n');
}
