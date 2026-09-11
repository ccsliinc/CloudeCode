/**
 * WHICH SESSIONS THE RUNNING LIST IS ALLOWED TO SHOW.
 *
 * @vitest-environment jsdom
 *
 * PORTED FROM tests/test_dead_pane_not_running.node.mjs AND THE TWO RENDER
 * CASES OF tests/test_session_lists_are_disjoint.node.mjs. Both of those
 * asserted against RENDERED MARKUP rather than against state, deliberately
 * - the defect they were written for was always visible on screen and
 * never in a log - and both drove the real `loadRunningSessions` through a
 * `vm` sandbox. That sandbox has no `Element`, so once the list became a
 * component it could no longer paint there; the assertions move to where a
 * real DOM is, and they still measure the rendered rows rather than the
 * array behind them.
 *
 * THE CONTRAST IS THE TEST. Hiding everything would satisfy "the dead one
 * is gone" and be a worse bug, so every case below pairs the dead row with
 * a live row and asserts the live one SURVIVES.
 *
 * tmux `has-session` stays true for a pane held open by `remain-on-exit`
 * after its process exited, so a husk arrives from
 * `GET /sessions/attachable` and used to render among the running rows and
 * be counted in the heading, while its own red dot - read from
 * `#{pane_dead}` - had been telling the truth all along.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { sessionStore } from '../sessions/store.svelte';
import { uiPrefs } from '../ui/prefs.svelte';
import { settle } from './tree-harness';
import { mountList, row, type MountedList } from './running-harness';
import type { SessionHost } from '../sessions/host';
import type { AttachableSession } from '../sessions/types';

let list: MountedList | null = null;

/** A tick, exactly as the 5s poller runs it. */
const tick = () => sessionStore.loadRunningSessions((k: string) => k);

/**
 * A host answering a fixed attachable set and nothing else.
 *
 * Description: the two sidecars answer empty rather than failing, so the
 *   listing verdict stays `ok` and a row that is missing is missing
 *   because the MERGE dropped it rather than because a probe refused.
 * Inputs: attachable - the rows `GET /sessions/attachable` returns.
 * Output: SessionHost.
 */
function hostWith(attachable: AttachableSession[]): SessionHost {
    return {
        getProjects: async () => [],
        getProjectsPresence: async () => ({ status: 'ok', projects: [] }),
        getProjectsAuthority: async () => ({ mode: 'db', degraded: false, writable: true }),
        listAttachableSessions: async () => attachable.map((r) => ({ ...r })),
        listSessions: async () => [],
        getCurrentSession: async () => null,
        listSessionRecords: async () => [],
    };
}

/** Mount the list and drive one real tick against a fixed fleet. */
async function paint(attachable: AttachableSession[]): Promise<MountedList> {
    const mounted = mountList({});
    sessionStore.useHost(hostWith(attachable));
    await tick();
    await settle();
    return mounted;
}

/** Every tmux name currently painted. */
function names(mounted: MountedList): (string | null)[] {
    return Array.from(mounted.container.querySelectorAll('.running-session-row'))
        .map((el) => el.getAttribute('data-name'));
}

const live = row('cloude_alpha', { status: 'idle', created_at_epoch: 1_700_000_000 });
const dead = row('cloude_ses_husk', { status: 'dead', created_at_epoch: 1_699_000_000 });
const murky = row('cloude_murky', { status: 'unknown', created_at_epoch: 1_698_000_000 });

beforeEach(() => {
    sessionStore.useHost(null);
    uiPrefs.resetForTests();
});

afterEach(() => {
    if (list) {
        list.destroy();
        list = null;
    }
});

describe('a DEAD pane is not a running session', () => {
    test('the husk is NOT rendered among the running rows', async () => {
        list = await paint([live, dead]);
        expect(names(list)).not.toContain('cloude_ses_husk');
    });

    test('and the live row IS still rendered, which proves it discriminates', async () => {
        list = await paint([live, dead]);
        expect(names(list)).toContain('cloude_alpha');
    });

    test('the heading count excludes the dead row', async () => {
        // The count and the rows come from one array, so a count that
        // disagreed with the list would mean two answers to one question.
        list = await paint([live, dead]);
        expect(list.chrome.counts.at(-1)?.text).toBe('session.running.count 1');
    });

    test('the STATE ARRAY itself drops it, not just the markup', async () => {
        // Filtering at paint time would leave every other reader of the
        // store - the project tree, a row action, the sort - still holding
        // a session that is not running.
        list = await paint([live, dead]);
        expect(sessionStore.runningSessions.map((r) => r.name))
            .toEqual(['cloude_alpha']);
    });

    test('a listing of ONLY dead rows renders no rows at all', async () => {
        list = await paint([dead]);
        expect(names(list)).toEqual([]);
    });
});

describe('UNKNOWN is not a death', () => {
    test('a row whose status could not be read is KEPT and rendered', async () => {
        // COULD-NOT-TELL IS NOT EVIDENCE OF ABSENCE. Dropping it would
        // make a session the user has vanish because a probe was slow.
        list = await paint([live, murky]);
        expect(names(list)).toContain('cloude_murky');
        expect(names(list)).toContain('cloude_alpha');
    });

    test('and it is counted, because it is still a session we hold', async () => {
        list = await paint([live, murky]);
        expect(list.chrome.counts.at(-1)?.text).toBe('session.running.count 2');
    });
});

describe('THE PARENT-LINK BADGE IS GONE from the running row', () => {
    test('the row id renders and no arrow to a predecessor does', async () => {
        // It used to append `← #3`. Restarts made before row reuse landed
        // set `parent_session_id` on the session that REPLACED them, so
        // the badge pointed at the abandoned predecessor - precisely the
        // relationship the owner asked not to be shown - and those rows
        // are excluded from every list, so it pointed at a row that
        // appears nowhere on screen.
        list = mountList({
            rows: [row('cloude_api', { session_row_id: 7, parent_session_id: '4' })],
        });
        const badge = list.container.querySelector(
            '.running-session-id',
        ) as HTMLElement;
        expect(badge.textContent).toBe('#7');
        expect(list.container.innerHTML).not.toContain('←');
        expect(list.container.innerHTML).not.toContain('#4');
    });
});
