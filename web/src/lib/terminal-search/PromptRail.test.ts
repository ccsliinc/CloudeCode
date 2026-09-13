/**
 * THE RAIL, MOUNTED, DRIVEN THROUGH THE REAL TICK GEOMETRY.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE NEEDS A DOCUMENT, when the config's default is Node and
 * its comment asks for a reason: the rail's height is a MEASUREMENT off
 * a real element and the tick layout is proportional to it, so a test
 * that stubbed the measurement would be asserting its own fixture.
 *
 * THE GEOMETRY IS THE SHIPPED ONE, NOT A COPY. `layoutTicks` and
 * `currentOrdinalFor` are loaded out of the real
 * `client/js/terminal-prompt-scan.js`, which stays a framework-free
 * vanilla module and has its own suite
 * (`tests/test_terminal_prompt_scan.node.mjs`). Only `scan` is replaced,
 * because feeding it a real xterm cell buffer is that suite's job and
 * not this one's.
 *
 * Ported from `tests/test_terminal_prompt_rail.node.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import PromptRail from './PromptRail.svelte';
import { RailModel } from './rail-model.svelte';
import type { MarkerLike, PromptScanApi, ScannedPrompt } from './types';

/** The real scanner module, evaluated once into a plain object. */
const realScan: PromptScanApi = (() => {
    // `process.cwd()` and not `import.meta.url`: under the jsdom
    // environment this file opts into, `import.meta.url` is an http URL
    // and `readFileSync` refuses it. Vitest's cwd is `web/`, this
    // project's root.
    const src = fs.readFileSync(
        path.resolve(process.cwd(), '..', 'client', 'js', 'terminal-prompt-scan.js'),
        'utf8',
    );
    const target: Record<string, unknown> = {};
    // The module is an IIFE over `typeof window !== 'undefined' ? window
    // : globalThis`. Handing it a `window` parameter is what makes it
    // publish onto this object instead of onto the jsdom global, so the
    // test cannot accidentally depend on load order.
    new Function('window', src)(target);
    return target.TerminalPromptScan as PromptScanApi;
})();

/** One scanned prompt. */
function prompt(ordinal: number, line: number, text: string): ScannedPrompt {
    return { ordinal, line, text, preview: text.slice(0, 80) };
}

/** A fake marker: xterm's contract, none of xterm. */
function marker(line: number): MarkerLike {
    return {
        line,
        isDisposed: false,
        dispose(this: MarkerLike) {
            this.isDisposed = true;
        },
    };
}

interface Harness {
    rail: RailModel;
    el: HTMLElement;
    ticks: () => HTMLButtonElement[];
    markers: MarkerLike[];
    offsets: number[];
    scrolled: number[];
    setBuffer: (patch: Record<string, unknown>) => void;
    clickStrip: (x: number, y: number) => void;
    destroy: () => void;
}

/** Where the harness pretends the strip's box sits in the viewport. */
const STRIP_LEFT = 40;
const STRIP_TOP = 160;
/** The strip's width, matching the component's own stylesheet. */
const STRIP_WIDTH = 24;

/**
 * Mount the rail over a fixed set of prompts.
 *
 * Inputs: prompts, and the strip height to report from the DOM.
 * Output: Harness.
 */
function mountRail(prompts: ScannedPrompt[], height = 400): Harness {
    const buffer: Record<string, unknown> = {
        type: 'normal',
        baseY: 100,
        cursorY: 5,
        viewportY: 0,
        length: 1000,
    };
    const markers: MarkerLike[] = [];
    const offsets: number[] = [];
    const scrolled: number[] = [];
    const term = {
        cols: 80,
        rows: 24,
        get buffer() {
            return { active: buffer };
        },
        registerMarker: (offset: number) => {
            offsets.push(offset);
            const m = marker(
                (buffer.baseY as number) + (buffer.cursorY as number) + offset,
            );
            markers.push(m);
            return m;
        },
        scrollToLine: (line: number) => scrolled.push(line),
    };
    const rail = new RailModel({
        term: () => term,
        promptScan: () => ({ ...realScan, scan: () => prompts.map((p) => ({ ...p })) }),
        isRule: () => undefined,
    });

    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(PromptRail, { target, props: { rail } });
    flushSync();
    const el = target.querySelector('.terminal-prompt-rail') as HTMLElement;
    // jsdom lays nothing out, so the two measurements this component
    // makes have to be declared. They are real reads of a real element.
    Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    // The strip is deliberately NOT at the viewport origin: a handler
    // that used `clientY` raw instead of subtracting the box's own top
    // would pass against a rect of zeros and be wrong on every screen.
    el.getBoundingClientRect = () =>
        ({
            top: STRIP_TOP,
            left: STRIP_LEFT,
            right: STRIP_LEFT + STRIP_WIDTH,
            bottom: STRIP_TOP + height,
            width: STRIP_WIDTH,
            height,
            x: STRIP_LEFT,
            y: STRIP_TOP,
            toJSON: () => ({}),
        }) as DOMRect;
    rail.show();
    flushSync();

    return {
        rail,
        el,
        ticks: () => Array.from(el.querySelectorAll('.prompt-tick')),
        markers,
        offsets,
        scrolled,
        setBuffer: (patch) => Object.assign(buffer, patch),
        // A click on the STRIP, at a point given in the strip's own
        // coordinates. It is dispatched on the strip element, so the
        // event's target is the strip, exactly as a browser reports a
        // click that lands on the empty space beside a tick.
        clickStrip: (x, y) =>
            el.dispatchEvent(
                new window.MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    clientX: STRIP_LEFT + x,
                    clientY: STRIP_TOP + y,
                }),
            ),
        destroy: () => {
            rail.dispose();
            unmount(instance, { outro: false });
            target.remove();
        },
    };
}

let live: Harness | null = null;

/**
 * Mount a rail and register it for teardown, handing back a handle the
 * type system knows is there.
 *
 * Inputs: as `mountRail`. Output: Harness.
 */
function mounted(prompts: ScannedPrompt[], height?: number): Harness {
    const h = mountRail(prompts, height);
    live = h;
    return h;
}

/**
 * The nth element of a list, or a failure naming what was missing.
 *
 * Description: the tsconfig checks indexed access, and a bare `!` in a
 * test hides exactly the case worth being told about - a rail that
 * painted fewer ticks than the assertion below is about.
 * Inputs: list, index, what (for the message). Output: the element.
 */
function nth<T>(list: T[], index: number, what: string): T {
    const value = list[index];
    if (value === undefined) throw new Error(`no ${what} at index ${index}`);
    return value;
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    live?.destroy();
    live = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('painting the strip', () => {
    test('one tick per prompt when the strip has room for them', () => {
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 200, 'two'), prompt(3, 900, 'three')]);
        expect(h.ticks()).toHaveLength(3);
        expect(h.el.hidden).toBe(false);
    });

    test('a marker is registered at line minus baseY minus cursorY', () => {
        // xterm's asymmetry, not ours: registerMarker takes a RELATIVE
        // offset and scrollToLine takes the absolute line back.
        const h = mounted([prompt(1, 10, 'one')]);
        expect(h.offsets).toEqual([10 - 100 - 5]);
    });

    test('the tooltip reads "#n of N" and carries the preview', () => {
        const h = mounted([prompt(1, 10, 'run the tests'), prompt(2, 500, 'ship it')]);
        expect(nth(h.ticks(), 0, 'tick').getAttribute('title')).toBe('#1 of 2  run the tests');
        expect(nth(h.ticks(), 0, 'tick').getAttribute('aria-label')).toBe('#1 of 2  run the tests');
    });

    test('a cluster names its RANGE and is marked as one', () => {
        // Six prompts into a strip with room for three ticks.
        const h = mounted(
            [10, 20, 30, 40, 50, 60].map((line, i) => prompt(i + 1, line, `p${i + 1}`)),
            12,
        );
        const ticks = h.ticks();
        expect(ticks).toHaveLength(3);
        expect(nth(ticks, 0, 'tick').classList.contains('is-cluster')).toBe(true);
        expect(nth(ticks, 0, 'tick').getAttribute('title')).toContain('#1-#2 of 6');
    });

    test('NEGATIVE: a roomy strip produces no clusters at all', () => {
        // Without this the cluster test would pass against a rail that
        // merged everything unconditionally.
        const h = mounted(
            [10, 200, 400, 600, 800, 900].map((line, i) => prompt(i + 1, line, `p${i + 1}`)),
            400,
        );
        expect(h.ticks().every((t) => !t.classList.contains('is-cluster'))).toBe(true);
    });
});

describe('the filter', () => {
    test('a filter DIMS the misses and never removes them', () => {
        const h = mounted([prompt(1, 10, 'alpha'), prompt(2, 500, 'beta')]);
        h.rail.setFilter((text) => text.includes('alpha'));
        flushSync();
        const ticks = h.ticks();
        expect(ticks).toHaveLength(2);
        expect(nth(ticks, 0, 'tick').classList.contains('is-dim')).toBe(false);
        expect(nth(ticks, 1, 'tick').classList.contains('is-dim')).toBe(true);
    });

    test('clearing the filter lights everything back up', () => {
        const h = mounted([prompt(1, 10, 'alpha'), prompt(2, 500, 'beta')]);
        h.rail.setFilter((text) => text.includes('alpha'));
        flushSync();
        h.rail.setFilter(null);
        flushSync();
        expect(h.ticks().every((t) => !t.classList.contains('is-dim'))).toBe(true);
    });

    test('a filter that throws is treated as a match, not as a miss', () => {
        const h = mounted([prompt(1, 10, 'alpha')]);
        h.rail.setFilter(() => {
            throw new Error('half-typed');
        });
        flushSync();
        expect(nth(h.ticks(), 0, 'tick').classList.contains('is-dim')).toBe(false);
    });
});

describe('where you are', () => {
    test('the viewport row picks the current tick', () => {
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two'), prompt(3, 900, 'three')]);
        h.rail.setViewport(600);
        flushSync();
        const current = h.ticks().filter((t) => t.classList.contains('is-current'));
        expect(current).toHaveLength(1);
        expect(nth(current, 0, 'current tick').getAttribute('data-ordinal')).toBe('2');
    });
});

describe('jumping', () => {
    test('a jump calls scrollToLine with the ABSOLUTE line', () => {
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two')]);
        expect(h.rail.jumpTo(2)).toBe(true);
        expect(h.scrolled).toEqual([500]);
    });

    test('clicking a tick jumps to it', () => {
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two')]);
        nth(h.ticks(), 1, 'tick').click();
        expect(h.scrolled).toEqual([500]);
    });

    test('a marker xterm moved on a trim is followed, not the scanned row', () => {
        const h = mounted([prompt(1, 10, 'one')]);
        nth(h.markers, 0, 'marker').line = 4;
        h.rail.jumpTo(1);
        expect(h.scrolled).toEqual([4]);
    });

    test('NEGATIVE: a prompt whose marker was disposed refuses the jump', () => {
        const h = mounted([prompt(1, 10, 'one')]);
        nth(h.markers, 0, 'marker').dispose?.();
        expect(h.rail.jumpTo(1)).toBe(false);
        expect(h.scrolled).toEqual([]);
    });

    test('a click on the EMPTY STRIP beside a tick jumps to that tick', () => {
        // THE 24px STRIP IS THE TAP TARGET, WHICH IS WHAT THIS FILE
        // EXISTS TO HOLD. The tick is 12x3 and right-aligned, so a point
        // 15px left of the strip's right edge is at x=9 - inside the
        // strip, and nine pixels clear of the mark. Before the strip
        // carried a handler this click reached nothing at all.
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two'), prompt(3, 900, 'three')]);
        const second = nth(h.rail.tickViews, 1, 'tick view');
        h.clickStrip(STRIP_WIDTH - 15, second.y);
        expect(h.scrolled).toEqual([500]);
    });

    test('the strip picks the NEAREST tick, not the first or the last', () => {
        // Without this the test above would pass against a handler that
        // always jumped to tick one.
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two'), prompt(3, 900, 'three')]);
        const views = h.rail.tickViews;
        const third = nth(views, 2, 'tick view');
        const second = nth(views, 1, 'tick view');
        // Just above the last tick, and still nearer to it than to the
        // one before it.
        h.clickStrip(4, third.y - Math.floor((third.y - second.y) / 4));
        expect(h.scrolled).toEqual([900]);
    });

    test('a click on the TICK jumps exactly once, not twice', () => {
        // The tick is a button INSIDE the strip, so its click bubbles to
        // the strip's handler too. A handler that did not check the
        // event's target would jump twice, and on a cluster the second
        // jump could land somewhere the user never aimed at.
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two')]);
        nth(h.ticks(), 1, 'tick').click();
        expect(h.scrolled).toEqual([500]);
    });

    test('NEGATIVE: a strip with no ticks refuses the click rather than jumping', () => {
        const h = mounted([]);
        h.clickStrip(4, 120);
        expect(h.scrolled).toEqual([]);
    });

    test('the offset is measured from the STRIP, not read off clientY raw', () => {
        // THE LOAD-BEARING CONTROL. The harness mounts the strip at
        // STRIP_TOP rather than at the viewport origin precisely so this
        // can fail: a handler that passed `clientY` straight through
        // would resolve this click to STRIP_TOP px further down the
        // strip, which is past the midpoint between the first two ticks
        // and therefore lands on the SECOND one. Against a rect of zeros
        // both handlers agree and the test proves nothing.
        const h = mounted([prompt(1, 10, 'one'), prompt(2, 500, 'two'), prompt(3, 900, 'three')]);
        const views = h.rail.tickViews;
        const first = nth(views, 0, 'tick view');
        const second = nth(views, 1, 'tick view');
        // The premise the control rests on, asserted rather than assumed.
        expect(first.y + STRIP_TOP).toBeGreaterThan((first.y + second.y) / 2);
        h.clickStrip(4, first.y);
        expect(h.scrolled).toEqual([10]);
    });

    test('jump walks only the MATCHING prompts, and wraps', () => {
        const h = mounted([
            prompt(1, 10, 'alpha'),
            prompt(2, 300, 'beta'),
            prompt(3, 600, 'alpha again'),
        ]);
        h.rail.setFilter((text) => text.includes('alpha'));
        h.rail.setViewport(0);
        flushSync();
        h.rail.jump(1);
        h.rail.jump(1);
        expect(h.scrolled).toEqual([600, 10]);
    });
});

describe('when there is nothing to show', () => {
    test('an empty scan hides the strip', () => {
        const h = mounted([]);
        expect(h.el.hidden).toBe(true);
        expect(h.ticks()).toHaveLength(0);
    });

    test('the alternate screen hides it, prompts or not', () => {
        // A TUI has no scrollback and none of our prompts.
        const h = mounted([prompt(1, 10, 'one')]);
        expect(h.el.hidden).toBe(false);
        h.setBuffer({ type: 'alternate' });
        h.rail.refresh();
        flushSync();
        expect(h.el.hidden).toBe(true);
    });

    test('hide() puts it away and dispose() releases every marker', () => {
        const h = mounted([prompt(1, 10, 'one')]);
        h.rail.hide();
        flushSync();
        expect(h.el.hidden).toBe(true);
        h.rail.dispose();
        expect(h.markers.every((m) => m.isDisposed)).toBe(true);
    });
});
