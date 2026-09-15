/**
 * THE RENDER WINDOW, AND THE TWO ASSERTIONS THAT FAIL IN OPPOSITE
 * DIRECTIONS.
 *
 * WHY THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST HERE. A windowing
 * function that returns the whole list no matter what it is asked passes
 * every positive test anybody would naturally write: the rows are all
 * there, the padding is zero, nothing is missing. It is also completely
 * useless, and it is the exact shape `computeWindow`'s own refusal path
 * returns - so the refusal and the defect are the same value, told apart
 * only by whether the inputs supported narrowing.
 *
 * So the bound is asserted from BOTH sides:
 *   POSITIVE - a measured window is STRICTLY smaller than the count, and
 *     the same size at 50 rows as at 50,000.
 *   NEGATIVE - an UNMEASURED window is the whole list, and says so with
 *     `measured: false`.
 * A function hardcoded to "whole list" fails the first. One hardcoded to
 * a fixed slice fails the second, and would hide rows on a pane whose
 * height was never measured. Neither assertion alone catches both.
 *
 * COUNTING, NEVER TIMING. The claim is a BOUND on rendered rows, and a
 * wall clock on a loaded box would either flake or be too loose to prove
 * anything - the same reasoning `tests/test_listing_subprocess_cost.py`
 * gives for counting subprocesses instead of timing them.
 */
import { describe, it, expect } from 'vitest';
import {
    computeWindow,
    renderedCount,
    maxRendered,
    scrollToShow,
    DEFAULT_OVERSCAN,
    ROW_GAP_PX,
} from './tlist-window';

/** A viewport and row height that divide evenly, so the arithmetic is readable. */
const VIEWPORT = 600;
const ROW_H = 60;

/**
 * One measured window over `count` rows at the top of the list.
 * Inputs: count - rows. scrollTop - px, default 0.
 * Output: the window.
 */
function measured(count: number, scrollTop = 0) {
    return computeWindow({
        count,
        scrollTop,
        viewportHeight: VIEWPORT,
        rowHeight: ROW_H,
        overscan: DEFAULT_OVERSCAN,
    });
}

describe('computeWindow: the bound', () => {
    it('renders the SAME number of rows at 50, 500 and 5,000', () => {
        // THE WHOLE PROPERTY, IN ONE ASSERTION. The vanilla list rendered
        // one <li> per loaded row, so this triple would have read
        // 50 / 500 / 5000. Anything that grows with the count here is the
        // defect coming back.
        const at50 = renderedCount(measured(50));
        const at500 = renderedCount(measured(500));
        const at5000 = renderedCount(measured(5000));
        expect(at50).toBe(at500);
        expect(at500).toBe(at5000);

        // MEASURED, NOT ASSUMED: at this viewport and row height the
        // window is 20 rows, and it is 20 whether the list holds 50 or
        // 19,587. The bound therefore bites on the FIRST page already -
        // 50 is PAGE_SIZE - which is stronger than the file header
        // claims, and the claim is left conservative rather than
        // tightened on one arithmetic coincidence.
        expect(at50).toBe(20);
    });

    it('never exceeds the bound derived from viewport and overscan', () => {
        const bound = maxRendered(VIEWPORT, ROW_H, DEFAULT_OVERSCAN);
        for (const count of [51, 200, 1000, 3416, 19587]) {
            for (const scrollTop of [0, 600, 5000, 40000]) {
                const w = computeWindow({
                    count,
                    scrollTop,
                    viewportHeight: VIEWPORT,
                    rowHeight: ROW_H,
                    overscan: DEFAULT_OVERSCAN,
                });
                expect(renderedCount(w)).toBeLessThanOrEqual(bound);
            }
        }
    });

    it('NEGATIVE CONTROL: a measured window is strictly smaller than a '
        + 'long list, so a function that always returned everything fails '
        + 'here', () => {
        const count = 5000;
        const w = measured(count);
        expect(w.measured).toBe(true);
        expect(renderedCount(w)).toBeLessThan(count);
        // Named explicitly rather than left implied by the inequality: the
        // defect this catches is a window that IS the list.
        expect(w.last).toBeLessThan(count - 1);
    });

    it('NEGATIVE CONTROL: an UNMEASURED window is the whole list, so a '
        + 'function hardcoded to a fixed slice fails here', () => {
        const count = 5000;
        for (const broken of [
            { rowHeight: 0 },
            { rowHeight: -12 },
            { rowHeight: Number.NaN },
            { viewportHeight: 0 },
            { viewportHeight: Number.NaN },
        ]) {
            const w = computeWindow({
                count,
                scrollTop: 0,
                viewportHeight: VIEWPORT,
                rowHeight: ROW_H,
                ...broken,
            });
            expect(w.measured).toBe(false);
            expect(renderedCount(w)).toBe(count);
            expect(w.padTop).toBe(0);
            expect(w.padBottom).toBe(0);
        }
    });
});

describe('computeWindow: what it answers', () => {
    it('starts at 0 and pads nothing at the top of the list', () => {
        const w = measured(5000, 0);
        expect(w.first).toBe(0);
        expect(w.padTop).toBe(0);
        expect(w.padBottom).toBeGreaterThan(0);
    });

    it('discounts one flex gap from a spacer it actually renders', () => {
        // The spacers are flex children of a `gap: 10px` column, so a
        // rendered spacer contributes its height PLUS one gap. The height
        // it declares is therefore one gap short of the space it stands
        // in for. Asserted rather than eyeballed because an off-by-one-gap
        // is invisible until a list is long enough for it to accumulate.
        const w = measured(5000, 6000);
        const hiddenAbove = w.first * ROW_H;
        expect(w.first).toBeGreaterThan(0);
        expect(w.padTop).toBe(hiddenAbove - ROW_GAP_PX);
    });

    it('renders no spacer, and no negative height, at either end', () => {
        const top = measured(5000, 0);
        expect(top.padTop).toBe(0);

        const bottomScroll = 5000 * ROW_H;
        const bottom = measured(5000, bottomScroll);
        expect(bottom.last).toBe(4999);
        expect(bottom.padBottom).toBe(0);
        expect(bottom.padTop).toBeGreaterThanOrEqual(0);
    });

    it('answers an empty list without inventing a row', () => {
        const w = computeWindow({
            count: 0, scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW_H,
        });
        expect(renderedCount(w)).toBe(0);
        expect(w.last).toBe(-1);
    });

    it('keeps the window inside the list when scrolled past its end', () => {
        const w = measured(100, 999999);
        expect(w.first).toBeGreaterThanOrEqual(0);
        expect(w.last).toBe(99);
        expect(renderedCount(w)).toBeLessThanOrEqual(100);
    });
});

describe('scrollToShow', () => {
    it('leaves the scroll alone when the row is already on screen', () => {
        expect(scrollToShow(3, 0, VIEWPORT, ROW_H)).toBe(0);
    });

    it('scrolls up to the row when it is above the viewport', () => {
        expect(scrollToShow(2, 600, VIEWPORT, ROW_H)).toBe(120);
    });

    it('scrolls down by exactly the overshoot when it is below', () => {
        // Row 40 spans 2400..2460; the viewport is 600 tall, so its bottom
        // edge has to land at 2460, which puts the top at 1860.
        expect(scrollToShow(40, 0, VIEWPORT, ROW_H)).toBe(1860);
    });

    it('REFUSES rather than guessing when nothing was measured', () => {
        // Same discipline as computeWindow's refusal: an unmeasured
        // scroll target is not 0, it is unavailable. Answering 0 would
        // jump a list to the top every time a keystroke arrived before
        // the first measurement.
        expect(scrollToShow(40, 0, VIEWPORT, 0)).toBeNull();
        expect(scrollToShow(40, 0, 0, ROW_H)).toBeNull();
        expect(scrollToShow(-1, 0, VIEWPORT, ROW_H)).toBeNull();
    });
});
