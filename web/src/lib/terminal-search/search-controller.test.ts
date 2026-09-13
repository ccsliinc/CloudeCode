/**
 * THE PANEL'S LIFECYCLE, DRIVEN THROUGH AN INJECTED HOST.
 *
 * Ported from the lifecycle half of
 * `tests/test_terminal_search_keys.node.mjs`. Node environment on
 * purpose: nothing here is about a rendered element, it is about which
 * call the controller makes and which it refuses, and every refusal is
 * handed in through the host rather than staged in a browser.
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import { SearchController, SESSION_WATCH_MS, TYPE_DEBOUNCE_MS } from './search-controller.svelte';
import type { SearchHost } from './search-host';
import type { BufferLike, EngineResults } from './types';

/** Everything a harness records, so an assertion can be about a call. */
interface Calls {
    attach: unknown[];
    find: Array<[string, string]>;
    next: number;
    prev: number;
    clear: number;
    predicate: string[];
    history: Array<string | null>;
    deepHref: string[];
    deepOpen: string[];
    focusTerm: number;
}

/** What a harness lets a test move underneath the controller. */
interface World {
    sessionId: string | null;
    bufferType: string;
    screenActive: boolean;
    modalDepth: number;
    /** What DeepDive.hrefFor resolves to, or a rejection. */
    deepHref: string | null | Error;
    /** Present unless a test removes a whole module. */
    withHistory: boolean;
    withDeepDive: boolean;
    historyResult: { loaded?: 'painted' | 'already' | 'unavailable' } | Error;
    onResults: null | ((r: EngineResults) => void);
}

function harness(patch: Partial<World> = {}) {
    const world: World = {
        sessionId: 'ses_a',
        bufferType: 'normal',
        screenActive: true,
        modalDepth: 0,
        deepHref: '/archive/p/12?q=hazard',
        withHistory: true,
        withDeepDive: true,
        historyResult: { loaded: 'painted' },
        onResults: null,
        ...patch,
    };
    const calls: Calls = {
        attach: [],
        find: [],
        next: 0,
        prev: 0,
        clear: 0,
        predicate: [],
        history: [],
        deepHref: [],
        deepOpen: [],
        focusTerm: 0,
    };
    const buffer: BufferLike = { baseY: 0, cursorY: 0, viewportY: 0, length: 10 };
    const term = {
        cols: 80,
        rows: 24,
        get buffer() {
            return { active: { ...buffer, type: world.bufferType } };
        },
        registerMarker: () => null,
        scrollToLine: () => {},
    };
    const host: SearchHost = {
        term: () => term,
        sessionId: () => world.sessionId,
        currentSession: () => ({ working_dir: '/p' }),
        engine: () => ({
            attach: (t) => calls.attach.push(t),
            find: (q, _o, dir) => calls.find.push([q, dir]),
            next: () => {
                calls.next += 1;
            },
            prev: () => {
                calls.prev += 1;
            },
            clear: () => {
                calls.clear += 1;
            },
            onResults: (cb) => {
                world.onResults = cb;
                return () => {
                    world.onResults = null;
                };
            },
            predicate: (q) => {
                calls.predicate.push(q);
                return (text: string) => text.includes(q);
            },
        }),
        history: () =>
            world.withHistory
                ? {
                    ensureLoaded: (_t, id) => {
                        calls.history.push(id);
                        return world.historyResult instanceof Error
                            ? Promise.reject(world.historyResult)
                            : Promise.resolve(world.historyResult);
                    },
                }
                : null,
        deepDive: () =>
            world.withDeepDive
                ? {
                    MIN_QUERY_CHARS: 2,
                    hrefFor: (_s, q) => {
                        calls.deepHref.push(q);
                        return world.deepHref instanceof Error
                            ? Promise.reject(world.deepHref)
                            : Promise.resolve(world.deepHref);
                    },
                    open: (_s, q) => {
                        calls.deepOpen.push(q);
                        return Promise.resolve(true);
                    },
                }
                : null,
        // The scanner is a pure vanilla module; the rail's own behaviour
        // is measured in PromptRail.test.ts against the REAL geometry.
        promptScan: () => ({
            scan: () => [],
            layoutTicks: () => [],
            currentOrdinalFor: () => 0,
        }),
        isRule: () => undefined,
        modalOpen: () => world.modalDepth > 0,
        terminalScreenActive: () => world.screenActive,
        focusTerm: () => {
            calls.focusTerm += 1;
        },
    };
    return { calls, world, host, controller: new SearchController(host) };
}

/** Let every pending microtask land. */
async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

let open: SearchController | null = null;

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    open?.close();
    open = null;
    vi.useRealTimers();
});

describe('opening', () => {
    test('the engine goes on the LIVE term and the rail is shown', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        expect(h.controller.isOpen()).toBe(true);
        expect(h.calls.attach).toHaveLength(1);
        expect(h.controller.rail.hidden).toBe(true);
        // Hidden because this fixture scans no prompts, which is the same
        // reason an empty buffer hides it in the app. What matters here
        // is that show() ran at all, which the refresh below proves.
        expect(h.calls.history).toEqual(['ses_a']);
    });

    test('the tmux history load is asked for, for THIS session', async () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        expect(h.controller.history).toBe('pending');
        await settle();
        expect(h.controller.history).toBe('painted');
    });

    test('a missing history module is `unavailable`, not `pending` forever', () => {
        const h = harness({ withHistory: false });
        open = h.controller;
        h.controller.open();
        expect(h.controller.history).toBe('unavailable');
        expect(h.controller.countText).toBe('searching recent output only');
    });

    test('a history load that threw degrades to `unavailable`', async () => {
        const h = harness({ historyResult: new Error('nope') });
        open = h.controller;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        h.controller.open();
        await settle();
        expect(h.controller.history).toBe('unavailable');
    });

    test('NEGATIVE: with no terminal attached, open does nothing at all', () => {
        const h = harness();
        (h.host as { term: () => null }).term = () => null;
        h.controller.open();
        expect(h.controller.isOpen()).toBe(false);
        expect(h.calls.attach).toEqual([]);
    });

    test('a second open refocuses and does not re-attach or re-fetch', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.open();
        expect(h.calls.attach).toHaveLength(1);
        expect(h.calls.history).toHaveLength(1);
    });
});

describe('typing', () => {
    test('nothing runs until the debounce elapses, then find and the rail filter do', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.onType();
        expect(h.calls.find).toEqual([]);
        vi.advanceTimersByTime(TYPE_DEBOUNCE_MS);
        expect(h.calls.find).toEqual([['hazard', 'next']]);
        expect(h.calls.predicate).toEqual(['hazard']);
    });

    test('a burst of keystrokes pays for ONE search', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        for (const q of ['h', 'ha', 'haz']) {
            h.controller.query = q;
            h.controller.onType();
            vi.advanceTimersByTime(TYPE_DEBOUNCE_MS - 1);
        }
        vi.advanceTimersByTime(1);
        expect(h.calls.find).toEqual([['haz', 'next']]);
    });

    test('a debounce that lands after a close runs nothing', () => {
        const h = harness();
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.onType();
        h.controller.close();
        vi.advanceTimersByTime(TYPE_DEBOUNCE_MS * 4);
        expect(h.calls.find).toEqual([]);
    });

    test('the counter reads the add-on report as it arrives', async () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        // The history load has to land first: while it is in flight the
        // counter says so, whatever the add-on has reported.
        await settle();
        h.controller.query = 'hazard';
        h.world.onResults?.({ resultIndex: 1, resultCount: 4, limit: 1000 });
        expect(h.controller.countText).toBe('2 of 4');
    });
});

describe('walking matches', () => {
    test('step calls next and prev', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.step('next');
        h.controller.step('prev');
        expect(h.calls.next).toBe(1);
        expect(h.calls.prev).toBe(1);
    });

    test('NEGATIVE: with an empty query a step does nothing', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.step('next');
        expect(h.calls.next).toBe(0);
    });
});

describe('closing', () => {
    test('close drops every highlight, hides the rail and refocuses the pane', () => {
        const h = harness();
        h.controller.open();
        h.controller.close();
        expect(h.controller.isOpen()).toBe(false);
        expect(h.calls.clear).toBe(1);
        expect(h.controller.rail.hidden).toBe(true);
        expect(h.calls.focusTerm).toBe(1);
    });

    test('close unsubscribes from the add-on rather than leaking a listener', () => {
        const h = harness();
        h.controller.open();
        expect(h.world.onResults).not.toBeNull();
        h.controller.close();
        expect(h.world.onResults).toBeNull();
    });

    test('toggle opens then closes', () => {
        const h = harness();
        open = h.controller;
        h.controller.toggle();
        expect(h.controller.isOpen()).toBe(true);
        h.controller.toggle();
        expect(h.controller.isOpen()).toBe(false);
    });
});

describe('the session underneath', () => {
    test('a session switch closes the panel', () => {
        // One session's query must never filter another session's rail.
        const h = harness();
        h.controller.open();
        h.world.sessionId = 'ses_b';
        vi.advanceTimersByTime(SESSION_WATCH_MS);
        expect(h.controller.isOpen()).toBe(false);
    });

    test('NEGATIVE: a null session id is not a mismatch and must not close it', () => {
        // The controller answers null while a connect is in flight.
        // Closing on that would shut the panel during a reconnect of the
        // very session it is searching.
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.world.sessionId = null;
        vi.advanceTimersByTime(SESSION_WATCH_MS * 3);
        expect(h.controller.isOpen()).toBe(true);
    });

    test('a history answer for a session we have left is discarded', async () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.world.sessionId = 'ses_b';
        vi.advanceTimersByTime(SESSION_WATCH_MS);
        await settle();
        expect(h.controller.isOpen()).toBe(false);
        expect(h.controller.history).toBeNull();
    });
});

describe('deep dive', () => {
    test('under the archive floor it refuses and says why', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'a';
        h.controller.refreshDeepDive();
        expect(h.controller.deepEnabled).toBe(false);
        expect(h.controller.deepTitle).toBe('type at least 2 characters');
    });

    test('a project with an archive enables it', async () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.refreshDeepDive();
        await settle();
        expect(h.controller.deepEnabled).toBe(true);
        expect(h.calls.deepHref).toContain('hazard');
    });

    test('a project with no archived conversations refuses and says why', async () => {
        const h = harness({ deepHref: null });
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.refreshDeepDive();
        await settle();
        expect(h.controller.deepEnabled).toBe(false);
        expect(h.controller.deepTitle).toBe('no archived conversations for this folder');
    });

    test('a missing DeepDive module refuses and says why', () => {
        const h = harness({ withDeepDive: false });
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.refreshDeepDive();
        expect(h.controller.deepEnabled).toBe(false);
        expect(h.controller.deepTitle).toBe('the conversation archive is not available');
    });

    test('a lookup that lands for a query the user has moved off is ignored', async () => {
        // No history module, so nothing else re-runs the lookup while the
        // stale one is in flight - the settled history load legitimately
        // re-queries for whatever is in the box by then.
        const h = harness({ deepHref: null, withHistory: false });
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.refreshDeepDive();
        h.controller.query = 'other';
        await settle();
        // Claim at the gesture, check at the write: the stale answer must
        // not disable the button for a query it was never about.
        expect(h.controller.deepTitle).not.toBe('no archived conversations for this folder');
    });

    test('NEGATIVE: pressing it while it refuses navigates nowhere', () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'a';
        h.controller.refreshDeepDive();
        h.controller.openDeepDive();
        expect(h.calls.deepOpen).toEqual([]);
    });

    test('pressing it while it is enabled hands the query over', async () => {
        const h = harness();
        open = h.controller;
        h.controller.open();
        h.controller.query = 'hazard';
        h.controller.refreshDeepDive();
        await settle();
        h.controller.openDeepDive();
        expect(h.calls.deepOpen).toEqual(['hazard']);
    });
});
