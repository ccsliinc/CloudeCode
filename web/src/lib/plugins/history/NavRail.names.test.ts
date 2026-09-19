/**
 * A PROJECT NAME REACHES THE SCREEN IN EVERY VIEW OF THE RAIL, OR IT
 * REACHES NONE OF THEM.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT A SECOND COPY OF
 * `NavProjectCard.names.test.ts`. That file mounts ONE CARD and hands it
 * a row that already carries `app_name_source`. It is correct and it
 * passed throughout, because the defect was never in the card: the two
 * routes the rail actually lists from - `/archive/overlay/projects` and
 * `/archive/corpora/{id}/projects` - carry NONE of the app-name fields,
 * while the only decorated route, `/archive/projects`, is read by no
 * view. Measured against the live databases 2026-09-19: 100 of 100 rows
 * decorated on the route nobody calls, 0 of 100 on both routes the rail
 * calls. So every card drew its slug while a card test fed a decorated
 * fixture went green. A FIXTURE THAT CARRIES THE FIELD CANNOT DETECT A
 * MISSING FIELD.
 *
 * SO THIS STARTS ONE LAYER LOWER. It builds the REAL
 * `createArchiveClient` over a fake TRANSPORT and mounts the REAL
 * `NavRail`, then reads text out of the DOM. Everything between the
 * socket and the screen is shipping code, which is the only arrangement
 * that can fail for the reason this actually failed.
 *
 * BOTH VIEWS, ENUMERATED. `VIEWS` has exactly two members and both are
 * driven here. Worth recording, because the handed-down diagnosis said
 * the by-machine view rendered projects through `NavNode` and
 * `labelFor`: it does not. `NavLevel.svelte` branches `kind ===
 * PROJECT` to `NavProjectCard`, so both views have always shared one
 * component and one resolver. The last describe block pins that, so a
 * future change that DID start drawing a project through `NavNode`
 * fails here rather than shipping a second name ladder.
 *
 * THE CONTROL ARM IS LOAD-BEARING. With `/archive/projects` made
 * unreachable the join index is incomplete and nothing is carried, so
 * every row must fall back to its path. Without that arm this suite
 * would pass just as happily against a rail that printed names from
 * anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import NavRail from './NavRail.svelte';
import NavNode from './NavNode.svelte';
import { createArchiveClient } from './client';
import { APP_NAME_SOURCES } from './nav-app-name';
import { scratchLabel } from './nav-scratch-label';
import { NODE_KINDS, VIEWS } from './nav-vocab';
import { labelFor, type NavRowData } from './nav-row';
import type { OutcomeClassifier } from './state';
import type { ScreenApi } from '../types';

/** The slug every undecorated row falls back to. Unmistakable. */
const SLUG_FOR = (id: number) => `-Users-someone-Development-project-${id}`;

/** The name the app database supplies. Also unmistakable. */
const APP_NAME = 'A Real Project Name';

/** A real scratch directory, shortened from one of the 17 on this install. */
const SCRATCH_CWD = '/private/var/folders/p6/2fx4wn854s19lksf30bgv6rh0000gn/T/cc_rht_work_ko0irget';

/** The leaf it is told apart by. */
const SCRATCH_LEAF = 'cc_rht_work_ko0irget';

/** Two values no client has ever decided about. The membership control. */
const UNKNOWN_SOURCES = [
    'a_ninth_rung_nobody_has_decided_about',
    'AS_WRITTEN',
    '!!nonsense!!',
];

/** Every value the server publishes, plus the three it does not. */
const ALL_SOURCES: readonly string[] = [
    ...Object.values(APP_NAME_SOURCES),
    ...UNKNOWN_SOURCES,
];

/** The three rungs on which a name may be drawn. */
const APPROVED: readonly string[] = [
    APP_NAME_SOURCES.AS_WRITTEN,
    APP_NAME_SOURCES.CANONICAL_SPELLING,
    APP_NAME_SOURCES.DERIVED_CWD,
];

/** One UNDECORATED row, exactly as both listing routes really send them. */
function bare(id: number, key: 'full_path' | 'slug'): NavRowData {
    return {
        project_id: id,
        display_name: null,
        [key]: SLUG_FOR(id),
        transcript_count: 262,
        session_count: 4,
        session_counted: true,
    } as unknown as NavRowData;
}

/** One DECORATED row, as `/archive/projects` sends them. */
function decorated(id: number, source: string): NavRowData {
    const scratch = source === APP_NAME_SOURCES.SCRATCH_PATH;
    return {
        project_id: id,
        full_path: SLUG_FOR(id),
        app_display_name: scratch ? null : APP_NAME,
        app_name_source: source,
        app_description: 'a description that must not leak past a refusal',
        app_project_id: 900 + id,
        app_name_evidence: null,
        app_name_cwd: scratch ? SCRATCH_CWD : null,
        app_name_anchor_project_id: null,
    } as unknown as NavRowData;
}

/** An envelope result, shaped as the granted transport returns one. */
function ok(body: unknown): unknown {
    return {
        envelope: body, httpStatus: 200, headers: null,
        transportError: null, refusedByGrant: false,
    };
}

/** The decorated route made unreachable, for the control arm. */
function dead(): unknown {
    return {
        envelope: null, httpStatus: null, headers: null,
        transportError: 'control arm: /archive/projects unreachable',
        refusedByGrant: false,
    };
}

/** A listing body with the meta the merged loader reads. */
function listing(rows: readonly NavRowData[]): unknown {
    return {
        result: rows,
        result_status: 'ok',
        meta: { unattributed: { by_corpus: [] }, hosts: [] },
    };
}

/**
 * A transport serving the three project routes plus the tree above them.
 *
 * Description: this is the seam that matters. Replacing the CLIENT
 *   instead would skip the very code under test, which is how this
 *   defect survived four verifications.
 * Inputs: sources - one published value per project row.
 *   breakNamed - make `/archive/projects` unreachable (the control).
 * Output: ScreenApi.
 */
function transport(sources: readonly string[], breakNamed = false): ScreenApi {
    const ids = sources.map((_, i) => i + 1);
    return {
        grants: ['/archive'],
        call(endpoint: string): Promise<unknown> {
            const path = endpoint.split('?')[0];
            if (path === '/archive/projects') {
                return Promise.resolve(breakNamed ? dead() : ok(listing(
                    sources.map((s, i) => decorated(ids[i]!, s)),
                )));
            }
            if (path === '/archive/overlay/projects') {
                return Promise.resolve(ok(listing(ids.map((id) => bare(id, 'full_path')))));
            }
            if (path === '/archive/hosts') {
                return Promise.resolve(ok({
                    result: [{ host_id: 1, hostname: 'a-machine', transcript_count: 1 }],
                    result_status: 'ok', meta: {},
                }));
            }
            if (path === '/archive/hosts/1/corpora') {
                return Promise.resolve(ok({
                    result: [{ corpus_id: 1, corpus_key: 'k', transcript_count: 1,
                               unattributed_transcript_count: 0, counted: true }],
                    result_status: 'ok', meta: {},
                }));
            }
            if (path === '/archive/corpora/1/projects') {
                // NOTE THE DIFFERENT KEY. The per-corpus route puts the
                // slug on `slug` and leaves `full_path` null, which is
                // why the join keys on `project_id` and not on a slug.
                return Promise.resolve(ok({
                    result: ids.map((id) => bare(id, 'slug')),
                    result_status: 'ok', meta: {},
                }));
            }
            return Promise.resolve(ok({ result: [], result_status: 'ok', meta: {} }));
        },
    } as unknown as ScreenApi;
}

/** Reads the envelope's own status rather than forcing one. */
const outcome: OutcomeClassifier = {
    classify(env: unknown) {
        const e = env as { result_status?: string } | null;
        return { token: e?.result_status || 'transport_failed', reasons: [], meta: null };
    },
    isRenderable: (token: string) => token === 'ok' || token === 'partial',
    hasMore: () => null,
};

/** As much of the mounted rail as these tests drive. */
interface RailApi {
    loadMergedProjects(): Promise<string>;
    setView(next: string): Promise<string>;
    expand(kind: string, id: number | string): Promise<string>;
    currentView(): string;
}

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** One project card, as it reached the DOM. */
interface Face {
    readonly label: string;
    readonly source: string | null;
    readonly named: boolean;
    readonly scratch: boolean;
}

/**
 * Mount the rail, drive it into one view, and read every project card.
 *
 * Inputs: view - a `VIEWS` member. sources - one per row.
 *   breakNamed - the control arm's switch.
 * Output: the faces, in render order.
 */
async function facesIn(
    view: string, sources: readonly string[], breakNamed = false,
): Promise<readonly Face[]> {
    host = document.createElement('div');
    document.body.appendChild(host);
    const api = mount(NavRail, {
        target: host,
        props: {
            client: createArchiveClient(transport(sources, breakNamed)),
            outcome, onSelect: () => {},
            store: null, modalStack: null, modalHost: null,
        } as never,
    }) as unknown as RailApi;
    mounted = api as unknown as Record<string, unknown>;

    if (view === VIEWS.HOSTS) {
        await api.setView(VIEWS.HOSTS);
        await api.expand(NODE_KINDS.HOST, 1);
        await api.expand(NODE_KINDS.CORPUS, 1);
    } else {
        await api.loadMergedProjects();
    }
    expect(api.currentView()).toBe(view);

    const list = host.querySelector(
        view === VIEWS.HOSTS ? '.archive-nav__level--hosts' : '.archive-nav__level--merged',
    );
    if (!list) throw new Error(`no ${view} level rendered, so nothing was measured`);
    const cards = Array.from(list.querySelectorAll('[data-node-kind="project"]'));
    if (cards.length === 0) throw new Error(`no project cards in ${view}, nothing measured`);
    return cards.map((li) => ({
        label: (li.querySelector('.archive-nav__label')?.textContent || '').trim(),
        source: li.getAttribute('data-app-name-source'),
        named: li.getAttribute('data-app-named') === 'true',
        scratch: li.getAttribute('data-app-scratch') === 'true',
    }));
}

/**
 * Faces keyed by the rung they were drawn from.
 *
 * Description: THE MERGED VIEW REORDERS ITS ROWS - `paintMerged` applies
 *   the order control - so render position is not input position and an
 *   index-keyed assertion would be asserting the sort. Keyed on the rung
 *   instead, which is the thing each case is actually about.
 * Inputs: faces - what `facesIn` read.
 * Output: source to face.
 */
function bySource(faces: readonly Face[]): Map<string, Face> {
    const out = new Map<string, Face>();
    for (const f of faces) if (f.source !== null) out.set(f.source, f);
    return out;
}

describe('THE VIEWS ARE ENUMERATED, so a third cannot be added unmeasured', () => {
    it('has exactly two, and both are exercised below', () => {
        expect(Object.values(VIEWS).sort()).toEqual(['hosts', 'merged']);
    });
});

for (const view of Object.values(VIEWS)) {
    describe(`view=${view}: the three approved rungs draw the app name`, () => {
        it('names every approved row and leaves the slug behind', async () => {
            const faces = await facesIn(view, APPROVED);
            expect(faces).toHaveLength(APPROVED.length);
            const seen = bySource(faces);
            for (const source of APPROVED) {
                const f = seen.get(source);
                expect(f, `no card was drawn for ${source}`).toBeTruthy();
                expect(f!.label).toBe(APP_NAME);
                expect(f!.label).not.toContain('-Users-someone');
                expect(f!.named).toBe(true);
                expect(f!.scratch).toBe(false);
            }
        });
    });

    describe(`view=${view}: every refusal still draws the path`, () => {
        const refused = [
            APP_NAME_SOURCES.NONE,
            APP_NAME_SOURCES.AMBIGUOUS,
            APP_NAME_SOURCES.CWD_CONFLICT,
            APP_NAME_SOURCES.CANNOT_DETERMINE,
        ];
        it('draws no name on any of the four, though one was sent', async () => {
            const faces = await facesIn(view, refused);
            const seen = bySource(faces);
            for (const source of refused) {
                // The rung still rides on the element: a refusal that
                // erased its own reason says nothing about why.
                const f = seen.get(source);
                expect(f, `no card was drawn for ${source}`).toBeTruthy();
                expect(f!.label).toMatch(/^-Users-someone-Development-project-\d+$/);
                expect(f!.label).not.toContain(APP_NAME);
                expect(f!.named).toBe(false);
                expect(f!.scratch).toBe(false);
            }
        });
    });

    describe(`view=${view}: an unknown source may never draw a name`, () => {
        it('refuses all three, as a membership test and not a shape test', async () => {
            const faces = await facesIn(view, UNKNOWN_SOURCES);
            const seen = bySource(faces);
            for (const source of UNKNOWN_SOURCES) {
                const f = seen.get(source);
                expect(f, `no card was drawn for ${source}`).toBeTruthy();
                expect(f!.label).toMatch(/^-Users-someone-Development-project-\d+$/);
                expect(f!.label).not.toContain(APP_NAME);
                expect(f!.named).toBe(false);
                expect(f!.scratch).toBe(false);
            }
        });
    });

    describe(`view=${view}: scratch_path is neither named nor pathed`, () => {
        it('draws the recessive scratch face and keeps the path off it', async () => {
            const [f] = await facesIn(view, [APP_NAME_SOURCES.SCRATCH_PATH]);
            expect(f!.label).toBe(scratchLabel(SCRATCH_CWD));
            expect(f!.label).toContain(SCRATCH_LEAF);
            expect(f!.label).not.toBe(APP_NAME);
            expect(f!.label).not.toContain(SLUG_FOR(1));
            expect(f!.label).not.toContain(SCRATCH_CWD);
            expect(f!.named).toBe(false);
            expect(f!.scratch).toBe(true);
        });
    });

    describe(`view=${view}: THE CONTROL - an undecorated listing draws slugs`, () => {
        it('every published kind falls back to its path when '
            + '/archive/projects cannot be read, which is the pre-fix '
            + 'state and proves this suite can still fail', async () => {
            const faces = await facesIn(view, ALL_SOURCES, true);
            expect(faces).toHaveLength(ALL_SOURCES.length);
            // Every row, whatever rung it WOULD have been, is a path.
            // Compared as a SET because the merged view sorts.
            expect(faces.map((f) => f.label).sort())
                .toEqual(ALL_SOURCES.map((_, i) => SLUG_FOR(i + 1)).sort());
            for (const f of faces) {
                expect(f.named).toBe(false);
                expect(f.scratch).toBe(false);
                // No source field arrived at all, which is a different
                // finding from a source that refused.
                expect(f.source).toBe(null);
            }
        });
    });

    describe(`view=${view}: the whole published vocabulary at once`, () => {
        it('names exactly the three approved kinds out of eleven', async () => {
            const faces = await facesIn(view, ALL_SOURCES);
            const named = faces.filter((f) => f.named);
            expect(named).toHaveLength(APPROVED.length);
            expect(faces.filter((f) => f.scratch)).toHaveLength(1);
        });
    });
}

describe('NavNode DOES NOT AND MUST NOT NAME A PROJECT', () => {
    /**
     * `NavLevel.svelte` branches `kind === PROJECT` to `NavProjectCard`,
     * so `NavNode` never receives one in either view. This pins the
     * other half of that: even handed a project row carrying a perfectly
     * good approved name, `NavNode` renders `labelFor`'s answer. If a
     * future change routes a project here, or threads the app name into
     * `labelFor`, this fails instead of quietly growing a second name
     * ladder beside the one in `nav-card.ts`.
     */
    function nodeLabel(kind: string, row: NavRowData): string {
        host = document.createElement('ul');
        document.body.appendChild(host);
        mounted = mount(NavNode, {
            target: host, props: { kind, row } as never,
        }) as unknown as Record<string, unknown>;
        return (host.querySelector('.archive-nav__label')?.textContent || '').trim();
    }

    it('renders labelFor even for a project row carrying an approved name', () => {
        const row = decorated(1, APP_NAME_SOURCES.AS_WRITTEN);
        const drawn = nodeLabel(NODE_KINDS.PROJECT, row);
        expect(drawn).toBe(labelFor(NODE_KINDS.PROJECT, row));
        expect(drawn).toBe(SLUG_FOR(1));
        expect(drawn).not.toBe(APP_NAME);
    });

    it('labelFor itself is untouched by the app-name fields, which is why '
        + 'it is NOT the seam: nav-card.ts calls it to derive the rung '
        + 'BENEATH the app name, and the vanilla parity suites compare it '
        + 'against the still-shipping renderer', () => {
        const plain = { project_id: 1, full_path: SLUG_FOR(1) } as unknown as NavRowData;
        const withName = decorated(1, APP_NAME_SOURCES.AS_WRITTEN);
        expect(labelFor(NODE_KINDS.PROJECT, withName))
            .toBe(labelFor(NODE_KINDS.PROJECT, plain));
    });

    it('a host row is unaffected in every way', () => {
        const drawn = nodeLabel(NODE_KINDS.HOST, {
            host_id: 1, hostname: 'a-machine', display_name: null,
            app_display_name: APP_NAME, app_name_source: APP_NAME_SOURCES.AS_WRITTEN,
        } as unknown as NavRowData);
        expect(drawn).toBe('a-machine');
    });
});
