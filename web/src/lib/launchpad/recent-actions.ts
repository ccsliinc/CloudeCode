/**
 * The three things a RECENT row can do, and the seam they reach through.
 *
 * PORTED FROM `Launchpad._deleteSessionRecord`, `_forkSession` and
 * `_restartRecentSession`, deleted in the same commit. Two of the three
 * have callers OUTSIDE this section - the project tree's ended rows
 * archive and restart, the running-sessions row forks - and those are
 * slices 4 and 5. They are NOT left behind as a second copy: the
 * implementation is here and the two remaining legacy call sites call
 * these by name through `window.CloudeWeb.launchpad`. One behaviour, one
 * greppable call site, no dual path.
 *
 * WHY THE HOST IS INJECTED. These talk to globals the legacy tree
 * publishes (`window.API`, `window.Launchpad`) and to the store, and none
 * of them exists in a test process. :func:`browserHost` resolves them at
 * CALL TIME, so the browser gets the real ones and a test hands in a
 * recorder. A seam, not an adapter layer: no response is reshaped and no
 * endpoint is wrapped.
 *
 * ARCHIVING IS NOT DESTROYING, AND THAT IS WHY THERE IS NO CONFIRM.
 * `DELETE /sessions/records/{uuid}` stamps `archived_at` server-side and
 * the row keeps every column it had, which is why an archived
 * conversation can still be opened, grouped and restarted. Nothing is
 * destroyed and the row is retained, and this app has a standing rule
 * that confirm copy must name real consequences: a dialog warning about
 * nothing teaches people to click through the ones that matter. The X on
 * a RUNNING row is the different verb, and it keeps its confirm.
 *
 * EVERY ONE REFRESHES BOTH SURFACES, not just the one clicked. Archiving
 * from RECENT while the project tree still showed the row would recreate
 * the exact contradiction this whole area was repaired to remove.
 */
import {
    forkFailureNotice,
    RECENT_KEYS,
    reasonOf,
    restartNotice,
    unidentifiedRestartNotice,
} from '../../../../client/js/labels/recent-session.js';
import {
    restartPlan,
    type RecentSessionsPayload,
    type RestartOptions,
    type Translate,
} from './recent';
import type { LiveSession } from './recent-visibility';

/** The `POST /sessions/{name}/fork` body, as much as is read. */
export interface ForkResponse {
    /** False when the fork works but its parent link did not land. */
    lineage_recorded?: boolean;
    /** The server's own sentence about that, preferred when present. */
    detail?: string | null;
}

/** The `RestartSessionResponse` body, as much as is read. */
export interface RestartResponse {
    /** `resumed` | `none_recorded` | `unknown`. Never collapsed to two. */
    conversation?: string | null;
    /** The label the replacement came back wearing. */
    title_carried?: string | null;
    /** False when the conversation resumed but the row could not be kept. */
    row_reused?: boolean;
    detail?: string | null;
}

/** Everything outside this module that the RECENT section reaches. */
export interface RecentHost {
    /** `GET /sessions/recent`, with the archive filter as it stands. */
    fetchRecent(includeArchived: boolean): Promise<RecentSessionsPayload>;
    /** `DELETE /sessions/records/{uuid}`. A soft archive, never a delete. */
    archiveRecord(sessionUuid: string): Promise<unknown>;
    /** `POST /sessions/{name}/fork`. */
    fork(tmuxName: string): Promise<ForkResponse>;
    /** `POST /sessions/restart`, addressed by the durable uuid. */
    restart(sessionUuid: string): Promise<RestartResponse>;
    /** `POST /sessions`, for a row that carries no uuid to look up. */
    createSession(payload: Record<string, string>): Promise<unknown>;
    /** The launchpad's inline, non-blocking error line. */
    showError(message: string): void;
    /** Re-read this section after an action changed it. */
    refreshRecent(): Promise<void>;
    /** Re-read the live sessions, so a restart's new one appears. */
    refreshRunningSessions(): Promise<void>;
    /** Re-read the attribution join behind the project tree. */
    refreshAttribution(): Promise<void>;
    /**
     * The live sessions, for the one-list-only rule.
     *
     * ANSWERING `[]` IS NOT A HARMLESS DEGRADE, which is what made this
     * worth chasing. `visibleRecentRows` short-circuits on
     * `if (!live.length) return rows.slice()`, so an empty answer does
     * not filter conservatively - it switches the de-duplication OFF
     * entirely and paints every running session a second time under
     * RECENT.
     */
    liveSessions(): LiveSession[];
    /** The legacy tmux-name-to-display-name mapping (slice 5 moves it). */
    deriveDisplayName(tmuxName: string): string | null;
}

/**
 * Archive one stored session from every listing, keeping the record.
 *
 * Description: the ONE handler behind every archive control on this
 *   screen. RECENT rows and the project tree's ended rows both route
 *   here, so the two cannot drift into meaning different things, which
 *   is the class of bug this area was repaired for.
 * Inputs: sessionUuid - the stored row's durable key. host, t.
 * Output: Promise<void>. Failure is reported inline, never thrown.
 * Example: await archiveSessionRecord('a1b2-c3', host, t);
 */
export async function archiveSessionRecord(
    sessionUuid: string | null | undefined,
    host: RecentHost,
    t: Translate,
): Promise<void> {
    if (!sessionUuid) {
        // No id means we do not know WHICH row was asked for, and an
        // archive aimed at nothing must say so rather than quietly doing
        // nothing and looking like it worked.
        host.showError(t(RECENT_KEYS.archiveFailedNoId));
        return;
    }
    try {
        await host.archiveRecord(sessionUuid);
    } catch (error) {
        console.error('CloudeWeb: archive of session record failed:', error);
        host.showError(t(RECENT_KEYS.archiveFailed, { reason: reasonOf(error, t) }));
        return;
    }
    await host.refreshAttribution();
    await host.refreshRecent();
}

/**
 * Fork a running session into a new one branching its claude conversation.
 *
 * Description: THE PARENT IS NOT CHANGED BY THIS. It keeps running, stays
 *   listed, stays resumable and can be forked again - there is no "was
 *   forked from" state anywhere, because the process was never touched.
 *
 *   THREE OUTCOMES ARE SURFACED, NOT TWO. A 409 means the session has no
 *   recorded claude conversation to resume, which is a REFUSAL and is
 *   reported as one: forking anyway would start a brand new conversation
 *   wearing a fork label and the user would believe they had branched
 *   their work. And a fork that succeeds while its parent link fails to
 *   land says so, rather than claiming a clean success.
 * Inputs: tmuxName - the PARENT's tmux session name. host, t.
 * Output: Promise<void>.
 * Example: await forkSession('cloude_work', host, t);
 */
export async function forkSession(
    tmuxName: string | null | undefined,
    host: RecentHost,
    t: Translate,
): Promise<void> {
    if (!tmuxName) {
        host.showError(t(RECENT_KEYS.forkFailedNoName));
        return;
    }
    let result: ForkResponse;
    try {
        result = await host.fork(tmuxName);
    } catch (error) {
        console.error('CloudeWeb: fork failed:', error);
        host.showError(forkFailureNotice(error, t));
        return;
    }
    if (result && result.lineage_recorded === false) {
        // Not an error and not a clean success. Say exactly what is true:
        // the fork exists and works, the link did not land. The server's
        // own detail wins, because it can name what it could not record.
        const detail = typeof result.detail === 'string' ? result.detail.trim() : '';
        host.showError(detail || t(RECENT_KEYS.forkLineageUnrecorded));
    }
    await host.refreshAttribution();
    await host.refreshRecent();
}

/**
 * Restart a stopped session, carrying everything it already knew.
 *
 * WHAT THIS IS AND IS NOT. It is NOT a resurrection: the old tmux
 * session's pane is gone and the replacement necessarily gets a new
 * `#{session_created}`, so the identity triple can never match the old
 * row and is not made to. (`POST /sessions/respawn` is the other verb: it
 * puts a process back into a session that still EXISTS.) Creating fresh
 * is the correct ACTION here. What was wrong before was throwing away the
 * title and the conversation link while doing it.
 *
 * Inputs: opts - {sessionUuid, title, workingDir, agentType}. host, t.
 * Output: Promise<void>.
 * Example: await restartRecentSession({ sessionUuid: 'u1' }, host, t);
 */
export async function restartRecentSession(
    opts: Partial<RestartOptions> | null | undefined,
    host: RecentHost,
    t: Translate,
): Promise<void> {
    const plan = restartPlan(opts);
    try {
        if (plan.mode === 'restart') {
            const result = await host.restart(plan.sessionUuid);
            const notice = restartNotice(result, t);
            if (notice) host.showError(notice);
        } else {
            await host.createSession(plan.payload || {});
            // `mustExplain` is true for exactly this mode, and the notice
            // is built from the row's own title rather than from a
            // fragment glued into a sentence.
            if (plan.mustExplain) {
                host.showError(unidentifiedRestartNotice((opts && opts.title) || '', t));
            }
        }
        await host.refreshRunningSessions();
        await host.refreshRecent();
    } catch (error) {
        console.error('CloudeWeb: restart of recent session failed:', error);
        host.showError(t(RECENT_KEYS.restartFailed, { reason: reasonOf(error, t) }));
    }
}

/** The legacy globals this section reaches, as much as it uses. */
interface LegacyApi {
    listRecentSessions(includeArchived?: boolean): Promise<RecentSessionsPayload>;
    deleteSessionRecord(sessionUuid: string): Promise<unknown>;
    forkSession(tmuxName: string): Promise<ForkResponse>;
    restartSession(sessionUuid: string): Promise<RestartResponse>;
    createSession(params?: Record<string, string>): Promise<unknown>;
}

/** The launchpad singleton, as much of it as this section reaches. */
interface LegacyLaunchpad {
    showError?(message: string): void;
    loadRunningSessions?(): Promise<void>;
    _deriveRunningSessionDisplayName?(tmuxName: string): string | null;
}

/**
 * This bundle's own namespace, as much of it as this section reaches.
 *
 * READ RATHER THAN IMPORTED, and that is this module's stated invariant
 * rather than an oversight: "this module never imports the store and the
 * store never imports this". `nav-host.ts` reaches the same two fields
 * the same way, so this is the established shape on this screen and not
 * a new one.
 */
interface WebNamespace {
    launchpad?: {
        sessions?: { runningSessions?: LiveSession[] };
        loadSessionAttribution?: () => Promise<unknown>;
    };
}

/**
 * The real host: the legacy globals, resolved at CALL time.
 *
 * Description: every lookup happens inside the method, not when this is
 *   built, because `window.API` and `window.Launchpad` are published by
 *   classic scripts whose load order relative to a mount is not something
 *   this tree gets to assume. A missing global is treated the way the
 *   legacy code treated one - the action reports rather than throwing -
 *   which keeps a half-booted page from turning a click into a stack
 *   trace nobody sees.
 *
 *   `refreshRecent` IS INJECTED RATHER THAN CALLED FROM HERE, so this
 *   module never imports the store and the store never imports this. The
 *   component owns that wiring, which is the one place that already knows
 *   about both.
 * Inputs: refreshRecent - how to re-read this section after an action.
 * Output: a RecentHost bound to the page.
 * Example: const host = browserHost(() => store.refreshRecent(...));
 */
export function browserHost(refreshRecent: () => Promise<void>): RecentHost {
    const api = (): LegacyApi => (window as unknown as { API: LegacyApi }).API;
    const lp = (): LegacyLaunchpad =>
        (window as unknown as { Launchpad?: LegacyLaunchpad }).Launchpad || {};
    const web = (): WebNamespace =>
        (window as unknown as { CloudeWeb?: WebNamespace }).CloudeWeb || {};
    return {
        fetchRecent: (includeArchived) => api().listRecentSessions(includeArchived),
        archiveRecord: (uuid) => api().deleteSessionRecord(uuid),
        fork: (name) => api().forkSession(name),
        restart: (uuid) => api().restartSession(uuid),
        createSession: (payload) => api().createSession(payload),
        showError(message: string): void {
            const target = lp();
            if (typeof target.showError === 'function') {
                target.showError(message);
                return;
            }
            // The inline error line is a legacy surface. When it is not
            // there yet the message must still go SOMEWHERE loud rather
            // than being dropped, because the messages this reports are
            // the three-outcome ones nobody may lose.
            console.error('CloudeWeb: no error surface for:', message);
        },
        refreshRecent,
        async refreshRunningSessions(): Promise<void> {
            const target = lp();
            if (typeof target.loadRunningSessions === 'function') {
                await target.loadRunningSessions();
            }
        },
        // THE COMPILED PATH, NOT THE RETIRED LEGACY METHOD. This asked
        // `window.Launchpad.loadSessionAttribution`, which `shim.ts`
        // never republished, so the guard always refused and the project
        // tree kept rendering the `sessionRecords` it already had after
        // an archive or a fork. `main.ts` publishes the real one on
        // `CloudeWeb.launchpad` for exactly this caller.
        async refreshAttribution(): Promise<void> {
            const load = web().launchpad?.loadSessionAttribution;
            if (typeof load === 'function') await load();
        },
        // `refreshProjectList` IS GONE, AND THE PAINT IS NOT MISSING -
        // IT IS AUTOMATIC. `renderProjectList()` was the legacy
        // imperative repaint, and the tree it repainted is now
        // `ProjectTree.svelte`, whose groups are a `$derived` over seven
        // `sessionStore` accessors ("one `$derived` subscribing to all of
        // them rather than a render call somebody has to remember to
        // make"). So the store assignment inside `refreshAttribution`
        // above IS the repaint, and a forwarder would be a second way to
        // ask for something that already happened. This deletion is only
        // correct BECAUSE that data refresh survives: the paint follows
        // the data, and dropping both would have left the tree stale.
        liveSessions(): LiveSession[] {
            const rows = web().launchpad?.sessions?.runningSessions;
            return Array.isArray(rows) ? rows : [];
        },
        deriveDisplayName(tmuxName: string): string | null {
            const target = lp();
            if (typeof target._deriveRunningSessionDisplayName === 'function') {
                return target._deriveRunningSessionDisplayName(tmuxName);
            }
            // NOT a guess at the mapping. The deriver strips the `cloude_`
            // prefix and un-slugs the rest, and reimplementing that here
            // would be a second spelling of one rule; slice 5 moves it.
            // Until then, absent means the next rung of the name ladder
            // answers, which is the working directory.
            return null;
        },
    };
}
