/**
 * The one adapter between a granted client and the legacy API client.
 *
 * WHY `stripApiBase` EXISTS, AND IT IS A BUG THIS PAID FOR.
 * `ScreenApi.call` resolves and normalises every path to an ABSOLUTE one
 * under `/api/v1` BEFORE checking it against the grant, because
 * containment has to be measured on the path that would actually be sent
 * - that is not negotiable and it is what stops
 * `/archive/../sessions/respawn` crossing. But `client/js/api.js` sets
 * `this.baseURL = <origin>/api/v1` and PREPENDS it, so everything that
 * composes a URL from that base takes a path RELATIVE to it. Handing it
 * the resolved absolute path produces `/api/v1/api/v1/features`, which
 * 404s.
 *
 * THAT IS EXACTLY WHAT SHIPPED IN THE FIRST DRAFT OF SLICE 1, AND NO
 * UNIT TEST SAW IT. Every suite handed the granted client a recording
 * transport and asserted the path it was ASKED FOR, which was correct;
 * none of them asked what the real client would DO with it. It was
 * caught by driving the real page against a real server, where the
 * archive's availability probe answered `unknown` on a server that
 * reports `enabled`. SO THE STRIP LIVES HERE, ONCE, and it is still
 * load-bearing on exactly the same line: the transport below composes
 * `api.baseURL + stripApiBase(path)`, which is the same composition
 * `api-archive.js::callEnvelope` did as `this.baseURL + endpoint`.
 *
 * THE TRANSPORT IS ENVELOPE-SHAPED, WHICH IS A CHANGE SLICE 2 MADE AND
 * IS RECORDED RATHER THAN QUIETLY DONE. Slice 1's transport called
 * `api.call()`, which THROWS on any non-2xx and returns only the parsed
 * body. That is correct for the three screens already built on it and
 * wrong for every archive route: measured on the live server, `GET
 * /api/v1/archive/transcripts/99999` answers HTTP 404 carrying a
 * COMPLETE, renderable envelope, and a malformed cursor answers HTTP 400
 * the same way. Both are findings a person must read, and `api.call`
 * discards the body on the way to its throw.
 *
 * Information flows one way only, which is why there is now ONE
 * transport rather than two: an envelope result carries the body, so a
 * caller that wants only the body can take `.envelope`, while a body
 * cannot reproduce a status or a header. Two transports would be two
 * answers to "what does a call return", and the grant check sits above
 * both of them.
 *
 * WHAT IT STILL BORROWS FROM `window.API`, AND WHY IT MUST. Three
 * things: `baseURL`, `getToken()` and `_singleFlightRefresh()`. That
 * last one is the app's ONE token-refresh mutex; `api-archive.js`'s own
 * header records that a second refresh chain is the exact race
 * `api.js`'s single-flight comment exists to prevent, so this reaches
 * for the existing one rather than minting a second.
 */

/** The base `ScreenApi` resolves against and `api.js` prepends. */
const API_BASE = '/api/v1';

/** As much of the legacy API client as this adapter reads. */
interface LegacyApiClient {
    baseURL?: string;
    getToken?(): string | null;
    _singleFlightRefresh?(): Promise<boolean>;
}

/** As much of `window.Auth` as the 401 replay consults. */
interface LegacyAuth {
    getRefreshToken?(): string | null;
}

/** What one call resolves to. Mirrors `EnvelopeResult` in `./types`. */
interface TransportResult {
    envelope: unknown;
    httpStatus: number | null;
    headers: { get(name: string): string | null } | null;
    transportError: string | null;
    refusedByGrant: boolean;
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

/** A result for a call that never reached the network. */
function transportFailure(reason: string): TransportResult {
    return {
        envelope: null, httpStatus: null, headers: null,
        transportError: reason, refusedByGrant: false,
    };
}

/**
 * Build the transport that reaches the server, envelope-shaped.
 *
 * Description: IT NEVER REJECTS. A dead network, a body that is not
 *   JSON and a deadline expiry all RESOLVE with `envelope: null` and
 *   `transportError` naming what happened, because "the server did not
 *   answer" is a finding a screen has to paint and a rejected promise is
 *   how a finding becomes an unhandled console line nobody sees. The one
 *   rejection a caller can still see is the GRANT refusing, which
 *   happens in `screen-api.ts` before this function is ever reached.
 *
 *   Everything is resolved LAZILY, at call time, so this module does not
 *   require `window.API` to exist when it is imported: the bundle is a
 *   deferred module and the legacy client is a classic script, and while
 *   that ordering happens to be safe today, depending on it at import
 *   time is a dependency on a script tag's position.
 * Inputs: none. Output: a function taking a RESOLVED absolute path and
 *   an options object, which may carry `timeoutMs`.
 * Example: createScreenApi(['/archive'], legacyEnvelopeTransport(), 'history')
 */
export function legacyEnvelopeTransport(): (
    path: string, init?: Record<string, unknown>,
) => Promise<unknown> {
    return async function transport(
        path: string, init?: Record<string, unknown>,
    ): Promise<unknown> {
        return await send(path, init || {}, false);
    };
}

/**
 * One attempt, with at most one replay after a token refresh.
 *
 * Description: `retrying` is what bounds the replay to one. Two archive
 *   requests racing must not each burn the refresh chain, which is why
 *   the refresh itself is the app's single-flight one rather than a
 *   fetch issued here.
 * Inputs: path - resolved and absolute. options - `timeoutMs` plus fetch
 *   options. retrying - true on the replay after a successful refresh.
 * Output: Promise<TransportResult>, never rejected.
 */
async function send(
    path: string, options: Record<string, unknown>, retrying: boolean,
): Promise<TransportResult> {
    const g = globalThis as {
        API?: LegacyApiClient; Auth?: LegacyAuth;
        fetch?: typeof fetch; AbortController?: typeof AbortController;
    };
    const api = g.API;
    if (!api || typeof api.baseURL !== 'string') {
        return transportFailure(
            '[plugins] the API client is not loaded; "' + path + '" was not sent');
    }
    if (typeof g.fetch !== 'function') {
        return transportFailure(
            '[plugins] fetch is unavailable; "' + path + '" was not sent');
    }

    const { timeoutMs, ...fetchOnly } = options as {
        timeoutMs?: number; headers?: Record<string, string>;
    };
    const headers: Record<string, string> = { ...(fetchOnly.headers || {}) };
    const token = typeof api.getToken === 'function' ? api.getToken() : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // AbortController is the only way to stop a fetch already handed to
    // the browser. Racing a timer against the promise leaves the request
    // running and its response landing on a view that stopped waiting.
    const Ctor = g.AbortController;
    const controller = typeof Ctor === 'function' ? new Ctor() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (controller && typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const fetchOptions: Record<string, unknown> = { ...fetchOnly, headers };
    if (controller) fetchOptions.signal = controller.signal;

    try {
        const response = await g.fetch(
            `${api.baseURL}${stripApiBase(path)}`, fetchOptions as RequestInit);

        // A 401 here means the access token expired mid-browse. Run the
        // SAME single-flight refresh the rest of the app uses and replay
        // once.
        if (response.status === 401 && !retrying
                && typeof api._singleFlightRefresh === 'function'
                && g.Auth && typeof g.Auth.getRefreshToken === 'function'
                && g.Auth.getRefreshToken()) {
            const refreshed = await api._singleFlightRefresh();
            if (refreshed === true) {
                if (timer) clearTimeout(timer);
                return await send(path, options, true);
            }
        }

        let envelope: unknown = null;
        let transportError: string | null = null;
        try {
            envelope = await response.json();
        } catch (parseError) {
            // A body that is not JSON is not an envelope. Reporting it
            // as one would put an object with no result_status in front
            // of archive-outcome.js, which classifies that as a
            // transport error anyway - but saying so HERE keeps the real
            // reason instead of losing it.
            const m = parseError && typeof parseError === 'object'
                && 'message' in parseError
                ? String((parseError as { message: unknown }).message)
                : String(parseError);
            transportError = `response body was not JSON: ${m}`;
        }

        return {
            envelope,
            httpStatus: response.status,
            headers: response.headers || null,
            transportError,
            refusedByGrant: false,
        };
    } catch (error) {
        const aborted = !!error && typeof error === 'object'
            && (error as { name?: unknown }).name === 'AbortError';
        const message = error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message) : String(error);
        const reason = aborted
            ? `no response in ${Math.round((timeoutMs || 0) / 1000)}s`
            : `request failed: ${message}`;
        console.debug(`API archive [${path}]: ${reason}`);
        return transportFailure(reason);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
