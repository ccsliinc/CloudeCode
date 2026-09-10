/**
 * The RECENT group: everything about it that is not markup.
 *
 * WHAT THIS IS A PORT OF. `client/js/launchpad.js` carried nine methods
 * for this section - `loadRecentSessions`, `_renderRecentSessionRowHtml`,
 * `renderRecentSessions`, `_bindRecentSessionClicks`, `_forkSession`,
 * `_deleteSessionRecord`, `_restartPlan`, `_restartNotice` and
 * `_restartRecentSession` - plus the two show-archived preferences and
 * `client/js/session-recent-visibility.js`. They were deleted in the same
 * commit that added this file. The rules below are that code, moved
 * rather than rewritten, and the comments explaining WHY a rule is the
 * way it is came with it.
 *
 * THE THREE-OUTCOME CONTRACT IS THE WHOLE POINT OF `recentView()`.
 * `GET /sessions/recent` answers `state` of `ok`, `probe_unavailable` or
 * `never_probed`, and a state that is not `ok` MUST render its notice and
 * ZERO rows. A silently empty list there is indistinguishable from "you
 * have no history", which is the false-green this project keeps paying
 * for. It is a ladder returning a VALUE, so the contract can be asserted
 * with no DOM and the component beside it is a switch over four cases.
 *
 * NO COPY LIVES HERE. Every sentence comes from
 * `client/js/labels/recent-session.js` reading the catalog. `t` is passed
 * in rather than imported so a test can drive the whole ladder in the
 * pseudo locale without moving the running app's.
 */
import {
    RECENT_KEYS,
    recentCountLabel,
    recentCountUnavailableLabel,
    unavailableDetail,
} from '../../../../client/js/labels/recent-session.js';
import { visibleRecentRows, type LiveSession, type RecentRow } from './recent-visibility';

/** How a message is looked up. Always injected, never imported here. */
export type Translate = (key: string, params?: Record<string, unknown> | null) => string;

/** One stored session row, as `GET /sessions/recent` sends it. */
export interface RecentSessionRecord extends RecentRow {
    /** The durable key. A restart is addressed by this, never by a name. */
    session_uuid?: string | null;
    /** `stopped` is the ONLY value a restart control may be offered for. */
    lifecycle?: string | null;
    /** The user's own label for the session, when they gave it one. */
    title?: string | null;
    /** Where the session ran. Carried into an unidentified restart. */
    working_dir?: string | null;
    /** The wrapper id it was launched under. */
    agent_type?: string | null;
}

/** The `GET /sessions/recent` body. */
export interface RecentSessionsPayload {
    /** `ok` | `probe_unavailable` | `never_probed`. Never collapsed to two. */
    state?: string | null;
    sessions?: RecentSessionRecord[] | null;
    /** The server's own sentence for a state that is not `ok`. */
    notice?: string | null;
}

/** One row of the list, already resolved to the strings it paints. */
export interface RecentRowView {
    /** The durable key, and the `data-uuid` every control carries. */
    uuid: string;
    /** What the user is asked to recognise. Never empty. */
    name: string;
    /** The raw lifecycle, for the `data-lifecycle` attribute. */
    lifecycle: string;
    /** The badge's text: the ended word, or the raw lifecycle verbatim. */
    lifecycleLabel: string;
    /** Whether a restart control may be offered at all. */
    canRestart: boolean;
    /** Whether the user has archived this row. */
    archived: boolean;
    /** The restart control's payload, null when no restart is offered. */
    restart: RestartOptions | null;
}

/** The four things this section can be. */
export type RecentView =
    | { kind: 'hidden' }
    | { kind: 'unavailable'; state: string; title: string; detail: string; count: string }
    | { kind: 'empty'; count: string; message: string }
    | { kind: 'rows'; count: string; rows: RecentRowView[] };

/** What a restart control carries, and what the plan is built from. */
export interface RestartOptions {
    sessionUuid: string;
    title: string;
    workingDir: string;
    agentType: string;
}

/** How a restart will be performed, as data. */
export interface RestartPlan {
    /** `restart` addresses a stored row; `create_unidentified` cannot. */
    mode: 'restart' | 'create_unidentified';
    /** The durable key, empty in `create_unidentified` mode. */
    sessionUuid: string;
    /** The create body, non-null ONLY in `create_unidentified` mode. */
    payload: Record<string, string> | null;
    /** True exactly when the caller MUST say what could not be determined. */
    mustExplain: boolean;
}

/** The two states that mean "we could not look", never "nothing here". */
const UNAVAILABLE_STATES = ['probe_unavailable', 'never_probed'];

/**
 * The state a payload is claiming, defaulted the SAFE way.
 *
 * Description: an absent or unparseable state reads as `never_probed`,
 *   not as `ok`. Not having been told is not evidence of health, and
 *   defaulting the other way is how an empty list gets presented as an
 *   empty history.
 * Inputs: payload - the wire body, or null when nothing was fetched.
 * Output: string - one of the three contract values.
 * Example: stateOf(null)  // 'never_probed'
 */
export function stateOf(payload: RecentSessionsPayload | null | undefined): string {
    const raw = payload && typeof payload.state === 'string' ? payload.state.trim() : '';
    return raw || 'never_probed';
}

/**
 * Decide HOW a restart will be performed, as data.
 *
 * Pure: no network, no DOM, no state read - which is what makes the
 * decision assertable on its own rather than only through its effects.
 *
 * THE BUG THIS SHAPE EXISTS TO KILL. The restart used to be built from
 * `working_dir` and `agent_type` alone. The row's TITLE was never put
 * into the button's markup at all and its `session_uuid` was in the
 * dataset and never passed to the handler, so restarting a session the
 * user had named, and had been talking to for hours, produced an unnamed
 * blank console. It discarded identity the client was already holding.
 *
 * TWO MODES, AND THE SECOND IS NOT A QUIET FALLBACK:
 *
 *   `restart` - a `session_uuid` is known, so the SERVER can read the
 *     stored row and is the only thing that can answer whether there is a
 *     claude conversation to resume (the wire's `SessionRecord` carries
 *     no `claude_session_uuid`, on purpose). The uuid is the whole
 *     payload; the server owns title, directory, agent, model and the
 *     lineage stamp. Sending our own copies would hand it a second,
 *     staler declaration of facts it already holds.
 *
 *   `create_unidentified` - the row carries NO `session_uuid`, so there
 *     is nothing to look up and no conversation link can even be
 *     attempted. A session is still created and `mustExplain` is true so
 *     the caller MUST say what could not be determined. The third
 *     outcome, not a silent degrade to a blank console.
 *
 * Inputs: opts - every field optional and any of them possibly empty.
 * Output: the plan. `payload` is the create body in the second mode.
 * Example: restartPlan({ sessionUuid: 'u1', title: 'Media' }).mode
 *   // 'restart'
 */
export function restartPlan(opts: Partial<RestartOptions> | null | undefined): RestartPlan {
    const o = opts || {};
    const sessionUuid = (o.sessionUuid || '').trim();
    const title = (o.title || '').trim();
    const workingDir = (o.workingDir || '').trim();
    const agentType = (o.agentType || '').trim();
    if (sessionUuid) {
        return { mode: 'restart', sessionUuid, payload: null, mustExplain: false };
    }
    const payload: Record<string, string> = {};
    if (workingDir) payload.working_dir = workingDir;
    if (agentType) payload.agent_type = agentType;
    // THE TITLE TRAVELS EVEN HERE. `project_name` is what names the tmux
    // session, so carrying it is the difference between the replacement
    // wearing the user's own label and wearing a generated handle. It is
    // the one piece of identity this mode CAN carry.
    if (title) payload.project_name = title;
    return { mode: 'create_unidentified', sessionUuid: '', payload, mustExplain: true };
}

/**
 * Resolve one stored row to the strings and flags a row paints.
 *
 * THREE-OUTCOME RESTART GATE, ENFORCED HERE, not only by the server query
 * that populated the row. `GET /sessions/recent` only ever returns
 * `lifecycle='stopped'` rows, and this checks `lifecycle` itself anyway
 * and refuses to offer a restart for anything else. A row whose lifecycle
 * is `unknown` must never offer to restart it: restarting a session whose
 * state could not be confirmed is how you get two of the same session
 * running at once. Belt and braces on purpose - assert every guarantee at
 * the layer that enforces it.
 *
 * Inputs:
 *   row - one stored record.
 *   deriveName - the legacy tmux-name-to-display-name mapping, injected
 *     because it still lives in `launchpad.js` until slice 5.
 *   t - the translator.
 * Output: the row's view.
 * Example: describeRow({ session_uuid: 'u', lifecycle: 'stopped' }, d, t)
 */
export function describeRow(
    row: RecentSessionRecord,
    deriveName: (tmuxName: string) => string | null,
    t: Translate,
): RecentRowView {
    const title = (row.title && String(row.title).trim()) || '';
    // `title` IS THE LABEL NOW, so it leads. It used to sit third in this
    // chain as a last-ditch fallback, which was correct while it was a
    // lineage-seeded string and is exactly backwards once it carries what
    // the user called the session.
    const name = title
        || (row.tmux_name ? deriveName(row.tmux_name) || '' : '')
        || row.working_dir
        || t(RECENT_KEYS.nameFallback);
    const lifecycle = (row.lifecycle && String(row.lifecycle)) || 'unknown';
    const canRestart = lifecycle === 'stopped';
    return {
        uuid: (row.session_uuid && String(row.session_uuid)) || '',
        name,
        lifecycle,
        // A LIFECYCLE WE CANNOT ACT ON IS ECHOED VERBATIM, NOT TRANSLATED.
        // It is a server enum this client does not enumerate, so there is
        // no key to look up and inventing one per unseen value would be a
        // catalog that goes stale the next time the server grows a state.
        // The one value we DO act on gets a real message.
        lifecycleLabel: canRestart ? t(RECENT_KEYS.lifecycleEnded) : lifecycle,
        canRestart,
        archived: !!row.archived_at,
        restart: canRestart
            ? {
                sessionUuid: (row.session_uuid && String(row.session_uuid)) || '',
                title,
                workingDir: (row.working_dir && String(row.working_dir)) || '',
                agentType: (row.agent_type && String(row.agent_type)) || '',
            }
            : null,
    };
}

/**
 * The whole section, as a value.
 *
 * THE THREE-OUTCOME RULE APPLIED TO THE GROUP. `state !== 'ok'` (the
 * probe never ran, or the last one failed) answers `unavailable`, which
 * carries the notice and NO rows - never the stored rows shown as if
 * freshly confirmed, and never a silent empty section indistinguishable
 * from "no history". `state === 'ok'` with zero rows is the ordinary
 * "nothing stopped" case, which HIDES the section, matching the
 * running-sessions convention.
 *
 * THE EXCEPTION IS THE ARCHIVE FILTER, AND IT IS NOT COSMETIC. The
 * show-archived toggle lives in this section's heading, so hiding the
 * section on an empty result would take away the only control that can
 * turn it back off and the user would be looking at a screen with no way
 * to say what it is showing. An empty result with the filter on is also a
 * real answer - "asked for archived rows, there are none" - and it has to
 * be sayable.
 *
 * A SESSION APPEARS IN EXACTLY ONE LIST, and the exclusion is done
 * against the LIVE probe rather than the stored lifecycle, because the
 * two can disagree: a row whose reaper has not run yet still reads
 * `stopped` while its tmux session is plainly in the listing. See
 * ./recent-visibility.ts for why that is keyed on identity and not on the
 * tmux name.
 *
 * Inputs:
 *   payload - the wire body, or null when nothing has been fetched yet.
 *   live - the running sessions, for the one-list-only rule.
 *   showArchived - whether the user asked for archived rows.
 *   deriveName - the legacy display-name mapping.
 *   t - the translator.
 * Output: one of the four views.
 * Example: recentView({ state: 'ok', sessions: [] }, [], false, d, t).kind
 *   // 'hidden'
 */
export function recentView(
    payload: RecentSessionsPayload | null | undefined,
    live: readonly LiveSession[] | null | undefined,
    showArchived: boolean,
    deriveName: (tmuxName: string) => string | null,
    t: Translate,
): RecentView {
    const state = stateOf(payload);
    if (state !== 'ok') {
        return {
            kind: 'unavailable',
            state,
            title: t(RECENT_KEYS.unavailableTitle),
            detail: unavailableDetail(payload ? payload.notice : null, t),
            count: recentCountUnavailableLabel(t),
        };
    }
    const all = (payload && payload.sessions) || [];
    const rows = visibleRecentRows(all, live);
    const count = recentCountLabel(rows.length, t);
    if (rows.length === 0) {
        if (showArchived) {
            return { kind: 'empty', count, message: t(RECENT_KEYS.emptyIncludingArchived) };
        }
        return { kind: 'hidden' };
    }
    return { kind: 'rows', count, rows: rows.map((r) => describeRow(r, deriveName, t)) };
}

/**
 * Is this a state that means "we could not look"?
 *
 * Description: exported so a caller can name the two without repeating
 *   the strings. Anything not in the list, including `ok`, answers false.
 * Inputs: state - a contract value.
 * Output: boolean.
 * Example: isUnavailableState('never_probed')  // true
 */
export function isUnavailableState(state: string): boolean {
    return UNAVAILABLE_STATES.includes(state);
}
