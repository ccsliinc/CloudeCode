/**
 * THE BY-MACHINE DRILL-DOWN, AS DATA: host -> corpus -> project, plus
 * the project-less node that hangs off a corpus.
 *
 * THE TREE IS UNEXPOSED, NOT DELETED, and that is why it is ported. The
 * view bar that used to reach it was removed at the owner's instruction
 * ("i dont think we need the button and dropdown on the left column"),
 * but the merged view is only one of two the rail can be in and a deep
 * link still selects this one. Dropping it here would be deleting a path
 * the owner did not ask to have deleted.
 *
 * WHAT `archive-nav-tree.js` DOES NOT BECOME. That file was three DOM
 * helpers: `slotFor`, which ran `querySelectorAll('[data-node-kind]')`
 * over the rendered rail to find a node's `<ul>`; `renderPartialTail`,
 * which appended an outcome block after the rows; and
 * `appendUnattributedNode`, which appended one more `<li>`. All three
 * exist because the vanilla rail mutated a tree it had already drawn.
 * A Svelte template renders the tree FROM this state, so the state is
 * the whole answer and there is nothing to go looking for in the DOM.
 * What survives from that file is the two RULES it carried, and they are
 * both here: the partial banner is APPENDED, never substituted, and the
 * unattributed node is appended to EVERY expanded corpus.
 *
 * THE PARTIAL BANNER IS APPENDED, NEVER SUBSTITUTED. A `partial`
 * envelope carries rows AND an admission that the server did not finish
 * looking. Dropping the rows to show the banner hides what did come
 * back; dropping the banner claims the list is complete. So a partial
 * level keeps its rows and carries `partialEnvelope` beside them.
 *
 * THE UNATTRIBUTED NODE IS APPENDED TO EVERY EXPANDED CORPUS, ALWAYS -
 * including when its count is 0 and when no count was reported. Whether
 * it is then SHOWN is `shouldShowUnattributed`'s decision and is not
 * re-litigated here. Its count comes from the CORPORA listing, where the
 * server already reported it; a corpus this rail has not listed yields a
 * node with NO count, which renders NOT KNOWN rather than 0.
 *
 * Ported from client/js/archive-nav-drill.js and archive-nav-tree.js.
 */
import { NODE_KINDS, type NodeKind } from './nav-vocab';
import type { NavRowData } from './nav-row';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** The key the top level is stored under. */
export const HOSTS_KEY = 'hosts';

/** What one fetched level holds. Replaced, never mutated. */
export interface LevelState {
    /** Rows the server returned, in server order. */
    readonly rows: readonly NavRowData[];
    /** How many rows this level holds, or null before it was fetched. */
    readonly total: number | null;
    /** The outcome token: 'idle', 'loading', 'ok', 'partial', or a refusal. */
    readonly token: string;
    /** The envelope to render BENEATH the rows on a `partial`, or null. */
    readonly partialEnvelope: unknown;
    /** The envelope to render INSTEAD of rows on a refusal, or null. */
    readonly outcomeEnvelope: unknown;
    /** Why there is no envelope at all, or null when the server answered. */
    readonly transportError: string | null;
}

/** Every level this rail has fetched, keyed by `levelKey`. */
export type DrillState = Readonly<Record<string, LevelState>>;

/** The state a level is in before anything has been asked of it. */
export function emptyLevel(): LevelState {
    return {
        rows: [],
        total: null,
        token: 'idle',
        partialEnvelope: null,
        outcomeEnvelope: null,
        transportError: null,
    };
}

/**
 * The key one level is stored under.
 *
 * Description: the SAME two prefixes the vanilla rail used, because the
 *   honest-filter note keys its server total on them too.
 * Inputs: kind - HOST or CORPUS, the node being expanded. id.
 * Output: 'corpora:<id>' for a host, 'projects:<id>' for a corpus.
 * Example: levelKey('host', 2)   // -> 'corpora:2'
 */
export function levelKey(kind: NodeKind, id: number | string): string {
    return `${kind === NODE_KINDS.HOST ? 'corpora' : 'projects'}:${String(id)}`;
}

/**
 * The fields the drill-down's substring filter searches, per level.
 *
 * Description: a table rather than a branch, so a level the rail grows
 *   later cannot silently inherit the wrong field list. The keys are the
 *   node kind being LISTED, not the one being expanded.
 */
export const LEVEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
    [NODE_KINDS.HOST]: ['display_name', 'hostname'],
    [NODE_KINDS.CORPUS]: ['corpus_key', 'root_path'],
    [NODE_KINDS.PROJECT]: ['slug', 'observed_cwd'],
};

/**
 * The kind of node a level LISTS, given the kind being expanded.
 * Inputs: kind - HOST or CORPUS. Output: CORPUS or PROJECT.
 * Example: childKind('host')   // -> 'corpus'
 */
export function childKind(kind: NodeKind): NodeKind {
    return kind === NODE_KINDS.HOST ? NODE_KINDS.CORPUS : NODE_KINDS.PROJECT;
}

/**
 * Apply one level response to a level's state.
 *
 * Description: PURE, so the whole of the drill-down's contract is
 *   testable without a network or a document. A REFUSAL IS RENDERED,
 *   NEVER SWALLOWED: a rail that shows an empty branch on a refused
 *   request is indistinguishable from a branch that is genuinely empty,
 *   which is the claim nobody measured. A `partial` keeps its rows AND
 *   its banner.
 * Inputs: result - one EnvelopeResult from the granted client. outcome -
 *   the injected classifier.
 * Output: the level's next state.
 * Example: applyLevel(r, outcome).token   // -> 'ok'
 */
export function applyLevel(result: EnvelopeResult, outcome: OutcomeClassifier): LevelState {
    const envelope = result.transportError ? null : result.envelope;
    const classified = outcome.classify(envelope);
    if (!outcome.isRenderable(classified.token)) {
        return {
            rows: [],
            total: null,
            token: classified.token,
            partialEnvelope: null,
            outcomeEnvelope: result.transportError ? null : result.envelope,
            transportError: result.transportError,
        };
    }
    const page = (envelope as { result?: unknown } | null)?.result;
    const rows = Array.isArray(page) ? page as NavRowData[] : [];
    return {
        rows,
        total: rows.length,
        token: classified.token,
        partialEnvelope: classified.token === 'partial' ? envelope : null,
        outcomeEnvelope: null,
        transportError: null,
    };
}

/**
 * Issue one level request.
 *
 * Description: the ONLY place that decides which route a level maps to.
 * Inputs: client - the granted archive client. kind - HOST or CORPUS, the
 *   node being expanded. id.
 * Output: the envelope result. It RESOLVES on every path, including a
 *   dead network, because `EnvelopeResult` carries the failure.
 * Example: await fetchLevel(client, 'host', 2)
 */
export function fetchLevel(
    client: ArchiveClient,
    kind: NodeKind,
    id: number | string,
): Promise<EnvelopeResult> {
    return kind === NODE_KINDS.HOST
        ? client.listArchiveCorpora(id)
        : client.listArchiveProjects(id);
}

/**
 * Every corpus row this rail has loaded, flattened.
 *
 * Description: so an unattributed node can find its own count. Reads
 *   only the `corpora:` levels, which is where the server reported it.
 * Inputs: state - every fetched level.
 * Output: the corpus rows, in the order their levels were stored.
 * Example: loadedCorpora(state).length   // -> 3
 */
export function loadedCorpora(state: DrillState): readonly NavRowData[] {
    const out: NavRowData[] = [];
    for (const key of Object.keys(state)) {
        if (key.startsWith('corpora:')) out.push(...(state[key] as LevelState).rows);
    }
    return out;
}

/**
 * The row the unattributed node under one corpus is drawn from.
 *
 * Description: the matching corpus row when this rail has listed it, and
 *   a bare `{corpus_id}` when it has not - which renders NOT KNOWN
 *   rather than 0, because a count nobody reported is not a count of
 *   none. This is `appendUnattributedNode`'s lookup, kept exactly.
 * Inputs: corpora - every corpus row loaded. corpusId.
 * Output: the row to render the node from.
 * Example: unattributedRowFor(corpora, 2).unattributed_transcript_count
 */
export function unattributedRowFor(
    corpora: readonly NavRowData[],
    corpusId: number | string,
): NavRowData {
    const match = corpora.find((c) => String(c.corpus_id) === String(corpusId));
    return match || { corpus_id: corpusId };
}
