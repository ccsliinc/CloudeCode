/**
 * THE QUERY: running a search, accumulating hits, and continuing along
 * the ONE dimension the scan status named. Ported from the `create()`
 * closure in `client/js/archive-search.js`, minus the DOM.
 *
 * WHY THE STATE IS HERE AND NOT IN THE COMPONENT. A Svelte component can
 * hold `$state` perfectly well, and then the resume rule - the part that
 * is actually delicate - is only testable by mounting something. This
 * module is a plain object with plain methods, so every branch of the
 * two-cursor rule is reachable from a unit test with no jsdom, and
 * `SearchPanel.svelte` is left with nothing to get wrong but the paint.
 *
 * THE RESUME CHAIN NEVER TOUCHES `meta`. `resume()` reads
 * `affordance.cursor`, which `search-envelope.ts` resolved from exactly
 * ONE named field. This module therefore CANNOT pick the wrong cursor:
 * it has no code that could. That is the whole reason the affordance is
 * an object with a `field` on it rather than a bare string.
 *
 * BOTH KINDS APPEND. More matches add rows; more scope adds whatever the
 * newly-read transcripts hold. Neither discards what was already found,
 * because both are continuations of one question. A NEW query discards
 * everything, because a new question does not inherit an old answer's
 * coverage.
 *
 * IT HOLDS RAW HITS AND HANDS OUT VIEWS. `hits()` returns `HitView[]`,
 * never the raw records, so the only route from this module to a
 * template is one that has already been through the egress door. The raw
 * array is private and is never exported in any shape.
 *
 * Pure apart from the injected client. No DOM, no globals.
 */
import { hitView, type HitView, type SearchHitRecord } from './search-hit';
import {
    coverageSentence, resumeAffordance, scanStatus,
    type ResumeAffordance, type SearchEnvelope,
} from './search-envelope';
import { COVERAGE_PENDING } from './search-vocab';

/** What a transport hands back. The shape `client.ts` already returns. */
export interface EnvelopeResultLike {
    readonly envelope?: unknown;
    readonly transportError?: string | null;
}

/** The scope and terms of one search. Exactly one scope, unvalidated here. */
export interface SearchQuery {
    readonly q?: string;
    readonly transcriptId?: number | string;
    readonly projectId?: number | string;
    readonly corpusId?: number | string;
    readonly hostId?: number | string;
    readonly limit?: number;
    readonly caseSensitive?: boolean;
    readonly cursor?: string;
}

/** The one method this module needs from the granted archive client. */
export interface SearchTransport {
    searchArchive(opts?: SearchQuery): Promise<EnvelopeResultLike>;
}

/** Everything a view needs, after one response. */
export interface SearchState {
    /** Accumulated hits, already through the egress door. */
    readonly hits: readonly HitView[];
    /** The coverage sentence. Rendered on EVERY outcome, including ok. */
    readonly coverage: string;
    /** The resume control's model, or null before any answer. */
    readonly affordance: ResumeAffordance | null;
    /** `meta.scan.status`, membership-checked. Never assumed complete. */
    readonly scan: string;
    /** The outcome classifier's token, or null before any answer. */
    readonly token: string | null;
    /** The transport's own failure text, or null. */
    readonly transportError: string | null;
    /** The raw envelope, for the outcome block. Never read for hits. */
    readonly envelope: unknown;
    /** True while a request is in flight. */
    readonly running: boolean;
}

/** What the runner needs to classify an envelope. Injected, per slice 4. */
export interface OutcomeLike {
    classify(envelope: unknown): { token: string };
}

/** The runner's public shape. */
export interface SearchRunner {
    /** The current state. A fresh object on every change. */
    state(): SearchState;
    /** Run a NEW search. Discards prior hits and prior coverage. */
    run(query: SearchQuery): Promise<SearchState>;
    /** Continue along the ONE dimension the scan status named. */
    resume(): Promise<SearchState>;
    /** The query last run, for a caller that wants to re-scope it. */
    query(): SearchQuery | null;
}

/** The token used when nothing was classified because nothing arrived. */
export const TOKEN_TRANSPORT_ERROR = 'transport-error';

/** The state a runner holds before anything has been asked. */
export function emptySearch(): SearchState {
    return {
        hits: [], coverage: COVERAGE_PENDING, affordance: null, scan: 'unknown',
        token: null, transportError: null, envelope: null, running: false,
    };
}

/**
 * Build a search runner over a granted client.
 *
 * Description: the classifier is INJECTED exactly as slices 5, 6 and 7
 *   inject it, because `archive-outcome.js` is a separate module and
 *   this tree reaches for no global. It is NOT optional: a runner with
 *   no classifier could not tell a partial answer from a complete one,
 *   which is the one thing this whole surface exists to say out loud.
 * Inputs: transport - the granted client. outcome - the classifier.
 * Output: a SearchRunner.
 * Example: const r = createSearchRunner(client, outcome);
 *          await r.run({q: 'restic', projectId: 12});
 */
export function createSearchRunner(
    transport: SearchTransport,
    outcome: OutcomeLike,
): SearchRunner {
    let current: SearchState = emptySearch();
    let lastQuery: SearchQuery | null = null;

    /**
     * Fold one response into the state.
     *
     * Description: `append` is what separates a resume from a new run,
     *   and it is passed in rather than derived, because deriving it
     *   from the presence of a cursor would make a re-run of the same
     *   query with a stale cursor append silently.
     * Inputs: r - the transport result. append - keep prior hits.
     * Output: the new state.
     */
    function apply(r: EnvelopeResultLike, append: boolean): SearchState {
        const transportError = typeof r.transportError === 'string' && r.transportError
            ? r.transportError
            : null;
        const envelope = transportError ? null : (r.envelope ?? null);
        const token = transportError
            ? TOKEN_TRANSPORT_ERROR
            : outcome.classify(envelope).token;

        const env = envelope as SearchEnvelope | null;
        const raw = (env && Array.isArray((env as { result?: unknown }).result))
            ? (env as { result: readonly SearchHitRecord[] }).result
            : [];
        // EVERY row goes through `hitView`, which goes through the egress
        // door. There is no branch here that keeps a raw record.
        const rows = raw.map((one) => hitView(one));

        current = {
            hits: append ? [...current.hits, ...rows] : rows,
            coverage: coverageSentence(env),
            affordance: resumeAffordance(env),
            scan: scanStatus(env),
            token,
            transportError,
            envelope,
            running: false,
        };
        return current;
    }

    return {
        state: () => current,
        query: () => lastQuery,

        run(query: SearchQuery): Promise<SearchState> {
            lastQuery = query ?? {};
            current = { ...emptySearch(), running: true };
            return Promise.resolve(transport.searchArchive(lastQuery))
                .then((r) => apply(r, false));
        },

        resume(): Promise<SearchState> {
            const a = current.affordance;
            // A BLOCKED AFFORDANCE IS NOT AN ERROR AND NOT A NO-OP THAT
            // LIES. The state is returned unchanged with its reason
            // already on it, so the caller repaints the same stated
            // blocker rather than clearing the control.
            if (!a || !a.cursor || !lastQuery) return Promise.resolve(current);
            const next: SearchQuery = { ...lastQuery, cursor: a.cursor };
            current = { ...current, running: true };
            return Promise.resolve(transport.searchArchive(next))
                .then((r) => apply(r, true));
        },
    };
}
