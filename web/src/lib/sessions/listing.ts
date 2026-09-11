/**
 * The three-outcome latch for the launchpad's two session probes.
 *
 * PORTED FROM `Launchpad._noteListingUnknown`, `_listingReasonFromError`
 * and the status extraction inside `loadRunningSessions`'s catch, LINE BY
 * LINE. The rules are not restated here in a tidier form; they are the
 * same rules in the same order, because the thing they encode is that a
 * probe which did not answer must never render as a machine with zero
 * sessions. The previous version of that catch logged loudly and fell
 * back to `[]`, which is worse than a silent catch: the console told the
 * truth while the screen rendered a dead tmux server as a healthy one,
 * and the loud log made the problem look solved.
 *
 * THE COPY IS NOT IN THIS FILE. A reason is a machine TOKEN and stays a
 * token; the human sentence under a CANNOT DETERMINE row is assembled by
 * `client/js/labels/session-listing.js` from the catalog. See
 * `.claude/notes/i18n-design.md`.
 */
import type { ListingState } from './types';

/** The reason recorded when nothing more specific could be derived. */
export const DEFAULT_REASON = 'probe_error';

/**
 * A fresh listing verdict for one poll tick.
 *
 * Description: `ok` starts true and only ever moves to false. Built new
 *   per tick rather than mutated in place across ticks, so a probe that
 *   recovers is not still wearing the previous tick's failure.
 * Inputs: none.
 * Output: ListingState.
 * Example: let listing = emptyListing();
 */
export function emptyListing(): ListingState {
    return { ok: true, reason: null, detail: null, sources: [] };
}

/**
 * Record that one of the two session probes did not produce an answer.
 *
 * Description: latches `ok` to false for this poll tick. ONCE FALSE IT
 *   NEVER FLIPS BACK within the tick - a second probe succeeding does not
 *   un-break the first, because the row set is still incomplete. The
 *   first reason and the first detail win for the same reason: the
 *   earliest failure is the one that explains the gap.
 * Inputs:
 *   state - the tick's verdict, mutated in place.
 *   source - 'attachable' | 'live', which fetch failed.
 *   reason - short machine token, mirroring the server's TmuxListing
 *     vocabulary where one is available.
 *   detail - human text for the row's second line, already assembled.
 * Output: void.
 * Example: noteListingUnknown(listing, 'attachable', 'timeout', detail);
 */
export function noteListingUnknown(
    state: ListingState,
    source: string,
    reason: string | null,
    detail: string | null,
): void {
    state.ok = false;
    if (!state.reason) state.reason = reason || DEFAULT_REASON;
    if (!state.detail) state.detail = detail || null;
    if (state.sources.indexOf(source) === -1) state.sources.push(source);
}

/**
 * The HTTP status behind a rejected API call, or null.
 *
 * Description: the `call()` wrapper in `client/js/api.js` throws
 *   `Error("HTTP <code>")` for non-401s and `Error("Authentication
 *   required...")` for 401s after a refresh fails, so the status has to
 *   be parsed back out of the message when the error carries no numeric
 *   `status`. Null means the status could not be determined, which is a
 *   third outcome and NOT a zero.
 * Inputs: err - the rejection, of any shape.
 * Output: number | null.
 * Example: statusFromError(new Error('HTTP 503'))  // 503
 */
export function statusFromError(err: unknown): number | null {
    const e = err as { status?: unknown; message?: unknown } | null | undefined;
    if (e && typeof e.status === 'number') {
        return e.status;
    }
    if (e && typeof e.message === 'string') {
        const m = e.message.match(/HTTP\s+(\d{3})/);
        // Group 1 exists whenever the pattern matched at all.
        if (m) return parseInt(m[1]!, 10);
        if (/Authentication required/i.test(e.message)) return 401;
    }
    return null;
}

/**
 * Derive a machine-readable reason token from a rejected API call.
 *
 * Description: PREFERS THE SERVER'S OWN `listing_reason` (shipped in the
 *   structured 503 detail from `GET /sessions/attachable` and preserved
 *   on `err.detail` by `api.js`) so the client repeats the server's
 *   verdict rather than inventing a parallel one. Falls back to the
 *   transport-level facts the browser actually has.
 *
 *   NOT A TRANSLATED STRING. This is an identifier the way an error code
 *   is, it is compared against the server's vocabulary, and translating
 *   it would make two installs disagree about what the same failure is
 *   called.
 * Inputs: err - the rejection. status - already parsed by the caller.
 * Output: string, e.g. 'tmux_missing', 'unauthorized', 'http_500',
 *   'network_error'.
 * Example: listingReasonFromError(err, 401)  // 'unauthorized'
 */
export function listingReasonFromError(err: unknown, status: number | null): string {
    const d = (err as { detail?: unknown } | null | undefined)?.detail;
    if (d && typeof d === 'object') {
        const reason = (d as { listing_reason?: unknown }).listing_reason;
        if (typeof reason === 'string' && reason) return reason;
    }
    if (status === 401) return 'unauthorized';
    if (typeof status === 'number' && status > 0) return `http_${status}`;
    return 'network_error';
}
