/**
 * The one store the launchpad's session data lives in.
 *
 * SLICE 2 CREATED IT HOLDING THE RECENT SLICE ONLY. SLICE 3 GIVES IT THE
 * REST: the four fetches, the attribution join, the work-stamp index, the
 * three-outcome listing latch and the 5s tick. `client/js/launchpad.js`
 * now holds NO copy of any of it - the instance fields its surviving
 * renderers read are accessor properties delegating here, so there is
 * exactly one data path and a renderer cannot be looking at a stale
 * array while the store holds a fresh one.
 *
 * THE THREE-OUTCOME CONTRACT IS THE WHOLE POINT OF THIS FILE, and it
 * appears five separate times: the recent state, the running-sessions
 * listing, the attribution listing, the projects listing and the archived
 * dimension. It is written out five times deliberately - a shared
 * `Result<T>` here would be five imports and one more thing to learn for
 * no deleted line, and the five differ in what their third outcome
 * MEANS. Not one of them may collapse into two: a fetch that did not
 * answer must never render as a measured empty list, because the console
 * telling the truth while the screen renders a dead tmux server as a
 * healthy machine with zero sessions is the exact failure this app has
 * already paid for.
 *
 * EXPORTED AS AN OBJECT WITH ACCESSORS, never as the runes themselves. A
 * `$state` exported by value is read once at import and never again, so
 * every consumer would hold a dead snapshot; a getter re-reads it inside
 * the caller's own effect and stays reactive across the module boundary.
 *
 * NOTHING HERE RUNS AT IMPORT TIME. No global is read, no timer is
 * started, no fetch is issued. `main.ts` promises that loading the bundle
 * does no work, and a module-scope `localStorage` read has already broken
 * that contract once and taken an unrelated node test with it.
 *
 * THE COPY IS NOT IN THIS FILE. Every sentence this layer can print is
 * assembled by `client/js/labels/session-listing.js` from the catalog.
 */
import {
    attributionFailedDetail,
    listingDetail,
    projectsLoadFailed,
    recordsMalformedDetail,
    sessionsMalformedDetail,
} from '../../../../client/js/labels/session-listing.js';
import { loadFailedNotice } from '../../../../client/js/labels/recent-session.js';
import type { RecentSessionsPayload, Translate as RecentTranslate } from '../launchpad/recent';
import { loadAttribution, sortRunningSessionsByWork } from './attribution';
import { hostWindow } from './env';
import { browserSessionHost, type SessionHost } from './host';
import { emptyListing, listingReasonFromError, statusFromError } from './listing';
import { createPoller, type Poller, type PollerDeps } from './poller';
import { loadRunningRows } from './running';
import type {
    ListingState,
    ProjectAuthority,
    ProjectPresenceRow,
    ProjectRow,
    RunningSessionRow,
    SessionRecord,
    Translate,
} from './types';

/**
 * Tell the auth layer a 401 was seen.
 *
 * Description: `api.js` already dispatches `auth-required` on a 401 after
 *   a refresh fails, so this is DEFENCE IN DEPTH and nothing downstream
 *   depends on it. It is wrapped because a realm without `CustomEvent`
 *   must not be able to lose the listing verdict that is the actual
 *   answer; the swallow is deliberate and logged.
 * Inputs: none. Output: void.
 * Example: dispatchReauthNeeded()
 */
function dispatchReauthNeeded(): void {
    const w = hostWindow();
    if (!w) return;
    try {
        w.dispatchEvent(new CustomEvent('cloude:reauth-needed', {
            detail: { source: 'CloudeWeb.loadRunningSessions' },
        }));
    } catch (dispatchError) {
        console.warn('CloudeWeb: could not dispatch reauth event:', dispatchError);
    }
}

// ---- the held state --------------------------------------------------

/** The last `GET /sessions/recent` body. null reads as `never_probed`. */
let recentPayload = $state<RecentSessionsPayload | null>(null);
/** True while a recent refresh is in flight. Diagnostic; nothing gates on it. */
let recentInFlight = $state(false);
/** `GET /projects`. */
let projects = $state<ProjectRow[]>([]);
/** null = never asked, true = read, false = the fetch failed. */
let projectsListingOk = $state<boolean | null>(null);
/** null = archived rows were not asked for, so this build has no opinion. */
let archivedFetchOk = $state<boolean | null>(null);
/** `GET /projects/authority`. null renders as CANNOT DETERMINE, never healthy. */
let projectAuthority = $state<ProjectAuthority | null>(null);
/** `GET /projects/presence`, keyed by raw config path AND by normalised root. */
let projectPresence = $state<Map<string, ProjectPresenceRow>>(new Map());
/** The merged running-session rows, dead panes already dropped. */
let runningSessions = $state<RunningSessionRow[]>([]);
/** This tick's verdict on the two session probes. */
let runningSessionsListing = $state<ListingState>(emptyListing());
/** Name-only attribution fallback. NEVER holds an archived row. */
let sessionAttribution = $state<Map<string, SessionRecord>>(new Map());
/** Instance-exact attribution. DOES hold archived rows, on purpose. */
let sessionAttributionByInstance = $state<Map<string, SessionRecord>>(new Map());
/** Names that could not be ranked. A refusal, never a silent pick. */
let sessionAttributionAmbiguous = $state<Set<string>>(new Set());
/** Three-outcome latch for the whole `GET /sessions/records` fetch. */
let sessionAttributionListingOk = $state(true);
/** Why it could not be read. Never rendered as "no project". */
let sessionAttributionListingDetail = $state<string | null>(null);
/** The same payload as a flat list: the tree needs the rows tmux cannot name. */
let sessionRecords = $state<SessionRecord[]>([]);
/** tmux name to newest `last_work_at`. An absent name means UNRECORDED. */
let workStampByName = $state<Map<string, string>>(new Map());

/** The one poller. Built on first `startPolling`, cleared by `stopPolling`. */
let poller: Poller | null = null;

/**
 * The host, resolved once on first use.
 *
 * Description: LAZY, not module-scope. See the file header - reading
 *   `window` at import time is the defect this tree already shipped once.
 */
let host: SessionHost | null = null;

/** The host in use, building the browser one on first call. */
function activeHost(): SessionHost {
    if (!host) host = browserSessionHost();
    return host;
}

// ---- the store -------------------------------------------------------

/** The launchpad's session data, as both trees read it. */
export const sessionStore = {
    /** The last recent-sessions body, or null before the first fetch. */
    get recentPayload(): RecentSessionsPayload | null { return recentPayload; },
    /** Whether a recent-sessions fetch is in flight right now. */
    get recentInFlight(): boolean { return recentInFlight; },
    /** `GET /projects`, as the tree and the pickers read it. */
    get projects(): ProjectRow[] { return projects; },
    set projects(value: ProjectRow[]) { projects = value; },
    /** Three outcomes: null not asked, true read, false the fetch failed. */
    get projectsListingOk(): boolean | null { return projectsListingOk; },
    set projectsListingOk(value: boolean | null) { projectsListingOk = value; },
    /** Three outcomes for the archived dimension specifically. */
    get archivedFetchOk(): boolean | null { return archivedFetchOk; },
    set archivedFetchOk(value: boolean | null) { archivedFetchOk = value; },
    /** The provenance report. null is CANNOT DETERMINE, never healthy. */
    get projectAuthority(): ProjectAuthority | null { return projectAuthority; },
    set projectAuthority(value: ProjectAuthority | null) { projectAuthority = value; },
    /** Presence per project, by raw config path and by normalised root. */
    get projectPresence(): Map<string, ProjectPresenceRow> { return projectPresence; },
    set projectPresence(value: Map<string, ProjectPresenceRow>) { projectPresence = value; },
    /** The merged running rows, measured-dead already dropped. */
    get runningSessions(): RunningSessionRow[] { return runningSessions; },
    set runningSessions(value: RunningSessionRow[]) { runningSessions = value; },
    /** This tick's probe verdict. `ok:false` routes to NEEDS ATTENTION. */
    get runningSessionsListing(): ListingState { return runningSessionsListing; },
    set runningSessionsListing(value: ListingState) { runningSessionsListing = value; },
    /** The name-only join rung. */
    get sessionAttribution(): Map<string, SessionRecord> { return sessionAttribution; },
    set sessionAttribution(value: Map<string, SessionRecord>) { sessionAttribution = value; },
    /** The instance-exact join rung. */
    get sessionAttributionByInstance(): Map<string, SessionRecord> {
        return sessionAttributionByInstance;
    },
    set sessionAttributionByInstance(value: Map<string, SessionRecord>) {
        sessionAttributionByInstance = value;
    },
    /** Names that could not be ranked. NEEDS ATTENTION, never "no project". */
    get sessionAttributionAmbiguous(): Set<string> { return sessionAttributionAmbiguous; },
    set sessionAttributionAmbiguous(value: Set<string>) { sessionAttributionAmbiguous = value; },
    /** Whether the records fetch answered at all. */
    get sessionAttributionListingOk(): boolean { return sessionAttributionListingOk; },
    set sessionAttributionListingOk(value: boolean) { sessionAttributionListingOk = value; },
    /** Why it did not. */
    get sessionAttributionListingDetail(): string | null {
        return sessionAttributionListingDetail;
    },
    set sessionAttributionListingDetail(value: string | null) {
        sessionAttributionListingDetail = value;
    },
    /** The raw records, for the rows whose tmux session is GONE. */
    get sessionRecords(): SessionRecord[] { return sessionRecords; },
    set sessionRecords(value: SessionRecord[]) { sessionRecords = value; },
    /** The work-stamp index the ordering reads. */
    get workStampByName(): Map<string, string> { return workStampByName; },
    set workStampByName(value: Map<string, string>) { workStampByName = value; },
    /** Whether the 5s tick is running. */
    get polling(): boolean { return !!poller && poller.running; },

    /**
     * Replace the endpoints this store reads. For tests only.
     *
     * Description: passing null restores the browser host, so one test
     *   cannot leak its stub into the next.
     * Inputs: next - a host, or null. Output: void.
     * Example: sessionStore.useHost(fakeHost)
     */
    useHost(next: SessionHost | null): void {
        host = next;
    },

    /**
     * Fetch the RECENT group and record it, contract intact.
     *
     * Description: datastore-backed, NOT a live tmux probe - the one
     *   launcher surface that reads stored history rather than re-asking
     *   tmux. Failure is non-fatal and is RECORDED AS A STATE, never as
     *   an absence: a rejected fetch writes `probe_unavailable` plus a
     *   notice naming the reason, so the section renders its
     *   cannot-determine block. Clearing the payload instead would render
     *   as `never_probed` with no notice, which is a different and
     *   quieter lie.
     *
     *   THE ARCHIVE FLAG IS PASSED. It was not, once, and that was the
     *   whole defect: the endpoint, the query parameter and the API
     *   wrapper's argument all existed and no caller ever set it.
     * Inputs: fetchRecent, includeArchived, t.
     * Output: Promise<void>. Never rejects.
     * Example: await sessionStore.refreshRecent(host.fetchRecent, false, t);
     */
    async refreshRecent(
        fetchRecent: (includeArchived: boolean) => Promise<RecentSessionsPayload>,
        includeArchived: boolean,
        t: RecentTranslate,
    ): Promise<void> {
        recentInFlight = true;
        try {
            const payload = await fetchRecent(!!includeArchived);
            recentPayload = {
                // A body with no `state` is NOT assumed healthy. This
                // mirrors the legacy default exactly: an answer that did
                // not say reads as a probe that did not answer.
                state: (payload && payload.state) || 'probe_unavailable',
                sessions: (payload && payload.sessions) || [],
                notice: (payload && payload.notice) || null,
            };
        } catch (error) {
            console.warn('CloudeWeb: failed to load recent sessions:', error);
            recentPayload = {
                state: 'probe_unavailable',
                sessions: [],
                notice: loadFailedNotice(error, t),
            };
        } finally {
            recentInFlight = false;
        }
    },

    /**
     * Fetch which source the project list came from.
     *
     * Description: non-fatal, and its failure is its OWN state rather
     *   than an assumption of health. A failed fetch sets the authority
     *   to null, which the banner renders as "could not determine which
     *   source is authoritative" - never as the healthy `db` mode.
     *   Assuming health here would reintroduce the exact false green the
     *   authority endpoint exists to expose.
     * Inputs: none. Output: Promise<void>. Never rejects.
     * Example: await sessionStore.loadProjectAuthority()
     */
    async loadProjectAuthority(): Promise<void> {
        try {
            projectAuthority = await activeHost().getProjectsAuthority();
        } catch (error) {
            console.warn('CloudeWeb: failed to load project authority:', error);
            projectAuthority = null;
        }
    },

    /**
     * Fetch live filesystem presence for every DB-tracked project.
     *
     * Description: non-fatal. A failed fetch leaves the map EMPTY rather
     *   than throwing, so every project renders as 'unchecked' - normal,
     *   actions allowed - rather than the whole launchpad erroring out
     *   over a presence sidecar. That is a deliberate choice not to
     *   invent a worse verdict than "could not ask": failing to LOAD
     *   presence is not evidence anything is missing or unreachable.
     *
     *   INDEXED TWICE, by `raw_path` and by `root`. `GET /projects` now
     *   returns the normalised root as a project's identity; indexing by
     *   `raw_path` alone made the badge miss whenever the two spellings
     *   differed, which on this owner's box is most of them.
     * Inputs: none. Output: Promise<void>. Never rejects.
     * Example: await sessionStore.loadProjectPresence()
     */
    async loadProjectPresence(): Promise<void> {
        // BUILT INTO A LOCAL AND ASSIGNED ONCE. The legacy method cleared
        // the field first and then filled it, which a rune consumer would
        // see as two states; one assignment at the end is the same
        // observable outcome, including on the failure path, where what
        // lands is the empty map the legacy clear left behind.
        const next = new Map<string, ProjectPresenceRow>();
        try {
            const result = await activeHost().getProjectsPresence();
            if (result && result.status === 'ok' && Array.isArray(result.projects)) {
                for (const row of result.projects) {
                    if (row && row.raw_path) next.set(row.raw_path, row);
                    if (row && row.root) next.set(row.root, row);
                }
            }
        } catch (error) {
            console.warn('CloudeWeb: failed to load project presence:', error);
        }
        projectPresence = next;
    },

    /**
     * Fetch the project list, and both sidecars, before the first paint.
     *
     * Description: presence and authority are BOTH awaited before this
     *   resolves so neither a missing project nor a degraded datastore
     *   flashes as normal for one frame - the tree reads all three
     *   synchronously when it paints.
     *
     *   ONLY A FETCH THAT ASKED FOR ARCHIVED ROWS MAY REPORT ON THEM.
     *   With the toggle off `archivedFetchOk` stays null - "not asked" -
     *   so the UI never renders "no archived projects" off the back of a
     *   request that excluded them by construction. On failure it latches
     *   false only if we actually asked.
     * Inputs: includeArchived - the toggle as it stands right now.
     *   t - the translator, for the failure sentence only.
     * Output: Promise with `ok` and, on failure, the message to show.
     *   NEVER REJECTS: the caller decides what to paint.
     * Example: const r = await sessionStore.loadProjects(false, t);
     */
    async loadProjects(
        includeArchived: boolean,
        t: Translate,
    ): Promise<{ ok: boolean; error: string | null }> {
        try {
            projects = await activeHost().getProjects(includeArchived);
            projectsListingOk = true;
            archivedFetchOk = includeArchived ? true : null;
            await Promise.all([
                this.loadProjectPresence(),
                this.loadProjectAuthority(),
            ]);
            return { ok: true, error: null };
        } catch (error) {
            projectsListingOk = false;
            // The archived rows were part of THIS failed fetch, so their
            // outcome is "could not evaluate", not "none".
            archivedFetchOk = includeArchived ? false : null;
            console.error('CloudeWeb: failed to load projects:', error);
            return { ok: false, error: projectsLoadFailed(error, t) };
        }
    },

    /**
     * Fetch the stored session records: the join, the work index, the latch.
     *
     * Description: one fetch feeds two things - which project each
     *   running row belongs to, and the `last_work_at` the list is
     *   ORDERED by - which is why the caller must run it BEFORE it sorts.
     *   The rules live in `attribution.ts`; this assigns the result as
     *   one atomic snapshot so no reader can ever see a fresh join beside
     *   a stale work index.
     * Inputs: t - the translator, for the two failure sentences.
     * Output: Promise<void>. Never rejects.
     * Example: await sessionStore.loadSessionAttribution(t)
     */
    async loadSessionAttribution(t: Translate): Promise<void> {
        const snap = await loadAttribution(
            activeHost(), t, recordsMalformedDetail, attributionFailedDetail,
        );
        sessionAttribution = snap.byName;
        sessionAttributionByInstance = snap.byInstance;
        sessionAttributionAmbiguous = snap.ambiguous;
        sessionRecords = snap.records;
        workStampByName = snap.workStamps;
        sessionAttributionListingOk = snap.listingOk;
        sessionAttributionListingDetail = snap.listingDetail;
    },

    /**
     * Fetch the unified running-sessions list.
     *
     * Description: the two-endpoint merge, the dead-pane filter and the
     *   three-outcome verdict all live in `running.ts`. What is decided
     *   HERE is the ORDER OF THE LAST THREE STEPS, and it is load
     *   bearing: attribution runs BEFORE the sort, because the same fetch
     *   carries the sort key. Sorting first would order every first paint
     *   by a value that had not arrived, and then never re-sort, because
     *   the sort is not repeated after that call.
     *
     *   The UI flags are ensured and NOT awaited - a feature switch must
     *   never be able to delay the session list.
     * Inputs: t - the translator, for the failure sentences.
     * Output: Promise<void>. Never rejects.
     * Example: await sessionStore.loadRunningSessions(t)
     */
    async loadRunningSessions(t: Translate): Promise<void> {
        // Reset the verdict for this poll tick, so a probe that recovers
        // is not still wearing the previous tick's failure.
        runningSessionsListing = emptyListing();
        // The owner's UI switches, measured once per page load. Memoized
        // onto one promise inside that module, so a poll costs nothing
        // after the first tick. `session-sidebar-fetch.js` makes the same
        // call, because either surface may be the first one a page load
        // reaches. See client/js/ui-flags.js.
        // Read off `window`, not `globalThis`, and through `hostWindow`
        // so a realm with no window answers rather than throwing. See
        // ./env.ts for both measurements behind that.
        const flags = (hostWindow() as unknown as {
            UIFlags?: { ensure?: unknown };
        } | undefined)?.UIFlags;
        if (flags && typeof flags.ensure === 'function') {
            (flags.ensure as () => void)();
        }
        const { rows, listing } = await loadRunningRows({
            host: activeHost(),
            t,
            malformedDetail: sessionsMalformedDetail,
            detailFor: listingDetail,
            reasonFor: listingReasonFromError,
            statusFor: statusFromError,
            onReauth: dispatchReauthNeeded,
        });
        runningSessionsListing = listing;
        runningSessions = rows;
        await this.loadSessionAttribution(t);
        runningSessions = sortRunningSessionsByWork(rows.slice(), workStampByName);
    },

    /**
     * Start the single 5s tick, WITH the teardown launchpad.js never had.
     *
     * Description: idempotent. The two gates - signed in, and the
     *   launchpad screen still active - live in `poller.ts` and default
     *   to the same globals the legacy tick read.
     * Inputs: deps - at minimum `{ tick }`. Output: void.
     * Example: sessionStore.startPolling({ tick: () => refresh() })
     */
    startPolling(deps: PollerDeps): void {
        if (!poller) poller = createPoller(deps);
        poller.start();
    },

    /**
     * Stop the tick and clear its interval.
     *
     * Description: THE LINE `client/js/launchpad.js` NEVER HAD. Idempotent,
     *   and it forgets the poller so a later `startPolling` builds a fresh
     *   one against whatever tick that caller wants.
     * Inputs: none. Output: void.
     * Example: sessionStore.stopPolling()
     */
    stopPolling(): void {
        if (!poller) return;
        poller.stop();
        poller = null;
    },

    /**
     * Drop every held fetch.
     *
     * Description: for a test, and for a caller tearing the screen down.
     *   The recent payload goes back to null, which reads as
     *   `never_probed` and NOT as an empty `ok`; the listing latches go
     *   back to their never-asked values for the same reason. It also
     *   stops the tick, because a cleared store that kept polling would
     *   refill itself a moment later.
     * Inputs: none. Output: void.
     * Example: sessionStore.reset()
     */
    reset(): void {
        this.stopPolling();
        recentPayload = null;
        recentInFlight = false;
        projects = [];
        projectsListingOk = null;
        archivedFetchOk = null;
        projectAuthority = null;
        projectPresence = new Map();
        runningSessions = [];
        runningSessionsListing = emptyListing();
        sessionAttribution = new Map();
        sessionAttributionByInstance = new Map();
        sessionAttributionAmbiguous = new Set();
        sessionAttributionListingOk = true;
        sessionAttributionListingDetail = null;
        sessionRecords = [];
        workStampByName = new Map();
        host = null;
    },
};
