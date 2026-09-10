/**
 * WHAT A REAL POLL TICK COSTS THE DOM, DRIVEN THROUGH THE REAL LOAD PATH.
 *
 * @vitest-environment jsdom
 *
 * THIS FILE EXISTS BECAUSE ./mutation-count.test.ts COULD NOT SEE A
 * REGRESSION AND A REAL BROWSER COULD. That file writes the store's
 * fields directly through `applyFixture`, which measures the tree's
 * response to a DATA CHANGE. A poll tick is not a data change: it is
 * `sessionStore.loadRunningSessions()`, which runs two fetches, the
 * merge, the dead-pane filter, the attribution join, the work-stamp
 * index and the sort, WITH AN AWAIT IN THE MIDDLE OF IT. Measured in
 * Brave on 2026-09-10 over a 9-project, 45-row screen: the harness said
 * 0 mutations on an unchanged tick and the browser said 6,048.
 *
 * THE DEFECT, AND WHY ONLY A KEYED LIST COULD SEE IT.
 * `loadRunningSessions` used to assign `runningSessions = rows` in FETCH
 * order, await attribution, then assign the SORTED array. Two
 * assignments either side of an await are two separate effect flushes,
 * so every subscriber saw the unsorted order and then the sorted one.
 * The legacy string renderer could not tell - it painted once, at the
 * end, from whatever the fields held. A keyed `{#each}` faithfully moved
 * all 45 rows to match the intermediate and then moved them all back:
 * 504 `childList` records and 1,344 nodes per tick, on the most common
 * path there is, and WORSE THAN THE RENDER GUARD THIS MIGRATION DELETED,
 * which got an unchanged tick to zero.
 *
 * THE FIXTURE'S TWO ORDERS DISAGREE ON PURPOSE. It is built ascending by
 * creation epoch, which is what a server answers; the sort is descending.
 * A fixture whose fetch order happened to match its display order would
 * pass whether the defect was there or not, which is the way this test
 * would rot.
 *
 * THE ASSERTION IS ZERO, NOT "SMALL". An unchanged tick has nothing to
 * say to the DOM, and any number above zero here is a subscriber
 * reacting to a state the app should never have published.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { sessionStore } from '../sessions/store.svelte';
import { treeCollapse } from './tree-collapse.svelte';
import { uiPrefs } from '../ui/prefs.svelte';
import {
    fixtureHost,
    fleet,
    mountTree,
    settle,
    watchMutations,
    type MountedTree,
} from './tree-harness';

/** A tick, exactly as the 5s poller runs it. */
const tick = () => sessionStore.loadRunningSessions((k: string) => k);

/** How many ticks a 60s window at the real 5s interval contains. */
const TICKS_PER_WINDOW = 12;

let tree: MountedTree | null = null;

/**
 * Mount the tree and drive one real tick, so the screen is settled.
 *
 * Description: the FIRST tick after a mount legitimately paints, so
 *   every measurement below starts after one. Measuring from the mount
 *   would count the initial render as churn.
 * Inputs: working - tmux names whose status should read `working`.
 * Output: Promise<MountedTree>.
 */
async function mountAndSettle(working: string[] = []): Promise<MountedTree> {
    const t = mountTree({});
    sessionStore.useHost(fixtureHost(fleet({ working })));
    await sessionStore.loadProjects(false, (k: string) => k);
    await tick();
    await settle();
    return t;
}

beforeEach(() => {
    if (tree) {
        tree.destroy();
        tree = null;
    }
    sessionStore.useHost(null);
    treeCollapse.resetForTests();
    uiPrefs.resetForTests();
});

describe('the real load path paints the same screen the direct writes do', () => {
    test('one tick through loadRunningSessions paints 9 nodes and 45 rows', async () => {
        tree = await mountAndSettle();
        expect(tree.container.querySelectorAll(
            '.project-node[data-project-node="project"]')).toHaveLength(9);
        expect(tree.container.querySelectorAll('.project-session-row')).toHaveLength(45);
    });

    test('and it paints them in the SORT order, newest created first', async () => {
        // The fixture is fetched ascending. If this ever reads ascending,
        // the sort stopped being applied and the zero below would be a
        // zero about the wrong thing.
        tree = await mountAndSettle();
        const names = Array.from(tree.container.querySelectorAll(
            '.project-node[data-project-name="project-3"] .project-session-row'))
            .map((el) => el.getAttribute('data-name'));
        expect(names).toEqual([
            'cloude_p3_s4', 'cloude_p3_s3', 'cloude_p3_s2',
            'cloude_p3_s1', 'cloude_p3_s0',
        ]);
    });
});

describe('TWELVE REAL TICKS with nothing changing cost the DOM nothing', () => {
    test('0 records and 0 nodes', async () => {
        // THE REGRESSION TEST. Before the fix this read 6,048 records and
        // 16,128 nodes in a real browser and 0 in the old harness, which
        // is the whole reason this file exists.
        tree = await mountAndSettle();
        const watcher = watchMutations(tree.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            await tick();
            await settle();
        }
        expect(watcher.stop()).toEqual({ records: 0, nodes: 0 });
    });

    test('and the row ORDER is unchanged after them, not merely restored', async () => {
        // A list that moved out and back would score above zero on the
        // count; this catches the case where it scored zero because
        // nothing was subscribed at all.
        tree = await mountAndSettle();
        const before = Array.from(tree.container.querySelectorAll(
            '.project-session-row')).map((el) => el.getAttribute('data-name'));
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            await tick();
            await settle();
        }
        const after = Array.from(tree.container.querySelectorAll(
            '.project-session-row')).map((el) => el.getAttribute('data-name'));
        expect(after).toEqual(before);
        expect(after).toHaveLength(45);
    });

    test('NEGATIVE CONTROL: the tree really is subscribed to these ticks', async () => {
        // Without this, a tree that had stopped reading the store would
        // score a perfect zero above and prove nothing at all.
        tree = await mountAndSettle();
        const dot = () => tree!.container.querySelector(
            '.project-session-row[data-name="cloude_p3_s2"] .status-dot') as HTMLElement;
        expect(dot().className).toContain('status-dot--idle');
        sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
        await tick();
        await settle();
        expect(dot().className).toContain('status-dot--working');
    });
});

describe('a tick that DOES change one status costs five attributes and no nodes', () => {
    test('exactly 5 records, all attributes, all on one element', async () => {
        tree = await mountAndSettle();
        const watcher = watchMutations(tree.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            if (i === 5) {
                sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
            }
            await tick();
            await settle();
        }
        const { records, nodes } = watcher.stop();
        // FIVE, and the five are the LED's own: `class`, `data-inner`,
        // `data-outer`, `title` and `aria-label`. Pinned rather than
        // bounded so a sixth write fails here instead of hiding under a
        // loose inequality.
        expect(records).toBe(5);
        expect(nodes).toBe(0);
    });

    test('and the dot that changed is the SAME element it was before', async () => {
        tree = await mountAndSettle();
        const sel = '.project-session-row[data-name="cloude_p3_s2"] .status-dot';
        const before = tree.container.querySelector(sel);
        sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
        await tick();
        await settle();
        const after = tree.container.querySelector(sel);
        expect(after).toBe(before);
        expect((after as HTMLElement).className).toContain('status-dot--working');
    });
});

describe('THE SOURCE RULE: the row set is published exactly once per tick', () => {
    test('loadRunningSessions assigns `runningSessions` once, and after the await', async () => {
        // The count test above is the behaviour; this is the shape, and
        // it names the thing not to do. A second assignment either side of
        // the await is two effect flushes, and a keyed list moves every
        // row to match the first one before moving it back.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const src = fs.readFileSync(
            path.join(here, '..', 'sessions', 'store.svelte.ts'), 'utf8');
        const body = src.slice(src.indexOf('async loadRunningSessions'));
        const method = body.slice(0, body.indexOf('\n    },'));
        const assignments = method.match(/^\s*runningSessions = /gm) || [];
        expect(assignments).toHaveLength(1);
        // ...and it is the SORTED one.
        expect(method).toContain('runningSessions = sortRunningSessionsByWork');
    });
});
