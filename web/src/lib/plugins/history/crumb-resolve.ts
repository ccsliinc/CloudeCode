/**
 * NAMING A PROJECT NOBODY CLICKED. PORTED from
 * `client/js/archive-crumb-resolve.js`, deleted in the same commit.
 *
 * The crumb learns a project's name from the row the user selected in
 * the rail - which is fine until the user arrives by URL, at which point
 * no row was ever clicked and the crumb has nothing to say. A fresh deep
 * link to `/archive/p/<id>` therefore rendered `project NOT NAMED YET`
 * permanently, not for a beat: the fact was never going to arrive,
 * because the only thing that produced it was a click that never
 * happened.
 *
 * That is a worse failure than it looks. NOT NAMED YET is honest for a
 * fact still in flight, and this module exists so it keeps meaning that.
 * Left as it was, the one string covered both "not yet" and "never", and
 * a permanent unknown wearing the label of a temporary one is the
 * false-green shape the rest of this screen is written against.
 *
 * WHY IT READS THE MERGED LIST RATHER THAN ADDING A ROUTE. The merged
 * project list is ONE unpaginated request the rail already makes, it
 * already carries `display_name` for every project, and it already
 * carries `members`, which is the only place the ids of the folded-up
 * projects survive. A per-id lookup route would be a second way to ask a
 * question this response already answers, and it would have to re-derive
 * the same names from the same rows.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS NOT A NAME.
 *   - `name`             - the id was found; the node is returned.
 *   - `unresolved`       - the list was read and this id is not in it.
 *   - `cannot_determine` - the list could not be read at all.
 * Only the first ever reaches the crumb. The other two leave NOT NAMED
 * YET standing, because a crumb that invents a name is worse than one
 * that admits it has none - a wrong name is believable.
 *
 * A FAILED READ IS NOT CACHED. The successful list is memoised, so a
 * session costs one request no matter how many projects are opened; a
 * failure clears the memo so the next navigation retries rather than
 * inheriting one bad minute for the life of the tab.
 *
 * WHAT THE PORT CHANGED. It took `window.API` and reached
 * `window.ArchiveCrumb.indexNodes`; it now takes the GRANTED client and
 * imports `indexNodes` directly. A refusal from the grant lands in the
 * same `catch` as a transport error and answers `cannot_determine`,
 * which is the honest answer: the list could not be read. The refusal
 * itself is still named and logged by `screen-api.ts`, so the two are
 * distinguishable where it matters even though this caller treats them
 * alike - and it treats them alike because it does exactly the same
 * thing with both.
 */
import { indexNodes, type ProjectNode } from './crumb';
import type { ScreenApi } from '../types';

/** The id was found and the node is a real name. */
export const NAME = 'name';
/** The list was read; this id is not in it. */
export const UNRESOLVED = 'unresolved';
/** The list could not be read. NOT the same as an empty list. */
export const CANNOT_DETERMINE = 'cannot_determine';

/** Which of the three a resolution was. */
export type ResolveStatus = 'name' | 'unresolved' | 'cannot_determine';

/** The answer: the node when there is one, and which of the three it is. */
export interface ResolveResult {
    readonly node: ProjectNode | null;
    readonly status: ResolveStatus;
}

/** The route the merged project list lives on, relative to `/api/v1`. */
const MERGED_PROJECTS_PATH = '/archive/overlay/projects';

/** The envelope shape this reads, as much of it as it reads. */
interface Envelope {
    result_status?: string;
    result?: unknown;
}

/** What a resolver offers. */
export interface CrumbResolver {
    resolve(projectId: number | string | null | undefined): Promise<ResolveResult>;
}

/**
 * Build a resolver that turns a project id into the merged node
 * describing it, reading the merged project list at most once per
 * success.
 * Inputs: api - the screen's granted client.
 * Output: CrumbResolver.
 * Example: createResolver(api).resolve(48)
 *          //   -> {node: {display_name: 'Infrastructure', ...},
 *          //       status: 'name'}
 */
export function createResolver(api: ScreenApi): CrumbResolver {
    let pending: Promise<{ status: ResolveStatus;
                           index: Record<string, ProjectNode> | null }> | null = null;

    /** The id -> node index, memoised on success only. */
    function load(): Promise<{ status: ResolveStatus;
                               index: Record<string, ProjectNode> | null }> {
        if (pending) return pending;
        pending = Promise.resolve()
            .then(() => api.call(MERGED_PROJECTS_PATH))
            .then((r) => {
                const reply = r as { transportError?: unknown; envelope?: Envelope } | null;
                const env = reply && reply.envelope;
                // A transport error, a missing envelope, a non-ok status
                // or a non-array result are all "could not read", and
                // none of them is an empty list.
                if (!reply || reply.transportError || !env) return null;
                if (env.result_status !== 'ok') return null;
                if (!Array.isArray(env.result)) return null;
                return indexNodes(env.result as ProjectNode[]);
            })
            .catch(() => null)
            .then((index) => {
                if (index === null) {
                    // Do not poison the tab with one bad request.
                    pending = null;
                    return { status: CANNOT_DETERMINE as ResolveStatus, index: null };
                }
                return { status: NAME as ResolveStatus, index };
            });
        return pending;
    }

    /** The merged node that names this project id. */
    function resolve(
        projectId: number | string | null | undefined,
    ): Promise<ResolveResult> {
        if (projectId === null || projectId === undefined) {
            return Promise.resolve({ node: null, status: UNRESOLVED as ResolveStatus });
        }
        return load().then((r) => {
            if (!r.index) {
                return { node: null, status: CANNOT_DETERMINE as ResolveStatus };
            }
            const node = r.index[String(projectId)] || null;
            return { node, status: (node ? NAME : UNRESOLVED) as ResolveStatus };
        });
    }

    return { resolve };
}
