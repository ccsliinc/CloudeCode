/**
 * THE BY-MACHINE DRILL-DOWN AND THE DETAILS MODAL, MOUNTED AND DRIVEN.
 *
 * @vitest-environment jsdom
 *
 * SEPARATE FROM `NavRail.behaviour.test.ts` because that file reached
 * this repo's 500-line cap and these two surfaces are the honest thing
 * to take out: neither is the merged view, which is the only one a click
 * can reach today, and both are driven through the rail's exported API
 * rather than through the default screen.
 *
 * THE DRILL-DOWN IS UNEXPOSED, NOT DELETED. The view bar that reached it
 * was removed at the owner's instruction; `setView` and the deep links
 * still work, so the code stays reachable and tested. That is the whole
 * reason this file exists rather than the tree being dropped in the port.
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

describe('NavRail: the by-machine drill-down, which is unexposed and not deleted',
    () => {
        it('loads only the ACTIVE view, so the rail cannot open empty with no '
            + 'request made', async () => {
            const { client, asked } = clientWith({ merged: mergedEnvelope(NODES) });
            const api = mountRail(client);
            await api.ensureViewLoaded();
            expect(asked).toEqual(['merged']);
            expect(api.currentView()).toBe('merged');
        });

        it('expands a host into its corpora and a corpus into its projects',
            async () => {
                const { client, asked } = clientWith({
                    hosts: envelope({
                        result: [{ host_id: 1, display_name: 'mini', transcript_count: 9 }],
                        result_status: 'ok', meta: {},
                    }),
                    corpora: envelope({
                        result: [{ corpus_id: 7, corpus_key: 'k',
                            unattributed_transcript_count: 5, transcript_count: 9 }],
                        result_status: 'ok', meta: {},
                    }),
                    projects: envelope({
                        result: [{ project_id: 3, slug: '-s', transcript_count: 2 }],
                        result_status: 'ok', meta: {},
                    }),
                });
                const api = mountRail(client);
                await api.setView('hosts');
                flushSync();
                expect(document.querySelectorAll('[data-node-kind="host"]')).toHaveLength(1);
                await api.expand(NODE_KINDS.HOST, 1);
                flushSync();
                expect(document.querySelectorAll('[data-node-kind="corpus"]')).toHaveLength(1);
                await api.expand(NODE_KINDS.CORPUS, 7);
                flushSync();
                expect(cards()).toHaveLength(1);
                // APPENDED TO EVERY EXPANDED CORPUS, which is the drill
                // path's own rule and not the merged view's.
                expect(document.querySelectorAll('[data-node-kind="unattributed"]'))
                    .toHaveLength(1);
                expect(asked).toEqual(['hosts', 'corpora:1', 'projects:7']);
            });

        it('a reopened level is not refetched', async () => {
            const { client, asked } = clientWith({
                hosts: envelope({
                    result: [{ host_id: 1, display_name: 'mini' }],
                    result_status: 'ok', meta: {},
                }),
            });
            const api = mountRail(client);
            await api.setView('hosts');
            await api.expand(NODE_KINDS.HOST, 1);
            await api.expand(NODE_KINDS.HOST, 1);
            await api.expand(NODE_KINDS.HOST, 1);
            expect(asked.filter((a) => a === 'corpora:1')).toHaveLength(1);
        });

        it('A FAILED BRANCH NEVER COLLAPSES INTO A LEAF: the refusal renders '
            + 'at that node and its siblings stay usable', async () => {
            const { client } = clientWith({
                hosts: envelope({
                    result: [
                        { host_id: 1, display_name: 'one' },
                        { host_id: 2, display_name: 'two' },
                    ],
                    result_status: 'ok', meta: {},
                }),
                corpora: envelope(null, 'the network went away'),
            });
            const api = mountRail(client);
            await api.setView('hosts');
            await api.expand(NODE_KINDS.HOST, 1);
            flushSync();
            const failed = document.querySelector('[data-node-id="1"]');
            expect(failed?.querySelector(`.${CLASS.transportReason}`)?.textContent)
                .toBe('the network went away');
            // The sibling is untouched and still clickable.
            expect(document.querySelectorAll('[data-node-kind="host"]')).toHaveLength(2);
            expect(document.querySelector('[data-node-id="2"] button')).toBeTruthy();
        });
    });

describe('NavRail: the details modal', () => {
    /** One project on two machines, which is 3 of 77 on the live corpus. */
    const twoHost = {
        project_id: 5, display_name: 'shared', full_path: '-shared',
        transcript_count: 10, hosts: ['one', 'two'],
        members: [
            { host_id: 1, host_display_name: 'one', transcript_count: 4 },
            { host_id: 2, host_display_name: 'two', transcript_count: 6 },
        ],
    };

    it('opens on the info control WITHOUT also selecting the project', async () => {
        const seen: unknown[] = [];
        const { client } = clientWith({ merged: mergedEnvelope([twoHost]) });
        const api = mountRail(client, { onSelect: () => seen.push(1) });
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        expect(document.querySelector(`.${INFO_CLASS.root}`)).toBeTruthy();
        expect(seen).toHaveLength(0);
    });

    it('names both machines and links each one', async () => {
        const { client } = clientWith({ merged: mergedEnvelope([twoHost]) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        const section = document.querySelector('[data-section="machines"]');
        expect(section?.getAttribute('data-machines')).toBe('2');
        expect(section?.textContent).toContain('Collected from 2 machines');
        expect(document.querySelectorAll('[data-action="filter-host"]')).toHaveLength(2);
    });

    it('A MACHINE LIST NEVER REPORTED IS NOT AN EMPTY ONE: it renders a '
        + 'could-not-evaluate rather than an empty section', async () => {
        const envelopes: unknown[] = [];
        const { client } = clientWith({
            merged: mergedEnvelope([{ project_id: 6, display_name: 'p', full_path: '-p' }]),
        });
        const api = mountRail(client, {
            renderOutcome: (e: unknown) => {
                envelopes.push(e);
                const el = document.createElement('p');
                el.textContent = 'could not evaluate';
                return el;
            },
        });
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        const section = document.querySelector('[data-section="machines"]');
        expect(section?.getAttribute('data-machines')).toBe('cannot-determine');
        expect(section?.querySelectorAll(`.${INFO_CLASS.machine}`)).toHaveLength(0);
        expect((envelopes[0] as { result_status: string }).result_status)
            .toBe('cannot_determine');
    });

    it('PORTALS the overlay to the host it was given, because ModalStack '
        + 'refuses to route Escape to an overlay that is not a direct '
        + 'child of the body', async () => {
        // `modal-stack.js:115` queries `:scope > .modal-overlay` on
        // document.body and refuses to act unless the top registered
        // entry is the last of them. An overlay left in the rail's own
        // subtree is not a child of body at all, so Escape SILENTLY
        // stops closing the modal - nothing throws and nothing logs.
        const seen: Element[] = [];
        const stack = { push: (el: Element) => { seen.push(el); }, pop: () => {} };
        const { client } = clientWith({ merged: mergedEnvelope([twoHost]) });
        const api = mountRail(client, { modalStack: stack, modalHost: document.body });
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        const overlay = document.querySelector('.modal-overlay');
        expect(overlay?.parentElement).toBe(document.body);
        // The node the stack was handed is the node that is parented
        // there, which is the whole claim: pushing an overlay from a
        // position the stack cannot see is the failure being avoided.
        expect(seen[0]).toBe(overlay);
        expect([...document.body.querySelectorAll(':scope > .modal-overlay')])
            .toContain(overlay);
    });

    it('WITHOUT a host it stays in the subtree, which still paints and '
        + 'loses Escape routing - recorded, not hidden', async () => {
        const { client } = clientWith({ merged: mergedEnvelope([twoHost]) });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        const overlay = document.querySelector('.modal-overlay');
        expect(overlay).toBeTruthy();
        expect(overlay?.closest('.archive-nav')).toBeTruthy();
        expect([...document.body.querySelectorAll(':scope > .modal-overlay')])
            .not.toContain(overlay);
    });

    it('pushes onto the INJECTED modal stack and pops on close, reaching no '
        + 'global for it', async () => {
        const events: string[] = [];
        const stack = {
            push: () => { events.push('push'); },
            pop: () => { events.push('pop'); },
        };
        const { client } = clientWith({ merged: mergedEnvelope([twoHost]) });
        const api = mountRail(client, { modalStack: stack, modalHost: document.body });
        await api.loadMergedProjects();
        flushSync();
        document.querySelector<HTMLButtonElement>('[data-action="info"]')?.click();
        flushSync();
        expect(events).toEqual(['push']);
        document.querySelector<HTMLButtonElement>('[data-action="close"]')?.click();
        flushSync();
        expect(events).toEqual(['push', 'pop']);
        expect(document.querySelector(`.${INFO_CLASS.root}`)).toBeNull();
    });

    it('narrowing to a machine closes the modal and filters the rail', async () => {
        const { client } = clientWith({
            merged: mergedEnvelope([
                twoHost,
                { project_id: 9, display_name: 'only-one', full_path: '-one',
                    hosts: ['one'], members: [{ host_id: 1, host_display_name: 'one' }] },
            ]),
        });
        const api = mountRail(client);
        await api.loadMergedProjects();
        flushSync();
        expect(cards()).toHaveLength(2);
        // ADDRESSED BY ID, not by position. Neither node carries a date,
        // so both park and the parked block is ordered by NAME - which
        // puts `only-one` first and would otherwise open the wrong card's
        // modal. The test found that; it is the ordering doing its job.
        document.querySelector<HTMLButtonElement>(
            '[data-node-id="5"] [data-action="info"]')?.click();
        flushSync();
        document.querySelectorAll<HTMLButtonElement>('[data-action="filter-host"]')[1]?.click();
        flushSync();
        expect(document.querySelector(`.${INFO_CLASS.root}`)).toBeNull();
        expect(cards()).toHaveLength(1);
        expect(cards()[0]?.getAttribute('data-node-id')).toBe('5');
    });
});
