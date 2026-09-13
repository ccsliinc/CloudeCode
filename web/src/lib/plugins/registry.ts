/**
 * The plugin registry: register a plugin, ask a surface what it holds.
 *
 * NO SINGLETON IS EXPORTED, ONLY FUNCTIONS. `createRegistry()` builds an
 * independent one, which is how a test gets isolation without a
 * `reset()` that would exist for nobody else; the module keeps one
 * private instance and `register` / `surfacesOf` are thin wrappers on
 * it. Handing out the mutable store itself would let any importer
 * reorder or drop another plugin's contributions.
 *
 * ORDER IS TOTAL AND DECLARED, NEVER INSERTION LUCK. Contributions sort
 * on `order` (default 0) and then on `id`, so two builds that import the
 * plugins in a different sequence still paint the same list in the same
 * places. Relying on a Map's insertion order would work perfectly until
 * the day an import moved.
 *
 * A TAKEN `routePrefix` IS REFUSED THE SAME WAY A DUPLICATE ID IS, and
 * it is checked in the SAME validation pass rather than in a second one.
 * An `app-screen` contribution claims one leading path segment, and two
 * screens claiming one segment is not a paint-order question that a sort
 * can settle - it is two answers to "who owns this URL", and whichever
 * the walk reached first would silently own it. The comparison is exact
 * on the whole segment, never `startsWith`, so `archive` and `archived`
 * are two prefixes and not a collision.
 *
 * A DUPLICATE ID IS REFUSED AND SAID OUT LOUD. Last-write-wins would let
 * a new plugin silently replace a shipped control with something that
 * merely shares its name, and the symptom would be a control that
 * "stopped working" with nothing in the log. A refusal is loud and
 * leaves the working one in place. It is also ALL OR NOTHING: a plugin
 * whose second contribution collides registers none of them, so a
 * partially-registered plugin is never a state anything has to handle.
 */
import type { AppScreen, Contribution, Plugin, PluginSurface } from './types';

/** What a registry offers. Built by `createRegistry`, never exported raw. */
export interface PluginRegistry {
    /** Register a plugin. Returns false, having logged, on any refusal. */
    register(plugin: Plugin): boolean;
    /** Every contribution to one surface, in the one deterministic order. */
    surfacesOf<K extends PluginSurface>(kind: K): readonly Contribution<K>[];
    /**
     * The contribution id owning one route prefix, or null.
     * Exists so a refusal can be REPORTED rather than merely obeyed, and
     * so a test can assert the table rather than infer it from a log.
     */
    prefixOwner(prefix: string): string | null;
}

/**
 * Sort comparison: `order` first (absent reads as 0), `id` second. The id
 * tie break is what makes the order TOTAL - without it, two contributions
 * sharing an order come back in registration sequence, the exact
 * dependency this registry exists to remove.
 * Inputs: a, b - two contributions. Output: number, for Array.sort.
 */
function byOrderThenId(a: Contribution, b: Contribution): number {
    const ao = a.order ?? 0;
    const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
}

/**
 * Build an independent registry - the whole implementation. The exports
 * below are this, called on one private instance; a test that proves
 * ordering or a refusal builds its own, so it cannot be perturbed by
 * whatever the app registered at import time.
 * Inputs: none. Output: PluginRegistry.
 * Example: createRegistry().register({id: 'x', contributions: []}) -> true
 */
export function createRegistry(): PluginRegistry {
    /** Registered plugin ids, for the duplicate refusal. */
    const pluginIds = new Set<string>();
    /** Contributions by surface, unsorted. Sorting happens on read. */
    const bySurface = new Map<PluginSurface, Contribution[]>();
    /** routePrefix -> the contribution id holding it. One owner each. */
    const prefixOwners = new Map<string, string>();

    /** Is this contribution id already taken on its surface? */
    function idTaken(c: Contribution): boolean {
        const held = bySurface.get(c.surface);
        return !!held && held.some((existing) => existing.id === c.id);
    }

    /**
     * The route prefix an `app-screen` contribution claims, or '' for a
     * contribution to any other surface.
     * Inputs: c. Output: string - the bare segment, no slashes.
     */
    function prefixOf(c: Contribution): string {
        if (c.surface !== 'app-screen') return '';
        const payload = c.payload as AppScreen | undefined;
        const raw = payload && typeof payload.routePrefix === 'string'
            ? payload.routePrefix : '';
        // Written as one segment by contract. Trimming the slashes a
        // caller may have added anyway is what makes '/archive' and
        // 'archive' the same claim rather than two.
        return raw.replace(/^\/+|\/+$/g, '');
    }

    function register(plugin: Plugin): boolean {
        if (!plugin || typeof plugin.id !== 'string' || !plugin.id) {
            console.error('[plugins] refused a plugin with no id');
            return false;
        }
        if (pluginIds.has(plugin.id)) {
            console.error(
                `[plugins] refused duplicate plugin id "${plugin.id}" - the `
                + 'one already registered is kept');
            return false;
        }
        // VALIDATED IN FULL BEFORE ANYTHING IS STORED. A plugin that
        // registered its first two contributions and then hit a
        // collision would leave the surface holding half a feature.
        const incoming = plugin.contributions || [];
        const seen = new Set<string>();
        /** Prefixes claimed by THIS plugin, so it cannot collide with itself. */
        const seenPrefixes = new Map<string, string>();
        for (const c of incoming) {
            if (!c || typeof c.id !== 'string' || !c.id) {
                console.error(
                    `[plugins] refused plugin "${plugin.id}": a contribution `
                    + 'has no id');
                return false;
            }
            const key = `${c.surface}\0${c.id}`;
            if (seen.has(key) || idTaken(c)) {
                console.error(
                    `[plugins] refused plugin "${plugin.id}": contribution id `
                    + `"${c.id}" is already registered on surface `
                    + `"${c.surface}" - the one already registered is kept`);
                return false;
            }
            seen.add(key);
            if (c.surface === 'app-screen') {
                const prefix = prefixOf(c);
                if (prefix === '') {
                    console.error(
                        `[plugins] refused plugin "${plugin.id}": app-screen `
                        + `contribution "${c.id}" declares no routePrefix`);
                    return false;
                }
                if (prefixOwners.has(prefix) || seenPrefixes.has(prefix)) {
                    const owner = prefixOwners.get(prefix) ?? seenPrefixes.get(prefix);
                    console.error(
                        `[plugins] refused plugin "${plugin.id}": route prefix `
                        + `"${prefix}" is already owned by contribution `
                        + `"${owner}" - the one already registered is kept`);
                    return false;
                }
                seenPrefixes.set(prefix, c.id);
            }
        }
        pluginIds.add(plugin.id);
        for (const [prefix, owner] of seenPrefixes) prefixOwners.set(prefix, owner);
        for (const c of incoming) {
            const held = bySurface.get(c.surface);
            if (held) held.push(c);
            else bySurface.set(c.surface, [c]);
        }
        return true;
    }

    function surfacesOf<K extends PluginSurface>(kind: K): readonly Contribution<K>[] {
        const held = bySurface.get(kind);
        if (!held) return [];
        // A COPY, SORTED. Sorting the stored array in place would make a
        // read mutate the registry, and handing the stored array back
        // would let a caller splice a contribution out of it.
        return held.slice().sort(byOrderThenId) as Contribution<K>[];
    }

    function prefixOwner(prefix: string): string | null {
        return prefixOwners.get(String(prefix ?? '')) ?? null;
    }

    return { register, surfacesOf, prefixOwner };
}

/** The one registry the bundle uses. Private on purpose. */
const registry = createRegistry();

/**
 * Register a plugin with the bundle's registry.
 * Inputs: plugin. Output: boolean - false on a logged refusal.
 */
export function register(plugin: Plugin): boolean {
    return registry.register(plugin);
}

/**
 * Every contribution to one surface of the bundle's registry, ordered.
 * NOT filtered by `enabled` - that needs a context only the calling
 * surface can build, so the filter lives at the call site.
 * Inputs: kind. Output: readonly Contribution<K>[].
 */
export function surfacesOf<K extends PluginSurface>(kind: K): readonly Contribution<K>[] {
    return registry.surfacesOf(kind);
}

/**
 * The contribution id owning one `app-screen` route prefix, or null.
 * Inputs: prefix - the bare leading segment, e.g. 'archive'.
 * Output: string | null.
 */
export function prefixOwner(prefix: string): string | null {
    return registry.prefixOwner(prefix);
}
