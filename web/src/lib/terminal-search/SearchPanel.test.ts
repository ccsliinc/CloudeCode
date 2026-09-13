/**
 * THE PANEL, MOUNTED THROUGH THE REAL MOUNT PATH, WITH A REAL CAPTURE
 * PHASE.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE NEEDS A DOCUMENT. The claim it exists to prove is that a
 * character typed in the query field NEVER REACHES THE PANE, and that is
 * a claim about event propagation: the listener is on `document` in the
 * CAPTURE phase, so it sees the key before any descendant does and its
 * `stopPropagation()` stops the key ever arriving. A router tested
 * against a decision object cannot prove that; only a real DOM can.
 *
 * The vanilla panel carried a second, bubble-phase copy of its handler
 * purely because the node mini-DOM had no capture phase. jsdom has one,
 * so the copy is gone and this file is what makes that safe.
 *
 * Ported from the propagation half of
 * `tests/test_terminal_search_keys.node.mjs`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';

import { mountTerminalSearch, unmountTerminalSearch } from './mount-search';
import type { SearchController } from './search-controller.svelte';
import type { SearchHost } from './search-host';

/** What the harness records about the world outside the panel. */
interface Calls {
    pane: string[];
    focusTerm: number;
    find: string[];
}

interface Harness {
    controller: SearchController;
    calls: Calls;
    panel: () => HTMLElement;
    input: () => HTMLInputElement;
    headerBtn: () => HTMLButtonElement;
    key: (on: Element | Document, init: KeyboardEventInit & { key: string }) => KeyboardEvent;
}

/**
 * Build the terminal screen, mount the panel into it, and record what
 * reaches the pane.
 *
 * Inputs: none. Output: Harness.
 */
function setup(over?: Partial<SearchHost>): Harness {
    document.body.innerHTML = `
        <button type="button" id="terminalSearchBtn" class="btn-icon"></button>
        <div id="terminal-screen" class="screen active">
            <div class="terminal-container" id="terminal-container">
                <div id="terminal"></div>
            </div>
        </div>`;
    const container = document.getElementById('terminal-container') as HTMLElement;

    const calls: Calls = { pane: [], focusTerm: 0, find: [] };
    // STANDING IN FOR xterm's TEXTAREA. A key that reaches the container
    // is a key that would have reached the pane; the negative control
    // below proves this spy can actually see one.
    container.addEventListener('keydown', (e) => calls.pane.push((e as KeyboardEvent).key));

    const term = {
        buffer: { active: { type: 'normal', baseY: 0, cursorY: 0, viewportY: 0, length: 0 } },
    };
    const host: SearchHost = {
        term: () => term,
        sessionId: () => 'ses_a',
        currentSession: () => null,
        engine: () => ({
            attach: () => {},
            find: (q) => calls.find.push(q),
            next: () => {},
            prev: () => {},
            clear: () => {},
            onResults: () => () => {},
            predicate: () => () => true,
        }),
        history: () => null,
        deepDive: () => null,
        promptScan: () => ({ scan: () => [], layoutTicks: () => [], currentOrdinalFor: () => 0 }),
        isRule: () => undefined,
        modalOpen: () => false,
        terminalScreenActive: () => true,
        focusTerm: () => {
            calls.focusTerm += 1;
        },
    };
    const controller = mountTerminalSearch({ ...host, ...(over ?? {}) });
    if (!controller) throw new Error('the panel did not mount');
    flushSync();

    return {
        controller,
        calls,
        panel: () => document.querySelector('.terminal-search-panel') as HTMLElement,
        input: () => document.querySelector('.terminal-search__input') as HTMLInputElement,
        headerBtn: () => document.getElementById('terminalSearchBtn') as HTMLButtonElement,
        key: (on, init) => {
            const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
            on.dispatchEvent(e);
            return e;
        },
    };
}

let h: Harness | null = null;

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    unmountTerminalSearch();
    h = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('mounting', () => {
    test('the panel and the rail host are inside the terminal container', () => {
        h = setup();
        const container = document.getElementById('terminal-container') as HTMLElement;
        expect(h.panel().parentElement).toBe(container);
        expect(container.querySelector('.terminal-prompt-rail-host')).not.toBeNull();
        // #terminal is still there: mountPanel never clears its container.
        expect(container.querySelector('#terminal')).not.toBeNull();
    });

    test('it paints closed, and Cmd+F opens it', () => {
        h = setup();
        expect(h.panel().classList.contains('is-open')).toBe(false);
        const e = h.key(document, { key: 'f', metaKey: true });
        flushSync();
        expect(h.controller.isOpen()).toBe(true);
        expect(h.panel().classList.contains('is-open')).toBe(true);
        expect(e.defaultPrevented).toBe(true);
    });

    test('the header button toggles it, wired in JS and never in markup', () => {
        h = setup();
        h.headerBtn().click();
        expect(h.controller.isOpen()).toBe(true);
        h.headerBtn().click();
        expect(h.controller.isOpen()).toBe(false);
        expect(h.headerBtn().getAttribute('onclick')).toBeNull();
    });

    test('the panel takes its top from the stylesheet, never an inline one', () => {
        h = setup();
        h.controller.open();
        flushSync();
        expect(h.panel().style.top).toBe('');
    });
});

/* ---------------------------------------------------------------------
 * Autofocus
 *
 * THE DEFECT THIS PINS IS NOT "focus was never called". It always was,
 * on the line it is on now. `opened` is a rune, so Svelte applied
 * `.is-open` on a MICROTASK - and until it did the panel was still
 * `display: none`, where `HTMLElement.focus()` is a specified no-op that
 * throws nothing and logs nothing. The caret stayed in the pane.
 *
 * jsdom performs no layout, so it will happily focus a hidden input and
 * CANNOT reproduce that by itself. So these tests assert the MECHANISM
 * instead: what the DOM said at the instant focus was called. Move the
 * `flushSync()` out of `open()` and the first one goes red.
 * ------------------------------------------------------------------- */
describe('autofocus', () => {
    test('the field is focused by the time open() returns, with no flush from the caller', () => {
        h = setup();
        h.controller.open();
        expect(document.activeElement).toBe(h.input());
    });

    test('the panel is already painted open at the moment focus is called', () => {
        h = setup();
        const seen: boolean[] = [];
        const input = h.input();
        const real = input.focus.bind(input);
        vi.spyOn(input, 'focus').mockImplementation((opts) => {
            seen.push(input.closest('.terminal-search-panel')!.classList.contains('is-open'));
            real(opts);
        });
        h.controller.open();
        // One focus, and the panel was VISIBLE for it. `[false]` is what
        // the pre-fix code produced, and a hidden field cannot take focus
        // in a real browser.
        expect(seen).toEqual([true]);
    });

    test('focus lands before the history load resolves, not after', () => {
        // A load that never settles: if focus were chained onto it, the
        // field would never get the caret at all.
        h = setup({ history: () => ({ ensureLoaded: () => new Promise(() => {}) }) });
        h.controller.open();
        expect(document.activeElement).toBe(h.input());
        expect(h.controller.history).toBe('pending');
    });

    test('re-opening refocuses and SELECTS the existing text', () => {
        h = setup();
        h.controller.open();
        const input = h.input();
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        flushSync();
        (document.getElementById('terminal') as HTMLElement).focus();

        h.key(document, { key: 'f', metaKey: true });
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('needle'.length);
    });
});

/* ---------------------------------------------------------------------
 * The toast stack's offset
 *
 * The VALUE is a measurement and jsdom has no layout, so what is proven
 * here is the CONTRACT: the variable exists while the panel is open and
 * is gone the moment it closes. The rule that reads it is itself gated
 * on `body:has(...is-open)`, so a leaked value could not move the stack
 * anyway - that gate and this clear are two independent guards on the
 * same failure, which is toasts stranded halfway down the screen.
 * ------------------------------------------------------------------- */
describe('the toast offset', () => {
    /** The published offset, or null when none is set. */
    const offset = (): string | null =>
        document.documentElement.style.getPropertyValue('--terminal-search-toast-top') || null;

    test('it is published while open and removed on close', () => {
        h = setup();
        expect(offset()).toBeNull();
        h.controller.open();
        flushSync();
        expect(offset()).toMatch(/^-?\d+px$/);
        h.controller.close();
        flushSync();
        expect(offset()).toBeNull();
    });
});

describe('the shield', () => {
    test('typing in the field never reaches the pane', () => {
        h = setup();
        h.controller.open();
        flushSync();
        for (const key of ['r', 'm', ' ', '-', 'f', 'Backspace', 'Home', 'x']) {
            h.key(h.input(), { key });
        }
        expect(h.calls.pane).toEqual([]);
    });

    test('Enter, Shift+Enter, the arrows and Escape never reach it either', () => {
        h = setup();
        h.controller.open();
        flushSync();
        h.key(h.input(), { key: 'Enter' });
        h.key(h.input(), { key: 'Enter', shiftKey: true });
        h.key(h.input(), { key: 'ArrowUp' });
        h.key(h.input(), { key: 'ArrowDown' });
        h.key(h.input(), { key: 'Escape' });
        expect(h.calls.pane).toEqual([]);
    });

    test('NEGATIVE CONTROL: the pane spy DOES see a key typed at the pane', () => {
        // Without this, "the pane saw nothing" could equally mean the spy
        // is wired to something no event can ever reach.
        h = setup();
        h.controller.open();
        flushSync();
        h.key(document.getElementById('terminal') as Element, { key: 'q' });
        expect(h.calls.pane).toEqual(['q']);
    });

    test('a shielded character is not prevented, so the field still receives it', () => {
        h = setup();
        h.controller.open();
        flushSync();
        const e = h.key(h.input(), { key: 'r' });
        expect(e.defaultPrevented).toBe(false);
    });
});

describe('closing', () => {
    test('Escape in the field closes the panel and gives the pane its focus back', () => {
        h = setup();
        h.controller.open();
        flushSync();
        h.key(h.input(), { key: 'Escape' });
        flushSync();
        expect(h.controller.isOpen()).toBe(false);
        expect(h.calls.focusTerm).toBe(1);
        expect(h.panel().classList.contains('is-open')).toBe(false);
    });

    test('NEGATIVE: Escape typed AT THE PANE does not close the panel', () => {
        // Escape at a claude prompt is claude's.
        h = setup();
        h.controller.open();
        flushSync();
        h.key(document.getElementById('terminal') as Element, { key: 'Escape' });
        expect(h.controller.isOpen()).toBe(true);
        expect(h.calls.focusTerm).toBe(0);
    });

    test('the close control closes it', () => {
        h = setup();
        h.controller.open();
        flushSync();
        (h.panel().querySelector('[aria-label="close search (esc)"]') as HTMLButtonElement).click();
        flushSync();
        expect(h.controller.isOpen()).toBe(false);
    });

    test('a destroyed session closes it', () => {
        h = setup();
        h.controller.open();
        window.dispatchEvent(new Event('session-destroyed'));
        expect(h.controller.isOpen()).toBe(false);
    });
});

describe('what the row shows', () => {
    test('the field is labelled for a screen reader and takes no autocorrect', () => {
        h = setup();
        const input = h.input();
        expect(input.getAttribute('aria-label')).toBe('search this session');
        expect(input.getAttribute('autocapitalize')).toBe('off');
        expect(input.getAttribute('spellcheck')).toBe('false');
    });

    test('the counter is a polite live region', () => {
        h = setup();
        expect(
            (document.querySelector('.terminal-search__count') as HTMLElement).getAttribute(
                'aria-live',
            ),
        ).toBe('polite');
    });

    test('deep dive is disabled with a reason when the archive is unavailable', () => {
        h = setup();
        h.controller.open();
        flushSync();
        const deep = document.querySelector('.terminal-search__deep') as HTMLButtonElement;
        expect(deep.disabled).toBe(true);
        expect(deep.getAttribute('title')).toBe('the conversation archive is not available');
    });

    test('the mount is reversible: unmount takes the panel and the chord away', () => {
        h = setup();
        const controller = h.controller;
        unmountTerminalSearch();
        expect(document.querySelector('.terminal-search-panel')).toBeNull();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
        expect(controller.isOpen()).toBe(false);
    });
});
