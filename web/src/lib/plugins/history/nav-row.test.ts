/**
 * THE ROW VOCABULARY, THE CARD'S COUNTS AND THE MODAL'S MACHINE RULES,
 * PROVED AGAINST THE VANILLA MODULES THEY REPLACE.
 *
 * Same discipline as `nav-order.parity.test.ts`: the real
 * `client/js/archive-nav-row.js`, `archive-nav-card.js` and
 * `archive-nav-info.js` are evaluated from disk and every claim is "the
 * port and the original answer the same thing". Where a function has no
 * vanilla counterpart - `countsLine` and `infoField` exist because a
 * Svelte template holds no logic - it is asserted directly and the
 * assertion says so.
 *
 * THE FAKE WINDOW IS SEEDED WITH `ArchiveFormat`, AND LEAVING IT OUT WAS
 * A FALSE FAILURE THIS SUITE PRODUCED ON ITS FIRST RUN. The vanilla
 * `renderCount` reads `window.ArchiveFormat.formatCount` and falls back
 * to bare `String(n)` when it is absent, so an unseeded harness had it
 * answering '3416' against the port's '3,416' and looked like a
 * regression in the port. In the real browser that global IS present and
 * IS this same `format.ts`: `web/src/main.ts` publishes it through
 * `installArchiveGlobals()` precisely so the legacy modules of slices 3
 * and 5 to 9 share one implementation. Seeding it makes the comparison
 * faithful to the browser rather than to an environment neither module
 * ever runs in.
 *
 * THE VANILLA CARD IS LOADED WITHOUT ITS DOM DEPENDENCIES ON PURPOSE.
 * `renderCard` needs a document and this suite does not call it; the
 * pure functions beside it - `sessionCountFor`, `presentationFor`,
 * `countsTitle` - reach nothing but their arguments, which is why they
 * were the half worth porting as data.
 */
import { describe, expect, it } from 'vitest';
import {
    loadVanilla, type VanillaCardModule, type VanillaInfoModule,
    type VanillaRowModule,
} from './nav-vanilla-harness';
import { NODE_KINDS, UNATTRIBUTED_LABEL } from './nav-vocab';
import {
    countFor, describeFilter, filterRows, idFor, labelFor, renderCount,
    shouldShowUnattributed, titleFor, unattributedNote,
} from './nav-row';
import { countsLine, countsTitle, presentationFor, sessionCountFor } from './nav-card';
import { infoField, machineRows, machinesHeading } from './nav-info';
import { archiveFormat } from './format';

const win = loadVanilla('archive-nav-info.js',
    loadVanilla('archive-nav-card.js',
        loadVanilla('archive-nav-row.js',
            loadVanilla('archive-nav-order.js', { ArchiveFormat: archiveFormat }))));
const Row = win.ArchiveNavRow as VanillaRowModule;
const Card = win.ArchiveNavCard as VanillaCardModule;
const Info = win.ArchiveNavInfo as VanillaInfoModule;

/** Rows covering every branch each rule has. */
const ROWS: Record<string, Record<string, unknown>> = {
    host: { host_id: 1, display_name: 'mini', hostname: 'mini.local', transcript_count: 9 },
    hostBare: { host_id: 2 },
    corpus: { corpus_id: 3, corpus_key: 'k', root_path: '/r', transcript_count: 4 },
    corpusBare: { corpus_id: 4 },
    project: { project_id: 5, display_name: 'Media', full_path: '-Users-x-Media',
        observed_cwd: '/Users/x/Media', hosts: ['one', 'two'], transcript_count: 7 },
    projectNoName: { project_id: 6, full_path: '-Users-x-Thing' },
    projectBare: { project_id: 7 },
    unattributed: { corpus_id: 3, unattributed_transcript_count: 5 },
};

describe('POSITIVE CONTROL', () => {
    it('the vanilla modules loaded', () => {
        expect(typeof Row.labelFor).toBe('function');
        expect(typeof Card.sessionCountFor).toBe('function');
        expect(typeof Info.machinesHeading).toBe('function');
    });
});

describe('labelFor, titleFor, idFor and countFor agree with the vanilla rules', () => {
    const cases: [string, string][] = [
        [NODE_KINDS.HOST, 'host'], [NODE_KINDS.HOST, 'hostBare'],
        [NODE_KINDS.CORPUS, 'corpus'], [NODE_KINDS.CORPUS, 'corpusBare'],
        [NODE_KINDS.PROJECT, 'project'], [NODE_KINDS.PROJECT, 'projectNoName'],
        [NODE_KINDS.PROJECT, 'projectBare'],
        [NODE_KINDS.UNATTRIBUTED, 'unattributed'],
    ];
    for (const [kind, key] of cases) {
        it(`${kind} / ${key}`, () => {
            const row = ROWS[key] as Record<string, unknown>;
            expect(labelFor(kind as never, row)).toBe(Row.labelFor(kind, row));
            expect(titleFor(kind as never, row)).toBe(Row.titleFor(kind, row));
            expect(idFor(kind as never, row)).toBe(Row.idFor(kind, row));
            expect(countFor(kind as never, row)).toBe(Row.countFor(kind, row));
        });
    }

    it('a label is NEVER empty, because a blank row cannot be clicked with '
        + 'intent', () => {
        for (const [kind, key] of cases) {
            expect(labelFor(kind as never, ROWS[key]).length).toBeGreaterThan(0);
        }
        expect(labelFor(NODE_KINDS.UNATTRIBUTED, {})).toBe(UNATTRIBUTED_LABEL);
    });

    it('a project with no display_name shows its SLUG, not a fabricated leaf', () => {
        expect(labelFor(NODE_KINDS.PROJECT, ROWS.projectNoName)).toBe('-Users-x-Thing');
    });
});

describe('renderCount never prints a zero for an absence', () => {
    for (const n of [0, 1, 3416, null, undefined, NaN, Infinity, 'x'] as unknown[]) {
        it(`for ${JSON.stringify(n)}`, () => {
            expect(renderCount(n)).toBe(Row.renderCount(n));
        });
    }

    it('0 and "not measured" are DIFFERENT findings and read differently', () => {
        expect(renderCount(0)).toBe('0');
        expect(renderCount(null)).toBe('NOT KNOWN');
    });
});

describe('the honest filter sentence, and the substring filter behind it', () => {
    it('describeFilter agrees, word for word', () => {
        const cases: [number, number, number | null, string][] = [
            [3, 71, 3416, 'projects'], [0, 71, null, 'hosts'], [71, 71, 71, 'projects'],
        ];
        for (const [m, l, t, noun] of cases) {
            expect(describeFilter(m, l, t, noun)).toBe(Row.describeFilter(m, l, t, noun));
        }
    });

    it('always says it filtered rows already fetched', () => {
        expect(describeFilter(3, 71, 3416, 'projects')).toContain('not the whole corpus');
    });

    it('filterRows agrees, including the empty-needle case', () => {
        const rows = [{ slug: 'abc' }, { slug: 'xyz' }, { other: 'abc' }];
        for (const q of ['', 'B', 'abc', 'zzz']) {
            expect(filterRows(rows, q, ['slug'])).toEqual(Row.filterRows(rows, q, ['slug']));
        }
    });
});

describe('the unattributed verdict, which is the one place a wrong hide is '
    + 'permanent', () => {
    const cases: Record<string, unknown>[] = [
        { unattributed_transcript_count: 0 },
        { unattributed_transcript_count: 5 },
        { unattributed_transcript_count: null },
        { counted: false, unattributed_transcript_count: 7 },
        {},
    ];
    for (const row of cases) {
        it(`agrees for ${JSON.stringify(row)}`, () => {
            expect(shouldShowUnattributed(row)).toEqual(Row.shouldShowUnattributed(row));
            expect(unattributedNote(row)).toEqual(Row.unattributedNote(row));
        });
    }

    it('ONLY a measured zero hides it', () => {
        expect(cases.filter((r) => !shouldShowUnattributed(r).show)).toHaveLength(1);
        expect(shouldShowUnattributed({ unattributed_transcript_count: 0 }).reason)
            .toBe('known zero');
    });

    it('the note is ANSWERED only for a measured count, so an open question '
        + 'is not dressed up as a settled one', () => {
        expect(unattributedNote({ unattributed_transcript_count: 5 }).answered).toBe(true);
        expect(unattributedNote({ unattributed_transcript_count: null }).answered).toBe(false);
        expect(unattributedNote({ counted: false }).answered).toBe(false);
    });
});

describe('the session count: three outcomes, never a substitute', () => {
    const cases: Record<string, unknown>[] = [
        { session_count: 27 },
        { session_count: 0 },
        { transcript_count: 718 },
        { session_counted: false, session_count: 27 },
        { session_count: null, session_transcript_count: 9 },
        { session_transcript_count: 9 },
    ];
    for (const row of cases) {
        it(`agrees for ${JSON.stringify(row)}`, () => {
            expect(sessionCountFor(row)).toEqual(Card.sessionCountFor(row));
            expect(countsTitle(sessionCountFor(row), 718))
                .toBe(Card.countsTitle(Card.sessionCountFor(row), 718));
        });
    }

    it('a PRESENT-but-null field is cannot-determine and does NOT fall '
        + 'through to the alias, which would let a stale second field '
        + 'answer for a first that said "I do not know"', () => {
        expect(sessionCountFor({ session_count: null, session_transcript_count: 9 }))
            .toEqual({ state: 'cannot-determine', value: null });
    });

    it('`value` is a number ONLY in the known state, so a caller cannot '
        + 'render a substitute by accident', () => {
        for (const row of cases) {
            const out = sessionCountFor(row);
            expect(typeof out.value === 'number').toBe(out.state === 'known');
        }
    });

    it('countsLine resolves both halves and the tooltip. NO VANILLA '
        + 'COUNTERPART: `renderCounts` built a DOM node, and this is the '
        + 'model it built it from, so the Svelte template holds no logic', () => {
        expect(countsLine({ session_count: 27, transcript_count: 718 }))
            .toMatchObject({ sessionText: '27', totalText: '718', total: 718 });
        expect(countsLine({ transcript_count: 718 }).sessionText).toBe('NOT KNOWN');
        expect(countsLine({}).totalText).toBe('NOT KNOWN');
    });
});

/**
 * Read a presentation as a plain bag, so the two modules' key sets can
 * be compared without either being widened in its own declaration.
 *
 * Inputs: value - a presentation from either module.
 * Output: the same object, typed as a record.
 */
function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

describe('the presentation overlay: three values, and the third is not a '
    + 'flavour of the first', () => {
    const cases: Record<string, unknown>[] = [
        { project_id: 1, display_name: 'shown', archive_display_name: 'onDisk',
            overlay: { status: 'applied', group: 'g', hidden: true,
                applied: ['display_name'] } },
        { project_id: 2, display_name: 'same', archive_display_name: 'same',
            overlay: { status: 'applied', applied: ['display_name'] } },
        { project_id: 3, display_name: 'p', overlay: { status: 'none', applied: [] } },
        { project_id: 4, display_name: 'p', overlay: { status: 'cannot_determine' } },
        { project_id: 5, display_name: 'p', full_path: '-p' },
    ];
    /**
     * PARITY IS NOW A SUBSET ASSERTION, AND THE REASON IS RECORDED
     * RATHER THAN THE ASSERTION BEING WEAKENED QUIETLY.
     * `presentationFor` gained `app`, `fromApp` and `scratch`, which
     * carry the app-database name and the measured-throwaway-directory
     * outcome that the vanilla module predates and knows nothing
     * about. Exact equality would now fail on every row for a reason
     * that is not a port defect. So: every key the VANILLA module
     * produces must still be produced identically - that is the
     * commitment, unchanged - and the added keys are asserted to be
     * additions rather than replacements, by checking vanilla has
     * neither. A test that only compared the shared keys would pass
     * just as well if our port had silently DROPPED one of them, which
     * is why the key sets are compared too.
     */
    for (const row of cases) {
        it(`agrees for project ${String(row.project_id)}`, () => {
            const ours = asRecord(presentationFor(row, null));
            const theirs = Card.presentationFor(row, null);
            for (const key of Object.keys(theirs)) {
                expect({ [key]: ours[key] }).toEqual({ [key]: theirs[key] });
            }
            expect(Object.keys(ours).filter((k) => !(k in theirs)).sort())
                .toEqual(['app', 'fromApp', 'scratch']);
        });
    }

    it('a row with NO overlay block reads `absent`, which is one level up '
        + 'from `none`: this build is talking to an endpoint that carries '
        + 'no block at all', () => {
        expect(presentationFor(cases[4] as never, null).overlayStatus).toBe('absent');
    });

    it('`renamed` comes off `applied` and NEVER off comparing two strings, '
        + 'because renaming a project to its own folder name is a thing a '
        + 'person may do', () => {
        expect(presentationFor(cases[1] as never, null).renamed).toBe(true);
    });

    it('a client-side fallback is consulted ONLY when the row carries no '
        + 'block', () => {
        const fallback = { 5: { display_name: 'from-fallback' }, 1: { display_name: 'ignored' } };
        expect(presentationFor(cases[4] as never, fallback).name).toBe('from-fallback');
        expect(presentationFor(cases[0] as never, fallback).name).toBe('shown');
        const ours = asRecord(presentationFor(cases[4] as never, fallback));
        const theirs = Card.presentationFor(cases[4], fallback);
        for (const key of Object.keys(theirs)) {
            expect({ [key]: ours[key] }).toEqual({ [key]: theirs[key] });
        }
    });
});

describe('the modal machine rules', () => {
    const rows: unknown[] = [
        undefined, [], ['one'], ['one', 'two'], 'not-an-array',
    ];
    for (const hosts of rows) {
        it(`machinesHeading agrees for ${JSON.stringify(hosts)}`, () => {
            expect(machinesHeading(hosts)).toEqual(Info.machinesHeading(hosts));
        });
    }

    it('THE ONE-MACHINE CASE IS A SENTENCE, not a list of one, because it '
        + 'is 74 of 77 projects', () => {
        expect(machinesHeading(['one'])).toEqual({
            text: 'Collected from one machine.', known: true,
        });
    });

    it('an ABSENT host list is `known: false`, so the caller renders a '
        + 'could-not-evaluate rather than an empty section', () => {
        expect(machinesHeading(undefined).known).toBe(false);
        expect(machinesHeading([]).known).toBe(false);
    });

    it('machineRows agrees, and a host with no member row is LISTED and '
        + 'unlinked rather than dropped', () => {
        const row = {
            hosts: ['one', 'two', 'three'],
            members: [
                { host_id: 1, host_display_name: 'one', transcript_count: 4 },
                { host_id: null, host_display_name: 'two', transcript_count: 6 },
            ],
        };
        expect(machineRows(row)).toEqual(Info.machineRows(row));
        expect(machineRows(row).map((m) => m.linkable)).toEqual([true, false, false]);
        expect(machineRows(row)).toHaveLength(3);
    });

    it('infoField marks an absence rather than rendering a blank. NO '
        + 'VANILLA COUNTERPART: `field()` built a DOM node and this is the '
        + 'model behind it', () => {
        expect(infoField('Slug', null, 'NOT KNOWN - none reported'))
            .toEqual({ term: 'Slug', value: 'NOT KNOWN - none reported', known: false });
        expect(infoField('Slug', '-x', 'unused').known).toBe(true);
        expect(infoField('Slug', '', 'absent').known).toBe(false);
    });
});
