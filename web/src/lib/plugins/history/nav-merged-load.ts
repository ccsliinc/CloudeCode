/**
 * APPLYING ONE MERGED-PROJECTS RESPONSE, as a pure function.
 *
 * WHY IT IS NOT INSIDE THE COMPONENT. `NavRail.svelte` reached this
 * repo's 500-line cap and this was the honest thing to take out: it is
 * the one piece of that file that never touched the rail's state, only
 * the envelope in front of it. It is also the SAME SHAPE as
 * `nav-drill.ts::applyLevel` and `tlist-paging.ts::applyPage`, which is
 * what makes the three readable together: envelope in, next state out,
 * no network, no document, no component.
 *
 * ONE REQUEST, NOT PAGINATED. 77 nodes on the live corpus, and a PAGE of
 * a merged tree would let someone conclude a project lives on one machine
 * because the row proving otherwise fell on page 2. So there is no cursor
 * here and there is deliberately no place to put one.
 *
 * A PARTIAL KEEPS ITS ROWS AND ITS BANNER, exactly as every other level
 * in this rail does.
 *
 * Ported from the `loadMergedProjects` half of client/js/archive-nav.js.
 */
import type { NavRowData } from './nav-row';
import type { MergedNode } from './nav-merged';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** The merged listing, as the rail holds it. Replaced, never mutated. */
export interface MergedState {
    readonly nodes: readonly MergedNode[];
    /** `meta.unattributed.by_corpus`, the per-corpus orphan counts. */
    readonly unattributed: readonly NavRowData[];
    /** `meta.hosts`, the machines the SERVER named. */
    readonly hosts: readonly NavRowData[];
    /** How many nodes the listing held, or null before it was fetched. */
    readonly total: number | null;
    /** 'idle', 'ok', 'partial', or a refusal token. */
    readonly token: string;
    /** The envelope to render BENEATH the rows on a `partial`, or null. */
    readonly partialEnvelope: unknown;
    /** The envelope to render INSTEAD of rows on a refusal, or null. */
    readonly outcomeEnvelope: unknown;
    /** Why there is no envelope at all, or null when the server answered. */
    readonly transportError: string | null;
}

/**
 * The state the merged view starts in, before anything has been asked.
 *
 * Description: `total` is NULL and not 0, because "not fetched" and
 *   "fetched and empty" are different findings and the honest filter
 *   sentence quotes this number.
 * Inputs: none. Output: the empty state.
 * Example: emptyMerged().total   // -> null
 */
export function emptyMerged(): MergedState {
    return {
        nodes: [], unattributed: [], hosts: [], total: null,
        token: 'idle', partialEnvelope: null, outcomeEnvelope: null,
        transportError: null,
    };
}

/**
 * Apply one merged-projects response.
 *
 * Description: PURE. A REFUSAL KEEPS NOTHING: the previous rows are not
 *   carried forward, because this listing is not paged and a refusal
 *   answered the whole question rather than one page of it. That is the
 *   one way it differs from `applyPage`, which keeps rows precisely
 *   because it IS paged.
 * Inputs: result - one EnvelopeResult from the granted client. outcome -
 *   the injected classifier.
 * Output: the next state.
 * Example: applyMerged(r, outcome).token   // -> 'ok'
 */
export function applyMerged(
    result: EnvelopeResult,
    outcome: OutcomeClassifier,
): MergedState {
    const envelope = result.transportError ? null : result.envelope;
    const classified = outcome.classify(envelope);
    if (!outcome.isRenderable(classified.token)) {
        return {
            ...emptyMerged(),
            token: classified.token,
            outcomeEnvelope: result.transportError ? null : result.envelope,
            transportError: result.transportError,
        };
    }
    const env = (envelope || {}) as Record<string, unknown>;
    const meta = (env.meta || {}) as Record<string, unknown>;
    const unattributed = (meta.unattributed || {}) as Record<string, unknown>;
    const nodes = Array.isArray(env.result) ? env.result as MergedNode[] : [];
    return {
        nodes,
        unattributed: Array.isArray(unattributed.by_corpus)
            ? unattributed.by_corpus as NavRowData[]
            : [],
        hosts: Array.isArray(meta.hosts) ? meta.hosts as NavRowData[] : [],
        total: nodes.length,
        token: classified.token,
        partialEnvelope: classified.token === 'partial' ? envelope : null,
        outcomeEnvelope: null,
        transportError: null,
    };
}
