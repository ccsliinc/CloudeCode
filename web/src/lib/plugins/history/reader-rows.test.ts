/**
 * THE ROW MODEL, AND THE ONE TABLE THAT SAYS WHICH AFFORDANCES EXIST.
 *
 * THE LOAD-BEARING TEST HERE IS AN ABSENCE. `bodyView` decides which
 * actions a body region offers, and the hard gate's whole guarantee is
 * that `render-anyway` is NOT among them - structurally, rather than as
 * a `disabled` attribute somebody can flip. An assertion that a button
 * is missing is the only way to state that, so it is stated per state
 * and for every state at once.
 */
import { describe, expect, it } from 'vitest';
import {
    bodyView, familyFor, familyModFor, groupRows, indexOfLine, isRun, itemKey,
    rangeText, roleLabel, type ProgressRun, type SpineRow,
} from './reader-rows';
import { ACTIONS, BODY_STATE, FAMILIES, NO_ROLE_TEXT, NOT_REQUESTED } from './reader-vocab';
import type { BodyEntry } from './reader-body-cache';

/** A cache entry in one state, with everything else neutral. */
function entry(state: string, over: Partial<BodyEntry> = {}): BodyEntry {
    return {
        state: state as BodyEntry['state'], text: null, chars: 0, masked: 0,
        reason: 'because', findingCount: 0, bodyHref: null, ...over,
    };
}

/** A spine row with a line number and whatever else the test needs. */
function row(line: number, over: Partial<SpineRow> = {}): SpineRow {
    return { line_no: line, ...over } as SpineRow;
}

describe('familyFor: 26 record types collapse to five families', () => {
    it('maps the measured types', () => {
        expect(familyFor('user')).toBe(FAMILIES.TURN);
        expect(familyFor('assistant')).toBe(FAMILIES.TURN);
        expect(familyFor('result')).toBe(FAMILIES.TOOL);
        expect(familyFor('tool_use_summary')).toBe(FAMILIES.TOOL);
        expect(familyFor('progress')).toBe(FAMILIES.PROGRESS);
        expect(familyFor('summary')).toBe(FAMILIES.NOTE);
        expect(familyFor('custom-title')).toBe(FAMILIES.NOTE);
    });

    it('A 27TH RECORD TYPE RENDERS AS `meta`, not as a crash and not as '
        + 'a conversation turn', () => {
        expect(familyFor('some-future-type')).toBe(FAMILIES.META);
        expect(familyFor(null)).toBe(FAMILIES.META);
        expect(familyFor(7)).toBe(FAMILIES.META);
        expect(familyFor(undefined)).toBe(FAMILIES.META);
    });

    it('reads the modifier from the LITERAL table, so the stylesheet '
        + 'antijoin can recover every class from the source', () => {
        expect(familyModFor(FAMILIES.TURN)).toBe('archive-row--turn');
        expect(familyModFor(FAMILIES.META)).toBe('archive-row--meta');
        expect(familyModFor('nonsense' as never)).toBe('archive-row--meta');
    });
});

describe('roleLabel: role is NULL on 44.93 percent of bodies', () => {
    it('walks the NORMATIVE chain and says which rung answered', () => {
        expect(roleLabel({ role: 'assistant', record_type: 'assistant' }))
            .toEqual({ text: 'assistant', source: 'role' });
        expect(roleLabel({ role: null, record_type: 'progress' }))
            .toEqual({ text: 'progress', source: 'record_type' });
        expect(roleLabel({ role: '', record_type: '' }))
            .toEqual({ text: NO_ROLE_TEXT, source: 'none' });
        expect(roleLabel(null))
            .toEqual({ text: NO_ROLE_TEXT, source: 'none' });
    });

    it('NEVER ANSWERS A BLANK, which would be a could-not-evaluate '
        + 'laundered into whitespace', () => {
        for (const r of [null, undefined, {}, { role: '' }, { role: 3 }]) {
            expect(roleLabel(r as never).text.trim().length).toBeGreaterThan(0);
        }
    });
});

describe('groupRows: 37.49 percent of bodies are `progress`', () => {
    const p = (n: number) => row(n, { record_type: 'progress' });

    it('folds a RUN and leaves everything else alone', () => {
        const items = groupRows([
            row(1, { record_type: 'user' }), p(2), p(3), p(4),
            row(5, { record_type: 'assistant' }),
        ]);
        expect(items).toHaveLength(3);
        const run = items[1] as ProgressRun;
        expect(isRun(run)).toBe(true);
        expect(run).toMatchObject({ from: 2, to: 4, count: 3 });
        expect(run.rows).toHaveLength(3);
    });

    it('LEAVES A RUN OF ONE as an ordinary line: a chip reading '
        + '"progress x 1" costs a row and says less', () => {
        const items = groupRows([row(1, { record_type: 'user' }), p(2),
            row(3, { record_type: 'user' })]);
        expect(items).toHaveLength(3);
        expect(isRun(items[1] as never)).toBe(false);
    });

    it('DISCARDS NOTHING: every folded row is still carried', () => {
        const spine = [p(1), p(2), p(3), p(4), p(5)];
        const items = groupRows(spine);
        expect(items).toHaveLength(1);
        expect((items[0] as ProgressRun).rows).toEqual(spine);
        expect((items[0] as ProgressRun).count).toBe(5);
    });

    it('handles the empty and the unusable input without throwing', () => {
        expect(groupRows([])).toEqual([]);
        expect(groupRows(null)).toEqual([]);
        expect(groupRows(undefined)).toEqual([]);
        expect(groupRows('nope' as never)).toEqual([]);
    });
});

describe('indexOfLine: a line inside a COLLAPSED run is not on screen', () => {
    const items = groupRows([
        row(7109, { record_type: 'user' }),
        ...[7110, 7111, 7112, 7123].map((n) => row(n, { record_type: 'progress' })),
        row(7124, { record_type: 'assistant' }),
    ]);

    it('finds a plain row and says it is not folded', () => {
        expect(indexOfLine(items, 7109)).toEqual({ item: 0, inRun: false });
        expect(indexOfLine(items, 7124)).toEqual({ item: 2, inRun: false });
    });

    it('FINDS A LINE INSIDE A RUN and says so, which is the real shape: '
        + "transcript 5767's line 7,111 sits inside the run 7110..7123", () => {
        expect(indexOfLine(items, 7111)).toEqual({ item: 1, inRun: true });
    });

    it('answers null for a line the loaded rows do not hold, rather than '
        + 'a nearby guess', () => {
        expect(indexOfLine(items, 99999)).toBeNull();
        expect(indexOfLine([], 1)).toBeNull();
    });
});

describe('itemKey: stable across an append that re-groups', () => {
    it('keys a run by `from`, which appending cannot move, and a line by '
        + 'its own line_no', () => {
        expect(itemKey(row(42))).toBe('line:42');
        expect(itemKey({ kind: 'progress-run', from: 7110, to: 7123, count: 14, rows: [] }))
            .toBe('run:7110');
        // The SAME key after a merge extends the run's tail.
        expect(itemKey({ kind: 'progress-run', from: 7110, to: 7200, count: 90, rows: [] }))
            .toBe('run:7110');
    });
});

describe('rangeText', () => {
    it('names the span, and the single-line wording exists', () => {
        expect(rangeText({ kind: 'progress-run', from: 7110, to: 7123, count: 14, rows: [] }))
            .toBe('lines 7110-7123');
        expect(rangeText({ kind: 'progress-run', from: 5, to: 5, count: 1, rows: [] }))
            .toBe('line 5');
    });
});

describe('bodyView: which affordances EXIST, as data', () => {
    /** The action names a view offers. */
    const actionsOf = (v: { actions: readonly { action: string }[] }) =>
        v.actions.map((a) => a.action);

    it('NOT REQUESTED is a sized placeholder, NEVER a spinner: nothing '
        + 'has been asked for, so there is nothing to wait on', () => {
        const v = bodyView(null, '5,501 chars');
        expect(v.dataState).toBe(NOT_REQUESTED);
        expect(v.kind).toBe('placeholder');
        expect(v.sentence).toContain('5,501 chars');
        expect(v.sentence).toContain('not loaded yet');
        expect(v.text).toBeNull();
        expect(actionsOf(v)).toEqual([]);
        // And it says something even when the size is not known.
        expect(bodyView(null, null).sentence).toBe('body not loaded yet');
    });

    it('renders text ONLY in state `included`, and only the masked text', () => {
        const v = bodyView(entry(BODY_STATE.OK, { text: 'safe bytes', masked: 2 }), null);
        expect(v.kind).toBe('text');
        expect(v.text).toBe('safe bytes');
        expect(v.masked).toBe(2);
        expect(actionsOf(v)).toEqual([]);
    });

    it('THE HARD GATE OFFERS NO RENDER ACTION AT ANY DEPTH. That absence '
        + 'is the guarantee', () => {
        const v = bodyView(entry(BODY_STATE.GATED_HARD), null);
        expect(v.label).toBe('TOO LARGE TO RENDER');
        expect(v.text).toBeNull();
        expect(actionsOf(v)).toEqual([ACTIONS.DOWNLOAD_BODY]);
        expect(actionsOf(v)).not.toContain(ACTIONS.RENDER_ANYWAY);
    });

    it('A SERVER WITHHOLDING OFFERS NO RENDER ACTION EITHER', () => {
        const v = bodyView(entry(BODY_STATE.WITHHELD), null);
        expect(v.label).toBe('WITHHELD BY THE SERVER');
        expect(actionsOf(v)).not.toContain(ACTIONS.RENDER_ANYWAY);
    });

    it('A MASK REFUSAL RENDERS NO BODY: not truncated, not partially '
        + 'masked, not shown behind a warning', () => {
        const v = bodyView(
            entry(BODY_STATE.MASK_REFUSED, { findingCount: 3, reason: 'positions unknown' }),
            null,
        );
        expect(v.kind).toBe('refusal');
        expect(v.label).toBe('BODY WITHHELD BY THIS VIEW');
        expect(v.text).toBeNull();
        expect(v.sentence).toContain('3 secret');
        expect(v.sentence).toContain('positions unknown');
        // A retry is offered, because the refusal may be transient.
        expect(actionsOf(v)).toEqual([ACTIONS.RETRY_BODY]);
        expect(actionsOf(v)).not.toContain(ACTIONS.RENDER_ANYWAY);
    });

    it('THE SOFT GATE IS THE ONE STATE THAT OFFERS A RENDER ACTION, which '
        + 'is the whole difference between the two gates', () => {
        const v = bodyView(entry(BODY_STATE.GATED_SOFT), null);
        expect(v.label).toBe('LARGE BODY');
        expect(actionsOf(v)).toEqual([ACTIONS.RENDER_ANYWAY, ACTIONS.DOWNLOAD_BODY]);
    });

    it('ACROSS EVERY STATE, exactly ONE offers render-anyway', () => {
        const states = Object.values(BODY_STATE);
        const offering = states.filter((s) =>
            actionsOf(bodyView(entry(s), null)).includes(ACTIONS.RENDER_ANYWAY));
        expect(offering).toEqual([BODY_STATE.GATED_SOFT]);
    });

    it('NO STATE EXCEPT `included` CARRIES TEXT. That is what makes a '
        + '54 MB body unable to reach the DOM', () => {
        const withText = Object.values(BODY_STATE)
            .filter((s) => bodyView(entry(s, { text: 'LEAKED' }), null).text !== null);
        expect(withText).toEqual([BODY_STATE.OK]);
    });

    it('names a NO BODY row as a fact about the file, not a failure', () => {
        const v = bodyView(entry(BODY_STATE.NO_BODY), null);
        expect(v.kind).toBe('placeholder');
        expect(v.sentence).toContain('no body row');
        expect(actionsOf(v)).toEqual([]);
    });

    it('shows a loading row as loading, and a could-not-evaluate as its '
        + 'own shape rather than an empty row', () => {
        expect(bodyView(entry(BODY_STATE.LOADING), null).kind).toBe('loading');
        const un = bodyView(entry(BODY_STATE.CANNOT_DETERMINE, { reason: 'the shard died' }), null);
        expect(un.kind).toBe('outcome');
        expect(un.sentence).toContain('the shard died');
        expect(actionsOf(un)).toEqual([ACTIONS.RETRY_BODY]);
    });

    it('EVERY state says SOMETHING. A blank body region is a '
        + 'could-not-evaluate rendered as nothing', () => {
        for (const s of Object.values(BODY_STATE)) {
            // `included` is the ONE state that speaks through its TEXT,
            // and the cache's own invariant is that its `text` is never
            // null there - a refusal sets `text: null` and a DIFFERENT
            // state. Handing it a null text would be constructing an
            // entry the cache cannot produce, so the probe gives it the
            // text its state promises.
            const e = s === BODY_STATE.OK ? entry(s, { text: 'bytes' }) : entry(s);
            const v = bodyView(e, null);
            const said = (v.label || '') + (v.sentence || '') + (v.text || '');
            expect(said.trim().length, s).toBeGreaterThan(0);
        }
        expect(bodyView(null, null).sentence).toBeTruthy();
    });
});
