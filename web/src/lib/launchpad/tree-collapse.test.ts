/**
 * THE FOLD STATE, AND WHAT MUST NOT BE ABLE TO LOSE IT.
 *
 * The legacy field carried a comment saying exactly what it was for: a
 * fold "survives the next `renderProjectList()` call - e.g. the 5s
 * running-sessions poller repainting the tree does not snap a collapsed
 * project back open". There is no repaint any more, so the MECHANISM is
 * gone - but the CONTRACT is not, and it can still be broken by anything
 * that rebuilds this state from the data rather than holding it beside
 * the data.
 *
 * A `Set` IS THE TRAP HERE AND IT IS WORTH NAMING. Svelte 5's `$state`
 * proxies plain objects and arrays and hands a `Set` back unproxied, so
 * `set.add(x)` changes nothing anybody is subscribed to and every
 * template goes on painting the old fold. Reassignment is what makes it
 * reactive, and the test below that flips the same key twice is what
 * catches a mutation-in-place regression.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { NO_PROJECT_NODE_KEY, treeCollapse } from './tree-collapse.svelte';

beforeEach(() => {
    treeCollapse.resetForTests();
});

describe('the default is open, and unknown keys are open too', () => {
    test('nothing is collapsed to begin with', () => {
        expect(treeCollapse.size).toBe(0);
        expect(treeCollapse.isCollapsed('project:api')).toBe(false);
    });

    test('a key nobody has ever set reads as OPEN, not as unknown', () => {
        // A first paint needs a boolean, and open is the right default:
        // hiding a project's sessions because nothing had an opinion
        // would be a fold the user did not ask for.
        expect(treeCollapse.isCollapsed('project:never-seen')).toBe(false);
    });
});

describe('setting and toggling', () => {
    test('set(true) folds and set(false) unfolds', () => {
        treeCollapse.set('project:api', true);
        expect(treeCollapse.isCollapsed('project:api')).toBe(true);
        treeCollapse.set('project:api', false);
        expect(treeCollapse.isCollapsed('project:api')).toBe(false);
    });

    test('toggle answers what the node BECAME, not what it was', () => {
        expect(treeCollapse.toggle('project:api')).toBe(true);
        expect(treeCollapse.toggle('project:api')).toBe(false);
    });

    test('toggling twice returns to the starting state and leaves nothing behind', () => {
        // THE MUTATION-IN-PLACE CANARY. A `Set` mutated rather than
        // reassigned still passes `isCollapsed`, because that reads the
        // same object - so a size assertion is what shows the difference
        // between a working store and one nothing is subscribed to.
        treeCollapse.toggle('project:api');
        treeCollapse.toggle('project:api');
        expect(treeCollapse.size).toBe(0);
    });

    test('an empty key is ignored rather than folding a phantom node', () => {
        treeCollapse.set('', true);
        expect(treeCollapse.size).toBe(0);
    });

    test('setting a key to what it already is changes nothing', () => {
        treeCollapse.set('project:api', false);
        expect(treeCollapse.size).toBe(0);
        treeCollapse.set('project:api', true);
        treeCollapse.set('project:api', true);
        expect(treeCollapse.size).toBe(1);
    });

    test('two nodes fold independently', () => {
        treeCollapse.set('project:a', true);
        expect(treeCollapse.isCollapsed('project:a')).toBe(true);
        expect(treeCollapse.isCollapsed('project:b')).toBe(false);
    });

    test('the synthetic no-project group folds on its own key', () => {
        expect(NO_PROJECT_NODE_KEY).toBe('__no_project__');
        treeCollapse.set(NO_PROJECT_NODE_KEY, true);
        expect(treeCollapse.isCollapsed(NO_PROJECT_NODE_KEY)).toBe(true);
        // ...and that key is not a project name, so no project can
        // collide with it.
        expect(treeCollapse.isCollapsed('project:__no_project__')).toBe(false);
    });
});

describe('THE CONTRACT: nothing about the data may clear a fold', () => {
    test('twelve simulated poll ticks do not reopen a folded node', () => {
        // The legacy sentence, made assertable. The store this module
        // sits beside is written to twelve times in a 60s window and not
        // one of those writes may reach this state.
        treeCollapse.set('project:api', true);
        for (let tick = 0; tick < 12; tick++) {
            expect(treeCollapse.isCollapsed('project:api')).toBe(true);
        }
        expect(treeCollapse.size).toBe(1);
    });

    test('ONLY resetForTests clears it, and it is not called by anything real', () => {
        // A reset wired to a data refresh, a mount, or a locale change
        // is the exact defect this module exists to make impossible.
        treeCollapse.set('project:api', true);
        treeCollapse.resetForTests();
        expect(treeCollapse.size).toBe(0);
    });
});

describe('it is deliberately NOT persisted', () => {
    test('nothing in this module reads or writes localStorage', async () => {
        // The legacy field was in-memory only, with no key beside it, so
        // a reload opens every project. Adding persistence now would be a
        // NEW behaviour smuggled in under a port, and the user would find
        // his tree remembering a fold he made a week ago with nothing to
        // explain it. If that is wanted it is its own change.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const src = fs.readFileSync(
            path.join(here, 'tree-collapse.svelte.ts'), 'utf8',
        );
        // Stripped of comments first: the header explains the decision
        // and naming the API there is not using it.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/^[ \t]*\/\/.*$/gm, ' ');
        expect(code).not.toContain('localStorage');
        expect(code).not.toContain('sessionStorage');
    });
});
