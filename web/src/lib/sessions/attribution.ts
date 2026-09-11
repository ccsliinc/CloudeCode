/**
 * The tmux-identity to stored-row join, and the work order built from it.
 *
 * PORTED FROM `Launchpad._resolveSessionAttribution`,
 * `_buildWorkStampIndex`, `_workStampFor` and
 * `_sortRunningSessionsByWork`, LINE BY LINE.
 *
 * THE INCIDENT THIS ENCODES, measured live: `GET /sessions/records`
 * returns newest-first and INCLUDES archived rows. The old code built its
 * `tmux_name -> row` map with a plain `map.set()` loop over that list, so
 * the OLDEST row won (a forward scan over a newest-first list is
 * last-write-wins-on-the-oldest) and an archived row was never excluded.
 * Two tmux instances legitimately share a `tmux_name`, because a session
 * recreated after its pane died reuses the name with a new
 * `tmux_created_epoch`; when the older one got archived, its row shadowed
 * the newer running one and the running session vanished from its project
 * entirely - a session disappearing being the worst possible rendering of
 * "attribution is unknown" (row id 3, archived, epoch 1787686975 beat row
 * id 4, running, epoch 1788016091).
 *
 * SO THERE ARE THREE STRUCTURES, NOT ONE MAP, AND BOTH RUNGS SURVIVE.
 * `byInstance` is the exact rung and `byName` the weaker fallback;
 * `ambiguous` is the refusal. A caller that collapsed them into one map
 * would reintroduce the defect above, and one that treated `ambiguous` as
 * "no project" would render a session that has one as a session that
 * does not.
 */
import type { RunningSessionRow, SessionRecord, Translate } from './types';

/**
 * The separator inside an instance key.
 *
 * Description: a NUL byte, chosen so no tmux name can ever collide with
 *   the key of another by containing what looks like the separator
 *   followed by digits. A hyphen would let `a-1` plus epoch `2` collide
 *   with `a` plus epoch `1-2`.
 */
export const INSTANCE_KEY_SEPARATOR = '\u0000';

/** The three structures `resolveSessionAttribution` answers with. */
export interface ResolvedAttribution {
    byName: Map<string, SessionRecord>;
    byInstance: Map<string, SessionRecord>;
    ambiguous: Set<string>;
}

/**
 * The instance-exact key for one tmux name plus creation epoch.
 *
 * Description: the ONE place this key is spelled. Two spellings of a
 *   composite key are two keys the moment they disagree, and a writer and
 *   a reader that disagree lose every row silently.
 * Inputs: name (string), epoch (number|string).
 * Output: string.
 * Example: instanceKey('cloude_api', 1788016091)
 */
export function instanceKey(name: string, epoch: number | string): string {
    return name + INSTANCE_KEY_SEPARATOR + epoch;
}

/**
 * Resolve the tmux-identity to stored-row join used for project
 * attribution, from a raw `GET /sessions/records` payload.
 *
 * Description: builds three structures.
 *
 *   `byInstance` is keyed on the composite instance identity
 *   `${tmux_name}\u0000${tmux_created_epoch}`. It INCLUDES ARCHIVED ROWS
 *   on purpose: a caller holding a live session's own creation epoch can
 *   resolve its EXACT row this way, including the case where the user
 *   archived that exact instance's record. The row still comes back and
 *   the caller drops it on `archived_at`, which is what keeps "delete
 *   this session's record" working without letting an unrelated archived
 *   row from an OLDER instance of the same name shadow a live one.
 *
 *   `byName` is the weaker name-only fallback, for a caller that cannot
 *   supply an epoch or whose exact key is not found. It NEVER contains an
 *   archived row: an archived row must not shadow a live session under a
 *   name-only join. Among the remaining candidates for a name, the row
 *   with the newest `tmux_created_epoch` wins, resolved by scanning every
 *   candidate for the true maximum, so the winner does not depend on the
 *   order rows arrived in.
 *
 *   `ambiguous` holds names where two or more non-archived candidates
 *   could not be ranked - a real tie on the newest epoch, or a candidate
 *   with no epoch recorded at all. Such a name is deliberately ABSENT
 *   from `byName`: this is a COULD-NOT-EVALUATE and the caller must
 *   report it as one rather than silently picking a row.
 *
 *   A genuine collision inside `byInstance` itself (two distinct rows
 *   claiming the identical name plus epoch pair, which should not happen
 *   but is not assumed impossible) is treated the same way: the key is
 *   dropped so a lookup reports "not found" rather than an arbitrary
 *   pick, and the caller falls through to `byName` / `ambiguous`.
 * Inputs: rows - as returned by `GET /sessions/records`: newest first,
 *   archived rows included.
 * Output: ResolvedAttribution.
 * Example:
 *   const { byName } = resolveSessionAttribution(rows);
 *   byName.get('cloude_a')  // the SessionRecord for the live instance
 */
export function resolveSessionAttribution(rows: SessionRecord[]): ResolvedAttribution {
    const byInstance = new Map<string, SessionRecord>();
    const instanceCollisions = new Set<string>();
    const candidatesByName = new Map<string, Array<{ row: SessionRecord; epoch: number | null }>>();

    for (const row of rows) {
        if (!row || !row.tmux_name) continue;
        const name = row.tmux_name;
        const epoch = (row.tmux_created_epoch === null || row.tmux_created_epoch === undefined)
            ? null
            : row.tmux_created_epoch;

        if (epoch !== null) {
            const key = instanceKey(name, epoch);
            if (byInstance.has(key)) {
                instanceCollisions.add(key);
            } else {
                byInstance.set(key, row);
            }
        }

        // Archived rows are never a candidate for the name-only
        // fallback - see the docstring above.
        if (row.archived_at) continue;

        if (!candidatesByName.has(name)) candidatesByName.set(name, []);
        candidatesByName.get(name)!.push({ row, epoch });
    }

    for (const key of instanceCollisions) byInstance.delete(key);

    const byName = new Map<string, SessionRecord>();
    const ambiguous = new Set<string>();
    for (const [name, candidates] of candidatesByName) {
        if (candidates.length === 1) {
            // Length checked on the line above; the assertion is for
            // `noUncheckedIndexedAccess`, not a claim about the data.
            byName.set(name, candidates[0]!.row);
            continue;
        }
        // Two or more non-archived rows share this name. A row with no
        // recorded epoch can never be ranked against another, so its
        // mere presence makes the whole name ambiguous.
        if (candidates.some((c) => c.epoch === null)) {
            ambiguous.add(name);
            continue;
        }
        const maxEpoch = Math.max(...candidates.map((c) => c.epoch as number));
        const winners = candidates.filter((c) => c.epoch === maxEpoch);
        if (winners.length > 1) {
            ambiguous.add(name);
            continue;
        }
        // `winners` is non-empty by construction: `maxEpoch` came from
        // this very list, so at least one candidate equals it.
        byName.set(name, winners[0]!.row);
    }

    return { byName, byInstance, ambiguous };
}

/**
 * Build the tmux-name to newest `last_work_at` index the ordering reads.
 *
 * Description: the MAXIMUM stamp per tmux name, not the stamp on
 *   whichever row happened to be scanned last. A name is reusable - this
 *   app itself re-mints one with a -2/-3 uniquifier, and a session
 *   recreated after its pane died takes the name back with a new creation
 *   epoch - so several rows can carry one name. Taking the maximum is
 *   correct without needing to know which row is live, because a dead
 *   instance cannot have worked more recently than the one that replaced
 *   it.
 *
 *   ARCHIVED ROWS ARE INCLUDED, deliberately and unlike `byName`.
 *   Archiving is the user saying "take this off my screen"; it says
 *   nothing about when work happened, and a row that is off screen
 *   contributes no row to order anyway. Excluding it could only
 *   understate a live session's own history if the two shared a name.
 *
 *   A row with no `last_work_at` contributes NOTHING rather than a zero -
 *   an absent name in this map is the third outcome the callers read as
 *   "unrecorded".
 * Inputs: rows - `GET /sessions/records` payload.
 * Output: Map of tmux name to ISO stamp.
 * Example: buildWorkStampIndex(rows).get('cloude_api')
 */
export function buildWorkStampIndex(rows: SessionRecord[] | unknown): Map<string, string> {
    const index = new Map<string, string>();
    for (const row of (Array.isArray(rows) ? rows : []) as SessionRecord[]) {
        if (!row || !row.tmux_name || !row.last_work_at) continue;
        const seen = index.get(row.tmux_name);
        if (!seen || row.last_work_at > seen) {
            index.set(row.tmux_name, row.last_work_at);
        }
    }
    return index;
}

/**
 * The `last_work_at` for one running-session row, or null.
 *
 * Description: read out of the attribution fetch's own records rather
 *   than off the row, because the row comes from the tmux probe and the
 *   stamp lives in the database. Keyed by tmux NAME and resolved to the
 *   MAXIMUM stamp under that name.
 * Inputs: session - a running-session row with `name`. index - the
 *   work-stamp map.
 * Output: string | null - an ISO timestamp, or null for unrecorded.
 * Example: workStampFor(row, stamps)
 */
export function workStampFor(
    session: RunningSessionRow | null | undefined,
    index: Map<string, string> | null | undefined,
): string | null {
    if (!session || !session.name) return null;
    if (!index) return null;
    return index.get(session.name) || null;
}

/**
 * Order the running-session rows by WORK, newest work first.
 *
 * Description: THIS LIST IS A TIMELINE, and it is read by scanning down
 *   it to recall what is in flight. The previous order led with
 *   `is_active` - "is this the session I am attached to" - so clicking a
 *   row to look at it hoisted that row to the top and the timeline was
 *   destroyed by the act of reading it. That term is gone, and no term
 *   that a click can change has replaced it.
 *
 *   `last_work_at` is stamped ONLY from Claude Code hook events that mean
 *   the conversation did something. Attaching, selecting or deep-linking
 *   never moves it.
 *
 *   THREE OUTCOMES, AND UNRECORDED IS THE THIRD. A session with no
 *   `last_work_at` has not been measured working - true of every session
 *   predating the feature, and of one started seconds ago that has not
 *   run a turn yet. It is NOT treated as work at the epoch and NOT as
 *   work now: those rows sort BELOW every measured row and keep their own
 *   newest-created-first order among themselves.
 *
 *   `created_by_cloude` is kept as a tie-break only, below the work key.
 *   It is an ORIGIN fact that no click can flip, so it never
 *   reintroduces the defect.
 * Inputs: rows - sorted IN PLACE, as the legacy method did. index - the
 *   work-stamp map.
 * Output: the same array, for chaining.
 * Example: sortRunningSessionsByWork(rows, stamps)
 */
export function sortRunningSessionsByWork(
    rows: RunningSessionRow[],
    index: Map<string, string> | null | undefined,
): RunningSessionRow[] {
    rows.sort((a, b) => {
        const aw = workStampFor(a, index);
        const bw = workStampFor(b, index);
        if (!!aw !== !!bw) return aw ? -1 : 1;
        if (aw && bw && aw !== bw) return aw < bw ? 1 : -1;
        if (!!a.created_by_cloude !== !!b.created_by_cloude) {
            return a.created_by_cloude ? -1 : 1;
        }
        return (b.created_at_epoch || 0) - (a.created_at_epoch || 0);
    });
    return rows;
}

/** Everything one `GET /sessions/records` pass yields. */
export interface AttributionSnapshot {
    byName: Map<string, SessionRecord>;
    byInstance: Map<string, SessionRecord>;
    ambiguous: Set<string>;
    records: SessionRecord[];
    workStamps: Map<string, string>;
    listingOk: boolean;
    listingDetail: string | null;
}

/**
 * The empty snapshot, which is what a FAILED fetch yields.
 *
 * Description: A FAILED FETCH IS NOT AN EMPTY WORK HISTORY, and the two
 *   must not render alike. Everything is cleared so every row reads as
 *   unrecorded and is LABELLED as such, which is honest - rather than
 *   keeping a stale index and ordering the list by stamps that may no
 *   longer be current. `listingOk` false is the thing that stops these
 *   empty maps being read as "these sessions belong to no project"; it is
 *   why the detail travels with them rather than being logged.
 * Inputs: detail - the assembled sentence naming why.
 * Output: AttributionSnapshot.
 * Example: emptyAttribution(detail)
 */
export function emptyAttribution(detail: string): AttributionSnapshot {
    return {
        byName: new Map(),
        byInstance: new Map(),
        ambiguous: new Set(),
        records: [],
        workStamps: new Map(),
        listingOk: false,
        listingDetail: detail,
    };
}

/**
 * Fetch the stored session records and resolve everything derived.
 *
 * Description: the tree needs to know which project each running row
 *   belongs to, and the SAME payload carries `last_work_at`, which is the
 *   key the running list is ORDERED by - which is why one fetch feeds
 *   both and why the caller must run it BEFORE it sorts.
 *
 *   NON-FATAL, AND ITS FAILURE IS A VERDICT. A rejection degrades the
 *   tree to NEEDS ATTENTION and never throws out. A 200 whose body is not
 *   an array takes the same path with its own sentence, because an
 *   unparseable list is not an empty one.
 * Inputs: host - the endpoints. t - the translator, for the two failure
 *   sentences. malformedDetail / failedDetail - the assemblers, injected
 *   so this module carries no copy.
 * Output: Promise<AttributionSnapshot>. Never rejects.
 * Example: const snap = await loadAttribution(host, t, a, b);
 */
export async function loadAttribution(
    host: { listSessionRecords(): Promise<SessionRecord[]> },
    t: Translate,
    malformedDetail: (t: Translate) => string,
    failedDetail: (error: unknown, t: Translate) => string,
): Promise<AttributionSnapshot> {
    try {
        const rows = await host.listSessionRecords();
        if (!Array.isArray(rows)) {
            return emptyAttribution(malformedDetail(t));
        }
        const resolved = resolveSessionAttribution(rows);
        return {
            byName: resolved.byName,
            byInstance: resolved.byInstance,
            ambiguous: resolved.ambiguous,
            records: rows,
            workStamps: buildWorkStampIndex(rows),
            listingOk: true,
            listingDetail: null,
        };
    } catch (error) {
        console.warn('CloudeWeb: failed to load session attribution:', error);
        return emptyAttribution(failedDetail(error, t));
    }
}
