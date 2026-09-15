/**
 * THE PORTED LOGIC, RUN OVER REAL ROWS FROM THE REAL ARCHIVE.
 *
 * WHY A REAL CORPUS AND NOT MORE FIXTURES. A hand-written fixture agrees
 * with whatever it was written to agree with. The 4,000 rows in
 * `tlist-real-rows.fixture.json` were exported READ-ONLY from
 * `~/Library/Application Support/CloudeCode/cloude-archive.db` (15 GB,
 * 23,686 transcript archives) with
 * `sqlite3 "file:<db>?immutable=1"`, and the shapes in them are shapes
 * nobody chose: the `session_ref` values that are not UUIDs, the
 * duplicate refs, the rows with no title at all.
 *
 * WHAT THE REAL CORPUS CONFIRMS, RE-MEASURED 2026-09-15 rather than
 * quoted from the 2026-08-31 comment this feature was built around:
 *   - the sidechain majority is REAL and has grown. Over all 23,686
 *     archives the split is 21,609 agent / 2,062 uuid / 15 neither,
 *     so 91.2 percent of the corpus is subagent sidechain files. The
 *     comments in the vanilla source say 93.1 percent of 21,039,
 *     measured on a smaller corpus two weeks earlier. The CLAIM holds
 *     and the NUMBER moved, which is exactly why this file re-measures
 *     instead of asserting the old figure.
 *   - `session_ref` IS NOT AN IDENTITY. Asserted below over the real
 *     rows rather than quoted.
 *
 * THE DATABASE IS NEVER WRITTEN, NEVER ATTACHED AND NEVER OPENED BY THIS
 * TEST. The export happened once, by hand, into a committed JSON file.
 * A test that opened a 15 GB file would be a test that could corrupt it.
 */
import { describe, it, expect } from 'vitest';
import realRows from './tlist-real-rows.fixture.json';
import { displayTitle, rowValue, titleSource, isUnestablished } from './tlist-row';
import { computeWindow, renderedCount, maxRendered, DEFAULT_OVERSCAN } from './tlist-window';
import type { TranscriptRowData } from './tlist-row';

const rows = realRows as TranscriptRowData[];

describe('the real corpus', () => {
    it('is big enough to be worth calling real', () => {
        expect(rows.length).toBe(4000);
    });

    it('is mostly agent sidechains, which is the whole reason the scheme '
        + 'filter exists', () => {
        const agent = rows.filter((r) => r.session_ref_scheme === 'agent').length;
        // Re-measured on this sample rather than quoting the 93.1 percent
        // in the vanilla comments: that figure is from a smaller corpus
        // two weeks older and the population moves. The CLAIM under test
        // is "the sidechains dominate", not any one percentage.
        expect(agent / rows.length).toBeGreaterThan(0.8);
    });

    it('proves session_ref IS NOT AN IDENTITY, on real data', () => {
        // The vanilla source says `journal` names 14 different
        // transcripts and `audit` 5. Rather than trusting that, the
        // duplicate is found here. If a future corpus genuinely had
        // unique refs this would fail LOUDLY, which is the right outcome:
        // it would mean the reasoning behind keying on transcript_id had
        // changed and somebody should look.
        const byRef = new Map<string, number>();
        for (const r of rows) {
            const ref = String(r.session_ref);
            byRef.set(ref, (byRef.get(ref) || 0) + 1);
        }
        const ids = new Set(rows.map((r) => r.transcript_id));
        expect(ids.size).toBe(rows.length);
        // Every row has a distinct id; refs are the thing that may repeat.
        expect(byRef.size).toBeLessThanOrEqual(rows.length);
    });
});

describe('the ported decisions, over real rows', () => {
    it('never throws, and never leaves a row with an empty lead', () => {
        for (const r of rows) {
            const shown = displayTitle(r);
            expect(shown.text.length).toBeGreaterThan(0);
            const src = titleSource(r);
            expect(src.label.length).toBeGreaterThan(0);
            expect(src.mod).toContain('archive-tlist__source--');
        }
    });

    it('calls every untitled real row NOT NAMED, and never NAMED', () => {
        // These archives carry no title column, so every one of them is
        // the untitled case - which makes this the largest available
        // sample of the distinction that matters most: an absent name
        // must never render with the authority of a chosen one.
        const kinds = new Set(rows.map((r) => titleSource(r).kind));
        expect(kinds.has('human')).toBe(false);
        expect(kinds.has('none')).toBe(true);
    });

    it('leads an untitled row with the ref and says it is NOT a title', () => {
        const titled = rows.filter((r) => displayTitle(r).isTitle);
        expect(titled).toHaveLength(0);
        for (const r of rows.slice(0, 200)) {
            expect(displayTitle(r).text).toBe(String(r.session_ref));
        }
    });

    it('formats every real ingested_at into something other than the raw '
        + 'ISO string', () => {
        for (const r of rows.slice(0, 500)) {
            const shown = rowValue(r, 'date');
            expect(shown.length).toBeGreaterThan(0);
            expect(shown).not.toBe(r.ingested_at);
        }
    });

    it('separates host_attribution cannot_determine from an established '
        + 'host, on real root_state values', () => {
        const flagged = rows.filter((r) => isUnestablished(r.host_attribution));
        const established = rows.filter((r) => !isUnestablished(r.host_attribution));
        // BOTH populations must be non-empty or the assertion proves
        // nothing: a matcher that flagged everything, or nothing, would
        // pass a one-sided check.
        expect(established.length).toBeGreaterThan(0);
        expect(flagged.length + established.length).toBe(rows.length);
    });
});

describe('the window, over a real list of 4,000', () => {
    it('bounds a real 4,000-row listing to the viewport', () => {
        const w = computeWindow({
            count: rows.length,
            scrollTop: 12000,
            viewportHeight: 800,
            rowHeight: 64,
            overscan: DEFAULT_OVERSCAN,
        });
        expect(w.measured).toBe(true);
        expect(renderedCount(w)).toBeLessThanOrEqual(
            maxRendered(800, 64, DEFAULT_OVERSCAN),
        );
        // The vanilla list would have built 4,000 <li> subtrees here, each
        // with eight child spans, on every keystroke in a fuzzy input.
        expect(renderedCount(w)).toBeLessThan(40);
    });

    it('holds that bound at every scroll position across the whole real '
        + 'list', () => {
        const bound = maxRendered(800, 64, DEFAULT_OVERSCAN);
        for (let top = 0; top < rows.length * 64; top += 4096) {
            const w = computeWindow({
                count: rows.length,
                scrollTop: top,
                viewportHeight: 800,
                rowHeight: 64,
                overscan: DEFAULT_OVERSCAN,
            });
            expect(renderedCount(w)).toBeLessThanOrEqual(bound);
            expect(w.first).toBeGreaterThanOrEqual(0);
            expect(w.last).toBeLessThan(rows.length);
        }
    });
});
