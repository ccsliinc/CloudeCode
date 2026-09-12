/**
 * Everything outside the create, clone, edit and archive flows that they
 * reach, as one injected object.
 *
 * WHY A HOST AND NOT A DIRECT `window.API` CALL. These flows WRITE, and
 * what has to be tested about them is the ORDER in which they write: that
 * nothing is created before the folder step answers, that a cancelled
 * step creates nothing at all, that a refused name is re-asked rather
 * than rewritten. A flow that reached for globals itself could only be
 * exercised in a browser against a real server, which is the one place
 * those orderings are hardest to check and most expensive to get wrong.
 * Injected, a test hands in a recorder and reads back exactly what was
 * called, with what, and in what order.
 *
 * IT IS A SEAM, NOT AN ADAPTER. Every member has the argument list the
 * underlying call already has, and no response is reshaped. The one
 * exception is `confirm`, which is deliberately NARROWER than
 * `App.showConfirmModal`: these flows only ever ask a yes/no with a
 * title, a message, a detail and two labels.
 *
 * RESOLVED LAZILY, PER CALL. `main.ts` promises that loading the bundle
 * touches no global, and a module-scope `window.API` read would break
 * that contract the way a module-scope `localStorage` read already broke
 * it once. Every member here resolves its global at CALL time.
 *
 * `showConfirmModal` IS NOT RE-IMPLEMENTED. `window.App.showConfirmModal`
 * is the one confirmation modal in this app - it owns the escaping, the
 * escape key, the click-outside and the focus - and this reaches it. A
 * Svelte copy would be a second implementation of a dialog whose whole
 * value is that there is one of it.
 */
import { hostWindow } from '../sessions/env';
import { withNav, type NavToken } from './nav-generation';
import { t } from '../i18n/index.svelte';
import { browserNavHost } from './nav-host';
import { detachAndCreateNew, selectProject } from './navigation';
import { showError, updateStatus } from './status-report';
import type { ProjectRow } from '../sessions/types';
import type { ClonedProject } from './modal-types';

/** The provider/wrapper choice the launch picker resolves. */
export interface ProviderChoice {
    /** A configured wrapper id, when the user picked a wrapper row. */
    wrapperId?: string | null;
    /** A pinned family name, when the user picked a family row. */
    agentType?: string | null;
    /** An OpenRouter model id, omitted for claude. */
    model?: string | null;
    [key: string]: unknown;
}

/** The `POST /sessions` body, as these flows build it. */
export type CreatePayload = Record<string, unknown>;

/** As much of the created session as these flows read. */
export interface CreatedSession {
    working_dir?: string | null;
    [key: string]: unknown;
}

/** Everything the create, clone, edit and archive flows reach. */
export interface CreateHost {
    /** The launch picker. Null means the user cancelled the whole launch. */
    chooseProvider(): Promise<ProviderChoice | null>;
    /** `POST /sessions`. */
    createSession(payload: CreatePayload): Promise<CreatedSession>;
    /** `POST /projects`. Rejects with "already exists" on a collision. */
    createProject(row: {
        name: string;
        path: string;
        description?: string | null;
    }): Promise<unknown>;
    /** `PATCH /projects/{name}`. */
    updateProject(name: string, fields: Record<string, unknown>): Promise<unknown>;
    /** `POST /projects/{name}/archive`. */
    archiveProject(name: string): Promise<unknown>;
    /** `POST /projects/{name}/unarchive`. */
    unarchiveProject(name: string): Promise<unknown>;
    /** `POST /projects/clone`. */
    cloneProject(payload: {
        repoUrl: string;
        parentDir: string;
        description?: string;
    }): Promise<ClonedProject>;
    /** `GET /browse` with no path: the configured projects root. */
    defaultParentDir(): Promise<string | null>;
    /** The existing folder picker, or null when it is not loaded. */
    folderPicker(): (() => Promise<string | null>) | null;
    /** Refetch `GET /projects` into the store. */
    reloadProjects(): Promise<unknown>;
    /** The projects the store currently holds. */
    projects(): ProjectRow[];
    /** True read, false FAILED to read, null never asked. Three outcomes. */
    projectsListingOk(): boolean | null;
    /** The presence row for a project, by its root or its path. */
    presenceFor(project: ProjectRow): Record<string, unknown> | null;
    /** Enter a project, passing a provider choice already made. */
    selectProject(project: ProjectRow, choice: ProviderChoice | null): Promise<unknown>;
    /** Detach the running session and create anyway, on "already running". */
    detachAndCreateNew(agentType: string | null): unknown;
    /** The xterm cell grid, so the pane is born at the right size. */
    terminalDims(): Record<string, unknown>;
    /** The launchpad's transient status line. */
    updateStatus(message: string): void;
    /** The launchpad's inline, non-blocking error line. */
    showError(message: string): void;
    /** `App.showConfirmModal`. True confirmed, false cancelled. */
    confirm(
        title: string,
        message: string,
        details: string | null,
        primaryLabel: string,
        secondaryLabel: string,
    ): Promise<boolean>;
    /**
     * Tell the rest of the app a session was created.
     *
     * `nav` is the navigation token the flow declared before its POST.
     * It is OPTIONAL on the signature and must not be optional in
     * practice on any path that awaits: `app.js`'s listener waives its
     * stale-navigation check when `detail.nav` is absent, so a flow that
     * forgets one is not refused, it is silently unguarded. See
     * `nav-generation.ts`.
     */
    announceSessionCreated(session: CreatedSession, nav?: NavToken): void;
}

/** The subset of `window.API` these flows call. */
interface LegacyApi {
    createSession(payload: CreatePayload): Promise<CreatedSession>;
    createProject(row: Record<string, unknown>): Promise<unknown>;
    updateProject(name: string, fields: Record<string, unknown>): Promise<unknown>;
    archiveProject(name: string): Promise<unknown>;
    unarchiveProject(name: string): Promise<unknown>;
    cloneProjectFromGithub(payload: Record<string, unknown>): Promise<ClonedProject>;
    browseDirectory(path?: string): Promise<{ path?: string | null }>;
}

/**
 * The subset of `window.Launchpad` these flows call.
 *
 * SLICE 7 CUT THIS TO ONE MEMBER. `selectProject`, `detachAndCreateNew`,
 * `_getTerminalDims`, `updateStatus` and `showError` all live in this
 * tree now and are imported rather than read off a global, which is one
 * fewer way for the compiled half to depend on the legacy half. What is
 * left is the launch picker, which is genuinely still a classic script
 * (`client/js/providers.js`) and publishes itself onto the shim.
 */
interface LegacyLaunchpad {
    showProviderModal(): Promise<ProviderChoice | null>;
}

/**
 * The host that talks to the running app.
 *
 * Description: resolves `window.API`, `window.App`, `window.Launchpad`
 *   and `window.FolderPickerModal` per call. A member whose global is
 *   absent throws rather than returning a plausible nothing, because
 *   every one of these is a WRITE: a create that quietly did not happen
 *   is the worst outcome on this screen. The two exceptions are
 *   `folderPicker`, which reports absence as null because typing a path
 *   is still a complete way through, and `defaultParentDir`, which
 *   reports it as CANNOT DETERMINE for the same reason.
 * Inputs: none.
 * Output: CreateHost.
 * Example: const host = browserCreateHost();
 */
export function browserCreateHost(): CreateHost {
    const win = () => hostWindow() as unknown as Record<string, unknown> | undefined;
    const api = (): LegacyApi => (win()?.API as LegacyApi);
    const lp = (): LegacyLaunchpad => (win()?.Launchpad as LegacyLaunchpad);
    const store = () =>
        (win()?.CloudeWeb as { launchpad?: { sessions?: Record<string, unknown> } } | undefined)
            ?.launchpad?.sessions as
            | {
                  projects: ProjectRow[];
                  projectsListingOk: boolean | null;
                  projectPresence: Map<string, Record<string, unknown>>;
              }
            | undefined;

    return {
        chooseProvider: () => lp().showProviderModal(),
        createSession: (payload) => api().createSession(payload),
        createProject: (row) => api().createProject(row),
        updateProject: (name, fields) => api().updateProject(name, fields),
        archiveProject: (name) => api().archiveProject(name),
        unarchiveProject: (name) => api().unarchiveProject(name),
        cloneProject: (payload) => api().cloneProjectFromGithub(payload),
        async defaultParentDir() {
            try {
                const res = await api().browseDirectory();
                return (res && res.path) || null;
            } catch (error) {
                // CANNOT DETERMINE, not "there is no default". The modal
                // shows an empty field with a prompt rather than a guess.
                console.warn('CloudeWeb: default project folder unavailable:', error);
                return null;
            }
        },
        folderPicker() {
            const picker = win()?.FolderPickerModal as
                | { open(options?: Record<string, unknown>): Promise<string | null> }
                | undefined;
            if (!picker || typeof picker.open !== 'function') return null;
            // NO ESCAPER IS INJECTED any more. The picker has carried its
            // own default since it was extracted, and the launchpad copy
            // that used to be passed in is deleted with this slice.
            return () => picker.open();
        },
        reloadProjects: () => {
            const web = win()?.CloudeWeb as
                | { launchpad?: { loadProjects?: (includeArchived?: boolean) => Promise<unknown> } }
                | undefined;
            const load = web?.launchpad?.loadProjects;
            return load ? load() : Promise.resolve();
        },
        projects: () => store()?.projects ?? [],
        projectsListingOk: () => store()?.projectsListingOk ?? null,
        presenceFor(project) {
            const presence = store()?.projectPresence;
            if (!presence) return null;
            const byRoot = project.root ? presence.get(String(project.root)) : undefined;
            const byPath = project.path ? presence.get(String(project.path)) : undefined;
            return (byRoot || byPath || null) as Record<string, unknown> | null;
        },
        selectProject: (project, choice) =>
            selectProject(project, browserNavHost(), t, choice),
        detachAndCreateNew: (agentType) => {
            // The create flow it retries with is passed in rather than
            // imported, because importing it here would close the loop
            // create-flow.ts -> create-host.ts -> create-flow.ts.
            const web = win()?.CloudeWeb as
                | { launchpad?: { createNewSession?: (a: string | null) => Promise<unknown> } }
                | undefined;
            const create = web?.launchpad?.createNewSession;
            return detachAndCreateNew(
                agentType,
                browserNavHost(),
                t,
                create ? (a) => create(a) : () => Promise.resolve(),
            );
        },
        terminalDims: () => browserNavHost().terminalDims(),
        updateStatus,
        showError: (message) => showError(message, t),
        confirm: (title, message, details, primaryLabel, secondaryLabel) => {
            const app = win()?.App as
                | {
                      showConfirmModal(
                          title: string,
                          message: string,
                          details: string | null,
                          primaryLabel: string,
                          secondaryLabel: string,
                      ): Promise<boolean>;
                  }
                | undefined;
            return app!.showConfirmModal(title, message, details, primaryLabel, secondaryLabel);
        },
        announceSessionCreated(session, nav) {
            const w = hostWindow() as unknown as Window | undefined;
            w?.dispatchEvent(
                new CustomEvent('session-created', { detail: withNav({ session }, nav ?? null) }),
            );
        },
    };
}
