/**
 * Which stored RECENT rows survive the "already running" guard.
 *
 * PORTED FROM tests/test_recent_deleted_visibility.node.mjs, deleted in
 * the same commit as `client/js/session-recent-visibility.js` itself. The
 * cases are that file's, including its measurement, because they are the
 * specification: this rule was keyed on the tmux NAME once and it hid
 * five of the six rows the user had archived.
 *
 * ONE CASE IS DELIBERATELY NOT PORTED. The node original ended with a
 * source-level check that `launchpad.js` calls the module and that
 * `index.html` loads it before `launchpad.js`. Both statements are now
 * false BY DESIGN - the module is gone, the rule is imported at build
 * time into the bundle, and there is no script tag left to order. A wiring
 * assertion about a wiring that no longer exists is not a guard, it is a
 * fossil. What replaces it is the browser proof: an archived row that
 * shares a live session's name is visible on screen with the filter on.
 */
import { describe, expect, test } from 'vitest';

import { isArchived, rowIdOf, visibleRecentRows, type RecentRow } from './recent-visibility';

/** The ids that survived, in order, so a diff names the rows. */
function ids(rows: readonly RecentRow[]): Array<number | string | null | undefined> {
    return rows.map((r) => r.id);
}

describe('the regression: a name is not an identity', () => {
    test('an archived row is kept when a live session reused its tmux name', () => {
        // MEASURED ON THE OWNER'S BOX, 2026-09-08. Rows 9 and 10 are not
        // rows 11 and 12; they are older sessions that happened to be
        // given the same tmux name. The name key could not tell them
        // apart, so flipping the filter added exactly ONE of six rows,
        // which reads on screen as a control that does nothing.
        const recent: RecentRow[] = [
            { id: 9, tmux_name: 'cloude_Mac', archived_at: '2026-09-03T19:20:11.638508Z' },
            { id: 10, tmux_name: 'cloude_Hirschfeld', archived_at: '2026-09-03T19:20:11.685805Z' },
            { id: 41, tmux_name: 'cloude_CloudeCode', archived_at: '2026-09-07T13:31:01.049755Z' },
        ];
        const live = [
            { name: 'cloude_Mac', session_row_id: 11 },
            { name: 'cloude_Hirschfeld', session_row_id: 12 },
        ];
        expect(ids(visibleRecentRows(recent, live))).toEqual([9, 10, 41]);
    });

    test('a live row is never excluded on a name match alone', () => {
        const recent: RecentRow[] = [{ id: 30, tmux_name: 'cloude_BHPP', archived_at: null }];
        const live = [{ name: 'cloude_BHPP', session_row_id: 31 }];
        expect(ids(visibleRecentRows(recent, live))).toEqual([30]);
    });
});

describe('the guard still does its job, on identity', () => {
    test('a stopped row the reaper has not caught up with is suppressed', () => {
        // Row 20 IS this live session - same stored row, lifecycle simply
        // not reconciled yet. It is on screen under RUNNING, so RECENT
        // drops it. A session appears in exactly one list.
        const recent: RecentRow[] = [
            { id: 20, tmux_name: 'cloude_BHPP', archived_at: null },
            { id: 21, tmux_name: 'cloude_Other', archived_at: null },
        ];
        expect(ids(visibleRecentRows(recent, [{ name: 'cloude_BHPP', session_row_id: 20 }])))
            .toEqual([21]);
    });
});

describe('degraded identity is named, not silent', () => {
    test('with no session_row_id anywhere, the name key is used for live rows', () => {
        // A payload carrying no id at all is evidence we could not look,
        // not evidence nothing is duplicated. The old key comes back for
        // exactly that case, so the duplicate does not return with it.
        const recent: RecentRow[] = [
            { id: 40, tmux_name: 'cloude_BHPP', archived_at: null },
            { id: 41, tmux_name: 'cloude_Keep', archived_at: null },
        ];
        expect(ids(visibleRecentRows(recent, [{ name: 'cloude_BHPP' }]))).toEqual([41]);
    });

    test('with no session_row_id anywhere, an archived row is STILL kept', () => {
        // Rule 1 holds in every case, degraded identity included.
        const recent: RecentRow[] = [
            { id: 42, tmux_name: 'cloude_BHPP', archived_at: '2026-09-07T21:30:00.000000Z' },
        ];
        expect(ids(visibleRecentRows(recent, [{ name: 'cloude_BHPP' }]))).toEqual([42]);
    });

    test('a PARTIAL payload does not demote the whole list to the name key', () => {
        // One live session identified itself, one did not. The identified
        // one is not row 50, so row 50 stays. Demoting on "some row was
        // incomplete" would re-introduce the collision above.
        const recent: RecentRow[] = [{ id: 50, tmux_name: 'cloude_BHPP', archived_at: null }];
        const live = [{ name: 'cloude_BHPP' }, { name: 'cloude_Elsewhere', session_row_id: 99 }];
        expect(ids(visibleRecentRows(recent, live))).toEqual([50]);
    });
});

describe('shapes that must not throw and must not silently empty the list', () => {
    test('no live sessions excludes nothing', () => {
        const recent: RecentRow[] = [{ id: 60, tmux_name: 'cloude_A', archived_at: null }];
        expect(ids(visibleRecentRows(recent, []))).toEqual([60]);
        expect(ids(visibleRecentRows(recent, null))).toEqual([60]);
    });

    test('non-array inputs answer with an empty list, never a throw', () => {
        expect(visibleRecentRows(null, null)).toEqual([]);
        expect(visibleRecentRows(undefined, [{ name: 'x' }])).toEqual([]);
    });

    test('a row with no id survives an identity-keyed pass', () => {
        // It cannot be identified, so it cannot be positively excluded.
        // Fail open: hiding a session the user can no longer reach is the
        // failure a list filter must never produce.
        const recent: RecentRow[] = [{ tmux_name: 'cloude_A', archived_at: null }];
        expect(visibleRecentRows(recent, [{ name: 'cloude_A', session_row_id: 7 }]))
            .toHaveLength(1);
    });

    test('the filter returns a NEW array and mutates neither input', () => {
        const recent: RecentRow[] = [{ id: 1, archived_at: null }];
        const live = [{ name: 'x', session_row_id: 2 }];
        const out = visibleRecentRows(recent, live);
        expect(out).not.toBe(recent);
        expect(recent).toHaveLength(1);
        expect(live).toHaveLength(1);
    });
});

describe('the two helpers, stated rather than inferred', () => {
    test('rowIdOf normalises every "no id" shape to null', () => {
        expect(rowIdOf({ session_row_id: 11 })).toBe(11);
        expect(rowIdOf({ session_row_id: '11' })).toBe(11);
        expect(rowIdOf({ session_row_id: null })).toBeNull();
        // 0 is not a valid sqlite rowid, so it is absent and not a
        // falsy trap that a truthiness check would misread.
        expect(rowIdOf({ session_row_id: 0 })).toBeNull();
        expect(rowIdOf({})).toBeNull();
        expect(rowIdOf(null)).toBeNull();
    });

    test('isArchived reads archived_at and nothing else', () => {
        expect(isArchived({ archived_at: '2026-09-03T00:00:00Z' })).toBe(true);
        expect(isArchived({ archived_at: null })).toBe(false);
        expect(isArchived({ tmux_name: 'cloude_x' })).toBe(false);
        expect(isArchived(null)).toBe(false);
    });
});

describe('NEGATIVE CONTROL: the filter is capable of excluding something', () => {
    test('a matcher that always kept everything would pass every case above', () => {
        // Without this, a `visibleRecentRows` that returned its input
        // unchanged would satisfy the archived cases, the degraded cases
        // and every shape case, and prove nothing at all.
        const recent: RecentRow[] = [{ id: 1, tmux_name: 'cloude_A', archived_at: null }];
        expect(visibleRecentRows(recent, [{ name: 'cloude_A', session_row_id: 1 }]))
            .toEqual([]);
    });
});
