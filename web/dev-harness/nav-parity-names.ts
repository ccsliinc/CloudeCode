/**
 * HOW MANY CARDS SHOW A NAME, HOW MANY SHOW SCRATCH, HOW MANY SHOW A
 * PATH. Counted off the rendered DOM, never off the fixture.
 *
 * SCAFFOLDING. Imported only by `nav-parity.ts`, which is imported only
 * by `nav-parity.html`. Nothing under `web/src/` can see it.
 *
 * WHY IT READS THE DOM. The fixture says what the SERVER answered; this
 * says what a person actually sees, and the two are different claims.
 * The whole refusal ladder lives between them: a row arrives carrying
 * `app_display_name` on eight different match kinds and the card is
 * supposed to draw that name on three of them, a scratch label on one,
 * and the path on the other four. Counting the fixture's
 * `app_name_source` values would report the SERVER's work and call it
 * the client's, which is exactly the confusion this page exists to
 * prevent - and a rail that had never been wired up at all would score
 * identically.
 *
 * THE LABEL'S OWN TRUNCATION IS COUNTED HERE AND NOT IN THE DENSITY
 * PASS, because it is expected and always has been: the name is the
 * scan target, it is not shrunk, and the rail is 272px at its narrowest.
 * It is reported so a derived name that is long enough to be useless can
 * be SEEN rather than assumed not to exist.
 */

/** The attribute the card stamps when it drew the app database's name. */
const NAMED_ATTR = 'data-app-named';

/** The attribute the card stamps on a measured throwaway directory. */
const SCRATCH_ATTR = 'data-app-scratch';

/** The attribute carrying the server's rung, verbatim. */
const SOURCE_ATTR = 'data-app-name-source';

/** What one level's cards are showing. */
export interface NameCensus {
    readonly which: string;
    readonly widthPx: number;
    /** Every card counted. */
    readonly total: number;
    /** Drawing the app database's name, recorded or derived. */
    readonly named: number;
    /** Drawing the scratch label. */
    readonly scratch: number;
    /** Drawing the archive path, because every rung refused. */
    readonly path: number;
    /** The server's rung, counted. Keys are `app_name_source` values. */
    readonly bySource: Readonly<Record<string, number>>;
    /** Labels whose text did not fit and had to ellipsise. */
    readonly labelTruncated: number;
    /** The longest label actually rendered, for a sanity read. */
    readonly longestLabel: string;
    /** Up to five scratch labels, so the treatment can be eyeballed. */
    readonly scratchSamples: readonly string[];
    /** Up to eight derived names, likewise. */
    readonly derivedSamples: readonly string[];
}

/**
 * Count what one rendered level is showing.
 *
 * Description: it does NOT set the width. The caller has just measured
 *   density at some width and this reads the same laid-out DOM, so a
 *   width set here would silently re-measure the truncation at a
 *   different one.
 * Inputs: which - a name for the column. level - the `ul` of cards.
 *   widthPx - the width the caller left the rail at, for the report only.
 * Output: the census.
 * Example: censusNames('svelte', level, 320)
 */
export function censusNames(
    which: string, level: HTMLElement, widthPx: number,
): NameCensus {
    const bySource: Record<string, number> = {};
    let named = 0;
    let scratch = 0;
    let path = 0;
    let labelTruncated = 0;
    let longestLabel = '';
    const scratchSamples: string[] = [];
    const derivedSamples: string[] = [];

    const items = level.querySelectorAll<HTMLElement>('li');
    items.forEach((li) => {
        const source = li.getAttribute(SOURCE_ATTR) || '(field absent)';
        bySource[source] = (bySource[source] || 0) + 1;
        const label = li.querySelector<HTMLElement>('.archive-nav__label');
        const text = (label?.textContent || '').trim();
        if (text.length > longestLabel.length) longestLabel = text;
        if (label && label.scrollWidth > label.clientWidth) labelTruncated += 1;
        if (li.getAttribute(NAMED_ATTR) === 'true') {
            named += 1;
            if (source === 'derived_cwd' && derivedSamples.length < 8) {
                derivedSamples.push(text);
            }
        } else if (li.getAttribute(SCRATCH_ATTR) === 'true') {
            scratch += 1;
            if (scratchSamples.length < 5) scratchSamples.push(text);
        } else {
            path += 1;
        }
    });

    return {
        which,
        widthPx,
        total: items.length,
        named,
        scratch,
        path,
        bySource,
        labelTruncated,
        longestLabel,
        scratchSamples,
        derivedSamples,
    };
}

/**
 * Print one census as lines a person reads.
 *
 * Description: the three counts are printed as ONE line that adds up,
 *   because the interesting failure is a row that is none of the three
 *   or two of them at once, and a reader can only see that if the sum
 *   is in front of them.
 * Inputs: census - one counted level.
 * Output: the lines.
 * Example: reportNames(censusNames(...)).join('\n')
 */
export function reportNames(census: NameCensus): readonly string[] {
    const sum = census.named + census.scratch + census.path;
    const sources = Object.keys(census.bySource).sort()
        .map((k) => `${k}=${census.bySource[k]}`).join('  ');
    const lines: string[] = [
        `${census.which} at ${census.widthPx}px, what the faces are showing`,
        `  name ${census.named}  +  scratch ${census.scratch}  +  path `
        + `${census.path}  =  ${sum} of ${census.total}`
        + `${sum === census.total ? '' : '   <-- FAILURE, a card is neither or both'}`,
        `  server rung: ${sources}`,
        `  labels ellipsised: ${census.labelTruncated} of ${census.total} `
        + '(expected: the name is not shrunk and the rail is narrow)',
        `  longest label rendered: "${census.longestLabel}"`,
    ];
    for (const sample of census.derivedSamples) {
        lines.push(`    derived: ${sample}`);
    }
    for (const sample of census.scratchSamples) {
        lines.push(`    scratch: ${sample}`);
    }
    return lines;
}
