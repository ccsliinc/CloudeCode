/**
 * The wire shapes the launchpad's session data layer reads.
 *
 * THE NESTING IS THE POINT, AND IT IS WHY THESE ARE TYPES AT ALL.
 * `GET /sessions/list` answers `SessionInfo`, whose fields sit on TWO
 * LEVELS: `activity_status`, `unread`, `startup_gate`, `status_source`,
 * `label` and the rest of the display record live on the WRAPPER, while
 * `id`, `working_dir` and `pty_pid` live on the nested `.session`.
 * Reading `info.id` gives `undefined` silently and looks exactly like a
 * backend that did not send it, which CLAUDE.md names as this project's
 * single most repeated bug. `SessionListItem` keeps the nesting rather
 * than flattening it, so `info.id` is a COMPILE error - the first time
 * that bug is catchable before it reaches a browser.
 *
 * `SessionInfo` CARRIES NO `created_at_epoch`. Only `AttachableSession`
 * does. That asymmetry is load bearing: it is why a live-only row is
 * unshifted with a zero-defaulted epoch in `running.ts` and therefore
 * always takes the name-only rung of the attribution join. The type says
 * so, so nobody has to remember it.
 *
 * These describe the server's JSON, so the naming is the server's
 * snake_case rather than this tree's camelCase. Renaming them here would
 * put a translation layer between the fetch and the merge, and the merge
 * is 274 lines of field-by-field rules that must stay readable against
 * `src/models.py`.
 */

/** The nested half of `SessionInfo` - `Session` in `src/models.py`. */
export interface SessionCore {
    id?: string | null;
    pty_pid?: number | null;
    working_dir?: string | null;
    status?: string | null;
    created_at?: string | null;
    last_activity?: string | null;
    agent_type?: string | null;
    pinned_theme?: string | null;
    tmux_session?: string | null;
    model?: string | null;
}

/**
 * One row of `GET /sessions/list`.
 *
 * Description: the WRAPPER. Everything a row paints reads from here;
 *   only the identity fields come off `.session`.
 */
export interface SessionListItem {
    session?: SessionCore | null;
    /** Only ever the server's own bulk tmux verdict. Never fabricated. */
    activity_status?: string | null;
    unread?: boolean | null;
    startup_gate?: string | null;
    status_source?: string | null;
    tmux_session?: string | null;
    agent_type?: string | null;
    agent_family?: string | null;
    agent_family_source?: string | null;
    agent_wrapper_label?: string | null;
    pinned_theme?: string | null;
    session_backend?: string | null;
    session_row_id?: number | null;
    parent_session_id?: string | null;
    label?: string | null;
    created_by_cloude?: boolean | null;
    /**
     * NOT ON `SessionInfo`. Present so the merge can read it without a
     * cast when a back-compat single-session server answers something
     * richer; it is `undefined` on every real `/sessions/list` row, which
     * is exactly what makes the zero default fire.
     */
    created_at_epoch?: number | null;
    id?: string | null;
}

/** One row of `GET /sessions/attachable` - `AttachableSession`. Flat. */
export interface AttachableSession {
    name: string;
    label?: string | null;
    created_by_cloude?: boolean | null;
    created_at_epoch?: number | null;
    window_count?: number | null;
    agent_type?: string | null;
    agent_family?: string | null;
    agent_family_source?: string | null;
    agent_wrapper_label?: string | null;
    pinned_theme?: string | null;
    session_row_id?: number | null;
    parent_session_id?: string | null;
    /** Note the field is `status`, NOT `activity_status`. */
    status?: string | null;
    unread?: boolean | null;
    listing_ok?: boolean | null;
    listing_reason?: string | null;
}

/**
 * A merged running-session row, as the launchpad's renderers read it.
 *
 * Description: starts as an `AttachableSession` and is overwritten field
 *   by field from the live `/sessions/list` row, or is built whole when
 *   the session is live-only. Deliberately permissive: `startup_gate` may
 *   be genuinely absent (the server sent nothing) and the renderer
 *   normalises that to `unknown`, which is a DIFFERENT outcome from a
 *   sent `unknown`.
 */
export interface RunningSessionRow extends AttachableSession {
    is_active?: boolean;
    session_id?: string | null;
    startup_gate?: string | null;
    status_source?: string | null;
}

/** One row of `GET /sessions/records` - `SessionRecord`. */
export interface SessionRecord {
    session_uuid?: string | null;
    id?: number | null;
    tmux_name?: string | null;
    tmux_created_epoch?: number | null;
    lifecycle?: string | null;
    project_id?: number | null;
    project_attribution?: string | null;
    working_dir?: string | null;
    archived_at?: string | null;
    title?: string | null;
    parent_session_id?: string | null;
    last_work_at?: string | null;
    owned?: boolean | null;
    agent_type?: string | null;
    agent_family?: string | null;
    agent_family_source?: string | null;
}

/**
 * The three-outcome latch for one poll tick's session probes.
 *
 * Description: `ok` false is the third outcome - not "no sessions" and
 *   not an error thrown at the caller, but "the row set below is
 *   incomplete and the screen must say so". `sources` names which of the
 *   two fetches did not answer.
 */
export interface ListingState {
    ok: boolean;
    reason: string | null;
    detail: string | null;
    sources: string[];
}

/** `GET /projects/authority` - the provenance report for the project list. */
export interface ProjectAuthority {
    mode?: string | null;
    degraded?: boolean | null;
    writable?: boolean | null;
    message?: string | null;
}

/** One row of `GET /projects/presence`. */
export interface ProjectPresenceRow {
    raw_path?: string | null;
    root?: string | null;
    [key: string]: unknown;
}

/** `GET /projects/presence`. */
export interface ProjectPresencePayload {
    status?: string | null;
    projects?: ProjectPresenceRow[] | null;
}

/** One row of `GET /projects`. Only the fields this layer moves. */
export interface ProjectRow {
    name?: string | null;
    path?: string | null;
    root?: string | null;
    [key: string]: unknown;
}

/** The translator, as every pure module in this tree takes it. */
export type Translate = (key: string, params?: Record<string, unknown> | null) => string;
