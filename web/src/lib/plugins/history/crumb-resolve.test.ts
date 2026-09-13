/**
 * Naming a project nobody clicked. PORTED from
 * `tests/test_archive_crumb_resolve.node.mjs`, deleted in the same
 * commit, case for case.
 *
 * ONE ASSERTION CHANGED AND THE CASE IS KEPT, which is the rule 8.3 of
 * the scope sets. The original built its double as
 * `{listArchiveMergedProjects()}` because the subject took `window.API`;
 * the subject now takes the GRANTED client, so the double is
 * `{call(path)}` and the test additionally asserts WHICH path is asked
 * for. That is strictly more than the original proved, and it is the
 * assertion the port could not avoid moving.
 */
import { describe, expect, test } from 'vitest';
import { createResolver } from './crumb-resolve';
import { hasNumericId, indexNodes, projectSegment, PROJECT_UNKNOWN,
         type ProjectNode } from './crumb';
import type { ScreenApi } from '../types';

/** The two-machine node: representative id 7, folded-up member id 42. */
const DUAL: ProjectNode = {
    project_id: 7, display_name: 'Media', full_path: '-Users-j-Media',
    members: [{ project_id: 7 }, { project_id: 42 }],
};

/** A single-machine node. */
const SOLO: ProjectNode = {
    project_id: 3, display_name: 'Infrastructure', full_path: '-Users-j-Infra',
    members: [{ project_id: 3 }],
};

/** A healthy envelope carrying the given nodes. */
function okEnvelope(nodes: ProjectNode[]): unknown {
    return { httpStatus: 200, transportError: null,
             envelope: { result: nodes, result_status: 'ok', meta: {} } };
}

/** A granted client whose one call resolves to a given envelope result. */
function apiReturning(result: unknown, seen?: string[]): ScreenApi {
    return {
        grants: ['/archive'],
        call: (path: string) => { seen?.push(path); return Promise.resolve(result); },
    };
}

test('every member id resolves, not just the representative', () => {
    const index = indexNodes([DUAL, SOLO]);
    // 3 ids across 2 nodes - the fold must not strand id 42.
    expect(Object.keys(index).length).toBe(3);
    expect(index['7']).toBe(DUAL);
    expect(index['42']).toBe(DUAL);
    expect(index['3']).toBe(SOLO);
});

test('a deep link to a FOLDED member id renders a name, not NOT NAMED YET', async () => {
    // This is the exact live case: 3 of 80 ids sit only in `members`,
    // and they are the 3 cross-machine projects - the worst possible
    // sample to be silently wrong about.
    const r = await createResolver(apiReturning(okEnvelope([DUAL, SOLO]))).resolve(42);
    expect(r.status).toBe('name');
    const seg = projectSegment(r.node);
    expect(seg.text).toBe('Media');
    expect(seg.kind).toBe('name');
    expect(seg.text).not.toBe(PROJECT_UNKNOWN);
    expect(hasNumericId([seg.text]), 'no database id may reach a crumb').toBe(false);
});

test('it asks the merged overlay route, and only that route', async () => {
    const seen: string[] = [];
    await createResolver(apiReturning(okEnvelope([DUAL]), seen)).resolve(7);
    expect(seen).toEqual(['/archive/overlay/projects']);
});

test('an unreadable list is cannot_determine, never a name', async () => {
    for (const bad of [
        { httpStatus: 0, transportError: 'network died', envelope: null },
        { httpStatus: 500, transportError: null, envelope: null },
        { httpStatus: 200, transportError: null,
          envelope: { result: [], result_status: 'datastore_unreadable', meta: {} } },
        { httpStatus: 200, transportError: null,
          envelope: { result: null, result_status: 'ok', meta: {} } },
    ]) {
        const r = await createResolver(apiReturning(bad)).resolve(42);
        expect(r.status).toBe('cannot_determine');
        expect(r.node, 'a failed read must never invent a name').toBeNull();
    }
});

test('a thrown request is cannot_determine rather than an unhandled rejection', async () => {
    const api: ScreenApi = {
        grants: ['/archive'],
        call: () => { throw new Error('boom'); },
    };
    const r = await createResolver(api).resolve(42);
    expect(r.status).toBe('cannot_determine');
    expect(r.node).toBeNull();
});

test('a GRANT REFUSAL is cannot_determine, not a name', async () => {
    // NEW CASE, and it is the one the granted client made possible. A
    // refusal is a reason the list could not be read; it must land in
    // the same honest outcome as a dead network, never in a name.
    const api: ScreenApi = {
        grants: [],
        call: () => Promise.reject(new Error('refused by the grant')),
    };
    const r = await createResolver(api).resolve(42);
    expect(r.status).toBe('cannot_determine');
    expect(r.node).toBeNull();
});

test('an id genuinely absent is unresolved, and distinct from unreadable', async () => {
    // The three-outcome rule: "the list does not contain this" and "I
    // could not read the list" are different findings, and only one of
    // them means the id is wrong.
    const r = await createResolver(apiReturning(okEnvelope([DUAL, SOLO]))).resolve(999);
    expect(r.status).toBe('unresolved');
    expect(r.node).toBeNull();
});

test('an empty-but-ok list is unresolved, not cannot_determine', async () => {
    const r = await createResolver(apiReturning(okEnvelope([]))).resolve(42);
    expect(r.status).toBe('unresolved');
});

test('the merged list is fetched ONCE across many lookups', async () => {
    let calls = 0;
    const api: ScreenApi = {
        grants: ['/archive'],
        call: () => { calls++; return Promise.resolve(okEnvelope([DUAL, SOLO])); },
    };
    const r = createResolver(api);
    await Promise.all([r.resolve(7), r.resolve(42), r.resolve(3), r.resolve(999)]);
    expect(calls, 'a rail-sized request must not run once per crumb').toBe(1);
});

test('a FAILED read is not cached, so the next navigation retries', async () => {
    // One bad minute must not poison the tab for its lifetime.
    let calls = 0;
    const api: ScreenApi = {
        grants: ['/archive'],
        call: () => {
            calls++;
            return Promise.resolve(calls === 1
                ? { httpStatus: 0, transportError: 'down', envelope: null }
                : okEnvelope([DUAL, SOLO]));
        },
    };
    const r = createResolver(api);
    expect((await r.resolve(42)).status).toBe('cannot_determine');
    expect((await r.resolve(42)).status).toBe('name');
    expect(calls).toBe(2);
});

describe('a null id never reaches the network', () => {
    test('resolve(null) is unresolved without a call', async () => {
        let calls = 0;
        const api: ScreenApi = {
            grants: ['/archive'],
            call: () => { calls++; return Promise.resolve(okEnvelope([])); },
        };
        const r = await createResolver(api).resolve(null);
        expect(r.status).toBe('unresolved');
        expect(calls).toBe(0);
    });
});
