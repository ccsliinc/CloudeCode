/**
 * FUZZY SUBSEQUENCE MATCHING for the rail's project filter, with the
 * matched character POSITIONS handed back so the label can mark them.
 *
 * IT IS NOT THE SAME ALGORITHM AS SLICE 6'S, AND THE TWO MUST BOTH
 * EXIST. `tlist-fuzzy.ts` is not a matcher at all: it is an INTERFACE
 * for an injected one, and the implementation behind it is
 * `client/js/archive-fuzzy.js`, a different vanilla module from this
 * one. They differ in four ways that are not stylistic:
 *
 *   1. SHAPE OF THE QUERY. `archive-fuzzy` takes a MAP of column to
 *      query and requires EVERY non-empty column to match (an AND across
 *      columns). This takes ONE needle and keeps the BEST of several
 *      weighted fields (an OR across fields). A row matching only its
 *      path is a hit here and would be a hit there too - but a row
 *      matching the name and not the date is a hit here and a MISS
 *      there. The two answer different questions.
 *   2. SHAPE OF THE ANSWER. That one reports `[start, end)` SPANS, runs
 *      already coalesced. This reports individual character INDICES.
 *   3. THE BOUNDARY RULE. That one's separators are ` -_./:\` plus tab,
 *      with no camel rule. This one's are `/-_. ` PLUS a lower-to-upper
 *      camel transition, which is what makes `CloudeCode` yield two word
 *      starts and is the reason `cldcode` finds it.
 *   4. THE SCORE. That one is base-per-char plus a consecutive bonus
 *      plus a boundary bonus. This one weights contiguity at 12 and a
 *      boundary at 8, then adds a BOUNDED earliness term and a COVERAGE
 *      term (query length over candidate length), and finally multiplies
 *      by the field's weight. Neither term exists in the other.
 *
 * Extracting a shared core would mean a matcher parameterised on all
 * four, which is two matchers wearing one name: the field weighting and
 * the AND-across-columns rule cannot both be the default. They are kept
 * apart, and this file says why so the question is not reopened blind.
 *
 * WHY NOT A SUBSTRING FILTER. The rail's old filter was
 * `indexOf(needle) !== -1`, which requires a contiguous run. Against
 * this corpus that fails on what people actually type: `cloudecode` does
 * not find `CloudeCode` if they typed `cldcode`, and `dvtools` never
 * finds `dev_tools/scripts` although every letter is there in order.
 *
 * IT IS STILL A FILTER OVER LOADED ROWS AND SAYS SO. Fuzziness does not
 * widen the scope. The sentence the rail prints beside it is unchanged,
 * because making a filter cleverer without making it broader is exactly
 * when a person is most likely to read it as a search.
 *
 * MATCHING IS CASE-INSENSITIVE, MARKING IS NOT. Positions index the
 * ORIGINAL string, so the rail marks the real characters and never
 * re-cases what it shows.
 *
 * Ported from client/js/archive-nav-fuzzy.js. Pure; no DOM.
 */

/** Characters after which the next character starts a new "word". */
export const BOUNDARY_CHARS = '/-_. ';

/** One field to search, and how much a hit in it is worth. */
export interface FuzzyField {
    readonly name: string;
    readonly weight: number;
}

/** A scored subsequence match and the indices that produced it. */
export interface FuzzyHit {
    readonly score: number;
    readonly positions: readonly number[];
}

/** The best field's hit for one row. */
export interface FuzzyRowHit extends FuzzyHit {
    readonly field: string;
}

/** One ranked row: the row, its score, which field matched, and where. */
export interface RankedNavRow<T> {
    readonly row: T;
    readonly score: number;
    readonly field: string | null;
    readonly positions: readonly number[];
    /** Incoming index, so ties fall back to the order given. */
    readonly index: number;
}

/** One run of a label, and whether it matched. */
export interface NavSegment {
    readonly text: string;
    readonly hit: boolean;
}

/**
 * Is the character at `i` the start of a word?
 *
 * Description: true at index 0, after a boundary character, and at a
 *   lower-to-upper camel transition.
 * Inputs: text - the ORIGINAL, un-lowercased string. i - the index.
 * Output: whether a word starts there.
 * Example: isBoundary('CloudeCode', 6)   // -> true
 */
export function isBoundary(text: string, i: number): boolean {
    if (i === 0) return true;
    const prev = text.charAt(i - 1);
    if (BOUNDARY_CHARS.includes(prev)) return true;
    const cur = text.charAt(i);
    return prev === prev.toLowerCase() && prev !== prev.toUpperCase()
        && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Match `needle` as a subsequence of `text`, greedily left to right, and
 * score the run.
 *
 * Description: the greedy walk takes the FIRST admissible position for
 *   each needle character, which is not always the highest-scoring
 *   alignment. For a rail of this size and queries of a few characters
 *   that difference is not observable, and an optimal alignment is a
 *   dynamic program nobody here needs. If this ever moves to a set large
 *   enough for the ranking to matter, replace the walk, not the scoring.
 * Inputs: text - the candidate. needle - the query.
 * Output: the hit, or null when `needle` is not a subsequence. An EMPTY
 *   needle returns score 0 with no positions: it matches everything,
 *   which is how a cleared filter shows every row.
 * Example: match('dev_tools/scripts', 'dvtools').positions.length  // -> 7
 */
export function match(text: unknown, needle: unknown): FuzzyHit | null {
    const haystack = String(text === null || text === undefined ? '' : text);
    const query = String(needle === null || needle === undefined ? '' : needle);
    if (!query) return { score: 0, positions: [] };
    if (!haystack) return null;

    const lowerHay = haystack.toLowerCase();
    const lowerNeedle = query.toLowerCase();
    const positions: number[] = [];
    let at = 0;
    for (let n = 0; n < lowerNeedle.length; n += 1) {
        const found = lowerHay.indexOf(lowerNeedle.charAt(n), at);
        if (found === -1) return null;
        positions.push(found);
        at = found + 1;
    }

    let score = 0;
    for (let p = 0; p < positions.length; p += 1) {
        const idx = positions[p] as number;
        // Contiguity: the dominant term, so an adjacent run wins.
        if (p > 0 && idx === (positions[p - 1] as number) + 1) score += 12;
        if (isBoundary(haystack, idx)) score += 8;
    }
    // Earliness, as a tie-break only: bounded so it can never outweigh a
    // genuinely contiguous match further along.
    score += Math.max(0, 10 - (positions[0] as number));
    // A query that covers most of the candidate is a better answer than
    // the same query buried in a much longer string.
    score += Math.round((query.length / haystack.length) * 10);
    return { score, positions };
}

/**
 * Score one row across several fields and keep the best field's result,
 * so a row is ranked by its strongest evidence and the rail marks the
 * field it actually matched.
 *
 * Inputs: row, needle, fields.
 * Output: the best hit, or null when no field matched.
 * Example: matchRow({display_name: 'Media'}, 'mda', FIELDS)?.field
 *   // -> 'display_name'
 */
export function matchRow<T extends Record<string, unknown>>(
    row: T | null | undefined,
    needle: string,
    fields: readonly FuzzyField[],
): FuzzyRowHit | null {
    let best: FuzzyRowHit | null = null;
    for (const spec of fields) {
        const value = row ? row[spec.name] : undefined;
        if (typeof value !== 'string') continue;
        const hit = match(value, needle);
        if (!hit) continue;
        const weighted = hit.score * (typeof spec.weight === 'number' ? spec.weight : 1);
        if (!best || weighted > best.score) {
            best = { score: weighted, field: spec.name, positions: hit.positions };
        }
    }
    return best;
}

/**
 * Filter and RANK rows fuzzily. The rail's replacement for a substring
 * filter.
 *
 * Inputs: rows. needle - '' returns every row, unranked and in order.
 *   fields - the weighted fields to search.
 * Output: each `{row, score, field, positions, index}`, best first. Ties
 *   fall back to the incoming order, so a rail built from a sorted list
 *   stays stable.
 * Example: rank(rows, 'dvtools', FIELDS)[0].row
 */
export function rank<T extends Record<string, unknown>>(
    rows: readonly T[] | null | undefined,
    needle: unknown,
    fields: readonly FuzzyField[],
): readonly RankedNavRow<T>[] {
    const list = Array.isArray(rows) ? rows : [];
    const query = String(needle === null || needle === undefined ? '' : needle);
    const specs = Array.isArray(fields) && fields.length
        ? fields
        : [{ name: 'display_name', weight: 3 }, { name: 'full_path', weight: 1 }];
    if (!query) {
        return list.map((row, index) => ({ row, score: 0, field: null, positions: [], index }));
    }
    const out: RankedNavRow<T>[] = [];
    list.forEach((row, index) => {
        const hit = matchRow(row, query, specs);
        if (hit) {
            out.push({ row, score: hit.score, field: hit.field, positions: hit.positions, index });
        }
    });
    out.sort((a, b) => b.score - a.score || a.index - b.index);
    return out;
}

/**
 * Split `text` into marked and unmarked runs.
 *
 * Description: replaces the vanilla `highlight`, which built a DOM
 *   fragment. A Svelte template renders the marks itself, so this
 *   returns DATA and no innerHTML is involved anywhere - slugs and
 *   folder names in this corpus contain real punctuation and a U+2019,
 *   they are text, and they reach the DOM as text.
 * Inputs: text, positions - indices into `text`.
 * Output: the runs, in order. An empty text yields no segments.
 * Example: segments('abc', [1])
 *   // -> [{text:'a',hit:false},{text:'b',hit:true},{text:'c',hit:false}]
 */
export function segments(
    text: unknown,
    positions: readonly number[] | null | undefined,
): readonly NavSegment[] {
    const source = String(text === null || text === undefined ? '' : text);
    const marks = new Set<number>(Array.isArray(positions) ? positions : []);
    const out: NavSegment[] = [];
    let buffer = '';
    let inMark = false;
    const flush = (): void => {
        if (buffer) out.push({ text: buffer, hit: inMark });
        buffer = '';
    };
    for (let c = 0; c < source.length; c += 1) {
        const wanted = marks.has(c);
        if (wanted !== inMark) { flush(); inMark = wanted; }
        buffer += source.charAt(c);
    }
    flush();
    return out;
}
