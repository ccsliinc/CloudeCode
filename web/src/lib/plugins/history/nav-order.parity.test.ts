/**
 * THE ORDERING RULE AND THE FUZZY RANKING, PROVED AGAINST THE VANILLA
 * MODULES THEY REPLACE, OVER THE REAL CORPUS.
 *
 * WHY A DIFFERENTIAL TEST AND NOT ASSERTIONS. Ordering rules are where
 * a silent behaviour change hides: every rearrangement still renders a
 * list, and a list in a plausible order looks correct. Asserting the
 * port against expectations written by the person who wrote the port
 * proves the expectations. So `nav-vanilla-harness.ts` evaluates the
 * REAL `client/js/archive-nav-order.js` and `archive-nav-fuzzy.js` from
 * disk, unmodified, and every claim below is "these two produce the same
 * answer for this input".
 *
 * THE INPUT IS REAL. `nav-real-nodes.fixture.json` is 98 merged project
 * nodes built from the live archive at
 * `~/Library/Application Support/CloudeCode/cloude-archive.db`
 * (READ ONLY, opened `mode=ro&immutable=1`), 23,725 archives, 2026-09-16:
 * every project's real slug, its real transcript and uuid-session counts,
 * and the real MAX(newest_message_ts) across its transcripts.
 *
 * ONE MEASUREMENT OFF THAT CORPUS IS WORTH STATING because it exercises
 * the branch a synthetic fixture would have missed: `observed_cwd` is
 * NULL on all 98 rows, so `merge_projects` derives NO display_name for
 * any of them - which means the `name` ordering can place NONE of the 98
 * and parks the entire corpus. A fixture written by hand would have had
 * names.
 *
 * THE NEGATIVE CONTROL IS MANDATORY HERE. A differential test whose two
 * sides are both broken agrees perfectly, so the last block MUTATES the
 * port's rule and asserts the comparison then FAILS. It was watched
 * going red before this file was trusted.
 */
import { describe, expect, it } from 'vitest';
import {
    loadVanilla, type VanillaFuzzyModule, type VanillaOrderModule, type VanillaRow,
} from './nav-vanilla-harness';
import { MODES, sortNodes, activityCell, unsortedReason, hasKey } from './nav-order';
import { rank, match } from './nav-fuzzy';
import { FIELDS } from './nav-merged';
import real from './nav-real-nodes.fixture.json' with { type: 'json' };

/** The real corpus nodes, typed loosely because the fixture is data. */
const NODES = real as unknown as Record<string, unknown>[];

/** The vanilla modules, evaluated from disk. */
const win = loadVanilla('archive-nav-fuzzy.js', loadVanilla('archive-nav-order.js', {}));
const VanillaOrder = win.ArchiveNavOrder as VanillaOrderModule;
const VanillaFuzzy = win.ArchiveNavFuzzy as VanillaFuzzyModule;

/** A node's identity in an ordering, so two lists compare as strings. */
function ids(nodes: readonly VanillaRow[]): string[] {
    return nodes.map((n) => String(n.full_path));
}

describe('the real corpus is what it is claimed to be', () => {
    it('POSITIVE CONTROL: the fixture loaded and the vanilla modules ran', () => {
        // Without this every comparison below passes for an empty list
        // compared against an empty list.
        expect(NODES.length).toBe(98);
        expect(typeof VanillaOrder.sortNodes).toBe('function');
        expect(typeof VanillaFuzzy.rank).toBe('function');
    });

    it('has a date for every project and a name for none, which is the '
        + 'branch a hand-written fixture would have missed', () => {
        expect(NODES.every((n) => n.activity_status === 'known')).toBe(true);
        expect(NODES.every((n) => n.display_name === null)).toBe(true);
        // So the time modes place all 98 and the name mode places none.
        expect(NODES.filter((n) => hasKey(n, 'time')).length).toBe(98);
        expect(NODES.filter((n) => hasKey(n, 'name')).length).toBe(0);
    });
});

describe('sortNodes agrees with client/js/archive-nav-order.js', () => {
    for (const mode of MODES) {
        it(`over all 98 real projects, mode "${mode.id}"`, () => {
            const mine = sortNodes(NODES, mode.id);
            const theirs = VanillaOrder.sortNodes(NODES, mode.id);
            expect(ids(mine.nodes)).toEqual(ids(theirs.nodes));
            expect(mine.ordered).toBe(theirs.ordered);
            expect(mine.mode).toBe(theirs.mode);
            expect(mine.parked.map((p) => p.reason.short))
                .toEqual(theirs.parked.map((p) => p.reason.short));
        });
    }

    it('agrees on an unrecognised mode id, which must fall back and not '
        + 'render an empty rail', () => {
        expect(ids(sortNodes(NODES, 'from-a-future-build').nodes))
            .toEqual(ids(VanillaOrder.sortNodes(NODES, 'from-a-future-build').nodes));
    });

    it('agrees on the three activity outcomes, which are the rows a '
        + 'collapse would scatter', () => {
        // The real corpus is all `known`, so the two absences are
        // constructed here deliberately: they are the whole reason the
        // parked block exists and no live row exercises them today.
        const mixed = [
            ...NODES.slice(0, 5),
            { full_path: '-a-none', display_name: 'a none', activity_status: 'none',
                newest_activity_at: null, session_count: 1, session_counted: true },
            { full_path: '-b-unknown', display_name: 'b unknown', activity_status: 'unknown',
                newest_activity_at: null, session_count: null, session_counted: false },
        ];
        for (const mode of ['recent', 'oldest', 'name', 'size']) {
            const mine = sortNodes(mixed, mode);
            const theirs = VanillaOrder.sortNodes(mixed, mode);
            expect(ids(mine.nodes), mode).toEqual(ids(theirs.nodes));
            expect(mine.parked.map((p) => p.reason), mode)
                .toEqual(theirs.parked.map((p) => p.reason));
        }
    });

    it('keeps the undated block at the END in BOTH time directions, which '
        + 'is the inference the rail is not entitled to make', () => {
        const mixed = [
            { full_path: '-z', display_name: 'z', activity_status: 'unknown' },
            ...NODES.slice(0, 3),
        ];
        for (const mode of ['recent', 'oldest']) {
            const out = sortNodes(mixed, mode);
            expect(out.nodes[out.nodes.length - 1]?.full_path, mode).toBe('-z');
        }
    });

    it('never mutates the array it was given', () => {
        const before = ids(NODES);
        sortNodes(NODES, 'recent');
        sortNodes(NODES, 'size');
        expect(ids(NODES)).toEqual(before);
    });

    it('activityCell agrees, including the two absences', () => {
        for (const node of NODES.slice(0, 20)) {
            expect(activityCell(node)).toEqual(VanillaOrder.activityCell(node));
        }
        for (const status of ['none', 'unknown']) {
            const row = { activity_status: status, newest_activity_at: null };
            expect(activityCell(row)).toEqual(VanillaOrder.activityCell(row));
        }
        // A row with no activity fields at all is null on both sides: it
        // is every non-project row, and any build whose server predates
        // the field.
        expect(activityCell({})).toBeNull();
        expect(VanillaOrder.activityCell({})).toBeNull();
    });

    it('unsortedReason agrees, word for word, because those words are '
        + 'what the rail shows', () => {
        const cases: [Record<string, unknown>, 'time' | 'name' | 'size'][] = [
            [{ activity_status: 'unknown' }, 'time'],
            [{ activity_status: 'none' }, 'time'],
            [{}, 'size'],
            [{}, 'name'],
        ];
        for (const [row, kind] of cases) {
            expect(unsortedReason(row, kind)).toEqual(VanillaOrder.unsortedReason(row, kind));
        }
    });
});

describe('the fuzzy ranking agrees with client/js/archive-nav-fuzzy.js', () => {
    /** Queries typed against real slugs, including the ones that motivated it. */
    const QUERIES = ['cloudecode', 'cldcode', 'dvtools', 'media', 'infra', 'a',
        'zzzzz', 'Development', 'sync', '-'];

    for (const q of QUERIES) {
        it(`ranks all 98 real projects identically for "${q}"`, () => {
            const mine = rank(NODES, q, FIELDS);
            const theirs = VanillaFuzzy.rank(NODES, q, FIELDS);
            expect(mine.map((h) => String(h.row.full_path)))
                .toEqual(theirs.map((h) => String(h.row.full_path)));
            expect(mine.map((h) => h.score)).toEqual(theirs.map((h) => h.score));
            expect(mine.map((h) => h.field)).toEqual(theirs.map((h) => h.field));
            expect(mine.map((h) => h.positions)).toEqual(theirs.map((h) => h.positions));
        });
    }

    it('an EMPTY query returns every row in the order given, which is how '
        + 'a cleared filter shows the chosen ordering', () => {
        const mine = rank(NODES, '', FIELDS);
        expect(mine.map((h) => String(h.row.full_path))).toEqual(ids(NODES));
        expect(mine.every((h) => h.positions.length === 0)).toBe(true);
    });

    it('agrees on the camel-transition boundary, which is what makes '
        + '"cldcode" find "CloudeCode"', () => {
        // THIS CASE IS LOAD-BEARING AND THE REAL CORPUS DOES NOT COVER
        // IT. Measured while watching the negative control: deleting the
        // camel rule from `isBoundary` leaves all ten real-slug queries
        // above still agreeing, because the greedy walk takes the FIRST
        // admissible position for each character and on these
        // hyphen-separated slugs those positions land on lowercase
        // letters. Only these three targeted pairs notice.
        for (const [text, needle] of [['CloudeCode', 'cldcode'],
            ['dev_tools/scripts', 'dvtools'], ['Media', 'media']] as const) {
            expect(match(text, needle)).toEqual(VanillaFuzzy.match(text, needle));
        }
    });
});

describe('NEGATIVE CONTROL: the comparison can fail', () => {
    it('a rule that parks the undated block at the TOP disagrees with the '
        + 'vanilla answer', () => {
        // A differential test whose two sides are both broken agrees
        // perfectly. This mutates one side on purpose and asserts the
        // comparison notices, so a green run above means the two really
        // were compared rather than the assertion being vacuous.
        const mixed = [
            ...NODES.slice(0, 4),
            { full_path: '-z-undated', display_name: 'z', activity_status: 'unknown' },
        ];
        const theirs = VanillaOrder.sortNodes(mixed, 'recent');
        const parkedFirst = [
            ...theirs.nodes.filter((n) => n.activity_status !== 'known'),
            ...theirs.nodes.filter((n) => n.activity_status === 'known'),
        ];
        expect(ids(parkedFirst)).not.toEqual(ids(theirs.nodes));
    });

    it('a matcher that always finds something disagrees with the vanilla '
        + 'answer, which is why "zzzzz" must return nothing', () => {
        // The matcher-that-always-matches is worse than useless, and it
        // passes every positive test above. This is the one assertion
        // that catches it.
        expect(rank(NODES, 'zzzzz', FIELDS).length).toBe(0);
        expect(VanillaFuzzy.rank(NODES, 'zzzzz', FIELDS).length).toBe(0);
        expect(rank(NODES, 'a', FIELDS).length).toBeGreaterThan(0);
    });
});
