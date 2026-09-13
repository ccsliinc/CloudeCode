/**
 * THE BASE COMES OFF EXACTLY ONCE, AND THIS FILE EXISTS BECAUSE IT DID
 * NOT.
 *
 * The first draft of slice 1 handed the legacy client the RESOLVED
 * absolute path, so `/features` went out as `/api/v1/api/v1/features`,
 * 404'd, and the archive's availability probe answered `unknown` on a
 * server that reports `enabled`. The visible symptom was the header's
 * archive button never appearing.
 *
 * NOT ONE UNIT TEST SAW IT, AND THAT IS THE LESSON WORTH KEEPING. Every
 * suite around the granted client passed it a recording transport and
 * asserted the path it was ASKED FOR. That assertion was right and
 * stayed right; the defect was in what the REAL client then did with
 * that path, which a recorder cannot have an opinion about. It was found
 * by driving the real page against a real server.
 *
 * So the case below is deliberately about the JOIN rather than about
 * either side of it: what the legacy client actually RECEIVES, given
 * what `ScreenApi` actually SENDS. Its double stands in for `api.js`
 * only in that it records - the path it records is the real one, because
 * it is reached through the real `createScreenApi` and the real
 * adapter, with nothing in between mocked.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { legacyApiTransport, stripApiBase } from './api-transport';
import { createScreenApi } from './screen-api';

/** Install a recording double of `window.API` and hand back its log. */
function installLegacyApi(): string[] {
    const seen: string[] = [];
    (globalThis as Record<string, unknown>).API = {
        call: (path: string) => { seen.push(path); return Promise.resolve({ ok: true }); },
    };
    return seen;
}

afterEach(() => { delete (globalThis as Record<string, unknown>).API; });

test('stripApiBase removes exactly one base, and mangles nothing else', () => {
    expect(stripApiBase('/api/v1/features')).toBe('/features');
    expect(stripApiBase('/api/v1/archive/hosts')).toBe('/archive/hosts');
    expect(stripApiBase('/api/v1')).toBe('/');
    // NOT a second strip: a route that genuinely contains the segments
    // again keeps them.
    expect(stripApiBase('/api/v1/api/v1/features')).toBe('/api/v1/features');
    // A path that does not carry the base is returned UNCHANGED rather
    // than rewritten into something that might work.
    expect(stripApiBase('/features')).toBe('/features');
    expect(stripApiBase('')).toBe('');
});

test('THE REGRESSION: the legacy client receives the path RELATIVE to /api/v1', async () => {
    // This is the whole file. `api.js` prepends its own /api/v1, so what
    // it receives here plus that base must be the path that was granted -
    // not that path with the base on twice.
    const seen = installLegacyApi();
    const api = createScreenApi(['/archive', '/features'], legacyApiTransport(), 'history');

    await api.call('/features');
    await api.call('/archive/hosts');

    expect(seen, 'the legacy client was handed an already-based path, so every '
                 + 'request would 404').toEqual(['/features', '/archive/hosts']);
    for (const path of seen) {
        expect(path.startsWith('/api/v1'),
               `"${path}" still carries the base; api.js will prepend it again`)
            .toBe(false);
    }
});

test('a path written WITH the base by the caller arrives the same way', async () => {
    // `ScreenApi` accepts both spellings and normalises them, so the
    // adapter must land on one answer whichever the caller used.
    const seen = installLegacyApi();
    const api = createScreenApi(['/archive'], legacyApiTransport(), 'history');
    await api.call('/api/v1/archive/hosts');
    await api.call('/archive/hosts');
    expect(seen).toEqual(['/archive/hosts', '/archive/hosts']);
});

test('a traversal that stays in the grant arrives NORMALISED', async () => {
    const seen = installLegacyApi();
    const api = createScreenApi(['/archive'], legacyApiTransport(), 'history');
    await api.call('/archive/hosts/../projects');
    expect(seen).toEqual(['/archive/projects']);
});

test('the grant still refuses BEFORE the adapter is reached', async () => {
    // The strip must not become a way past the check. A refused call
    // never reaches the legacy client at all.
    const seen = installLegacyApi();
    const api = createScreenApi(['/archive'], legacyApiTransport(), 'history');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(api.call('/api/v1/archive/../sessions/respawn')).rejects.toThrow();
    await expect(api.call('/sessions/respawn')).rejects.toThrow();
    err.mockRestore();
    expect(seen).toEqual([]);
});

test('a missing API client is a named rejection, not a throw at import', async () => {
    delete (globalThis as Record<string, unknown>).API;
    const api = createScreenApi(['/features'], legacyApiTransport(), 'history');
    await expect(api.call('/features')).rejects.toThrow(/API client is not loaded/);
});
