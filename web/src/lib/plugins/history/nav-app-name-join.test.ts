/**
 * THE JOIN CARRIES FIELDS AND DECIDES NOTHING.
 *
 * WHAT IS BEING GUARDED. Three routes return project nodes and only
 * `/archive/projects` is decorated with the app database's name; the two
 * the rail actually lists from carry none. `nav-app-name-join.ts` moves
 * the fields across. Everything that could make that DANGEROUS is a
 * refusal, and each one is asserted here:
 *
 *   an incomplete index changes nothing
 *   a duplicate key is dropped rather than picked between
 *   a row the SERVER already decorated is left alone
 *   nothing is mutated
 *
 * THE NEGATIVE CONTROLS ARE THE POINT. A join that always attached a
 * name would pass every positive assertion in here and would put a
 * confident, wrong project name on a card - which is strictly worse
 * than the slug it replaced. So the duplicate case, the refused-listing
 * case and the server-already-answered case are each asserted to change
 * NOTHING, and the resolver is then asked what it makes of the result,
 * because "the field arrived" and "a name is drawn" are different
 * claims.
 *
 * AND THE REFUSALS ARE ASSERTED THROUGH THE REAL RESOLVER, NOT RESTATED.
 * `nav-app-name.ts` owns which of the eight `app_name_source` values may
 * draw a name. This file does not re-implement that judgement; it joins
 * a row carrying each published value plus two unknown ones and asks
 * `appNameFor` what it decided, so a second opinion cannot creep in
 * here.
 */
import { describe, expect, it } from 'vitest';
import {
    APP_NAME_FIELDS, APP_NAME_JOIN_KEY, applyAppNames, buildAppNameIndex,
    emptyAppNameIndex, joinAppNames,
} from './nav-app-name-join';
import { APP_NAME_SOURCES, appNameFor } from './nav-app-name';
import type { EnvelopeResult } from '../types';
import type { NavRowData } from './nav-row';

/** An envelope result as the granted client returns a good answer. */
function ok(rows: unknown[]): EnvelopeResult {
    return {
        envelope: { result: rows, result_status: 'ok', meta: {} },
        httpStatus: 200, headers: null, transportError: null, refusedByGrant: false,
    } as EnvelopeResult;
}

/** The decorated route failing to answer at all. */
function dead(): EnvelopeResult {
    return {
        envelope: null, httpStatus: null, headers: null,
        transportError: 'connection refused', refusedByGrant: false,
    } as EnvelopeResult;
}

/** One decorated row off `/archive/projects`. */
function namedRow(id: number, source: string, name: string | null): NavRowData {
    return {
        project_id: id,
        full_path: `-slug-${id}`,
        app_display_name: name,
        app_name_source: source,
        app_description: 'a description',
        app_project_id: 900 + id,
        app_name_evidence: null,
        app_name_cwd: null,
        app_name_anchor_project_id: null,
    } as unknown as NavRowData;
}

/** One undecorated row, as the overlay and per-corpus routes send them. */
function bareRow(id: number): NavRowData {
    return {
        project_id: id, full_path: `-slug-${id}`, transcript_count: 7,
    } as unknown as NavRowData;
}

describe('THE POSITIVE CASE, asserted first so the controls below mean something', () => {
    it('carries every app-name field onto a row that had none', () => {
        const index = buildAppNameIndex(ok([namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Media')]));
        const [row] = applyAppNames([bareRow(1)], index) as Record<string, unknown>[];
        expect(index.complete).toBe(true);
        for (const field of APP_NAME_FIELDS) {
            expect(Object.prototype.hasOwnProperty.call(row!, field)).toBe(true);
        }
        expect(appNameFor(row as NavRowData).name).toBe('Media');
    });

    it('joins on project_id and on nothing else, so a row whose slug '
        + 'differs is still named and a row with a matching slug but no '
        + 'id is not', () => {
        expect(APP_NAME_JOIN_KEY).toBe('project_id');
        const index = buildAppNameIndex(ok([namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Media')]));
        const differentSlug = { project_id: 1, full_path: '-a-different-spelling' };
        const noId = { full_path: '-slug-1' };
        const out = applyAppNames(
            [differentSlug, noId] as unknown as NavRowData[], index,
        ) as Record<string, unknown>[];
        expect(out[0]!.app_display_name).toBe('Media');
        expect(out[1]!.app_display_name).toBeUndefined();
    });

    it('accepts a string project_id as readily as a number, because the '
        + 'two listings are two routes and neither promises a type', () => {
        const index = buildAppNameIndex(ok([
            { ...(namedRow(4, APP_NAME_SOURCES.AS_WRITTEN, 'Mac') as object), project_id: '4' },
        ]));
        const [row] = applyAppNames(
            [{ project_id: 4, full_path: '-slug-4' } as unknown as NavRowData], index,
        ) as Record<string, unknown>[];
        expect(row!.app_display_name).toBe('Mac');
    });
});

describe('NEGATIVE CONTROL: an index that did not measure anything changes nothing', () => {
    it('a transport failure yields an index that is NOT complete', () => {
        const index = buildAppNameIndex(dead());
        expect(index.complete).toBe(false);
        expect(index.patches.size).toBe(0);
    });

    it('a grant refusal yields an index that is NOT complete', () => {
        const index = buildAppNameIndex({
            envelope: null, httpStatus: null, headers: null,
            transportError: 'refused', refusedByGrant: true,
        } as EnvelopeResult);
        expect(index.complete).toBe(false);
    });

    it('a body whose result is not a list yields an index that is NOT '
        + 'complete, because a shape nobody can read is not a reading of '
        + 'nothing', () => {
        expect(buildAppNameIndex({
            envelope: { result: { nope: true }, result_status: 'ok' },
            httpStatus: 200, headers: null, transportError: null, refusedByGrant: false,
        } as EnvelopeResult).complete).toBe(false);
    });

    it('an incomplete index returns the SAME array, so the rail draws '
        + 'exactly what it drew before this feature existed', () => {
        const rows = [bareRow(1), bareRow(2)];
        expect(applyAppNames(rows, emptyAppNameIndex())).toBe(rows);
        expect(applyAppNames(rows, buildAppNameIndex(dead()))).toBe(rows);
    });

    it('a REAL answer of zero rows IS complete, and is not the same '
        + 'finding as a refusal', () => {
        const index = buildAppNameIndex(ok([]));
        expect(index.complete).toBe(true);
        expect(index.patches.size).toBe(0);
    });
});

describe('NEGATIVE CONTROL: a duplicate key is dropped, never picked between', () => {
    it('two decorated rows under one project_id name neither of them', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'One'),
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Two'),
        ]));
        expect(index.complete).toBe(true);
        expect(index.patches.has('1')).toBe(false);
        expect(index.duplicates).toContain('1');
        const [row] = applyAppNames([bareRow(1)], index) as Record<string, unknown>[];
        expect(row!.app_display_name).toBeUndefined();
        expect(appNameFor(row as NavRowData).name).toBe(null);
    });

    it('a THIRD row under the same key does not resurrect it', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'One'),
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Two'),
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Three'),
        ]));
        expect(index.patches.has('1')).toBe(false);
        expect(index.duplicates).toEqual(['1']);
    });

    it('a duplicate poisons ONLY its own key', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'One'),
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Two'),
            namedRow(2, APP_NAME_SOURCES.AS_WRITTEN, 'Media'),
        ]));
        const out = applyAppNames(
            [bareRow(1), bareRow(2)], index,
        ) as Record<string, unknown>[];
        expect(out[0]!.app_display_name).toBeUndefined();
        expect(out[1]!.app_display_name).toBe('Media');
    });
});

describe('NEGATIVE CONTROL: the server outranks the join', () => {
    it('a row that ALREADY carries app_name_source is left untouched, '
        + 'which is what makes this a no-op the day the overlay route '
        + 'starts decorating rather than a second opinion', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'From the join'),
        ]));
        const served = {
            project_id: 1,
            full_path: '-slug-1',
            app_name_source: APP_NAME_SOURCES.AMBIGUOUS,
            app_display_name: null,
        } as unknown as NavRowData;
        const [row] = applyAppNames([served], index);
        expect(row).toBe(served);
        expect(appNameFor(row).name).toBe(null);
        expect(appNameFor(row).source).toBe(APP_NAME_SOURCES.AMBIGUOUS);
    });

    it('a row carrying an EXPLICIT NULL app_name_source is still joined, '
        + 'because a null is a field the row happens to have and not an '
        + 'answer the server gave', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Media'),
        ]));
        const [row] = applyAppNames(
            [{ project_id: 1, app_name_source: null } as unknown as NavRowData], index,
        ) as Record<string, unknown>[];
        expect(row!.app_display_name).toBe('Media');
    });
});

describe('EVERY PUBLISHED SOURCE SURVIVES THE JOIN AS ITSELF, '
    + 'and two unknown ones do too', () => {
    const unknowns = ['a_ninth_rung_nobody_has_decided_about', '!!nonsense!!'];
    for (const source of [...Object.values(APP_NAME_SOURCES), ...unknowns]) {
        it(`${source} arrives at the resolver verbatim`, () => {
            const index = buildAppNameIndex(ok([namedRow(1, source, 'A Real Name')]));
            const [row] = applyAppNames([bareRow(1)], index);
            const app = appNameFor(row);
            // The join carries; the RESOLVER decides. Asserting the
            // decision here would be a second copy of the rule.
            expect(app.source).toBe(source);
            const approved = source === APP_NAME_SOURCES.AS_WRITTEN
                || source === APP_NAME_SOURCES.CANONICAL_SPELLING
                || source === APP_NAME_SOURCES.DERIVED_CWD;
            expect(app.named).toBe(approved);
            expect(app.name).toBe(approved ? 'A Real Name' : null);
        });
    }

    it('an approved source with a BLANK name still draws nothing, so a '
        + 'join cannot paint an empty label where a path used to be', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, ''),
        ]));
        const [row] = applyAppNames([bareRow(1)], index);
        expect(appNameFor(row).named).toBe(false);
    });
});

describe('NOTHING IS MUTATED', () => {
    it('the source row keeps the bytes the server sent', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Media'),
        ]));
        const original = bareRow(1);
        const before = JSON.stringify(original);
        const [row] = applyAppNames([original], index);
        expect(row).not.toBe(original);
        expect(JSON.stringify(original)).toBe(before);
    });

    it('joinAppNames preserves every other key of the envelope, so the '
        + 'unattributed counts and the paging meta survive a decoration', () => {
        const index = buildAppNameIndex(ok([
            namedRow(1, APP_NAME_SOURCES.AS_WRITTEN, 'Media'),
        ]));
        const listing = {
            envelope: {
                result: [bareRow(1)],
                result_status: 'partial',
                meta: { unattributed: { by_corpus: [{ corpus_id: 2, count: 5 }] } },
            },
            httpStatus: 200, headers: null, transportError: null, refusedByGrant: false,
        } as EnvelopeResult;
        const out = joinAppNames(listing, index);
        const env = out.envelope as Record<string, unknown>;
        expect(env.result_status).toBe('partial');
        expect(env.meta).toEqual(listing.envelope
            && (listing.envelope as Record<string, unknown>).meta);
        expect((env.result as Record<string, unknown>[])[0]!.app_display_name).toBe('Media');
    });

    it('joinAppNames returns the SAME result object when nothing changed, '
        + 'so a refused decoration costs the caller nothing at all', () => {
        const listing = ok([bareRow(1)]);
        expect(joinAppNames(listing, emptyAppNameIndex())).toBe(listing);
        expect(joinAppNames(dead(), buildAppNameIndex(ok([])))).toBeTruthy();
    });
});
