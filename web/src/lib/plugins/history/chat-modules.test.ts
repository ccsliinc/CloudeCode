/**
 * THE PURE HALVES OF THE CONVERSATION VIEW: subagent ordering, the drill
 * chain, the height estimator and the fetch reducers.
 *
 * All four are arithmetic over the server's shape with no DOM, which is
 * the point of splitting them out of the component: a claim about run
 * ORDER should be provable without standing up a scroller.
 *
 * EVERY ORDERING CLAIM HERE HAS A NEGATIVE BESIDE IT. An orderer that
 * always produces an ordinal is the failure this module exists to
 * prevent: printing "1st, 2nd, 3rd" identically for a measured clock and
 * for a file offset upgrades one into the other.
 */
import { describe, expect, it } from 'vitest';
import {
    basisProse, expanderFor, lookupState, order, ordinalFor, panelFor, startOf,
    transcriptsOf, LOOKUP_FAILED, LOOKUP_KNOWN, ORDER_DERIVED, ORDER_UNKNOWN,
} from './chat-subagents';
import { createStack, crumbText } from './chat-stack';
import {
    blockHeight, estimateItem, COLLAPSED_BLOCK_PX, INFO_PANEL_PX, PROGRESS_ROW_PX,
    STATED_BLOCK_PX, TURN_CHROME_PX, TURN_MAX_PX,
} from './chat-estimate';
import {
    appendTurns, applyTurns, emptyChat, groupTurns, nextCursorOf, sentinelText,
    turnsOf,
} from './chat-load';
import { infoPanel, pick } from './chat-info';
import { outcome, turnsPage, unroutedResponse } from './chat-harness';

describe('chat-subagents: three lookup outcomes, never two', () => {
    it('TELLS "SPAWNED NONE" FROM "COULD NOT LOOK"', () => {
        expect(lookupState({ subagents: [], subagents_state: 'none_spawned' }))
            .toBe(LOOKUP_KNOWN);
        expect(lookupState({ subagents: [], subagents_state: 'cannot_determine' }))
            .toBe(LOOKUP_FAILED);
        // AN EMPTY ARRAY IS NOT EVIDENCE ON ITS OWN: the state wins.
        expect(lookupState({ subagents: [] })).toBe(LOOKUP_KNOWN);
        expect(lookupState({ subagents_state: 'none_spawned' })).toBe(LOOKUP_FAILED);
        // A word invented after this file was written fails toward the
        // third outcome rather than toward success.
        expect(lookupState({ subagents: [], subagents_state: 'a_new_word' }))
            .toBe(LOOKUP_FAILED);
    });

    it('A TURN THAT SPAWNED NONE HAS NO PANEL AND NO EXPANDER', () => {
        const t = { subagents: [], subagents_state: 'none_spawned' };
        expect(panelFor(t)).toBeNull();
        expect(expanderFor(t)).toBeNull();
    });

    it('A TURN WHOSE LOOKUP FAILED HAS BOTH, and both say NOT KNOWN', () => {
        const t = { subagents: [], subagents_state: 'cannot_determine', line_no: 7 };
        expect(expanderFor(t)?.label).toContain('NOT KNOWN');
        expect(panelFor(t)?.sentence).toContain('NOT KNOWN');
        expect(panelFor(t)?.sentence).toContain('not the same');
    });
});

describe('chat-subagents: an ordinal is a claim', () => {
    it('PASSES THE SERVER\'S OWN BASIS THROUGH rather than restating it', () => {
        const rows = [
            { order: 2, order_basis: 'file_position' },
            { order: 1, order_basis: 'file_position' },
        ];
        const o = order(rows);
        expect(o.basis).toBe('file_position');
        expect(o.rows.map((r) => r.order)).toEqual([1, 2]);
        // AND SAYS WHAT THAT MEANS, so a file offset is not read as a clock.
        expect(basisProse(2, 'file_position')).toContain('NOT a measured clock');
        expect(basisProse(2, 'start_ts')).toContain('START TIME');
    });

    it('ROWS THAT DISAGREE ABOUT THEIR BASIS cannot be summarised by '
        + 'either of their answers', () => {
        const o = order([
            { order: 1, order_basis: 'start_ts' },
            { order: 2, order_basis: 'file_position' },
        ]);
        expect(o.basis).toBe('declared');
    });

    it('DERIVES AN ORDER FROM START TIMES when the server declared none, '
        + 'and LABELS IT DERIVED', () => {
        const o = order([
            { start_ts: '2026-01-02T00:00:00Z' },
            { start_ts: '2026-01-01T00:00:00Z' },
        ]);
        expect(o.basis).toBe(ORDER_DERIVED);
        expect(o.rows[0]?.start_ts).toBe('2026-01-01T00:00:00Z');
    });

    it('THE NEGATIVE CONTROL: with neither an order nor a full set of '
        + 'start times, the ordinal column is EMPTY of any rank', () => {
        const o = order([{ start_ts: '2026-01-01T00:00:00Z' }, {}]);
        expect(o.basis).toBe(ORDER_UNKNOWN);
        expect(ordinalFor(ORDER_UNKNOWN, 0)).toBe('NOT KNOWN');
        expect(basisProse(2, ORDER_UNKNOWN)).toContain('ordinals are withheld');
    });

    it('ordinals read as English, including the teens', () => {
        expect(ordinalFor('start_ts', 0)).toBe('1st');
        expect(ordinalFor('start_ts', 1)).toBe('2nd');
        expect(ordinalFor('start_ts', 2)).toBe('3rd');
        expect(ordinalFor('start_ts', 3)).toBe('4th');
        expect(ordinalFor('start_ts', 10)).toBe('11th');
        expect(ordinalFor('start_ts', 11)).toBe('12th');
        expect(ordinalFor('start_ts', 12)).toBe('13th');
        expect(ordinalFor('start_ts', 20)).toBe('21st');
    });

    it('A ROW WITH NO TIME IS NULL, NOT ZERO, so it cannot sort earliest', () => {
        expect(startOf({})).toBeNull();
        expect(startOf({ start_ts: '' })).toBeNull();
        expect(startOf({ started_at: '2026-01-01T00:00:00Z' }))
            .toBe('2026-01-01T00:00:00Z');
    });

    it('ONE SPAWN RESOLVING TO TWO TRANSCRIPTS gets one control each, '
        + 'under one ordinal, and says so', () => {
        const panel = panelFor({
            subagents_state: 'resolved',
            subagents: [{ order: 1, order_basis: 'start_ts', link_state: 'resolved',
                transcripts: [
                    { transcript_id: 91, session_ref: 'agent-a' },
                    { transcript_id: 92, session_ref: 'agent-a' },
                ] }],
        });
        expect(panel?.rows[0]?.controls).toHaveLength(2);
        expect(panel?.rows[0]?.controls.map((c) => c.ordinal)).toEqual(['1st', '1st']);
        expect(panel?.rows[0]?.multi).toContain('none was picked for you');
    });

    it('A FLAT `transcript_id` is tolerated so a future shape does not '
        + 'silently render as unlinked', () => {
        expect(transcriptsOf({ transcript_id: 7 })).toEqual([{ transcript_id: 7 }]);
        expect(transcriptsOf({})).toEqual([]);
    });
});

describe('chat-stack: the way back', () => {
    it('IS EMPTY UNTIL A ROOT IS NAMED, because a chain with no root is '
        + 'an unasked question', () => {
        const st = createStack();
        expect(st.depth()).toBe(0);
        expect(st.current()).toBeNull();
        // A PUSH ONTO AN EMPTY CHAIN IS REFUSED rather than silently
        // becoming a reset.
        expect(st.push({ transcriptId: 9 })).toBeNull();
        expect(st.depth()).toBe(0);
    });

    it('EVERY LEVEL IS INDIVIDUALLY REACHABLE, which is what makes a '
        + 'four-deep chain one click from the top', () => {
        const st = createStack();
        st.reset({ transcriptId: 1, label: 'root' });
        st.push({ transcriptId: 2, label: 'a', ordinal: 1 });
        st.push({ transcriptId: 3, label: 'b', ordinal: 2 });
        st.push({ transcriptId: 4, label: 'c', ordinal: 1 });
        expect(st.depth()).toBe(4);
        expect(st.truncateTo(0)?.transcriptId).toBe(1);
        expect(st.depth()).toBe(1);
    });

    it('AN INDEX NAMING NO LEVEL IS A NO-OP, not a truncation to nothing', () => {
        const st = createStack();
        st.reset({ transcriptId: 1 });
        expect(st.truncateTo(5)).toBeNull();
        expect(st.truncateTo(-1)).toBeNull();
        expect(st.depth()).toBe(1);
        // And the root can never be popped.
        expect(st.pop()).toBeNull();
        expect(st.depth()).toBe(1);
    });

    it('AN UNNAMED LEVEL SAYS SO rather than being filled in', () => {
        const st = createStack();
        st.reset({ transcriptId: 4 });
        expect(crumbText(st.levels()[0]!)).toBe('name NOT KNOWN (t4)');
        st.push({ transcriptId: 91, label: 'Explore', ordinal: 2 });
        expect(crumbText(st.levels()[1]!)).toBe('2. Explore (t91)');
    });

    it('RELABELS THE ROOT ONLY, so a late header cannot rename a level '
        + 'the reader has already drilled into', () => {
        const st = createStack();
        st.reset({ transcriptId: 1, label: null });
        st.push({ transcriptId: 2, label: 'child' });
        expect(st.relabelRoot('the session')).toBe(true);
        expect(st.levels()[0]?.label).toBe('the session');
        expect(st.levels()[1]?.label).toBe('child');
        // Idempotent, and it refuses an empty name.
        expect(st.relabelRoot('the session')).toBe(false);
        expect(st.relabelRoot('')).toBe(false);
    });
});

describe('chat-estimate: finite, positive, and capped', () => {
    it('A COLLAPSED BLOCK COSTS ITS SUMMARY LINE, however enormous its '
        + 'payload', () => {
        expect(blockHeight({ type: 'tool_use', text_length: 200000 }))
            .toBe(COLLAPSED_BLOCK_PX);
        expect(blockHeight({ type: 'thinking', text_length: 999999 }))
            .toBe(COLLAPSED_BLOCK_PX);
    });

    it('A WITHHELD OR UNEVALUATED BLOCK COSTS ITS STATED REASON', () => {
        expect(blockHeight({ type: 'text', text_state: 'withheld_secret_bearing' }))
            .toBe(STATED_BLOCK_PX);
        expect(blockHeight(null)).toBe(STATED_BLOCK_PX);
    });

    it('THE CAP IS LOAD-BEARING: a 37 MB block does not produce three '
        + 'million pixels', () => {
        const huge = estimateItem(
            { blocks: [{ type: 'text', text_state: 'included', text_length: 37_000_000 }] },
            null,
        );
        expect(huge).toBe(TURN_MAX_PX);
    });

    it('AND THE CAP APPLIES TO CONTENT ONLY, so a panel the reader opened '
        + 'is not squeezed out by a huge block above it', () => {
        const turn = {
            blocks: [{ type: 'text', text_state: 'included', text_length: 37_000_000 }],
        };
        expect(estimateItem(turn, { infoOpen: true })).toBe(TURN_MAX_PX + INFO_PANEL_PX);
    });

    it('A FOLDED RUN IS ONE CONTROL TALL, and a nonsense item still '
        + 'produces a finite positive number', () => {
        expect(estimateItem({ kind: 'progress-run', from: 1, to: 9, count: 9 }, null))
            .toBe(PROGRESS_ROW_PX);
        expect(estimateItem(null, null)).toBe(TURN_CHROME_PX);
    });
});

describe('chat-load: the fetch reducers', () => {
    it('AN UNROUTED PATH IS A SYNTHETIC cannot_determine that NAMES the '
        + 'endpoint, not an empty conversation', () => {
        const next = applyTurns(4, unroutedResponse(), outcome);
        expect(next.token).toBe('cannot_determine');
        expect(next.items).toHaveLength(0);
        const env = next.envelope as { unevaluated: { subject: string; reason: string }[] };
        expect(env.unevaluated[0]?.subject).toContain('/archive/transcripts/4/messages');
        expect(env.unevaluated[0]?.reason).toContain('NOT a claim that the transcript is empty');
    });

    it('A RENDERABLE ENVELOPE WITH NO TURNS ARRAY is its own '
        + 'could-not-determine, not an empty conversation', () => {
        const next = applyTurns(4, {
            envelope: { result: { nothing: true }, result_status: 'ok', meta: {} },
            httpStatus: 200, headers: null, transportError: null,
        } as never, outcome);
        expect(next.token).toBe('cannot_determine');
        expect(turnsOf({ result: { nothing: true } })).toBeNull();
        expect(turnsOf({ result: { turns: [] } })).toEqual([]);
        expect(turnsOf({ result: [] })).toEqual([]);
    });

    it('`has_more` IS THREE-VALUED and only an explicit false completes', () => {
        expect(applyTurns(4, turnsPage([{ line_no: 1 }], false), outcome).complete).toBe(true);
        expect(applyTurns(4, turnsPage([{ line_no: 1 }], true), outcome).complete).toBe(false);
        expect(applyTurns(4, turnsPage([{ line_no: 1 }], null), outcome).complete).toBeNull();
    });

    it('A CURSOR THAT IS NOT A NON-EMPTY STRING IS NOT A CURSOR', () => {
        expect(nextCursorOf({ meta: { paging: { next_cursor: 'x' } } })).toBe('x');
        expect(nextCursorOf({ meta: { paging: { next_cursor: '' } } })).toBeNull();
        expect(nextCursorOf({ meta: { paging: { next_cursor: 7 } } })).toBeNull();
        expect(nextCursorOf({ meta: {} })).toBeNull();
        expect(nextCursorOf(null)).toBeNull();
    });

    it('A FAILED PAGE KEEPS THE TURNS and flips completeness to NOT KNOWN', () => {
        const first = applyTurns(4, turnsPage([{ line_no: 1 }], true, 'c1'), outcome);
        const after = appendTurns(first, unroutedResponse(), outcome);
        expect(after.items).toHaveLength(1);
        expect(after.complete).toBeNull();
    });

    it('FOLDS RUNS OF PROGRESS RECORDS and leaves a lone one alone', () => {
        const p = (n: number) => ({ record_type: 'progress', line_no: n });
        const items = groupTurns([p(1), p(2), { record_type: 'user', line_no: 3 }, p(4)]);
        expect(items).toHaveLength(3);
        expect(items[0]).toMatchObject({ kind: 'progress-run', from: 1, to: 2, count: 2 });
        expect(items[2]).toMatchObject({ record_type: 'progress', line_no: 4 });
    });

    it('AND RE-FOLDS ACROSS A PAGE BOUNDARY, so a run split by paging does '
        + 'not become two adjacent chips', () => {
        const p = (n: number) => ({ record_type: 'progress', line_no: n });
        const first = applyTurns(4, turnsPage([p(1), p(2)], true, 'c1'), outcome);
        const after = appendTurns(first, turnsPage([p(3), p(4)], false), outcome);
        expect(after.items).toHaveLength(1);
        expect(after.items[0]).toMatchObject({ from: 1, to: 4, count: 4 });
    });

    it('THE SENTINEL SAYS WHICH OF THE TWO NON-COMPLETE CASES IT IS', () => {
        expect(sentinelText(400, false)).toContain('NOT THE END');
        expect(sentinelText(400, null)).toContain('NOT KNOWN');
        expect(emptyChat().complete).toBeNull();
    });
});

describe('chat-info: every nest is searched and every gap is named', () => {
    it('READS THE TURN, THEN `info`, THEN its three nests', () => {
        expect(pick({ model: 'a' }, 'model')).toBe('a');
        expect(pick({ info: { model: 'b' } }, 'model')).toBe('b');
        expect(pick({ info: { usage: { input_tokens: 5 } } }, 'input_tokens')).toBe(5);
        expect(pick({ info: { line: { line_status: 'ok' } } }, 'line_status')).toBe('ok');
        expect(pick({ info: { body: { body_chars: 9 } } }, 'body_chars')).toBe(9);
        expect(pick({}, 'model')).toBeUndefined();
    });

    it('A FIELD THE SERVER DID NOT SEND IS A ROW READING NOT KNOWN, never '
        + 'a missing row', () => {
        const panel = infoPanel({ model: 'claude-opus-5' });
        expect(panel.rows).toHaveLength(19);
        expect(panel.usage).toHaveLength(6);
        const model = panel.rows.find((r) => r.label === 'model');
        expect(model?.known).toBe(true);
        const uuid = panel.rows.find((r) => r.label === 'uuid');
        expect(uuid?.known).toBe(false);
        expect(uuid?.value).toBe('NOT KNOWN');
    });

    it('AN UNFAMILIAR KEY IS SHOWN, not dropped, so a field the server '
        + 'grew cannot become invisible for a year', () => {
        const panel = infoPanel({ info: { something_new: 'x', usage: { state: 'ok' } } });
        expect(panel.extra.map((r) => r.label)).toEqual(['something_new']);
    });

    it('A PANEL ASKED FOR A TURN THAT IS NOT HELD says so rather than '
        + 'rendering an empty box', () => {
        expect(infoPanel(null).missing).toBe(true);
    });
});
