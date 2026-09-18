/**
 * HOW MANY ROUND TRIPS DEEP THE HOME SCREEN'S FIRST PAINT IS.
 *
 * This file measures DEPTH, not count. The six requests behind the
 * launchpad were always six; what was slow was that they went out one
 * after another, each one waiting on an answer it took no input from.
 * `loadProjects` awaited the project list, then its two argument-free
 * sidecars, and only then did the running merge start, which awaited
 * `/sessions/attachable`, then `/sessions/list`, then
 * `/sessions/records`. Five waves end to end before the first row could
 * be drawn.
 *
 * SO A FETCH COUNT WOULD HAVE PASSED BEFORE THE FIX AND PROVED NOTHING.
 * The harness below hands every endpoint a promise nobody resolves, then
 * releases the whole outstanding set at once and counts how many times it
 * has to do that before the load settles. That number IS the waterfall:
 * requests that go out together cost one release, requests that go out in
 * sequence cost one each.
 *
 * THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST. A counter that always
 * answered 1 would pass the assertion this file exists for, so the same
 * harness is driven by a deliberately serial caller and required to
 * report 6. Watch that one go red before trusting the green one.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { createI18n } from '../../../../client/js/i18n/runtime.js';
import type { SessionHost } from './host';
import { sessionStore } from './store.svelte';
import type {
    AttachableSession,
    ProjectRow,
    SessionListItem,
    SessionRecord,
} from './types';

const en = createI18n({ locale: 'en' }) as { t(k: string, p?: unknown): string };
const t = (k: string, p?: Record<string, unknown> | null) => en.t(k, p);

/** Every endpoint the session store may reach, by the name used below. */
const ENDPOINTS = [
    'attachable', 'authority', 'list', 'presence', 'projects', 'records',
] as const;

/** Let every already-settled promise run its continuations. */
const settleMicrotasks = (): Promise<void> =>
    new Promise((resolve) => { setTimeout(resolve, 0); });

/** What one probing host offers a test. */
interface WaveRig {
    host: SessionHost;
    /** Every endpoint name asked for, in the order it was asked. */
    calls: string[];
    /**
     * Release the outstanding requests, repeatedly, until none is left.
     *
     * Returns how many releases that took - one per WAVE of concurrent
     * requests, which is the depth of the waterfall under test.
     */
    drain(): Promise<number>;
}

/**
 * Build a host whose every answer is withheld until a wave is released.
 *
 * Description: each method records its name and returns a promise parked
 *   in the pending set. Nothing resolves on its own, so a caller that
 *   awaits one request before sending the next cannot make progress until
 *   `drain` releases a wave, which is what makes the wave count equal the
 *   serial depth.
 *
 *   `list` answers a NON-EMPTY array on purpose, so the back-compat
 *   `getCurrentSession` fallback stays gated and this measurement is of
 *   the modern path. That the fallback is still gated is asserted below.
 * Inputs: over - per-endpoint values to answer with.
 * Output: WaveRig.
 * Example: const rig = waveRig(); sessionStore.useHost(rig.host);
 */
function waveRig(over: Partial<Record<string, unknown>> = {}): WaveRig {
    const calls: string[] = [];
    let pending: Array<() => void> = [];
    const probe = <T>(name: string, fallback: T) => (): Promise<T> => {
        calls.push(name);
        const answer = (name in over ? over[name] : fallback) as T | Error;
        return new Promise<T>((resolve, reject) => {
            pending.push(() => {
                if (answer instanceof Error) reject(answer);
                else resolve(answer);
            });
        });
    };
    const host: SessionHost = {
        getProjects: probe('projects', [] as ProjectRow[]),
        getProjectsPresence: probe('presence', { status: 'ok', projects: [] }),
        getProjectsAuthority: probe('authority', null as never),
        listAttachableSessions: probe('attachable', [{
            name: 'cloude_a', created_by_cloude: true, created_at_epoch: 5000,
            window_count: 1, status: 'idle',
        }] as AttachableSession[]),
        listSessions: probe('list', [{
            tmux_session: 'cloude_a', activity_status: 'working', unread: false,
            session: { id: 'ses_1' },
        }] as SessionListItem[]),
        getCurrentSession: probe('current', null),
        listSessionRecords: probe('records', [] as SessionRecord[]),
    };
    return {
        host,
        calls,
        async drain(): Promise<number> {
            let waves = 0;
            await settleMicrotasks();
            while (pending.length) {
                waves += 1;
                const batch = pending;
                pending = [];
                for (const release of batch) release();
                await settleMicrotasks();
            }
            return waves;
        },
    };
}

afterEach(() => {
    sessionStore.reset();
    sessionStore.useHost(null);
});

describe('the first paint is one round trip deep', () => {
    test('all six requests go out together and settle in ONE wave', async () => {
        // THE SEQUENCER'S OWN SHAPE, as `main.ts::loadHomeScreen` calls
        // it: the running merge is started, the panels are asked, and
        // only then is the project list awaited. Nothing here awaits
        // anything before starting the next thing, which is the property
        // under test.
        const rig = waveRig();
        sessionStore.useHost(rig.host);

        const running = sessionStore.loadRunningSessions(t);
        const projects = sessionStore.loadProjects(false, t);
        const waves = await rig.drain();
        await Promise.all([running, projects]);

        // PINNED. A regression that re-serialises any pair of these puts
        // this number up, and the failure names the depth rather than a
        // millisecond figure a loaded box could move.
        expect(waves).toBe(1);
        expect([...rig.calls].sort()).toEqual([...ENDPOINTS]);
    });

    test('and it really did load: rows, verdict and join all landed', async () => {
        // A load that fetched nothing would also settle in one wave, so
        // the depth assertion above is only worth having beside this one.
        const rig = waveRig();
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        const projects = sessionStore.loadProjects(false, t);
        await rig.drain();
        await Promise.all([running, projects]);

        expect(sessionStore.runningSessions).toHaveLength(1);
        expect(sessionStore.runningSessions[0]?.is_active).toBe(true);
        expect(sessionStore.runningSessionsListing.ok).toBe(true);
        expect(sessionStore.sessionAttributionListingOk).toBe(true);
        expect(sessionStore.projectsListingOk).toBe(true);
    });

    test('the back-compat fallback is still gated behind an empty list', async () => {
        // `getCurrentSession` is the ONE genuinely dependent request in
        // this flow: it may only be sent once `/sessions/list` has been
        // seen to answer nothing. It must not have joined the wave.
        const rig = waveRig();
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        await rig.drain();
        await running;
        expect(rig.calls).not.toContain('current');
    });

    test('it costs a SECOND wave when the live list really is empty', async () => {
        // ...and the fallback still fires when it should, which is what
        // makes the assertion above a gate rather than a deletion.
        const rig = waveRig({ list: [] });
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        const waves = await rig.drain();
        await running;
        expect(rig.calls).toContain('current');
        expect(waves).toBe(2);
    });
});

describe('THE NEGATIVE CONTROL: the counter can report more than one', () => {
    test('a deliberately serial caller measures six waves on the same rig', async () => {
        // If this passes at 1 the harness is broken and every green
        // assertion above is worthless. Six awaits, six releases.
        const rig = waveRig();
        const serial = (async () => {
            await rig.host.getProjects(false);
            await rig.host.getProjectsPresence();
            await rig.host.getProjectsAuthority();
            await rig.host.listAttachableSessions();
            await rig.host.listSessions!();
            await rig.host.listSessionRecords();
        })();
        const waves = await rig.drain();
        await serial;
        expect(waves).toBe(6);
    });

    test('THE BEFORE NUMBER: the shape this replaced measures five', async () => {
        // The waterfall as it shipped, reproduced request for request so
        // the figure quoted in CLAUDE.md has something behind it. The
        // project list, then its two sidecars together, then the two
        // session probes one after the other, then the records read.
        //
        // MEASURED THE OTHER WAY TOO, which is the part worth trusting:
        // reverting the three source files and re-running the assertions
        // above turned `waves` from 1 into 3 for the store on its own,
        // and the two extra waves are the ones this sequence shows -
        // `loadHomeScreen` used to await the whole project load before
        // the merge sent anything.
        const rig = waveRig();
        const serial = (async () => {
            await rig.host.getProjects(false);
            await Promise.all([
                rig.host.getProjectsPresence(),
                rig.host.getProjectsAuthority(),
            ]);
            await rig.host.listAttachableSessions();
            await rig.host.listSessions!();
            await rig.host.listSessionRecords();
        })();
        const waves = await rig.drain();
        await serial;
        expect(waves).toBe(5);
    });
});

describe('THE SOURCE RULE: the sequencer starts before it awaits', () => {
    test('loadHomeScreen kicks the merge and the panels ahead of the list', async () => {
        // The store can only fan out what it is given the chance to. Two
        // of the five waves lived in `main.ts`, not in this directory: the
        // merge was started on the line AFTER the project load was
        // awaited, so no amount of concurrency inside the store could
        // reach it. This is the shape assertion for that line, in the
        // style of `running-tick-mutations.test.ts`.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const src = fs.readFileSync(path.join(here, '..', '..', 'main.ts'), 'utf8');
        const body = src.slice(src.indexOf('async function loadHomeScreen'));
        // Comments stripped: the docblock beside it EXPLAINS the old
        // order, and a scan that read prose would fail on the account of
        // the fix, which is the least useful failure there is.
        const fn = body.slice(0, body.indexOf('\n}'))
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/^[ \t]*\/\/.*$/gm, ' ');

        const started = fn.indexOf('sessionStore.loadRunningSessions(t)');
        const panels = fn.indexOf('refreshLaunchpadPanels()');
        const awaited = fn.indexOf('await sessionStore.loadProjects');
        expect(started).toBeGreaterThan(-1);
        expect(panels).toBeGreaterThan(-1);
        expect(awaited).toBeGreaterThan(-1);
        expect(started).toBeLessThan(awaited);
        expect(panels).toBeLessThan(awaited);
        // ...and specifically NOT the line this replaced, which is what
        // put the merge a full project load behind the first paint.
        expect(fn).not.toContain('void sessionStore.loadRunningSessions(t);');
    });
});

describe('concurrency did not collapse the two session verdicts', () => {
    test('a failed attachable probe still lets the live merge answer', async () => {
        // The two probes are in flight together now, so the risk this
        // guards is a `Promise.all`-shaped fix discarding the second
        // answer the moment the first one failed. One failure, one
        // source named, and the live rows still merged in.
        const rig = waveRig({ attachable: new Error('HTTP 503') });
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        await rig.drain();
        await running;

        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        expect(sessionStore.runningSessionsListing.sources).toEqual(['attachable']);
        expect(sessionStore.runningSessions.map((r) => r.name)).toEqual(['cloude_a']);
    });

    test('a failed live probe does not reach for the fallback', async () => {
        // A rejection is not an empty list. The fallback answers "this
        // server only has one session", which a failed merge has not
        // measured.
        const rig = waveRig({ list: new Error('HTTP 500') });
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        await rig.drain();
        await running;

        expect(rig.calls).not.toContain('current');
        expect(sessionStore.runningSessionsListing.ok).toBe(false);
        expect(sessionStore.runningSessionsListing.sources).toEqual(['live']);
    });

    test('both failing names both sources, attachable first', async () => {
        const rig = waveRig({
            attachable: new Error('HTTP 503'), list: new Error('HTTP 500'),
        });
        sessionStore.useHost(rig.host);
        const running = sessionStore.loadRunningSessions(t);
        await rig.drain();
        await running;
        expect(sessionStore.runningSessionsListing.sources).toEqual(['attachable', 'live']);
    });
});

describe('the project sidecars are joined, not merely started', () => {
    test('presence and authority have landed before loadProjects resolves', async () => {
        const rig = waveRig({
            presence: { status: 'ok', projects: [{ raw_path: '/p', root: '/p' }] },
            authority: { mode: 'db', degraded: false },
        });
        sessionStore.useHost(rig.host);
        const projects = sessionStore.loadProjects(false, t);
        await rig.drain();
        await projects;
        // Read straight after the await: a fan-out that forgot to join
        // would leave both of these at their never-asked values.
        expect(sessionStore.projectAuthority).toEqual({ mode: 'db', degraded: false });
        expect(sessionStore.projectPresence.get('/p')).toBeTruthy();
    });

    test('a failed project list still resolves, and still joins them', async () => {
        const rig = waveRig({
            projects: new Error('HTTP 500'),
            authority: { mode: 'db', degraded: false },
        });
        sessionStore.useHost(rig.host);
        const projects = sessionStore.loadProjects(true, t);
        await rig.drain();
        const result = await projects;

        expect(result.ok).toBe(false);
        expect(sessionStore.projectsListingOk).toBe(false);
        expect(sessionStore.archivedFetchOk).toBe(false);
        expect(sessionStore.projectAuthority).toEqual({ mode: 'db', degraded: false });
    });
});
