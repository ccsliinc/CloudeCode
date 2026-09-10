/**
 * The one store the launchpad's session data lives in.
 *
 * THIS SLICE CREATES IT HOLDING THE RECENT SLICE ONLY, and that is
 * deliberate rather than incomplete. `.claude/notes/svelte-migration-launchpad.md`
 * gives it four fetches, a join, a work-stamp index and a 5s tick; slice 3
 * moves those. Adding fields now for data nothing reads would be a store
 * whose shape nobody has tested, and the migration's own rule is that a
 * slice moves a screen and its data together.
 *
 * WHAT IT ALREADY ENFORCES, THOUGH, IS THE THREE-OUTCOME CONTRACT.
 * `GET /sessions/recent` answers `state` of `ok`, `probe_unavailable` or
 * `never_probed`, and `refreshRecent()` never throws that away: a fetch
 * that REJECTS is recorded as `probe_unavailable` with a notice naming
 * why, not as an empty list. There is no code path in here that can leave
 * `recentPayload` holding `{ state: 'ok', sessions: [] }` because
 * something failed. That is the whole reason the failure branch writes a
 * payload instead of clearing one.
 *
 * EXPORTED AS AN OBJECT WITH ACCESSORS, never as the runes themselves. A
 * `$state` exported by value is read once at import and never again, so
 * every consumer would hold a dead snapshot; a getter re-reads it inside
 * the caller's own effect and stays reactive across the module boundary.
 *
 * IT OWNS NO TIMER YET. Slice 3 brings the 5s poll here, WITH the
 * `clearInterval` on teardown that `launchpad.js` has never had. Until
 * then the legacy poller calls in, exactly as it always did.
 */
import { loadFailedNotice } from '../../../../client/js/labels/recent-session.js';
import type { RecentSessionsPayload, Translate } from '../launchpad/recent';

/**
 * The last `GET /sessions/recent` body.
 *
 * Description: null means nothing has been fetched yet, which
 *   `stateOf()` reads as `never_probed` - not as `ok`. Not having looked
 *   is never evidence there is nothing there.
 */
let recentPayload = $state<RecentSessionsPayload | null>(null);

/** True while a refresh is in flight. Diagnostic; nothing gates on it. */
let recentInFlight = $state(false);

/** The launchpad's session data, as this tree reads it. */
export const sessionStore = {
    /** The last recent-sessions body, or null before the first fetch. */
    get recentPayload(): RecentSessionsPayload | null {
        return recentPayload;
    },

    /** Whether a recent-sessions fetch is in flight right now. */
    get recentInFlight(): boolean {
        return recentInFlight;
    },

    /**
     * Fetch the RECENT group and record it, contract intact.
     *
     * Description: datastore-backed, NOT a live tmux probe - this is the
     *   one launcher surface that reads stored history rather than
     *   re-asking tmux. Failure is non-fatal and is RECORDED AS A STATE,
     *   never as an absence: a rejected fetch writes `probe_unavailable`
     *   plus a notice naming the reason, so the section renders its
     *   cannot-determine block. Clearing the payload instead would render
     *   as `never_probed` with no notice, which is a different and
     *   quieter lie.
     *
     *   THE ARCHIVE FLAG IS PASSED. It was not, once, and that was the
     *   whole defect: the endpoint, the query parameter and the API
     *   wrapper's argument all existed and no caller ever set it, so
     *   archived session records were unreachable from every screen in
     *   the app.
     * Inputs:
     *   fetchRecent - `GET /sessions/recent`, taking the archive filter.
     *   includeArchived - the filter as it stands right now.
     *   t - the translator, for the failure notice only.
     * Output: Promise<void>. Never rejects.
     * Example: await sessionStore.refreshRecent(host.fetchRecent, false, t);
     */
    async refreshRecent(
        fetchRecent: (includeArchived: boolean) => Promise<RecentSessionsPayload>,
        includeArchived: boolean,
        t: Translate,
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
     * Drop every held fetch.
     *
     * Description: for a test, and for a caller tearing the screen down.
     *   It sets the payload back to null, which reads as `never_probed`
     *   and NOT as an empty `ok` - a cleared store must not be able to
     *   claim the group is empty.
     * Inputs: none. Output: void.
     * Example: sessionStore.reset()
     */
    reset(): void {
        recentPayload = null;
        recentInFlight = false;
    },
};
