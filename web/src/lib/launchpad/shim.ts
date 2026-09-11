/**
 * `window.Launchpad`, after `client/js/launchpad.js` stopped existing.
 *
 * IT IS A SEAM, NOT A CLASS. There is no instance, no state and no
 * behaviour in here: every member forwards into the compiled tree, and
 * the list is exactly the members that code OUTSIDE this tree still
 * reaches for. Eight of them, each with a named call site, re-derived
 * against the tree rather than copied from the plan - six slices moved
 * who calls what, and three members the plan expected to survive
 * (`_escapeHtml`, `showConfirmModal`, `createConsoleSession`) were
 * resolved at their call sites instead and are NOT here.
 *
 * IT MERGES, IT DOES NOT OVERWRITE, AND THAT IS AN ORDERING FACT RATHER
 * THAN A STYLE. This bundle is a `<script type="module">`, so it runs
 * AFTER every classic script on the page. `client/js/providers.js`
 * publishes the launch picker onto this object at its own load time,
 * which is earlier. Assigning a fresh object here would drop that
 * publication on the floor and the first "new project" would open a
 * picker that resolves null. `window.CloudeWeb` throws on a collision
 * for the opposite reason: nothing is supposed to publish into it but
 * this file.
 *
 * WHY NOT DELETE THE GLOBAL OUTRIGHT. Because `router.js`, `app.js`,
 * `terminal.js`, `providers.js`, `terminal-commands-panel.js` and
 * `session-sidebar-clicks.js` are five different screens' worth of
 * classic script that cannot import a module, and re-pointing all of
 * them at `window.CloudeWeb` would be this slice quietly becoming six
 * slices. The shim is the honest size of what is left.
 */
import { derivedDisplayName } from '../sessions/session-label';
import { sessionStore } from '../sessions/store.svelte';
import { hostWindow } from '../sessions/env';
import type { SessionRecord } from '../sessions/types';

/** Exactly what the legacy tree may reach on `window.Launchpad`. */
export interface LaunchpadShim {
    /**
     * `client/js/app.js:963` - the "already inited" test. Truthy once the
     * shell is mounted. It is a GETTER: `app.js` reads it before it calls
     * `init()`, so a plain field captured at publish time would read
     * null forever and re-init on every visit to the home screen.
     */
    readonly launchpadScreen: HTMLElement | null;
    /** `client/js/app.js:964` - mount the screen, once. */
    init(): void;
    /** `client/js/app.js:974` - refetch projects and repaint. */
    loadProjects(): Promise<void>;
    /** `client/js/terminal.js:1769` - refetch the running rows. */
    loadRunningSessions(): Promise<void>;
    /** `client/js/router.js:352` - resolve a deep link, creating nothing. */
    openProjectByName(name: string): Promise<void>;
    /** `client/js/app.js:1403` - the deep-link slug for a tmux name. */
    _deriveRunningSessionDisplayName(tmuxName: string | null): string;
    /** `client/js/session-sidebar-clicks.js:320` - the stored rows. */
    readonly sessionRecords: SessionRecord[];
    /**
     * `client/js/providers.js:649` WRITES this and
     * `web/src/lib/launchpad/nav-host.ts` reads it. The launch picker is
     * the one piece of this screen still living in a classic script, and
     * this property is the whole reason the shim merges rather than
     * assigns.
     */
    showProviderModal?: () => Promise<Record<string, unknown> | null>;
}

/** What the shim needs from the compiled tree to answer its callers. */
export interface ShimBackends {
    launchpadScreen(): HTMLElement | null;
    init(): void;
    loadProjects(): Promise<void>;
    loadRunningSessions(): Promise<void>;
    openProjectByName(name: string): Promise<void>;
}

/**
 * Publish the shim onto `window`, merging into whatever is already there.
 *
 * Description: every member is defined with a getter where it must be
 *   read late (`launchpadScreen`, `sessionRecords`) and as a plain
 *   function otherwise. `Object.defineProperty` rather than a spread,
 *   because a spread would evaluate a getter once and freeze its answer.
 * Inputs: backends - the compiled-tree implementations.
 * Output: the published object.
 * Example: publishLaunchpadShim({init, loadProjects, ...});
 */
export function publishLaunchpadShim(backends: ShimBackends): LaunchpadShim {
    const win = hostWindow() as unknown as Record<string, unknown> | undefined;
    const existing = (win?.Launchpad as Partial<LaunchpadShim> | undefined) || {};
    const shim = existing as LaunchpadShim;

    Object.defineProperty(shim, 'launchpadScreen', {
        configurable: true,
        enumerable: true,
        get: () => backends.launchpadScreen(),
    });
    Object.defineProperty(shim, 'sessionRecords', {
        configurable: true,
        enumerable: true,
        get: () => sessionStore.sessionRecords,
    });
    Object.assign(shim, {
        init: () => backends.init(),
        loadProjects: () => backends.loadProjects(),
        loadRunningSessions: () => backends.loadRunningSessions(),
        openProjectByName: (name: string) => backends.openProjectByName(name),
        _deriveRunningSessionDisplayName: (tmuxName: string | null) =>
            derivedDisplayName(tmuxName),
    });

    if (win) win.Launchpad = shim;
    return shim;
}

/**
 * Every member an outside caller reads, as data.
 *
 * Description: the list a guard iterates. It is here rather than inside
 *   the test because the test's job is to prove the shim MATCHES the
 *   tree, and a list that lived only in the test could agree with itself
 *   while the shim quietly lost a member.
 */
export const SHIM_MEMBERS: readonly string[] = [
    'launchpadScreen',
    'init',
    'loadProjects',
    'loadRunningSessions',
    'openProjectByName',
    '_deriveRunningSessionDisplayName',
    'sessionRecords',
    'showProviderModal',
];
