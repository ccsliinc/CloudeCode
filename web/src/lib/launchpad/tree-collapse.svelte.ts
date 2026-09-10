/**
 * Which project-tree nodes the user has folded shut.
 *
 * SLICE 4. `Launchpad._collapsedProjectNodes` was a plain `Set` on the
 * singleton, and the legacy comment on it says exactly why it existed:
 * so a fold "survives the next `renderProjectList()` call - e.g. the 5s
 * running-sessions poller repainting the tree does not snap a collapsed
 * project back open".
 *
 * THAT SENTENCE IS STILL THE CONTRACT, AND THE MECHANISM UNDERNEATH IT
 * HAS CHANGED COMPLETELY. There is no repaint any more: the tree is a
 * reactive component and a poll tick writes only the values that moved.
 * So a fold no longer has to SURVIVE anything - but it can still be
 * LOST, by any change that rebuilds this state from the data instead of
 * holding it beside the data. Keeping the set in a module-scope rune,
 * outside every component, is what makes that impossible: nothing in a
 * component's lifecycle can drop it, because it does not live in one.
 * ./tree-collapse.test.ts drives twelve simulated ticks against it.
 *
 * IT IS DELIBERATELY NOT PERSISTED. The legacy field was in-memory only,
 * with no localStorage key beside it, so a reload opens every project.
 * Writing one now would be a NEW behaviour smuggled in under a port, and
 * the user would find his tree remembering a fold he made a week ago
 * with nothing to explain it. If that is wanted it is its own change,
 * with its own key and its own opinion about what to do on a first run.
 *
 * A `Set` IS REASSIGNED, NEVER MUTATED IN PLACE. Svelte 5's `$state`
 * proxies plain objects and arrays; a `Set` is handed back as-is, so
 * `set.add(x)` moves nothing and no template re-reads. Building a new
 * `Set` and assigning it is the whole fix, and it is cheap: this holds
 * one string per folded node on a screen with tens of projects.
 *
 * NOTHING RUNS AT IMPORT. No storage read, no global. See
 * ../ui/prefs.svelte.ts for the incident behind that rule.
 */

/** The node keys currently folded shut. Reassigned on every change. */
let collapsed = $state<Set<string>>(new Set());

/** The synthetic "no project" group's key. Not a real project name. */
export const NO_PROJECT_NODE_KEY = '__no_project__';

/**
 * The project tree's fold state.
 *
 * Description: exported as an OBJECT WITH ACCESSORS rather than as the
 *   rune, because a `$state` exported by value is read once at import
 *   and never again - every consumer would hold a dead snapshot. A
 *   getter re-reads it inside the caller's own effect and stays reactive
 *   across the module boundary.
 */
export const treeCollapse = {
    /**
     * Is this node folded shut?
     *
     * Inputs: nodeKey - `project:<name>` or NO_PROJECT_NODE_KEY.
     * Output: boolean. Unknown keys are OPEN, which is the default a
     *   first paint needs.
     * Example: treeCollapse.isCollapsed('project:api')  // false
     */
    isCollapsed(nodeKey: string): boolean {
        return collapsed.has(nodeKey);
    },

    /**
     * Fold or unfold one node.
     *
     * Inputs: nodeKey. next - true to fold.
     * Output: void.
     * Example: treeCollapse.set('project:api', true)
     */
    set(nodeKey: string, next: boolean): void {
        if (!nodeKey) return;
        if (collapsed.has(nodeKey) === !!next) return;
        const updated = new Set(collapsed);
        if (next) updated.add(nodeKey);
        else updated.delete(nodeKey);
        collapsed = updated;
    },

    /**
     * Flip one node, and answer what it became.
     *
     * Inputs: nodeKey.
     * Output: boolean - the new collapsed state.
     * Example: treeCollapse.toggle('project:api')  // true
     */
    toggle(nodeKey: string): boolean {
        const next = !collapsed.has(nodeKey);
        this.set(nodeKey, next);
        return next;
    },

    /** How many nodes are folded. For a test, and for nothing else. */
    get size(): number {
        return collapsed.size;
    },

    /**
     * Forget every fold.
     *
     * Description: for a test. NOT called on a data refresh, on a mount,
     *   or on a locale change - a fold that cleared itself when the data
     *   moved is the exact defect this module exists to make impossible.
     * Inputs: none. Output: void.
     * Example: treeCollapse.resetForTests()
     */
    resetForTests(): void {
        collapsed = new Set();
    },
};
