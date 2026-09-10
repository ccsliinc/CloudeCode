/**
 * The two-endpoint merge, the six never-defaulted fields, and the husks.
 *
 * PORTED FROM tests/test_dead_pane_not_running.node.mjs,
 * tests/test_session_lists_are_disjoint.node.mjs and
 * tests/test_running_sessions_unknown.node.mjs. Those three files kept
 * every assertion about RENDERED MARKUP, which slices 4 and 5 own; what
 * moved here is the row set and the verdict those renderers are handed.
 *
 * THE SIX NEVER-DEFAULTED FIELDS ARE THE POINT OF THIS FILE.
 * `agent_family`, `agent_family_source`, `agent_wrapper_label`,
 * `startup_gate`, `status_source`, `label` and the wrapper-level `status`
 * are each a THREE-OUTCOME field whose null is a real answer meaning "the
 * server could not determine it". A `||` in any of them keeps the
 * previous tick's value, so a session whose wrapper was deleted
 * mid-session goes on being named after it and one that has just answered
 * its trust prompt goes on saying it needs a keypress. Every one of them
 * has a case below that goes RED on a `||`, and the cases are written as
 * "a live row that says null OVERWRITES a stale non-null", which is the
 * only shape a default cannot survive.
 */
import { describe, expect, test } from 'vitest';

import { emptyListing } from './listing';
import { filterDeadPanes, mergeLiveSession, mergeLiveSessions, rowsFromAttachable } from './running';
import type { RunningSessionRow, SessionListItem } from './types';

/**
 * One attachable row already in the set, wearing STALE values in every
 * field the live row is supposed to overwrite.
 */
function stale(over: Partial<RunningSessionRow> = {}): RunningSessionRow {
    return {
        name: 'cloude_a',
        status: 'idle',
        unread: false,
        created_by_cloude: true,
        created_at_epoch: 1000,
        window_count: 1,
        agent_family: 'claude',
        agent_family_source: 'launched',
        agent_wrapper_label: 'claude in chrome',
        startup_gate: 'awaiting_startup_prompt',
        status_source: 'hook',
        label: 'an old name',
        session_row_id: 7,
        parent_session_id: 'ses_parent',
        pinned_theme: 'amber',
        ...over,
    };
}

/**
 * One `/sessions/list` WRAPPER row. Note the nesting: the id lives on
 * `.session` and everything else lives here.
 */
function live(over: Partial<SessionListItem> = {}): SessionListItem {
    return {
        tmux_session: 'cloude_a',
        activity_status: 'working',
        unread: true,
        created_by_cloude: true,
        session: { id: 'ses_live' },
        ...over,
    };
}

describe('the wrapper-versus-nested trap', () => {
    test('the session id is read off `.session`, not off the wrapper', () => {
        const rows = [stale()];
        mergeLiveSession(rows, live());
        expect(rows[0]!.session_id).toBe('ses_live');
    });

    test('a live-only row is built with the same rule', () => {
        const rows: RunningSessionRow[] = [];
        mergeLiveSession(rows, live({ tmux_session: 'cloude_new' }));
        expect(rows[0]!.session_id).toBe('ses_live');
    });

    test('a row with no tmux_session cannot be addressed and is skipped', () => {
        const rows: RunningSessionRow[] = [];
        expect(mergeLiveSession(rows, live({ tmux_session: null }))).toBe(false);
        expect(rows).toHaveLength(0);
    });
});

describe('the six fields a live row overwrites UNCONDITIONALLY', () => {
    // Each case hands the merge a live row whose field is null or absent
    // over a stale row whose field holds a real value. A `||` default
    // keeps the stale value and every one of these goes red.
    const CASES: Array<[keyof RunningSessionRow, Partial<SessionListItem>]> = [
        ['agent_family', { agent_family: null }],
        ['agent_family_source', { agent_family_source: null }],
        ['agent_wrapper_label', { agent_wrapper_label: null }],
        ['status_source', { status_source: null }],
        ['session_row_id', { session_row_id: null }],
        ['parent_session_id', { parent_session_id: null }],
    ];

    test.each(CASES)('a null %s replaces the stale value on an existing row', (field, patch) => {
        const rows = [stale()];
        mergeLiveSession(rows, live(patch));
        expect(rows[0]![field]).toBeNull();
    });

    // `status_source` IS ABSENT FROM THIS LIST, AND THAT IS THE LEGACY
    // BEHAVIOUR RATHER THAN AN OVERSIGHT IN THE PORT. The merge's
    // overwrite branch sets it; its live-only unshift branch never has, so
    // a session that reaches the launchpad ONLY through `/sessions/list`
    // carries no provenance for its status at all and the tooltip says
    // nothing. It reads like a missing line. It was left exactly as it
    // stood, because slice 3 is a MOVE and fixing a behaviour while
    // relocating it makes a regression impossible to bisect. Flagged in
    // the slice 3 report; it belongs to slice 5, which owns that tooltip.
    const UNSHIFT_CASES = CASES.filter(([field]) => field !== 'status_source');

    test.each(UNSHIFT_CASES)('...and lands as null on a live-only row too', (field, patch) => {
        const rows: RunningSessionRow[] = [];
        mergeLiveSession(rows, live({ ...patch, tmux_session: 'cloude_new' }));
        expect(rows[0]![field]).toBeNull();
    });

    test('a live-only row carries NO status_source, which is a known gap', () => {
        // Pinned so the gap is a measured fact rather than folklore, and
        // so slice 5 closing it is a deliberate, visible change.
        const rows: RunningSessionRow[] = [];
        mergeLiveSession(rows, live({ status_source: 'hook', tmux_session: 'cloude_new' }));
        expect(rows[0]!.status_source).toBeUndefined();
    });

    test('an ABSENT field also becomes null, so a stale guess cannot survive', () => {
        // The server omitting a field and the server sending null mean the
        // same thing to a reader: it could not determine it. What must not
        // happen is the previous tick's answer standing in for either.
        const rows = [stale()];
        mergeLiveSession(rows, {
            tmux_session: 'cloude_a', activity_status: 'working', session: { id: 'x' },
        });
        expect(rows[0]!.agent_family).toBeNull();
        expect(rows[0]!.agent_family_source).toBeNull();
        expect(rows[0]!.agent_wrapper_label).toBeNull();
        expect(rows[0]!.status_source).toBeUndefined();
    });

    test('a session that has ANSWERED its trust prompt stops asking for a key', () => {
        // punchlist 19, stated as the behaviour rather than the field. The
        // stale row says `awaiting_startup_prompt`; the live row says
        // `ready`, and a `||` would never let it through because the stale
        // value is truthy.
        const rows = [stale()];
        mergeLiveSession(rows, live({ startup_gate: 'ready' }));
        expect(rows[0]!.startup_gate).toBe('ready');
    });

    test('and a gate the server stopped sending stops being claimed', () => {
        const rows = [stale()];
        mergeLiveSession(rows, live({ startup_gate: undefined }));
        expect(rows[0]!.startup_gate).toBeUndefined();
    });

    test('a wrapper deleted mid-session stops being named', () => {
        const rows = [stale()];
        mergeLiveSession(rows, live({ agent_wrapper_label: null, agent_family: null }));
        expect(rows[0]!.agent_wrapper_label).toBeNull();
        expect(rows[0]!.agent_family).toBeNull();
    });

    test('the LABEL is overwritten when sent, including with an empty string', () => {
        // An empty label is the user clearing the name. `|| existing` would
        // silently restore the old one.
        const rows = [stale()];
        mergeLiveSession(rows, live({ label: '' }));
        expect(rows[0]!.label).toBe('');
    });

    test('...but an ABSENT label leaves the attachable row\'s own name alone', () => {
        // The asymmetry is deliberate and is the legacy rule byte for
        // byte: `if (live.label !== undefined)`. A rename that persisted,
        // resolved and was served correctly still vanished on screen for
        // want of that line, so the field is copied - but an endpoint that
        // said nothing is not an instruction to erase.
        const rows = [stale()];
        mergeLiveSession(rows, live({ label: undefined }));
        expect(rows[0]!.label).toBe('an old name');
    });

    test('the wrapper-level status is replaced, never OR-ed', () => {
        const rows = [stale({ status: 'working' })];
        mergeLiveSession(rows, live({ activity_status: 'idle' }));
        expect(rows[0]!.status).toBe('idle');
    });

    test('a live row that sends NO status reads unknown, not the stale one', () => {
        const rows = [stale({ status: 'working' })];
        mergeLiveSession(rows, live({ activity_status: null }));
        expect(rows[0]!.status).toBe('unknown');
    });

    test('NEGATIVE CONTROL: a real value does reach the row', () => {
        // Without this, a merge that wrote null over everything
        // unconditionally would pass every assertion above.
        const rows = [stale()];
        mergeLiveSession(rows, live({
            agent_family: 'codex', agent_family_source: 'inferred_process',
            agent_wrapper_label: 'codex cli', status_source: 'transcript',
            startup_gate: 'ready', label: 'a new name', session_row_id: 42,
        }));
        expect(rows[0]).toMatchObject({
            agent_family: 'codex',
            agent_family_source: 'inferred_process',
            agent_wrapper_label: 'codex cli',
            status_source: 'transcript',
            startup_gate: 'ready',
            label: 'a new name',
            session_row_id: 42,
        });
    });
});

describe('the fields that are NOT unconditionally overwritten', () => {
    test('a pinned theme is only replaced when the live row has one', () => {
        const rows = [stale({ pinned_theme: 'amber' })];
        mergeLiveSession(rows, live({ pinned_theme: null }));
        expect(rows[0]!.pinned_theme).toBe('amber');
    });

    test('created_by_cloude comes from the server and is never derived', () => {
        // A fact about ORIGIN. It must not flip when a session is opened
        // or closed. Two previous local derivations were both wrong.
        const rows = [stale({ created_by_cloude: true })];
        mergeLiveSession(rows, live({ created_by_cloude: false }));
        expect(rows[0]!.created_by_cloude).toBe(false);
    });
});

describe('a live-only row and the epoch it cannot have', () => {
    test('is unshifted to the FRONT, and marked active', () => {
        const rows = [stale({ name: 'cloude_other' })];
        mergeLiveSession(rows, live({ tmux_session: 'cloude_new' }));
        expect(rows.map((r) => r.name)).toEqual(['cloude_new', 'cloude_other']);
        expect(rows[0]!.is_active).toBe(true);
    });

    test('carries a ZERO epoch, because SessionInfo has none', () => {
        // THIS IS WHY A LIVE-ONLY ROW ALWAYS TAKES THE NAME-ONLY RUNG of
        // the attribution join. It is not a placeholder waiting to be
        // filled: the epoch is simply not on that wire shape.
        const rows: RunningSessionRow[] = [];
        mergeLiveSession(rows, live({ tmux_session: 'cloude_new' }));
        expect(rows[0]!.created_at_epoch).toBe(0);
    });

    test('an existing row KEEPS its own epoch across the merge', () => {
        // The attachable endpoint is the only source of a real epoch, so
        // the merge must not overwrite one with the live row's absence.
        const rows = [stale({ created_at_epoch: 1788016091 })];
        mergeLiveSession(rows, live());
        expect(rows[0]!.created_at_epoch).toBe(1788016091);
    });
});

describe('a dead pane is not a running session', () => {
    test('a MEASURED dead row is dropped', () => {
        const rows = [stale({ name: 'cloude_dead', status: 'dead' }), stale()];
        expect(filterDeadPanes(rows).map((r) => r.name)).toEqual(['cloude_a']);
    });

    test('an UNKNOWN row is KEPT: could-not-tell is not a death', () => {
        // Dropping it would assert a death nobody measured, which is the
        // same false verdict in the opposite direction.
        const rows = [stale({ name: 'cloude_unknown', status: 'unknown' })];
        expect(filterDeadPanes(rows).map((r) => r.name)).toEqual(['cloude_unknown']);
    });

    test('a row with no status at all is kept for the same reason', () => {
        const rows = [stale({ name: 'cloude_quiet', status: null })];
        expect(filterDeadPanes(rows)).toHaveLength(1);
    });

    test('a listing of ONLY dead rows yields none, and does not throw', () => {
        const rows = [stale({ status: 'dead' }), stale({ name: 'b', status: 'dead' })];
        expect(filterDeadPanes(rows)).toEqual([]);
    });

    test('a live row that goes dead is dropped after the merge, not before', () => {
        // The husk can arrive from EITHER endpoint, so membership of the
        // running section is decided once, at the end.
        const rows = [stale()];
        mergeLiveSessions(rows, [live({ activity_status: 'dead' })]);
        expect(rows).toHaveLength(1);
        expect(filterDeadPanes(rows)).toEqual([]);
    });
});

describe('the attachable body, and what a non-array means', () => {
    test('an array is the list', () => {
        const listing = emptyListing();
        expect(rowsFromAttachable([stale()], listing, 'detail')).toHaveLength(1);
        expect(listing.ok).toBe(true);
    });

    test('a non-array 200 is UNKNOWN, not empty', () => {
        // A 200 that did not parse is an unparseable list. Saying zero
        // would be the same invented verdict as swallowing a rejection.
        const listing = emptyListing();
        expect(rowsFromAttachable({ oops: true }, listing, 'the body was not a list'))
            .toEqual([]);
        expect(listing.ok).toBe(false);
        expect(listing.reason).toBe('malformed_response');
        expect(listing.detail).toBe('the body was not a list');
        expect(listing.sources).toEqual(['attachable']);
    });

    test('an EMPTY array is a measured zero and raises no alarm', () => {
        // NEGATIVE CONTROL for the rule above: the third outcome must be
        // distinguishable from a real empty list, or it says nothing.
        const listing = emptyListing();
        expect(rowsFromAttachable([], listing, 'detail')).toEqual([]);
        expect(listing.ok).toBe(true);
    });
});
