/**
 * The rail's PURE ROW LOGIC: what one server row is called, what it is
 * addressed by, what it counts, and the two sentences the rail is
 * obliged to print about its own scope.
 *
 * Ported from the pure half of `client/js/archive-nav-row.js`. The other
 * half of that file was `document.createElement`, which Svelte renders
 * declaratively, so it has no counterpart here. What survives is every
 * function that was a pure function of its arguments.
 *
 * NOT KNOWN IS A RENDERED STRING, NOT A ZERO. `renderCount` prints it
 * whenever the server sent no count, because a count of 0 and a count
 * nobody measured are different findings and a rail that shows "0" for
 * both is lying about one of them. IT DELEGATES TO `format.ts` rather
 * than re-deciding: `formatCount` already returns exactly `NOT_KNOWN`
 * for anything non-countable and already groups the digits, and the
 * vanilla module called the same formatter through
 * `window.ArchiveFormat`. Reused from slice 2/4, not rebuilt.
 *
 * THE FILTER IS HONEST ABOUT ITS OWN SCOPE, in words, every time it is
 * non-empty. `describeFilter` is that sentence. A filter that reads like
 * a search of the corpus is a false green with a text box on it.
 */
import { NODE_KINDS, UNATTRIBUTED_LABEL, UNATTRIBUTED_TITLE, type NodeKind } from './nav-vocab';
import { formatCount, NOT_KNOWN } from './format';

/** One row as the archive endpoints return it. Keys vary by kind. */
export interface NavRowData {
    readonly [key: string]: unknown;
}

/**
 * Render a count that may be absent.
 *
 * Description: a missing number renders as NOT KNOWN, never as 0.
 * Inputs: n - the count, or anything else.
 * Output: the grouped digits, or `NOT KNOWN`.
 * Example: renderCount(null)   // -> 'NOT KNOWN'
 */
export function renderCount(n: unknown): string {
    return formatCount(n);
}

/** Read one property off a row as a non-empty string, or null. */
function str(row: NavRowData | null | undefined, key: string): string | null {
    const v = row ? row[key] : undefined;
    return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Case-insensitive substring filter over already-loaded rows.
 *
 * Description: the drill-down's filter. It is NOT the merged view's,
 *   which is fuzzy - see `nav-fuzzy.ts`. Kept as it was because the two
 *   levels genuinely filter differently and collapsing them would change
 *   what the by-machine tree matches.
 * Inputs: rows - nav rows. needle - '' matches everything. fields - row
 *   properties to search.
 * Output: the matching subset, order preserved.
 * Example: filterRows([{slug: 'abc'}], 'B', ['slug'])  // -> [{slug:'abc'}]
 */
export function filterRows(
    rows: readonly NavRowData[] | null | undefined,
    needle: unknown,
    fields: readonly string[] | null | undefined,
): readonly NavRowData[] {
    const list = Array.isArray(rows) ? rows : [];
    const q = String(needle === null || needle === undefined ? '' : needle).toLowerCase();
    if (!q) return list.slice();
    const keys = Array.isArray(fields) && fields.length ? fields : ['slug'];
    return list.filter((row) => keys.some((k) => {
        const v = row ? row[k] : undefined;
        return typeof v === 'string' && v.toLowerCase().includes(q);
    }));
}

/**
 * The sentence a filter must always carry, naming what it did and did
 * NOT look at.
 *
 * Inputs: matched - rows the filter kept. loaded - rows this rail has
 *   fetched. total - rows the server says exist, or null. noun - e.g.
 *   'projects'.
 * Output: the sentence.
 * Example: describeFilter(3, 71, 3416, 'projects')
 *   // -> 'filter matches 3 of 71 loaded projects. 3,416 exist; this
 *   //     filters rows already fetched, not the whole corpus.'
 */
export function describeFilter(
    matched: unknown,
    loaded: unknown,
    total: number | null,
    noun: string,
): string {
    let line = `filter matches ${renderCount(matched)} of ${renderCount(loaded)} loaded ${noun}.`;
    if (typeof total === 'number' && typeof loaded === 'number' && total > loaded) {
        line += ` ${renderCount(total)} exist;`;
    }
    return `${line} This filters rows already fetched, not the whole corpus.`;
}

/**
 * The label for one nav row, by kind.
 *
 * Description: never empty. A row with no name at all renders its id
 *   rather than a blank, because a blank row cannot be clicked with
 *   intent.
 *
 *   FOR A PROJECT, `display_name` IS PREFERRED OVER THE SLUG and there
 *   is no shortening here. The slug middle-truncates to
 *   '-Users-jsugamele-Develo...t-Assistants-Developer' in a 272px rail,
 *   which removes precisely the segment that identifies it. The rail
 *   truncates with CSS and puts the full text in a title attribute, so
 *   nothing is destroyed. A null `display_name` means the server had no
 *   observed_cwd and refused to guess a folder name out of a slug it
 *   cannot invert; showing the slug is honest, showing a fabricated leaf
 *   is not.
 * Inputs: kind, row.
 * Output: the label.
 */
export function labelFor(kind: NodeKind, row: NavRowData | null | undefined): string {
    const r = row || {};
    if (kind === NODE_KINDS.HOST) {
        return str(r, 'display_name') || str(r, 'hostname') || `host ${String(r.host_id)}`;
    }
    if (kind === NODE_KINDS.CORPUS) {
        return str(r, 'corpus_key') || str(r, 'root_path') || `corpus ${String(r.corpus_id)}`;
    }
    if (kind === NODE_KINDS.UNATTRIBUTED) return UNATTRIBUTED_LABEL;
    return str(r, 'display_name')
        || str(r, 'full_path')
        || str(r, 'slug')
        || str(r, 'observed_cwd')
        || `project ${String(r.project_id)}`;
}

/**
 * The full, untruncated text for a row's `title` attribute, so hovering
 * a truncated label reveals everything the rail could not fit.
 *
 * Inputs: kind, row.
 * Output: '' when there is nothing more to say than the label already says.
 * Example: titleFor('project', {observed_cwd: '/x', full_path: '-x'})
 */
export function titleFor(kind: NodeKind, row: NavRowData | null | undefined): string {
    const r = row || {};
    if (kind === NODE_KINDS.UNATTRIBUTED) return UNATTRIBUTED_TITLE;
    if (kind === NODE_KINDS.PROJECT) {
        const parts: string[] = [];
        const cwd = str(r, 'observed_cwd');
        if (cwd) parts.push(cwd);
        const slug = str(r, 'full_path') || str(r, 'slug');
        if (slug && slug !== parts[0]) parts.push(`slug: ${slug}`);
        const hosts = r.hosts;
        if (Array.isArray(hosts) && hosts.length) parts.push(`on: ${hosts.join(', ')}`);
        return parts.join('\n');
    }
    if (kind === NODE_KINDS.HOST) return str(r, 'hostname') || str(r, 'display_name') || '';
    if (kind === NODE_KINDS.CORPUS) return str(r, 'root_path') || str(r, 'corpus_key') || '';
    return '';
}

/**
 * The id a row is addressed by, per kind.
 * Inputs: kind, row. Output: the id, or null.
 */
export function idFor(
    kind: NodeKind,
    row: NavRowData | null | undefined,
): number | string | null {
    const r = (row || {}) as Record<string, unknown>;
    const pick = kind === NODE_KINDS.HOST ? r.host_id
        : kind === NODE_KINDS.CORPUS ? r.corpus_id
            : kind === NODE_KINDS.PROJECT ? r.project_id
                : r.corpus_id;
    return typeof pick === 'number' || typeof pick === 'string' ? pick : null;
}

/**
 * The transcript count a row advertises, per kind.
 * Inputs: kind, row. Output: the count, or null when it is not a number.
 */
export function countFor(kind: NodeKind, row: NavRowData | null | undefined): number | null {
    const r = row || {};
    const v = kind === NODE_KINDS.UNATTRIBUTED
        ? r.unattributed_transcript_count
        : r.transcript_count;
    return typeof v === 'number' ? v : null;
}

/** Whether the unattributed node is drawn, and the reason either way. */
export interface UnattributedVerdict {
    readonly show: boolean;
    readonly reason: string;
}

/**
 * Decide whether the unattributed node is rendered.
 *
 * Description: THE ONLY CASE THAT HIDES IT is a count the server
 *   measured and reported as 0. A count that is missing, null, or
 *   flagged `counted: false` keeps the node ON SCREEN. Hiding on an
 *   unmeasured count would be indistinguishable from hiding real
 *   transcripts, and these are exactly the transcripts that are
 *   invisible from the project tree by construction - the one population
 *   where a wrong hide is permanent. Measured 2026-09-01: corpus 1 has
 *   0, corpus 2 has 5.
 * Inputs: row - the corpus row carrying the count.
 * Output: the verdict; `reason` is for tests and for the node's tooltip,
 *   so the decision is inspectable.
 * Example: shouldShowUnattributed({unattributed_transcript_count: 0})
 *   // -> {show: false, reason: 'known zero'}
 */
export function shouldShowUnattributed(
    row: NavRowData | null | undefined,
): UnattributedVerdict {
    const r = row || {};
    if (r.counted === false) {
        return { show: true, reason: 'count could not be determined' };
    }
    const n = r.unattributed_transcript_count;
    if (typeof n !== 'number' || !isFinite(n)) {
        return { show: true, reason: 'no count was reported' };
    }
    if (n === 0) return { show: false, reason: 'known zero' };
    return { show: true, reason: `holds ${n}` };
}

/** The note under the unattributed node, and whether it is settled. */
export interface UnattributedNote {
    readonly text: string;
    readonly answered: boolean;
}

/**
 * The note under the unattributed node, DERIVED from the same
 * `shouldShowUnattributed` verdict that decided to show it, so the words
 * and the reason cannot disagree.
 *
 * Description: the node is shown for three different reasons and only
 *   one of them is settled. A measured non-zero count is ANSWERED; a
 *   count that could not be established or was never reported is
 *   genuinely open and must not be dressed up as answered.
 * Inputs: row - the same row `shouldShowUnattributed` reads.
 * Output: the note.
 * Example: unattributedNote({unattributed_transcript_count: 5}).answered
 *   // -> true
 */
export function unattributedNote(row: NavRowData | null | undefined): UnattributedNote {
    const verdict = shouldShowUnattributed(row);
    if (verdict.reason === 'count could not be determined'
        || verdict.reason === 'no count was reported') {
        return {
            answered: false,
            text: 'belongs to no project, invisible from the project tree - '
                + 'and how many there are is not established, so this node is '
                + 'shown rather than hidden',
        };
    }
    return {
        answered: true,
        text: 'belongs to no project because its path has no project layer to '
            + 'declare one - a complete answer, not a failed attribution. It is '
            + 'invisible from the project tree, which is why it is listed here.',
    };
}

/** Re-exported so a consumer needs one import for the literal too. */
export { NOT_KNOWN };
