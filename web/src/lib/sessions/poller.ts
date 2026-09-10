/**
 * The single 5s tick behind the running-sessions list.
 *
 * PORTED FROM `Launchpad._startRunningSessionsPoller`, WITH THE ONE
 * THING THAT METHOD NEVER HAD: a `clearInterval`. `client/js/launchpad.js`
 * called `setInterval` and stored the handle purely as an idempotence
 * flag; the word `clearInterval` appeared nowhere in the file, so the
 * tick outlived every teardown there has ever been. `stop()` is the
 * point of this module.
 *
 * TWO GATES, AND THEY ARE THE ORIGINAL TWO. A tick is skipped when the
 * user is not authenticated, and when the launchpad screen is not the
 * active one - the second read through
 * `ProjectListRenderGuard.shouldPoll(document)`, exactly as before. THE
 * SKIP IS A SKIP, NOT A STOP: the interval keeps running and the next
 * tick re-asks, so returning to the screen resumes without anything
 * having to restart it. Stopping on a hidden screen would need something
 * to notice the screen came back, and nothing does.
 *
 * EVERY DEPENDENCY IS INJECTED, WITH DEFAULTS THAT RESOLVE THE REAL
 * GLOBALS. That is what makes "a hidden screen does not poll" assertable
 * with no browser and no timer of its own: a test hands in its own
 * `shouldPoll` and counts ticks. A module that read `window` directly
 * could only be tested by a claim.
 */

import { hostDocument, hostWindow } from './env';

/** How often the running-session set is re-probed. */
export const POLL_INTERVAL_MS = 5000;

/** What a poller needs to decide whether to tick, and what to do. */
export interface PollerDeps {
    /** The work one tick does. Rejections are caught and logged. */
    tick: () => Promise<unknown> | unknown;
    /** Whether the user is signed in. Defaults to `window.Auth`. */
    isAuthenticated?: () => boolean;
    /** Whether the launchpad screen is showing. Defaults to the guard. */
    shouldPoll?: () => boolean;
    /** Injected for tests. Defaults to the global pair. */
    setIntervalFn?: (handler: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    intervalMs?: number;
}

/** A started poller. `stop()` is idempotent and always clears. */
export interface Poller {
    start(): void;
    stop(): void;
    readonly running: boolean;
}

/**
 * Whether the user is signed in, as the legacy tick asked.
 *
 * Description: the full three-part test the original carried -
 *   `window.Auth` exists, it has an `isAuthenticated` function, and that
 *   function answers true. An absent auth layer answers FALSE, so a page
 *   that has not finished booting does not poll.
 * Inputs: none. Output: boolean.
 * Example: defaultIsAuthenticated()
 */
export function defaultIsAuthenticated(): boolean {
    // READ OFF `window`, NOT `globalThis`, and through `hostWindow` so a
    // realm with no window at all answers rather than throwing. See
    // ./env.ts for both measurements behind that.
    const auth = (hostWindow() as unknown as {
        Auth?: { isAuthenticated?: unknown };
    } | undefined)?.Auth;
    return !!(auth && typeof auth.isAuthenticated === 'function'
        && (auth.isAuthenticated as () => boolean)());
}

/**
 * Whether the launchpad screen is the active one.
 *
 * Description: delegates to `ProjectListRenderGuard.shouldPoll(document)`,
 *   which tests `#launchpad-screen` for `.active`. THE ABSENT-GUARD CASE
 *   ANSWERS TRUE, which is the legacy behaviour byte for byte: the guard
 *   is an optimisation, and a missing optimisation must not silently stop
 *   the app refreshing.
 * Inputs: none. Output: boolean.
 * Example: defaultShouldPoll()
 */
export function defaultShouldPoll(): boolean {
    // Same rule as above.
    const g = (hostWindow() as unknown as {
        ProjectListRenderGuard?: { shouldPoll?: (d: unknown) => boolean };
    } | undefined)?.ProjectListRenderGuard;
    if (g && typeof g.shouldPoll === 'function') {
        return !!g.shouldPoll(hostDocument());
    }
    return true;
}

/**
 * Build the running-sessions poller.
 *
 * Description: `start()` is idempotent - a second call while running is a
 *   no-op, which is the guard the legacy method's stored handle provided.
 *   `stop()` CLEARS the interval and forgets the handle, so a stopped
 *   poller can be started again and a stopped one cannot tick once more.
 * Inputs: deps - see PollerDeps.
 * Output: Poller.
 * Example:
 *   const poller = createPoller({ tick: () => store.loadRunningSessions() });
 *   poller.start();
 *   poller.stop();
 */
export function createPoller(deps: PollerDeps): Poller {
    const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
    const isAuthenticated = deps.isAuthenticated ?? defaultIsAuthenticated;
    const shouldPoll = deps.shouldPoll ?? defaultShouldPoll;
    const setIntervalFn = deps.setIntervalFn
        ?? ((h: () => void, ms: number) => setInterval(h, ms));
    const clearIntervalFn = deps.clearIntervalFn
        ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

    let handle: unknown = null;

    return {
        get running(): boolean {
            return handle !== null;
        },
        start(): void {
            if (handle !== null) return;
            handle = setIntervalFn(() => {
                if (!isAuthenticated()) return;
                if (!shouldPoll()) return;
                // CALLED SYNCHRONOUSLY, which is what the legacy tick did
                // (`this.loadRunningSessions().catch(...)`). Deferring it
                // by even one microtask is a real behaviour change: it
                // moves the fetch behind whatever else is already queued,
                // and it makes the tick unobservable to any caller that
                // measures the turn it fired in. The try/catch is here
                // because `tick` may throw before it returns a promise,
                // and a throw inside a timer handler is unrecoverable.
                try {
                    Promise.resolve(deps.tick()).catch((err) => {
                        console.warn('CloudeWeb: running-sessions poll tick failed:', err);
                    });
                } catch (err) {
                    console.warn('CloudeWeb: running-sessions poll tick failed:', err);
                }
            }, intervalMs);
        },
        stop(): void {
            if (handle === null) return;
            clearIntervalFn(handle);
            handle = null;
        },
    };
}
