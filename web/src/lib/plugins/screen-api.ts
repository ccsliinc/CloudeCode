/**
 * The granted client: a fetch scoped to exactly the prefixes a screen
 * declared, and a refusal that cannot be mistaken for a 404.
 *
 * WHY A CAPABILITY AND NOT A CLIENT THE HOST WRITES. Three options were
 * weighed in the scope. Letting a plugin call `window.API` directly is
 * what the archive does today and is unbounded: a module that can call
 * `/archive/transcripts` can call `/sessions/respawn`. Having the host
 * write a bespoke typed client per plugin does not generalise, because
 * it puts the host back in the business of knowing about each plugin,
 * which is the dependency direction a module boundary exists to
 * reverse. So the contribution DECLARES `apiPrefixes` and the host
 * builds this. The grant is data, reviewable in one line, and identical
 * for first-party and third-party code - what differs is who approves
 * it, not what enforces it.
 *
 * A REFUSAL IS NOT A 404, AND THE DIFFERENCE IS STRUCTURAL RATHER THAN
 * WORDED. A 404 from a capability check is indistinguishable from a
 * broken server, and the person debugging it goes looking in the wrong
 * half of the application. So a refusal never reaches the network: the
 * promise REJECTS with a `GrantRefusedError`, which carries the path it
 * refused and the grants it was holding, and it is logged. A 404 by
 * contrast RESOLVES, carrying whatever the host's client resolves a
 * missing route to. A caller that only writes `.catch()` can still tell
 * them apart, because one arrives as a rejection with a name on it and
 * the other does not arrive as a rejection at all.
 *
 * CONTAINMENT IS COMPONENT-WISE AND THE PATH IS NORMALISED FIRST. Two
 * separate failures, one check. `/api/v1/archived-thing` must not pass a
 * grant for `/api/v1/archive`, which is what `startsWith` would allow -
 * the same defect `project_directory.py` names, where
 * `/Users/jsugamelevil` reads as living under `/Users/jsugamele`. And
 * `/archive/../sessions/respawn` must not pass it either, which is what
 * comparing the path AS WRITTEN would allow. Normalising before
 * comparing closes the second; comparing whole segments closes the
 * first. Neither closes the other.
 */

/**
 * The base every grant and every call is resolved against. Spelled once
 * here; a second spelling is a second answer to "what is a path".
 */
const API_BASE = '/api/v1';

/**
 * A call a screen was not granted. Thrown before anything is sent.
 *
 * Description: an Error subclass so an existing `catch` still catches
 *   it, carrying `name`, `path` and `grants` so a caller can tell a
 *   refusal from a transport failure and from a 404 without parsing a
 *   message string. `name` is set explicitly rather than inherited,
 *   because a minifier renames the class and `err.constructor.name` is
 *   therefore not a fact about the build that ships.
 * Example:
 *   try { await api.call('/sessions/respawn'); }
 *   catch (e) { if (e instanceof GrantRefusedError) notMine(e.path); }
 */
export class GrantRefusedError extends Error {
    /** Always 'GrantRefusedError'. Survives minification; the class name does not. */
    override readonly name = 'GrantRefusedError';
    /** The resolved, normalised path that was refused. */
    readonly path: string;
    /** The grants held at the moment of refusal, as declared. */
    readonly grants: readonly string[];

    constructor(path: string, grants: readonly string[]) {
        super(
            `[plugins] refused a call to "${path}": outside this screen's `
            + `grant of [${grants.join(', ') || 'nothing'}]. The request was `
            + 'not sent; this is a capability refusal, not a 404.',
        );
        this.path = path;
        this.grants = grants.slice();
    }
}

/**
 * What the host supplies to actually make a call once the grant passes.
 *
 * Description: one function, taking an ABSOLUTE path under `/api/v1`.
 *   Narrow on purpose: the smaller this is, the less a screen could do
 *   with it if it ever got hold of one, and the easier a test's double
 *   is to trust.
 */
export interface ApiTransport {
    (path: string, init?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Split a path into its non-empty segments.
 * Inputs: path - e.g. '/api/v1/archive/'. Output: ['api','v1','archive'].
 */
function segmentsOf(path: string): string[] {
    return path.split('/').filter((s) => s !== '');
}

/**
 * Resolve `.` and `..` inside a path, by segment.
 *
 * Description: HAND-ROLLED RATHER THAN `new URL(...)`, deliberately. URL
 *   needs a base, normalises percent-escapes and would happily accept an
 *   absolute URL with another origin in it - three behaviours this does
 *   not want and would have to guard anyway. A `..` that would climb
 *   above the root is DROPPED rather than throwing: the result is then a
 *   path that is simply not under any grant, which the caller refuses
 *   for the ordinary reason.
 * Inputs: path (string).
 * Output: string - an absolute path with no '.' or '..' segments.
 * Example: normalisePath('/api/v1/archive/../sessions/respawn')
 *          // -> '/api/v1/sessions/respawn'
 */
export function normalisePath(path: string): string {
    const out: string[] = [];
    for (const seg of segmentsOf(path)) {
        if (seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
    }
    return '/' + out.join('/');
}

/**
 * Is `path` inside `grant`, comparing whole segments?
 *
 * Description: true when the grant's segments are a PREFIX of the path's
 *   segments, segment for segment. Equality counts (a grant covers
 *   itself). This is the whole of the containment rule and it is one
 *   function so there is one answer to it.
 * Inputs: path - already normalised and absolute. grant - likewise.
 * Output: boolean.
 * Example: withinGrant('/api/v1/archived-thing', '/api/v1/archive')
 *          // -> false   (`archived-thing` is not the segment `archive`)
 */
export function withinGrant(path: string, grant: string): boolean {
    const p = segmentsOf(path);
    const g = segmentsOf(grant);
    if (g.length === 0) return false;
    if (p.length < g.length) return false;
    for (let i = 0; i < g.length; i++) {
        if (p[i] !== g[i]) return false;
    }
    return true;
}

/**
 * Resolve a caller's path against `/api/v1` and normalise it.
 *
 * Description: a path already carrying the base is left where it is; one
 *   that does not is joined under it. Both are then normalised, so the
 *   thing compared against the grant is the thing that would be sent.
 * Inputs: path (string) - '/archive/x' or '/api/v1/archive/x'.
 * Output: string - absolute and normalised.
 */
export function resolveApiPath(path: string): string {
    const raw = typeof path === 'string' ? path : '';
    const withBase = raw.startsWith(API_BASE + '/') || raw === API_BASE
        ? raw
        : API_BASE + (raw.startsWith('/') ? raw : '/' + raw);
    return normalisePath(withBase);
}

/**
 * Build the client one screen is granted.
 *
 * Description: THE HOST CALLS THIS, THE SCREEN RECEIVES THE RESULT. The
 *   grants are resolved and normalised ONCE, here, so a grant written as
 *   '/archive' and one written as '/api/v1/archive/' are the same grant
 *   and cannot disagree. Every call is then checked against that
 *   resolved set.
 *
 *   AN EMPTY GRANT LIST IS A REAL ANSWER AND REFUSES EVERYTHING. It is
 *   what a screen that talks to no server declares, and a screen that
 *   declared nothing by mistake gets a loud refusal on its first call
 *   rather than silent access.
 * Inputs: prefixes - the contribution's `apiPrefixes`, as declared.
 *         transport - what actually makes the call once the grant passes.
 *         label - the contribution id, for the log line.
 * Output: ScreenApi.
 * Example:
 *   const api = createScreenApi(['/archive'], (p) => API.call(p), 'history');
 *   await api.call('/archive/projects');       // sent
 *   await api.call('/sessions/respawn');       // GrantRefusedError
 */
export function createScreenApi(
    prefixes: readonly string[],
    transport: ApiTransport,
    label: string,
): import('./types').ScreenApi {
    const declared = (prefixes || []).slice();
    const resolved = declared.map(resolveApiPath);

    async function call(path: string, init?: Record<string, unknown>): Promise<unknown> {
        const target = resolveApiPath(path);
        const allowed = resolved.some((g) => withinGrant(target, g));
        if (!allowed) {
            const err = new GrantRefusedError(target, declared);
            // LOGGED AS WELL AS THROWN. The throw is for the caller; the
            // log is for the person reading a console and wondering why
            // one request never appeared in the network tab. A silent
            // refusal is the failure this whole mechanism exists to
            // avoid reproducing one layer up.
            console.error(`[plugins] "${label}" ${err.message}`);
            throw err;
        }
        return transport(target, init);
    }

    return { call, grants: declared };
}
