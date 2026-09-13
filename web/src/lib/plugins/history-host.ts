/**
 * The running app, as the history screen sees it. HOST CODE, AND IT
 * LIVES OUTSIDE `history/` ON PURPOSE.
 *
 * This is the one module that knows both that `window.App` exists and
 * that a history screen wants a `ScreenShellHost`. Putting it inside
 * `history/` would put `window.App` inside the directory section 10 of
 * the scope wants liftable some day, and `import-direction.test.ts`
 * would be asserting a boundary that the boundary's own code crossed.
 * The arrow points outward: `history/` declares the shape it needs, the
 * host supplies it.
 *
 * EVERY GLOBAL IS RESOLVED LAZILY, AT CALL TIME. `client/dist/app.js` is
 * a deferred module and the legacy IIFEs are classic scripts, so they
 * have all run by the time this module evaluates - but the app's own
 * controller publishes `window.App` during its script and wires itself
 * on `load`. Reading the globals inside the functions rather than at
 * import time is what makes the order of those two irrelevant, which is
 * the same rule `main.ts`'s `browserHost` already follows.
 *
 * A MISSING GLOBAL IS A NAMED REFUSAL, NEVER A THROW. The legacy tree
 * tolerates a module that did not load, and so does this: a false return
 * with a warning naming what was unavailable, because a navigation that
 * silently does nothing is indistinguishable from one nobody asked for.
 */
import type { ScreenShellHost } from './history/index';

/** As much of the legacy app controller as this host calls. */
interface LegacyApp {
    showArchive?(route: unknown): void;
    showLaunchpad?(): void;
}

/** As much of `window` as this host reads. */
interface HostWindow {
    App?: LegacyApp;
    location: { pathname: string };
    history: { pushState(state: unknown, title: string, url: string): void };
}

/** The window, or null outside a browser. */
function win(): HostWindow | null {
    return typeof window !== 'undefined'
        ? (window as unknown as HostWindow) : null;
}

/**
 * Build the browser host.
 *
 * Description: the adapter between the `app-screen` lifecycle and the
 *   legacy screen controller. Slice 3 replaces `showScreen` with a
 *   Svelte mount and deletes `LegacyApp.showArchive`; nothing else in
 *   this file has to move, and no caller learns about it.
 * Inputs: none. Output: ScreenShellHost.
 * Example: createHistoryPlugin(browserScreenHost(), (p) => API.call(p));
 */
export function browserScreenHost(): ScreenShellHost {
    return {
        showScreen(route) {
            const w = win();
            const app = w && w.App;
            if (!app || typeof app.showArchive !== 'function') {
                console.warn('[history] the app shell is unavailable; the '
                             + 'archive could not be shown.');
                return false;
            }
            app.showArchive(route);
            return true;
        },
        showLauncher() {
            const w = win();
            const app = w && w.App;
            if (!app || typeof app.showLaunchpad !== 'function') {
                console.warn('[history] the app shell is unavailable; the '
                             + 'archive could not be left.');
                return false;
            }
            app.showLaunchpad();
            return true;
        },
        pushPath(path) {
            const w = win();
            if (!w || !w.history) return false;
            try {
                w.history.pushState({}, '', path);
                return true;
            } catch {
                // History API blocked (a sandboxed iframe refuses it).
                // The navigation still runs: a wrong address bar is not
                // a reason to refuse to navigate. Same tolerance the
                // router applies.
                return false;
            }
        },
        currentPath() {
            const w = win();
            return w && w.location ? String(w.location.pathname) : '';
        },
        setVisible(container, visible) {
            // THE SAME MECHANISM EVERY OTHER SCREEN IN THIS APP USES.
            // `.active` is what `App.hideAllScreens()` strips and what
            // `showArchive()` adds, so a screen hidden here and a screen
            // hidden by the legacy controller are in the same state -
            // there is no second notion of hidden for anything to
            // disagree about.
            if (!container || !container.classList) return;
            if (visible) container.classList.add('active');
            else container.classList.remove('active');
        },
    };
}
