/**
 * Everything outside the project tree that the project tree reaches.
 *
 * ONE SEAM, INJECTED, so the whole surface is drivable from a test with
 * no `window`, no legacy singleton and no server. The pattern is slice
 * 2's `RecentHost`; this one has more members because the tree is where
 * NAVIGATION happens, and navigation is the thing slice 4 is least
 * allowed to break.
 *
 * WHY NAVIGATION STAYS IN `launchpad.js` AND IS ONLY CALLED FROM HERE.
 * `openProjectByName` calls `Router.rejectTarget(name)` on a miss, and
 * `selectProject` is gated by `_resolvingDeepLink` so that resolving a
 * deep link can never CREATE a session. That guard is a cross-cutting
 * contract every slice has to preserve, and the cheapest way to preserve
 * it is not to move it: the tree calls `selectProject` and the guard
 * stays exactly where it is, still the only thing that decides. A
 * component that re-implemented the navigation would be a second
 * decision-maker, and the two would disagree the first time either
 * changed.
 *
 * NO METHOD HERE IS RESOLVED AT IMPORT. `browserProjectTreeHost()`
 * builds an object of closures, each of which looks its global up when
 * CALLED. That is the rule the whole bundle is under: loading it does no
 * work and reads no global. It is also what makes the host survive the
 * legacy singleton being replaced under it, which slice 7 will do.
 */
import type { ProjectRow } from '../sessions/types';
import { sessionDisplayLabel } from '../sessions/session-label';
import { t } from '../i18n/index.svelte';
import type { TreeSessionRow } from './project-groups';
import { browserCreateHost } from './create-host';
import { browserModals } from './modals';
import {
    archiveProjectFlow,
    editProjectFlow,
    unarchiveProjectFlow,
} from './project-actions';
import { attachRunningSession, returnToActiveSession } from './navigation';
import { browserNavHost } from './nav-host';
import { explainRefusedProject, type PresenceRow } from './status-report';
import { presenceFor } from './project-node';
import { sessionStore } from '../sessions/store.svelte';

/** The legacy launchpad singleton, as this file uses it. */
interface LegacyLaunchpad {
    selectProject?: (project: ProjectRow) => unknown;
    loadProjects?: () => Promise<unknown>;
}

/** What the tree can ask the rest of the app to do. */
export interface ProjectTreeHost {
    /**
     * Open a project. Refused rows never reach this: see `explainRefused`.
     * Routes into `Launchpad.selectProject`, so the `_resolvingDeepLink`
     * guard still decides.
     */
    selectProject(project: ProjectRow): void;
    /**
     * Say out loud that a MISSING or CANNOT DETERMINE row refuses to open.
     *
     * REFUSING IS NOT THE SAME AS DOING NOTHING. This used to be a bare
     * `return`: the click was swallowed with no message, no log line and
     * no request, so the row presented as a button that does nothing.
     */
    explainRefused(project: ProjectRow, el: Element | null): void;
    editProject(project: ProjectRow): void;
    archiveProject(name: string): Promise<void>;
    unarchiveProject(name: string): Promise<void>;
    /** Jump into a session this browser already has a backend for. */
    returnToActive(sessionId: string | null): Promise<void>;
    /** Open or adopt a session by tmux name. */
    attachSession(name: string): Promise<void>;
    /** Restart an ENDED row: a NEW session, never a resurrection. */
    restartEnded(row: TreeSessionRow): Promise<void>;
    /** Soft-archive an ended row's stored record. Never a delete. */
    archiveRecord(sessionUuid: string | null): Promise<void>;
    /** The string a HUMAN should see for one session row. */
    displayLabel(row: TreeSessionRow): string;
    /** Re-fetch the project list, carrying the archive filter. */
    reloadProjects(): Promise<void>;
}

/** The compiled tree's own namespace, as this file uses it. */
interface WebNamespace {
    launchpad?: {
        restartRecentSession?: (opts: unknown) => Promise<unknown>;
        archiveSessionRecord?: (uuid: string | null) => Promise<unknown>;
        loadProjects?: (includeArchived: boolean) => Promise<unknown>;
    };
}

/** The `window`, or undefined in a realm that has none. */
function win(): (Window & typeof globalThis) | undefined {
    return typeof window === 'undefined' ? undefined : window;
}

/** The legacy singleton, looked up on every call. */
function legacy(): LegacyLaunchpad | null {
    const w = win() as unknown as { Launchpad?: LegacyLaunchpad } | undefined;
    return (w && w.Launchpad) || null;
}

/** This bundle's own namespace, looked up on every call. */
function web(): WebNamespace | null {
    const w = win() as unknown as { CloudeWeb?: WebNamespace } | undefined;
    return (w && w.CloudeWeb) || null;
}

/**
 * Report that something the tree needed was not there.
 *
 * Description: LOUD, NEVER SILENT. Every member below degrades to doing
 *   nothing when the legacy singleton is missing, and a click that does
 *   nothing for a reason nobody logged is indistinguishable from a
 *   broken app. This is a diagnostic, not user copy.
 * Inputs: what - the member that was absent.
 * Output: void.
 * Example: missing('selectProject')
 */
function missing(what: string): void {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('CloudeWeb: the project tree could not reach', what);
    }
}

/**
 * Build the host the real browser uses.
 *
 * Description: closures over nothing. Each member resolves its global
 *   when called, so this may be built at any time, including before the
 *   legacy tree has finished loading.
 * Inputs: none.
 * Output: ProjectTreeHost.
 * Example: const host = browserProjectTreeHost();
 */
export function browserProjectTreeHost(): ProjectTreeHost {
    return {
        selectProject(project: ProjectRow): void {
            const lp = legacy();
            if (!lp || typeof lp.selectProject !== 'function') {
                missing('selectProject');
                return;
            }
            lp.selectProject(project);
        },
        // THE COMPILED PATH, NOT THE DELETED LEGACY METHOD. This reached
        // for `window.Launchpad._explainRefusedProject` until now. Slice 7
        // deleted that method with client/js/launchpad.js and `shim.ts`
        // republished ten members that do not include it, so the guard
        // below always took its `missing()` branch and CLICKING A REFUSED
        // PROJECT ROW SAID NOTHING AT ALL - logged, never thrown, and
        // invisible to every unit test because the tree's tests hand in a
        // recorder and assert what the row ASKED FOR. Identical to the two
        // `running-host.ts` already rewired for the same reason, one file
        // over; it survived that round because the shim's scanner could
        // not see a member reached through `legacy()`.
        //
        // `el` IS UNUSED AND THE PARAMETER STAYS. The legacy method
        // anchored its bubble to the row; `explainRefusedProject` reports
        // through the launchpad's one inline error line instead. Dropping
        // the parameter would change this seam's shape for every caller
        // and every test double to delete an argument, which is not what
        // this fix is.
        explainRefused(project: ProjectRow, el: Element | null): void {
            void el;
            // `ProjectPresenceRow` declares only `raw_path` and `root`
            // plus an index signature, so `presence` / `presence_detail`
            // reach it through that signature and TS sees no overlap with
            // `PresenceRow`. Narrowed HERE, at the seam, which is what
            // `project-node.ts` already does for the same two fields off
            // the same row; widening either interface to make this
            // implicit would stop the checker objecting the next time the
            // wrong row is passed.
            const presence = presenceFor(project, sessionStore.projectPresence) as
                PresenceRow | null;
            explainRefusedProject(project, presence, t);
        },
        // SLICE 6 MOVED THESE THREE INTO THIS TREE. They used to be
        // methods on the legacy singleton and are now
        // `project-actions.ts`, so the tree calls them directly instead
        // of bouncing out to `window.Launchpad` and back. The host
        // members stay, because the tree's tests drive this seam and
        // because a later surface may want to inject a recorder.
        editProject(project: ProjectRow): void {
            void editProjectFlow(browserCreateHost(), browserModals(), t, project);
        },
        async archiveProject(name: string): Promise<void> {
            await archiveProjectFlow(browserCreateHost(), t, name);
        },
        async unarchiveProject(name: string): Promise<void> {
            await unarchiveProjectFlow(browserCreateHost(), t, name);
        },
        async returnToActive(sessionId: string | null): Promise<void> {
            // THE COMPILED PATH, NOT THE DELETED LEGACY METHOD. See the
            // same two members in running-host.ts for the full account:
            // slice 7 deleted these off `window.Launchpad` and `shim.ts`
            // never republished them, so both guards below always took
            // their `missing()` branch and a click on a session row went
            // nowhere. `navigation.ts` carries the ported paths.
            await returnToActiveSession(sessionId, browserNavHost(), t);
        },
        async attachSession(name: string): Promise<void> {
            await attachRunningSession(name, browserNavHost(), t);
        },
        async restartEnded(row: TreeSessionRow): Promise<void> {
            // THE SAME IMPLEMENTATION THE RECENT ROWS USE. Slice 2 moved
            // it into the compiled tree and exported it precisely so this
            // surface would not keep a second copy: one restart plan, one
            // three-outcome notice, on both rows.
            const w = web();
            const fn = w && w.launchpad && w.launchpad.restartRecentSession;
            if (typeof fn !== 'function') {
                missing('restartRecentSession');
                return;
            }
            await fn({
                sessionUuid: row.session_uuid || null,
                title: (row.title && String(row.title).trim()) || '',
                workingDir: row.working_dir || '',
                agentType: row.agent_type || '',
            });
        },
        async archiveRecord(sessionUuid: string | null): Promise<void> {
            const w = web();
            const fn = w && w.launchpad && w.launchpad.archiveSessionRecord;
            if (typeof fn !== 'function') {
                missing('archiveSessionRecord');
                return;
            }
            await fn(sessionUuid);
        },
        displayLabel(row: TreeSessionRow): string {
            // SLICE 5 MOVED THIS OUT OF `launchpad.js`. It used to call
            // `Launchpad._sessionDisplayLabel`, which was deleted with the
            // running-sessions list; the rule itself never lived there
            // either - it resolves through `client/js/session-label.js`,
            // the shared module the sidebar row, the tab title, the
            // in-page header and the toast cards all read. Calling it
            // directly is one hop fewer and one fewer thing to delete in
            // slice 7. Reimplementing the fallback chain here would be a
            // third answer to "what is this session called".
            return sessionDisplayLabel(row);
        },
        async reloadProjects(): Promise<void> {
            const lp = legacy();
            if (!lp || typeof lp.loadProjects !== 'function') {
                missing('loadProjects');
                return;
            }
            await lp.loadProjects();
        },
    };
}
