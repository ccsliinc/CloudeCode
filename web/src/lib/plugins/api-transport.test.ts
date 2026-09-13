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
 * SLICE 2 MOVED THE RECORDER ONE LAYER DOWN, WHICH IS STRICTLY BETTER
 * AND IS THE REASON EVERY CASE BELOW READS DIFFERENTLY. The transport no
 * longer calls `api.call()` and let `api.js` compose the URL; it composes
 * `api.baseURL + stripApiBase(path)` itself, because the archive needs
 * the STATUS and the HEADERS that `api.call` throws away on a non-2xx.
 * So the double is now on `fetch`, and what these cases assert is the
 * literal URL that would go on the wire - the exact string the original
 * bug got wrong, rather than the argument handed to a function that
 * would then get it wrong. Every case from the previous version is kept;
 * the assertions moved to the composed URL.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { legacyEnvelopeTransport, stripApiBase } from './api-transport';
import { createScreenApi } from './screen-api';

/** What `api.js` sets `baseURL` to on this app's own origin. */
const BASE_URL = 'http://example.test:5055/api/v1';

/** Install a recording `fetch` plus a double of `window.API`. */
function installLegacy(opts: { status?: number; body?: unknown } = {}): string[] {
    const seen: string[] = [];
    (globalThis as Record<string, unknown>).API = {
        baseURL: BASE_URL,
        getToken: () => 'test-jwt',
        _singleFlightRefresh: () => Promise.resolve(false),
    };
    (globalThis as Record<string, unknown>).fetch = (url: string) => {
        seen.push(String(url));
        return Promise.resolve({
            status: opts.status === undefined ? 200 : opts.status,
            headers: { get: () => null },
            json: async () => (opts.body === undefined ? { ok: true } : opts.body),
        });
    };
    return seen;
}

/** The real `fetch`, put back after each case. */
const realFetch = globalThis.fetch;

beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => {}); });
afterEach(() => {
    delete (globalThis as Record<string, unknown>).API;
    (globalThis as Record<string, unknown>).fetch = realFetch;
    vi.restoreAllMocks();
});

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

test('THE REGRESSION: the URL on the wire carries the base exactly once', async () => {
    // This is the whole file, and it is now asserted on the real thing:
    // the composed URL. `/api/v1/api/v1/features` is the string that
    // shipped and 404'd, so it is the string this refuses.
    const seen = installLegacy();
    const api = createScreenApi(['/archive', '/features'], legacyEnvelopeTransport(), 'history');

    await api.call('/features');
    await api.call('/archive/hosts');

    expect(seen).toEqual([`${BASE_URL}/features`, `${BASE_URL}/archive/hosts`]);
    for (const url of seen) {
        expect(url.includes('/api/v1/api/v1'),
               `"${url}" carries the base twice; this is the slice 1 regression`)
            .toBe(false);
    }
});

test('a path written WITH the base by the caller arrives the same way', async () => {
    // `ScreenApi` accepts both spellings and normalises them, so the
    // adapter must land on one answer whichever the caller used.
    const seen = installLegacy();
    const api = createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history');
    await api.call('/api/v1/archive/hosts');
    await api.call('/archive/hosts');
    expect(seen).toEqual([`${BASE_URL}/archive/hosts`, `${BASE_URL}/archive/hosts`]);
});

test('a traversal that stays in the grant arrives NORMALISED', async () => {
    const seen = installLegacy();
    const api = createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history');
    await api.call('/archive/hosts/../projects');
    expect(seen).toEqual([`${BASE_URL}/archive/projects`]);
});

test('the grant still refuses BEFORE the transport is reached', async () => {
    // The strip must not become a way past the check. A refused call
    // never reaches `fetch` at all, which is what "the request was not
    // sent" has to mean if it is to mean anything.
    const seen = installLegacy();
    const api = createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(api.call('/api/v1/archive/../sessions/respawn')).rejects.toThrow();
    await expect(api.call('/sessions/respawn')).rejects.toThrow();
    err.mockRestore();
    expect(seen).toEqual([]);
});

test('every request carries the Bearer token and a deadline it can be aborted by', async () => {
    // Both moved out of `api-archive.js` with the rest of the client. A
    // request with no abort signal cannot be stopped by its deadline, so
    // the loading state it feeds can never terminate.
    const captured: RequestInit[] = [];
    (globalThis as Record<string, unknown>).API = {
        baseURL: BASE_URL, getToken: () => 'test-jwt',
    };
    (globalThis as Record<string, unknown>).fetch = (_u: string, init: RequestInit) => {
        captured.push(init);
        return Promise.resolve({
            status: 200, headers: { get: () => null }, json: async () => ({}),
        });
    };
    const api = createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history');
    await api.call('/archive/hosts', { timeoutMs: 10000 });
    const headers = captured[0]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
    expect(captured[0]!.signal, 'the request carries no abort signal, so its deadline '
        + 'cannot stop it').toBeTruthy();
});

test('a NON-2XX RESOLVES carrying its envelope, which api.call could not do', async () => {
    // THE REASON THE TRANSPORT CHANGED SHAPE. Measured on the live
    // server: GET /api/v1/archive/transcripts/99999 is HTTP 404 with a
    // complete, renderable envelope. `api.call` throws on any non-2xx
    // and returns only the body, so that envelope is lost on the way to
    // the rejection.
    installLegacy({ status: 404, body: { result_status: 'not_found' } });
    const api = createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history');
    const r = await api.call('/archive/transcripts/99999') as {
        httpStatus: number; envelope: { result_status: string }; transportError: null };
    expect(r.httpStatus).toBe(404);
    expect(r.envelope.result_status).toBe('not_found');
    expect(r.transportError).toBe(null);
});

test('a missing API client is a NAMED RESULT, no longer a rejection', async () => {
    // THE CASE IS KEPT AND ITS ASSERTION MOVED, which is the porting
    // rule: the outcome it guards against is unchanged - a page that did
    // not load `api.js` must say so by name rather than fail somewhere
    // later - but the transport now RESOLVES it, because the archive's
    // own contract is that a call never rejects and a finding a screen
    // has to paint must arrive as a value.
    delete (globalThis as Record<string, unknown>).API;
    const api = createScreenApi(['/features'], legacyEnvelopeTransport(), 'history');
    const r = await api.call('/features') as { transportError: string; envelope: null };
    expect(r.transportError).toMatch(/API client is not loaded/);
    expect(r.envelope).toBe(null);
});
