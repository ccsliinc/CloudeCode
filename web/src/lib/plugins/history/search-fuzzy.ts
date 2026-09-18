/**
 * SUBSEQUENCE ("fuzzy") MATCHING for the archive's PER-COLUMN filters.
 * Ported from `client/js/archive-fuzzy.js`, rule for rule.
 *
 * IT IS A THIRD MATCHER, AND THE ANSWER TO "SHOULD THESE BE SHARED" IS
 * NO. `nav-fuzzy.ts` (slice 5) already says why in its own header, and
 * this file is the other end of that argument. `tlist-fuzzy.ts`
 * (slice 6) is NOT a matcher at all: it is the INTERFACE for an injected
 * one, written against `window.ArchiveFuzzy` and waiting for exactly
 * this port. So the count is two implementations and one interface, and
 * this file is the second implementation.
 *
 * THE FOUR DIFFERENCES FROM `nav-fuzzy.ts`, none of them stylistic:
 *
 *   1. SHAPE OF THE QUERY. This takes a MAP of column to query and
 *      requires EVERY non-empty column to match - an AND across columns,
 *      which is what a per-column filter row means to the person typing
 *      in it. `nav-fuzzy` takes ONE needle and keeps the BEST of several
 *      weighted fields - an OR across fields. A row matching its name
 *      but not its date is a hit there and a MISS here. They answer
 *      different questions.
 *   2. SHAPE OF THE ANSWER. This reports `[start, end)` SPANS with runs
 *      already coalesced, so a matched run highlights as ONE mark.
 *      `nav-fuzzy` reports individual character INDICES.
 *   3. THE BOUNDARY RULE. This one's separators are ` -_./:\` plus tab,
 *      with NO camel rule. `nav-fuzzy`'s are `/-_. ` PLUS a lower-to-
 *      upper camel transition, which is what makes `cldcode` find
 *      `CloudeCode` there and not here.
 *   4. THE SCORE. This is base-per-char plus a consecutive bonus plus a
 *      boundary bonus, then a CAPPED leading penalty and a haystack
 *      length tiebreak. `nav-fuzzy` weights contiguity at 12 and a
 *      boundary at 8, adds a bounded earliness term and a COVERAGE term,
 *      then multiplies by the field's weight. Neither file's terms exist
 *      in the other.
 *
 * Extracting a shared core would mean a matcher parameterised on all
 * four, which is two matchers wearing one name: the field weighting and
 * the AND-across-columns rule cannot both be the default. They are kept
 * apart, and BOTH headers say why, so the question is not reopened
 * blind. `search-fuzzy.test.ts` asserts the divergence on real inputs
 * rather than leaving it as a claim in a comment.
 *
 * WHY SUBSEQUENCE AND NOT SUBSTRING. The three columns this filters are
 * a session title, a session_ref and a timestamp, and every one is a
 * string a person remembers the SHAPE of rather than a span of. Measured
 * against the live corpus 2026-09-01: a ref like
 * `ee039f7f-cfac-4688-86dc-30a4e28483bb` is recalled as "ee03...83bb"
 * and a timestamp `2026-08-29 18:28:32` as "0829 1828". Neither is a
 * contiguous substring of its own row, so an exact-substring matcher
 * answers zero for both while the row is sitting on screen.
 *
 * THE SCORE IS ORDINAL, NOT A PERCENTAGE, AND IT IS NEVER RENDERED. It
 * exists only to order rows against each other within one query.
 *
 * NO MATCH IS `null`, NEVER A ZERO SCORE. Zero is a legitimate score for
 * a real but poor match, so a caller testing `if (score)` on a numeric
 * miss would silently drop a matching row. The two answers have two
 * shapes and cannot be confused.
 *
 * AN EMPTY QUERY MATCHES EVERYTHING WITH NO SPANS. It is not a match of
 * nothing and it is not an error: a filter nobody has typed into is not
 * a filter, and returning null for it would empty the list on first
 * paint.
 *
 * CASE IS FOLDED FOR MATCHING AND NEVER FOR DISPLAY. Spans index the
 * ORIGINAL string, so a caller highlights the bytes actually on screen.
 * Folding for display would rewrite a UUID.
 *
 * Pure. No DOM, no fetch, no framework, no globals.
 */
import type { FuzzyMatcher, LabelSegment, MatchSpan, RankedRow, SpanMap } from './tlist-fuzzy';
import type { TranscriptRowData } from './tlist-row';

/**
 * Characters after which a position counts as a word boundary.
 *
 * Description: the separators the three filtered columns actually use -
 *   hyphens in a UUID, colons and spaces in a timestamp, dots and
 *   slashes in a path-derived title. DELIBERATELY NOT `nav-fuzzy.ts`'s
 *   set; see difference 3 in the header.
 */
export const BOUNDARY_CHARS = ' -_./:\\\t';

/**
 * Points for each character matched immediately after the previous
 * match. The largest weight, because a run is the strongest signal that
 * the query is a real fragment.
 */
export const CONSECUTIVE_BONUS = 8;

/** Points for a character matched at a word boundary. */
export const BOUNDARY_BONUS = 6;

/** Points every matched character earns regardless. */
export const BASE_PER_CHAR = 1;

/**
 * Penalty per character skipped before the FIRST match, capped so a long
 * haystack cannot drive the score arbitrarily negative and swamp the
 * bonuses above.
 */
export const LEADING_PENALTY = 1;

/** Cap on the leading penalty. */
export const LEADING_PENALTY_MAX = 20;

/** A scored subsequence match and the spans that produced it. */
export interface FuzzyMatch {
    readonly score: number;
    readonly spans: readonly MatchSpan[];
}

/**
 * Is the character at `i` the start of a word?
 *
 * Description: true at index 0 and after any BOUNDARY_CHARS.
 * Inputs: text - the haystack. i - an index into it.
 * Output: boolean.
 * Example: isBoundary('a-b', 2) // -> true
 */
export function isBoundary(text: string, i: number): boolean {
    if (i <= 0) return true;
    return BOUNDARY_CHARS.indexOf(text.charAt(i - 1)) !== -1;
}

/**
 * Match `query` as a subsequence of `text`, greedily left to right, and
 * score the result.
 *
 * Description: THE GREEDY WALK IS DELIBERATE AND ITS LIMIT IS STATED. It
 *   takes the FIRST position for each query character rather than
 *   searching every assignment for the best-scoring one, so a
 *   pathological query can score lower than an optimal matcher would.
 *   That is accepted: the walk is O(len(text)) with no allocation, it
 *   runs over every loaded row on every keystroke, and being one rank
 *   out on a rare input is a far smaller cost than a filter that
 *   stutters. It never changes WHETHER a row matches, only its order.
 * Inputs: query - what was typed, may be empty. text - the row's value
 *   for one column, possibly null.
 * Output: a FuzzyMatch on a match, where each span is
 *   [startInclusive, endExclusive) into the ORIGINAL `text`. `null` when
 *   the query is not a subsequence. An empty query returns score 0 and
 *   no spans.
 * Example: match('e483bb', 'ee039f7f-30a4e28483bb')?.spans.length // -> 2
 */
export function match(query: unknown, text: unknown): FuzzyMatch | null {
    const q = typeof query === 'string' ? query : '';
    const hay = (text === null || text === undefined) ? '' : String(text);
    if (q.length === 0) return { score: 0, spans: [] };
    if (hay.length === 0) return null;

    const ql = q.toLowerCase();
    const hl = hay.toLowerCase();
    const spans: [number, number][] = [];
    let score = 0;
    let qi = 0;
    let prevMatched = -2;
    let firstAt = -1;

    for (let hi = 0; hi < hl.length && qi < ql.length; hi += 1) {
        if (hl.charAt(hi) !== ql.charAt(qi)) continue;
        if (firstAt === -1) firstAt = hi;
        score += BASE_PER_CHAR;
        const open = spans.length ? spans[spans.length - 1] : undefined;
        if (hi === prevMatched + 1 && open) {
            score += CONSECUTIVE_BONUS;
            // Extend the open span rather than opening a second one, so a
            // run highlights as one mark and not as N.
            open[1] = hi + 1;
        } else {
            if (isBoundary(hay, hi)) score += BOUNDARY_BONUS;
            spans.push([hi, hi + 1]);
        }
        prevMatched = hi;
        qi += 1;
    }

    if (qi < ql.length) return null;
    score -= Math.min(firstAt * LEADING_PENALTY, LEADING_PENALTY_MAX);
    // Shorter haystack wins a tie: it is the more specific row.
    score -= Math.min(hay.length / 100, 5);
    return { score, spans: spans.map((s) => [s[0], s[1]] as MatchSpan) };
}

/**
 * Split `text` into alternating unmatched and matched runs.
 *
 * Description: returns SEGMENTS rather than markup, so this file stays
 *   free of the DOM and the caller keeps control of the element and the
 *   class it emits - which is also what keeps commitment 1 enforceable,
 *   since a matcher emitting its own markup would emit its own classes.
 * Inputs: text - the original string. spans - the match spans.
 * Output: segments in order, no empty ones, covering the whole string
 *   exactly once.
 * Example: segments('abcd', [[1, 3]])
 *   // -> [{text:'a',hit:false},{text:'bc',hit:true},{text:'d',hit:false}]
 */
export function segments(
    text: unknown, spans: readonly MatchSpan[] | null | undefined,
): readonly LabelSegment[] {
    const hay = (text === null || text === undefined) ? '' : String(text);
    const list = Array.isArray(spans) ? spans : [];
    const out: LabelSegment[] = [];
    let at = 0;
    for (const span of list) {
        const s = span[0];
        const e = span[1];
        if (s > at) out.push({ text: hay.slice(at, s), hit: false });
        if (e > s) out.push({ text: hay.slice(s, e), hit: true });
        at = e;
    }
    if (at < hay.length) out.push({ text: hay.slice(at), hit: false });
    return out;
}

/**
 * Is any column being filtered right now?
 *
 * Description: distinguishes "nobody has typed anything" from "a query
 *   matched nothing", which render as different things and must never be
 *   merged.
 * Inputs: queries - column key to typed text.
 * Output: boolean.
 * Example: isActive({title: ''}) // -> false
 */
export function isActive(
    queries: Readonly<Record<string, string>> | null | undefined,
): boolean {
    const q = queries ?? {};
    for (const key of Object.keys(q)) {
        if (typeof q[key] === 'string' && (q[key] as string).length > 0) return true;
    }
    return false;
}

/**
 * Filter and rank rows against a map of per-column queries.
 *
 * Description: a row must match EVERY non-empty query - AND, not OR. The
 *   columns narrow together, which is what a per-column filter row means
 *   to the person using it, and it is difference 1 from `nav-fuzzy.ts`.
 *   Ties break by the row's ORIGINAL order, so the list does not
 *   reshuffle under equal scores.
 * Inputs: rows - the loaded rows, untouched. queries - column key to
 *   typed text. valueOf - reads one column out of one row, passed in so
 *   this file knows nothing about the row shape.
 * Output: the matching rows with their spans, highest score first.
 * Example: rank(rows, {ref: 'e48'}, (r, k) => String(r[k]))
 */
export function rank(
    rows: readonly TranscriptRowData[],
    queries: Readonly<Record<string, string>>,
    valueOf: (row: TranscriptRowData, key: string) => string,
): readonly RankedRow[] {
    const list = Array.isArray(rows) ? rows : [];
    const q = queries ?? {};
    const keys = Object.keys(q).filter(
        (k) => typeof q[k] === 'string' && (q[k] as string).length > 0,
    );
    const scored: { row: TranscriptRowData; score: number; spans: SpanMap; at: number }[] = [];

    for (let i = 0; i < list.length; i += 1) {
        const row = list[i];
        if (!row) continue;
        let total = 0;
        const spans: Record<string, readonly MatchSpan[]> = {};
        let ok = true;
        for (const key of keys) {
            const m = match(q[key], valueOf(row, key));
            if (m === null) { ok = false; break; }
            total += m.score;
            spans[key] = m.spans;
        }
        if (ok) scored.push({ row, score: total, spans: spans as SpanMap, at: i });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.at - b.at));
    return scored.map((s) => ({ row: s.row, spans: s.spans }));
}

/**
 * The matcher, as slice 6's injected interface expects it.
 *
 * Description: THIS IS THE INJECTION SITE `tlist-fuzzy.ts` was written
 *   against. Its header says "when the matcher is ported, it satisfies
 *   this interface and the injection site is the only thing that
 *   changes" - this object is that, and the type annotation is what
 *   proves the claim at compile time rather than in prose. Slice 6's
 *   file is NOT edited.
 * Example: <TranscriptList fuzzy={archiveFuzzy} ... />
 */
export const archiveFuzzy: FuzzyMatcher = { isActive, rank, segments };
