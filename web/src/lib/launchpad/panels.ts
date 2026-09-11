/**
 * Every panel on the home screen, in mount order, as ONE list.
 *
 * THIS IS THE PLUGIN SEAM, AND IT IS THE ONLY THING SLICE 7 OWED IT.
 * `.claude/notes/svelte-migration-launchpad.md` section 6 asks for four
 * habits and no registry: one of them is that panels are mounted BY NAME
 * FROM ONE ORDERED LIST rather than by `mount()` calls scattered through
 * the shell. A `launchpad-panel` surface later is then one more entry in
 * this array plus whatever consent rung that decision wants - not a
 * rewrite of the shell. Do not scatter a `mount()` call back into
 * `HomeScreen.svelte` to save an indirection; the indirection IS the
 * feature.
 *
 * `ensurePanel`, NOT `mountPanel`, FOR EVERY ONE OF THEM. Each of these
 * four components READS the session store, so a tick updates them by
 * reactivity and nothing needs to tell them to paint. `mountPanel` would
 * unmount and rebuild the whole panel on every call, which is the exact
 * repaint slices 2, 4 and 5 deleted - reintroduced by the seam rather
 * than by the renderer. `ensurePanel` is a map lookup once a live panel
 * sits on the element that currently carries the id.
 *
 * THE CONTAINER IDS ARE A CONTRACT, not an implementation detail. They
 * are written by `HomeScreen.svelte` as STATIC markup, and the legacy
 * chrome that writes section counts and visibility addresses them and
 * their headings by id. Renaming one is a breaking change to three files
 * that cannot import this one.
 */
import type { Component } from 'svelte';
import { ensurePanel, panelInstance, unmountPanel } from '../mount';
import AttributionPrompt from './AttributionPrompt.svelte';
import RecentSessions from './RecentSessions.svelte';
import ProjectTree from './ProjectTree.svelte';
import RunningSessions from './RunningSessions.svelte';

/** One panel: the container id it fills and the component that fills it. */
export interface PanelEntry {
    /** The id of the element in `HomeScreen.svelte` this mounts into. */
    id: string;
    /** The component. */
    component: Component<Record<string, never>, Record<string, unknown>>;
}

/**
 * The four panels, in the order they appear down the screen.
 *
 * The attribution prompt is FIRST on purpose and not only in this array:
 * it is a question, not a status line, and a question below the fold is
 * a question nobody answers.
 */
export const LAUNCHPAD_PANELS: readonly PanelEntry[] = [
    { id: 'attribution-prompt', component: AttributionPrompt as PanelEntry['component'] },
    { id: 'running-sessions-list', component: RunningSessions as PanelEntry['component'] },
    { id: 'recent-sessions-list', component: RecentSessions as PanelEntry['component'] },
    { id: 'project-list', component: ProjectTree as PanelEntry['component'] },
];

/**
 * Mount every panel that is not already up.
 *
 * Description: idempotent by construction, so the shell may call it on
 *   every render and a caller may call it defensively. A container that
 *   is not in the document yet is warned about by `mountPanel` and
 *   skipped, which is the normal early-boot state rather than an error.
 * Inputs: none. Output: the ids that now hold a live panel.
 * Example: mountLaunchpadPanels();   // ['attribution-prompt', ...]
 */
export function mountLaunchpadPanels(): string[] {
    const mounted: string[] = [];
    for (const panel of LAUNCHPAD_PANELS) {
        if (ensurePanel(panel.id, panel.component, {})) mounted.push(panel.id);
    }
    return mounted;
}

/**
 * Unmount every panel this list owns.
 *
 * Description: the other half, and the thing the legacy shell never had.
 *   The screen is created once and lives for the page today, so nothing
 *   calls this in the browser - it exists so the panels have an owner
 *   that can end them, and so a test can prove a mount is reversible.
 * Inputs: none. Output: how many were live.
 * Example: unmountLaunchpadPanels();   // 4
 */
export function unmountLaunchpadPanels(): number {
    let count = 0;
    for (const panel of LAUNCHPAD_PANELS) {
        if (unmountPanel(panel.id)) count += 1;
    }
    return count;
}

/**
 * Ask every panel that FETCHES for itself to refetch.
 *
 * Description: THE CALL THAT REPLACED A REMOUNT, and it is the whole of
 *   slice 7's repaint story. Two of these four panels own a fetch of
 *   their own - the attribution prompt asks `GET /sessions/attribution
 *   -prompt`, RECENT asks `GET /sessions/recent` - and the legacy shell
 *   refetched both by REMOUNTING them on every `loadProjects()`, which
 *   threw the whole card and the whole list away to change at most a
 *   row. Each now exposes `refresh()` on its mount handle and this calls
 *   it, so a refetch repaints only what moved.
 *
 *   The other two panels are deliberately absent from the result and
 *   need nothing: the project tree and the running list READ the store,
 *   so the store's own load is what updates them.
 *
 *   A panel with no `refresh` export is SKIPPED, not an error: that is
 *   how a store-reading panel says it has nothing to refetch.
 * Inputs: none. Output: the ids that were asked.
 * Example: refreshLaunchpadPanels();   // ['attribution-prompt', ...]
 */
export function refreshLaunchpadPanels(): string[] {
    const asked: string[] = [];
    for (const panel of LAUNCHPAD_PANELS) {
        const instance = panelInstance(panel.id);
        const refresh = instance?.refresh;
        if (typeof refresh !== 'function') continue;
        try {
            void (refresh as () => unknown)();
            asked.push(panel.id);
        } catch (error) {
            // Guarded per panel: one card failing to refetch must not
            // stop the next one from trying.
            console.error('CloudeWeb: panel refresh failed for', panel.id, error);
        }
    }
    return asked;
}
