/**
 * `search-fuzzy.ts`, AND THE EVIDENCE THAT IT IS A THIRD MATCHER RATHER
 * THAN A DUPLICATE OF SLICE 5'S.
 *
 * WHY THE DIVERGENCE IS ASSERTED AND NOT ASSUMED. Both files' headers
 * claim the two algorithms differ in four ways. A claim in a comment is
 * a claim; the moment somebody "de-duplicates" them, the comments still
 * read correctly and the behaviour is gone. So this file drives BOTH
 * matchers on the same inputs and asserts they DISAGREE, which is a test
 * that fails the day a shared core is extracted - exactly when somebody
 * needs to be told.
 *
 * THE POSITIVE HALF IS EQUALLY LOAD-BEARING: two matchers that disagreed
 * about everything would also pass a divergence test, so this asserts
 * the real behaviour of this one too.
 */
import { describe, expect, it } from 'vitest';
import {
    archiveFuzzy, BOUNDARY_CHARS, isActive, isBoundary, match, rank, segments,
} from './search-fuzzy';
import * as navFuzzy from './nav-fuzzy';

/** A ref and a timestamp of the shapes actually in this corpus. */
const REF = 'ee039f7f-cfac-4688-86dc-30a4e28483bb';
const STAMP = '2026-08-29 18:28:32';

describe('search-fuzzy: the matcher itself', () => {
    it('finds what people actually type, which no substring filter does', () => {
        // Measured recall shapes from the live corpus, 2026-09-01.
        expect(match('ee0383bb', REF)).not.toBeNull();
        expect(REF.includes('ee0383bb')).toBe(false);
        expect(match('08291828', STAMP)).not.toBeNull();
        expect(STAMP.includes('08291828')).toBe(false);
    });

    it('answers null for a miss and never a zero score, because zero is '
        + 'a legitimate score for a real but poor match', () => {
        expect(match('zzz', REF)).toBeNull();
        const poor = match('b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');
        expect(poor).not.toBeNull();
        // A caller testing `if (score)` on this would drop a real row.
        expect(typeof poor?.score).toBe('number');
    });

    it('matches everything with no spans on an empty query, so a filter '
        + 'nobody has typed into does not empty the list', () => {
        const m = match('', REF);
        expect(m).toEqual({ score: 0, spans: [] });
        expect(isActive({ title: '' })).toBe(false);
        expect(isActive({ title: 'a' })).toBe(true);
    });

    it('coalesces a consecutive run into ONE span, so it highlights as '
        + 'one mark rather than as N', () => {
        const m = match('e483bb', REF);
        expect(m).not.toBeNull();
        // 'e483bb' is 6 characters; a non-coalescing matcher reports 6
        // spans, this reports fewer because the tail is a run.
        expect((m?.spans.length ?? 99)).toBeLessThan(6);
    });

    it('indexes the ORIGINAL string, so a caller never re-cases a UUID', () => {
        const m = match('CFAC', REF);
        expect(m).not.toBeNull();
        const segs = segments(REF, m?.spans ?? []);
        expect(segs.map((s) => s.text).join('')).toBe(REF);
        expect(segs.filter((s) => s.hit).map((s) => s.text).join('')).toBe('cfac');
    });

    it('ANDs across columns, which is what a per-column filter row means', () => {
        const rows = [
            { title: 'deploy notes', ref: REF, date: STAMP },
            { title: 'deploy notes', ref: 'zzzz', date: STAMP },
        ] as never[];
        const got = rank(rows, { title: 'dep', ref: 'ee03' },
            (r, k) => String((r as Record<string, unknown>)[k]));
        // The second row matches `title` and MISSES `ref`, so it is out.
        expect(got).toHaveLength(1);
        expect(got[0]?.spans.title).toBeDefined();
        expect(got[0]?.spans.ref).toBeDefined();
    });

    it('breaks ties by ORIGINAL order, so the list does not reshuffle', () => {
        const rows = [
            { title: 'abc', ref: '', date: '' },
            { title: 'abc', ref: '', date: '' },
            { title: 'abc', ref: '', date: '' },
        ] as never[];
        const got = rank(rows, { title: 'abc' },
            (r, k) => String((r as Record<string, unknown>)[k]));
        expect(got.map((g) => g.row)).toEqual(rows);
    });

    it('satisfies slice 6\'s injected FuzzyMatcher interface, which is '
        + 'what the interface was written against', () => {
        expect(typeof archiveFuzzy.isActive).toBe('function');
        expect(typeof archiveFuzzy.rank).toBe('function');
        expect(typeof archiveFuzzy.segments).toBe('function');
        expect(archiveFuzzy.isActive({ title: 'a' })).toBe(true);
    });
});

describe('THE VERDICT: this is a THIRD matcher, not slice 5\'s', () => {
    it('DIFFERENCE 1, the query shape: one ANDs columns, the other picks '
        + 'the best of weighted fields', () => {
        const rows = [{ name: 'deploy', path: 'zzz' }];
        // nav-fuzzy: ONE needle, OR across fields. A row matching only
        // its name is a hit.
        const nav = navFuzzy.rank(rows, 'deploy',
            [{ name: 'name', weight: 1 }, { name: 'path', weight: 1 }]);
        expect(nav).toHaveLength(1);
        // search-fuzzy: a MAP, AND across columns. The same row asked
        // about both columns is a MISS.
        const mine = rank(rows as never[], { name: 'deploy', path: 'deploy' },
            (r, k) => String((r as Record<string, unknown>)[k]));
        expect(mine).toHaveLength(0);
    });

    it('DIFFERENCE 2, the answer shape: spans against indices', () => {
        const navHit = navFuzzy.match('abcd', 'abc');
        // nav-fuzzy reports individual character INDICES.
        expect(navHit?.positions).toEqual([0, 1, 2]);
        // search-fuzzy reports [start, end) SPANS, runs coalesced.
        expect(match('abc', 'abcd')?.spans).toEqual([[0, 3]]);
    });

    it('DIFFERENCE 3, the boundary rule: different separator sets, and a '
        + 'camel rule on ONE side only', () => {
        expect(BOUNDARY_CHARS).not.toBe(navFuzzy.BOUNDARY_CHARS);
        // A colon is a boundary here (timestamps) and not there.
        expect(isBoundary('a:b', 2)).toBe(true);
        expect(navFuzzy.isBoundary('a:b', 2)).toBe(false);
        // The camel transition is a boundary THERE and not here.
        expect(navFuzzy.isBoundary('CloudeCode', 6)).toBe(true);
        expect(isBoundary('CloudeCode', 6)).toBe(false);
    });

    it('DIFFERENCE 4, the score: the two disagree on the SAME input, so '
        + 'neither could be the other with a flag flipped', () => {
        const mine = match('cld', 'CloudeCode');
        const theirs = navFuzzy.match('CloudeCode', 'cld');
        expect(mine).not.toBeNull();
        expect(theirs).not.toBeNull();
        expect(mine?.score).not.toBe(theirs?.score);
    });

    it('THE NEGATIVE CONTROL: they still AGREE about what a subsequence '
        + 'IS, so the divergence above is about ranking and not about '
        + 'one of them being broken', () => {
        for (const [needle, hay] of [['cld', 'CloudeCode'], ['dep', 'deploy'],
                                     ['zzz', 'deploy']] as const) {
            const mineHit = match(needle, hay) !== null;
            const theirsHit = navFuzzy.match(hay, needle) !== null;
            expect(mineHit, `${needle}/${hay}`).toBe(theirsHit);
        }
    });
});
