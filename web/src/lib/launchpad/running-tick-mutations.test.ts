/**
 * WHAT A REAL POLL TICK COSTS THE RUNNING-SESSIONS LIST.
 *
 * @vitest-environment jsdom
 *
 * THIS FILE EXISTS BECAUSE A HARNESS THAT WRITES THE STORE'S FIELDS
 * CANNOT SEE THE DEFECT THIS SLICE'S SURFACE INHERITED. Slice 4 measured
 * it: `./mutation-count.test.ts` writes fields directly and reported 0
 * mutations on an unchanged tick while Brave reported 6,048, because a
 * poll tick is not a data change - it is
 * `sessionStore.loadRunningSessions()`, which runs two fetches, the merge,
 * the dead-pane filter, the attribution join, the work-stamp index and the
 * sort, WITH AN AWAIT IN THE MIDDLE OF IT. Anything published either side
 * of that await is two effect flushes, and a keyed list faithfully paints
 * both.
 *
 * SLICE 4 FIXED THE ROW SET. SLICE 5 FIXES THE LISTING VERDICT, and it is
 * the same defect one field over: `loadRunningSessions` opened by
 * assigning `runningSessionsListing = emptyListing()` and assigned the
 * real verdict after the await. The assignment after it is unconditional,
 * so the reset changed nothing about the ANSWER and everything about how
 * many times it was published. On a screen whose probe is failing, every
 * tick removed the NEEDS ATTENTION block and put it back, and flipped the
 * heading between a number and "could not be determined". This list is
 * the only surface that renders that verdict, so nothing else could have
 * caught it.
 *
 * THE ASSERTION IS ZERO, NOT "SMALL". An unchanged tick has nothing to say
 * to the DOM, and any number above zero is a subscriber reacting to a
 * state the app should never have published.
 *
 * THE FIXTURE'S TWO ORDERS DISAGREE ON PURPOSE, inherited from
 * ./tree-harness.ts: it is built ascending by creation epoch, which is
 * what a server answers, and the sort is descending. A fixture whose fetch
 * order matched its display order would pass whether the defect was there
 * or not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { sessionStore } from '../sessions/store.svelte';
import { uiPrefs } from '../ui/prefs.svelte';
import { fixtureHost, fleet, settle, watchMutations } from './tree-harness';
import { mountList, type MountedList } from './running-harness';

/** A tick, exactly as the 5s poller runs it. */
const tick = () => sessionStore.loadRunningSessions((k: string) => k);

/** How many ticks a 60s window at the real 5s interval contains. */
const TICKS_PER_WINDOW = 12;

let list: MountedList | null = null;

/**
 * Mount the list and drive one real tick, so the screen is settled.
 *
 * Description: the FIRST tick after a mount legitimately paints, so every
 *   measurement below starts after one. Measuring from the mount would
 *   count the initial render as churn.
 * Inputs: working - tmux names whose status should read `working`.
 * Output: Promise<MountedList>.
 */
async function mountAndSettle(working: string[] = []): Promise<MountedList> {
    const mounted = mountList({});
    sessionStore.useHost(fixtureHost(fleet({ working })));
    await tick();
    await settle();
    return mounted;
}

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

describe('the real load path paints the list it is supposed to', () => {
    test('one tick through loadRunningSessions paints 45 rows', async () => {
        list = await mountAndSettle();
        expect(list.container.querySelectorAll('.running-session-row'))
            .toHaveLength(45);
    });

    test('and it paints them in the SORT order, newest created first', async () => {
        // The fixture is fetched ASCENDING. If this ever reads ascending,
        // the sort stopped being applied and the zero below would be a
        // zero about the wrong thing.
        list = await mountAndSettle();
        const names = Array.from(
            list.container.querySelectorAll('.running-session-row'),
        ).map((el) => el.getAttribute('data-name'));
        expect(names[0]).toBe('cloude_p8_s4');
        expect(names.at(-1)).toBe('cloude_p0_s0');
    });
});

describe('TWELVE REAL TICKS with nothing changing cost the DOM nothing', () => {
    test('0 records and 0 nodes', async () => {
        list = await mountAndSettle();
        const watcher = watchMutations(list.container);
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
        list = await mountAndSettle();
        const before = Array.from(
            list.container.querySelectorAll('.running-session-row'),
        ).map((el) => el.getAttribute('data-name'));
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            await tick();
            await settle();
        }
        const after = Array.from(
            list.container.querySelectorAll('.running-session-row'),
        ).map((el) => el.getAttribute('data-name'));
        expect(after).toEqual(before);
        expect(after).toHaveLength(45);
    });

    test('NEGATIVE CONTROL: the list really is subscribed to these ticks', async () => {
        // Without this, a list that had stopped reading the store would
        // score a perfect zero above and prove nothing at all.
        list = await mountAndSettle();
        const dot = () => list!.container.querySelector(
            '.running-session-row[data-name="cloude_p3_s2"] .status-dot',
        ) as HTMLElement;
        expect(dot().className).toContain('status-dot--idle');
        sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
        await tick();
        await settle();
        expect(dot().className).toContain('status-dot--working');
    });
});

describe('a tick that DOES change one status is cheap and LOCAL', () => {
    test('the records are attributes only, and no node is added or removed', async () => {
        list = await mountAndSettle();
        const watcher = watchMutations(list.container);
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
        // loose inequality. ZERO NODES is the half that matters most: the
        // legacy list rewrote every row on the screen for this.
        expect(records).toBe(5);
        expect(nodes).toBe(0);
    });

    test('and the dot that changed is the SAME element it was before', async () => {
        list = await mountAndSettle();
        const sel = '.running-session-row[data-name="cloude_p3_s2"] .status-dot';
        const before = list.container.querySelector(sel);
        sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
        await tick();
        await settle();
        expect(list.container.querySelector(sel)).toBe(before);
    });

    test('THE BUSY CASE: a status change lands while a rename editor is open', async () => {
        // WHAT THE DELETED GUARD COULD NOT DO. `session-list-busy-guard.js`
        // answered "is the user mid-edit inside the list we are about to
        // wipe" and the caller SKIPPED the paint, so this change was not
        // shown at all until the editor closed. Correctness bought with
        // staleness; here both are true at once.
        list = await mountAndSettle();
        const rowEl = list.container.querySelector(
            '.running-session-row[data-name="cloude_p3_s2"]',
        ) as HTMLElement;
        (rowEl.querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowEl.querySelector(
            '.running-session-rename-input',
        ) as HTMLInputElement;
        input.value = 'half typed';
        sessionStore.useHost(fixtureHost(fleet({ working: ['cloude_p3_s2'] })));
        await tick();
        await settle();
        // The editor survived, with its text...
        const after = rowEl.querySelector(
            '.running-session-rename-input',
        ) as HTMLInputElement;
        expect(after).toBe(input);
        expect(after.value).toBe('half typed');
        // ...AND the change was painted.
        expect((rowEl.querySelector('.status-dot') as HTMLElement).className)
            .toContain('status-dot--working');
    });
});

describe('THE SOURCE RULE: nothing is published twice per tick', () => {
    /** `loadRunningSessions`'s body, sliced out of the real source. */
    async function loadRunningSessionsBody(): Promise<string> {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const src = fs.readFileSync(
            path.join(here, '..', 'sessions', 'store.svelte.ts'), 'utf8');
        const body = src.slice(src.indexOf('async loadRunningSessions'));
        const method = body.slice(0, body.indexOf('\n    },'));
        // COMMENTS ARE STRIPPED, because this method's own docblock
        // QUOTES the line that must not reappear - it explains what the
        // old defect was. A scan that read prose would fail on the
        // explanation of the fix, which is the least useful failure there
        // is.
        return method
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/^[ \t]*\/\/.*$/gm, ' ');
    }

    test('the LISTING VERDICT is assigned once, and after the await', async () => {
        // SLICE 5's HALF OF THE SLICE 4 DEFECT. The count test below is the
        // behaviour; this is the shape, and it names the thing not to do.
        const method = await loadRunningSessionsBody();
        const assignments = method.match(/^\s*runningSessionsListing = /gm) || [];
        expect(assignments).toHaveLength(1);
        expect(method).toContain('runningSessionsListing = listing;');
        // ...and specifically NOT the reset that used to open the method.
        expect(method).not.toContain('runningSessionsListing = emptyListing()');
    });

    test('the ROW SET is still assigned once, and still the sorted one', async () => {
        // Slice 4's rule, re-asserted from this surface. Both surfaces
        // subscribe to the same field, so either one regressing breaks
        // both, and a rule asserted in only one file is a rule half the
        // callers can be moved out from under.
        const method = await loadRunningSessionsBody();
        const assignments = method.match(/^\s*runningSessions = /gm) || [];
        expect(assignments).toHaveLength(1);
        expect(method).toContain('runningSessions = sortRunningSessionsByWork');
    });

    test('TWELVE TICKS ON A FAILING PROBE cost the DOM nothing either', async () => {
        // THE MEASURED HALF, and the one a shape assertion cannot give.
        // Before the fix this removed and re-added the whole NEEDS
        // ATTENTION block twelve times over.
        list = mountList({});
        const failing = {
            ...fixtureHost(fleet({})),
            listAttachableSessions: async () => {
                throw new Error('tmux did not answer');
            },
            listSessions: async () => {
                throw new Error('tmux did not answer');
            },
        };
        sessionStore.useHost(failing);
        await tick();
        await settle();
        expect(list.container.querySelector('.running-sessions-attention'))
            .not.toBeNull();
        const watcher = watchMutations(list.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            await tick();
            await settle();
        }
        expect(watcher.stop()).toEqual({ records: 0, nodes: 0 });
        // NEGATIVE CONTROL: the block is still there, so the zero is not
        // a zero about an empty container.
        expect(list.container.querySelector('.running-sessions-attention'))
            .not.toBeNull();
    });
});
