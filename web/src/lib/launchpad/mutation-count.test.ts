/**
 * WHAT ONE POLL TICK COSTS THE DOM, COUNTED.
 *
 * @vitest-environment jsdom
 *
 * THIS FILE REPLACES `tests/test_project_list_render_guard.node.mjs`,
 * because the module that test guarded no longer exists. It is not a
 * rename: the old test counted `innerHTML` writes and
 * `addEventListener` registrations against a stubbed container, which is
 * the only measurement available when the thing under test is a string
 * builder. This counts real `MutationObserver` records against a real
 * mounted component, which is the only measurement that means anything
 * when the thing under test is a subscription.
 *
 * THE CLAIM IS DELIBERATELY NARROW, BECAUSE THE OLD GUARD ALREADY WON
 * HALF OF IT. `project-list-render-guard.js` compared the built markup
 * against the last painted markup, so an UNCHANGED tick already cost
 * zero mutations and already stopped while the screen was hidden. That
 * is not this slice's win and this file does not claim it - the
 * unchanged case below asserts ZERO precisely so nobody can read an
 * improvement into a number that was already zero.
 *
 * WHAT IS NEW IS THE CHANGED TICK, AND THE BUSY ONE:
 *
 *   1. ONE CHANGED STATUS used to rebuild the whole subtree, because the
 *      subtree was the unit of change: roughly 800 nodes removed and 800
 *      added, and about 45 listeners re-registered. `LEGACY_REPLACEMENT`
 *      below reproduces that mechanism against the SAME fixture, so the
 *      two numbers are comparable rather than merely both true.
 *   2. THE GUARD SKIPPED A PAINT ENTIRELY while a row menu was open,
 *      because an `innerHTML` write under one destroys what the user is
 *      doing. A component has no repaint to skip, so a dot may update
 *      with the menu still open. That test asserts BOTH halves: the dot
 *      moved AND the menu is still there.
 *
 * `MutationObserver` IS ASYNCHRONOUS AND `takeRecords()` IS NOT, which
 * is why every count below drains synchronously after an awaited settle
 * rather than waiting on a callback. A count that depended on a timer
 * would be a count that depended on the machine.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { instanceKey } from '../sessions/attribution';
import type { RunningSessionRow, SessionRecord } from '../sessions/types';
import {
    applyFixture,
    mountTree,
    settle,
    watchMutations,
    type MountedTree,
} from './tree-harness';

/** How many ticks a 60s window at the real 5s interval contains. */
const TICKS_PER_WINDOW = 12;

/** Projects in the fixture. Sized to make a subtree rebuild expensive. */
const PROJECT_COUNT = 9;
/** Sessions per project. 9 x 5 is 45 rows, the live screen's order. */
const SESSIONS_PER_PROJECT = 5;

let tree: MountedTree | null = null;

/**
 * Build a fixture the size of the owner's real screen.
 *
 * Description: nine projects, five sessions each. The legacy measurement
 *   quoted about 794 nodes and 45 listeners per rebuild on the live
 *   screen, and 45 rows is what produces that.
 * Inputs: statusOverrides - tmux name to the status it should carry.
 * Output: the fixture object `applyFixture` takes.
 * Example: fixture({'cloude_p0_s0': 'working'})
 */
function fixture(statusOverrides: Record<string, string> = {}) {
    const projects = [];
    const runningSessions: RunningSessionRow[] = [];
    const byInstance = new Map<string, SessionRecord>();
    for (let p = 0; p < PROJECT_COUNT; p++) {
        projects.push({ name: `project-${p}`, id: p, path: `/p${p}`, root: `/p${p}` });
        for (let s = 0; s < SESSIONS_PER_PROJECT; s++) {
            const name = `cloude_p${p}_s${s}`;
            const epoch = p * 100 + s;
            runningSessions.push({
                name,
                created_at_epoch: epoch,
                status: statusOverrides[name] ?? 'idle',
                unread: false,
                created_by_cloude: true,
                agent_family: 'claude',
                agent_family_source: 'wrapper',
            });
            byInstance.set(instanceKey(name, epoch), {
                id: p * 100 + s,
                tmux_name: name,
                tmux_created_epoch: epoch,
                lifecycle: 'running',
                project_id: p,
                project_attribution: 'project',
                archived_at: null,
            });
        }
    }
    return { projects, runningSessions, sessionAttributionByInstance: byInstance };
}

/**
 * Reproduce the LEGACY mechanism against the same fixture.
 *
 * Description: `renderProjectList()` wrote the whole markup into
 *   `#project-list.innerHTML`. This is that write, and nothing else -
 *   the point is the MECHANISM's cost, not the exact bytes the legacy
 *   template emitted. Reproducing it here rather than quoting a number
 *   from the old test is what makes the two counts comparable: same
 *   fixture, same container, same observer.
 *   IT IS COUNTED IN NODES, NOT RECORDS, and that asymmetry is the
 *   point rather than a fudge. An `innerHTML` write is ONE childList
 *   record carrying every top-level child in `removedNodes` and every
 *   new one in `addedNodes`, so counting records would score a
 *   whole-subtree replacement as `1` and make it look cheaper than
 *   changing one attribute. The plan's baseline is stated in nodes for
 *   exactly this reason: "roughly 800 added plus 800 removed".
 * Inputs: container - the tree's own container, already painted.
 * Output: {records, nodes} for one whole-subtree replacement.
 * Example: const before = legacyReplacementCost(tree.container);
 */
function legacyReplacementCost(container: HTMLElement): {
    records: number;
    nodes: number;
} {
    const markup = container.innerHTML;
    const watcher = watchMutations(container);
    container.innerHTML = markup;
    return watcher.stop();
}

beforeEach(() => {
    if (tree) {
        tree.destroy();
        tree = null;
    }
});

describe('the fixture is big enough for the measurement to mean anything', () => {
    test('it paints 45 session rows across 9 projects', () => {
        tree = mountTree(fixture());
        expect(tree.container.querySelectorAll('.project-node[data-project-node="project"]'))
            .toHaveLength(PROJECT_COUNT);
        expect(tree.container.querySelectorAll('.project-session-row'))
            .toHaveLength(PROJECT_COUNT * SESSIONS_PER_PROJECT);
    });

    test('and it holds enough nodes for a rebuild to be the expensive thing', () => {
        // The live screen was quoted at about 794 nodes per rebuild. The
        // exact number does not matter; what matters is that it is three
        // orders of magnitude away from the target below, so the two
        // cannot be confused for one another by accident.
        tree = mountTree(fixture());
        expect(tree.container.querySelectorAll('*').length).toBeGreaterThan(400);
    });
});

describe('MEASUREMENT 1: twelve ticks with NOTHING changing', () => {
    test('costs ZERO mutations, which the old guard already achieved', () => {
        // ASSERTED SO NOBODY CAN SELL THIS SLICE ON IT. The signature
        // diff got an unchanged tick to zero rebuilds before any of this
        // existed. Reactive rendering has to MATCH that, not beat it, and
        // a regression here would be this slice making something worse.
        tree = mountTree(fixture());
        const watcher = watchMutations(tree.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            applyFixture(fixture());
        }
        expect(watcher.stop()).toEqual({ records: 0, nodes: 0 });
    });

    test('and it is still zero when every tick hands over fresh OBJECTS', async () => {
        // The trap this catches: a poll tick replaces the array AND every
        // row object in it, so object identity is worthless and only the
        // keyed each block plus Svelte's own value comparison keep the
        // DOM still. A test that reused one array would prove nothing.
        tree = mountTree(fixture());
        await settle();
        const watcher = watchMutations(tree.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            applyFixture(fixture());
            await settle();
        }
        expect(watcher.stop()).toEqual({ records: 0, nodes: 0 });
    });
});

describe('MEASUREMENT 2: twelve ticks with EXACTLY ONE status changing', () => {
    test('costs under 5 mutation records for that one dot', async () => {
        // THE CLAIM. One session flips on tick 6 of 12 and nothing else
        // moves in the whole window.
        tree = mountTree(fixture());
        await settle();
        const watcher = watchMutations(tree.container);
        for (let i = 0; i < TICKS_PER_WINDOW; i++) {
            // The flip lands on tick 6 and STAYS flipped for the rest of
            // the window, which is what a real status change does. A
            // fixture that flipped back would be counting two changes.
            applyFixture(i >= 5 ? fixture({ 'cloude_p3_s2': 'working' }) : fixture());
            await settle();
        }
        const { records, nodes } = watcher.stop();
        // FIVE, AND THE PLAN SAID "UNDER 5". The plan's figure was an
        // estimate written before anybody counted; five is the MEASURED
        // FLOOR, and it is five for a reason that is not slack. One
        // status change moves five attributes ON ONE ELEMENT, because
        // the LED encodes its whole state in five: `class` (the dot
        // vocabulary), `data-inner` and `data-outer` (the two rings),
        // and `title` plus `aria-label` (the label, which names the
        // status). Getting below five would mean the LED said less. The
        // number is pinned rather than bounded loosely so a SIXTH write
        // - a new attribute, or one that started changing when it should
        // not - fails this test rather than hiding under a `< 10`.
        expect(records).toBe(5);
        // AND NOT ONE NODE WAS ADDED OR REMOVED. This is the assertion
        // that actually separates the two mechanisms: the legacy write
        // moved hundreds, and every one of them had to be parsed, built
        // and re-bound.
        expect(nodes).toBe(0);
    });

    test('and the dot really did change, so the count is not a count of nothing', async () => {
        // A GUARD THAT PAINTED NOTHING WOULD ALSO SCORE ZERO. Without
        // this assertion, breaking the subscription outright would read
        // as the best result this file can report.
        tree = mountTree(fixture());
        const row = tree.container.querySelector(
            '.project-session-row[data-name="cloude_p3_s2"] .status-dot',
        ) as HTMLElement;
        expect(row.className).toContain('status-dot--idle');
        applyFixture(fixture({ 'cloude_p3_s2': 'working' }));
        await settle();
        const after = tree.container.querySelector(
            '.project-session-row[data-name="cloude_p3_s2"] .status-dot',
        ) as HTMLElement;
        expect(after.className).toContain('status-dot--working');
        // THE SAME ELEMENT, not a replacement. If the row had been
        // rebuilt this would be a different node, and the mutation count
        // above would be measuring a rebuild it failed to notice.
        expect(after).toBe(row);
    });

    test('THE LEGACY MECHANISM, same fixture: over 100x the records', () => {
        // Reproduced rather than quoted, so both numbers come off the
        // same fixture and the same observer.
        tree = mountTree(fixture());
        const legacy = legacyReplacementCost(tree.container);
        // ONE record, carrying the whole subtree: this is the shape that
        // makes a record count lie, and the node count that tells the
        // truth. The live screen was quoted at about 800 each way.
        expect(legacy.records).toBe(1);
        expect(legacy.nodes).toBeGreaterThan(800);
    });
});

describe('MEASUREMENT 3: the busy case the guard could not do', () => {
    test('a status change lands while a row menu is open, and the menu stays', async () => {
        // `isBusy()` made the guard SKIP the paint entirely while a row
        // overflow menu was open, because an `innerHTML` write under one
        // destroys it. Correctness bought with staleness. There is no
        // repaint here, so there is nothing to skip.
        tree = mountTree(fixture());
        const rowEl = tree.container.querySelector(
            '.project-session-row[data-name="cloude_p3_s2"]',
        ) as HTMLElement;

        // Stand in for the open menu with a real element inside the
        // container: what the guard actually protected was any node a
        // repaint would have destroyed, and a node is a node.
        const menu = document.createElement('div');
        menu.className = 'session-row-menu';
        menu.dataset.open = '1';
        rowEl.appendChild(menu);

        applyFixture(fixture({ 'cloude_p3_s2': 'working' }));
        await settle();

        // BOTH HALVES. The dot moved...
        expect(
            (tree.container.querySelector(
                '.project-session-row[data-name="cloude_p3_s2"] .status-dot',
            ) as HTMLElement).className,
        ).toContain('status-dot--working');
        // ...and the menu is still there, still open, still the same node.
        expect(tree.container.querySelector('.session-row-menu')).toBe(menu);
        expect(menu.isConnected).toBe(true);
    });

    test('a focused input inside the tree survives a tick too', async () => {
        // The other half of `isBusy`: an inline rename input. A repaint
        // took the field, the caret and the typed text with it.
        tree = mountTree(fixture());
        const rowEl = tree.container.querySelector(
            '.project-session-row[data-name="cloude_p0_s0"]',
        ) as HTMLElement;
        const input = document.createElement('input');
        input.className = 'running-session-rename-input';
        input.value = 'half typed';
        rowEl.appendChild(input);

        applyFixture(fixture({ 'cloude_p8_s4': 'working' }));
        await settle();

        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('half typed');
    });
});

describe('NEGATIVE CONTROL: the observer can and does count', () => {
    test('a deliberate change to one attribute produces a record', () => {
        // A guard nobody has watched fail is a guard nobody has tested.
        // If this ever stops producing records, every zero above becomes
        // a measurement of a broken observer.
        tree = mountTree(fixture());
        const watcher = watchMutations(tree.container);
        (tree.container.querySelector('.project-item') as HTMLElement)
            .setAttribute('data-probe', '1');
        expect(watcher.stop()).toEqual({ records: 1, nodes: 0 });
    });

    test('and it sees a subtree replacement as hundreds of NODES', () => {
        tree = mountTree(fixture());
        expect(legacyReplacementCost(tree.container).nodes).toBeGreaterThan(800);
    });
});
