/**
 * THE MERGED PROJECT LIST: one flat, fuzzily-filterable list of projects
 * with the machine demoted to a badge and a filter.
 *
 * -----------------------------------------------------------------
 * WHAT `archive-nav-merged.js` MERGES: NOTHING. Traced before this was
 * rewritten, because the file's name says otherwise and a reimplementation
 * from the name would have invented a merge.
 * -----------------------------------------------------------------
 * THE MERGE IS THE SERVER'S. `src/core/archive_project_names.py::merge_projects`
 * collapses per-corpus project rows into one node per real project,
 * KEYED ON `observed_cwd`. A row with no `observed_cwd` cannot be proved
 * to be the same project as any other, so it keys on its own project id
 * and stays separate - the safe direction, because wrongly SPLITTING a
 * project shows two nodes and wrongly MERGING two shows a project that
 * does not exist. `hosts` is the sorted set of member host names;
 * `transcript_count` sums the members and is null if ANY member's count
 * is missing, because a total that silently omits an unmeasured member
 * is a number nobody measured; `session_count` obeys the identical rule
 * and carries `session_counted` beside it. Nodes come back sorted by
 * lowercased display_name then full_path.
 *
 * The client file called "merged" only ever CONSUMED those nodes. It
 * does three things and none of them is a merge: it narrows the list to
 * one machine, it orders and fuzzily ranks it, and it decides which
 * unattributed corpus rows get a node. Those three are what is here.
 *
 * THE MACHINE MOVED, IT DID NOT GO AWAY. The old rail made the host a
 * LEVEL you clicked through. The owner is consolidating onto one
 * machine, at which point "which box was this born on" stops being worth
 * two clicks and becomes worth a badge. So every node carries its
 * `hosts` as badges, a node on two machines says so on its face, and
 * `hostId` narrows the list. Nothing is discarded. Measured 2026-09-01:
 * 80 project rows merge to 77 nodes and exactly 3 projects exist on both
 * machines, with byte-identical observed_cwd on each - which is what
 * makes the merge a statement about identity rather than a relabel.
 *
 * ORDER FIRST, THEN RANK, AND THAT SEQUENCE IS THE POINT. When there is
 * no filter text the ranker preserves input order, so the chosen order
 * is what shows. When there IS filter text, RELEVANCE WINS - a person
 * who has typed is looking for one project, and re-sorting his best
 * match to the bottom because it happens to be old would make the filter
 * useless. The order still decides ties, because it is the input order
 * the ranker preserves.
 *
 * Ported from client/js/archive-nav-merged.js. Its `paint()` and
 * `paintHostSelect()` were DOM builders; the Svelte templates render
 * those, so what is here is the model `paint()` computed before it drew.
 */
import { renderCount, shouldShowUnattributed, type NavRowData } from './nav-row';
import { rank, type FuzzyField, type RankedNavRow } from './nav-fuzzy';
import { sortNodes, type OrderableNode, type UnsortedReason } from './nav-order';

/** Fields the fuzzy filter searches, strongest first. */
export const FIELDS: readonly FuzzyField[] = [
    { name: 'display_name', weight: 3 },
    { name: 'full_path', weight: 1 },
    { name: 'observed_cwd', weight: 1 },
];

/** A merged project node as the endpoint returns it. */
export interface MergedNode extends OrderableNode {
    readonly project_id?: number | string | null;
    readonly hosts?: readonly string[];
    readonly members?: readonly { host_id?: number | string | null }[];
}

/**
 * Keep only the projects with a member on one machine.
 *
 * Description: `null` or '' means every machine and returns the list as
 *   given - NOT an empty list, which would read as "this machine has no
 *   projects".
 * Inputs: nodes - merged project nodes. hostId - the machine, or null.
 * Output: the subset, order preserved.
 * Example: filterByHost(nodes, 2).length   // -> 4
 */
export function filterByHost<T extends MergedNode>(
    nodes: readonly T[] | null | undefined,
    hostId: number | string | null | undefined,
): readonly T[] {
    const list = Array.isArray(nodes) ? nodes : [];
    if (hostId === null || hostId === undefined || hostId === '') return list.slice();
    const want = String(hostId);
    return list.filter((node) => {
        const members = (node && node.members) || [];
        return members.some((m: { host_id?: number | string | null }) =>
            String(m.host_id) === want);
    });
}

/** One unattributed corpus row and the verdict about showing it. */
export interface UnattributedEntry {
    readonly row: NavRowData;
    readonly reason: string;
}

/** Which unattributed rows get a node, and which do not. */
export interface UnattributedSplit {
    readonly shown: readonly UnattributedEntry[];
    readonly hidden: readonly UnattributedEntry[];
}

/**
 * Which unattributed corpus rows get a node, and why.
 *
 * Description: returns the REJECTED rows too, so a caller can report "2
 *   corpora had none" instead of silently rendering fewer nodes than
 *   there are corpora.
 * Inputs: rows - `meta.unattributed.by_corpus`.
 * Output: both halves, each entry carrying its reason.
 * Example: partitionUnattributed(rows).shown.length   // -> 1
 */
export function partitionUnattributed(
    rows: readonly NavRowData[] | null | undefined,
): UnattributedSplit {
    const list = Array.isArray(rows) ? rows : [];
    const shown: UnattributedEntry[] = [];
    const hidden: UnattributedEntry[] = [];
    for (const row of list) {
        // The server's block spells the count `transcript_count`; the
        // rail's rule reads `unattributed_transcript_count`. Mapped here,
        // once, rather than teaching the rule a second field name it
        // would then have to keep in step.
        const verdict = shouldShowUnattributed({
            unattributed_transcript_count: row.transcript_count,
            counted: row.counted,
        });
        (verdict.show ? shown : hidden).push({ row, reason: verdict.reason });
    }
    return { shown, hidden };
}

/** The host-filtered, ordered list plus the reason each parked row parked. */
export interface NormalizedProjects<T> {
    readonly ordered: readonly T[];
    /** Keyed on `full_path`. See `normalizedProjects` for why not the name. */
    readonly parkedReasons: Readonly<Record<string, UnsortedReason>>;
}

/**
 * The host-filtered, ordered project list, and why anything was parked.
 *
 * Description: parked reasons are keyed on `full_path`, which is the
 *   slug and is unique per node. `display_name` is deliberately NOT
 *   unique - the server widens it only as far as it has to - and would
 *   collide.
 *
 *   MEMOISATION IS THE CALLER'S JOB HERE, unlike the vanilla module.
 *   That file kept a module-level one-entry cache because `paint()` ran
 *   on every keystroke and re-filtered and re-sorted each time. Svelte's
 *   `$derived` already recomputes only when its inputs change, so a
 *   second cache inside this function would be a private copy of state
 *   the framework is already tracking - and a module-level one would be
 *   shared by every rail mounted in the process, which is the bug a
 *   component-scoped derivation cannot have.
 * Inputs: nodes, hostId, orderMode.
 * Output: the ordered list and the parked reasons.
 * Example: normalizedProjects(nodes, null, 'recent').ordered.length
 */
export function normalizedProjects<T extends MergedNode>(
    nodes: readonly T[] | null | undefined,
    hostId: number | string | null | undefined,
    orderMode: unknown,
): NormalizedProjects<T> {
    const filtered = filterByHost(nodes, hostId);
    const sorted = sortNodes(filtered, orderMode);
    const parkedReasons: Record<string, UnsortedReason> = {};
    for (const entry of sorted.parked) {
        parkedReasons[String(entry.node.full_path)] = entry.reason;
    }
    return { ordered: sorted.nodes, parkedReasons };
}

/** One project row ready to draw: ranked, marked, and possibly parked. */
export interface PaintedProject<T> extends RankedNavRow<T> {
    /** The reason this row is not in the order, or null. */
    readonly unsorted: UnsortedReason | null;
}

/** Everything the merged view draws, and the numbers to say about it. */
export interface MergedPaint<T> {
    readonly projects: readonly PaintedProject<T>[];
    readonly unattributed: readonly UnattributedEntry[];
    /** Rows drawn after the fuzzy filter. */
    readonly rendered: number;
    /** Rows the host filter and the order left to rank. */
    readonly total: number;
    /** Unattributed rows suppressed on a MEASURED zero. */
    readonly hiddenUnattributed: number;
}

/**
 * Everything the merged view draws, for one set of inputs.
 *
 * Description: the model the vanilla `paint()` computed before it began
 *   appending elements. THE UNATTRIBUTED NODES SIT AFTER THE PROJECTS
 *   AND ARE NOT SUBJECT TO THE FUZZY FILTER: they are a scope, not a
 *   project, and filtering them out by name would hide the one
 *   population that is already invisible from the project tree. They are
 *   therefore dropped entirely while filter text is present, exactly as
 *   the original did, rather than being ranked against a name they do
 *   not have.
 * Inputs: nodes, unattributed - `meta.unattributed.by_corpus`, hostId,
 *   filterText, orderMode.
 * Output: the rows to draw and the counts to report.
 * Example: paintMerged(nodes, [], null, 'med', 'recent').rendered
 */
export function paintMerged<T extends MergedNode>(
    nodes: readonly T[] | null | undefined,
    unattributed: readonly NavRowData[] | null | undefined,
    hostId: number | string | null | undefined,
    filterText: unknown,
    orderMode: unknown,
): MergedPaint<T> {
    const text = String(filterText || '');
    const normalized = normalizedProjects(nodes, hostId, orderMode);
    const ranked = rank(normalized.ordered, text, FIELDS);
    const projects = ranked.map((hit) => ({
        ...hit,
        // Present even when null, so the row has one code path and
        // cannot leave a stale marker behind on a repaint.
        unsorted: normalized.parkedReasons[String(hit.row.full_path)] || null,
    }));
    const split = partitionUnattributed(unattributed);
    return {
        projects,
        unattributed: text ? [] : split.shown,
        rendered: projects.length,
        total: normalized.ordered.length,
        hiddenUnattributed: split.hidden.length,
    };
}

/** One entry in the machine filter. */
export interface HostOption {
    readonly value: string;
    readonly label: string;
}

/**
 * The machine filter's options, from the hosts the SERVER named.
 *
 * Description: built from `meta.hosts` so the rail can never invent a
 *   machine or miss one. The leading "all" entry carries an EMPTY value,
 *   which `filterByHost` reads as every machine.
 * Inputs: hosts - `meta.hosts`.
 * Output: the options, the "all" entry first.
 * Example: hostOptions([{host_id: 2, display_name: 'mini', project_count: 4}])
 */
export function hostOptions(
    hosts: readonly NavRowData[] | null | undefined,
): readonly HostOption[] {
    const list = Array.isArray(hosts) ? hosts : [];
    return [
        { value: '', label: 'All machines' },
        ...list.map((h) => ({
            value: String(h.host_id),
            // Routed through the rail's one count formatter so the
            // machine filter cannot show a bare 0 where the rest of the
            // rail shows NOT KNOWN for the same absence.
            label: `${String(h.display_name)} (${renderCount(h.project_count)})`,
        })),
    ];
}
