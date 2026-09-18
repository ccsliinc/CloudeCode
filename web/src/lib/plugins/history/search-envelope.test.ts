/**
 * THE TWO-CURSOR RULE, AND THE PROPERTY THAT A ZERO-HIT ANSWER MEANS
 * DIFFERENT THINGS UNDER DIFFERENT SCAN STATUSES.
 *
 * THE ASSERTIONS ARE ON THE WIRING, NOT ON THE PROSE. `resumeAffordance`
 * returns the NAME of the one meta field it consulted, so these tests
 * check `field` rather than checking that a sentence mentions a cursor.
 * A test on the sentence passes when the sentence is right and the read
 * is wrong, which is precisely the bug: the two cursors are exactly
 * complementary, so reading the wrong one yields null, which looks like
 * "cannot resume" - a plausible, quiet, wrong answer.
 */
import { describe, expect, it } from 'vitest';
import {
    coverageSentence, resumeAffordance, scanProgress, scanStatus,
} from './search-envelope';
import { RESUME_KINDS, SCAN_UNKNOWN } from './search-vocab';

/** The two complementary live shapes, measured 2026-08-31. */
const LIMIT_REACHED = {
    meta: {
        scan: { status: 'limit_reached', transcripts_scanned: 1,
                transcripts_not_scanned: 3415, resume_cursor: null },
        scope: { transcripts_in_scope: 3416 },
        paging: { next_cursor: 'PAGE-CURSOR' },
    },
};
const BUDGET_EXHAUSTED = {
    meta: {
        scan: { status: 'budget_exhausted', transcripts_scanned: 801,
                transcripts_not_scanned: 2615, resume_cursor: 'SCAN-CURSOR' },
        scope: { transcripts_in_scope: 3416 },
        paging: { next_cursor: null },
    },
};

describe('scan status: membership, never an assumption of completeness', () => {
    it('recognises the four the server declares', () => {
        for (const s of ['complete', 'budget_exhausted', 'limit_reached', 'not_run']) {
            expect(scanStatus({ meta: { scan: { status: s } } })).toBe(s);
        }
    });

    it('answers `unknown` for anything else, and NEVER `complete`', () => {
        for (const s of ['finished', '', null, 42, undefined]) {
            expect(scanStatus({ meta: { scan: { status: s } } }), String(s))
                .toBe(SCAN_UNKNOWN);
        }
        expect(scanStatus(null)).toBe(SCAN_UNKNOWN);
        expect(scanStatus({})).toBe(SCAN_UNKNOWN);
        expect(scanStatus({ meta: {} })).toBe(SCAN_UNKNOWN);
    });
});

describe('the two cursors: one named field each, never a fallback', () => {
    it('`limit_reached` reads meta.paging.next_cursor AND NOTHING ELSE', () => {
        const a = resumeAffordance(LIMIT_REACHED);
        expect(a.kind).toBe(RESUME_KINDS.MORE_HITS);
        expect(a.field).toBe('meta.paging.next_cursor');
        expect(a.cursor).toBe('PAGE-CURSOR');
        expect(a.blocked).toBe(false);
    });

    it('`budget_exhausted` reads meta.scan.resume_cursor AND NOTHING ELSE', () => {
        const a = resumeAffordance(BUDGET_EXHAUSTED);
        expect(a.kind).toBe(RESUME_KINDS.MORE_SCOPE);
        expect(a.field).toBe('meta.scan.resume_cursor');
        expect(a.cursor).toBe('SCAN-CURSOR');
        expect(a.blocked).toBe(false);
    });

    it('NEVER SWAPS. A limit_reached whose page cursor is absent is '
        + 'BLOCKED even when a scan cursor is sitting right there', () => {
        const crossed = {
            meta: {
                scan: { status: 'limit_reached', resume_cursor: 'SCAN-CURSOR' },
                paging: { next_cursor: null },
            },
        };
        const a = resumeAffordance(crossed);
        expect(a.field).toBe('meta.paging.next_cursor');
        // THE WHOLE POINT: the other cursor is present and is NOT taken.
        expect(a.cursor).toBeNull();
        expect(a.blocked).toBe(true);
        expect(a.reason).toContain('meta.paging.next_cursor');
    });

    it('NEVER SWAPS, the other direction', () => {
        const crossed = {
            meta: {
                scan: { status: 'budget_exhausted', resume_cursor: null },
                paging: { next_cursor: 'PAGE-CURSOR' },
            },
        };
        const a = resumeAffordance(crossed);
        expect(a.field).toBe('meta.scan.resume_cursor');
        expect(a.cursor).toBeNull();
        expect(a.blocked).toBe(true);
    });

    it('`complete` offers nothing and is NOT blocked - there is simply '
        + 'nothing left, which is a different finding from a failure', () => {
        const a = resumeAffordance({ meta: { scan: { status: 'complete' } } });
        expect(a.kind).toBe(RESUME_KINDS.NONE);
        expect(a.blocked).toBe(false);
        expect(a.field).toBeNull();
    });

    it('`not_run` and an unrecognised status are BLOCKED, because '
        + 'whether anything remains unread is NOT KNOWN', () => {
        expect(resumeAffordance({ meta: { scan: { status: 'not_run' } } }).blocked)
            .toBe(true);
        expect(resumeAffordance({ meta: { scan: { status: 'invented' } } }).kind)
            .toBe(RESUME_KINDS.UNKNOWN);
        expect(resumeAffordance(null).blocked).toBe(true);
    });
});

describe('coverage: stated on every outcome, never inferred', () => {
    it('names how much was NOT read when the scan stopped short', () => {
        const line = coverageSentence(BUDGET_EXHAUSTED);
        expect(line).toContain('801 of 3416');
        expect(line).toContain('2615 were NOT read');
    });

    it('says NOT KNOWN rather than inventing a zero when the server '
        + 'reported no numbers', () => {
        expect(coverageSentence(null)).toContain('NOT KNOWN');
        expect(coverageSentence({ meta: {} })).toContain('NOT KNOWN');
        expect(coverageSentence(null)).not.toMatch(/\b0 of\b/);
    });

    it('makes NO claim about what was not read when everything was read', () => {
        const complete = {
            meta: { scan: { transcripts_scanned: 3416 },
                    scope: { transcripts_in_scope: 3416 } },
        };
        expect(coverageSentence(complete)).not.toContain('NOT read');
    });
});

describe('progress: transcripts over transcripts, never bytes', () => {
    it('is null whenever either integer is missing, so no bar renders '
        + 'over a guess', () => {
        expect(scanProgress(null).fraction).toBeNull();
        expect(scanProgress({ meta: { scan: { transcripts_scanned: 1 } } }).fraction)
            .toBeNull();
        expect(scanProgress({ meta: { scope: { transcripts_in_scope: 9 } } }).fraction)
            .toBeNull();
    });

    it('computes a real fraction when both are present', () => {
        expect(scanProgress(BUDGET_EXHAUSTED).fraction).toBeCloseTo(801 / 3416);
    });

    it('IGNORES bytes_scanned entirely - it overshot its own budget by '
        + '2.75 percent in a live measurement and cannot be a fraction', () => {
        const overshoot = {
            meta: {
                scan: { bytes_scanned: 551648566, budget_bytes: 536870912 },
                scope: {},
            },
        };
        const p = scanProgress(overshoot);
        expect(p.fraction).toBeNull();
        expect(JSON.stringify(p)).not.toContain('551648566');
    });
});
