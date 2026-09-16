/**
 * THE HARNESS'S COMPOSITION ROOT FOR THE GRANTED CLIENT. SCAFFOLDING.
 *
 * IT BUILDS THE SAME CLIENT `main.ts` BUILDS, THROUGH THE SAME TWO
 * FUNCTIONS. `createScreenApi(API_PREFIXES, legacyEnvelopeTransport())`
 * then `createArchiveClient(...)`. Nothing is re-implemented here and no
 * second transport exists: a request from this page is checked against
 * the same `['/archive', '/features']` grant, component-wise, by
 * `screen-api.ts`, before it leaves the browser. A path outside the
 * grant is refused here exactly as it is refused in the app.
 *
 * WHY A `window.API` SHIM AT ALL. `api-transport.ts` reads three things
 * off `window.API` - `baseURL`, `getToken()` and `_singleFlightRefresh()`
 * - because in the real app those belong to the legacy
 * `client/js/api.js`, which this page deliberately does not load: that
 * file boots a whole application controller. So this publishes the
 * SMALLEST object that satisfies the transport, and publishes no more
 * than that. It provides `baseURL` and `getToken` and DELIBERATELY NOT
 * `_singleFlightRefresh`, so the 401 replay branch is inert and an
 * expired token shows the login panel instead of silently refreshing
 * against a refresh token this harness never keeps.
 *
 * `baseURL` IS RELATIVE, AND THAT IS LOAD-BEARING. `api.js` sets an
 * absolute `<origin>/api/v1`; here the page's own origin IS the Vite dev
 * server and the FastAPI one is reached through its proxy, so the
 * request has to go to a same-origin `/api/v1/...`. An absolute
 * `http://127.0.0.1:8000/api/v1` would work only until the browser
 * applied a cross-origin rule to it, and would need CORS opened on the
 * server to fix. It does not, because of this line.
 */
import { createScreenApi } from '../src/lib/plugins/screen-api';
import { legacyEnvelopeTransport } from '../src/lib/plugins/api-transport';
import { API_PREFIXES, createArchiveClient } from '../src/lib/plugins/history/index';
import type { ArchiveClient } from '../src/lib/plugins/history/index';
import { readAccessToken } from './harness-session';

/** What the granted transport reads off `window.API`, and nothing more. */
interface HarnessApiShim {
    readonly baseURL: string;
    getToken(): string | null;
}

/** Same-origin, so the dev server's proxy carries it to FastAPI. */
const RELATIVE_API_BASE = '/api/v1';

/** The label a grant refusal prints, so a console line names this page. */
const GRANT_LABEL = 'dev-preview-harness';

/**
 * Publish the minimal `window.API` the granted transport needs.
 *
 * Description: IDEMPOTENT. Calling twice writes the same object over
 *   itself and accumulates nothing. `getToken` reads the token at CALL
 *   time rather than closing over it, so a login part-way through the
 *   session is picked up by requests already wired.
 * Inputs: none.
 * Output: void.
 * Example: installHarnessApiGlobal();
 */
export function installHarnessApiGlobal(): void {
    const shim: HarnessApiShim = {
        baseURL: RELATIVE_API_BASE,
        getToken: () => readAccessToken(),
    };
    (globalThis as { API?: HarnessApiShim }).API = shim;
}

/**
 * Build the granted archive client this page hands to both components.
 *
 * Description: ONE client for the whole page, because two would be two
 *   grants to keep in step. It holds `API_PREFIXES` and can reach
 *   nothing else.
 * Inputs: none.
 * Output: ArchiveClient.
 * Example: const client = createHarnessArchiveClient();
 *          await client.listArchiveMergedProjects();
 */
export function createHarnessArchiveClient(): ArchiveClient {
    return createArchiveClient(
        createScreenApi(API_PREFIXES, legacyEnvelopeTransport(), GRANT_LABEL),
    );
}
