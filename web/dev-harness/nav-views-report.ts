/**
 * READ WHAT A RENDERED RAIL SAYS, AND SAY IT BACK AS TEXT. SCAFFOLDING.
 *
 * IT READS THE DOM, NOT THE MODEL. Every figure below comes off a
 * mounted element - `textContent` for the face, `getBoundingClientRect`
 * for the height, `getAttribute` for the rung. Asking `presentationFor`
 * what it resolved would prove only that the resolver agrees with
 * itself, and a template is fully capable of reaching past a resolved
 * model to the raw row.
 *
 * THE HEIGHT IS REPORTED BESIDE THE TEXT ON PURPOSE. The change this
 * page verifies was required not to grow the card, which is 49px flat,
 * and a naming change that silently added a line would be a regression
 * nobody was looking for.
 *
 * Delete it with the rest of `web/dev-harness/` when the real shell
 * lands.
 */

/** One project row, as it actually reached the screen. */
export interface RowReading {
    /** The literal text on the card's face. */
    readonly label: string;
    /** `data-app-name-source`, or '' when the element carries none. */
    readonly source: string;
    /** True when `data-app-named` is set, i.e. the face IS the app's name. */
    readonly named: boolean;
    /** True when `data-app-scratch` is set. */
    readonly scratch: boolean;
    /** The card's own height, rounded to two decimals. */
    readonly height: number;
}

/** One arm of the page: a view, and every project row it drew. */
export interface ArmReading {
    /** 'merged', 'hosts', or the control. */
    readonly arm: string;
    /** How many project cards this arm rendered. */
    readonly cards: number;
    /** How many of them show the app database's name. */
    readonly named: number;
    /** How many show the recessive `scratch / <leaf>` face. */
    readonly scratch: number;
    /** How many fell through to a path, which is the correct refusal. */
    readonly path: number;
    /** Every distinct `data-app-name-source` seen, with its count. */
    readonly sources: Readonly<Record<string, number>>;
    /** Distinct card heights seen, so a grown card cannot hide in a mean. */
    readonly heights: readonly number[];
    /** The first rows, verbatim, so a person can read them. */
    readonly rows: readonly RowReading[];
}

/** How many rows are quoted verbatim per arm. Enough to be convincing. */
const QUOTED = 12;

/**
 * Read every project card one mounted rail drew.
 *
 * Description: selects on `[data-node-kind="project"]`, which is what
 *   the card writes, so a host or corpus row cannot be counted as a
 *   project. A rail that drew nothing yields zero counts rather than
 *   throwing - "the arm rendered no cards" is a finding and must reach
 *   the report instead of stopping it.
 * Inputs: host (HTMLElement) - the element the rail was mounted into.
 *   arm (string) - the label for this arm.
 * Output: ArmReading.
 * Example: readArm('merged', box).rows[0].label   // -> 'CloudeCode'
 */
export function readArm(arm: string, host: HTMLElement): ArmReading {
    const cards = Array.from(
        host.querySelectorAll('[data-node-kind="project"]'),
    ) as HTMLElement[];
    const sources: Record<string, number> = {};
    const heights: number[] = [];
    const rows: RowReading[] = [];
    let named = 0;
    let scratch = 0;

    for (const li of cards) {
        const src = li.getAttribute('data-app-name-source') || '';
        sources[src || '(no source field)'] = (sources[src || '(no source field)'] || 0) + 1;
        const isNamed = li.getAttribute('data-app-named') === 'true';
        const isScratch = li.getAttribute('data-app-scratch') === 'true';
        if (isNamed) named += 1;
        if (isScratch) scratch += 1;
        const card = li.querySelector('.archive-nav__card') as HTMLElement | null;
        const h = card ? Math.round(card.getBoundingClientRect().height * 100) / 100 : 0;
        if (heights.indexOf(h) === -1) heights.push(h);
        // QUOTE THE FIRST FEW, THEN ONE OF EVERY RUNG. Quoting only the
        // head of a 100 row list shows 12 rows that all resolved the
        // same way, which is exactly the reading that has been mistaken
        // for a pass here before. The rungs that REFUSE are the ones a
        // reader needs to see the literal text of.
        const seenRung = rows.some((r) => r.source === src);
        if (rows.length < QUOTED || !seenRung) {
            const label = li.querySelector('.archive-nav__label');
            rows.push({
                label: (label?.textContent || '').trim(),
                source: src,
                named: isNamed,
                scratch: isScratch,
                height: h,
            });
        }
    }

    return {
        arm,
        cards: cards.length,
        named,
        scratch,
        path: cards.length - named - scratch,
        sources,
        heights: heights.sort((a, b) => a - b),
        rows,
    };
}

/** Escape text for the report. The labels are real paths and real names. */
function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the readings as a page a person and a script can both read.
 *
 * Description: plain text inside a `<pre>`, because the consumer is
 *   `measure_nav_views.py` reading `textContent` out of a real browser
 *   and a person reading the same page. Two renderings of one reading
 *   would drift.
 * Inputs: arms (readonly ArmReading[]).
 * Output: the HTML.
 * Example: reportHtml([readArm('merged', box)])
 */
export function reportHtml(arms: readonly ArmReading[]): string {
    const lines: string[] = [];
    for (const a of arms) {
        lines.push(`=== ARM: ${a.arm}`);
        lines.push(`    project cards rendered : ${a.cards}`);
        lines.push(`    showing the app name   : ${a.named}`);
        lines.push(`    showing scratch / leaf : ${a.scratch}`);
        lines.push(`    showing a path (refused or undecorated) : ${a.path}`);
        lines.push(`    distinct card heights  : ${a.heights.join(', ')}`);
        const srcs = Object.keys(a.sources).sort()
            .map((k) => `${k}=${a.sources[k]}`).join('  ');
        lines.push(`    app_name_source values : ${srcs}`);
        lines.push(`    first ${a.rows.length} rows, verbatim:`);
        for (const r of a.rows) {
            const tag = r.named ? 'NAME ' : r.scratch ? 'SCRAT' : 'path ';
            lines.push(`      [${tag}] ${JSON.stringify(r.label)}`
                + `   source=${r.source || '(none)'}  h=${r.height}`);
        }
        lines.push('');
    }
    return `<pre>${esc(lines.join('\n'))}</pre>`;
}
