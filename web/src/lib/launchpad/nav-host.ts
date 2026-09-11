/**
 * Everything the home screen's navigation reaches outside itself.
 *
 * WHY A SEAM AT ALL, when slices 1 to 6 mostly called `window.API`
 * directly. Because this is the one surface whose CONTRACTS are the
 * product: a deep link must never create a session, a refusal must reach
 * the router's banner, and an adopt must carry the row's label across. A
 * seam is what lets those be asserted with an array and a spy instead of
 * a browser, and every one of them is a bug this app has already shipped
 * once.
 *
 * THE SEAM IS READ PER CALL, NEVER CAPTURED. `window.API`, `window.App`,
 * `window.Router` and `window.TerminalController` are classic scripts
 * that may not have evaluated when this module does, and
 * `TerminalController.term` in particular is null until the first visit
 * to the terminal screen.
 */
import { hostWindow, hostDocument } from '../sessions/env';
import type { ProjectRow, RunningSessionRow } from '../sessions/types';

/** As much of a created or fetched session as this glue reads. */
export interface SessionLike {
    label?: string | null;
    working_dir?: string | null;
    tmux_session?: string | null;
    [key: string]: unknown;
}

/** What `POST /sessions/adopt` answers. */
export interface AdoptResponse {
    session?: SessionLike | null;
    initial_scrollback_b64?: string | null;
    fifo_start_offset?: number | null;
    [key: string]: unknown;
}

/** Everything the navigation glue calls. */
export interface NavHost {
    /** `POST /sessions/adopt`. */
    adoptSession(tmuxName: string, attach: boolean): Promise<AdoptResponse>;
    /** `GET /sessions/{id}`, or the active one when id is null. */
    getSession(
        id?: string | null,
        options?: Record<string, unknown>,
    ): Promise<SessionLike | { session?: SessionLike }>;
    /** `POST /sessions/detach`. */
    detachSession(): Promise<unknown>;
    /** `POST /sessions`. */
    createSession(payload: Record<string, unknown>): Promise<SessionLike>;
    /** `POST /projects`. Rejects with "already exists" on a collision. */
    createProject(row: Record<string, unknown>): Promise<unknown>;
    /** The launch picker. Null means the user cancelled the whole launch. */
    chooseProvider(): Promise<Record<string, unknown> | null>;
    /** The xterm cell grid, so a pane is born at the right size. */
    terminalDims(): Record<string, unknown>;
    /** Refetch `GET /projects` and repaint. */
    reloadProjects(): Promise<unknown>;
    /** Refetch the merged running rows. */
    reloadRunningSessions(): Promise<unknown>;
    /** The rows the store currently holds. */
    runningSessions(): RunningSessionRow[];
    /** This tick's verdict on the two session probes. */
    runningListingOk(): boolean;
    /** Why the listing could not be read, for the log line. */
    runningListingReason(): string | null;
    /** Tell the rest of the app a session was created or adopted. */
    announceSessionCreated(detail: Record<string, unknown>): void;
    /** The router's error banner, which also cleans the URL back to `/`. */
    rejectTarget(name: string): boolean;
    /** Pre-show the terminal screen and measure it. */
    prepareTerminal(): Promise<{ cols: number; rows: number }>;
    /** Hand a fetched session to the terminal controller. */
    returnToExistingTerminal(session: SessionLike): void;
    /** Sleep, so the retry ladder is drivable in a test without a clock. */
    wait(ms: number): Promise<void>;
}

/** The subset of `window.API` this glue calls. */
interface LegacyApi {
    adoptSession(name: string, attach: boolean): Promise<AdoptResponse>;
    getSession(id?: string | null, options?: Record<string, unknown>): Promise<SessionLike>;
    detachSession(): Promise<unknown>;
    createSession(payload: Record<string, unknown>): Promise<SessionLike>;
    createProject(row: Record<string, unknown>): Promise<unknown>;
}

/**
 * How long the layout wait may DELAY a rejoin before giving up on frames.
 *
 * Matches `client/js/terminal-layout-wait.js`'s own `FRAME_TIMEOUT_MS`,
 * which is the module that already solved this for the terminal's connect
 * path. The number is small on purpose: a fit measured a frame early is a
 * slightly wrong grid, and a rejoin that never happens is a dead screen.
 */
const FRAME_TIMEOUT_MS = 250;

/**
 * Yield two animation frames, RACED AGAINST A TIMER.
 *
 * Description: THE BARE `await requestAnimationFrame` THAT USED TO BE
 *   HERE NEVER RESOLVES IN A HIDDEN TAB, and that is gotcha 9 in
 *   CLAUDE.md rather than a theory - a browser does not paint a
 *   backgrounded tab, so it never runs that tab's rAF callbacks and
 *   anything awaiting one hangs there permanently, not slowly. Measured
 *   on this branch in a real browser: a deep link resolved in a
 *   backgrounded tab froze inside `prepareTerminal` and never returned.
 *   The same shape cost this project a terminal that sat on
 *   "Connecting to terminal..." for 35 minutes.
 *
 *   It was ported verbatim from `launchpad.js`, so the defect is MOVED
 *   rather than introduced - and slice 7 is the moment it became
 *   measurable, because the whole path is now reachable from a test.
 *
 *   A LAYOUT WAIT MAY DELAY THE WORK, NEVER CANCEL IT. Same rule, and
 *   the same 250 ms, as `client/js/terminal-layout-wait.js`, which the
 *   terminal's own connect path already races this way.
 * Inputs: none. Output: Promise<void>. Always resolves.
 * Example: await twoFrames();
 */
function twoFrames(): Promise<void> {
    return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        setTimeout(finish, FRAME_TIMEOUT_MS);
        requestAnimationFrame(() => requestAnimationFrame(finish));
    });
}

/**
 * Pre-show the terminal screen, then fit and read its true grid.
 *
 * Description: THE ORDER IS THE WHOLE POINT and it is why this is not
 *   inlined. xterm cannot measure a container that is not laid out, so
 *   the screen is shown first, xterm is initialised if this page load
 *   never visited it, two animation frames are yielded so layout
 *   flushes, and only then does `fit()` run. A mismatch between the
 *   measured grid and the pane's garbles older scrollback on a
 *   differently-sized client, which is the bug this dance exists for.
 * Inputs: none. Output: {cols, rows}; 0/0 when the fit could not run,
 *   which the server reads as "skip the pre-resize".
 * Example: const {cols, rows} = await browserPrepareTerminal();
 */
async function browserPrepareTerminal(): Promise<{ cols: number; rows: number }> {
    const win = hostWindow() as unknown as Record<string, unknown> | undefined;
    const doc = hostDocument();
    const app = win?.App as { hideAllScreens?: () => void } | undefined;
    if (app && typeof app.hideAllScreens === 'function') {
        app.hideAllScreens();
    } else {
        doc?.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    }
    doc?.getElementById('terminal-screen')?.classList.add('active');

    const controller = win?.TerminalController as
        | {
              term?: { cols?: number; rows?: number } | null;
              fitAddon?: { fit?: () => void } | null;
              init?: () => Promise<unknown>;
          }
        | undefined;
    if (controller && !controller.term && typeof controller.init === 'function') {
        await controller.init();
    }
    await twoFrames();
    try {
        if (controller?.fitAddon && typeof controller.fitAddon.fit === 'function') {
            controller.fitAddon.fit();
        }
        return {
            cols: controller?.term?.cols || 0,
            rows: controller?.term?.rows || 0,
        };
    } catch (error) {
        // Tolerated: fall through with 0/0. The server skips the
        // pre-resize and the behaviour is identical to what every
        // same-width client already gets.
        console.warn('CloudeWeb: rejoin pre-fit failed:', error);
        return { cols: 0, rows: 0 };
    }
}

/**
 * The host, resolved against the running page.
 *
 * Inputs: none. Output: NavHost.
 * Example: await openProjectByName('api', browserNavHost(), t);
 */
export function browserNavHost(): NavHost {
    const win = () => hostWindow() as unknown as Record<string, unknown> | undefined;
    const api = (): LegacyApi => win()?.API as LegacyApi;
    const web = () =>
        win()?.CloudeWeb as
            | {
                  launchpad?: {
                      sessions?: {
                          runningSessions: RunningSessionRow[];
                          runningSessionsListing?: { ok?: boolean; reason?: string | null };
                      };
                      loadProjects?: (includeArchived?: boolean) => Promise<unknown>;
                      loadRunningSessions?: () => Promise<unknown>;
                      archivedProjectsVisible?: () => boolean;
                  };
              }
            | undefined;

    return {
        adoptSession: (name, attach) => api().adoptSession(name, attach),
        getSession: (id, options) => api().getSession(id ?? null, options),
        detachSession: () => api().detachSession(),
        createSession: (payload) => api().createSession(payload),
        createProject: (row) => api().createProject(row),
        chooseProvider: () => {
            const lp = win()?.Launchpad as
                | { showProviderModal?: () => Promise<Record<string, unknown> | null> }
                | undefined;
            // `providers.js` publishes the picker onto the shim at load
            // time. It is the ONE thing on this screen that still lives
            // in a classic script, so it is read rather than imported.
            return lp?.showProviderModal
                ? lp.showProviderModal()
                : Promise.resolve<Record<string, unknown> | null>(null);
        },
        terminalDims: () => {
            const metrics = win()?.TerminalMetrics as
                | { currentGrid?: () => Record<string, unknown> }
                | undefined;
            if (metrics && typeof metrics.currentGrid === 'function') {
                return metrics.currentGrid();
            }
            // Module missing (a load-order regression). Send nothing
            // rather than a guess; the server falls back to its defaults.
            console.warn('CloudeWeb: TerminalMetrics unavailable for dims');
            return {};
        },
        reloadProjects: () => {
            const load = web()?.launchpad?.loadProjects;
            return load ? load() : Promise.resolve();
        },
        reloadRunningSessions: () => {
            const load = web()?.launchpad?.loadRunningSessions;
            return load ? load() : Promise.resolve();
        },
        runningSessions: () => web()?.launchpad?.sessions?.runningSessions ?? [],
        // TRUE WHEN NOT MEASURED. A listing that has not run yet is not a
        // listing that failed, and the retry ladder must only spin on a
        // MEASURED failure - see `resolveDeepLink`.
        runningListingOk: () => web()?.launchpad?.sessions?.runningSessionsListing?.ok !== false,
        runningListingReason: () =>
            web()?.launchpad?.sessions?.runningSessionsListing?.reason ?? null,
        announceSessionCreated(detail) {
            const w = hostWindow() as unknown as Window | undefined;
            w?.dispatchEvent(new CustomEvent('session-created', { detail }));
        },
        rejectTarget(name) {
            const router = win()?.Router as { rejectTarget?: (n: string) => void } | undefined;
            if (router && typeof router.rejectTarget === 'function') {
                router.rejectTarget(name);
                return true;
            }
            return false;
        },
        prepareTerminal: browserPrepareTerminal,
        returnToExistingTerminal(session) {
            const app = win()?.App as
                | { returnToExistingTerminal?: (s: SessionLike) => void }
                | undefined;
            app?.returnToExistingTerminal?.(session);
        },
        wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
}

/** A project the launcher can open. Re-exported so callers need one import. */
export type { ProjectRow };
