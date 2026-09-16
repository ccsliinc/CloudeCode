/**
 * THE HARNESS'S AUTHENTICATION. SCAFFOLDING, NOT SLICE 3.
 *
 * IT USES THE REAL LOGIN AND NOTHING ELSE. The archive routes are behind
 * the app's JWT, so a preview that showed real data had exactly two
 * roads: turn the auth off for development, or log in. The first one is
 * how a development switch ends up shipped, so this takes the second.
 * The person types the same six-digit TOTP code he types into the app,
 * it goes to the same `POST /api/v1/auth/verify`, and what comes back is
 * the same short-lived access token the app holds. Nothing here disables
 * a check, adds a bypass, relaxes CORS or widens a CSP.
 *
 * NO CREDENTIAL IS STORED IN THE TREE, and none is written anywhere it
 * survives the tab. The access token lives in `sessionStorage`, which is
 * per-tab and per-origin and dies with the tab, and it is NEVER logged -
 * not at debug level, not in an error message, not in a thrown reason.
 * The TOTP code itself is held for the duration of one fetch and is not
 * stored at all.
 *
 * THE REFRESH TOKEN IS DELIBERATELY DROPPED. `api-transport.ts` replays
 * a 401 once through `window.API._singleFlightRefresh()` and
 * `window.Auth.getRefreshToken()`; this harness publishes neither, so
 * that branch simply never fires and an expired token surfaces as the
 * login panel again. Keeping a long-lived refresh token around for a
 * scaffold is a real credential kept for a convenience worth about four
 * hours, which is the access token's own TTL.
 */

/**
 * Where the access token is kept. `sessionStorage`, so it is scoped to
 * the one tab and is gone when that tab closes.
 */
const TOKEN_KEY = 'cloude.devHarness.accessToken';

/** The real login route. The same one client/js/auth.js posts to. */
const VERIFY_PATH = '/api/v1/auth/verify';

/** What a login attempt answers. Three outcomes, never a bare throw. */
export type LoginResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };

/**
 * Read the stored access token.
 *
 * Description: NEVER THROWS. `sessionStorage` can throw on ACCESS in a
 *   browser set to block site data, so the property lookup itself is
 *   inside the try. An unreadable store answers null, which the harness
 *   renders as "not logged in" rather than as an error.
 * Inputs: none.
 * Output: string | null - the token, or null when there is none.
 * Example: const t = readAccessToken();
 */
export function readAccessToken(): string | null {
    try {
        const value = globalThis.sessionStorage?.getItem(TOKEN_KEY);
        return typeof value === 'string' && value !== '' ? value : null;
    } catch (err: unknown) {
        // Storage is blocked. That is a browser setting, not a fault,
        // and the harness works without it (the token then lives only
        // for the life of the page). Named rather than swallowed.
        console.warn('[dev-harness] session storage is unreadable, so a login '
            + 'will not survive a reload:', describe(err));
        return null;
    }
}

/**
 * Store or clear the access token.
 *
 * Description: NEVER THROWS, and never logs the value.
 * Inputs: token - the access token, or null to clear it.
 * Output: void.
 * Example: writeAccessToken(null);  // log out
 */
export function writeAccessToken(token: string | null): void {
    try {
        const store = globalThis.sessionStorage;
        if (!store) return;
        if (token === null) store.removeItem(TOKEN_KEY);
        else store.setItem(TOKEN_KEY, token);
    } catch (err: unknown) {
        console.warn('[dev-harness] session storage is unwritable:', describe(err));
    }
}

/**
 * Exchange a TOTP code for an access token.
 *
 * Description: RESOLVES ON EVERY PATH, the same contract the archive
 *   client keeps, because "the server refused the code" and "the server
 *   is not running" are both findings the panel has to show and a
 *   rejected promise is how a finding becomes a console line nobody
 *   reads. A failure reason NEVER carries the code or the token.
 * Inputs: code - the six digits from the authenticator app.
 * Output: Promise<LoginResult>, never rejected.
 * Example: const r = await loginWithTotp('123456');
 *          if (!r.ok) show(r.reason);
 */
export async function loginWithTotp(code: string): Promise<LoginResult> {
    const trimmed = String(code || '').trim();
    if (trimmed === '') return { ok: false, reason: 'enter the six digit code' };

    let response: Response;
    try {
        response = await fetch(VERIFY_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: trimmed }),
        });
    } catch (err: unknown) {
        return {
            ok: false,
            reason: 'the server could not be reached. Is CloudeCode running on '
                + 'the address vite.dev-harness.config.ts proxies to? ('
                + describe(err) + ')',
        };
    }

    if (response.status === 429) {
        return { ok: false, reason: 'rate limited by the server. Wait for the next code.' };
    }

    let body: unknown = null;
    try {
        body = await response.json();
    } catch (err: unknown) {
        // A non-JSON body from the login route means something other
        // than the API answered - a proxy error page, typically. Saying
        // so beats reporting a bad code.
        return {
            ok: false,
            reason: `the login response was not JSON (HTTP ${response.status}): `
                + describe(err),
        };
    }

    if (!response.ok) {
        return { ok: false, reason: detailOf(body) || `login refused (HTTP ${response.status})` };
    }

    const token = tokenOf(body);
    if (token === null) {
        return { ok: false, reason: 'the server accepted the code but sent no access token' };
    }
    writeAccessToken(token);
    return { ok: true };
}

/** The `access_token` off a login body, or null. Never logs it. */
function tokenOf(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const value = (body as { access_token?: unknown }).access_token;
    return typeof value === 'string' && value !== '' ? value : null;
}

/** FastAPI's `detail` off an error body, or null. */
function detailOf(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const value = (body as { detail?: unknown }).detail;
    return typeof value === 'string' && value !== '' ? value : null;
}

/** The message off an unknown rejection, without assuming it is an Error. */
function describe(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
        return String((err as { message: unknown }).message);
    }
    return String(err);
}
