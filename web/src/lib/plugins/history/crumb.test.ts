/**
 * The breadcrumb vocabulary. PORTED from section 4 of
 * `tests/test_archive_titles_and_filters.node.mjs`, whose remaining
 * sections stay where they are.
 *
 * WHY ONLY PART OF THAT SUITE MOVED. Its subject is four modules at
 * once: the transcript row, the fuzzy matcher, the type filter and the
 * crumb. This slice moves the crumb and nothing else, and rule 8.3 of
 * the scope ports a suite "in the slice that moves its subject". So the
 * four crumb cases moved here verbatim and the rest of that file, which
 * is about modules slices 5 and 6 own, was left alone with its
 * `archive-crumb.js` load dropped.
 *
 * THE POSITIVE CONTROL IS KEPT AND IS THE REASON THE FIRST TEST MEANS
 * ANYTHING. `hasNumericId` is a detector, and an assertion of absence
 * over a detector that never fires is not a measurement.
 */
import { expect, test } from 'vitest';
import { createTracker, hasNumericId, labels, projectSegment,
         sessionSegment } from './crumb';
import type { ArchiveRoute } from './route';

test('a breadcrumb NEVER renders a numeric id', () => {
    const routes: Partial<ArchiveRoute>[] = [
        { view: 'project', projectId: 48, transcriptId: null },
        { view: 'transcript', projectId: 48, transcriptId: 5767 },
        { view: 'transcript', projectId: null, transcriptId: 5767 },
        { view: 'line', projectId: 48, transcriptId: 5767, lineNo: 1695 },
    ];
    for (const r of routes) {
        // The hardest case: NOTHING has been learned yet, which is what
        // a fresh deep link looks like before its header request
        // resolves.
        const parts = labels(r, { project: null, transcript: null });
        expect(hasNumericId(parts),
               'a bare id reached the crumb for ' + JSON.stringify(r)
               + ': ' + JSON.stringify(parts)).toBe(false);
        for (const p of parts) expect(p.length, 'a blank crumb segment').toBeGreaterThan(0);
    }
});

test('POSITIVE CONTROL: hasNumericId can actually return true', () => {
    // An assertion of absence over a detector that never fires is not a
    // measurement. This is the detector's own positive control.
    expect(hasNumericId(['project 48'])).toBe(true);
    expect(hasNumericId(['transcript 5767'])).toBe(true);
    expect(hasNumericId(['5767'])).toBe(true);
    expect(hasNumericId(['Infrastructure'])).toBe(false);
});

test('a crumb prefers a NAME, labels a REFERENCE as one, and states an unknown', () => {
    expect(projectSegment({ display_name: 'Infrastructure' }).kind).toBe('name');
    expect(projectSegment({ display_name: 'Infrastructure' }).text).toBe('Infrastructure');

    // `full_path` is the raw slug. It is shown, because it is the only
    // thing known - and LABELLED, so it does not read as a chosen name.
    const slug = projectSegment({ full_path: '-Users-jsugamele-Development' });
    expect(slug.kind).toBe('ref');
    expect(slug.text).toMatch(/^ref /);

    expect(projectSegment(null).kind).toBe('unknown');
    expect(sessionSegment({ title: 'Nightly sweep' }).text).toBe('Nightly sweep');
    expect(sessionSegment({ session_ref: 'journal' }).kind).toBe('ref');
    expect(sessionSegment(null).kind).toBe('unknown');
});

test('the tracker only answers about the id the route names', () => {
    const t = createTracker();
    t.learnTranscript(5767, { title: 'The right one' });
    // A DIFFERENT transcript. Returning the remembered name here would
    // render the previous session's title over the current one - a wrong
    // name, which is worse than the id it replaced, because it is
    // believable.
    const parts = t.labelsFor({ view: 'transcript', projectId: null,
                                transcriptId: 9999 });
    expect(parts.some((p) => p.includes('The right one')),
           'a fact about transcript 5767 was rendered for transcript 9999')
        .toBe(false);
    const right = t.labelsFor({ view: 'transcript', projectId: null,
                                transcriptId: 5767 });
    expect(right.some((p) => p.includes('The right one')),
           'the tracker did not answer for the id it was told about').toBe(true);
});
