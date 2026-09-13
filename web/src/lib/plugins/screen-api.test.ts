/**
 * THE GRANTED CLIENT, AND THE NEGATIVE CONTROL IS THE WHOLE POINT OF
 * THIS FILE.
 *
 * A suite that only proved the granted paths work would pass identically
 * against NO ENFORCEMENT AT ALL. So the assertions that matter here are
 * the ones about what does NOT happen: the request is not sent, the
 * refusal is not a 404, and the two are distinguishable by a caller that
 * catches rather than by one that reads a message.
 *
 * EVERY REFUSAL CASE IS PAIRED WITH A POSITIVE CONTROL. `/archive/x`
 * passing beside `/archived-thing` failing is what proves the second
 * failure is about containment and not about the client being broken.
 */
import { describe, expect, test, vi } from 'vitest';
import { createScreenApi, GrantRefusedError, normalisePath,
         resolveApiPath, withinGrant } from './screen-api';

/** A transport that records what it was asked for and resolves a marker. */
function recording() {
    const sent: string[] = [];
    const transport = (path: string) => { sent.push(path); return Promise.resolve('SENT'); };
    return { sent, transport };
}

describe('the happy path, so a refusal below means containment', () => {
    test('a granted path is sent, resolved against /api/v1', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        await expect(api.call('/archive/projects')).resolves.toBe('SENT');
        expect(sent).toEqual(['/api/v1/archive/projects']);
    });

    test('a grant covers itself, not only its children', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/features'], transport, 'history');
        await expect(api.call('/features')).resolves.toBe('SENT');
        expect(sent).toEqual(['/api/v1/features']);
    });

    test('several grants all hold at once', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive', '/features'], transport, 'history');
        await api.call('/archive/hosts');
        await api.call('/features');
        expect(sent).toEqual(['/api/v1/archive/hosts', '/api/v1/features']);
    });

    test('a path already carrying the base is not double-prefixed', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        await api.call('/api/v1/archive/hosts');
        expect(sent).toEqual(['/api/v1/archive/hosts']);
    });

    test('the grants are readable, and a copy', () => {
        const api = createScreenApi(['/archive'], recording().transport, 'history');
        expect(Array.from(api.grants)).toEqual(['/archive']);
        (api.grants as string[]).push('/sessions');
        const again = createScreenApi(['/archive'], recording().transport, 'h');
        expect(Array.from(again.grants)).toEqual(['/archive']);
    });
});

describe('THE NEGATIVE CONTROL: a call outside the grant is refused', () => {
    test('the request is NOT SENT, which is the claim that matters', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(api.call('/sessions/respawn')).rejects.toBeInstanceOf(GrantRefusedError);
        err.mockRestore();
        // If enforcement were absent this array would hold the path, and
        // every other assertion in this file would still pass.
        expect(sent, 'the refused call reached the transport').toEqual([]);
    });

    test('the refusal is DISTINGUISHABLE FROM A 404, by shape not by wording', async () => {
        // A 404 RESOLVES, carrying a status. A refusal REJECTS, carrying
        // a name, the path and the grants. A caller that only writes
        // `.catch()` can still tell them apart, which is the whole
        // requirement: a 404 from a capability check sends the person
        // debugging it into the wrong half of the application.
        const notFound = (path: string) =>
            Promise.resolve({ httpStatus: 404, path, envelope: null });
        const api = createScreenApi(['/archive'], notFound, 'history');

        const four04 = await api.call('/archive/nope') as { httpStatus: number };
        expect(four04.httpStatus).toBe(404);

        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        let refusal: unknown = null;
        try {
            await api.call('/sessions/respawn');
        } catch (e) {
            refusal = e;
        }
        err.mockRestore();

        expect(refusal).toBeInstanceOf(GrantRefusedError);
        const g = refusal as GrantRefusedError;
        // Three facts a caller can branch on without parsing prose.
        expect(g.name).toBe('GrantRefusedError');
        expect(g.path).toBe('/api/v1/sessions/respawn');
        expect(Array.from(g.grants)).toEqual(['/archive']);
        // And it is an Error, so an existing `catch` still catches it.
        expect(g).toBeInstanceOf(Error);
        // The 404 is not an Error at all, so the two cannot be confused.
        expect(four04).not.toBeInstanceOf(Error);
    });

    test('the refusal is LOGGED as well as thrown', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const api = createScreenApi(['/archive'], recording().transport, 'history');
        await api.call('/sessions/respawn').catch(() => {});
        expect(err).toHaveBeenCalledTimes(1);
        const line = String(err.mock.calls[0]?.[0] ?? '');
        err.mockRestore();
        // A silent refusal is the failure this mechanism exists not to
        // reproduce one layer up, so the log names the screen, the path
        // and the fact that it is not a 404.
        expect(line).toContain('history');
        expect(line).toContain('/api/v1/sessions/respawn');
        expect(line).toContain('not a 404');
    });
});

describe('containment is COMPONENT-WISE, never startsWith', () => {
    test('a grant for /archive refuses /archived-thing', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(api.call('/archived-thing')).rejects.toBeInstanceOf(GrantRefusedError);
        err.mockRestore();
        expect(sent).toEqual([]);
        // POSITIVE CONTROL beside it: the client is not simply broken.
        await expect(api.call('/archive')).resolves.toBe('SENT');
    });

    test('a grant for /archive refuses /archive/../sessions/respawn', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        let caught: unknown = null;
        try {
            await api.call('/archive/../sessions/respawn');
        } catch (e) {
            caught = e;
        }
        err.mockRestore();
        expect(caught).toBeInstanceOf(GrantRefusedError);
        expect(sent).toEqual([]);
        // The path in the refusal is the NORMALISED one, so the log says
        // where the call would actually have gone rather than repeating
        // the disguise it arrived in.
        expect((caught as GrantRefusedError).path).toBe('/api/v1/sessions/respawn');
    });

    test('a deeper traversal, and one that climbs past the root, both refuse', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const path of ['/archive/a/../../sessions/respawn',
                            '/archive/./../sessions/respawn',
                            '/../../../etc/passwd',
                            '/archive/../../../../sessions/respawn']) {
            await expect(api.call(path), path).rejects.toBeInstanceOf(GrantRefusedError);
        }
        err.mockRestore();
        expect(sent).toEqual([]);
    });

    test('a traversal that stays INSIDE the grant still passes', async () => {
        // POSITIVE CONTROL for the normaliser: it must resolve `..`, not
        // refuse everything containing one, or the refusals above would
        // prove nothing about containment.
        const { sent, transport } = recording();
        const api = createScreenApi(['/archive'], transport, 'history');
        await expect(api.call('/archive/hosts/../projects')).resolves.toBe('SENT');
        expect(sent).toEqual(['/api/v1/archive/projects']);
    });

    test('an EMPTY grant refuses everything', async () => {
        const { sent, transport } = recording();
        const api = createScreenApi([], transport, 'silent');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(api.call('/archive')).rejects.toBeInstanceOf(GrantRefusedError);
        await expect(api.call('/features')).rejects.toBeInstanceOf(GrantRefusedError);
        err.mockRestore();
        expect(sent).toEqual([]);
    });
});

describe('the two helpers, measured directly', () => {
    test('normalisePath resolves . and .. and drops a climb past the root', () => {
        expect(normalisePath('/api/v1/archive/../sessions')).toBe('/api/v1/sessions');
        expect(normalisePath('/a/./b')).toBe('/a/b');
        expect(normalisePath('/a/b/../../../../c')).toBe('/c');
        expect(normalisePath('/a//b/')).toBe('/a/b');
        expect(normalisePath('')).toBe('/');
    });

    test('withinGrant compares whole segments', () => {
        expect(withinGrant('/api/v1/archive', '/api/v1/archive')).toBe(true);
        expect(withinGrant('/api/v1/archive/x', '/api/v1/archive')).toBe(true);
        expect(withinGrant('/api/v1/archived-thing', '/api/v1/archive')).toBe(false);
        expect(withinGrant('/api/v1/arch', '/api/v1/archive')).toBe(false);
        expect(withinGrant('/api/v1/archive', '/api/v1/archive/x')).toBe(false);
        // An empty grant contains nothing, including the root.
        expect(withinGrant('/api/v1/archive', '')).toBe(false);
    });

    test('resolveApiPath is idempotent and always absolute', () => {
        expect(resolveApiPath('/archive')).toBe('/api/v1/archive');
        expect(resolveApiPath('archive')).toBe('/api/v1/archive');
        expect(resolveApiPath('/api/v1/archive')).toBe('/api/v1/archive');
        expect(resolveApiPath(resolveApiPath('/archive'))).toBe('/api/v1/archive');
        expect(resolveApiPath(undefined as unknown as string)).toBe('/api/v1');
    });
});
