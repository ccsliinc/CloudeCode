/**
 * A NAME RENDERS ON TWO MATCH KINDS AND ON NO OTHERS.
 *
 * @vitest-environment jsdom
 *
 * WHAT IS BEING GUARDED. `GET /archive/projects` now carries the app
 * database's name for a project beside the archive's own. It resolves 73
 * of 100 slugs on this install; the other 27 legitimately do not
 * resolve, and the server says WHY in `app_name_source` rather than
 * sending an empty string. Three of its five values are refusals and
 * they mean three different things:
 *
 *     none               the index was read and nothing matched
 *     ambiguous          two projects at different real directories
 *                        produce this one slug
 *     cannot_determine   the app database could not be read at all
 *
 * A UI THAT TREATS ALL THREE AS "NO NAME" AND INVENTS ONE UNDOES THE
 * ENTIRE POINT of the server's ladder. That is the failure this file
 * exists to make impossible to ship: the card may draw the app's name
 * ONLY on `as_written` and `canonical_spelling`, and must fall through
 * to the path it drew before this feature existed on everything else.
 *
 * THE NEGATIVE CONTROL IS LOAD-BEARING AND IS ASSERTED FIRST. A card
 * that had simply never been wired up would pass every refusal case in
 * here perfectly, because it would draw the path in all five. So the two
 * approved kinds are asserted to actually CHANGE the face; without that,
 * this suite proves nothing at all.
 *
 * IT DRIVES THE MOUNTED COMPONENT, not `presentationFor`. The refusal
 * lives in `nav-app-name.ts` and is consumed by `nav-card.ts`, but what
 * matters to a person is what reaches the DOM, and a template is fully
 * capable of reaching past a resolved model to the raw row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import NavProjectCard from './NavProjectCard.svelte';
import { APP_NAME_SOURCES, appNameFor, isNamedSource } from './nav-app-name';
import type { NavRowData } from './nav-row';

/** The slug the card falls back to. Deliberately unmistakable. */
const SLUG = '-Users-someone-Development-a-project';

/** The name the app database would supply. Also unmistakable. */
const APP_NAME = 'A Real Project Name';

/** One project row as the merged listing returns it, before decoration. */
function rowWith(source: string | null, name: string | null = APP_NAME): NavRowData {
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
    }
    return row as unknown as NavRowData;
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

describe('THE NEGATIVE CONTROL: the two approved kinds really do change the face', () => {
    for (const source of [APP_NAME_SOURCES.AS_WRITTEN, APP_NAME_SOURCES.CANONICAL_SPELLING]) {
        it(`${source} draws the app database's name in place of the slug`, () => {
            const { label, li } = faceOf(rowWith(source));
            expect(label).toBe(APP_NAME);
            expect(label).not.toContain(SLUG);
            expect(li.getAttribute('data-app-named')).toBe('true');
            expect(li.getAttribute('data-app-name-source')).toBe(source);
        });
    }
});

describe('EVERY OTHER SOURCE RENDERS THE PATH, UNCHANGED', () => {
    const refused = [
        APP_NAME_SOURCES.NONE,
        APP_NAME_SOURCES.AMBIGUOUS,
        APP_NAME_SOURCES.CANNOT_DETERMINE,
    ];
    for (const source of refused) {
        it(`${source} does NOT draw a name, even though one was sent`, () => {
            const { label, li } = faceOf(rowWith(source));
            expect(label).toBe(SLUG);
            expect(label).not.toContain(APP_NAME);
            expect(li.getAttribute('data-app-named')).toBe(null);
            // The rung is still ON the element. A refusal that erased its
            // own reason would leave 27 cards saying nothing about why.
            expect(li.getAttribute('data-app-name-source')).toBe(source);
        });
    }

    it('a source nobody has heard of is a refusal, not a pass. A sixth '
        + 'value added to the server tomorrow must not be able to render a '
        + 'name here before anybody has decided it may', () => {
        const { label } = faceOf(rowWith('some_future_rung'));
        expect(label).toBe(SLUG);
    });

    it('an APPROVED kind with a blank name still refuses, because an empty '
        + 'label where a path used to be reads as a bug in the rail rather '
        + 'than as a bug in the join', () => {
        expect(faceOf(rowWith(APP_NAME_SOURCES.AS_WRITTEN, '')).label).toBe(SLUG);
        expect(faceOf(rowWith(APP_NAME_SOURCES.AS_WRITTEN, null)).label).toBe(SLUG);
    });

    it('a row from a server that sends none of these fields is untouched, '
        + 'which is what every older install is', () => {
        const { label, li } = faceOf(rowWith(null));
        expect(label).toBe(SLUG);
        expect(li.getAttribute('data-app-name-source')).toBe(null);
    });
});

describe('THE DESCRIPTION RIDES THE SAME GATE as the name it belongs to', () => {
    it('a refused row exposes no description, because a description is a '
        + 'claim about a project row we just declined to name', () => {
        for (const source of ['none', 'ambiguous', 'cannot_determine']) {
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
    it('exactly two kinds are approved', () => {
        const all = Object.values(APP_NAME_SOURCES);
        expect(all.filter(isNamedSource).sort())
            .toEqual(['as_written', 'canonical_spelling']);
        expect(all.length).toBe(5);
    });
});
