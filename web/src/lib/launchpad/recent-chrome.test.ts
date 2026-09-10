/**
 * The three heading elements the RECENT section owns from outside its
 * mount, and the collapse it must not break.
 *
 * PORTED FROM the repaint case of tests/test_recent_section_collapse.node.mjs,
 * which was the one case in that file about this slice. The other four
 * are about `Launchpad.initSectionDisclosures()` and the heading's own
 * markup, both of which are still legacy and still tested there.
 *
 * THE INVARIANT, RESTATED FOR THE PORT. The legacy assertion was that
 * `renderRecentSessions()` rewrote `#recent-sessions-list`'s innerHTML
 * and never its `style.display`, so a section the user had collapsed
 * stayed collapsed across a poll tick. Svelte owns that container's
 * CHILDREN now and never its style, so the equivalent claim is stronger
 * and simpler: the section's chrome NEVER TOUCHES the list container at
 * all. That is asserted by recording every element this module asks for.
 *
 * A REAL DOM IS NOT NEEDED AND IS NOT PULLED IN. `vitest.config.ts` runs
 * in node on purpose; this installs a recording `document` for the
 * duration of a test, which is the same shape the node harnesses used and
 * costs no dependency.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { browserChrome } from './recent-chrome';

/** One recorded element, with only what this module writes. */
interface StubEl {
    id: string;
    textContent: string;
    style: { display: string };
    dataset: Record<string, string>;
    attrs: Record<string, string>;
    classes: Set<string>;
    listeners: Array<() => void>;
    setAttribute(name: string, value: string): void;
    classList: { toggle(name: string, on: boolean): void };
    addEventListener(type: string, fn: () => void): void;
}

/** Which ids were asked for, in order. The collapse guard reads this. */
let requested: string[] = [];
/** The stub elements, by id. */
let byId: Record<string, StubEl> = {};
/** Whatever `document` was before a test installed the stub. */
let savedDocument: unknown;

/**
 * Build one recording element.
 *
 * Inputs: id - the element's id. Output: the stub.
 * Example: el('recent-sessions-count').textContent  // ''
 */
function el(id: string): StubEl {
    const stub: StubEl = {
        id,
        textContent: '',
        style: { display: '' },
        dataset: {},
        attrs: {},
        classes: new Set<string>(),
        listeners: [],
        setAttribute(name, value) { this.attrs[name] = String(value); },
        classList: {
            toggle(name: string, on: boolean) {
                if (on) stub.classes.add(name);
                else stub.classes.delete(name);
            },
        },
        addEventListener(_type, fn) { this.listeners.push(fn); },
    };
    return stub;
}

/**
 * One stub element by id, asserted to be in the fixture.
 *
 * Description: `noUncheckedIndexedAccess` makes a record read
 *   `T | undefined`. Asserting here means a typo in an id fails as a
 *   named missing element rather than as an undefined property read four
 *   lines later.
 * Inputs: id - the element id. Output: the stub.
 * Example: fixture('recent-sessions-count').textContent
 */
function fixture(id: string): StubEl {
    const found = byId[id];
    expect(found, `no stub element for ${id}`).toBeDefined();
    return found as StubEl;
}

beforeEach(() => {
    requested = [];
    byId = {
        'recent-sessions-count': el('recent-sessions-count'),
        'recent-sessions-section': el('recent-sessions-section'),
        'recent-show-deleted-toggle': el('recent-show-deleted-toggle'),
        'recent-sessions-list': el('recent-sessions-list'),
    };
    savedDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
        getElementById(id: string) {
            requested.push(id);
            return byId[id] || null;
        },
    };
});

afterEach(() => {
    (globalThis as { document?: unknown }).document = savedDocument;
});

describe('the collapse the user set survives every repaint', () => {
    test('NOTHING here ever reaches the list container', () => {
        // `#recent-sessions-list` is what `initSectionDisclosures()`
        // shows and hides. If this module wrote its `style.display`, a
        // repaint would silently re-expand a section the user collapsed -
        // which is exactly what the legacy test guarded against.
        const chrome = browserChrome();
        chrome.setCount('2 recent', 'ok');
        chrome.setSectionVisible(true);
        chrome.setArchiveToggle(true, 'hide archived sessions');
        chrome.bindArchiveToggle(() => {});
        expect(requested).not.toContain('recent-sessions-list');
        expect(fixture('recent-sessions-list').style.display).toBe('');
    });

    test('repeated repaints leave the list container untouched', () => {
        const chrome = browserChrome();
        for (let i = 0; i < 12; i++) chrome.setSectionVisible(i % 2 === 0);
        expect(requested).not.toContain('recent-sessions-list');
    });
});

describe('the section shows and hides the way the legacy renderer did', () => {
    test('visible clears display, hidden sets none', () => {
        // The exact values the legacy renderer wrote. A class or the
        // `hidden` attribute would lose the cascade to the section's own
        // stylesheet rule and no-op the hide.
        const chrome = browserChrome();
        chrome.setSectionVisible(false);
        expect(fixture('recent-sessions-section').style.display).toBe('none');
        chrome.setSectionVisible(true);
        expect(fixture('recent-sessions-section').style.display).toBe('');
    });

    test('the count carries the state it is reporting, not just a number', () => {
        // `data-state` is what lets a stylesheet tell "2 recent" from
        // "cannot determine" without parsing the text.
        const chrome = browserChrome();
        chrome.setCount('cannot determine', 'probe_unavailable');
        expect(fixture('recent-sessions-count').textContent).toBe('cannot determine');
        expect(fixture('recent-sessions-count').attrs['data-state']).toBe('probe_unavailable');
    });

    test('a missing element is a no-op, never a throw', () => {
        // A panel whose container has not been written yet is a normal
        // early-boot state, not a fault.
        byId = {};
        const chrome = browserChrome();
        expect(() => {
            chrome.setCount('x', 'ok');
            chrome.setSectionVisible(true);
            chrome.setArchiveToggle(true, 'x');
            chrome.bindArchiveToggle(() => {});
        }).not.toThrow();
    });
});

describe('the archive filter is one listener with the latest handler', () => {
    test('the pressed state, the class and the title all move together', () => {
        const chrome = browserChrome();
        const toggle = fixture('recent-show-deleted-toggle');
        chrome.setArchiveToggle(true, 'hide archived sessions');
        expect(toggle.attrs['aria-pressed']).toBe('true');
        expect(toggle.classes.has('is-on')).toBe(true);
        expect(toggle.attrs.title).toBe('hide archived sessions');
        chrome.setArchiveToggle(false, 'show archived sessions');
        expect(toggle.attrs['aria-pressed']).toBe('false');
        expect(toggle.classes.has('is-on')).toBe(false);
    });

    test('remounting does NOT stack listeners', () => {
        // The component is remounted on every launchpad render. A
        // listener per mount would fire the re-fetch N times for one
        // click, which is the defect the legacy bound-flag prevented.
        const toggle = fixture('recent-show-deleted-toggle');
        for (let i = 0; i < 5; i++) browserChrome().bindArchiveToggle(() => {});
        expect(toggle.listeners).toHaveLength(1);
    });

    test('and the LATEST handler is the one that runs, not the first', () => {
        // The quieter half of the same problem: a bare register-once
        // strands the first mount's closure and every later mount's
        // handler is discarded, so the control keeps calling into a
        // component that is gone.
        const fired: string[] = [];
        browserChrome().bindArchiveToggle(() => fired.push('first'));
        browserChrome().bindArchiveToggle(() => fired.push('second'));
        browserChrome().bindArchiveToggle(() => fired.push('third'));
        fixture('recent-show-deleted-toggle').listeners.forEach((fn) => fn());
        expect(fired).toEqual(['third']);
    });
});
