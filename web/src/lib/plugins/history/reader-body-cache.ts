/**
 * Lazy body fetching for the transcript reader: the gate honoured before
 * any network, an LRU capped on TWO axes, in-flight de-duplication and a
 * deadline. Ported from `client/js/archive-body-cache.js`.
 *
 * WHAT THE ORIGINAL GUARANTEED, STATED AS FOUR PROPERTIES, BECAUSE THE
 * PORT HAS TO BE CHECKED AGAINST THEM RATHER THAN AGAINST A VIBE. Slice
 * 6 found that `archive-row-cache.js` had no consumer in the transcript
 * list at all; this one IS wired, into the reader, and these are what it
 * is wired for:
 *
 *   G1 THE CACHE NEVER HOLDS AN UNMASKED SECRET-BEARING BODY. Masking
 *     happens ONCE, at insert, through `reader-gate.applyMask`. When a
 *     body carries findings the raw text is dropped on the floor and
 *     only the mask result is stored, so no later caller can reach
 *     around the masker by reading the cache. On a refusal `text` is
 *     null by construction and `chars` counts nothing, so the raw string
 *     goes out of scope and is never reachable again.
 *   G2 BOTH CAPS, ALWAYS, AFTER EVERY INSERT. 300 bodies at 54 MB each
 *     is not a cache, it is an out-of-memory; two million 16-byte bodies
 *     fit under 32 MiB while making the Map itself the problem. Eviction
 *     runs until BOTH predicates hold, least-recently-used first.
 *   G3 ONE FETCH PER BODY ID. Two visible rows sharing a body, or fifty
 *     concurrent callers, issue exactly one request.
 *   G4 EVERY REQUEST TERMINATES. A loading state with no terminal
 *     condition is a state that can never fail, which is the worst
 *     defect shape a verification surface has.
 *
 * `reader-body-cache.test.ts` proves all four by COUNTING - cached
 * entries, api calls, and occurrences of a canary string across every
 * stored entry - rather than by timing anything, which is the discipline
 * slice 6 used when it counted painted rows at 200 and at 5,000.
 *
 * THREE OUTCOMES PER ENTRY, AND A FOURTH FOR ABSENCE. An entry is never
 * merely present or absent: `state` distinguishes a body that rendered,
 * one refused by a gate, one whose mask was refused, and one whose fetch
 * could not be evaluated. A MISSING entry means "not requested", which
 * is a fourth thing again and is never rendered as a spinner.
 *
 * No DOM, no framework, no globals. The classifier and the timers are
 * injected, so the whole of this is testable without a browser and
 * without waiting 30 seconds.
 */
import {
    applyMask, forbidsFetch, gateFor, reasonFrom,
    BODY_CACHE_MAX_CHARS, BODY_CACHE_MAX_ENTRIES, BODY_DEADLINE_MS,
    type ClassifiedLike, type GateRow, type GateVerdict,
} from './reader-gate';
import { BODY_STATE, type BodyState } from './reader-vocab';
import type { SecretFinding } from './reader-mask';
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/** One cached body. `text` is non-null ONLY in state `included`. */
export interface BodyEntry {
    readonly state: BodyState;
    /** The masked, safe text, or null. Never the raw body on a refusal. */
    readonly text: string | null;
    /** `text.length`, or 0 when there is no text. Drives cap G2. */
    readonly chars: number;
    /** How many secret windows were replaced. */
    readonly masked: number;
    /** Why this entry is not renderable, or null. */
    readonly reason: string | null;
    /** How many secrets the server believes are in this body. */
    readonly findingCount: number;
    /** The server's download href for this body, when it gave one. */
    readonly bodyHref: string | null;
    /** True when a GATE produced this entry rather than a fetch. */
    readonly gated?: boolean;
    /** The outcome token behind a cannot-determine, when there was one. */
    readonly outcomeToken?: string;
}

/** Counters a test or a status row can read. */
export interface CacheStats {
    readonly fetches: number;
    readonly evictions: number;
    readonly hits: number;
    readonly gateRefusals: number;
}

/** A spine row as the cache reads it. */
export interface BodyRow extends GateRow {
    readonly body_href?: unknown;
    readonly body_json?: unknown;
    readonly secrets?: readonly SecretFinding[] | null;
    readonly secret_finding_count?: unknown;
}

/** What `createBodyCache` needs. Everything optional has a NORMATIVE default. */
export interface BodyCacheOptions {
    /** The granted archive client. Required: it is the only fetch path. */
    readonly client: ArchiveClient;
    /** The injected outcome classifier, as `state.ts` injects it. */
    readonly outcome: OutcomeClassifier;
    /** Cap override, for tests. Defaults to the NORMATIVE constant. */
    readonly maxEntries?: number;
    /** Cap override, for tests. Defaults to the NORMATIVE constant. */
    readonly maxChars?: number;
    /** Deadline override, for tests. */
    readonly deadlineMs?: number;
    /** Injectable timer, so the deadline is testable without waiting. */
    readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    /** Injectable timer teardown. */
    readonly clearTimeoutFn?: (handle: unknown) => void;
}

/** The cache's public shape. */
export interface BodyCache {
    /** The gate, re-exported so a caller needs one name. No network. */
    gateFor(row: BodyRow | null | undefined): GateVerdict;
    /** Fetch and cache one body, honouring the gates. Never rejects. */
    request(row: BodyRow, force?: boolean): Promise<BodyEntry>;
    /** Accept a body that arrived on a /lines page, without a request. */
    offer(row: BodyRow): BodyEntry | null;
    /** Read a cached entry without fetching. Null means NOT REQUESTED. */
    get(bodyId: unknown): BodyEntry | null;
    /** Is a fetch for this body currently in flight? */
    isLoading(bodyId: unknown): boolean;
    /** Cached entry count. */
    size(): number;
    /** Cached characters across all entries. */
    chars(): number;
    /** Fetch, evict, hit and gate-refusal counters. */
    stats(): CacheStats;
    /** Drop everything, e.g. when the transcript changes. */
    clear(): void;
}

/** A gate refusal, as a cache entry. Never stored; answered directly. */
function refusalEntry(gate: GateVerdict, row: BodyRow | null | undefined): BodyEntry {
    return {
        state: gate.state,
        text: null,
        chars: 0,
        masked: 0,
        reason: gate.reason,
        findingCount: 0,
        bodyHref: typeof row?.body_href === 'string' ? row.body_href : null,
        gated: true,
    };
}

/**
 * Build a body cache bound to one granted client.
 *
 * Description: the four guarantees in the file header are enforced here
 *   and nowhere else, which is why every one of them is a counted
 *   property rather than a comment.
 * Inputs: options - see BodyCacheOptions.
 * Output: a BodyCache.
 * Example:
 *   const cache = createBodyCache({client, outcome});
 *   const gate = cache.gateFor(row);          // no network
 *   if (gate.state === 'included') await cache.request(row);
 */
export function createBodyCache(options: BodyCacheOptions): BodyCache {
    const { client, outcome } = options;
    if (!client || typeof client.getArchiveBody !== 'function') {
        throw new Error('createBodyCache needs a client with getArchiveBody');
    }
    if (!outcome || typeof outcome.classify !== 'function') {
        throw new Error('createBodyCache needs an outcome classifier');
    }
    const maxEntries = Number.isFinite(options.maxEntries)
        ? options.maxEntries as number : BODY_CACHE_MAX_ENTRIES;
    const maxChars = Number.isFinite(options.maxChars)
        ? options.maxChars as number : BODY_CACHE_MAX_CHARS;
    const deadlineMs = Number.isFinite(options.deadlineMs)
        ? options.deadlineMs as number : BODY_DEADLINE_MS;
    const setT = options.setTimeoutFn
        || (typeof setTimeout === 'function'
            ? (fn: () => void, ms: number) => setTimeout(fn, ms)
            : null);
    const clearT = options.clearTimeoutFn
        || (typeof clearTimeout === 'function'
            ? (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
            : null);

    /** body_id -> entry. Map iteration order IS the LRU order. */
    const entries = new Map<unknown, BodyEntry>();
    /** body_id -> Promise, so two rows sharing a body fetch once. G3. */
    const inflight = new Map<unknown, Promise<BodyEntry>>();
    /** Running sum of entry.chars, kept in step with `entries`. */
    let totalChars = 0;
    const stats = { fetches: 0, evictions: 0, hits: 0, gateRefusals: 0 };

    /** Move an entry to the most-recently-used end. Returns it, or null. */
    function touch(id: unknown): BodyEntry | null {
        if (!entries.has(id)) return null;
        const e = entries.get(id) as BodyEntry;
        entries.delete(id);
        entries.set(id, e);
        return e;
    }

    /**
     * Evict least-recently-used entries until BOTH caps hold. G2.
     *
     * Description: either cap alone is insufficient; see the file
     *   header. The loop condition is a conjunction of both predicates
     *   precisely so a caller cannot satisfy one and leave the other.
     * Output: how many entries were evicted.
     */
    function evict(): number {
        let n = 0;
        while (entries.size > maxEntries || totalChars > maxChars) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            const e = entries.get(oldest.value);
            totalChars -= (e && Number.isFinite(e.chars) ? e.chars : 0);
            if (totalChars < 0) totalChars = 0;
            entries.delete(oldest.value);
            n += 1;
            stats.evictions += 1;
        }
        return n;
    }

    /**
     * Insert or replace one entry and re-run eviction.
     * Inputs: id - the body id. entry - must carry `state` and a numeric
     *   `chars` (0 when it holds no text). Output: the stored entry.
     */
    function put(id: unknown, entry: BodyEntry): BodyEntry {
        if (entries.has(id)) {
            const old = entries.get(id);
            totalChars -= (old && Number.isFinite(old.chars) ? old.chars : 0);
            entries.delete(id);
        }
        const stored: BodyEntry = {
            ...entry,
            chars: Number.isFinite(entry.chars) ? entry.chars : 0,
        };
        entries.set(id, stored);
        totalChars += stored.chars;
        evict();
        return stored;
    }

    /** A synthetic envelope naming why a request could not be evaluated. */
    function cannotDetermine(reason: string): unknown {
        return {
            result: null,
            result_status: 'cannot_determine',
            scope_status: 'resolved',
            unevaluated: [{ subject: 'body', reason }],
            meta: {},
        };
    }

    /**
     * Race one promise against the body deadline. G4.
     *
     * Description: NEVER rejects. The rejection arm matters: a promise
     *   that neither resolves nor rejects is a loading state that can
     *   never terminate, which is the defect the deadline exists to
     *   prevent, reintroduced one layer down. Found by mutation testing
     *   on the vanilla file: the suite HUNG instead of going red.
     * Inputs: p - the request. ms - the deadline.
     * Output: the value, or a synthetic cannot_determine envelope result.
     */
    function withDeadline(
        p: Promise<EnvelopeResult>, ms: number,
    ): Promise<EnvelopeResult> {
        if (!setT) return p;
        return new Promise<EnvelopeResult>((resolve) => {
            let done = false;
            const timer = setT(() => {
                if (done) return;
                done = true;
                resolve({
                    envelope: cannotDetermine(
                        'no response in ' + Math.round(ms / 1000) + 's',
                    ),
                    httpStatus: 0,
                    headers: null,
                    transportError: null,
                } as unknown as EnvelopeResult);
            }, ms);

            /** Settle once, whichever way. */
            function settle(v: EnvelopeResult | null, err: unknown): void {
                if (done) return;
                done = true;
                if (clearT) clearT(timer);
                if (err) {
                    resolve({
                        envelope: cannotDetermine(
                            'the body request threw: '
                            + String((err as Error)?.message ?? err),
                        ),
                        httpStatus: 0,
                        headers: null,
                        transportError: null,
                    } as unknown as EnvelopeResult);
                    return;
                }
                resolve(v as EnvelopeResult);
            }
            p.then((v) => settle(v, null), (e) => settle(null, e || new Error('rejected')));
        });
    }

    /**
     * Turn a body payload into a cache entry, applying the mask. G1.
     *
     * Description: THE ONLY INSERT PATH FOR FETCHED TEXT. On a refusal
     *   `text` is null by construction, so the raw body is never stored
     *   and `chars` counts nothing; the raw string goes out of scope here
     *   and is never reachable again.
     * Inputs: id - the body id. payload - must carry `body_json`; may
     *   carry `secrets` and `secret_finding_count`.
     * Output: the stored entry.
     */
    function ingest(id: unknown, payload: BodyRow | null | undefined): BodyEntry {
        const body = payload?.body_json;
        const declared = Number.isInteger(payload?.secret_finding_count)
            ? payload?.secret_finding_count as number : 0;
        if (typeof body !== 'string') {
            return put(id, {
                state: BODY_STATE.CANNOT_DETERMINE,
                text: null,
                chars: 0,
                masked: 0,
                reason: 'the response carried no body_json string',
                findingCount: declared,
                bodyHref: null,
            });
        }
        const m = applyMask(body, payload?.secrets, declared);
        return put(id, {
            state: m.state,
            text: m.text,
            chars: m.text === null ? 0 : m.text.length,
            masked: m.masked,
            reason: m.reason,
            findingCount: m.findingCount,
            bodyHref: typeof payload?.body_href === 'string' ? payload.body_href : null,
        });
    }

    /**
     * Accept a body that arrived on a /lines page, without spending a
     * second request.
     *
     * Description: honours the gate first and DROPS anything it cannot
     *   mask, so the caller falls back to a real /bodies/{id} fetch that
     *   carries the offsets. THE GAP THIS EXISTS FOR:
     *   /lines?include_bodies=true was documented as returning a
     *   secret-bearing body with NO `secrets` array. Re-verified live
     *   2026-08-31 the array IS present, so the gap appears closed; this
     *   path stays defensive anyway, because a regression then costs a
     *   refetch and never a disclosure.
     * Inputs: row - a /lines row carrying body_json.
     * Output: the stored entry, or null when the caller must fetch
     *   properly.
     */
    function offer(row: BodyRow): BodyEntry | null {
        const gate = gateFor(row);
        if (gate.state !== BODY_STATE.OK) return null;
        if (!row || typeof row.body_json !== 'string') return null;
        const declared = Number.isInteger(row.secret_finding_count)
            ? row.secret_finding_count as number : 0;
        const m = applyMask(row.body_json, row.secrets, declared);
        if (m.state === BODY_STATE.MASK_REFUSED) return null;
        return put(row.body_id, {
            state: m.state,
            text: m.text,
            chars: m.text === null ? 0 : m.text.length,
            masked: m.masked,
            reason: null,
            findingCount: m.findingCount,
            bodyHref: typeof row.body_href === 'string' ? row.body_href : null,
        });
    }

    /**
     * Fetch and cache one body, honouring the gates.
     *
     * Description: NORMATIVE - a hard-gated, server-withheld,
     *   body-less or unmeasurable body is NEVER fetched, at any value of
     *   `force`. A soft-gated body is fetched only when the reader
     *   explicitly asked, which is what `force` means.
     * Inputs: row - a spine row. force - the reader pressed "render
     *   anyway".
     * Output: the cache entry. NEVER rejects.
     * Example: await cache.request(row);       // auto path
     *          await cache.request(row, true); // render anyway
     */
    function request(row: BodyRow, force?: boolean): Promise<BodyEntry> {
        const gate = gateFor(row);

        if (forbidsFetch(gate.state)) {
            stats.gateRefusals += 1;
            return Promise.resolve(refusalEntry(gate, row));
        }
        if (gate.state === BODY_STATE.GATED_SOFT && force !== true) {
            stats.gateRefusals += 1;
            return Promise.resolve(refusalEntry(gate, row));
        }

        const id = row.body_id;
        const hit = touch(id);
        if (hit) { stats.hits += 1; return Promise.resolve(hit); }
        const pending = inflight.get(id);
        if (pending) return pending;

        stats.fetches += 1;
        const p = withDeadline(
            Promise.resolve().then(() => client.getArchiveBody(id as number | string)),
            deadlineMs,
        ).then((res) => {
            inflight.delete(id);
            // A dead network is its own outcome and must not be laundered
            // into whatever the classifier makes of a null envelope.
            if (res && res.transportError) {
                return put(id, {
                    state: BODY_STATE.CANNOT_DETERMINE,
                    text: null,
                    chars: 0,
                    masked: 0,
                    findingCount: 0,
                    reason: 'the request did not complete: '
                        + String(res.transportError),
                    outcomeToken: 'transport-error',
                    bodyHref: null,
                });
            }
            const env = res ? res.envelope : null;
            const c = outcome.classify(env) as ClassifiedLike;
            if (c.token !== 'ok') {
                return put(id, {
                    state: BODY_STATE.CANNOT_DETERMINE,
                    text: null,
                    chars: 0,
                    masked: 0,
                    findingCount: 0,
                    reason: reasonFrom(c),
                    outcomeToken: c.token,
                    bodyHref: null,
                });
            }
            let payload = (env as { result?: unknown } | null)?.result;
            if (Array.isArray(payload)) payload = payload[0];
            return ingest(id, payload as BodyRow);
        });
        inflight.set(id, p);
        return p;
    }

    return {
        gateFor,
        request,
        offer,
        get: (bodyId: unknown) => touch(bodyId),
        isLoading: (bodyId: unknown) => inflight.has(bodyId),
        size: () => entries.size,
        chars: () => totalChars,
        stats: () => ({ ...stats }),
        clear: () => {
            entries.clear();
            inflight.clear();
            totalChars = 0;
        },
    };
}
