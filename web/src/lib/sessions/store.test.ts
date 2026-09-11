/**
 * The store, end to end: four fetches, both join rungs, five latches.
 *
 * PORTED FROM tests/test_running_sessions_unknown.node.mjs,
 * tests/test_session_lists_are_disjoint.node.mjs,
 * tests/test_ended_sessions_visibility.node.mjs and
 * tests/test_session_attribution_join.node.mjs - the halves of each that
 * are about the DATA a renderer is handed rather than the markup it makes.
 *
 * BOTH JOIN RUNGS ARE ASSERTED HERE AND NOT ONLY IN attribution.test.ts,
 * because the interesting half is which rung a REAL row lands on.
 * `/sessions/attachable` excludes live sessions and `SessionInfo` carries
 * no `created_at_epoch`, so a live-only row is unshifted with a zero
 * epoch and therefore ALWAYS takes the name-only rung. That is a property
 * of two endpoints disagreeing, and only a test that drives both can see
 * it.
 *
 * EVERY FETCH IS INJECTED. `useHost` replaces the endpoints, so a
 * rejection is produced on purpose rather than waited for. The failure
 * paths are the whole subject: not one of the five three-outcome latches
 * may collapse into two.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import { instanceKey } from './attribution';
import type { SessionHost } from './host';
import { sessionStore } from './store.svelte';
import type {
    AttachableSession,
    ProjectPresencePayload,
    ProjectRow,
    SessionListItem,
    SessionRecord,
} from './types';

const en = createI18n({ locale: 'en' }) as { t(k: string, p?: unknown): string };
const t = (k: string, p?: Record<string, unknown> | null) => en.t(k, p);

/** Everything a host answers, each overridable per test. */
interface HostParts {
    projects?: ProjectRow[] | Error;
    presence?: ProjectPresencePayload | Error;
    authority?: unknown;
    attachable?: unknown;
    live?: unknown;
    current?: SessionListItem | null | Error;
    records?: unknown;
    omitListSessions?: boolean;
}

/**
 * Build a host that answers exactly what a test asks for.
 *
 * Description: an `Error` value REJECTS rather than resolving, which is
 *   how the failure branches are reached deliberately.
 * Inputs: parts. Output: SessionHost.
 * Example: sessionStore.useHost(host({ attachable: new Error('HTTP 503') }))
 */
function host(parts: HostParts = {}): SessionHost {
    const answer = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
        value instanceof Error ? Promise.reject(value) : Promise.resolve(
            value === undefined ? fallback : value,
        );
    const built: SessionHost = {
        getProjects: () => answer(parts.projects, [] as ProjectRow[]),
        getProjectsPresence: () => answer(parts.presence, { status: 'ok', projects: [] }),
        getProjectsAuthority: () => answer(parts.authority as never, null as never),
        listAttachableSessions: () => answer(parts.attachable as never, [] as AttachableSession[]),
        getCurrentSession: () => answer(parts.current, null),
        listSessionRecords: () => answer(parts.records as never, [] as SessionRecord[]),
    };
    if (!parts.omitListSessions) {
        built.listSessions = () => answer(parts.live as never, [] as SessionListItem[]);
    }
    return built;
}

/** One attachable row. */
const attachable = (over: Partial<AttachableSession> = {}): AttachableSession => ({
    name: 'cloude_a', created_by_cloude: true, created_at_epoch: 5000,
    window_count: 1, status: 'idle', ...over,
});

/** One `/sessions/list` wrapper row. */
const liveRow = (over: Partial<SessionListItem> = {}): SessionListItem => ({
    tmux_session: 'cloude_live', activity_status: 'working', unread: false,
    session: { id: 'ses_1' }, ...over,
});

/** One stored record. */
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 1, tmux_name: 'cloude_a', tmux_created_epoch: 5000, project_id: 3,
    project_attribution: 'exact', archived_at: null, last_work_at: null, ...over,
});

beforeEach(() => {
    sessionStore.reset();
});

afterEach(() => {
    sessionStore.reset();
    sessionStore.useHost(null);
});

describe('a healthy tick', () => {
    test('merges both endpoints and says the listing is ok', async () => {
        sessionStore.useHost(host({
            attachable: [attachable()],
            live: [liveRow()],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name).sort())
            .toEqual(['cloude_a', 'cloude_live']);
        expect(sessionStore.runningSessionsListing.ok).toBe(true);
    });

    test('a measured zero is a measured zero, not an alarm', () => {
        // NEGATIVE CONTROL for every failure case below. If an empty list
        // could not be told from a failed probe, none of them mean anything.
        sessionStore.useHost(host({ attachable: [], live: [] }));
        return sessionStore.loadRunningSessions(t).then(() => {
            expect(sessionStore.runningSessions).toEqual([]);
            expect(sessionStore.runningSessionsListing.ok).toBe(true);
            expect(sessionStore.runningSessionsListing.detail).toBeNull();
        });
    });

    test('a dead pane is absent from the row set entirely', async () => {
        sessionStore.useHost(host({
            attachable: [attachable({ name: 'cloude_dead', status: 'dead' }), attachable()],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name)).toEqual(['cloude_a']);
    });

    test('an unknown pane is NOT: could-not-tell is not a death', async () => {
        sessionStore.useHost(host({
            attachable: [attachable({ name: 'cloude_unknown', status: 'unknown' })],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name)).toEqual(['cloude_unknown']);
    });
});

describe('the attachable probe not answering', () => {
    test('leaves no rows AND marks the listing unknown', async () => {
        // The row set staying empty is only half of it. Without the
        // verdict the screen renders a dead tmux server as a healthy
        // machine with zero sessions.
        sessionStore.useHost(host({ attachable: new Error('HTTP 503') }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions).toEqual([]);
        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        expect(sessionStore.runningSessionsListing.sources).toContain('attachable');
    });

    test("the server's structured reason reaches the verdict", async () => {
        const err = Object.assign(new Error('HTTP 503'), {
            status: 503,
            detail: { listing_reason: 'tmux_missing', listing_detail: 'no server running' },
        });
        sessionStore.useHost(host({ attachable: err }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.reason).toBe('tmux_missing');
        expect(sessionStore.runningSessionsListing.detail).toBe('no server running');
    });

    test('a non-array 200 is unknown, not empty', async () => {
        sessionStore.useHost(host({ attachable: { nope: true } }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        expect(sessionStore.runningSessionsListing.reason).toBe('malformed_response');
    });

    test('the verdict is reset on the NEXT tick, so a recovery shows', async () => {
        sessionStore.useHost(host({ attachable: new Error('HTTP 503') }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        sessionStore.useHost(host({ attachable: [attachable()] }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.ok).toBe(true);
    });
});

describe('the live merge not answering', () => {
    test('a 404 IS an answer: there is no active session', async () => {
        // The old bare "404 = no active session, fine" treated every
        // failure the same and let a failed merge render as "these are all
        // your sessions".
        const err = Object.assign(new Error('HTTP 404'), { status: 404 });
        sessionStore.useHost(host({ attachable: [attachable()], live: err }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.ok).toBe(true);
        expect(sessionStore.runningSessions).toHaveLength(1);
    });

    test('anything else is a merge that did not run, and is said out loud', async () => {
        const err = Object.assign(new Error('HTTP 500'), { status: 500 });
        sessionStore.useHost(host({ attachable: [attachable()], live: err }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        expect(sessionStore.runningSessionsListing.sources).toEqual(['live']);
        // The attachable rows still stand: they were measured.
        expect(sessionStore.runningSessions).toHaveLength(1);
    });

    test('an old single-session server falls back to getCurrentSession', async () => {
        sessionStore.useHost(host({
            omitListSessions: true,
            attachable: [],
            current: liveRow(),
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name)).toEqual(['cloude_live']);
    });

    test('an EMPTY live list also falls back, exactly as before', async () => {
        sessionStore.useHost(host({ attachable: [], live: [], current: liveRow() }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name)).toEqual(['cloude_live']);
    });
});

describe('both join rungs, driven through the real endpoints', () => {
    test('an ATTACHABLE row carries its epoch and takes the exact rung', async () => {
        sessionStore.useHost(host({
            attachable: [attachable({ name: 'cloude_a', created_at_epoch: 5000 })],
            records: [record({ id: 11, tmux_name: 'cloude_a', tmux_created_epoch: 5000 })],
        }));
        await sessionStore.loadRunningSessions(t);
        const row = sessionStore.runningSessions[0]!;
        expect(row.created_at_epoch).toBe(5000);
        expect(sessionStore.sessionAttributionByInstance
            .get(instanceKey(row.name, row.created_at_epoch as number))?.id).toBe(11);
    });

    test('a LIVE-ONLY row has a zero epoch and can only take the name rung', async () => {
        // `/sessions/attachable` excludes live sessions and `SessionInfo`
        // carries no `created_at_epoch`. Not a bug: the epoch is simply not
        // on that wire shape, which is why the name-only rung must exist.
        sessionStore.useHost(host({
            attachable: [],
            live: [liveRow({ tmux_session: 'cloude_live' })],
            records: [record({ id: 22, tmux_name: 'cloude_live', tmux_created_epoch: 9000 })],
        }));
        await sessionStore.loadRunningSessions(t);
        const row = sessionStore.runningSessions[0]!;
        expect(row.created_at_epoch).toBe(0);
        expect(sessionStore.sessionAttributionByInstance
            .has(instanceKey(row.name, 0))).toBe(false);
        expect(sessionStore.sessionAttribution.get('cloude_live')?.id).toBe(22);
    });

    test('an unrankable name reaches the store as AMBIGUOUS, not as absent', async () => {
        // It must be tellable from "belongs to no project". A caller that
        // read the empty byName entry alone would render a false green.
        sessionStore.useHost(host({
            attachable: [attachable()],
            records: [
                record({ id: 1, tmux_created_epoch: 700 }),
                record({ id: 2, tmux_created_epoch: 700 }),
            ],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.sessionAttributionAmbiguous.has('cloude_a')).toBe(true);
        expect(sessionStore.sessionAttribution.has('cloude_a')).toBe(false);
        expect(sessionStore.sessionAttributionListingOk).toBe(true);
    });
});

describe('the records fetch not answering', () => {
    test('empties the join AND drops the latch, which are different facts', async () => {
        // Empty maps alone say "these sessions belong to no project". The
        // latch is what makes them say "we could not read the table".
        sessionStore.useHost(host({
            attachable: [attachable()],
            records: new Error('HTTP 500'),
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.sessionAttribution.size).toBe(0);
        expect(sessionStore.sessionAttributionByInstance.size).toBe(0);
        expect(sessionStore.sessionRecords).toEqual([]);
        expect(sessionStore.sessionAttributionListingOk).toBe(false);
        expect(sessionStore.sessionAttributionListingDetail).toBe('HTTP 500');
    });

    test('a FAILED fetch is not an empty work history, so the index clears too', async () => {
        sessionStore.useHost(host({
            attachable: [attachable()],
            records: [record({ last_work_at: '2026-09-09T00:00:00Z' })],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.workStampByName.size).toBe(1);
        sessionStore.useHost(host({ attachable: [attachable()], records: new Error('down') }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.workStampByName.size).toBe(0);
    });

    test('a non-array body takes the same path, with its own sentence', async () => {
        sessionStore.useHost(host({ records: { nope: true } }));
        await sessionStore.loadSessionAttribution(t);
        expect(sessionStore.sessionAttributionListingOk).toBe(false);
        expect(sessionStore.sessionAttributionListingDetail)
            .toBe(t('session.listing.detail.malformed_records'));
    });

    test('a successful fetch clears a previous failure detail', async () => {
        sessionStore.useHost(host({ records: new Error('down') }));
        await sessionStore.loadSessionAttribution(t);
        sessionStore.useHost(host({ records: [record()] }));
        await sessionStore.loadSessionAttribution(t);
        expect(sessionStore.sessionAttributionListingOk).toBe(true);
        expect(sessionStore.sessionAttributionListingDetail).toBeNull();
    });
});

describe('attribution runs BEFORE the sort, and the order proves it', () => {
    test('the first paint is already ordered by work', async () => {
        // Sorting first would order every first paint by a value that had
        // not arrived, and then never re-sort, because the sort is not
        // repeated after the fetch.
        sessionStore.useHost(host({
            attachable: [
                attachable({ name: 'cloude_stale', created_at_epoch: 9000 }),
                attachable({ name: 'cloude_busy', created_at_epoch: 1000 }),
            ],
            records: [
                record({ tmux_name: 'cloude_busy', last_work_at: '2026-09-09T00:00:00Z' }),
                record({ tmux_name: 'cloude_stale', last_work_at: '2026-09-01T00:00:00Z' }),
            ],
        }));
        await sessionStore.loadRunningSessions(t);
        expect(sessionStore.runningSessions.map((r) => r.name))
            .toEqual(['cloude_busy', 'cloude_stale']);
    });
});

describe('the projects fetch and its two latches', () => {
    test('a read list latches ok, and does not claim anything about archived', async () => {
        sessionStore.useHost(host({ projects: [{ name: 'p' }] }));
        const result = await sessionStore.loadProjects(false, t);
        expect(result.ok).toBe(true);
        expect(sessionStore.projectsListingOk).toBe(true);
        // NOT ASKED is null, never false. Rendering "no archived projects"
        // off a request that excluded them by construction is a lie.
        expect(sessionStore.archivedFetchOk).toBeNull();
    });

    test('asking FOR archived rows is what lets the answer be reported', async () => {
        sessionStore.useHost(host({ projects: [] }));
        await sessionStore.loadProjects(true, t);
        expect(sessionStore.archivedFetchOk).toBe(true);
    });

    test('a failed fetch latches false and hands back a sentence', async () => {
        sessionStore.useHost(host({ projects: new Error('HTTP 500') }));
        const result = await sessionStore.loadProjects(true, t);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('HTTP 500');
        expect(sessionStore.projectsListingOk).toBe(false);
        expect(sessionStore.archivedFetchOk).toBe(false);
    });

    test('a failure with the toggle OFF says nothing about archived rows', async () => {
        sessionStore.useHost(host({ projects: new Error('HTTP 500') }));
        await sessionStore.loadProjects(false, t);
        expect(sessionStore.archivedFetchOk).toBeNull();
    });

    test('it never rejects, so one bad fetch cannot take the screen down', async () => {
        sessionStore.useHost(host({ projects: new Error('boom') }));
        await expect(sessionStore.loadProjects(false, t)).resolves.toBeTruthy();
    });
});

describe('the two project sidecars', () => {
    test('presence is indexed by BOTH the raw path and the normalised root', async () => {
        // Indexing by raw_path alone made the badge miss whenever the two
        // spellings differed, which on this owner's box is most of them.
        sessionStore.useHost(host({
            presence: {
                status: 'ok',
                projects: [{ raw_path: '~/Development/x', root: '/Users/j/iCloud/x' }],
            },
        }));
        await sessionStore.loadProjectPresence();
        expect(sessionStore.projectPresence.get('~/Development/x')).toBeTruthy();
        expect(sessionStore.projectPresence.get('/Users/j/iCloud/x')).toBeTruthy();
    });

    test('a failed presence fetch leaves the map EMPTY rather than throwing', async () => {
        // Failing to LOAD presence is not evidence anything is missing.
        // Every project then renders unchecked: normal, actions allowed.
        sessionStore.useHost(host({ presence: new Error('down') }));
        await sessionStore.loadProjectPresence();
        expect(sessionStore.projectPresence.size).toBe(0);
    });

    test('a non-ok presence body is also not read as rows', async () => {
        sessionStore.useHost(host({ presence: { status: 'degraded', projects: [{ root: 'x' }] } }));
        await sessionStore.loadProjectPresence();
        expect(sessionStore.projectPresence.size).toBe(0);
    });

    test('a failed authority fetch reads as CANNOT DETERMINE, never as healthy', async () => {
        // Assuming health here would reintroduce the exact false green the
        // authority endpoint exists to expose.
        sessionStore.useHost(host({ authority: { mode: 'db', degraded: false } }));
        await sessionStore.loadProjectAuthority();
        expect(sessionStore.projectAuthority).toEqual({ mode: 'db', degraded: false });
        sessionStore.useHost(host({ authority: new Error('down') }));
        await sessionStore.loadProjectAuthority();
        expect(sessionStore.projectAuthority).toBeNull();
    });
});

describe('the tick the store owns', () => {
    test('startPolling starts one, stopPolling stops it', () => {
        expect(sessionStore.polling).toBe(false);
        sessionStore.startPolling({ tick: () => {}, shouldPoll: () => false });
        expect(sessionStore.polling).toBe(true);
        sessionStore.stopPolling();
        expect(sessionStore.polling).toBe(false);
    });

    test('reset stops the tick, so a cleared store cannot refill itself', () => {
        sessionStore.startPolling({ tick: () => {}, shouldPoll: () => false });
        sessionStore.reset();
        expect(sessionStore.polling).toBe(false);
    });
});

describe('reset puts every latch back to NEVER ASKED, not to empty', () => {
    test('a cleared store claims nothing about anything', async () => {
        sessionStore.useHost(host({
            projects: [{ name: 'p' }], attachable: [attachable()], records: [record()],
        }));
        await sessionStore.loadProjects(true, t);
        await sessionStore.loadRunningSessions(t);
        sessionStore.reset();
        expect(sessionStore.projects).toEqual([]);
        expect(sessionStore.projectsListingOk).toBeNull();
        expect(sessionStore.archivedFetchOk).toBeNull();
        expect(sessionStore.recentPayload).toBeNull();
        expect(sessionStore.runningSessions).toEqual([]);
        expect(sessionStore.runningSessionsListing.ok).toBe(true);
        expect(sessionStore.sessionRecords).toEqual([]);
        expect(sessionStore.workStampByName.size).toBe(0);
    });
});
