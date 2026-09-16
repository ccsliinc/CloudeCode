/**
 * THE ORDER THE PROJECT RAIL IS IN, and the rule that decides it.
 *
 * THE RULE, IN ONE PARAGRAPH, because this is where a silent behaviour
 * change would hide. Pick a mode. Split the nodes into the ones that
 * have a value the mode can sort on and the ones that do not. Sort the
 * first block by that value in the mode's direction, breaking ties by
 * lowercased display_name and then by full_path so the order is STABLE
 * across repaints rather than depending on the engine's tie handling.
 * Sort the second block by lowercased display_name (falling back to
 * full_path) alone, and APPEND it - in both time directions - each row
 * carrying a marker saying which kind of absence parked it. Never
 * interleave the two.
 *
 * WHY TIME IS THE DEFAULT AND NOT THE NAME. The owner asked for it in
 * those words: "we should be looking at projects in time order but we
 * should be able to change the order". The data agrees. Measured on the
 * live corpus 2026-09-02, 77 merged projects: the newest MESSAGE
 * timestamp in each spreads across nine months, 2025-12 to 2026-08. The
 * other candidate, when this tool INGESTED the files, puts all 80 rows
 * on two days in late August, so it would render 56 projects as equally
 * recent and call that an ordering.
 *
 * THREE OUTCOMES, AND THEY SORT DIFFERENTLY FROM EACH OTHER.
 * `activity_status` is 'known' (a real timestamp, sorts by it), 'none'
 * (MEASURED absence: the transcripts were read and not one message
 * carries a timestamp) or 'unknown' (NOT MEASURED: the database could
 * not answer). The last two are the ones it is tempting to collapse, and
 * collapsing them is the bug this file is arranged around. A project
 * sorted to the bottom because we could not read its date is
 * indistinguishable, from the rail, from one that is genuinely ancient -
 * and the bottom of a most-recent-first list IMPLIES a date.
 *
 * THE PARKED BLOCK KEEPS ITS PLACEMENT IN BOTH TIME DIRECTIONS, ON
 * PURPOSE. Under "oldest first" the instinct is to move the undated ones
 * to the top, since unknown-and-probably-old belongs there - but that is
 * exactly the inference the rail is not entitled to make. Undated means
 * undated in either direction, so they stay at the end and the end never
 * means a date.
 *
 * TIMESTAMPS ARE COMPARED AS STRINGS. These are ISO-8601 stamps stored
 * byte-exactly as the producer wrote them, and for that format lexical
 * order IS chronological order. Parsing them into Date objects would
 * invent a precision and a timezone the archive never claimed, and Date
 * parsing of a malformed stamp yields NaN, which compares false against
 * everything and would silently scatter rows.
 *
 * PERSISTENCE IS A CONVENIENCE, NOT STATE. The choice lives in
 * localStorage: per-viewer, harmless to lose, read back by nothing else.
 * Every read and write is wrapped, because localStorage THROWS rather
 * than returning null in a private window and under some site-data
 * policies - so an unwrapped read is not a missing preference, it is a
 * rail that does not render at all. The store is INJECTABLE, and a
 * component takes it as a prop rather than reaching for a global.
 *
 * Ported from client/js/archive-nav-order.js. The `mount()` half of that
 * file built a real `<select>` by hand; the Svelte template renders the
 * same element from `MODES`, so only the rules are here.
 */

/** Where the choice is remembered. Namespaced like the app's other keys. */
export const STORAGE_KEY = 'cloude.archive.projectOrder';

/** Status tokens the SERVER sets. Mirrored from message_activity.py. */
export const ACTIVITY_KNOWN = 'known';
/** MEASURED absence of any dated message. */
export const ACTIVITY_NONE = 'none';
/** NOT MEASURED: the database could not answer. */
export const ACTIVITY_UNKNOWN = 'unknown';

/** What a mode sorts on. */
export type OrderKind = 'time' | 'name' | 'size';

/** One ordering offered by the control. */
export interface OrderMode {
    readonly id: string;
    readonly label: string;
    readonly kind: OrderKind;
    /** 1 ascending, -1 descending. */
    readonly dir: 1 | -1;
}

/**
 * The orderings, in the order they appear in the control. `id` is what
 * is persisted, so these strings are a STORED FORMAT and must not be
 * renamed casually - an unrecognised stored id falls back to the default
 * rather than rendering an empty rail.
 *
 * `size` sorts on session_count and NOT transcript_count, because
 * sessions is the number the owner said he cares about and the two
 * differ by roughly 14x (1,451 uuid-scheme against 21,039 total,
 * measured 2026-09-02). A node whose session count could not be
 * established parks with the undated block for the same reason a missing
 * date does: it has no measured value to place it by.
 */
export const MODES: readonly OrderMode[] = [
    { id: 'recent', label: 'Recent first', kind: 'time', dir: -1 },
    { id: 'oldest', label: 'Oldest first', kind: 'time', dir: 1 },
    { id: 'name', label: 'Name (A-Z)', kind: 'name', dir: 1 },
    { id: 'size', label: 'Most sessions', kind: 'size', dir: -1 },
];

/** The mode used when nothing is stored, or what is stored is not a mode. */
export const DEFAULT_MODE = 'recent';

/**
 * Is this id one of the modes?
 *
 * Description: used instead of a truthiness check so a stored value from
 *   a future build cannot silently become a comparator nobody wrote.
 * Inputs: id. Output: whether it names a mode.
 * Example: isMode('recent')   // -> true
 */
export function isMode(id: unknown): boolean {
    return MODES.some((m) => m.id === id);
}

/**
 * The mode record for an id, or the default's record.
 *
 * Description: never returns null, so no caller has to handle a null
 *   comparator.
 * Inputs: id. Output: one of MODES.
 * Example: modeFor('nope').id   // -> 'recent'
 */
export function modeFor(id: unknown): OrderMode {
    const hit = MODES.find((m) => m.id === id);
    if (hit) return hit;
    return MODES.find((m) => m.id === DEFAULT_MODE) || (MODES[0] as OrderMode);
}

/** Where a stored mode came from. Three outcomes, never two. */
export type ModeSource = 'stored' | 'default' | 'unavailable';

/** The stored choice and how it was arrived at. */
export interface StoredMode {
    readonly mode: string;
    readonly source: ModeSource;
}

/** The two Storage methods this module uses. Injected, never reached for. */
export interface ModeStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/**
 * The stored choice, or the default. NEVER THROWS.
 *
 * Description: localStorage can throw on ACCESS - a private window, a
 *   browser set to block site data - and not merely return null, so the
 *   property lookup itself is inside the try. Three outcomes, so a
 *   caller can tell "he chose the default" from "we could not find out
 *   what he chose".
 * Inputs: store - the injected storage, or null.
 * Output: the mode and its source.
 * Example: readMode(localStorage).mode   // -> 'recent'
 */
export function readMode(store: ModeStore | null | undefined): StoredMode {
    let raw: string | null = null;
    try {
        if (!store) return { mode: DEFAULT_MODE, source: 'unavailable' };
        raw = store.getItem(STORAGE_KEY);
    } catch {
        // A storage that refuses to be read is not a missing preference,
        // and it must not take the rail down. Swallowed deliberately:
        // the outcome is reported as `unavailable`, which is the only
        // thing a caller can act on.
        return { mode: DEFAULT_MODE, source: 'unavailable' };
    }
    if (raw === null || raw === undefined) return { mode: DEFAULT_MODE, source: 'default' };
    if (!isMode(raw)) return { mode: DEFAULT_MODE, source: 'default' };
    return { mode: raw, source: 'stored' };
}

/**
 * Remember the choice. NEVER THROWS.
 *
 * Description: a failed write is reported as false and nothing else
 *   happens, because losing a preference must not cost the person the
 *   click he just made.
 * Inputs: mode, store.
 * Output: whether it was actually written.
 * Example: writeMode('name', localStorage)   // -> true
 */
export function writeMode(mode: string, store: ModeStore | null | undefined): boolean {
    if (!isMode(mode)) return false;
    try {
        if (!store) return false;
        store.setItem(STORAGE_KEY, mode);
        return true;
    } catch {
        // Same reasoning as readMode: reported, not raised.
        return false;
    }
}

/** One merged project node, as far as the ordering is concerned. */
export interface OrderableNode {
    readonly display_name?: string | null;
    readonly full_path?: string | null;
    readonly newest_activity_at?: string | null;
    readonly activity_status?: string | null;
    readonly session_count?: number | null;
    readonly session_counted?: boolean | null;
    readonly [key: string]: unknown;
}

/**
 * Does this node have a value the chosen mode can sort on?
 *
 * Description: this is the ONE place "sortable" is decided, so the
 *   comparator and the marker cannot disagree about which rows are in
 *   the ordered block and which are parked.
 * Inputs: node, kind.
 * Output: whether the mode can place it.
 * Example: hasKey({activity_status: 'none'}, 'time')   // -> false
 */
export function hasKey(node: OrderableNode | null | undefined, kind: OrderKind): boolean {
    const n = node || {};
    if (kind === 'time') {
        return n.activity_status === ACTIVITY_KNOWN
            && typeof n.newest_activity_at === 'string'
            && n.newest_activity_at !== '';
    }
    if (kind === 'size') {
        return n.session_counted !== false && typeof n.session_count === 'number';
    }
    // A name is present for every project whose observed_cwd the server
    // could read; a null display_name is the same class of absence as a
    // null date and is parked the same way.
    return typeof n.display_name === 'string' && n.display_name !== '';
}

/** Why a node has no sort key, in the words the rail shows. */
export interface UnsortedReason {
    readonly short: string;
    readonly title: string;
}

/**
 * Why this node has no sort key.
 *
 * Description: three outcomes for time, because 'none' and 'unknown' are
 *   different findings and a person acting on the rail needs to know
 *   which one he is looking at.
 * Inputs: node, kind.
 * Output: the short marker and the full tooltip.
 * Example: unsortedReason({activity_status: 'unknown'}, 'time').short
 *   // -> 'date not established'
 */
export function unsortedReason(
    node: OrderableNode | null | undefined,
    kind: OrderKind,
): UnsortedReason {
    const n = node || {};
    if (kind === 'time') {
        if (n.activity_status === ACTIVITY_UNKNOWN) {
            return {
                short: 'date not established',
                title: 'This project has no position in a time ordering because '
                    + 'its date could not be established - not because it is '
                    + 'old. It is parked here rather than sorted to an end that '
                    + 'would imply a date.',
            };
        }
        return {
            short: 'no dated messages',
            title: 'Measured: this project\'s transcripts were read and none of '
                + 'their messages carries a timestamp. That is an answer, not a '
                + 'failure to look - but it is not a date, so it is parked '
                + 'rather than sorted.',
        };
    }
    if (kind === 'size') {
        return {
            short: 'session count not established',
            title: 'The number of sessions in this project could not be '
                + 'measured, so it is parked rather than sorted as zero.',
        };
    }
    return {
        short: 'no name derived',
        title: 'This project\'s observed_cwd is null, so no folder name could '
            + 'be derived from it and there is nothing to sort by.',
    };
}

/** The two halves of a partition: what the mode can place, and what it cannot. */
export interface Partitioned<T> {
    readonly sortable: readonly T[];
    readonly parked: readonly T[];
}

/**
 * Split nodes into the ones the mode can order and the ones it cannot.
 *
 * Description: returns BOTH halves - a caller that only got the sortable
 *   half would render fewer projects than exist and have no way to
 *   notice.
 * Inputs: nodes, kind.
 * Output: both halves, input order preserved within each.
 * Example: partition(nodes, 'time').parked.length
 */
export function partition<T extends OrderableNode>(
    nodes: readonly T[] | null | undefined,
    kind: OrderKind,
): Partitioned<T> {
    const list = Array.isArray(nodes) ? nodes : [];
    const sortable: T[] = [];
    const parked: T[] = [];
    for (const node of list) (hasKey(node, kind) ? sortable : parked).push(node);
    return { sortable, parked };
}

/** The lowercased display name, for the tie-break and the parked order. */
function lowerName(n: OrderableNode): string {
    return String(n.display_name || '').toLowerCase();
}

/**
 * The comparator for one mode.
 *
 * Description: TOTAL - it returns a number for every pair, and falls
 *   back to the display name then the full path so the order is STABLE
 *   across repaints rather than depending on the engine's tie handling.
 * Inputs: mode - a MODES record.
 * Output: the comparator.
 * Example: [...nodes].sort(comparatorFor(modeFor('recent')))
 */
export function comparatorFor<T extends OrderableNode>(
    mode: OrderMode,
): (a: T, b: T) => number {
    return (a, b) => {
        let primary = 0;
        if (mode.kind === 'time') {
            const av = a.newest_activity_at as string;
            const bv = b.newest_activity_at as string;
            primary = av < bv ? -1 : (av > bv ? 1 : 0);
        } else if (mode.kind === 'size') {
            primary = (a.session_count as number) - (b.session_count as number);
        } else {
            const an = lowerName(a);
            const bn = lowerName(b);
            primary = an < bn ? -1 : (an > bn ? 1 : 0);
        }
        if (primary !== 0) return primary * mode.dir;
        const at = lowerName(a);
        const bt = lowerName(b);
        if (at !== bt) return at < bt ? -1 : 1;
        const ap = String(a.full_path || '');
        const bp = String(b.full_path || '');
        return ap < bp ? -1 : (ap > bp ? 1 : 0);
    };
}

/** One parked node and the reason it could not be placed. */
export interface ParkedNode<T> {
    readonly node: T;
    readonly reason: UnsortedReason;
}

/** The ordered list, how much of it was actually ordered, and why not. */
export interface SortResult<T> {
    readonly nodes: readonly T[];
    readonly ordered: number;
    readonly parked: readonly ParkedNode<T>[];
    readonly mode: string;
}

/**
 * Order the nodes, appending the ones with no sort key in a marked block
 * at the end.
 *
 * Description: NEVER MUTATES the input array, because the rail holds
 *   that array as its own state and a sort in place would make the
 *   stored order depend on which control was touched last. The parked
 *   block gets a stable order of its own - by name - so it does not
 *   reshuffle between repaints, but that order is NOT the mode's and is
 *   not presented as meaningful.
 * Inputs: nodes, modeId.
 * Output: the concatenated list plus the parked reasons, so the renderer
 *   can mark each parked row with what put it there.
 * Example: sortNodes(nodes, 'recent').nodes[0]
 */
export function sortNodes<T extends OrderableNode>(
    nodes: readonly T[] | null | undefined,
    modeId: unknown,
): SortResult<T> {
    const mode = modeFor(isMode(modeId) ? modeId : DEFAULT_MODE);
    const split = partition(nodes, mode.kind);
    const ordered = split.sortable.slice().sort(comparatorFor<T>(mode));
    const parked = split.parked.slice().sort((a, b) => {
        const an = String(a.display_name || a.full_path || '').toLowerCase();
        const bn = String(b.display_name || b.full_path || '').toLowerCase();
        return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    return {
        nodes: ordered.concat(parked),
        ordered: ordered.length,
        parked: parked.map((node) => ({ node, reason: unsortedReason(node, mode.kind) })),
        mode: mode.id,
    };
}

/** The date cell on a project card. */
export interface ActivityCell {
    readonly text: string;
    readonly title: string;
    readonly known: boolean;
}

/**
 * The date cell on a project row.
 *
 * Description: renders the DAY only, taken as the first 10 characters of
 *   the stored ISO-8601 stamp - NOT parsed into a Date, because parsing
 *   would apply the viewer's timezone to a stamp the archive stores
 *   byte-exactly as its producer wrote it, and would silently yield
 *   'Invalid Date' for a stamp that is not the shape we assumed. Three
 *   outcomes, matching the server's activity_status.
 * Inputs: row - a merged project node.
 * Output: the cell, or null when the row carries no activity fields at
 *   all (every non-project row, and any build whose server predates them).
 * Example: activityCell({activity_status: 'known',
 *   newest_activity_at: '2026-08-30T16:01:02Z'}).text   // -> '2026-08-30'
 */
export function activityCell(row: OrderableNode | null | undefined): ActivityCell | null {
    const r = row || {};
    if (typeof r.activity_status !== 'string') return null;
    if (r.activity_status === ACTIVITY_KNOWN
        && typeof r.newest_activity_at === 'string' && r.newest_activity_at) {
        return {
            known: true,
            text: r.newest_activity_at.slice(0, 10),
            title: `Last worked in ${r.newest_activity_at}\n(the newest message `
                + 'timestamp in this project, not when it was collected)',
        };
    }
    if (r.activity_status === ACTIVITY_UNKNOWN) {
        return {
            known: false,
            text: 'no date',
            title: 'The date could not be established for this project. That is '
                + 'not the same as it being old.',
        };
    }
    return {
        known: false,
        text: 'undated',
        title: 'Measured: this project has transcripts, and none of their '
            + 'messages carries a timestamp.',
    };
}
