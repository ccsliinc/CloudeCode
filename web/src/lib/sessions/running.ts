/**
 * The two-endpoint merge behind the running-sessions list.
 *
 * PORTED FROM THE BODY OF `Launchpad.loadRunningSessions`, LINE BY LINE,
 * AND DELIBERATELY NOT TIDIED. Every branch below looks like it could be
 * shortened and none of them can. This is the file to read slowly.
 *
 * `GET /sessions/attachable` answers external tmux sessions on the cloude
 * socket plus cloude-owned sessions not currently bound to an active
 * backend. It FILTERS OUT every currently-live session, to prevent a
 * self-adopt footgun. `GET /sessions/list` answers those, so the two are
 * merged here, each row gaining an `is_active` flag.
 *
 * SIX FIELDS ARE OVERWRITTEN UNCONDITIONALLY AND MUST NEVER BE
 * `||`-DEFAULTED: `agent_family`, `agent_family_source`,
 * `agent_wrapper_label`, `startup_gate`, `status_source`, `label`, and
 * the wrapper-level `status`. Each is a THREE-OUTCOME field whose null is
 * a real answer meaning "the server could not determine it". A `||` keeps
 * the previous tick's value, so a session whose wrapper was deleted
 * mid-session goes on being named after it, a session that has just
 * answered its trust prompt goes on saying it needs a keypress, and a
 * status that stopped being hook-fed goes on claiming it was. The test
 * that catches this is `running.test.ts`; a `||` there is a measured red.
 *
 * `!== undefined ? x : null` IS NOT THE SAME AS `|| null`, and the
 * difference is the whole point. The first preserves a server-sent
 * `null`, `0`, `false` or empty string as itself; the second collapses
 * all of them into the fallback.
 */
import type {
    AttachableSession,
    ListingState,
    RunningSessionRow,
    SessionListItem,
    Translate,
} from './types';
import { emptyListing, noteListingUnknown } from './listing';

/**
 * Merge one live `/sessions/list` row into the attachable row set.
 *
 * Description: mutates `rows` - either overwriting the matching row's
 *   fields or UNSHIFTING a new one built field by field. Returns whether
 *   anything was done, which is false only for a row with no
 *   `tmux_session`; such a row cannot be addressed and is skipped, the
 *   same `continue` the legacy loop had.
 *
 *   THE MERGE BUILDS ITS ROW FIELD BY FIELD, so anything not copied here
 *   simply does not exist on it. A rename that persisted, resolved and
 *   was served correctly still vanished on screen for want of one line.
 * Inputs: rows - the merged set so far, mutated. live - one wrapper-level
 *   `/sessions/list` row.
 * Output: boolean - whether the row was merged.
 * Example: mergeLiveSession(rows, liveRow)
 */
export function mergeLiveSession(rows: RunningSessionRow[], live: SessionListItem): boolean {
    const tmuxName = live && live.tmux_session;
    if (!tmuxName) return false;
    // `activity_status` comes from the server's bulk tmux pane query
    // (src/core/session_status.py) - 'running' | 'idle' | 'dead' |
    // 'unknown'. Never fabricated client-side.
    const liveStatus = (live && live.activity_status) || 'unknown';
    const liveUnread = !!(live && live.unread);
    // THE WRAPPER-VERSUS-NESTED TRAP, and this is the line that names it.
    // The id lives on `.session`; everything else on this row lives on
    // the wrapper. `live.id` alone reads `undefined` silently.
    const liveId = (live.session && live.session.id) || live.id || null;
    const existing = rows.find((s) => s.name === tmuxName);
    if (existing) {
        existing.is_active = true;
        existing.session_id = liveId || existing.session_id;
        existing.status = liveStatus;
        existing.unread = liveUnread;
        existing.created_by_cloude = !!live.created_by_cloude;
        // punchlist 19 - whether this session is parked on an unanswered
        // startup prompt. Overwritten unconditionally for the same reason
        // the family and wrapper below are: a session that has just
        // answered its trust prompt must STOP saying it needs a keypress,
        // and a `||` would keep the stale value.
        existing.startup_gate = live.startup_gate;
        // Provenance for the status above, rendered in the tooltip only
        // (see session-status-ui.js). Overwritten unconditionally for the
        // same reason the gate is: a status that stops being hook-fed
        // must stop claiming it was.
        existing.status_source = live.status_source;
        // feat/agent-family-pills - THREE-OUTCOME family display.
        // `agent_family` is null (not a string) whenever the server could
        // not determine it - overwritten unconditionally, never `||`'d
        // against the previous value, so a session whose wrapper was
        // deleted mid-session correctly flips to unknown instead of
        // keeping a stale guess.
        existing.agent_family = live.agent_family !== undefined ? live.agent_family : null;
        existing.agent_family_source = live.agent_family_source !== undefined
            ? live.agent_family_source : null;
        // The wrapper pill's text, overwritten unconditionally for the
        // same reason the family is: a wrapper deleted or renamed
        // mid-session must stop being named, not keep the label it had
        // when the row was first built.
        existing.agent_wrapper_label = live.agent_wrapper_label !== undefined
            ? live.agent_wrapper_label : null;
        if (live.pinned_theme) existing.pinned_theme = live.pinned_theme;
        // The durable row id, so an OPEN session shows the same "#7" a
        // detached one does. Without this the id appeared and vanished
        // depending on whether you happened to have the session open,
        // which reads as a glitch rather than as two code paths.
        existing.session_row_id = live.session_row_id !== undefined ? live.session_row_id : null;
        existing.parent_session_id = live.parent_session_id !== undefined
            ? live.parent_session_id : null;
        // The user's chosen name. See the note at the top of this
        // function about building the row field by field.
        if (live.label !== undefined) existing.label = live.label;
        return true;
    }
    rows.unshift({
        name: tmuxName,
        // The badge means: did THIS APP CREATE this tmux session, or did
        // it merely ADOPT one started outside the app? That is a fact
        // about origin, so it must not flip when the session is opened or
        // closed, and it must survive a server restart.
        //
        // Never derived here. The server answers it from its persisted
        // `owned_tmux_sessions` set and ships it on
        // SessionInfo.created_by_cloude - the same source
        // AttachableSession uses, so a row merged from either endpoint
        // agrees. Two previous local derivations were both wrong: a
        // hardcoded `true` badged every OPEN session TMUX (open sessions
        // reach us only here, because /sessions/attachable filters them
        // out), and an `adopted:`-id-prefix test badged nearly everything
        // EXTERNAL, because a server restart re-attaches to still-running
        // tmux sessions through the adopt path and mints `adopted:` ids
        // for sessions the server still owns. The id is not durable; the
        // NAME is.
        created_by_cloude: !!live.created_by_cloude,
        // `SessionInfo` CARRIES NO `created_at_epoch`, so this is a zero
        // on every real live-only row - which is exactly why such a row
        // always takes the NAME-ONLY rung of the attribution join and
        // never the instance-exact one. Not a bug and not a placeholder
        // waiting to be filled: the epoch is simply not on that wire
        // shape. See web/src/lib/sessions/types.ts.
        created_at_epoch: live.created_at_epoch || 0,
        window_count: 1,
        is_active: true,
        session_id: liveId,
        status: liveStatus,
        unread: liveUnread,
        pinned_theme: live.pinned_theme || null,
        // feat/agent-family-pills - see the `existing` branch above for
        // why this is never defaulted to a guessed string.
        agent_family: live.agent_family !== undefined ? live.agent_family : null,
        agent_family_source: live.agent_family_source !== undefined
            ? live.agent_family_source : null,
        // See the `existing` branch above.
        agent_wrapper_label: live.agent_wrapper_label !== undefined
            ? live.agent_wrapper_label : null,
        // See the `existing` branch above.
        session_row_id: live.session_row_id !== undefined ? live.session_row_id : null,
        parent_session_id: live.parent_session_id !== undefined ? live.parent_session_id : null,
        // See the `existing` branch above.
        label: live.label !== undefined ? live.label : null,
        // See the `existing` branch above. Left undefined when the server
        // sent nothing, which the renderer normalizes to 'unknown' and
        // paints as nothing at all.
        startup_gate: live.startup_gate,
    });
    return true;
}

/**
 * Merge every live row, in the order the server listed them.
 *
 * Inputs: rows - the attachable set, mutated. liveSessions - the
 *   `/sessions/list` payload.
 * Output: the same array, for chaining.
 * Example: mergeLiveSessions(rows, liveSessions)
 */
export function mergeLiveSessions(
    rows: RunningSessionRow[],
    liveSessions: SessionListItem[],
): RunningSessionRow[] {
    for (const live of liveSessions) {
        mergeLiveSession(rows, live);
    }
    return rows;
}

/**
 * Drop the husks, and only the husks.
 *
 * Description: A DEAD PANE IS NOT A RUNNING SESSION. tmux `has-session`
 *   stays true for a pane held open by `remain-on-exit` after its
 *   foreground process exited, so a husk arrives here from
 *   `GET /sessions/attachable` - which enumerates the socket and MUST
 *   keep returning it, because the lifecycle reaper depends on that
 *   enumeration being complete. Membership of the "running" section is
 *   this layer's decision, not the enumeration's, so the filter belongs
 *   here and nowhere else. Until it existed the husk was rendered among
 *   the running rows and counted in the heading, while its own red dot -
 *   read from `#{pane_dead}` - had been telling the truth all along.
 *
 *   THREE OUTCOMES: only a MEASURED `dead` is dropped. `unknown` STAYS,
 *   because "the probe could not tell" is not "it ended"; dropping it
 *   would assert a death nobody measured, which is the same false verdict
 *   in the opposite direction.
 * Inputs: rows - the merged set.
 * Output: a new array without the measured-dead rows.
 * Example: filterDeadPanes(rows)
 */
export function filterDeadPanes(rows: RunningSessionRow[]): RunningSessionRow[] {
    return rows.filter((s) => !s || s.status !== 'dead');
}

/**
 * Record the attachable probe's answer, three outcomes intact.
 *
 * Description: an array is the list. A 200 whose body is NOT an array is
 *   not an empty list, it is an unparseable one, and saying zero there
 *   would be the same invented verdict as swallowing a rejection.
 * Inputs: list - whatever the fetch resolved with. listing - the tick's
 *   verdict, mutated on the malformed path. malformedDetail - the
 *   assembled sentence for that path.
 * Output: RunningSessionRow[] - the rows, or empty.
 * Example: rowsFromAttachable(list, listing, detail)
 */
export function rowsFromAttachable(
    list: unknown,
    listing: ListingState,
    malformedDetail: string,
): RunningSessionRow[] {
    if (Array.isArray(list)) {
        return list as AttachableSession[] as RunningSessionRow[];
    }
    noteListingUnknown(listing, 'attachable', 'malformed_response', malformedDetail);
    return [];
}

/**
 * Fetch both endpoints and produce this tick's row set and verdict.
 *
 * Description: combines `GET /sessions/attachable` (external tmux
 *   sessions plus cloude-owned ones not currently bound to a backend)
 *   with `GET /sessions/list` (every currently-live session, which the
 *   attachable filter drops to prevent a self-adopt footgun).
 *
 *   A 404 FROM THE LIVE MERGE IS AN ANSWER: there is no active session.
 *   Anything else is NOT - it is a merge that did not run, so the row set
 *   may be missing every currently-open session, and the listing says so.
 *   The old bare "404 = no active session, fine" treated both the same
 *   and let a failed merge render as "these are all your sessions".
 *
 *   The dead-pane filter runs last, because a husk can arrive from either
 *   endpoint and membership of the running section is decided once.
 * Inputs: host, t, and the two copy assemblers, injected so this module
 *   carries no sentence of its own. onReauth fires on a 401 only.
 * Output: Promise of the rows and the tick's verdict. Never rejects.
 * Example: const { rows, listing } = await loadRunningRows(deps);
 */
export async function loadRunningRows(deps: {
    host: {
        listAttachableSessions(): Promise<AttachableSession[]>;
        listSessions?(): Promise<SessionListItem[]>;
        getCurrentSession(): Promise<SessionListItem | null>;
    };
    t: Translate;
    malformedDetail: (t: Translate) => string;
    detailFor: (err: unknown, status: number | null, t: Translate) => string;
    reasonFor: (err: unknown, status: number | null) => string;
    statusFor: (err: unknown) => number | null;
    onReauth?: () => void;
}): Promise<{ rows: RunningSessionRow[]; listing: ListingState }> {
    const listing = emptyListing();
    let rows: RunningSessionRow[] = [];
    try {
        const list = await deps.host.listAttachableSessions();
        rows = rowsFromAttachable(list, listing, deps.malformedDetail(deps.t));
    } catch (err) {
        const status = deps.statusFor(err);
        console.error(
            'CloudeWeb: loadRunningSessions failed:',
            status !== null ? `status=${status}` : '(no status)',
            err,
        );
        if (status === 401 && deps.onReauth) deps.onReauth();
        rows = [];
        noteListingUnknown(
            listing, 'attachable',
            deps.reasonFor(err, status),
            deps.detailFor(err, status, deps.t),
        );
    }
    try {
        let liveSessions: SessionListItem[] = [];
        if (typeof deps.host.listSessions === 'function') {
            liveSessions = await deps.host.listSessions();
        }
        if (!Array.isArray(liveSessions) || liveSessions.length === 0) {
            // Back-compat fallback: single-session server.
            const current = await deps.host.getCurrentSession();
            liveSessions = current ? [current] : [];
        }
        mergeLiveSessions(rows, liveSessions);
    } catch (err) {
        const status = deps.statusFor(err);
        if (status !== 404) {
            console.error('CloudeWeb: live-session merge failed:',
                status !== null ? `status=${status}` : '(no status)', err);
            noteListingUnknown(
                listing, 'live',
                deps.reasonFor(err, status),
                deps.detailFor(err, status, deps.t),
            );
        }
    }
    return { rows: filterDeadPanes(rows), listing };
}
