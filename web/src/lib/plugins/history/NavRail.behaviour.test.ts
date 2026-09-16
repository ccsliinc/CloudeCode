/**
 * THE NAV RAIL, MOUNTED AND DRIVEN, IN A REAL DOM.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE EXISTS BESIDE THE PARITY TESTS. Those prove the RULES:
 * given nodes and a mode, the order is the vanilla order. This one
 * proves the rules are actually WIRED - that the component renders what
 * it computed rather than computing an answer and then painting
 * something else. Those are two different claims and the first does not
 * imply the second. A component that called `paintMerged` and ignored it
 * would pass every assertion in `nav-merged.test.ts`.
 *
 * THE NEGATIVE CONTROL IS MANDATORY AND IT IS LOAD-BEARING. A tree that
 * renders something no matter what it is given passes every positive
 * test and is useless: an empty archive, a refused request and a filter
 * that matched nothing would all paint identically, which is this
 * project's false-green shape with a text box on it. So the last
 * describe block drives the rail with a refusal, with an empty listing
 * and with a filter nothing matches, and asserts a DIFFERENT, STATED
 * rendering for each. It was watched failing before anything here was
 * trusted.
 *
 * ROWS ARE COUNTED, NEVER TIMED. The claims are about DOM nodes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import NavRail from './NavRail.svelte';
import { CLASS, INFO_CLASS, NODE_KINDS, UNSTYLED_PRE_EXISTING } from './nav-vocab';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';
import real from './nav-real-nodes.fixture.json' with { type: 'json' };

const NODES = real as unknown as Record<string, unknown>[];

/**
 * The rail's exported API, as this suite drives it. Declared rather than
 * indexed off a `Record<string, Function>`, so a renamed export is a
 * compile error here instead of a runtime `undefined is not a function`.
 */
interface RailApi {
    loadMergedProjects(): Promise<string>;
    loadHosts(): Promise<string>;
    expand(kind: string, id: number | string | null): Promise<string>;
    setView(next: string): Promise<string>;
    ensureViewLoaded(): Promise<string>;
    setOrder(mode: string): boolean;
    setHostFilter(hostId: number | string | null | undefined): void;
    setFilter(text: string): void;
    clearFilter(): void;
    currentFilter(): string;
    currentView(): string;
    currentOrder(): string;
    lastPaint(): { rendered: number; total: number; hiddenUnattributed: number };
    mergedNodes(): readonly Record<string, unknown>[];
    rowsLoaded(key: string): readonly Record<string, unknown>[];
}

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** A classifier standing in for the still-vanilla `archive-outcome.js`. */
const outcome: OutcomeClassifier = {
    classify(envelope: unknown) {
        const e = envelope as { result_status?: string; meta?: Record<string, unknown> } | null;
        return { token: e?.result_status || 'transport_failed', reasons: [], meta: e?.meta || null };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore: () => null,
};

/** One envelope result, shaped as the granted client returns it. */
function envelope(body: unknown, transportError: string | null = null): EnvelopeResult {
    return {
        envelope: body, httpStatus: transportError ? 0 : 200, headers: null,
        transportError, refusedByGrant: false,
    } as EnvelopeResult;
}

/** A merged-projects envelope carrying `nodes`. */
function mergedEnvelope(
    nodes: unknown[],
    unattributed: unknown[] = [],
    status = 'ok',
): EnvelopeResult {
    return envelope({
        result: nodes,
        result_status: status,
        meta: { unattributed: { by_corpus: unattributed }, hosts: [] },
    });
}

/** A client answering fixed envelopes, and recording what was asked. */
function clientWith(answers: Partial<Record<string, EnvelopeResult>>) {
    const asked: string[] = [];
    const client = {
        listArchiveMergedProjects: () => {
            asked.push('merged');
            return Promise.resolve(answers.merged || mergedEnvelope([]));
        },
        listArchiveHosts: () => {
            asked.push('hosts');
            return Promise.resolve(answers.hosts || envelope({ result: [], result_status: 'ok', meta: {} }));
        },
        listArchiveCorpora: (id: unknown) => {
            asked.push(`corpora:${String(id)}`);
            return Promise.resolve(answers.corpora || envelope({ result: [], result_status: 'ok', meta: {} }));
        },
        listArchiveProjects: (id: unknown) => {
            asked.push(`projects:${String(id)}`);
            return Promise.resolve(answers.projects || envelope({ result: [], result_status: 'ok', meta: {} }));
        },
    };
    return { client: client as unknown as never, asked };
}

/** Mount the rail and return its exported API. */
function mountRail(client: unknown, props: Record<string, unknown> = {}): RailApi {
    host = document.createElement('div');
    document.body.appendChild(host);
    mounted = mount(NavRail, {
        target: host,
        props: { client, outcome, onSelect: () => {}, ...props } as never,
    }) as Record<string, unknown>;
    return mounted as unknown as RailApi;
}

/** Every rendered project card, in document order. */
function cards(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-node-kind="project"]')];
}

describe('NavRail: the merged view, wired', () => {
    it('renders one card per real project, in the order the rule chose', async () => {
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(cards()).toHaveLength(98);
        // The first card must be the one `sortNodes('recent')` put first,
        // not merely "a card". A component that painted the unsorted
        // input would render 98 cards too.
        const first = cards()[0]?.getAttribute('data-node-id');
        const newest = [...NODES].sort((a, b) =>
            String(b.newest_activity_at).localeCompare(String(a.newest_activity_at)))[0];
        expect(first).toBe(String(newest?.project_id));
    });

    it('re-orders the DOM when the order changes, rather than only the model',
        async () => {
            const { client } = clientWith({ merged: mergedEnvelope(NODES) });
            const api = mountRail(client);
            await api.loadMergedProjects();
            flushSync();
            const before = cards().map((c) => c.getAttribute('data-node-id'));
            api.setOrder('oldest');
            flushSync();
            const after = cards().map((c) => c.getAttribute('data-node-id'));
            expect(after).not.toEqual(before);
            expect(after.slice().reverse()).toEqual(before);
        });

    it('narrows the DOM when the fuzzy filter is typed, and says what it '
        + 'did NOT look at', async () => {
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        api.setFilter('cloudecode');
        flushSync();
        expect(cards()).toHaveLength(19);
        const note = document.querySelector(`.${CLASS.filterNote}`)?.textContent || '';
        expect(note).toContain('filter matches 19 of 98 loaded projects');
        expect(note).toContain('not the whole corpus');
    });

    it('the filter note is EMPTY when nothing is filtered, so the sentence '
        + 'appears only when it has something to disclaim', async () => {
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(document.querySelector(`.${CLASS.filterNote}`)?.textContent?.trim())
            .toBe('');
    });

    it('marks the matched characters in the label rather than re-casing '
        + 'or rebuilding it', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([{
                project_id: 1, display_name: 'CloudeCode', full_path: '-CloudeCode',
                activity_status: 'known', newest_activity_at: '2026-01-01T00:00:00Z',
                transcript_count: 3, session_count: 1, session_counted: true,
            }]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        api.setFilter('cldcode');
        flushSync();
        const marks = [...document.querySelectorAll(`mark.${CLASS.hit}`)];
        expect(marks.length).toBeGreaterThan(0);
        // The label still reads the ORIGINAL string, cases intact.
        expect(document.querySelector(`.${CLASS.label}`)?.textContent?.replace(/\s+/g, ''))
            .toBe('CloudeCode');
    });

    it('renders NOT KNOWN for a session count the server did not report, '
        + 'never the transcript total in its place', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([{
                project_id: 1, display_name: 'p', full_path: '-p',
                transcript_count: 718, activity_status: 'none',
            }]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        const sessions = document.querySelector(`.${CLASS.countSessions}`);
        expect(sessions?.getAttribute('data-session-state')).toBe('not-reported');
        expect(sessions?.textContent).toContain('NOT KNOWN');
        expect(sessions?.textContent).not.toContain('718');
        expect(document.querySelector(`.${CLASS.countTotal}`)?.textContent).toContain('718');
    });

    it('marks a parked card so it cannot be read as the oldest project', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([
                { project_id: 1, display_name: 'dated', full_path: '-a',
                    activity_status: 'known', newest_activity_at: '2026-01-01T00:00:00Z' },
                { project_id: 2, display_name: 'undated', full_path: '-b',
                    activity_status: 'unknown' },
            ]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        const last = cards()[1];
        expect(last?.getAttribute('data-unsorted')).toBe('date not established');
        expect(last?.querySelector(`.${CLASS.unsorted}`)?.textContent)
            .toContain('not in this order');
    });

    it('hands a chosen project to onSelect, by id and never by slug', async () => {
        const seen: unknown[] = [];
        const { client } = clientWith({
            merged: mergedEnvelope([{ project_id: 42, display_name: 'p', full_path: '-p' }]),
        });
        const api = mountRail(client, { onSelect: (k: string, id: unknown) => seen.push([k, id]) });
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="select"]')?.click();
        expect(seen).toEqual([[NODE_KINDS.PROJECT, 42]]);
    });
});

describe('NavRail: the unattributed scope, which nothing else can show', () => {
    it('renders a node for a corpus with a measured non-zero count and '
        + 'hides only the measured zero', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([], [
                { corpus_id: 1, transcript_count: 0 },
                { corpus_id: 2, transcript_count: 5 },
                { corpus_id: 3, transcript_count: null },
            ]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        const nodes = [...document.querySelectorAll('[data-node-kind="unattributed"]')];
        expect(nodes).toHaveLength(2);
        expect(nodes.map((n) => n.getAttribute('data-node-id'))).toEqual(['2', '3']);
        expect(nodes[0]?.getAttribute('data-unattributed-reason')).toBe('holds 5');
        expect(nodes[1]?.getAttribute('data-unattributed-reason'))
            .toBe('no count was reported');
    });

    it('an unmeasured count renders NOT KNOWN and an OPEN note, while a '
        + 'measured one renders an ANSWERED note', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([], [
                { corpus_id: 2, transcript_count: 5 },
                { corpus_id: 3, transcript_count: null },
            ]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        const notes = [...document.querySelectorAll(`.${CLASS.note}`)];
        expect(notes[0]?.className).toContain(CLASS.noteAnswered);
        expect(notes[1]?.className).not.toContain(CLASS.noteAnswered);
        const counts = [...document.querySelectorAll('[data-node-kind="unattributed"]')]
            .map((n) => n.querySelector(`.${CLASS.count}`)?.textContent);
        expect(counts).toEqual(['5', 'NOT KNOWN']);
    });

    it('is NOT fuzzily filtered away, because it is a scope and not a '
        + 'project', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope(NODES, [{ corpus_id: 2, transcript_count: 5 }]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(document.querySelectorAll('[data-node-kind="unattributed"]')).toHaveLength(1);
        api.setFilter('cloudecode');
        flushSync();
        // Dropped entirely rather than ranked against a name it does not
        // have, which is exactly what the vanilla list did.
        expect(document.querySelectorAll('[data-node-kind="unattributed"]')).toHaveLength(0);
    });
});

describe('NavRail: the order control remembers, and never throws doing it', () => {
    it('reads the stored choice once and writes the new one', async () => {
        const store = {
            getItem: () => 'size',
            setItem: (_k: string, v: string) => { written.push(v); },
        };
        const written: string[] = [];
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client, { store });
        expect(api.currentOrder()).toBe('size');
        api.setOrder('name');
        expect(written).toEqual(['name']);
    });

    it('A STORAGE THAT THROWS ON ACCESS IS A WORKING RAIL. An unwrapped read '
        + 'is not a missing preference, it is a rail that does not render',
    async () => {
        const store = {
            getItem: () => { throw new Error('site data blocked'); },
            setItem: () => { throw new Error('site data blocked'); },
        };
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client, { store });
        expect(api.currentOrder()).toBe('recent');
        expect(api.setOrder('name')).toBe(true);
        await api.loadMergedProjects();
        flushSync();
        expect(cards()).toHaveLength(98);
    });

    it('a stored value from a future build falls back rather than becoming '
        + 'a comparator nobody wrote', () => {
        const store = { getItem: () => 'by-vibes', setItem: () => {} };
        const { client } = clientWith({});
        const api = mountRail(client, { store });
        expect(api.currentOrder()).toBe('recent');
        expect(api.setOrder('by-vibes')).toBe(false);
    });
});

describe('NEGATIVE CONTROL: the rail refuses to paint a tree it was not given', () => {
    it('a REFUSED merged listing renders the refusal and NOT a single card',
        async () => {
            // A tree that renders something no matter what it is given
            // passes every positive test above and is useless.
            const { client } = clientWith({
                merged: envelope({ result_status: 'cannot_determine', meta: {} }),
            });
            const api = mountRail(client, {
                renderOutcome: () => {
                    const el = document.createElement('p');
                    el.textContent = 'could not evaluate';
                    return el;
                },
            });
            const token = await api.loadMergedProjects();
            flushSync();
            expect(token).toBe('cannot_determine');
            expect(cards()).toHaveLength(0);
            expect(document.querySelector(`.${CLASS.outcome}`)?.textContent)
                .toContain('could not evaluate');
        });

    it('a TRANSPORT failure renders the reason and NOT a single card', async () => {
        const { client } = clientWith({ merged: envelope(null, 'connection refused') });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(cards()).toHaveLength(0);
        expect(document.querySelector(`.${CLASS.transportReason}`)?.textContent)
            .toBe('connection refused');
    });

    it('an EMPTY listing says so rather than rendering a blank pane', async () => {
        const { client } = clientWith({ merged: mergedEnvelope([]) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(cards()).toHaveLength(0);
        expect(document.querySelector(`.${CLASS.filterEmpty}`)?.textContent?.trim())
            .toBe('No projects in this view.');
    });

    it('a FILTER that matched nothing says THAT, in different words from '
        + 'an empty listing', async () => {
        const { client } = clientWith({ merged: mergedEnvelope(NODES) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        api.setFilter('qqzzxx');
        flushSync();
        expect(cards()).toHaveLength(0);
        const text = document.querySelector(`.${CLASS.filterEmpty}`)?.textContent || '';
        expect(text).toContain('No loaded projects match this filter');
        expect(text).toContain('not the whole corpus');
        expect(text).not.toContain('No projects in this view');
    });

    it('the rail before any request renders NO cards, so "not asked yet" '
        + 'cannot look like "there are none"', () => {
        const { client, asked } = clientWith({ merged: mergedEnvelope(NODES) });
        mountRail(client);
        flushSync();
        expect(asked).toEqual([]);
        expect(cards()).toHaveLength(0);
    });
});
