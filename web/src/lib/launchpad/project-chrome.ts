/**
 * The two things the project list says about ITSELF, rather than about
 * any project in it.
 *
 * SLICE 4: `Launchpad._renderArchivedNoticeHtml` and
 * `_renderProjectAuthorityBannerHtml`. Both are THREE-OUTCOME LADDERS
 * and both exist for the same reason: an empty project list is exactly
 * when a user most needs to know whether the datastore answered, because
 * "you have no projects" and "your projects could not be read" look
 * identical without a sentence saying which.
 *
 * THEY RETURN DISCRIMINATED UNIONS, NOT HTML AND NOT BOOLEANS. A
 * three-outcome rule modelled as a nullable boolean is a two-outcome
 * rule with a bug in it: `false` and `null` end up on the same branch
 * the first time somebody writes `if (!ok)`. A `kind` field cannot
 * collapse that way, and a `switch` over it fails to compile when a
 * fourth outcome is added and not handled.
 *
 * THE COPY IS NOT IN HERE. Every case names a catalog key; the component
 * renders it. That is what keeps this file assertable without a
 * translator and what stops a reworded sentence silently becoming a
 * reworded rule.
 */
import type { ProjectAuthority, ProjectRow } from '../sessions/types';

/** Catalog keys the two ladders name. */
export const CHROME_KEYS = {
    /** "showing archived: {count}" - a MEASURED count, including zero. */
    archivedCount: 'project.archived.notice.count',
    /** CANNOT DETERMINE. Never rendered as a zero. */
    archivedUnknown: 'project.archived.notice.unknown',
    /** The authority fetch itself did not answer. */
    authorityUnknown: 'project.authority.unknown',
} as const;

/**
 * What the archived dimension is allowed to say.
 *
 * Description: THREE OUTCOMES, never two.
 *   `silent`  - the toggle is off, so nothing was asked. Renders NOTHING
 *               at all, and silence here is correct: a line saying
 *               "unknown" about a question nobody posed is furniture.
 *   `count`   - the toggle is on and the server answered. Renders the
 *               count INCLUDING ZERO, because "showing archived: 0" is a
 *               measured fact and is exactly what distinguishes this
 *               state from the next one.
 *   `unknown` - the toggle is on and the fetch FAILED. Says CANNOT
 *               DETERMINE in words and that the list below may be stale.
 *               It never renders as zero.
 */
export type ArchivedNotice =
    | { kind: 'silent' }
    | { kind: 'count'; count: number }
    | { kind: 'unknown' };

/**
 * Decide what the archived notice says.
 *
 * Inputs: archivedFetchOk - null not asked, true answered, false failed.
 *   projects - the current list, for the count.
 * Output: ArchivedNotice.
 * Example: archivedNotice(true, [])  // {kind: 'count', count: 0}
 */
export function archivedNotice(
    archivedFetchOk: boolean | null,
    projects: ProjectRow[],
): ArchivedNotice {
    if (archivedFetchOk === null || archivedFetchOk === undefined) {
        return { kind: 'silent' };
    }
    if (archivedFetchOk === false) return { kind: 'unknown' };
    const count = (projects || []).filter((p) => p && p.archived_at).length;
    return { kind: 'count', count };
}

/**
 * What the provenance banner is allowed to claim.
 *
 * Description: three cases, and THE HEALTHY ONE DRAWS NOTHING.
 *   `none`     - `db` mode, the steady state. An empty list here is a
 *                real measured empty list and the empty-state copy
 *                already says so.
 *   `degraded` - the datastore did not answer. The SERVER's own message
 *                is rendered, because it says which read failed and that
 *                writes are refused; this tree could not write that
 *                sentence and must not try.
 *   `unknown`  - the authority fetch ITSELF failed. Says so, and claims
 *                nothing in either direction.
 */
export type AuthorityBanner =
    | { kind: 'none' }
    | { kind: 'degraded'; mode: string; writable: boolean; message: string }
    | { kind: 'unknown' };

/**
 * Decide what the authority banner claims.
 *
 * Description: A NULL AUTHORITY IS NOT A HEALTHY ONE. A failed fetch
 *   leaves the store's authority null, and assuming health there would
 *   reintroduce the exact false green the authority endpoint exists to
 *   expose. So null is its own branch and it is the loud one.
 * Inputs: authority - the last `GET /projects/authority` body, or null.
 * Output: AuthorityBanner.
 * Example: authorityBanner(null)  // {kind: 'unknown'}
 */
export function authorityBanner(
    authority: ProjectAuthority | null | undefined,
): AuthorityBanner {
    if (authority === null || authority === undefined) return { kind: 'unknown' };
    if (!authority.degraded) return { kind: 'none' };
    const mode = authority.mode || '';
    return {
        kind: 'degraded',
        mode,
        writable: !!authority.writable,
        // The server's own sentence, falling back to the bare mode token
        // when it sent none. Data, not copy: it is not translated.
        message: authority.message || mode,
    };
}
