/**
 * A NAME RENDERS ON THREE MATCH KINDS AND ON NO OTHERS.
 *
 * @vitest-environment jsdom
 *
 * WHAT IS BEING GUARDED. `GET /archive/projects` carries the app
 * database's name for a project beside the archive's own, and
 * `app_name_source` says how it was matched. The vocabulary has EIGHT
 * values now that a second rung reports into the same field, and only
 * three of them may put a name on a card:
 *
 *     as_written         a project row's folder slugifies to this slug
 *     canonical_spelling it matched once the spelling was resolved
 *     derived_cwd        NO project row matches, so the name was
 *                        COMPOSED from the working directory the
 *                        transcripts recorded
 *
 * THE SERVER DID NOT WIDEN ITS OWN NAMED SET, AND THAT IS THE POINT OF
 * THIS FILE. `MATCH_KINDS_NAMED` on the server is still two values, so
 * a client that was never updated keeps drawing paths for the new
 * rungs; `MATCH_KINDS_NAMED_WITH_DERIVED` is the opt-in and this client
 * has taken it. Opting in is a decision, so it is asserted here as one:
 * exactly three, named individually, with every other published value
 * proven to refuse.
 *
 * FOUR OF THE OTHER FIVE ARE REFUSALS AND THEY MEAN FOUR DIFFERENT
 * THINGS:
 *
 *     none               the index was read and nothing matched
 *     ambiguous          two projects at different real directories
 *                        produce this one slug
 *     cwd_conflict       two different real directories were recorded
 *                        under this one slug
 *     cannot_determine   the app database could not be read at all
 *
 * A UI THAT TREATS THEM AS "NO NAME" AND INVENTS ONE UNDOES THE ENTIRE
 * POINT of the server's ladder. That is the failure this file exists to
 * make impossible to ship.
 *
 * THE FIFTH IS NOT A REFUSAL AND MUST NOT BE TESTED AS ONE.
 * `scratch_path` is a MEASURED namelessness - the server read a real
 * working directory and it was a per-run temp directory. It draws
 * neither a name nor a path but `scratch / <leaf>`, and the assertions
 * below pin all three halves of that: it is not the app's name, it is
 * not the slug, and `data-app-named` stays off it.
 *
 * THE NEGATIVE CONTROL IS LOAD-BEARING AND IS ASSERTED FIRST. A card
 * that had simply never been wired up would pass every refusal case in
 * here perfectly, because it would draw the path in all of them. So the
 * three approved kinds are asserted to actually CHANGE the face;
 * without that, this suite proves nothing at all.
 *
 * AND THE UNKNOWN VALUES ARE THE SECOND CONTROL. The vocabulary has
 * grown once already, from five values to eight. A NINTH added to the
 * server tomorrow must not be able to render a name here before anybody
 * has decided it may, and it must not be able to render as scratch
 * either - a plausible-looking future rung is tested beside an obvious
 * nonsense one, because the gate must be a membership test and not a
 * shape test.
 *
 * IT DRIVES THE MOUNTED COMPONENT, not `presentationFor`. The refusal
 * lives in `nav-app-name.ts` and is consumed by `nav-card.ts`, but what
 * matters to a person is what reaches the DOM, and a template is fully
 * capable of reaching past a resolved model to the raw row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import NavProjectCard from './NavProjectCard.svelte';
import { APP_NAME_SOURCES, appNameFor, isNamedSource, isScratchSource } from './nav-app-name';
import { SCRATCH_QUALIFIER } from './nav-scratch-label';
import type { NavRowData } from './nav-row';

/** The slug the card falls back to. Deliberately unmistakable. */
const SLUG = '-Users-someone-Development-a-project';

/** The name the app database would supply. Also unmistakable. */
const APP_NAME = 'A Real Project Name';

/** A real scratch directory, shortened from one of the 17 on this install. */
const SCRATCH_CWD = '/private/var/folders/p6/2fx4wn854s19lksf30bgv6rh0000gn/T/cc_rht_work_ko0irget';

/** The leaf that directory is told apart by. */
const SCRATCH_LEAF = 'cc_rht_work_ko0irget';

/** Every value the server publishes. A mirror of `MATCH_KINDS`. */
const PUBLISHED = Object.values(APP_NAME_SOURCES);

/** One project row as the merged listing returns it, before decoration. */
function rowWith(
    source: string | null,
    name: string | null = APP_NAME,
    extra: Record<string, unknown> = {},
): NavRowData {
    const row: Record<string, unknown> = {
        project_id: 5,
        display_name: null,
        full_path: SLUG,
        transcript_count: 262,
        session_count: 4,
        session_counted: true,
        activity_status: 'known',
        newest_activity_at: '2026-09-16T00:00:00Z',
    };
    if (source !== null) {
        row.app_name_source = source;
        row.app_display_name = name;
        row.app_description = 'a description that must not leak past a refusal';
        row.app_project_id = 42;
        // Declared null on every node by the server, so the fixture
        // shape matches even on the rungs that do not fill them.
        row.app_name_evidence = null;
        row.app_name_cwd = null;
        row.app_name_anchor_project_id = null;
    }
    return { ...row, ...extra } as unknown as NavRowData;
}

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** Mount one card and hand back the text its label actually carries. */
function faceOf(row: NavRowData): { label: string; li: HTMLElement } {
    host = document.createElement('ul');
    document.body.appendChild(host);
    mounted = mount(NavProjectCard, { target: host, props: { row } }) as
        unknown as Record<string, unknown>;
    const li = host.querySelector('li');
    if (!li) throw new Error('the card did not render an li, so nothing was measured');
    const label = li.querySelector('.archive-nav__label');
    if (!label) throw new Error('the card rendered no label, so nothing was measured');
    return { label: (label.textContent || '').trim(), li: li as HTMLElement };
}

describe('THE NEGATIVE CONTROL: the three approved kinds really do change the face', () => {
    const approved = [
        APP_NAME_SOURCES.AS_WRITTEN,
        APP_NAME_SOURCES.CANONICAL_SPELLING,
        APP_NAME_SOURCES.DERIVED_CWD,
    ];
    for (const source of approved) {
        it(`${source} draws the app database's name in place of the slug`, () => {
            const { label, li } = faceOf(rowWith(source));
            expect(label).toBe(APP_NAME);
            expect(label).not.toContain(SLUG);
            expect(li.getAttribute('data-app-named')).toBe('true');
            expect(li.getAttribute('data-app-name-source')).toBe(source);
            expect(li.getAttribute('data-app-scratch')).toBe(null);
        });
    }

    it('a derived name carries its evidence and its anchor onto the card '
        + 'without either being mistaken for the project id, because a client '
        + 'that navigated on the anchor would open the containing project '
        + 'instead of this folder', () => {
        const app = appNameFor(rowWith(APP_NAME_SOURCES.DERIVED_CWD, 'Production / tools/x', {
            app_name_evidence: 'cwd_leaf_match',
            app_name_cwd: '/Users/someone/Development/Production/tools/x',
            app_name_anchor_project_id: 7,
        }));
        expect(app.named).toBe(true);
        expect(app.evidence).toBe('cwd_leaf_match');
        expect(app.anchorProjectId).toBe(7);
        expect(app.projectId).toBe(42);
    });
});

describe('EVERY REFUSING SOURCE RENDERS THE PATH, UNCHANGED', () => {
    const refused = [
        APP_NAME_SOURCES.NONE,
        APP_NAME_SOURCES.AMBIGUOUS,
        APP_NAME_SOURCES.CWD_CONFLICT,
        APP_NAME_SOURCES.CANNOT_DETERMINE,
    ];
    for (const source of refused) {
        it(`${source} does NOT draw a name, even though one was sent`, () => {
            const { label, li } = faceOf(rowWith(source));
            expect(label).toBe(SLUG);
            expect(label).not.toContain(APP_NAME);
            expect(li.getAttribute('data-app-named')).toBe(null);
            expect(li.getAttribute('data-app-scratch')).toBe(null);
            // The rung is still ON the element. A refusal that erased its
            // own reason would leave those cards saying nothing about why.
            expect(li.getAttribute('data-app-name-source')).toBe(source);
        });
    }

    it('cwd_conflict keeps its OWN sentence and is never collapsed into '
        + 'ambiguous, because the two name different layers failing to '
        + 'decide and a reader is entitled to know which', () => {
        const conflict = appNameFor(rowWith(APP_NAME_SOURCES.CWD_CONFLICT)).refusal;
        const ambiguous = appNameFor(rowWith(APP_NAME_SOURCES.AMBIGUOUS)).refusal;
        expect(conflict).not.toBe('');
        expect(ambiguous).not.toBe('');
        expect(conflict).not.toBe(ambiguous);
    });

    const unknown = ['some_future_rung', 'derived_parent', 'x'];
    for (const source of unknown) {
        it(`a ninth value nobody has heard of ("${source}") is a refusal, not `
            + 'a pass. It may render neither a name nor the scratch treatment', () => {
            const { label, li } = faceOf(rowWith(source, APP_NAME, {
                app_name_cwd: SCRATCH_CWD,
            }));
            expect(label).toBe(SLUG);
            expect(li.getAttribute('data-app-named')).toBe(null);
            expect(li.getAttribute('data-app-scratch')).toBe(null);
            expect(isNamedSource(source)).toBe(false);
            expect(isScratchSource(source)).toBe(false);
        });
    }

    it('an APPROVED kind with a blank name still refuses, because an empty '
        + 'label where a path used to be reads as a bug in the rail rather '
        + 'than as a bug in the join', () => {
        for (const source of [APP_NAME_SOURCES.AS_WRITTEN, APP_NAME_SOURCES.DERIVED_CWD]) {
            expect(faceOf(rowWith(source, '')).label).toBe(SLUG);
            expect(faceOf(rowWith(source, null)).label).toBe(SLUG);
        }
    });

    it('a row from a server that sends none of these fields is untouched, '
        + 'which is what every older install is', () => {
        const { label, li } = faceOf(rowWith(null));
        expect(label).toBe(SLUG);
        expect(li.getAttribute('data-app-name-source')).toBe(null);
        expect(li.getAttribute('data-app-scratch')).toBe(null);
    });
});

describe('A SCRATCH ROW DRAWS NEITHER A NAME NOR A PATH', () => {
    const row = () => rowWith(APP_NAME_SOURCES.SCRATCH_PATH, null, {
        app_name_cwd: SCRATCH_CWD,
    });

    it('it says it is scratch, and says which one, in that order', () => {
        const { label, li } = faceOf(row());
        expect(label).toBe(`${SCRATCH_QUALIFIER} / ${SCRATCH_LEAF}`);
        expect(label.startsWith(SCRATCH_QUALIFIER)).toBe(true);
        expect(li.getAttribute('data-app-scratch')).toBe('true');
        expect(li.getAttribute('data-app-name-source'))
            .toBe(APP_NAME_SOURCES.SCRATCH_PATH);
    });

    it('it is NOT counted as named, so nothing that asks how many projects '
        + 'this rail has a name for gets a different answer than before', () => {
        const { li } = faceOf(row());
        expect(li.getAttribute('data-app-named')).toBe(null);
        expect(appNameFor(row()).named).toBe(false);
        expect(appNameFor(row()).name).toBe(null);
        expect(appNameFor(row()).scratch).toBe(true);
    });

    it('the 90 character path is NOT on the face, which is the whole reason '
        + 'this treatment exists', () => {
        expect(faceOf(row()).label).not.toContain('/private/var');
        expect(faceOf(row()).label).not.toContain(SLUG);
        expect(faceOf(row()).label.length).toBeLessThan(SCRATCH_CWD.length / 2);
    });

    it('and it stays reachable on the hover sentence, which is the licence '
        + 'for shortening it in the first place', () => {
        const { li } = faceOf(row());
        const face = li.querySelector('[data-action="select"]');
        expect(face?.getAttribute('title') || '').toContain(SCRATCH_CWD);
    });

    it('a scratch row the server sent no directory for degrades to the bare '
        + 'word rather than to the path, because the leaf is a '
        + 'disambiguator and not a name', () => {
        expect(faceOf(rowWith(APP_NAME_SOURCES.SCRATCH_PATH, null)).label)
            .toBe(SCRATCH_QUALIFIER);
    });

    it('a name sent alongside scratch_path is still refused. The server does '
        + 'not do that today, and a client that trusted it to keep not doing '
        + 'it would be trusting an absence', () => {
        const { label, li } = faceOf(rowWith(APP_NAME_SOURCES.SCRATCH_PATH, APP_NAME, {
            app_name_cwd: SCRATCH_CWD,
        }));
        expect(label).not.toContain(APP_NAME);
        expect(li.getAttribute('data-app-named')).toBe(null);
    });
});

describe('THE DESCRIPTION RIDES THE SAME GATE as the name it belongs to', () => {
    it('a refused row exposes no description, because a description is a '
        + 'claim about a project row we just declined to name', () => {
        const refusing = PUBLISHED.filter((s) => !isNamedSource(s));
        expect(refusing.length).toBe(5);
        for (const source of refusing) {
            expect(appNameFor(rowWith(source)).description).toBe(null);
        }
    });

    it('an approved row carries it, and the card puts it on the hover '
        + 'sentence where it costs no height', () => {
        const app = appNameFor(rowWith(APP_NAME_SOURCES.AS_WRITTEN));
        expect(app.description).toContain('a description');
        const { li } = faceOf(rowWith(APP_NAME_SOURCES.AS_WRITTEN));
        const face = li.querySelector('[data-action="select"]');
        expect(face?.getAttribute('title') || '').toContain('a description');
    });
});

describe('the approved set is one list, and it is short', () => {
    it('exactly three kinds are approved, and they are named individually '
        + 'rather than counted, so widening the gate to "any non-empty '
        + 'string" fails here rather than shipping', () => {
        expect(PUBLISHED.filter(isNamedSource).sort())
            .toEqual(['as_written', 'canonical_spelling', 'derived_cwd']);
        expect(PUBLISHED.length).toBe(8);
    });

    it('exactly one kind is scratch', () => {
        expect(PUBLISHED.filter(isScratchSource)).toEqual(['scratch_path']);
    });

    it('nothing is both named and scratch, on any published value or on an '
        + 'unknown one', () => {
        for (const source of [...PUBLISHED, 'a_ninth_value', '']) {
            expect(isNamedSource(source) && isScratchSource(source)).toBe(false);
        }
    });
});
