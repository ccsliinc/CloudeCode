/**
 * THE MERGED VIEW'S THREE JOBS, PROVED AGAINST THE VANILLA MODULE.
 *
 * WHAT `archive-nav-merged.js` MERGES: NOTHING, and that is the finding
 * this file records so the next reader does not reimplement a merge from
 * the file's name. THE MERGE IS THE SERVER'S -
 * `src/core/archive_project_names.py::merge_projects` - keyed on
 * `observed_cwd`, with a row that has none keying on its own project id
 * and staying separate. The client module consumes those nodes and does
 * three things: narrows by machine, orders then fuzzily ranks, and
 * decides which unattributed corpus rows get a node. Those three are
 * what is asserted here, each against the vanilla function.
 *
 * THE PIPELINE IS COMPARED WHOLE, not function by function.
 * `normalizedProjects` was a closure in the vanilla file and is not
 * exported, so the comparison reconstructs what its `paint()` did -
 * `filterByHost`, then `sortNodes`, then `rank` - and asserts my
 * `paintMerged` lands on the same rows in the same order. Comparing only
 * the exported halves would leave the SEQUENCE untested, and the
 * sequence is the interesting part: order first, then rank, so relevance
 * wins when something is typed and the chosen order wins when nothing is.
 */
import { describe, expect, it } from 'vitest';
import {
    loadVanilla, type VanillaFuzzyModule, type VanillaMergedModule,
    type VanillaOrderModule,
} from './nav-vanilla-harness';
import { FIELDS, filterByHost, paintMerged, partitionUnattributed, hostOptions } from './nav-merged';
import real from './nav-real-nodes.fixture.json' with { type: 'json' };

const NODES = real as unknown as Record<string, unknown>[];

/** The vanilla chain, in the order the browser loads it. */
const win = loadVanilla(
    'archive-nav-merged.js',
    loadVanilla('archive-nav-row.js',
        loadVanilla('archive-nav-fuzzy.js', loadVanilla('archive-nav-order.js', {}))),
);
const VanillaMerged = win.ArchiveNavMerged as VanillaMergedModule;
const VanillaOrder = win.ArchiveNavOrder as VanillaOrderModule;
const VanillaFuzzy = win.ArchiveNavFuzzy as VanillaFuzzyModule;

/** Nodes with real host membership, since the live corpus has one host. */
const TWO_HOST = [
    { full_path: '-a', display_name: 'a', activity_status: 'known',
        newest_activity_at: '2026-01-01T00:00:00Z', session_count: 1,
        session_counted: true, hosts: ['one'], members: [{ host_id: 1 }] },
    { full_path: '-b', display_name: 'b', activity_status: 'known',
        newest_activity_at: '2026-02-01T00:00:00Z', session_count: 2,
        session_counted: true, hosts: ['two'], members: [{ host_id: 2 }] },
    { full_path: '-c', display_name: 'c', activity_status: 'known',
        newest_activity_at: '2026-03-01T00:00:00Z', session_count: 3,
        session_counted: true, hosts: ['one', 'two'],
        members: [{ host_id: 1 }, { host_id: 2 }] },
];

describe('POSITIVE CONTROL', () => {
    it('the vanilla chain loaded and the fixture is the real corpus', () => {
        expect(typeof VanillaMerged.filterByHost).toBe('function');
        expect(typeof VanillaMerged.partitionUnattributed).toBe('function');
        expect(NODES.length).toBe(98);
    });

    it('the FIELDS table is the same one, weights included', () => {
        expect(FIELDS).toEqual(VanillaMerged.FIELDS);
    });
});

describe('filterByHost agrees with the vanilla rule', () => {
    for (const hostId of [null, undefined, '', 1, 2, '2', 99] as unknown[]) {
        it(`for hostId ${JSON.stringify(hostId)}`, () => {
            const mine = filterByHost(TWO_HOST, hostId as number | string | null);
            const theirs = VanillaMerged.filterByHost(TWO_HOST, hostId);
            expect(mine.map((n) => n.full_path))
                .toEqual(theirs.map((n) => n.full_path));
        });
    }

    it('an EMPTY host filter returns every node, never an empty list, which '
        + 'would read as "this machine has no projects"', () => {
        expect(filterByHost(NODES, null).length).toBe(98);
        expect(filterByHost(NODES, '').length).toBe(98);
    });
});

describe('partitionUnattributed agrees, including which rows are hidden', () => {
    const rows = [
        { corpus_id: 1, transcript_count: 0 },
        { corpus_id: 2, transcript_count: 5 },
        { corpus_id: 3, transcript_count: null },
        { corpus_id: 4, counted: false, transcript_count: 7 },
        { corpus_id: 5 },
    ];

    it('splits the same way and gives the same reasons', () => {
        const mine = partitionUnattributed(rows);
        const theirs = VanillaMerged.partitionUnattributed(rows);
        expect(mine.shown.map((e) => e.reason))
            .toEqual(theirs.shown.map((e) => e.reason));
        expect(mine.hidden.map((e) => e.reason))
            .toEqual(theirs.hidden.map((e) => e.reason));
    });

    it('HIDES ONLY A MEASURED ZERO. A missing, null or uncounted count keeps '
        + 'the node, because these are the transcripts invisible from the '
        + 'project tree by construction', () => {
        const mine = partitionUnattributed(rows);
        expect(mine.hidden).toHaveLength(1);
        expect(mine.hidden[0]?.row.corpus_id).toBe(1);
        expect(mine.shown.map((e) => e.row.corpus_id)).toEqual([2, 3, 4, 5]);
    });
});

describe('the whole pipeline agrees: filter, order, rank, in that sequence', () => {
    /** What the vanilla `paint()` computed, reconstructed from its parts. */
    function vanillaPipeline(
        nodes: unknown[], hostId: unknown, order: string, text: string,
    ): string[] {
        const filtered = VanillaMerged.filterByHost(nodes, hostId);
        const sorted = VanillaOrder.sortNodes(filtered, order);
        const ranked = VanillaFuzzy.rank(sorted.nodes, text, VanillaMerged.FIELDS);
        return ranked.map((h) => String(h.row.full_path));
    }

    for (const order of ['recent', 'oldest', 'name', 'size']) {
        for (const text of ['', 'cloude', 'dev', 'sync']) {
            it(`over 98 real projects, order "${order}", filter "${text}"`, () => {
                const mine = paintMerged(NODES, [], null, text, order);
                expect(mine.projects.map((p) => String(p.row.full_path)))
                    .toEqual(vanillaPipeline(NODES, null, order, text));
            });
        }
    }

    it('with a machine filter as well', () => {
        for (const hostId of [null, 1, 2]) {
            expect(paintMerged(TWO_HOST, [], hostId, 'a', 'recent')
                .projects.map((p) => String(p.row.full_path)))
                .toEqual(vanillaPipeline(TWO_HOST, hostId, 'recent', 'a'));
        }
    });

    it('NO FILTER TEXT means the chosen ORDER is what shows, which is the '
        + 'whole reason the order runs first', () => {
        const recent = paintMerged(NODES, [], null, '', 'recent');
        const oldest = paintMerged(NODES, [], null, '', 'oldest');
        const rIds = recent.projects.map((p) => String(p.row.full_path));
        const oIds = oldest.projects.map((p) => String(p.row.full_path));
        expect(rIds).not.toEqual(oIds);
        expect(rIds.slice().reverse()).toEqual(oIds);
    });

    it('FILTER TEXT means RELEVANCE WINS, so the matches are re-sorted out '
        + 'of the chosen order', () => {
        // A person who has typed is looking for one project, and
        // re-sorting his best match to the bottom because it happens to
        // be old would make the filter useless.
        //
        // MEASURED ON THE REAL CORPUS, and the measurement corrected the
        // assertion this test first carried. "cloudecode" matches 19 of
        // the 98 projects, and the top score is a TIE at 45 between the
        // CloudeCode checkout and `...Production-dev-tools-scripts`,
        // broken by the incoming order - the ordering still doing its
        // job on ties. Those two happen to be the NEWEST and the OLDEST
        // project in the corpus, so "the first row changes" is
        // coincidentally false in both time directions. What is
        // genuinely true, and is what relevance-wins means, is that the
        // ranked list is NOT the matching rows in their chosen order.
        for (const order of ['recent', 'oldest']) {
            const typed = paintMerged(NODES, [], null, 'cloudecode', order);
            const ordered = paintMerged(NODES, [], null, '', order);
            const matched = new Set(typed.projects.map((p) => String(p.row.full_path)));
            const inChosenOrder = ordered.projects
                .map((p) => String(p.row.full_path))
                .filter((id) => matched.has(id));
            expect(typed.projects.length, order).toBe(19);
            expect(typed.projects[0]?.score, order).toBe(45);
            expect(typed.projects.filter((p) => p.score === 45).length, order).toBe(2);
            expect(typed.projects.map((p) => String(p.row.full_path)), order)
                .not.toEqual(inChosenOrder);
        }
    });

    it('the unattributed rows are NOT ranked and are dropped while filtering, '
        + 'because they are a scope and not a project', () => {
        const rows = [{ corpus_id: 2, transcript_count: 5 }];
        expect(paintMerged(NODES, rows, null, '', 'recent').unattributed).toHaveLength(1);
        expect(paintMerged(NODES, rows, null, 'cloude', 'recent').unattributed).toHaveLength(0);
    });

    it('reports the counts the honest filter sentence needs without '
        + 'recounting anything', () => {
        const out = paintMerged(NODES, [{ corpus_id: 1, transcript_count: 0 }],
            null, 'cloudecode', 'recent');
        expect(out.total).toBe(98);
        expect(out.rendered).toBe(out.projects.length);
        expect(out.rendered).toBeLessThan(98);
        expect(out.hiddenUnattributed).toBe(1);
    });
});

describe('hostOptions is built from the hosts the SERVER named', () => {
    it('leads with an all-machines entry carrying an EMPTY value', () => {
        const out = hostOptions([{ host_id: 2, display_name: 'mini', project_count: 4 }]);
        expect(out[0]).toEqual({ value: '', label: 'All machines' });
        expect(out[1]).toEqual({ value: '2', label: 'mini (4)' });
    });

    it('a project count the server did not report reads NOT KNOWN, never 0', () => {
        const out = hostOptions([{ host_id: 2, display_name: 'mini' }]);
        expect(out[1]?.label).toBe('mini (NOT KNOWN)');
    });
});

describe('NEGATIVE CONTROL: paintMerged can return nothing', () => {
    it('a query no project contains renders no rows at all', () => {
        // A filter that always finds something is worse than useless: it
        // would pass every positive assertion above.
        expect(paintMerged(NODES, [], null, 'qqzzxx', 'recent').rendered).toBe(0);
    });

    it('a host filter naming a machine nothing is on renders no rows', () => {
        expect(paintMerged(TWO_HOST, [], 99, '', 'recent').rendered).toBe(0);
    });

    it('an empty node list renders nothing rather than inventing a row', () => {
        expect(paintMerged([], [], null, '', 'recent').rendered).toBe(0);
        expect(paintMerged(null, null, null, '', 'recent').rendered).toBe(0);
    });
});
