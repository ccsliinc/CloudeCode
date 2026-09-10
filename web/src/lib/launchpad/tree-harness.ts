/**
 * Mount the real ProjectTree against the real store, for a test.
 *
 * ONE HARNESS, SHARED BY EVERY COMPONENT TEST IN THIS SLICE, so a
 * behaviour test and the mutation count are measuring the SAME thing. If
 * the counting test built its own tree, a difference between the two
 * setups would silently become part of the number, and nobody would be
 * able to tell a real improvement from a cheaper fixture.
 *
 * IT DRIVES THE STORE, NOT THE COMPONENT'S PROPS. Every field the tree
 * paints is written onto `sessionStore`, exactly as a poll tick writes
 * it, and the component is given none of it. That is the whole
 * subscription under test: a props-driven fixture would prove that
 * Svelte updates props, which nobody doubted.
 *
 * THE HOST IS A RECORDER. Navigation, archive and restart all leave this
 * tree through `ProjectTreeHost`, so the harness hands in a stub that
 * records the calls. A test then asserts what the tree ASKED FOR rather
 * than what happened next, which is the only half of it this slice owns.
 */
import { mount, unmount } from 'svelte';

import ProjectTree from './ProjectTree.svelte';
import { sessionStore } from '../sessions/store.svelte';
import { treeCollapse } from './tree-collapse.svelte';
import { uiPrefs } from '../ui/prefs.svelte';
import type { ProjectChromeControl } from './project-chrome-control';
import type { ProjectTreeHost } from './project-tree-host';
import type { TreeSessionRow } from './project-groups';
import type {
    ProjectAuthority,
    ProjectPresenceRow,
    ProjectRow,
    RunningSessionRow,
    SessionRecord,
} from '../sessions/types';

/** One recorded call out of the tree. */
export interface HostCall {
    method: string;
    arg: unknown;
}

/** A host that records rather than acts. */
export interface RecordingHost extends ProjectTreeHost {
    calls: HostCall[];
}

/**
 * Build a host that records every call and performs none of them.
 *
 * Description: `displayLabel` is the exception - it must return a real
 *   string or the rows render blank, so it reproduces the legacy
 *   fallback chain's LAST rung (strip the `cloude_` prefix) rather than
 *   recording. That is the rung a session with no label actually takes.
 * Inputs: none. Output: RecordingHost.
 * Example: const host = recordingHost();
 */
export function recordingHost(): RecordingHost {
    const calls: HostCall[] = [];
    const note = (method: string, arg: unknown) => {
        calls.push({ method, arg });
    };
    return {
        calls,
        selectProject: (p) => note('selectProject', p),
        explainRefused: (p) => note('explainRefused', p),
        editProject: (p) => note('editProject', p),
        archiveProject: async (n) => { note('archiveProject', n); },
        unarchiveProject: async (n) => { note('unarchiveProject', n); },
        returnToActive: async (id) => { note('returnToActive', id); },
        attachSession: async (n) => { note('attachSession', n); },
        restartEnded: async (r) => { note('restartEnded', r); },
        archiveRecord: async (u) => { note('archiveRecord', u); },
        displayLabel: (row: TreeSessionRow) => {
            const label = typeof row.label === 'string' ? row.label.trim() : '';
            if (label) return label;
            const name = row.name || '';
            return name.startsWith('cloude_') ? name.slice('cloude_'.length) : name;
        },
        reloadProjects: async () => { note('reloadProjects', null); },
    };
}

/** A chrome control that records instead of touching the heading. */
export interface RecordingControl extends ProjectChromeControl {
    toggleStates: Array<{ on: boolean; title: string }>;
    /** Fire the handler the tree registered, as a real click would. */
    click(): void;
}

/**
 * Build a chrome control that records the writes and holds the handler.
 *
 * Inputs: none. Output: RecordingControl.
 * Example: const control = recordingControl(); control.click();
 */
export function recordingControl(): RecordingControl {
    const toggleStates: Array<{ on: boolean; title: string }> = [];
    let handler: (() => void) | null = null;
    return {
        toggleStates,
        setArchivedToggle(on, title) { toggleStates.push({ on, title }); },
        bindArchivedToggle(onClick) { handler = onClick; },
        click() { if (handler) handler(); },
    };
}

/** Everything a test wants to put on the store before it paints. */
export interface TreeFixture {
    projects?: ProjectRow[];
    presence?: Map<string, ProjectPresenceRow>;
    authority?: ProjectAuthority | null;
    archivedFetchOk?: boolean | null;
    runningSessions?: RunningSessionRow[];
    sessionRecords?: SessionRecord[];
    sessionAttribution?: Map<string, SessionRecord>;
    sessionAttributionByInstance?: Map<string, SessionRecord>;
    sessionAttributionAmbiguous?: Set<string>;
    sessionAttributionListingOk?: boolean;
    sessionAttributionListingDetail?: string | null;
    workStampByName?: Map<string, string>;
}

/**
 * Write one fixture onto the store, the way a poll tick would.
 *
 * Description: EVERY FIELD IS ASSIGNED, including the ones the fixture
 *   left out, so a test cannot accidentally inherit the previous one's
 *   data. Assignment is what a tick does; the store's setters are the
 *   same ones `loadRunningSessions` uses.
 * Inputs: fixture - what to put on the store.
 * Output: void.
 * Example: applyFixture({projects: [{name: 'api', id: 1}]})
 */
export function applyFixture(fixture: TreeFixture): void {
    sessionStore.projects = fixture.projects ?? [];
    sessionStore.projectPresence = fixture.presence ?? new Map();
    sessionStore.projectAuthority = fixture.authority === undefined
        ? { mode: 'db', degraded: false, writable: true }
        : fixture.authority;
    sessionStore.archivedFetchOk = fixture.archivedFetchOk ?? null;
    sessionStore.runningSessions = fixture.runningSessions ?? [];
    sessionStore.sessionRecords = fixture.sessionRecords ?? [];
    sessionStore.sessionAttribution = fixture.sessionAttribution ?? new Map();
    sessionStore.sessionAttributionByInstance =
        fixture.sessionAttributionByInstance ?? new Map();
    sessionStore.sessionAttributionAmbiguous =
        fixture.sessionAttributionAmbiguous ?? new Set();
    sessionStore.sessionAttributionListingOk =
        fixture.sessionAttributionListingOk ?? true;
    sessionStore.sessionAttributionListingDetail =
        fixture.sessionAttributionListingDetail ?? null;
    sessionStore.workStampByName = fixture.workStampByName ?? new Map();
}

/** A mounted tree, and everything a test needs to drive it. */
export interface MountedTree {
    container: HTMLElement;
    host: RecordingHost;
    control: RecordingControl;
    /** Tear the component down and clear the store and the fold state. */
    destroy(): void;
}

/**
 * Mount the tree into a fresh container, IN the document.
 *
 * Description: IN THE DOCUMENT, and that is not cosmetic. `isConnected`
 *   answers false for every node in a detached tree, so a test asserting
 *   that an open menu SURVIVED a tick would fail for a reason that has
 *   nothing to do with the tick. `document.activeElement` needs it too.
 *   `destroy()` removes the container, so one test's nodes can never be
 *   found by the next one's `querySelector`.
 * Inputs: fixture - the store state to paint from.
 * Output: MountedTree.
 * Example: const tree = mountTree({projects: [...]}); tree.destroy();
 */
export function mountTree(fixture: TreeFixture = {}): MountedTree {
    treeCollapse.resetForTests();
    uiPrefs.resetForTests();
    applyFixture(fixture);
    const container = document.createElement('div');
    container.id = 'project-list';
    document.body.appendChild(container);
    const host = recordingHost();
    const control = recordingControl();
    const instance = mount(ProjectTree, {
        target: container,
        props: { host, control },
    });
    return {
        container,
        host,
        control,
        destroy() {
            unmount(instance, { outro: false });
            container.remove();
            sessionStore.reset();
            treeCollapse.resetForTests();
            uiPrefs.resetForTests();
        },
    };
}

/**
 * How many nodes a NodeList holds, counting every descendant.
 *
 * Description: see `watchMutations` for why the descendants matter. A
 *   text node counts as one and has no children to walk.
 * Inputs: list - a record's `addedNodes` or `removedNodes`.
 * Output: number.
 * Example: subtreeSize(record.addedNodes)  // 794
 */
/**
 * Count everything a MutationObserver saw, records AND nodes.
 *
 * Description: TWO NUMBERS, BECAUSE THEY MEASURE DIFFERENT COSTS AND
 *   ONE OF THEM FLATTERS EACH SIDE. A whole-subtree `innerHTML` write is
 *   ONE childList record carrying hundreds of nodes; a reactive
 *   attribute change is one record carrying none. Reporting only records
 *   makes a subtree replacement look like a single cheap event;
 *   reporting only nodes makes an attribute change look free. Both are
 *   counted, and the assertions name which one they are about.
 *
 *   NODES ARE COUNTED WITH THEIR DESCENDANTS, and without that the
 *   legacy side under-reports by more than an order of magnitude. A
 *   `MutationRecord` names only the DIRECT children that moved, so an
 *   `innerHTML` write over nine project nodes reports nine added and
 *   nine removed - not the ~800 elements those nine actually carry. The
 *   thing that costs is parsing and building the whole subtree, so the
 *   whole subtree is what is counted.
 *
 *   THE CALLBACK IS WHERE RECORDS ARE COLLECTED, AND THAT IS THE WHOLE
 *   TRAP. `takeRecords()` drains the queue - but so does DELIVERY. The
 *   observer's callback fires on a microtask, and any `await` at all
 *   lets it run and empties the queue, so a test that awaited a settle
 *   and then called `takeRecords()` reads ZERO and looks like a perfect
 *   score. It cost this file three failing tests to find. Records are
 *   accumulated in the callback and `takeRecords()` is drained at the
 *   end for anything not yet delivered.
 * Inputs: container - the element to watch.
 * Output: a handle with `stop()`, which answers {records, nodes}.
 * Example: const w = watchMutations(el); ...; const {records} = w.stop();
 */
function subtreeSize(list: NodeList): number {
    let total = 0;
    for (const node of Array.from(list)) {
        total += 1;
        if (node.nodeType === 1) {
            total += (node as Element).querySelectorAll('*').length;
        }
    }
    return total;
}

export function watchMutations(container: HTMLElement): {
    stop(): { records: number; nodes: number };
} {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
        seen.push(...batch);
    });
    observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });
    return {
        stop() {
            seen.push(...observer.takeRecords());
            observer.disconnect();
            let nodes = 0;
            for (const record of seen) {
                nodes += subtreeSize(record.addedNodes);
                nodes += subtreeSize(record.removedNodes);
            }
            return { records: seen.length, nodes };
        },
    };
}

/**
 * Let Svelte's scheduler run, so a store write reaches the DOM.
 *
 * Description: Svelte 5 batches effects into a microtask, so a write and
 *   an assertion in one turn would read the DOM before the update ran.
 *   Two awaited microtasks is enough for a nested component tree; a
 *   timer would make the mutation count depend on the clock.
 * Inputs: none. Output: Promise<void>.
 * Example: await settle();
 */
export async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
