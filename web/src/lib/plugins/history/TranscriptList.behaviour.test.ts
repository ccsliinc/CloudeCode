/**
 * THE TRANSCRIPT LIST, MOUNTED AND DRIVEN, AND THE BOUND PROVED IN A
 * REAL DOM.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE EXISTS BESIDE `tlist-window.test.ts`. That file proves
 * the ARITHMETIC: given a count and a viewport, the window is bounded.
 * This one proves the arithmetic is actually WIRED - that the component
 * renders the window rather than computing one and then painting
 * everything anyway. Those are two different claims and the first does
 * not imply the second. A component that called `computeWindow` and
 * ignored it would pass every assertion in the other file.
 *
 * jsdom REPORTS ZERO FOR EVERY LAYOUT MEASUREMENT, and that is exploited
 * here rather than worked around. `offsetHeight` and `clientHeight` are
 * 0 in jsdom no matter what is on screen, which is EXACTLY the
 * "nothing was measured" state `computeWindow` refuses on. So:
 *   - with the measurements stubbed, the list must BOUND its rows;
 *   - with them left at jsdom's zeros, the list must render EVERY row.
 * The second is the negative control for the whole windowing feature: a
 * list that narrowed on unmeasured input would hide rows on any pane
 * whose height it could not read, silently, and look exactly like a
 * server that returned fewer rows.
 *
 * ROWS ARE COUNTED, NEVER TIMED. The claim is a bound on DOM nodes, and
 * a wall clock on a loaded box would either flake or be too loose to
 * prove anything - the same reasoning `tests/test_listing_subprocess_cost.py`
 * gives for counting subprocesses instead of timing them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import TranscriptList from './TranscriptList.svelte';
import { DEFAULT_OVERSCAN, maxRendered } from './tlist-window';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** Height every stubbed row reports, px. Arbitrary but real and positive. */
const ROW_PX = 60;
/** Height the stubbed scrollport reports, px. */
const VIEWPORT_PX = 600;

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
    while (restores.length) restores.pop()?.();
    vi.restoreAllMocks();
});

/** A classifier standing in for the still-vanilla `archive-outcome.js`. */
const outcome: OutcomeClassifier = {
    classify(envelope: unknown) {
        const e = envelope as { result_status?: string; meta?: Record<string, unknown> } | null;
        return { token: e?.result_status || 'transport_failed', reasons: [], meta: e?.meta || null };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore(envelope: unknown) {
        const e = envelope as { has_more?: boolean | null } | null;
        return e && e.has_more !== undefined ? e.has_more : null;
    },
};

/** N transcript rows with sequential ids. */
function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        transcript_id: i + 1,
        session_ref: `session-ref-${i + 1}`,
        session_ref_scheme: 'uuid',
        title: i % 3 === 0 ? `a session named ${i + 1}` : null,
        title_source: i % 3 === 0 ? 'custom-title' : null,
        host_attribution: 'host-1',
        line_count: 100 + i,
        raw_byte_length: 4096 + i,
        ingested_at: '2026-08-31T12:00:00Z',
    }));
}

/** A client that answers one page of `n` rows and then says it is done. */
function clientWith(n: number, hasMore: boolean | null = false) {
    const envelope: EnvelopeResult = {
        envelope: {
            result: rows(n),
            result_status: 'ok',
            has_more: hasMore,
            meta: { paging: { next_cursor: hasMore ? 'c1' : null } },
        },
        httpStatus: 200,
        headers: null,
        transportError: null,
        refusedByGrant: false,
    };
    return {
        listArchiveTranscripts: () => Promise.resolve(envelope),
        listArchiveUnattributed: () => Promise.resolve(envelope),
    } as unknown as never;
}

/**
 * Make every element report a real layout, which jsdom otherwise refuses
 * to do. Registered for teardown so one test cannot leak into the next.
 */
function stubLayout(): void {
    const oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return this.tagName === 'LI' ? ROW_PX - 10 : VIEWPORT_PX;
        },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => VIEWPORT_PX,
    });
    restores.push(() => {
        if (oh) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', oh);
        if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch);
    });
}

/** Mount the list into a scrollport and wait for its first page. */
async function mountList(count: number, props: Record<string, unknown> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    const scrollport = document.createElement('div');
    host.appendChild(scrollport);
    const target = document.createElement('div');
    scrollport.appendChild(target);

    mounted = mount(TranscriptList, {
        target,
        props: {
            client: clientWith(count),
            outcome,
            scope: { kind: 'project', id: 12, inScope: count },
            scrollport,
            overscan: DEFAULT_OVERSCAN,
            ...props,
        },
    }) as Record<string, unknown>;

    // Two microtask drains: one for the fetch, one for the effects the
    // applied page schedules (measure, then re-window off the measurement).
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { scrollport, target };
}

/** Every transcript row actually in the DOM. Spacers carry no id. */
function paintedRows(): NodeListOf<Element> {
    return document.querySelectorAll('li[data-transcript-id]');
}

describe('TranscriptList: the virtualisation bound, in a real DOM', () => {
    it('paints the SAME number of rows for 200 and for 5,000', async () => {
        stubLayout();
        await mountList(200);
        const at200 = paintedRows().length;
        unmount(mounted!); mounted = null; host!.remove(); host = null;

        await mountList(5000);
        const at5000 = paintedRows().length;

        expect(at200).toBeGreaterThan(0);
        expect(at200).toBe(at5000);
        // The vanilla list would have painted 200 and then 5,000 here.
        expect(at5000).toBeLessThanOrEqual(
            maxRendered(VIEWPORT_PX, ROW_PX, DEFAULT_OVERSCAN),
        );
        expect(at5000).toBeLessThan(5000);
    });

    it('keeps every loaded row addressable even though most are not '
        + 'painted', async () => {
        stubLayout();
        await mountList(5000);
        const api = mounted as unknown as { rows(): readonly unknown[] };
        expect(api.rows()).toHaveLength(5000);
        expect(paintedRows().length).toBeLessThan(5000);
    });

    it('draws spacers that carry NO class, so no stylesheet can reach '
        + 'them', async () => {
        stubLayout();
        await mountList(5000);
        const ul = document.querySelector('ul.archive-tlist__rows');
        const spacers = Array.from(ul?.children || []).filter(
            (el) => !el.hasAttribute('data-transcript-id'),
        );
        expect(spacers.length).toBeGreaterThan(0);
        for (const s of spacers) {
            // Commitment 1 in one assertion: a spacer with a class would
            // be a NEW class name, and a class with no rule would render
            // in user-agent defaults where no test could see it.
            expect(s.getAttribute('class')).toBeNull();
            expect(s.getAttribute('aria-hidden')).toBe('true');
            expect(s.getAttribute('style') || '').toMatch(/height:\s*\d/);
        }
    });

    it('NEGATIVE CONTROL: with NOTHING measured it paints EVERY row, so a '
        + 'component that narrowed on unmeasured input fails here', async () => {
        // No stubLayout(). jsdom reports 0 for every height, which is the
        // refusal state. The list must degrade to the vanilla behaviour.
        await mountList(300);
        expect(paintedRows().length).toBe(300);
        const ul = document.querySelector('ul.archive-tlist__rows');
        const spacers = Array.from(ul?.children || []).filter(
            (el) => !el.hasAttribute('data-transcript-id'),
        );
        expect(spacers).toHaveLength(0);
    });

    it('NEGATIVE CONTROL: with NO scrollport it paints EVERY row rather '
        + 'than reaching for one', async () => {
        stubLayout();
        await mountList(300, { scrollport: null });
        // The measurements are stubbed and available, so a component that
        // went hunting for a scroll container with closest() or
        // document.querySelector would find one and BOUND here. Painting
        // everything is the proof it asked for its container instead.
        expect(paintedRows().length).toBe(300);
    });
});

describe('TranscriptList: what it refuses to render', () => {
    it('offers NO load-more control when has_more is null', async () => {
        stubLayout();
        host = document.createElement('div');
        document.body.appendChild(host);
        const scrollport = document.createElement('div');
        host.appendChild(scrollport);
        const target = document.createElement('div');
        scrollport.appendChild(target);
        mounted = mount(TranscriptList, {
            target,
            props: {
                client: clientWith(20, null),
                outcome,
                scope: { kind: 'project', id: 12, inScope: 20 },
                scrollport,
            },
        }) as Record<string, unknown>;
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(document.querySelector('[data-action="load-more"]')).toBeNull();
        const end = document.querySelector('.archive-tlist__end');
        expect(end?.textContent).toContain('NOT KNOWN');
        expect(end?.className).toContain('archive-tlist__end--unknown');
    });

    it('hides the scheme chooser on the unattributed scope rather than '
        + 'showing one that does nothing', async () => {
        stubLayout();
        await mountList(10, {
            scope: { kind: 'unattributed', id: 3, inScope: null },
        });
        expect(document.querySelector('.archive-tlist__scheme')).toBeNull();
        // The fuzzy inputs are client-side and DO apply here, so they stay.
        expect(document.querySelectorAll('.archive-tlist__fuzzy-input'))
            .toHaveLength(3);
    });

    it('marks the NO PROJECT badge only in the unattributed listing', async () => {
        stubLayout();
        await mountList(5, {
            scope: { kind: 'unattributed', id: 3, inScope: null },
        });
        expect(
            document.querySelectorAll('.archive-tlist__badge--no-project').length,
        ).toBeGreaterThan(0);
    });

    it('keys the open control on transcript_id and never on session_ref', async () => {
        stubLayout();
        const seen: unknown[] = [];
        await mountList(5, { onSelect: (id: unknown) => seen.push(id) });
        const btn = document.querySelector<HTMLButtonElement>(
            '[data-action="open-transcript"]',
        );
        btn?.click();
        expect(seen).toHaveLength(1);
        expect(typeof seen[0]).toBe('number');
    });
});

describe('TranscriptList: the three public commitments', () => {
    /** Every class name actually painted into the mounted list. */
    function emittedClasses(): Set<string> {
        const seen = new Set<string>();
        for (const el of document.querySelectorAll('.archive-tlist, .archive-tlist *')) {
            const cls = el.getAttribute('class');
            if (!cls) continue;
            for (const one of cls.split(/\s+/)) if (one) seen.add(one);
        }
        return seen;
    }

    it('COMMITMENT 1: emits only class names the vocabulary declares', async () => {
        stubLayout();
        await mountList(40);
        const vocab = await import('./tlist-vocab');
        const allowed = new Set<string>([
            ...Object.values(vocab.CLASS),
            // The title-source modifiers live in their own table because
            // they travel WITH the label and hint they belong to. They are
            // still vocabulary, and a modifier is the easiest kind of
            // class to invent by accident.
            ...Object.values(vocab.TITLE_SOURCES).map((d) => d.mod),
            vocab.TITLE_SOURCE_NONE.mod,
            vocab.TITLE_SOURCE_UNKNOWN.mod,
        ]);
        const seen = emittedClasses();
        expect(seen.size).toBeGreaterThan(5);
        // NAMES THE OFFENDER. A bare `expect(false).toBe(true)` says a
        // class escaped and leaves the reader grepping for which one.
        const undeclared = [...seen].filter((c) => !allowed.has(c));
        expect(undeclared).toEqual([]);
    });

    it('COMMITMENT 2: every class it emits already has a rule in the '
        + 'untouched archive stylesheets', async () => {
        // THE ANTIJOIN, carried across from
        // `tests/test_archive_tlist_styled.node.mjs`. That test exists
        // because the vanilla list once shipped a complete BEM tree that
        // matched ZERO rules in all 30 stylesheets, and rendered in
        // Chrome's user-agent defaults in every theme: a white bevelled
        // button at 13.33px Arial. Nothing errored and no test failed.
        // The Svelte port inherits that exposure exactly, so it inherits
        // the guard.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const cssDir = path.join(here, '..', '..', '..', '..', '..', 'client', 'css');
        const css = fs.readdirSync(cssDir)
            .filter((f) => f.startsWith('archive') && f.endsWith('.css'))
            .map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8'))
            .join('\n');
        expect(css.length).toBeGreaterThan(1000);

        stubLayout();
        await mountList(40);
        const unstyled = [...emittedClasses()].filter(
            (c) => !css.includes(`.${c}`),
        );
        // `__scheme-option` is KNOWN to have no rule and that is
        // pre-existing: the vanilla filter header emits it too, and an
        // <option> takes almost no styling anyway. Named here rather than
        // quietly filtered, so it stays a recorded fact instead of
        // becoming a hole the next class slips through.
        expect(unstyled).toEqual(['archive-tlist__scheme-option']);
    });
});
