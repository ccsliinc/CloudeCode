/**
 * A FAKE TRANSPORT, NOT A FAKE CLIENT. SCAFFOLDING.
 *
 * THIS IS THE WHOLE POINT OF THE FILE, AND IT IS WHY THE RAIL COULD BE
 * VERIFIED FOUR TIMES WHILE THE OWNER LOOKED AT SLUGS.
 * `nav-parity-rail.ts` next door hands `NavRail` an object with four
 * listing methods on it. That object REPLACES `client.ts`, so every
 * decision `client.ts` makes - which route a view reads, and what is
 * carried onto the rows on the way back - is skipped. A rail measured
 * that way cannot fail for a reason that lives in the client, and the
 * defect lived in the client.
 *
 * So this stands in one layer lower: it implements `ScreenApi`, the
 * granted transport, and the page builds a REAL `createArchiveClient`
 * on top of it. Everything from `client.ts` downward is the shipping
 * code, including the app-name join. The only thing that is not real is
 * the socket.
 *
 * THE BYTES IT SERVES ARE THE LIVE SERVER'S. `capture_live_envelopes.py`
 * calls each route's own body against the real databases and writes the
 * envelopes to `live-envelopes.json`. They are not a fixture anybody
 * composed, which matters: a fixture is written by the person doing the
 * verifying, and a fixture that happens to carry `app_name_source` is
 * how a broken screen passes a test.
 *
 * Delete it with the rest of `web/dev-harness/` when the real shell
 * lands.
 */
import type { ScreenApi } from '../src/lib/plugins/types';

/** The captured envelopes, exactly as the route bodies produced them. */
export interface LiveEnvelopes {
    /** `GET /archive/projects` - the ONLY decorated project route. */
    readonly named: unknown;
    /** `GET /archive/overlay/projects` - what the merged view lists. */
    readonly overlay: unknown;
    /** `GET /archive/hosts`. */
    readonly hosts: unknown;
    /** `GET /archive/hosts/{id}/corpora`, by host id. */
    readonly corpora: Readonly<Record<string, unknown>>;
    /** `GET /archive/corpora/{id}/projects`, by corpus id. */
    readonly projects: Readonly<Record<string, unknown>>;
}

/** Which routes the fake transport is allowed to be asked for. */
export const HARNESS_GRANTS: readonly string[] = Object.freeze(['/archive']);

/** The result shape `client.ts` casts every `api.call` answer to. */
function ok(body: unknown): unknown {
    return {
        envelope: body, httpStatus: 200, headers: null,
        transportError: null, refusedByGrant: false,
    };
}

/** A route this harness has no capture for, reported as the server would. */
function notFound(path: string): unknown {
    return {
        envelope: {
            result: null,
            result_status: 'not_found',
            unevaluated: [{ subject: path, reason: 'no capture for this route' }],
        },
        httpStatus: 404,
        headers: null,
        transportError: null,
        refusedByGrant: false,
    };
}

/** A route the harness is deliberately making fail, for the control arm. */
function unreachable(path: string): unknown {
    return {
        envelope: null,
        httpStatus: null,
        headers: null,
        transportError: `harness control: ${path} was made unreachable`,
        refusedByGrant: false,
    };
}

/** How one arm of the page behaves. */
export interface TransportOptions {
    /**
     * REPRODUCE THE PRE-FIX STATE by making `/archive/projects`
     * unreachable. With no decorated listing the join index is
     * incomplete and carries nothing, so the rail draws exactly what it
     * drew before this change: the slug.
     *
     * This is the NEGATIVE CONTROL and it is load-bearing. A page that
     * rendered names because the harness handed it names would pass
     * whatever the rail did; this arm proves the page is capable of
     * showing a slug, so the other arm showing a name means something.
     */
    readonly breakNamedRoute?: boolean;
}

/** Strip the query string; the captures are keyed by path alone. */
function pathOf(endpoint: string): string {
    const q = endpoint.indexOf('?');
    return q === -1 ? endpoint : endpoint.slice(0, q);
}

/**
 * Build a `ScreenApi` that answers the archive routes from a capture.
 *
 * Description: the transport seam, so the page can construct the real
 *   `createArchiveClient` over it. Every call RESOLVES - a route with no
 *   capture answers `not_found` rather than throwing, because a throw
 *   from here would be read by `client.ts` as a grant refusal and would
 *   be a different outcome from the one being demonstrated.
 * Inputs: live (LiveEnvelopes) - the captured bodies.
 *   opts (TransportOptions) - the control arm's switch.
 * Output: ScreenApi.
 * Example: createArchiveClient(harnessTransport(live, {}))
 */
export function harnessTransport(
    live: LiveEnvelopes, opts: TransportOptions = {},
): ScreenApi {
    return {
        grants: HARNESS_GRANTS.slice(),
        call(endpoint: string): Promise<unknown> {
            const path = pathOf(endpoint);
            if (path === '/archive/projects') {
                return Promise.resolve(opts.breakNamedRoute
                    ? unreachable(path)
                    : ok(live.named));
            }
            if (path === '/archive/overlay/projects') return Promise.resolve(ok(live.overlay));
            if (path === '/archive/hosts') return Promise.resolve(ok(live.hosts));

            const corpora = /^\/archive\/hosts\/([^/]+)\/corpora$/.exec(path);
            if (corpora) {
                const body = live.corpora[corpora[1] ?? ''];
                return Promise.resolve(body === undefined ? notFound(path) : ok(body));
            }
            const projects = /^\/archive\/corpora\/([^/]+)\/projects$/.exec(path);
            if (projects) {
                const body = live.projects[projects[1] ?? ''];
                return Promise.resolve(body === undefined ? notFound(path) : ok(body));
            }
            return Promise.resolve(notFound(path));
        },
    } as unknown as ScreenApi;
}
