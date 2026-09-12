/**
 * The RECENT group's decision ladder. Ported from
 * tests/test_recent_sessions.node.mjs and the row half of
 * tests/test_recent_deleted_sessions.node.mjs, both deleted in the same
 * commit.
 *
 * WHY THESE ASSERT ON A VIEW AND NOT ON MARKUP, WHICH IS A CHANGE FROM
 * THE NODE ORIGINALS. Those files asserted against the HTML string the
 * legacy renderer wrote, and they were right to: the renderer WAS the
 * decision, so there was nowhere else to look, and the task they locked
 * down warned that this project once shipped "282 green state assertions
 * that rendered zero pixels". The port splits that renderer into a pure
 * ladder plus a template that is a switch over its four cases, so the
 * decision now has a name and a value. These tests assert the decision.
 * The template is proven in a real browser under the production CSP,
 * because that is the only place a template is actually true.
 *
 * THREE OUTCOMES on `GET /sessions/recent`'s `state`:
 *   1. `ok`                - stored stopped rows render, RESTART offered
 *                            on each (lifecycle === 'stopped').
 *   2. `probe_unavailable` - the last probe failed; ZERO rows, and the
 *                            notice renders instead.
 *   3. `never_probed`      - no probe has run yet; same as (2).
 *
 * A NON-OK STATE MAY NEVER PRODUCE A ROW LIST, EMPTY OR OTHERWISE, and
 * that is what the `kind` assertions below exist for. An empty list there
 * is indistinguishable from "you have no history" - the false green this
 * project keeps paying for.
 */
import { describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import {
    describeRow,
    recentView,
    restartPlan,
    stateOf,
    type RecentSessionRecord,
    type Translate,
} from './recent';

/** A real translator over the real catalog. No stub: copy is under test. */
const i18n = createI18n({ locale: 'en' }) as { t: Translate };
const t: Translate = (key, params) => i18n.t(key, params);

/** The tmux-name deriver, stubbed to the shape slice 5 still owns. */
const derive = (name: string): string => name.replace(/^cloude_/, '');

/**
 * The nth row of a `rows` view, asserted to exist.
 *
 * Description: `noUncheckedIndexedAccess` is on in this project, so an
 *   index read is `T | undefined`. Asserting here rather than at every
 *   call site keeps the reason in one place: a test that indexes a row
 *   it did not first assert the length of is testing nothing.
 * Inputs: rows - the view's rows. n - the index.
 * Output: the row.
 * Example: rowAt(view.rows, 0).canRestart
 */
function rowAt<T>(rows: readonly T[], n: number): T {
    const found = rows[n];
    expect(found, `no row at index ${n}`).toBeDefined();
    return found as T;
}

/** One stored row, with the fields this surface reads. */
function row(overrides: Partial<RecentSessionRecord> = {}): RecentSessionRecord {
    return {
        id: 1,
        session_uuid: 'uuid-1',
        tmux_name: 'cloude_stopped_one',
        lifecycle: 'stopped',
        working_dir: '/tmp/proj',
        agent_type: 'claude',
        archived_at: null,
        title: null,
        ...overrides,
    };
}

describe('the three-outcome contract on the whole group', () => {
    test("`ok` with a stopped row renders that row and offers a restart", () => {
        const view = recentView({ state: 'ok', sessions: [row()] }, [], false, derive, t);
        expect(view.kind).toBe('rows');
        if (view.kind !== 'rows') return;
        expect(view.rows).toHaveLength(1);
        expect(rowAt(view.rows, 0).canRestart).toBe(true);
        expect(rowAt(view.rows, 0).restart).not.toBeNull();
    });

    test.each(['probe_unavailable', 'never_probed'])(
        "`%s` renders the notice and CANNOT render rows, even with sessions present",
        (state) => {
            // Sessions ARE present in the payload. A state that is not
            // `ok` must not render them as if freshly confirmed, and must
            // not render an empty list either - it must render a notice.
            const view = recentView(
                { state, sessions: [row(), row({ session_uuid: 'uuid-2' })], notice: null },
                [], false, derive, t,
            );
            expect(view.kind).toBe('unavailable');
            if (view.kind !== 'unavailable') return;
            expect(view.state).toBe(state);
            expect(view.title.length).toBeGreaterThan(0);
            expect(view.detail.length).toBeGreaterThan(0);
            // There is no `rows` key on this view AT ALL, which is the
            // structural half of the guarantee: a caller cannot reach a
            // row list from a state that did not confirm one.
            expect('rows' in view).toBe(false);
        },
    );

    test('the server notice is preferred over the fallback detail', () => {
        const view = recentView(
            { state: 'probe_unavailable', sessions: [], notice: 'the last tmux probe timed out' },
            [], false, derive, t,
        );
        expect(view.kind).toBe('unavailable');
        if (view.kind !== 'unavailable') return;
        // The server knows WHICH probe failed and why; this client does
        // not, so its own sentence is a fallback and never an override.
        expect(view.detail).toBe('the last tmux probe timed out');
    });

    test('a body with no state at all is NOT read as healthy', () => {
        // Not having been told is not evidence of health. This is the
        // one default in the whole ladder and it points at "we could not
        // look", never at "there is nothing here".
        expect(stateOf(null)).toBe('never_probed');
        expect(stateOf({})).toBe('never_probed');
        expect(stateOf({ state: '  ' })).toBe('never_probed');
        expect(recentView(null, [], false, derive, t).kind).toBe('unavailable');
    });

    test('`ok` with zero rows hides the section, with no attention block', () => {
        // The ordinary "nothing stopped" case. Inventing uncertainty
        // where there is none is its own kind of lie.
        expect(recentView({ state: 'ok', sessions: [] }, [], false, derive, t).kind)
            .toBe('hidden');
    });

    test('`ok` with zero rows KEEPS the section up while the archive filter is on', () => {
        // The filter's control lives in this section's heading, so hiding
        // the section would take away the only thing that can turn it
        // back off. "Asked for archived rows, there are none" is also a
        // real answer and has to be sayable.
        const view = recentView({ state: 'ok', sessions: [] }, [], true, derive, t);
        expect(view.kind).toBe('empty');
        if (view.kind !== 'empty') return;
        expect(view.message.length).toBeGreaterThan(0);
    });

    test('the count says how many rows are ON SCREEN, not how many arrived', () => {
        const rows = [row({ id: 1 }), row({ id: 2, session_uuid: 'uuid-2' })];
        // Row 2 IS the live session, so it belongs under RUNNING and is
        // excluded here. The count must follow the exclusion.
        const view = recentView(
            { state: 'ok', sessions: rows },
            [{ name: 'cloude_stopped_one', session_row_id: 2 }],
            false, derive, t,
        );
        expect(view.kind).toBe('rows');
        if (view.kind !== 'rows') return;
        expect(view.rows).toHaveLength(1);
        expect(view.count).toContain('1');
    });
});

describe('the restart gate is enforced at the render layer, not only by the query', () => {
    test.each(['unknown', 'running', 'archived', ''])(
        "a `%s` lifecycle row offers NO restart control",
        (lifecycle) => {
            // Restarting a session whose state could not be confirmed is
            // how you get two of the same session running at once. The
            // endpoint only sends `stopped` rows; this checks anyway.
            const view = recentView(
                { state: 'ok', sessions: [row({ lifecycle })] }, [], false, derive, t,
            );
            expect(view.kind).toBe('rows');
            if (view.kind !== 'rows') return;
            expect(rowAt(view.rows, 0).canRestart).toBe(false);
            expect(rowAt(view.rows, 0).restart).toBeNull();
        },
    );

    test('a stopped row carries its working dir and agent type into the restart', () => {
        const view = recentView(
            {
                state: 'ok',
                sessions: [row({ working_dir: '/home/x/proj', agent_type: 'codex' })],
            },
            [], false, derive, t,
        );
        expect(view.kind).toBe('rows');
        if (view.kind !== 'rows') return;
        expect(rowAt(view.rows, 0).restart).toEqual({
            sessionUuid: 'uuid-1',
            title: '',
            workingDir: '/home/x/proj',
            agentType: 'codex',
        });
    });

    test('every stopped row gets its own restart, not one for the group', () => {
        const view = recentView(
            {
                state: 'ok',
                sessions: [
                    row({ id: 1, session_uuid: 'a', tmux_name: 'cloude_a' }),
                    row({ id: 2, session_uuid: 'b', tmux_name: 'cloude_b' }),
                ],
            },
            [], false, derive, t,
        );
        expect(view.kind).toBe('rows');
        if (view.kind !== 'rows') return;
        expect(view.rows.map((r) => r.restart?.sessionUuid)).toEqual(['a', 'b']);
    });
});

describe('a row names itself the way the user named it', () => {
    test('the title leads, because it is what the user called the session', () => {
        const r = describeRow(row({ title: '  Media Compression  ' }), derive, t);
        expect(r.name).toBe('Media Compression');
    });

    test('with no title the derived tmux name answers, then the directory', () => {
        expect(describeRow(row({ title: null }), derive, t).name).toBe('stopped_one');
        expect(describeRow(
            row({ title: null, tmux_name: null, working_dir: '/tmp/p' }), derive, t,
        ).name).toBe('/tmp/p');
    });

    test('with nothing at all it still has a name, never an empty label', () => {
        const r = describeRow(
            { session_uuid: 'u', lifecycle: 'stopped' }, derive, t,
        );
        expect(r.name.length).toBeGreaterThan(0);
    });

    test('an archived row is MARKED and keeps its restart', () => {
        // It is only on screen because the filter is on, and an archived
        // row drawn identically to a live one makes the toggle look like
        // it did nothing. Restart is what recovers it: rebind_instance
        // clears `archived_at`, so losing that control would leave the
        // row visible and unrecoverable.
        const r = describeRow(row({ archived_at: '2026-09-07T13:40:24Z' }), derive, t);
        expect(r.archived).toBe(true);
        expect(r.canRestart).toBe(true);
        expect(r.restart).not.toBeNull();
    });

    test('a row with no archived_at is not marked archived', () => {
        expect(describeRow(row({ archived_at: null }), derive, t).archived).toBe(false);
    });

    test('a lifecycle we cannot act on is echoed verbatim, not translated away', () => {
        // It is a server enum this client does not enumerate. Inventing a
        // catalog key per unseen value would go stale the next time the
        // server grows a state; echoing it tells the user what it said.
        expect(describeRow(row({ lifecycle: 'wedged' }), derive, t).lifecycleLabel)
            .toBe('wedged');
    });
});

describe('the restart plan, which decides HOW before anything is sent', () => {
    test('a known uuid is the whole payload: the server owns the rest', () => {
        // Sending our own copies of title, directory and agent would hand
        // the server a second, staler declaration of facts it holds.
        const plan = restartPlan({
            sessionUuid: 'u1', title: 'Media', workingDir: '/p', agentType: 'claude',
        });
        expect(plan.mode).toBe('restart');
        expect(plan.sessionUuid).toBe('u1');
        expect(plan.payload).toBeNull();
        expect(plan.mustExplain).toBe(false);
    });

    test('no uuid still creates a session, and MUST be explained', () => {
        // The third outcome, not a silent degrade to a blank console.
        const plan = restartPlan({ title: 'Media', workingDir: '/p', agentType: 'claude' });
        expect(plan.mode).toBe('create_unidentified');
        expect(plan.mustExplain).toBe(true);
        // The title travels: `project_name` is what names the tmux
        // session, so it is the difference between the replacement
        // wearing the user's label and wearing a generated handle.
        expect(plan.payload).toEqual({
            working_dir: '/p', agent_type: 'claude', project_name: 'Media',
        });
    });

    test('empty and whitespace fields are dropped, never sent as blanks', () => {
        const plan = restartPlan({ sessionUuid: '   ', title: '', workingDir: '  ' });
        expect(plan.mode).toBe('create_unidentified');
        expect(plan.payload).toEqual({});
    });

    test('a null or absent options object does not throw', () => {
        expect(restartPlan(null).mode).toBe('create_unidentified');
        expect(restartPlan(undefined).mustExplain).toBe(true);
    });
});
