/**
 * THE WINDOW IS BOUNDED BY THE VIEWPORT AND NOT BY THE FILE, AND THE
 * ANTI-JUMP DEBT IS EXACT.
 *
 * COUNTED, NEVER TIMED. Slice 6 proved its bound by counting painted
 * rows at 200 and at 5,000 rather than by timing a render, and this
 * file does the same one layer down: the number of rows a window
 * contains is asserted to be THE SAME at 500 rows and at 30,805, which
 * is the property, where a duration would be a machine's mood.
 *
 * HEIGHTS ARE NEVER ASSUMED CONSTANT. Slice 5 found a media query
 * nearly doubles a row; here a row's height is driven by its own
 * `body_chars` and two neighbours differ by a factor of ten. So the
 * estimator is tested against the real extremes of this corpus - the
 * 54,376,859-character body and the 30,805-line transcript - and the
 * correction path is tested by feeding measurements that DISAGREE with
 * the estimates, which is the only case that matters.
 */
import { describe, expect, it } from 'vitest';
import {
    createList, estimateHeight, rowAt,
    CHARS_PER_LINE, COLLAPSED_MAX_PX, HEIGHT_EPSILON_PX, LINE_HEIGHT_PX,
    PLACEHOLDER_EXTRA_PX, PROGRESS_ROW_PX, ROW_CHROME_PX,
} from './reader-virtual';

/** How many rows a window puts in the DOM. `last` is INCLUSIVE. */
function rendered(w: { first: number; last: number }): number {
    return w.last < w.first ? 0 : w.last - w.first + 1;
}

describe('estimateHeight: seeded from body_chars, never from a constant', () => {
    it('is driven by the char count, so two neighbours can differ by ten', () => {
        expect(estimateHeight({ body_state: 'included', body_chars: 960 }))
            .toBe(ROW_CHROME_PX + LINE_HEIGHT_PX * Math.ceil(960 / CHARS_PER_LINE));
        const small = estimateHeight({ body_chars: 40 });
        const large = estimateHeight({ body_chars: 4000 });
        expect(large).toBeGreaterThan(small * 3);
    });

    it('CLAMPS AT THE COLLAPSED MAX, which is what keeps the scrollbar '
        + 'usable: the corpus largest body would else estimate at '
        + 'roughly ten million pixels', () => {
        const uncapped = ROW_CHROME_PX
            + LINE_HEIGHT_PX * Math.ceil(54376859 / CHARS_PER_LINE);
        expect(uncapped).toBeGreaterThan(10_000_000);
        expect(estimateHeight({ body_chars: 54376859 })).toBe(COLLAPSED_MAX_PX);
    });

    it('gives a PLACEHOLDER height, never zero, to anything unmeasurable. '
        + 'A zero height row is invisible and unclickable', () => {
        const placeholder = ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX;
        for (const row of [null, undefined, {}, { body_chars: NaN },
            { body_chars: -1 }, { body_chars: 'x' },
            { body_chars: 10, body_state: 'withheld_too_large' }]) {
            expect(estimateHeight(row as never)).toBe(placeholder);
            expect(estimateHeight(row as never)).toBeGreaterThan(0);
        }
    });

    it('gives a collapsed progress run its own fixed height', () => {
        expect(estimateHeight({ kind: 'progress-run', body_chars: 999999 }))
            .toBe(PROGRESS_ROW_PX);
    });
});

describe('rowAt: the binary search', () => {
    it('finds the last row whose top is at or below y', () => {
        const offsets = Float64Array.of(0, 10, 30, 60);
        expect(rowAt(offsets, 0)).toBe(0);
        expect(rowAt(offsets, 9)).toBe(0);
        expect(rowAt(offsets, 10)).toBe(1);
        expect(rowAt(offsets, 25)).toBe(1);
        expect(rowAt(offsets, 30)).toBe(2);
        expect(rowAt(offsets, 1e9)).toBe(2);
    });

    it('answers 0 for an empty table rather than throwing', () => {
        expect(rowAt(Float64Array.of(0), 100)).toBe(0);
        expect(rowAt(new Float64Array(0), 100)).toBe(0);
    });
});

describe('THE BOUND: rendered rows depend on the viewport, not on N', () => {
    /** A list of `n` rows, all 100px tall. */
    function fixedList(n: number, overscan = 12) {
        const list = createList({ overscan });
        list.setCount(n, () => 100);
        return list;
    }

    it('renders THE SAME NUMBER of rows at 500 and at 30,805, which is '
        + 'the whole property', () => {
        const small = fixedList(500).windowFor(0, 800);
        const huge = fixedList(30805).windowFor(0, 800);
        expect(rendered(small)).toBe(rendered(huge));
        // And it is a small number, not "all of them".
        expect(rendered(huge)).toBeLessThan(40);
        expect(rendered(huge)).toBeGreaterThan(8);
    });

    it('stays bounded deep into a 30,805-line transcript, not just at '
        + 'the top', () => {
        // THE BOUND, DERIVED FROM THE SAME TWO INPUTS `windowFor` USES
        // and from nothing about N: the rows the viewport covers, plus
        // one for a partial row at each edge, plus the overscan on both
        // sides. Stated as arithmetic rather than as a number somebody
        // typed, so it moves with the constants instead of going stale.
        const vh = 800;
        const rowPx = 100;
        const overscan = 12;
        const bound = Math.ceil(vh / rowPx) + 2 + 2 * overscan;

        const list = fixedList(30805, overscan);
        // AT THE TOP THE UPPER OVERSCAN IS CLAMPED AWAY, so the top of a
        // list legitimately renders FEWER rows than the middle. Comparing
        // the middle against the top would be comparing a full window
        // against a half one, which is why the assertion is against the
        // derived bound instead.
        for (const y of [0, 1_500_000, list.totalHeight()]) {
            expect(rendered(list.windowFor(y, vh))).toBeLessThanOrEqual(bound);
        }
        // And the same bound holds for a list sixty times smaller, which
        // is the property: the count does not depend on N.
        expect(rendered(fixedList(500, overscan).windowFor(20_000, vh)))
            .toBeLessThanOrEqual(bound);
    });

    it('THE NEGATIVE CONTROL FOR THE BOUND: a bigger viewport renders '
        + 'MORE rows, or the window would be ignoring its inputs', () => {
        const list = fixedList(30805);
        expect(rendered(list.windowFor(0, 4000)))
            .toBeGreaterThan(rendered(list.windowFor(0, 800)));
        // And a bigger overscan does too.
        expect(rendered(fixedList(30805, 40).windowFor(0, 800)))
            .toBeGreaterThan(rendered(fixedList(30805, 2).windowFor(0, 800)));
    });

    it('separates the RENDER window from the VISIBLE window, because the '
        + 'anti-jump pivot is the narrow one', () => {
        const w = fixedList(1000).windowFor(10_000, 800);
        expect(w.first).toBeLessThan(w.firstVisible);
        expect(w.last).toBeGreaterThan(w.lastVisible);
        expect(w.firstVisible).toBe(100);
        expect(w.offsetTop).toBe(w.first * 100);
    });

    it('answers an empty list without pretending it has a row', () => {
        const w = createList({}).windowFor(0, 800);
        expect(w.last).toBe(-1);
        expect(rendered(w)).toBe(0);
        expect(w.totalHeight).toBe(0);
    });

    it('survives a non-finite scroll position and a zero viewport', () => {
        const list = fixedList(100);
        for (const bad of [NaN, -5, Infinity, undefined]) {
            expect(() => list.windowFor(bad as never, 800)).not.toThrow();
        }
        expect(rendered(list.windowFor(0, 0))).toBeGreaterThan(0);
    });

    it('refuses a non-finite ESTIMATE rather than corrupting every offset '
        + 'after it, because the binary search needs monotonicity', () => {
        const list = createList({});
        list.setCount(5, (i) => (i === 2 ? NaN : 100));
        const offs = list.offsets();
        for (let i = 1; i < offs.length; i += 1) {
            expect(offs[i] as number).toBeGreaterThan(offs[i - 1] as number);
        }
        expect(list.heightOf(2)).toBe(ROW_CHROME_PX + PLACEHOLDER_EXTRA_PX);
    });
});

describe('THE ANTI-JUMP DEBT: exact, and owed only for rows ABOVE', () => {
    /** 100 rows, all estimated at 100px. */
    function list100() {
        const list = createList({ overscan: 0 });
        list.setCount(100, () => 100);
        return list;
    }

    it('owes the SUM of corrections for rows strictly above the pivot', () => {
        const list = list100();
        // Rows 2 and 5 are taller than estimated; row 50 is below the pivot.
        list.measure(2, 150);
        list.measure(5, 80);
        list.measure(50, 400);
        const r = list.applyMeasurements(10);
        expect(r.applied).toBe(3);
        // +50 for row 2, -20 for row 5. Row 50 is at or below nothing -
        // it is BELOW the pivot, so it owes nothing.
        expect(r.delta).toBe(30);
        expect(r.lowestChanged).toBe(2);
    });

    it('owes NOTHING for a row AT the pivot, because that row is under '
        + "the reader's eyes and is supposed to grow downward", () => {
        const list = list100();
        list.measure(10, 300);
        expect(list.applyMeasurements(10).delta).toBe(0);
    });

    it('owes nothing at all when the pivot is the first row', () => {
        const list = list100();
        list.measure(0, 500);
        list.measure(3, 500);
        const r = list.applyMeasurements(0);
        expect(r.applied).toBe(2);
        expect(r.delta).toBe(0);
    });

    it('REBUILDS THE TABLE from the lowest changed index, so the total '
        + 'height converges on what was measured', () => {
        const list = list100();
        expect(list.totalHeight()).toBe(10000);
        list.measure(4, 250);
        list.applyMeasurements(0);
        expect(list.totalHeight()).toBe(10000 + 150);
        expect(list.offsetOf(5)).toBe(4 * 100 + 250);
    });

    it('IGNORES SUB-PIXEL CHURN, or a fractional line box would produce '
        + 'an endless reconcile loop', () => {
        const list = list100();
        expect(list.measure(3, 100 + HEIGHT_EPSILON_PX)).toBe(false);
        expect(list.measure(3, 100 - HEIGHT_EPSILON_PX)).toBe(false);
        expect(list.measure(3, 100 + HEIGHT_EPSILON_PX + 0.01)).toBe(true);
        expect(list.pendingCount()).toBe(1);
    });

    it('refuses a measurement it cannot use, rather than writing it', () => {
        const list = list100();
        for (const [i, px] of [[-1, 50], [100, 50], [1.5, 50], [3, NaN],
            [3, -1], [3, Infinity]] as [number, number][]) {
            expect(list.measure(i, px)).toBe(false);
        }
        expect(list.pendingCount()).toBe(0);
    });

    it('BATCHES: measurements do not move anything until they are applied', () => {
        const list = list100();
        list.measure(1, 400);
        expect(list.totalHeight()).toBe(10000);
        expect(list.heightOf(1)).toBe(100);
        list.applyMeasurements(0);
        expect(list.heightOf(1)).toBe(400);
    });

    it('answers a no-op honestly when nothing is pending', () => {
        const r = list100().applyMeasurements(0);
        expect(r).toEqual({ delta: 0, applied: 0, lowestChanged: -1, totalHeight: 10000 });
    });

    it('DROPS pending measurements on setCount, because those indices may '
        + 'no longer mean the same row', () => {
        const list = list100();
        list.measure(1, 400);
        expect(list.pendingCount()).toBe(1);
        list.setCount(50, () => 100);
        expect(list.pendingCount()).toBe(0);
        expect(list.totalHeight()).toBe(5000);
    });
});

describe('offsetOf / heightOf: out of range is 0, never a throw', () => {
    it('answers 0 for every unusable index', () => {
        const list = createList({});
        list.setCount(3, () => 10);
        for (const bad of [-1, 99, 1.5, NaN]) {
            expect(list.offsetOf(bad as number)).toBe(0);
            expect(list.heightOf(bad as number)).toBe(0);
        }
        expect(list.heightOf(1)).toBe(10);
        expect(list.offsetOf(2)).toBe(20);
    });
});
