/**
 * The way in and out, and the availability gate. PORTED from the
 * BEHAVIOURAL half of `tests/test_archive_entry_points.node.mjs` and
 * from `tests/test_message_archive_client_gate.node.mjs`.
 *
 * WHICH HALF MOVED, AND WHY THE OTHER HALF DID NOT. Those two node
 * suites each do two jobs. One is behavioural - load the module, drive
 * `open()` and `ensure()`, assert what happened - and its subject is
 * `archive-entry.js`, which this slice moves, so it moves with it. The
 * other is a set of SOURCE assertions about `client/index.html`,
 * `client/js/header-menu.js` and `client/js/launchpad.js`: that the
 * header owns exactly one archive control, that it carries no inline
 * event handler, that the launchpad grew no second door. Those files are
 * NOT moving in this slice, so those cases stay in their node suites and
 * were re-pointed at the seam that replaced the global. Moving them here
 * would have left a Vitest suite reading `client/index.html`, which is
 * a worse home for them than the one they have.
 *
 * THE AVAILABILITY CASES ARE THE ONES TO READ TWICE. Three states, and
 * `unknown` is not a flavour of `disabled`: a door drawn on a guess
 * leads onto a wall of 404s, and the two failure directions are not
 * symmetric. Every "could not tell" case below asserts `unknown`
 * explicitly rather than asserting "not enabled", because the second
 * would pass for a gate that collapsed the three into two.
 */
import { describe, expect, test, vi } from 'vitest';
import { createAvailability } from './availability';
import { createHistoryScreen, API_PREFIXES, SCREEN_ID } from './screen';
import { createHistoryPlugin, HISTORY_SCREEN_ID } from './index';
import { ARCHIVE_PREFIX, ARCHIVE_ROUTE_PREFIX } from './route';
import { createScreenApi } from '../screen-api';
import type { ScreenApi } from '../types';
import type { ScreenShellHost } from './screen';

/** What a driven host recorded. */
interface Calls {
    pushed: string[];
    shown: unknown[];
    launcher: number;
    visible: boolean[];
}

/** A host over a fake address bar and a fake app shell. */
function hostAt(opts: { pathname?: string; throwOnPush?: boolean;
                        withApp?: boolean } = {}): { host: ScreenShellHost; calls: Calls } {
    const calls: Calls = { pushed: [], shown: [], launcher: 0, visible: [] };
    let path = opts.pathname ?? '/';
    const withApp = opts.withApp !== false;
    const host: ScreenShellHost = {
        showScreen(route) {
            if (!withApp) return false;
            calls.shown.push(route);
            return true;
        },
        showLauncher() {
            if (!withApp) return false;
            calls.launcher++;
            return true;
        },
        pushPath(p) {
            if (opts.throwOnPush) return false;
            calls.pushed.push(p);
            path = p;
            return true;
        },
        currentPath: () => path,
        setVisible: (_el, v) => { calls.visible.push(v); },
    };
    return { host, calls };
}

/**
 * A granted client answering `/features` with a given block.
 *
 * THE DOUBLE IS ENVELOPE-SHAPED AS OF SLICE 2, because the real
 * transport is: it hands back `{envelope, httpStatus, headers,
 * transportError, refusedByGrant}` rather than the parsed body, so that
 * the archive's 404s can arrive carrying the envelope they really do
 * carry. A double still shaped like the body would make every case here
 * pass against a gate that could not read a real answer, which is this
 * project's recurring "the test handed in a recorder" failure with the
 * recorder one layer out of date.
 */
function featuresApi(block: unknown, seen?: string[]): ScreenApi {
    return {
        grants: Array.from(API_PREFIXES),
        call: (p: string) => {
            seen?.push(p);
            return Promise.resolve({
                envelope: { message_archive: block },
                httpStatus: 200, headers: null,
                transportError: null, refusedByGrant: false,
            });
        },
    };
}

describe('the entry point actually navigates', () => {
    test('open() writes the address bar and then shows the screen', () => {
        const { host, calls } = hostAt({ pathname: '/' });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.open()).toBe(true);
        expect(calls.pushed, 'the URL was not written').toEqual(['/archive']);
        expect(calls.shown.length, 'the screen was not shown').toBe(1);
    });

    test('open() does not push a duplicate history entry when already there', () => {
        const { host, calls } = hostAt({ pathname: '/archive' });
        const screen = createHistoryScreen(host, featuresApi(null));
        screen.open();
        // Re-entering the archive must not add a redundant Back target.
        expect(calls.pushed).toEqual([]);
        expect(calls.shown.length, 'the screen must still be shown').toBe(1);
    });

    test('a blocked History API does not block the navigation', () => {
        // Sandboxed iframes throw on pushState. The router already
        // swallows exactly this. A wrong address bar is strictly smaller
        // than a screen that will not open.
        const { host, calls } = hostAt({ pathname: '/', throwOnPush: true });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.open(), 'a History refusal aborted the navigation').toBe(true);
        expect(calls.shown.length).toBe(1);
    });

    test('a missing app shell is reported, not silently swallowed', () => {
        // THREE OUTCOMES. "I navigated", "I could not navigate", and
        // never a quiet false that reads like success to the caller.
        const { host, calls } = hostAt({ pathname: '/', withApp: false });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.open(), 'open() claimed success with no shell').toBe(false);
        expect(calls.shown.length).toBe(0);
    });

    test('openRoute writes the route path, not the bare prefix', () => {
        const { host, calls } = hostAt({ pathname: '/' });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.openRoute({ view: 'line', transcriptId: 5767, lineNo: 1695 }))
            .toBe(true);
        expect(calls.pushed).toEqual(['/archive/t/5767/l/1695']);
    });

    test('close() writes / and shows the launcher', () => {
        // The launcher's own reset refuses to touch the address bar
        // while the path reads /archive, so the exit writes it here or
        // the next refresh lands the user back in the archive they left.
        const { host, calls } = hostAt({ pathname: '/archive/t/5767' });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.close()).toBe(true);
        expect(calls.pushed).toEqual(['/']);
        expect(calls.launcher).toBe(1);
    });

    test('close() does not re-push when already at the root', () => {
        const { host, calls } = hostAt({ pathname: '/' });
        const screen = createHistoryScreen(host, featuresApi(null));
        screen.close();
        expect(calls.pushed, 'no redundant history entry').toEqual([]);
        expect(calls.launcher, 'and it still navigates').toBe(1);
    });

    test('a blocked History API does not stop the way OUT either', () => {
        // Same tolerance open() has: a wrong address bar is a strictly
        // smaller problem than being stuck on the archive.
        const { host, calls } = hostAt({ pathname: '/archive', throwOnPush: true });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.close()).toBe(true);
        expect(calls.launcher).toBe(1);
    });

    test('close() reports a missing app shell rather than throwing', () => {
        const { host, calls } = hostAt({ pathname: '/archive', withApp: false });
        const screen = createHistoryScreen(host, featuresApi(null));
        expect(screen.close(), 'a named refusal, not an exception').toBe(false);
        expect(calls.launcher).toBe(0);
    });

    test('a DISABLED archive refuses open(), and says why', async () => {
        const { host, calls } = hostAt({ pathname: '/' });
        const screen = createHistoryScreen(host, featuresApi(
            { state: 'disabled', reason: 'the switch is off' }));
        await screen.ensure();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(screen.open()).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        expect(calls.shown.length).toBe(0);
        expect(calls.pushed).toEqual([]);
    });

    test('an UNKNOWN archive does NOT refuse open()', async () => {
        // The asymmetry, stated as a test: turning "I could not tell"
        // into a refusal is the same false verdict in the other
        // direction. The DOORS are hidden on unknown; the navigation
        // itself is not blocked.
        const { host, calls } = hostAt({ pathname: '/' });
        const screen = createHistoryScreen(host, featuresApi(null));
        await screen.ensure();
        expect(screen.state()).toBe('unknown');
        expect(screen.open()).toBe(true);
        expect(calls.shown.length).toBe(1);
    });
});

describe('the availability gate has THREE states', () => {
    test('a measured enabled is enabled, and carries the reason', async () => {
        const gate = createAvailability(featuresApi(
            { state: 'enabled', reason: 'switched on in config' }));
        expect(await gate.ensure()).toBe('enabled');
        expect(gate.state()).toBe('enabled');
        expect(gate.reason()).toBe('switched on in config');
    });

    test('a measured disabled is disabled, never unknown', async () => {
        const gate = createAvailability(featuresApi({ state: 'disabled', reason: 'off' }));
        expect(await gate.ensure()).toBe('disabled');
    });

    test('it starts UNKNOWN and never starts enabled', () => {
        expect(createAvailability(featuresApi(null)).state()).toBe('unknown');
    });

    test('every could-not-tell answer is UNKNOWN, not disabled', async () => {
        const cases: unknown[] = [
            null,
            undefined,
            {},
            { state: 42 },
            { state: 'cannot_determine' },
            { state: 'a value this build does not know' },
        ];
        for (const block of cases) {
            const gate = createAvailability(featuresApi(block));
            expect(await gate.ensure(),
                   `block ${JSON.stringify(block)} must read unknown`).toBe('unknown');
        }
    });

    test('a RESOLVED transport failure is UNKNOWN and names the real cause', async () => {
        // THE RUNG THAT MOVED IN SLICE 2, asserted rather than left to
        // a fall-through. The transport now resolves a dead network
        // instead of rejecting, so this arrives in the `then` and not in
        // the `catch`. The verdict is the same UNKNOWN it always was;
        // what would have been lost is the SENTENCE - a fall-through
        // would have said "the server did not report a message archive
        // state", which is true of a server that was never reached and
        // sends the reader to the wrong half of the application.
        const gate = createAvailability({
            grants: ['/features'],
            call: () => Promise.resolve({
                envelope: null, httpStatus: null, headers: null,
                transportError: 'request failed: Failed to fetch',
                refusedByGrant: false,
            }),
        });
        expect(await gate.ensure()).toBe('unknown');
        expect(gate.reason()).toContain('Failed to fetch');
        expect(gate.reason(), 'the reason named the wrong cause: the server was never '
            + 'reached, so it cannot have failed to report a state')
            .not.toContain('did not report');
    });

    test('a rejected probe is UNKNOWN and names the failure', async () => {
        const gate = createAvailability({
            grants: ['/features'],
            call: () => Promise.reject(new Error('network died')),
        });
        expect(await gate.ensure()).toBe('unknown');
        expect(gate.reason()).toContain('network died');
    });

    test('a GRANT REFUSAL leaves it UNKNOWN, so no door is drawn', async () => {
        // The failure direction that matters: a screen whose grant did
        // not cover /features must not end up reading `enabled`.
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const gate = createAvailability(
            createScreenApi(['/archive'], () => Promise.resolve({}), 'history'));
        expect(await gate.ensure()).toBe('unknown');
        err.mockRestore();
    });

    test('a missing client is UNKNOWN without throwing', async () => {
        const gate = createAvailability(null as unknown as ScreenApi);
        expect(await gate.ensure()).toBe('unknown');
        expect(gate.reason()).toContain('not available');
    });

    test('N callers make ONE request', async () => {
        let calls = 0;
        const gate = createAvailability({
            grants: ['/features'],
            call: () => { calls++; return Promise.resolve({ message_archive: { state: 'enabled' } }); },
        });
        await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
        await gate.ensure();
        expect(calls).toBe(1);
    });

    test('it asks /features, and only /features', async () => {
        const seen: string[] = [];
        await createAvailability(featuresApi({ state: 'enabled' }, seen)).ensure();
        expect(seen).toEqual(['/features']);
    });

    test('onResolved fires once, and a LATE subscriber is not stranded', async () => {
        const gate = createAvailability(featuresApi({ state: 'enabled' }));
        const early: string[] = [];
        gate.onResolved((s) => early.push('early:' + s));
        await gate.ensure();
        const late: string[] = [];
        gate.onResolved((s) => late.push('late:' + s));
        expect(early).toEqual(['early:enabled']);
        expect(late, 'a late subscriber missed the only event it wanted')
            .toEqual(['late:enabled']);
    });

    test('one throwing subscriber does not stop the others', async () => {
        const gate = createAvailability(featuresApi({ state: 'enabled' }));
        const seen: string[] = [];
        gate.onResolved(() => { throw new Error('bad subscriber'); });
        gate.onResolved((s) => seen.push(s));
        await gate.ensure();
        expect(seen).toEqual(['enabled']);
    });
});

describe('the contribution, and what the host may rely on', () => {
    test('the plugin declares one app-screen on the archive prefix', () => {
        const { plugin } = createHistoryPlugin(hostAt().host, () => Promise.resolve(null));
        expect(plugin.contributions.length).toBe(1);
        const c = plugin.contributions[0]!;
        expect(c.surface).toBe('app-screen');
        expect(c.id).toBe(HISTORY_SCREEN_ID);
        const payload = c.payload as { routePrefix: string; screenId: string;
                                       apiPrefixes: readonly string[] };
        expect(payload.routePrefix).toBe(ARCHIVE_ROUTE_PREFIX);
        expect(payload.screenId).toBe(SCREEN_ID);
        expect(Array.from(payload.apiPrefixes)).toEqual(['/archive', '/features']);
    });

    test('the route prefix and the path prefix agree', () => {
        // They used to be two constants in two files - `ArchiveEntry.PATH`
        // and `Router.ARCHIVE_PREFIX` - and the node suite this replaces
        // asserted they matched by reading router.js. One owner now, so
        // the assertion is that the derived segment is the path's.
        expect('/' + ARCHIVE_ROUTE_PREFIX).toBe(ARCHIVE_PREFIX);
    });

    test('enabled() is TRUE even when the archive is switched off', async () => {
        // A deep link to /archive on a server with the archive off must
        // still reach THIS screen so it can say so. Returning false here
        // would fall the path through to the launcher, which is the
        // silent redirect the whole route design refuses.
        const { plugin, screen } = createHistoryPlugin(
            hostAt().host,
            // A TRANSPORT double, so envelope-shaped: this is the raw
            // transport the host hands `createHistoryPlugin`, not a
            // granted client, and the shape it answers in is what the
            // real one answers in.
            () => Promise.resolve({
                envelope: { message_archive: { state: 'disabled', reason: 'off' } },
                httpStatus: 200, headers: null,
                transportError: null, refusedByGrant: false,
            }));
        await screen.ensure();
        expect(screen.state()).toBe('disabled');
        expect(plugin.contributions[0]!.enabled({ flags: {}, refresh: () => {} })).toBe(true);
    });

    test('buildPath is the inverse of parse, through the payload', () => {
        const { plugin } = createHistoryPlugin(hostAt().host, () => Promise.resolve(null));
        const payload = plugin.contributions[0]!.payload as {
            parse(p: string, s: string): { ok: boolean; route?: unknown };
            buildPath(r: unknown): string | null;
        };
        for (const p of ['/archive', '/archive/p/12', '/archive/t/5767',
                         '/archive/t/5767/l/1695']) {
            const r = payload.parse(p, '');
            expect(r.ok, p).toBe(true);
            expect(payload.buildPath(r.route)).toBe(p);
        }
    });

    test('the tracker and the resolver are built once each', () => {
        const { screen } = createHistoryPlugin(hostAt().host, () => Promise.resolve(null));
        expect(screen.tracker()).toBe(screen.tracker());
        expect(screen.resolver()).toBe(screen.resolver());
    });
});
