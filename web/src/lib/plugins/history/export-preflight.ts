/**
 * THE TRANSCRIPT EXPORT PREFLIGHT: the three integrity outcomes, the
 * filename collision warning, and the reason there is no Download
 * button. Ported from `client/js/archive-export.js`, rule for rule.
 *
 * THIS FILE MOVES NO BYTES. It reads the HEADERS of an export the server
 * would send and reports an integrity finding about them. The bytes
 * themselves are `src/core/message_model_export.py`'s business and stay
 * byte-exact; see `export-vocab.ts`'s header for why this client must
 * never compose, mask or re-serialise them.
 *
 * THE BLOCKER, MEASURED LIVE 2026-08-31. The export endpoints
 * authenticate with `HTTPBearer` and nothing else (`src/api/auth.py`).
 * Against `GET /api/v1/archive/transcripts/4/export/verified`:
 *
 *   Authorization: Bearer <jwt>   200
 *   no auth header                401
 *   ?token=<jwt>                  401
 *   ?access_token=<jwt>           401
 *   Cookie: access_token=<jwt>    401
 *   POST .../export/ticket        404   (no ticket route exists)
 *
 * A browser NAVIGATION - `window.location = href`, an `<a download>`
 * click - sends no Authorization header, so it receives a 401 and the
 * browser saves an error page. The download cannot currently
 * authenticate AT ALL.
 *
 * WHY NOT A TOKEN IN THE URL. It would work, and it would put a live
 * credential in browser history, in the server access log and in any
 * Referer. That is the owner's call, not this file's, so no such scheme
 * is invented here.
 *
 * WHY NOT fetch-INTO-A-BLOB EITHER. A tab cannot both stream to disk and
 * hash the bytes. Buffering defeats the point: transcript 17266 is
 * 244,117,661 bytes and the API's own 413 text says buffering the 91 MB
 * one "would peak near 1052 MB".
 *
 * SO THIS IMPLEMENTS `blocked-no-credential`: the finding is reported
 * truthfully and the blocker is STATED, with a copyable shasum command
 * carrying the expected hash. It does NOT render a control that produces
 * a 401. A button that cannot work is worse than a stated blocker,
 * because the blocker is at least information.
 *
 * A 413 IS NOT AN ERROR HERE. A verified export of a large transcript
 * answers 413 with a `cannot_determine` envelope carrying
 * `meta.stream_href`. That is the server ROUTING you to the streaming
 * path, so this transitions straight to UNVERIFIABLE for that href
 * rather than showing a failure.
 *
 * Does not read `result_status` or `scope_status`: those are
 * `archive-outcome.js`'s exclusive business.
 *
 * Pure. No DOM, no fetch, no framework.
 */
import {
    HTTP_BUSY, HTTP_NOT_FOUND, HTTP_TOO_LARGE, STATES, type ExportState,
} from './export-vocab';

/** A transport result, as `client.ts` returns it. */
export interface PreflightResult {
    readonly envelope?: unknown;
    readonly httpStatus?: unknown;
    readonly headers?: unknown;
    readonly transportError?: string | null;
}

/** What one preflight established. */
export interface PreflightInfo {
    readonly state: ExportState;
    readonly expectedSha: string | null;
    readonly actualSha: string | null;
    readonly expectedBytes: string | null;
    readonly filename: string | null;
    readonly streamHref: string | null;
    /** True ONLY when the server SAID so AND both hashes agree. */
    readonly verified: boolean;
    readonly reason: string;
}

/** Whether a browser can start this download at all, and why not. */
export interface DownloadCapability {
    readonly canDownload: boolean;
    readonly reason: string;
}

/**
 * Read one response header off whatever the transport handed back.
 *
 * Description: accepts a real `Headers` object or a plain map, so a test
 *   can pass an object literal without building a `Headers`.
 * Inputs: headers - a Headers, a record, or null. name - LOWERCASE.
 * Output: the value, or null.
 */
function header(headers: unknown, name: string): string | null {
    if (!headers || typeof headers !== 'object') return null;
    const maybe = headers as { get?: unknown };
    if (typeof maybe.get === 'function') {
        const v = (maybe.get as (n: string) => unknown)(name);
        return typeof v === 'string' ? v : null;
    }
    const direct = (headers as Record<string, unknown>)[name];
    return typeof direct === 'string' ? direct : null;
}

/**
 * Pull the filename out of a `content-disposition` header.
 *
 * Inputs: value - the header, or null.
 * Output: the filename, or null.
 * Example: filenameFrom('attachment; filename="a.jsonl"') // -> 'a.jsonl'
 */
export function filenameFrom(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const m = /filename="([^"]*)"/.exec(value);
    return m ? m[1] as string : null;
}

/**
 * Classify a preflight response into ONE integrity state.
 *
 * Description: THE THREE INTEGRITY OUTCOMES ARE THREE, NOT TWO.
 *   VERIFIED is the only one that may be styled as success and it is
 *   never inferred from a 200 - the server must SAY `x-archive-verified:
 *   true` and both hashes must be present and equal. UNVERIFIABLE is a
 *   COULD NOT EVALUATE: the export streams and uvicorn implements no
 *   HTTP trailers, so there is no hash of what was actually sent; it is
 *   not a failure and it is not known to be corrupt. BUSY is the server
 *   declining to START - nothing failed and nothing was downloaded.
 * Inputs: r - a transport result.
 * Output: a PreflightInfo. Never throws.
 * Example: classifyPreflight({httpStatus: 503}).state // -> 'busy'
 */
export function classifyPreflight(r: PreflightResult | null | undefined): PreflightInfo {
    const res = r ?? {};
    const base = {
        expectedSha: null as string | null,
        actualSha: null as string | null,
        expectedBytes: null as string | null,
        filename: null as string | null,
        streamHref: null as string | null,
        verified: false,
    };

    if (typeof res.transportError === 'string' && res.transportError) {
        return {
            ...base, state: STATES.CANNOT_DETERMINE,
            reason: `The preflight request did not complete: ${res.transportError}. `
                + 'Nothing is known about this export.',
        };
    }

    const status = res.httpStatus;
    const envelope = (res.envelope && typeof res.envelope === 'object')
        ? res.envelope as Record<string, unknown> : {};
    const meta = (envelope.meta && typeof envelope.meta === 'object')
        ? envelope.meta as Record<string, unknown> : {};

    if (status === HTTP_BUSY) {
        return {
            ...base, state: STATES.BUSY,
            reason: 'The server declined to start this export right now. Nothing was '
                + 'downloaded and nothing failed. Retry.',
        };
    }
    if (status === HTTP_NOT_FOUND) {
        return {
            ...base, state: STATES.NOT_FOUND,
            reason: 'The archive was read and this transcript id is not in it.',
        };
    }
    if (status === HTTP_TOO_LARGE) {
        return {
            ...base, state: STATES.UNVERIFIABLE,
            streamHref: typeof meta.stream_href === 'string' ? meta.stream_href : null,
            reason: 'This file is too large to hash before sending, so the server routed '
                + 'it to the streaming path. Streaming carries no hash of what was '
                + 'actually sent: uvicorn implements no HTTP trailers. This download '
                + 'would be NOT VERIFIED. It is also not known to be corrupt.',
        };
    }

    const expectedSha = header(res.headers, 'x-archive-expected-sha256');
    const actualSha = header(res.headers, 'x-archive-actual-sha256');
    const expectedBytes = header(res.headers, 'x-archive-expected-bytes');
    const filename = filenameFrom(header(res.headers, 'content-disposition'));
    const claimed = header(res.headers, 'x-archive-verified');
    const trailerless = header(res.headers, 'x-archive-trailer-unavailable');
    const found = { ...base, expectedSha, actualSha, expectedBytes, filename };

    if (claimed === 'true' && expectedSha && actualSha && expectedSha === actualSha) {
        return {
            ...found, state: STATES.VERIFIED, verified: true,
            reason: 'The server hashed the bytes it is about to send and they match the '
                + 'stored hash. This is a measurement, not a claim about the transfer.',
        };
    }
    if (trailerless || (expectedSha && !actualSha)) {
        return {
            ...found, state: STATES.UNVERIFIABLE,
            reason: 'This export streams and carries no hash of what was actually sent: '
                + (trailerless || 'the server supplied no actual-hash header')
                + '. NOT VERIFIED. Also not known to be corrupt.',
        };
    }
    return {
        ...found, state: STATES.CANNOT_DETERMINE,
        reason: `The preflight returned HTTP ${String(status)} without the headers that `
            + 'establish integrity either way, so whether this export can be trusted is '
            + 'NOT KNOWN.',
    };
}

/**
 * Whether the download can be started from a browser at all.
 *
 * Description: separated out and NAMED so the reason lives in exactly
 *   one place and a future ticket route flips one function rather than
 *   five call sites.
 * Inputs: none.
 * Output: a DownloadCapability.
 * Example: downloadCapability().canDownload // -> false
 */
export function downloadCapability(): DownloadCapability {
    return {
        canDownload: false,
        reason: 'The export endpoints accept an Authorization: Bearer header and nothing '
            + 'else. Measured 2026-08-31: no auth, ?token=, ?access_token= and a cookie '
            + 'all answer 401, and there is no ticket route. A browser navigation or an '
            + 'a-download click sends no Authorization header, so it would receive a 401 '
            + 'and save an error page. Unblocking this needs a short-lived single-use '
            + 'download ticket on the API, which is the owner\'s call because the '
            + 'alternative - a JWT in the URL - puts a live credential in browser '
            + 'history and server logs.',
    };
}

/**
 * The command that does, off-machine, the measurement the server could
 * not do for a streamed export.
 *
 * Inputs: filename - the name, or null. expectedSha - the stored hash.
 * Output: a shell snippet.
 * Example: shasumCommand('a.jsonl', 'abc') // -> 'shasum -a 256 a.jsonl\n# expect: abc'
 */
export function shasumCommand(
    filename: string | null, expectedSha: string | null,
): string {
    return `shasum -a 256 ${filename || '<file>'}\n# expect: `
        + (expectedSha || 'NOT KNOWN - the server supplied no expected hash');
}

/**
 * The filename collision warning, or null when the name is unique.
 *
 * Description: FILENAME COLLISIONS ARE REAL. `content-disposition` is
 *   derived from `session_ref`, and measured: `journal` names 14
 *   different transcripts, `audit` 5, `agent-a877057` 4. Fourteen
 *   different files all download as `journal.jsonl`.
 *
 *   The caller passes the count because only it has the listing. This
 *   function DOES NOT GUESS: a count it was not given is reported as
 *   unknown, never as unique.
 * Inputs: filename - the name, or null. sameNameCount - how many
 *   transcripts download under it, or null for "not looked up".
 * Output: the warning, or null.
 * Example: collisionWarning('journal.jsonl', 14)
 */
export function collisionWarning(
    filename: string | null, sameNameCount: number | null | undefined,
): string | null {
    if (!filename) return null;
    if (typeof sameNameCount !== 'number') {
        return `Whether other transcripts download under the name ${filename} is NOT `
            + 'KNOWN. The filename comes from session_ref, which is not unique in this '
            + 'archive: `journal` names 14 different transcripts.';
    }
    if (sameNameCount <= 1) return null;
    return `${sameNameCount} transcripts in this archive download as ${filename}. Your `
        + 'browser will save this as a numbered variant or overwrite an existing file, '
        + 'depending on its settings. The name comes from session_ref, which is a label '
        + 'and not an identity.';
}
