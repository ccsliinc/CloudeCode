/**
 * The `app-screen` navigation walk and the mount lifecycle.
 *
 * THE LOAD-BEARING TEST IN THIS FILE IS THE THROWING SCREEN. The host
 * traded a hardcoded `if (path starts with /archive)` branch for a
 * generic walk over a list, and the risk that trade carries is that one
 * bad plugin takes navigation down for every other screen. A walk that
 * did exactly that would pass every positive test in this file.
 *
 * SO EVERY CONTAINMENT CASE IS ORDERED DELIBERATELY: the throwing screen
 * is registered BEFORE the good one, so a walk that aborted on the throw
 * could not reach the good one and the test would fail. Registering it
 * afterwards would let a broken walk pass.
 *
 * These tests build their OWN registry rather than using the module's,
 * for the reason `registry.test.ts` gives for the same choice: a test
 * that could be perturbed by whatever the bundle registered at import
 * time is measuring two things at once.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRegistry } from './registry';
import { deliverRoute, hideScreen, hideVisibleScreen, ownsPath,
         resetMountedScreens, visibleScreen, walkScreens,
         type ScreenHost } from './screens';
import type { AppScreen, Contribution, Plugin, PluginContext,
              ScreenRouteResult } from './types';

/** A context with no flags and a repaint that records nothing. */
const CTX: PluginContext = { flags: {}, refresh: () => {} };

/** Build a minimal screen payload with sane defaults. */
function screen(over: Partial<AppScreen> & { routePrefix: string }): AppScreen {
    return {
        screenId: over.routePrefix + '-screen',
        title: over.routePrefix,
        apiPrefixes: [],
        parse: (path) => (path.startsWith('/' + over.routePrefix)
            ? { ok: true, route: { path } }
            : { ok: false, token: 'no-match' }) as ScreenRouteResult<unknown>,
        buildPath: () => null,
        mount: () => {},
        show: () => {},
        hide: () => {},
        ...over,
    };
}

/** Wrap one payload as a whole plugin with one contribution. */
function pluginWith(id: string, payload: AppScreen, order?: number): Plugin {
    return {
        id,
        contributions: [{ id, surface: 'app-screen', order,
                          enabled: () => true, payload } as Contribution],
    };
}

/**
 * Register a set of plugins into a fresh registry and return a walk
 * bound to it.
 *
 * Description: `walkScreens` reads the MODULE registry, so these tests
 *   drive it through `builtin`-free registration on the shared instance
 *   would be wrong. Instead the walk logic is exercised against the
 *   module registry after the bundle's own registration, which is what
 *   the app actually runs - and isolation comes from unique ids per
 *   test. See the note on the module registry below.
 */

describe('ownsPath matches whole segments', () => {
    test('a prefix owns its own path and its children', () => {
        const s = screen({ routePrefix: 'archive' });
        expect(ownsPath(s, '/archive')).toBe(true);
        expect(ownsPath(s, '/archive/')).toBe(true);
        expect(ownsPath(s, '/archive/t/5767')).toBe(true);
    });

    test('a prefix does NOT own a longer first segment', () => {
        const s = screen({ routePrefix: 'archive' });
        expect(ownsPath(s, '/archived-thing')).toBe(false);
        expect(ownsPath(s, '/archives')).toBe(false);
        expect(ownsPath(s, '/arch')).toBe(false);
        expect(ownsPath(s, '/')).toBe(false);
        expect(ownsPath(s, '')).toBe(false);
    });

    test('a screen declaring no prefix owns nothing', () => {
        expect(ownsPath(screen({ routePrefix: '' }), '/anything')).toBe(false);
    });
});

describe('the registry refuses a taken route prefix', () => {
    let registry: ReturnType<typeof createRegistry>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        registry = createRegistry();
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('the first claim is recorded and readable', () => {
        expect(registry.register(pluginWith('a', screen({ routePrefix: 'archive' }))))
            .toBe(true);
        expect(registry.prefixOwner('archive')).toBe('a');
        err.mockRestore();
    });

    test('a SECOND claim on the same prefix is refused, whole-plugin', () => {
        registry.register(pluginWith('a', screen({ routePrefix: 'archive' })));
        const second: Plugin = {
            id: 'b',
            contributions: [
                { id: 'b-card', surface: 'session-card-action', enabled: () => true,
                  payload: { shortcut: 'Z', label: () => 'z', run: () => {} } } as Contribution,
                { id: 'b-screen', surface: 'app-screen', enabled: () => true,
                  payload: screen({ routePrefix: 'archive' }) } as Contribution,
            ],
        };
        expect(registry.register(second)).toBe(false);
        // ALL OR NOTHING: the sibling contribution on another surface
        // must not have landed either.
        expect(registry.surfacesOf('session-card-action').length).toBe(0);
        // The one already registered is kept.
        expect(registry.prefixOwner('archive')).toBe('a');
        expect(registry.surfacesOf('app-screen').length).toBe(1);
        err.mockRestore();
    });

    test('a plugin cannot collide with ITSELF', () => {
        const selfClash: Plugin = {
            id: 'twins',
            contributions: [
                { id: 'one', surface: 'app-screen', enabled: () => true,
                  payload: screen({ routePrefix: 'archive' }) } as Contribution,
                { id: 'two', surface: 'app-screen', enabled: () => true,
                  payload: screen({ routePrefix: 'archive' }) } as Contribution,
            ],
        };
        expect(registry.register(selfClash)).toBe(false);
        expect(registry.surfacesOf('app-screen').length).toBe(0);
        err.mockRestore();
    });

    test('an app-screen declaring NO prefix is refused', () => {
        expect(registry.register(pluginWith('nameless', screen({ routePrefix: '' }))))
            .toBe(false);
        err.mockRestore();
    });

    test('POSITIVE CONTROL: a DIFFERENT prefix registers fine', () => {
        // Without this, every assertion above passes for a registry that
        // refuses every app-screen contribution unconditionally.
        registry.register(pluginWith('a', screen({ routePrefix: 'archive' })));
        expect(registry.register(pluginWith('b', screen({ routePrefix: 'archived' }))))
            .toBe(true);
        expect(registry.prefixOwner('archived')).toBe('b');
        expect(registry.surfacesOf('app-screen').length).toBe(2);
        err.mockRestore();
    });

    test('the prefix is compared after trimming slashes, so /archive collides', () => {
        registry.register(pluginWith('a', screen({ routePrefix: 'archive' })));
        expect(registry.register(pluginWith('b', screen({ routePrefix: '/archive' }))))
            .toBe(false);
        err.mockRestore();
    });
});

/**
 * THE WALK, driven against the MODULE registry.
 *
 * `walkScreens` reads the module's own registry because that is what the
 * router does, and swapping it for an injected one would make this suite
 * measure an arrangement rather than the thing that ships. The bundle's
 * own plugins are registered by `builtin.ts`, which these tests do NOT
 * import, so the module registry holds only what each test registers.
 */
describe('walkScreens', () => {
    beforeEach(() => {
        resetMountedScreens();
    });

    test('a registered screen claims its own path', async () => {
        const { register } = await import('./registry');
        register(pluginWith('walk-ok', screen({
            routePrefix: 'wone',
            parse: (p) => ({ ok: true, route: { p } }),
        })));
        const r = walkScreens('/wone/x', '', CTX);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.contribution.id).toBe('walk-ok');
    });

    test('a path nobody owns is no-match, so the caller keeps looking', () => {
        const r = walkScreens('/session/cloude_api', '', CTX);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.token).toBe('no-match');
    });

    test('cannot-determine STOPS the walk and carries its reason', async () => {
        const { register } = await import('./registry');
        register(pluginWith('walk-cd', screen({
            routePrefix: 'wtwo',
            parse: () => ({ ok: false, token: 'cannot-determine',
                            reason: '"nope" is not a numeric id' }),
        })));
        const r = walkScreens('/wtwo/nope', '', CTX);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.token).toBe('cannot-determine');
        expect(r.reason).toContain('nope');
    });

    test('a DISABLED screen is skipped entirely', async () => {
        const { register } = await import('./registry');
        register({
            id: 'walk-off',
            contributions: [{ id: 'walk-off', surface: 'app-screen',
                              enabled: () => false,
                              payload: screen({ routePrefix: 'wthree' }) } as Contribution],
        });
        const r = walkScreens('/wthree/x', '', CTX);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.token).toBe('no-match');
    });
});

describe('THE NEGATIVE CONTROL: one bad screen must not take navigation down', () => {
    beforeEach(() => { resetMountedScreens(); });

    test('a screen whose parse THROWS is skipped, and the others still route', async () => {
        const { register } = await import('./registry');
        let goodWasAsked = false;
        // ORDER IS THE POINT. `order: 1` puts the thrower FIRST, so a
        // walk that aborted on the throw could never reach the good
        // screen and this test would fail. Registering it after the good
        // one would let a broken walk pass.
        register(pluginWith('bad-throw', screen({
            routePrefix: 'bthrow',
            parse: () => { throw new TypeError('the plugin is broken'); },
        }), 1));
        register(pluginWith('good-after', screen({
            routePrefix: 'gafter',
            parse: (p) => { goodWasAsked = true; return { ok: true, route: { p } }; },
        }), 2));

        const err = vi.spyOn(console, 'error').mockImplementation(() => {});

        // 1. The bad screen's OWN path does not throw out of the walk.
        const onBad = walkScreens('/bthrow/x', '', CTX);
        expect(onBad.ok).toBe(false);
        if (!onBad.ok) {
            // DEGRADED TO no-match, NOT to cannot-determine. A
            // cannot-determine stops the walk, so mapping a throw onto
            // it would take navigation down wearing a correct-looking
            // log line.
            expect(onBad.token).toBe('no-match');
        }

        // 2. Navigation still works for every other screen.
        const onGood = walkScreens('/gafter/y', '', CTX);
        expect(onGood.ok, 'the good screen stopped routing').toBe(true);
        if (onGood.ok) expect(onGood.contribution.id).toBe('good-after');
        expect(goodWasAsked).toBe(true);

        // 3. The refusal is LOGGED and names the offender.
        const lines = err.mock.calls.map((c) => String(c[0] ?? ''));
        err.mockRestore();
        expect(lines.some((l) => l.includes('bad-throw') && l.includes('parse'))).toBe(true);
    });

    test('a screen whose ENABLED throws is skipped the same way', async () => {
        const { register } = await import('./registry');
        register({
            id: 'bad-enabled',
            contributions: [{ id: 'bad-enabled', surface: 'app-screen', order: 1,
                              enabled: () => { throw new Error('nope'); },
                              payload: screen({ routePrefix: 'benab' }) } as Contribution],
        });
        register(pluginWith('good-enabled', screen({ routePrefix: 'genab' }), 2));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(walkScreens('/benab/x', '', CTX).ok).toBe(false);
        expect(walkScreens('/genab/x', '', CTX).ok).toBe(true);
        err.mockRestore();
    });

    test('a screen answering OFF-CONTRACT is treated exactly like a throw', async () => {
        const { register } = await import('./registry');
        const shapes: unknown[] = [undefined, null, 'ok', 42, {},
                                   { ok: false },
                                   { ok: false, token: 'invented' },
                                   { ok: false, token: 'cannot-determine' },
                                   { ok: 'yes', route: {} }];
        let i = 0;
        register(pluginWith('bad-shape', screen({
            routePrefix: 'bshape',
            parse: () => shapes[i] as ScreenRouteResult<unknown>,
        }), 1));
        register(pluginWith('good-shape', screen({ routePrefix: 'gshape' }), 2));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (i = 0; i < shapes.length; i++) {
            const r = walkScreens('/bshape/x', '', CTX);
            expect(r.ok, `shape ${JSON.stringify(shapes[i])} was accepted`).toBe(false);
            if (!r.ok) expect(r.token).toBe('no-match');
        }
        // And the good screen is untouched throughout.
        expect(walkScreens('/gshape/x', '', CTX).ok).toBe(true);
        err.mockRestore();
    });
});

describe('the mount lifecycle: mount once, show after, hide on leave', () => {
    /** A host over a fake document holding one element per id. */
    function hostOver(elements: Record<string, Element>): ScreenHost {
        return {
            getElement: (id) => elements[id] ?? null,
            transport: () => Promise.resolve(null),
        };
    }

    /** The smallest thing `deliverRoute` treats as a container. */
    function element(): Element {
        return { nodeName: 'DIV' } as unknown as Element;
    }

    beforeEach(() => { resetMountedScreens(); });

    test('the first route MOUNTS, the second SHOWS, and hide keeps the mount', () => {
        const calls: string[] = [];
        const payload = screen({
            routePrefix: 'life',
            screenId: 'life-screen',
            apiPrefixes: ['/archive'],
            mount: (_el, route) => calls.push('mount:' + JSON.stringify(route)),
            show: (route) => calls.push('show:' + JSON.stringify(route)),
            hide: () => calls.push('hide'),
        });
        const contribution = pluginWith('life', payload).contributions[0] as
            Contribution<'app-screen'>;
        const el = element();
        const host = hostOver({ 'life-screen': el });

        expect(deliverRoute(contribution, { n: 1 }, CTX, host)).toBe(true);
        expect(deliverRoute(contribution, { n: 2 }, CTX, host)).toBe(true);
        expect(hideScreen('life')).toBe(true);
        // MOUNTED ONCE. A deep link to a line number must not remount
        // the reader and lose its position.
        expect(calls).toEqual(['mount:{"n":1}', 'show:{"n":2}', 'hide']);

        // After a hide the mount is KEPT, so the next delivery SHOWS.
        expect(deliverRoute(contribution, { n: 3 }, CTX, host)).toBe(true);
        expect(calls[3]).toBe('show:{"n":3}');
    });

    test('mount receives a client granted EXACTLY the declared prefixes', async () => {
        const sent: string[] = [];
        let grants: readonly string[] = [];
        let refused: unknown = null;
        const payload = screen({
            routePrefix: 'grant',
            screenId: 'grant-screen',
            apiPrefixes: ['/archive'],
            mount: (_el, _r, _c, api) => {
                grants = api.grants;
                void api.call('/archive/x');
                refused = api.call('/sessions/respawn');
            },
        });
        const contribution = pluginWith('grant', payload).contributions[0] as
            Contribution<'app-screen'>;
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        deliverRoute(contribution, {}, CTX, {
            getElement: () => element(),
            transport: (p) => { sent.push(p); return Promise.resolve(null); },
        });
        await expect(refused).rejects.toThrow();
        err.mockRestore();
        expect(Array.from(grants)).toEqual(['/archive']);
        expect(sent).toEqual(['/api/v1/archive/x']);
    });

    test('a MISSING container is a warned no-op, never a throw', () => {
        let mounted = false;
        const payload = screen({ routePrefix: 'gone', screenId: 'not-here',
                                 mount: () => { mounted = true; } });
        const contribution = pluginWith('gone', payload).contributions[0] as
            Contribution<'app-screen'>;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(deliverRoute(contribution, {}, CTX, hostOver({}))).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        expect(mounted).toBe(false);
    });

    test('a REPLACED container is remounted, not shown into detached nodes', () => {
        const calls: string[] = [];
        const payload = screen({ routePrefix: 'swap', screenId: 'swap-screen',
                                 mount: () => calls.push('mount'),
                                 show: () => calls.push('show') });
        const contribution = pluginWith('swap', payload).contributions[0] as
            Contribution<'app-screen'>;
        const first = element();
        const second = element();
        let current = first;
        const host: ScreenHost = { getElement: () => current,
                                   transport: () => Promise.resolve(null) };
        deliverRoute(contribution, {}, CTX, host);
        deliverRoute(contribution, {}, CTX, host);
        current = second;
        deliverRoute(contribution, {}, CTX, host);
        expect(calls).toEqual(['mount', 'show', 'mount']);
    });

    test('a mount that THROWS records nothing, so the next delivery mounts again', () => {
        const calls: string[] = [];
        let explode = true;
        const payload = screen({
            routePrefix: 'boom', screenId: 'boom-screen',
            mount: () => { calls.push('mount'); if (explode) throw new Error('no'); },
            show: () => calls.push('show'),
        });
        const contribution = pluginWith('boom', payload).contributions[0] as
            Contribution<'app-screen'>;
        const host = hostOver({ 'boom-screen': element() });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(deliverRoute(contribution, {}, CTX, host)).toBe(false);
        explode = false;
        expect(deliverRoute(contribution, {}, CTX, host)).toBe(true);
        err.mockRestore();
        // Never a `show` against a half-built object.
        expect(calls).toEqual(['mount', 'mount']);
    });

    test('showing a second screen HIDES the first', () => {
        const calls: string[] = [];
        const one = pluginWith('one', screen({
            routePrefix: 'sone', screenId: 'sone-screen',
            mount: () => calls.push('one:mount'), hide: () => calls.push('one:hide'),
        })).contributions[0] as Contribution<'app-screen'>;
        const two = pluginWith('two', screen({
            routePrefix: 'stwo', screenId: 'stwo-screen',
            mount: () => calls.push('two:mount'), hide: () => calls.push('two:hide'),
        })).contributions[0] as Contribution<'app-screen'>;
        const host = hostOver({ 'sone-screen': element(), 'stwo-screen': element() });
        deliverRoute(one, {}, CTX, host);
        deliverRoute(two, {}, CTX, host);
        expect(calls).toEqual(['one:mount', 'one:hide', 'two:mount']);
        expect(visibleScreen()).toBe('two');
    });

    test('hideVisibleScreen names what it hid, and answers null when nothing is up', () => {
        expect(hideVisibleScreen()).toBeNull();
        const c = pluginWith('vis', screen({ routePrefix: 'vis', screenId: 'vis-screen' }))
            .contributions[0] as Contribution<'app-screen'>;
        deliverRoute(c, {}, CTX, hostOver({ 'vis-screen': element() }));
        expect(visibleScreen()).toBe('vis');
        expect(hideVisibleScreen()).toBe('vis');
        expect(visibleScreen()).toBeNull();
        expect(hideVisibleScreen()).toBeNull();
    });

    test('a hide that THROWS is logged and still clears the visible screen', () => {
        const c = pluginWith('badhide', screen({
            routePrefix: 'bh', screenId: 'bh-screen',
            hide: () => { throw new Error('no'); },
        })).contributions[0] as Contribution<'app-screen'>;
        deliverRoute(c, {}, CTX, hostOver({ 'bh-screen': element() }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(hideScreen('badhide')).toBe(true);
        err.mockRestore();
        expect(visibleScreen()).toBeNull();
    });
});
