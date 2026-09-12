/**
 * The join: which project owns each session, and which sessions cannot
 * be placed at all.
 *
 * SLICE 4. This is `Launchpad._buildProjectSessionGroups` and
 * `Launchpad._endedSessionsForTree`, ported branch by branch rather than
 * rewritten. It is the highest-risk code in the slice for one reason:
 * every branch that fails to route a session to NEEDS ATTENTION routes
 * it somewhere that LOOKS FINE. A lost rung does not throw, does not log
 * and does not render an error - it renders a green tree with a session
 * quietly filed under a project nobody proved it belongs to, or under
 * "no project" when the truth is "the working directory could not be
 * read". That is the false green this whole screen exists to remove, so
 * there are FIVE distinct attention reasons in the live pass and TWO
 * more in the ended pass, each one named, each one asserted by name in
 * ./project-groups.test.ts.
 *
 * THE REASONS ARE CATALOG KEYS, NOT SENTENCES. A reason is a
 * user-visible explanation, so it belongs in the string catalog; making
 * it a key rather than English prose also means a test asserts the
 * BRANCH TAKEN rather than a sentence somebody could reword without
 * noticing they changed the meaning. The one exception is
 * `listingUnreadable`, which carries an optional `detail` because the
 * server's own explanation of why the records fetch failed outranks any
 * sentence this tree could write - it knows which read failed and this
 * does not.
 *
 * THE INSTANCE KEY IS IMPORTED, NEVER REBUILT. `instanceKey` lives in
 * ../sessions/attribution.ts, which is what WRITES the map this file
 * reads. Two derivations of one key are two keys the moment one of them
 * changes, and the failure mode is a silent miss that falls through to
 * the name-only rung - which is exactly the archived-older-instance bug
 * the exact rung exists to prevent.
 *
 * THIS FILE IS PURE. No DOM, no fetch, no store import, no rune. It
 * takes a snapshot in and hands a grouping out, which is what makes the
 * seven attention branches testable without a browser.
 */
import { instanceKey } from '../sessions/attribution';
import type { RunningSessionRow, SessionRecord } from '../sessions/types';

/**
 * Why a session could not be attributed to a project.
 *
 * Description: the FIVE live reasons and the TWO ended ones, as catalog
 *   keys. Two ended variants exist rather than reusing the live keys
 *   because the sentence a user needs is different: an ended session
 *   whose directory could not be read is not a thing to go and fix, it
 *   is a thing to know about a row that is already over.
 */
export const ATTENTION_REASON = {
    /** 1. The whole `GET /sessions/records` fetch did not answer. */
    listingUnreadable: 'project.attention.listing_unreadable',
    /** 2. Two stored rows carry this tmux name and neither could be ranked. */
    ambiguousName: 'project.attention.ambiguous_name',
    /** 3. The fetch answered and holds nothing for this session. */
    noRecord: 'project.attention.no_record',
    /** 4. `project_attribution === 'unknown'`: the cwd was not readable. */
    dirUnreadable: 'project.attention.dir_unreadable',
    /** 5. An attribution that is neither none nor unknown and has no id. */
    noProjectId: 'project.attention.no_project_id',
    /** 4 prime, for a row whose session already ended. */
    endedDirUnreadable: 'project.attention.ended_dir_unreadable',
    /** 5 prime, for a row whose session already ended. */
    endedNoProjectId: 'project.attention.ended_no_project_id',
} as const;

/** One of the seven reason keys above. */
export type AttentionReason =
    (typeof ATTENTION_REASON)[keyof typeof ATTENTION_REASON];

/**
 * A session row as the TREE reads it: a live row, or an ended one.
 *
 * Description: `ended` is the discriminator and it is present-and-true
 *   only on rows built by `endedSessionsForTree`. The extra fields are
 *   the ones only a stored record carries.
 */
export interface TreeSessionRow extends RunningSessionRow {
    /** True only for a row with no live tmux instance behind it. */
    ended?: boolean;
    session_uuid?: string | null;
    working_dir?: string | null;
    title?: string | null;
    project_id?: number | null;
    project_attribution?: string | null;
}

/** One un-attributable session, with the reason it could not be placed. */
export interface AttentionItem {
    session: TreeSessionRow;
    /** A catalog key. Never an assembled sentence. */
    reasonKey: AttentionReason;
    /**
     * The server's own explanation, when it sent one.
     *
     * Set ONLY for `listingUnreadable`, and it outranks the key's
     * message because the server knows which read failed. It is data
     * rather than this tree's copy, so it is not translated and the
     * coverage guard does not look for it in the catalog.
     */
    detail?: string | null;
}

/** The grouping the tree paints. */
export interface ProjectSessionGroups {
    /** Sessions under each project row id. Live first, ended appended. */
    byProjectId: Map<number, TreeSessionRow[]>;
    /** `project_attribution === 'none'`: a MEASURED answer, not a failure. */
    noProject: TreeSessionRow[];
    /** Everything that could not be evaluated. Never rendered as green. */
    needsAttention: AttentionItem[];
}

/** Everything the join reads. Passed in, so the rules stay pure. */
export interface JoinInput {
    runningSessions: RunningSessionRow[];
    sessionRecords: SessionRecord[];
    /** Name-only fallback rung. Never holds an archived row. */
    sessionAttribution: Map<string, SessionRecord>;
    /** Instance-exact rung, keyed by `instanceKey`. DOES hold archived rows. */
    sessionAttributionByInstance: Map<string, SessionRecord>;
    /** Names that could not be ranked. A refusal, never a silent pick. */
    sessionAttributionAmbiguous: Set<string>;
    /** Whether the records fetch answered at all. */
    sessionAttributionListingOk: boolean;
    /** The server's reason it did not. */
    sessionAttributionListingDetail: string | null;
}

/**
 * The stored sessions that ENDED, shaped like running-session rows.
 *
 * Description: the rows the tree must show but no live probe can name.
 *   Four filters, each load-bearing and each ported verbatim:
 *
 *     archived_at    ARCHIVED. The user pressed archive; it is off his
 *                    screens. This is the ONE thing that hides a row and
 *                    it hides it WHATEVER its lifecycle, including one
 *                    that is somehow still running - or "archive" would
 *                    quietly mean "archive unless it is busy".
 *     lifecycle      only `stopped` and `dead` are ENDED. A `running`
 *                    row is the live probe's business. An `unknown` row
 *                    is a CANNOT DETERMINE and is NOT promoted to ended
 *                    here; the live pass routes it to NEEDS ATTENTION,
 *                    which is where an unevaluable row belongs.
 *     live name      a name the probe DID list is a live session, so the
 *                    stored row is merely stale. Never render both.
 *     replaced       a RUNNING row naming this one as its parent means
 *                    this row is already on screen as that successor.
 *                    The live-name check cannot catch it: the two rows
 *                    legitimately carry different tmux names.
 *
 *   THE THREE-OUTCOME GATE. When the listing did not answer this returns
 *   NOTHING. Inventing ended rows out of a failed read is the exact
 *   false green this screen keeps removing, and the live pass already
 *   routes every row to NEEDS ATTENTION in that case, which is honest.
 * Inputs: input - the join snapshot.
 * Output: TreeSessionRow[] - ended rows, empty when the fetch did not answer.
 * Example: endedSessionsForTree(input)  // [{name: 'cloude_a', ended: true}]
 */
export function endedSessionsForTree(input: JoinInput): TreeSessionRow[] {
    if (!input.sessionAttributionListingOk) return [];
    const liveNames = new Set(
        (input.runningSessions || []).map((s) => s.name),
    );
    const records = input.sessionRecords || [];
    const replacedByRunning = new Set<string>();
    for (const rec of records) {
        if (!rec || rec.lifecycle !== 'running') continue;
        const parent = rec.parent_session_id;
        if (parent !== null && parent !== undefined && parent !== '') {
            replacedByRunning.add(String(parent));
        }
    }
    const out: TreeSessionRow[] = [];
    for (const rec of records) {
        if (!rec || rec.archived_at) continue;
        if (rec.lifecycle !== 'stopped' && rec.lifecycle !== 'dead') continue;
        if (rec.tmux_name && liveNames.has(rec.tmux_name)) continue;
        if (rec.id !== null && rec.id !== undefined
            && replacedByRunning.has(String(rec.id))) continue;
        out.push({
            name: rec.tmux_name || '',
            label: rec.title || null,
            title: rec.title || null,
            session_uuid: rec.session_uuid,
            ended: true,
            status: 'stopped',
            is_active: false,
            created_by_cloude: !!rec.owned,
            created_at_epoch: rec.tmux_created_epoch || 0,
            working_dir: rec.working_dir || '',
            agent_type: rec.agent_type || '',
            agent_family: rec.agent_family || null,
            agent_family_source: rec.agent_family_source || null,
            project_id: rec.project_id,
            project_attribution: rec.project_attribution,
            // The durable row id, under the name every other surface
            // already uses for it.
            session_row_id: (rec.id === undefined ? null : rec.id),
        });
    }
    return out;
}

/**
 * Push one session into the project bucket it names.
 *
 * Description: extracted because the live pass and the ended pass share
 *   this exact shape and nothing else, and two copies of a `Map` upsert
 *   are two places a `set` can be forgotten.
 * Inputs: byProjectId - the accumulator. id - the project row id.
 *   session - the row.
 * Output: void.
 * Example: pushChild(byProjectId, 7, row)
 */
function pushChild(
    byProjectId: Map<number, TreeSessionRow[]>,
    id: number,
    session: TreeSessionRow,
): void {
    const list = byProjectId.get(id) || [];
    list.push(session);
    byProjectId.set(id, list);
}

/**
 * Cross-reference the live sessions against their stored records.
 *
 * Description: THE FIVE LIVE ATTENTION REASONS, in the order they are
 *   tested, and the order matters because an earlier rung continues past
 *   the rest:
 *
 *     1. listingUnreadable - the whole fetch failed, so nothing below it
 *        can be trusted and EVERY row lands here.
 *     2. ambiguousName - two stored rows for this name. Only reachable
 *        after the instance-exact rung missed.
 *     3. noRecord - the fetch answered and holds nothing for this row.
 *     4. dirUnreadable - `project_attribution === 'unknown'`, which is
 *        NOT an answer and must never render as "no project".
 *     5. noProjectId - an attribution that is neither `none` nor
 *        `unknown` and carries no id. Defensive: never guess which
 *        project it meant.
 *
 *   INSTANCE-EXACT FIRST. A running row carrying its own tmux creation
 *   epoch resolves its EXACT stored row rather than by name, which is
 *   what stops an archived OLDER instance of the same tmux name from
 *   ever being considered for a currently-live session.
 *
 *   DELETED WINS OVER LIVE. A row the user archived stays off the tree
 *   even if its tmux session is somehow still up, because deleting is a
 *   decision about the user's list and not about the process. Without
 *   it the rule reads "deleted, unless it happens to still be running",
 *   which is an exception nobody can predict from the button's label.
 *   Reached only through the instance-exact path, since the name-only
 *   fallback never yields an archived row - so this is specifically
 *   "the live session's OWN record was archived", not "some unrelated
 *   older instance of this name was".
 *
 *   ENDED ROWS ARE APPENDED, NOT MERGED, and the order is the point: a
 *   dead row sitting above the session he is working in is technically
 *   correct and practically wrong. Live first, ended underneath, in
 *   every group.
 * Inputs: input - the join snapshot.
 * Output: ProjectSessionGroups.
 * Example: const groups = buildProjectSessionGroups(input);
 */
export function buildProjectSessionGroups(input: JoinInput): ProjectSessionGroups {
    const byProjectId = new Map<number, TreeSessionRow[]>();
    const noProject: TreeSessionRow[] = [];
    const needsAttention: AttentionItem[] = [];
    const sessions = input.runningSessions || [];

    for (const s of sessions) {
        // REASON 1.
        if (!input.sessionAttributionListingOk) {
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.listingUnreadable,
                detail: input.sessionAttributionListingDetail || null,
            });
            continue;
        }

        let rec: SessionRecord | null = null;
        if (s.created_at_epoch) {
            const key = instanceKey(s.name, s.created_at_epoch);
            if (input.sessionAttributionByInstance.has(key)) {
                rec = input.sessionAttributionByInstance.get(key) || null;
            }
        }

        if (!rec) {
            // REASON 2. Only reachable once the exact instance missed.
            if (input.sessionAttributionAmbiguous.has(s.name)) {
                needsAttention.push({
                    session: s,
                    reasonKey: ATTENTION_REASON.ambiguousName,
                });
                continue;
            }
            rec = input.sessionAttribution.get(s.name) || null;
        }

        // REASON 3.
        if (!rec) {
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.noRecord,
            });
            continue;
        }

        // DELETED WINS OVER LIVE.
        if (rec.archived_at) continue;

        const attribution = rec.project_attribution;
        if (attribution === 'unknown') {
            // REASON 4.
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.dirUnreadable,
            });
        } else if (attribution === 'none') {
            noProject.push(s);
        } else if (rec.project_id !== null && rec.project_id !== undefined) {
            pushChild(byProjectId, rec.project_id, s);
        } else {
            // REASON 5.
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.noProjectId,
            });
        }
    }

    for (const s of endedSessionsForTree(input)) {
        if (s.project_attribution === 'unknown') {
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.endedDirUnreadable,
            });
        } else if (s.project_attribution === 'none') {
            noProject.push(s);
        } else if (s.project_id !== null && s.project_id !== undefined) {
            pushChild(byProjectId, s.project_id, s);
        } else {
            needsAttention.push({
                session: s,
                reasonKey: ATTENTION_REASON.endedNoProjectId,
            });
        }
    }

    return { byProjectId, noProject, needsAttention };
}

/**
 * The identity a keyed each block tracks one session row by.
 *
 * Description: THE PERFORMANCE CLAIM RESTS ON THIS FUNCTION, and it is
 *   the piece that is easy to get subtly wrong. Every poll tick replaces
 *   the whole `runningSessions` array with fresh objects, so object
 *   identity is useless and a keyed block is the only thing that can
 *   tell Svelte "this is the same row as last time, update it rather
 *   than rebuilding it". An UNSTABLE key silently reverts the whole
 *   slice to the legacy behaviour - the subtree is torn down and rebuilt
 *   every five seconds - and nothing about the rendered markup is wrong
 *   when that happens, so no rendering test would notice. The mutation
 *   count in ./mutation-count.test.ts is what notices.
 *
 *   THREE PARTS, AND EACH ONE EARNS ITS PLACE. The `ended` flag comes
 *   first because a name can move between the live and ended halves of
 *   one group and those are two different components; the tmux name is
 *   the handle; and the creation epoch is what keeps two instances of a
 *   reused name apart, which is the same reason the attribution join
 *   keys on it.
 * Inputs: row - one tree row.
 * Output: string - stable for as long as the row is the same instance.
 * Example: rowKey({name: 'cloude_api', created_at_epoch: 17, ended: true})
 *   // 'e:cloude_api:17'
 */
export function rowKey(row: TreeSessionRow): string {
    return (row.ended ? 'e:' : 'l:') + row.name + ':' + (row.created_at_epoch || 0);
}
