/**
 * The one adapter between a granted client and the legacy API client.
 *
 * WHY THIS FILE EXISTS, AND IT IS A BUG THIS PAID FOR. `ScreenApi.call`
 * resolves and normalises every path to an ABSOLUTE one under `/api/v1`
 * BEFORE checking it against the grant, because containment has to be
 * measured on the path that would actually be sent - that is not
 * negotiable and it is what stops `/archive/../sessions/respawn`
 * crossing. But `client/js/api.js` sets
 * `this.baseURL = <origin>/api/v1` and PREPENDS it, so it takes a path
 * RELATIVE to that base. Handing it the resolved absolute path produces
 * `/api/v1/api/v1/features`, which 404s.
 *
 * THAT IS EXACTLY WHAT SHIPPED IN THE FIRST DRAFT OF THIS SLICE, AND NO
 * UNIT TEST SAW IT. Every suite handed the granted client a recording
 * transport and asserted the path it was ASKED FOR, which was correct;
 * none of them asked what the real client would DO with it. It was
 * caught by driving the real page against a real server, where the
 * archive's availability probe answered `unknown` on a server that
 * reports `enabled`. That is `docs/LESSONS.md`'s rule about a test
 * building its input and its expectation from one source, landing on
 * this slice.
 *
 * SO THE STRIP LIVES HERE, ONCE. Two call sites needed it - the plugin
 * built at registration and the host's per-mount transport - and two
 * copies of an impedance match is how one of them gets fixed and the
 * other does not.
 */

/** The base `ScreenApi` resolves against and `api.js` prepends. */
const API_BASE = '/api/v1';

/** As much of the legacy API client as this adapter calls. */
interface LegacyApiClient {
    call(path: string, init?: unknown): Promise<unknown>;
}

/**
 * Turn a resolved absolute path back into what `api.js` expects.
 *
 * Description: strips exactly one leading `/api/v1`. A path that does
 *   not carry it is returned unchanged rather than mangled - the grant
 *   check has already run by the time anything reaches here, so a path
 *   in an unexpected shape is a bug to surface, not one to silently
 *   rewrite into something that might work.
 * Inputs: path - absolute, e.g. '/api/v1/archive/hosts'.
 * Output: relative to the base, e.g. '/archive/hosts'.
 * Example: stripApiBase('/api/v1/features')  // -> '/features'
 */
export function stripApiBase(path: string): string {
    const raw = typeof path === 'string' ? path : '';
    if (raw === API_BASE) return '/';
    if (raw.startsWith(API_BASE + '/')) return raw.slice(API_BASE.length);
    return raw;
}

/**
 * Build the transport that reaches the legacy API client.
 *
 * Description: resolved LAZILY, so this module does not require
 *   `window.API` to exist when it is imported - the bundle is a deferred
 *   module and the legacy client is a classic script, and while that
 *   ordering happens to be safe today, depending on it at import time is
 *   a dependency on a script tag's position.
 * Inputs: none. Output: a function taking a RESOLVED absolute path.
 * Example: createScreenApi(['/archive'], legacyApiTransport(), 'history')
 */
export function legacyApiTransport(): (
    path: string, init?: Record<string, unknown>,
) => Promise<unknown> {
    return (path: string, init?: Record<string, unknown>) => {
        const api = (globalThis as { API?: LegacyApiClient }).API;
        if (!api || typeof api.call !== 'function') {
            return Promise.reject(new Error(
                '[plugins] the API client is not loaded; "' + path
                + '" was not sent'));
        }
        return api.call(stripApiBase(path), init);
    };
}
