/**
 * The registry's four promises: deterministic order, duplicate refusal,
 * all-or-nothing registration, and `enabled` as a gate rather than a
 * suggestion.
 *
 * EVERY BLOCK BUILDS ITS OWN REGISTRY. `createRegistry()` exists for
 * exactly this: the module-level one already holds whatever `builtin.ts`
 * registered, and a test that asserted on a shared mutable store would
 * pass or fail on import order.
 *
 * Run with: npm test   (from web/)
 */
import { describe, expect, test, vi } from 'vitest';

import { createRegistry } from './registry';
import type { Contribution, PluginContext, PluginSurface, SessionCardAction } from './types';

/** A context with the given flags and a refresh that records its calls. */
function ctx(flags: Record<string, boolean> = {}): PluginContext {
    return { flags, refresh: vi.fn() };
}

/** A payload that describes nothing interesting. Inputs: none. Output: payload. */
function payload(): SessionCardAction {
    return {
        shortcut: 'X',
        label: () => 'x',
        run: () => {},
    };
}

/**
 * One `session-card-action` contribution.
 * Inputs: id; order (optional); enabled (optional, defaults to always).
 * Output: Contribution<'session-card-action'>.
 */
function contribution(
    id: string,
    order?: number,
    enabled: (c: PluginContext) => boolean = () => true,
): Contribution<'session-card-action'> {
    return {
        id,
        surface: 'session-card-action',
        ...(order === undefined ? {} : { order }),
        enabled,
        payload: payload(),
    };
}

describe('ordering', () => {
    test('sorts on order first, and never on registration sequence', () => {
        const r = createRegistry();
        // Registered last-first on purpose: an insertion-ordered store
        // passes every other assertion in this file and fails this one.
        expect(r.register({ id: 'c', contributions: [contribution('c', 30)] })).toBe(true);
        expect(r.register({ id: 'a', contributions: [contribution('a', 10)] })).toBe(true);
        expect(r.register({ id: 'b', contributions: [contribution('b', 20)] })).toBe(true);
        expect(r.surfacesOf('session-card-action').map((c) => c.id))
            .toEqual(['a', 'b', 'c']);
    });

    test('an absent order reads as 0, so it sorts ahead of a positive one', () => {
        const r = createRegistry();
        r.register({ id: 'p', contributions: [contribution('positive', 5)] });
        r.register({ id: 'q', contributions: [contribution('unordered')] });
        expect(r.surfacesOf('session-card-action').map((c) => c.id))
            .toEqual(['unordered', 'positive']);
    });

    test('ties break on id, so the order is TOTAL', () => {
        const r = createRegistry();
        r.register({ id: 'z', contributions: [contribution('zulu', 1)] });
        r.register({ id: 'a', contributions: [contribution('alpha', 1)] });
        r.register({ id: 'm', contributions: [contribution('mike', 1)] });
        expect(r.surfacesOf('session-card-action').map((c) => c.id))
            .toEqual(['alpha', 'mike', 'zulu']);
    });

    test('reading does not mutate the registry, and the caller cannot', () => {
        const r = createRegistry();
        r.register({ id: 'a', contributions: [contribution('a', 2), contribution('b', 1)] });
        const first = r.surfacesOf('session-card-action') as Contribution[];
        first.length = 0;
        expect(r.surfacesOf('session-card-action').map((c) => c.id)).toEqual(['b', 'a']);
    });

    test('an unpopulated surface answers empty, not undefined', () => {
        const r = createRegistry();
        expect(r.surfacesOf('status-source')).toEqual([]);
        expect(r.surfacesOf('sidebar-item')).toEqual([]);
        expect(r.surfacesOf('launchpad-panel')).toEqual([]);
    });
});

describe('duplicate refusal', () => {
    test('a second plugin with the same id is refused and logged', () => {
        const r = createRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(r.register({ id: 'dup', contributions: [contribution('first')] })).toBe(true);
            expect(r.register({ id: 'dup', contributions: [contribution('second')] })).toBe(false);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
        // The one already registered is KEPT. Last-write-wins would have
        // left 'second' here, which is the silent replacement this
        // refusal exists to prevent.
        expect(r.surfacesOf('session-card-action').map((c) => c.id)).toEqual(['first']);
    });

    test('a contribution id already taken on that surface is refused', () => {
        const r = createRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            r.register({ id: 'one', contributions: [contribution('shared')] });
            expect(r.register({ id: 'two', contributions: [contribution('shared')] })).toBe(false);
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
        expect(r.surfacesOf('session-card-action')).toHaveLength(1);
    });

    test('a collision registers NONE of the plugin, not the good ones', () => {
        const r = createRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            r.register({ id: 'one', contributions: [contribution('taken')] });
            expect(r.register({
                id: 'two',
                contributions: [contribution('fine'), contribution('taken')],
            })).toBe(false);
        } finally {
            spy.mockRestore();
        }
        expect(r.surfacesOf('session-card-action').map((c) => c.id)).toEqual(['taken']);
    });

    test('the SAME id on a DIFFERENT surface is not a collision', () => {
        const r = createRegistry();
        r.register({
            id: 'both',
            contributions: [
                contribution('twin'),
                {
                    id: 'twin',
                    surface: 'sidebar-item',
                    enabled: () => true,
                    payload: { label: 'l', icon: '', run: () => {} },
                },
            ],
        });
        expect(r.surfacesOf('session-card-action')).toHaveLength(1);
        expect(r.surfacesOf('sidebar-item')).toHaveLength(1);
    });

    test('the composite key is `surface\\0id`, not `surface + id` concatenated', () => {
        // The within-plugin duplicate check builds `${c.surface}\0${c.id}`
        // for each of a plugin's OWN contributions, so two DIFFERENT
        // (surface, id) pairs in the same plugin can never collide by
        // concatenation. Chosen so plain concatenation WOULD collide -
        // 'ab' + 'c' === 'a' + 'bc' === 'abc' - while the true composite
        // key does not: 'ab\0c' !== 'a\0bc'. If the NUL separator were
        // ever dropped (making the key a bare concatenation) or altered
        // to a character either string could contain, this test fails
        // because the plugin's two unrelated contributions would look
        // like an internal duplicate and the whole plugin - both
        // contributions, all-or-nothing - would be refused.
        const r = createRegistry();
        const surfaceA = 'ab' as unknown as PluginSurface;
        const surfaceB = 'a' as unknown as PluginSurface;
        const make = (surface: PluginSurface, id: string): Contribution => ({
            id,
            surface,
            enabled: () => true,
            payload: { label: 'l', icon: '', run: () => {} },
        } as unknown as Contribution);
        expect(r.register({
            id: 'both',
            contributions: [make(surfaceA, 'c'), make(surfaceB, 'bc')],
        })).toBe(true);
        expect(r.surfacesOf(surfaceA)).toHaveLength(1);
        expect(r.surfacesOf(surfaceB)).toHaveLength(1);
    });

    test('a plugin with no id, or a contribution with none, is refused', () => {
        const r = createRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(r.register({ id: '', contributions: [] })).toBe(false);
            expect(r.register({ id: 'x', contributions: [contribution('')] })).toBe(false);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
        expect(r.surfacesOf('session-card-action')).toEqual([]);
    });
});

describe('enabled is a predicate on the context, not a static field', () => {
    test('it is asked with the context it was given, and answers both ways', () => {
        const r = createRegistry();
        const gated = contribution('gated', 0, (c) => c.flags['some_flag'] !== false);
        r.register({ id: 'g', contributions: [gated] });
        const held = r.surfacesOf('session-card-action');
        expect(held).toHaveLength(1);
        expect(held[0]!.enabled(ctx({ some_flag: true }))).toBe(true);
        expect(held[0]!.enabled(ctx({ some_flag: false }))).toBe(false);
        // Absent reads as ON. A flag that could not be measured must not
        // be the reason a shipped control disappears.
        expect(held[0]!.enabled(ctx({}))).toBe(true);
    });

    test('a disabled contribution stays REGISTERED - the flag is not an unregister', () => {
        const r = createRegistry();
        r.register({ id: 'g', contributions: [contribution('off', 0, () => false)] });
        // Still on the surface, and the caller is what filters. This is
        // the difference between "switched off" and "not shipped", and
        // conflating them is what would make a config key a build-time
        // decision.
        expect(r.surfacesOf('session-card-action').map((c) => c.id)).toEqual(['off']);
    });
});
