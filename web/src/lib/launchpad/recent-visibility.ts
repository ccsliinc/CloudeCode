/**
 * Decide which stored RECENT rows may be painted, given the live sessions.
 *
 * PORTED FROM `client/js/session-recent-visibility.js`, which was deleted
 * in the same commit. The rules, the measurement behind them and the
 * fail-open asymmetry are that file's, moved rather than rewritten.
 *
 * WHY IT IS ITS OWN MODULE. The rule was once three inline lines in
 * `Launchpad.renderRecentSessions()`, keyed on the tmux NAME:
 *
 *     const liveNames = new Set(runningSessions.map(s => s.name));
 *     rows = recentAll.filter(r => !liveNames.has(r.tmux_name));
 *
 * A tmux name is not an identity. MEASURED ON THE OWNER'S BOX,
 * 2026-09-08: six session rows carry `archived_at`, three reach the wire,
 * and TWO of those three were then dropped here:
 *
 *     row  9  cloude_Mac         epoch 1788462035  ARCHIVED 2026-09-03
 *     row 11  cloude_Mac         epoch 1788463220  running
 *     row 10  cloude_Hirschfeld  epoch 1788462044  ARCHIVED 2026-09-03
 *     row 12  cloude_Hirschfeld  epoch 1788463221  running
 *
 * Rows 9 and 10 are not rows 11 and 12. They are older sessions that
 * happened to be given the same tmux name. The name key could not tell
 * them apart, so flipping "show archived" added exactly ONE row of the
 * six the user had archived, which reads on screen as a toggle that does
 * nothing.
 *
 * TWO RULES, IN THIS ORDER.
 *
 *   1. AN ARCHIVED ROW IS NEVER EXCLUDED BY THE RUNNING GUARD. The guard
 *      exists to stop a session appearing in RECENT while it is also on
 *      screen under RUNNING. A row the user archived cannot be that row:
 *      the running list is built from live sessions, none of which is
 *      archived. So the two facts cannot both hold, and excluding on this
 *      ground can only ever hide something otherwise unreachable.
 *
 *   2. A NON-ARCHIVED ROW IS EXCLUDED ONLY ON POSITIVE IDENTITY, i.e.
 *      when a live session's `session_row_id` IS this row's `id`. That
 *      still covers the case the guard was written for - a stopped row
 *      whose reaper has not run yet, whose tmux session is plainly in the
 *      listing - because that live session maps back to this very row.
 *
 * FAIL OPEN, DELIBERATELY, AND THE FALLBACK IS NAMED. The asymmetry is
 * stated server-side in `list_recent_sessions`: showing a duplicate is
 * untidy; HIDING a session the user can no longer reach from this screen
 * is the failure a list filter must never produce. But a payload carrying
 * NO `session_row_id` at all (an older server, a shape change) is not
 * evidence that nothing is duplicated - it is evidence we could not look.
 * In that one case the name key is used again for NON-archived rows, so
 * the duplicate the guard exists to prevent does not come back. Rule 1
 * holds in every case.
 */

/** One stored `SessionRecord` row, as much of it as this filter reads. */
export interface RecentRow {
    /** The sqlite rowid. The only thing that identifies this row. */
    id?: number | string | null;
    /** The tmux handle. Reused by tmux, so NEVER an identity. */
    tmux_name?: string | null;
    /** Set when the user archived the row. Never a hard delete. */
    archived_at?: string | null;
}

/** One live `AttachableSession`, as much of it as this filter reads. */
export interface LiveSession {
    /** The live tmux session name. */
    name?: string | null;
    /** The stored row this live session came from, when it knows. */
    session_row_id?: number | string | null;
}

/**
 * Read a live session's stored row id, or null when it has none.
 *
 * Description: normalises the three ways "no id" arrives (absent, null,
 *   undefined) to one value, so a caller never repeats the check. `0` is
 *   not a valid sqlite rowid, so it is treated as absent too rather than
 *   as a falsy trap.
 * Inputs: live - one AttachableSession from `GET /sessions/attachable`.
 * Output: number | null.
 * Example: rowIdOf({ session_row_id: 11 })  // 11
 */
export function rowIdOf(live: LiveSession | null | undefined): number | null {
    if (!live) return null;
    const raw = live.session_row_id;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Is this stored row one the user archived?
 *
 * Inputs: row - one SessionRecord from the wire.
 * Output: boolean - true when `archived_at` carries a value.
 * Example: isArchived({ archived_at: '2026-09-03T16:30:54Z' })  // true
 */
export function isArchived(row: RecentRow | null | undefined): boolean {
    return !!(row && row.archived_at);
}

/**
 * Filter stored RECENT rows down to the ones that may be painted.
 *
 * Description: applies the two rules in this module's header. Pure - it
 *   reads both lists and returns a new array, mutating neither. A
 *   non-array input answers with an empty list rather than throwing,
 *   because a render pass must degrade, never crash.
 * Inputs:
 *   recentRows - SessionRecord rows from `GET /sessions/recent`, archived
 *     ones included when the user asked for them.
 *   liveSessions - AttachableSession rows from `GET /sessions/attachable`.
 * Output: the subset to render, original order kept.
 * Example:
 *   visibleRecentRows(
 *       [{ id: 9, tmux_name: 'cloude_Mac', archived_at: '...' }],
 *       [{ name: 'cloude_Mac', session_row_id: 11 }],
 *   )  // the archived row is KEPT: row 9 is not row 11
 */
export function visibleRecentRows<T extends RecentRow>(
    recentRows: readonly T[] | null | undefined,
    liveSessions: readonly LiveSession[] | null | undefined,
): T[] {
    const rows = Array.isArray(recentRows) ? recentRows : [];
    const live = Array.isArray(liveSessions) ? liveSessions : [];
    if (!live.length) return rows.slice();

    const liveRowIds = new Set<number>();
    for (const s of live) {
        const id = rowIdOf(s);
        if (id !== null) liveRowIds.add(id);
    }
    // NOT "some live session lacks an id" - EVERY one of them. A partial
    // payload still identifies the sessions it identified, and demoting
    // the whole list to a name match because one row was incomplete would
    // re-introduce exactly the collision measured above.
    const identityUnavailable = liveRowIds.size === 0;
    const liveNames: Set<string> | null = identityUnavailable
        ? new Set(live.map((s) => s && s.name).filter((n): n is string => !!n))
        : null;

    return rows.filter((row) => {
        // Rule 1. See the header: an archived row is never the row that
        // is currently on screen under RUNNING.
        if (isArchived(row)) return true;
        if (identityUnavailable) {
            // Rule 2, degraded. Named, not silent - see FAIL OPEN.
            return !(row && row.tmux_name && liveNames!.has(row.tmux_name));
        }
        const id = row && row.id;
        if (id === undefined || id === null) return true;
        return !liveRowIds.has(Number(id));
    });
}
