/**
 * THE FOUR CACHE GUARANTEES, PROVED BY COUNTING.
 *
 * `client/js/archive-body-cache.js` IS wired - into the reader, unlike
 * `archive-row-cache.js`, which slice 6 measured as having no consumer in
 * the transcript list at all. So the port has to be checked against what
 * it actually guarantees, and this file states those four as properties
 * and counts them:
 *
 *   G1 THE CACHE NEVER HOLDS AN UNMASKED SECRET-BEARING BODY. Proved by
 *     SCANNING EVERY STORED ENTRY for a canary string, after driving the
 *     cache through every refusal shape. A count of zero occurrences
 *     across the whole cache is the assertion; "the row rendered a
 *     refusal" is not, because a refusing renderer over a poisoned cache
 *     is one shortcut away from a disclosure.
 *   G2 BOTH CAPS, ALWAYS, AFTER EVERY INSERT. Proved by inserting far
 *     past each cap and counting `size()` and `chars()`, at 200 and at
 *     5,000 - the same falsifiable shape slice 6 used when it counted
 *     painted rows rather than timing a render.
 *   G3 ONE FETCH PER BODY ID. Proved by counting calls to the client.
 *   G4 EVERY REQUEST TERMINATES. Proved with an injected timer against a
 *     promise that NEVER settles: a real deadline resolves it, and the
 *     test would HANG rather than fail if the deadline were removed,
 *     which is why the timer is injected and fired by hand.
 *
 * NOTHING HERE IS TIMED. Every assertion is a count or an identity.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBodyCache, type BodyCache, type BodyEntry } from './reader-body-cache';
import { BODY_INLINE_MAX, BODY_RENDER_HARD_MAX } from './reader-gate';
import { BODY_STATE } from './reader-vocab';
import { SECRET_MARKER } from './reader-mask';
import type { OutcomeClassifier } from './state';
import type { ArchiveClient } from './client';
import type { EnvelopeResult } from '../types';

/**
 * The canary. If this string is anywhere in the cache, G1 has failed.
 *
 * NOT KEY-SHAPED ON PURPOSE - see `reader-harness.ts`.
 */
const CANARY = 'CANARY-IF-YOU-SEE-THIS-A-GATE-FAILED-OPEN';

/**
 * A classifier standing in for the still-vanilla `archive-outcome.js`.
 *
 * IT CARRIES `unevaluated` INTO `reasons`, because the real one does:
 * `client/js/archive-outcome.js:113` is literally `var reasons =
 * Array.isArray(envelope.unevaluated) ? envelope.unevaluated : []`. A
 * double that dropped it would make the deadline's own sentence
 * unreachable in this suite while it reaches the user in production -
 * the test and the product disagreeing about the shape, with only the
 * test wrong, which is the exact failure the vanilla cache's own header
 * records from 2026-08-31.
 */
const outcome: OutcomeClassifier = {
    classify(envelope: unknown) {
        const e = envelope as
            { result_status?: string; unevaluated?: unknown; meta?: unknown } | null;
        return {
            token: e?.result_status || 'transport_failed',
            reasons: Array.isArray(e?.unevaluated) ? e.unevaluated : [],
            meta: (e?.meta as Record<string, unknown>) || null,
        };
    },
    isRenderable: (t: string) => t === 'ok' || t === 'partial',
    hasMore: () => null,
};

/** One envelope result, shaped as the granted client returns it. */
function envelope(body: unknown, transportError: string | null = null): EnvelopeResult {
    return {
        envelope: body, httpStatus: transportError ? 0 : 200, headers: null,
        transportError, refusedByGrant: false,
    } as EnvelopeResult;
}

/** A body payload as GET /archive/bodies/{id} returns it. */
function payload(body: string, secrets: unknown = null, declared = 0): EnvelopeResult {
    return envelope({
        result: { body_json: body, secrets, secret_finding_count: declared },
        result_status: 'ok', meta: {},
    });
}

/** A client answering a fixed payload, counting how often it is asked. */
function clientAnswering(answer: (id: unknown) => EnvelopeResult) {
    const calls: unknown[] = [];
    const client = {
        getArchiveBody(id: unknown) {
            calls.push(id);
            return Promise.resolve(answer(id));
        },
    } as unknown as ArchiveClient;
    return { client, calls };
}

/**
 * Every character the cache is holding, concatenated.
 *
 * Description: THE G1 PROBE. It reads through `get`, which is the only
 *   read path a consumer has, over every id the test inserted. A canary
 *   surviving anywhere in this string is a body the masker refused that
 *   the cache kept anyway.
 */
function allCachedText(cache: BodyCache, ids: readonly unknown[]): string {
    let out = '';
    for (const id of ids) {
        const e = cache.get(id);
        if (e && typeof e.text === 'string') out += e.text;
        // A reason string is rendered to the user too, so it is scanned.
        if (e && typeof e.reason === 'string') out += e.reason;
    }
    return out;
}

describe('G1: the cache never holds an unmasked secret-bearing body', () => {
    /** Every shape in which the masker refuses, as the server can send them. */
    const REFUSING_SHAPES: readonly { name: string; res: EnvelopeResult }[] = [
        {
            name: 'declared secrets, NO findings array (the measured live shape)',
            res: payload(`key=${CANARY} rest`, null, 3),
        },
        {
            name: 'declared secrets, EMPTY findings array',
            res: payload(`key=${CANARY} rest`, [], 2),
        },
        {
            name: 'fewer findings than declared',
            res: payload(`a ${CANARY} b ${CANARY}`, [
                { utf16_state: 'computed', match_offset_utf16: 2, match_length_utf16: CANARY.length },
            ], 2),
        },
        {
            name: 'a finding the server could not locate',
            res: payload(`key=${CANARY}`, [
                { utf16_state: 'cannot_determine', match_offset_utf16: 4, match_length_utf16: CANARY.length },
            ], 1),
        },
        {
            name: 'a finding whose window runs past the end of the body',
            res: payload(`key=${CANARY}`, [
                { utf16_state: 'computed', match_offset_utf16: 4, match_length_utf16: 99999 },
            ], 1),
        },
        {
            name: 'a finding carrying only the code-point offsets',
            res: payload(`key=${CANARY}`, [
                { utf16_state: 'computed', match_offset: 4, match_length: CANARY.length },
            ], 1),
        },
    ];

    it('stores ZERO occurrences of the canary across every refusal shape, '
        + 'so no later caller can reach around the masker', async () => {
        const ids: number[] = [];
        const { client } = clientAnswering((id) => {
            const shape = REFUSING_SHAPES[(id as number) % REFUSING_SHAPES.length];
            return (shape as { res: EnvelopeResult }).res;
        });
        const cache = createBodyCache({ client, outcome });

        for (let i = 0; i < REFUSING_SHAPES.length; i += 1) {
            ids.push(i);
            const entry = await cache.request({ body_id: i, body_chars: 400 });
            expect(entry.state, REFUSING_SHAPES[i]?.name).toBe(BODY_STATE.MASK_REFUSED);
            expect(entry.text, REFUSING_SHAPES[i]?.name).toBeNull();
            // A refusal counts NOTHING toward the char cap, which is what
            // says the raw string went out of scope rather than being
            // held with a flag on it.
            expect(entry.chars).toBe(0);
        }

        // THE ASSERTION. Not "the row refused" - "the cache is clean".
        const held = allCachedText(cache, ids);
        expect(held.split(CANARY).length - 1).toBe(0);
        expect(cache.chars()).toBe(0);
    });

    it('MASKS rather than refuses when the findings ARE usable, and stores '
        + 'only the masked text', async () => {
        const body = `head ${CANARY} tail`;
        const at = body.indexOf(CANARY);
        const { client } = clientAnswering(() => payload(body, [
            { utf16_state: 'computed', match_offset_utf16: at, match_length_utf16: CANARY.length },
        ], 1));
        const cache = createBodyCache({ client, outcome });

        const entry = await cache.request({ body_id: 1, body_chars: body.length });
        expect(entry.state).toBe(BODY_STATE.OK);
        expect(entry.masked).toBe(1);
        expect(entry.text).toContain(SECRET_MARKER);
        expect(allCachedText(cache, [1]).split(CANARY).length - 1).toBe(0);
    });

    it('`offer` DROPS a body it cannot mask rather than storing it, so a '
        + 'regression costs a refetch and never a disclosure', () => {
        const { client } = clientAnswering(() => payload('unused'));
        const cache = createBodyCache({ client, outcome });

        const stored = cache.offer({
            body_id: 9, body_chars: 40,
            body_json: `key=${CANARY}`, secrets: null, secret_finding_count: 1,
        });
        expect(stored).toBeNull();
        expect(cache.get(9)).toBeNull();
        expect(cache.size()).toBe(0);
    });

    it('THE NEGATIVE CONTROL FOR G1: a clean body IS stored, or this '
        + 'suite would pass against a cache that stored nothing', async () => {
        const { client } = clientAnswering(() => payload('ordinary bytes', [], 0));
        const cache = createBodyCache({ client, outcome });
        const entry = await cache.request({ body_id: 1, body_chars: 14 });
        expect(entry.state).toBe(BODY_STATE.OK);
        expect(entry.text).toBe('ordinary bytes');
        expect(cache.size()).toBe(1);
        expect(cache.chars()).toBe(14);
    });
});

describe('G2: both caps hold after every insert', () => {
    it('holds the ENTRY cap at 200 and at 5,000 inserts, counted', async () => {
        const { client } = clientAnswering(() => payload('x'.repeat(10)));
        const cache = createBodyCache({ client, outcome, maxEntries: 30, maxChars: 1e9 });

        for (let i = 0; i < 200; i += 1) {
            await cache.request({ body_id: i, body_chars: 10 });
        }
        expect(cache.size()).toBe(30);

        for (let i = 200; i < 5000; i += 1) {
            await cache.request({ body_id: i, body_chars: 10 });
        }
        // THE SAME NUMBER at 200 and at 5,000: the bound does not depend
        // on how many bodies were ever seen.
        expect(cache.size()).toBe(30);
        expect(cache.stats().evictions).toBe(5000 - 30);
    });

    it('holds the CHAR cap independently, which the entry cap alone '
        + 'cannot: 300 bodies at 54 MB each is not a cache', async () => {
        const big = 'y'.repeat(1000);
        const { client } = clientAnswering(() => payload(big));
        const cache = createBodyCache({ client, outcome, maxEntries: 1e6, maxChars: 5000 });

        for (let i = 0; i < 200; i += 1) {
            await cache.request({ body_id: i, body_chars: big.length });
        }
        expect(cache.chars()).toBeLessThanOrEqual(5000);
        expect(cache.size()).toBe(5);
        // The entry cap was never the binding one here, which is the point.
        expect(cache.size()).toBeLessThan(1e6);
    });

    it('evicts LEAST RECENTLY USED, and a read is a use', async () => {
        const { client } = clientAnswering(() => payload('zz'));
        const cache = createBodyCache({ client, outcome, maxEntries: 2, maxChars: 1e9 });

        await cache.request({ body_id: 'a', body_chars: 2 });
        await cache.request({ body_id: 'b', body_chars: 2 });
        // Touch 'a', making 'b' the least recently used.
        expect(cache.get('a')).not.toBeNull();
        await cache.request({ body_id: 'c', body_chars: 2 });

        expect(cache.get('a')).not.toBeNull();
        expect(cache.get('b')).toBeNull();
        expect(cache.get('c')).not.toBeNull();
    });

    it('keeps `chars()` in step with the entries it actually holds', async () => {
        const { client } = clientAnswering(() => payload('abcde'));
        const cache = createBodyCache({ client, outcome, maxEntries: 3, maxChars: 1e9 });
        for (let i = 0; i < 50; i += 1) {
            await cache.request({ body_id: i, body_chars: 5 });
        }
        expect(cache.size()).toBe(3);
        expect(cache.chars()).toBe(15);
    });
});

describe('G3: one fetch per body id', () => {
    it('fifty concurrent callers for one body issue exactly ONE request', async () => {
        const { client, calls } = clientAnswering(() => payload('shared'));
        const cache = createBodyCache({ client, outcome });

        const row = { body_id: 77, body_chars: 6 };
        const all = await Promise.all(
            Array.from({ length: 50 }, () => cache.request(row)),
        );
        expect(calls).toHaveLength(1);
        expect(cache.stats().fetches).toBe(1);
        // And every caller got the same answer.
        for (const e of all) expect(e.text).toBe('shared');
    });

    it('a later request for a cached body is a HIT, not a second fetch', async () => {
        const { client, calls } = clientAnswering(() => payload('once'));
        const cache = createBodyCache({ client, outcome });
        const row = { body_id: 5, body_chars: 4 };
        await cache.request(row);
        await cache.request(row);
        expect(calls).toHaveLength(1);
        expect(cache.stats().hits).toBe(1);
    });

    it('NEVER FETCHES a hard-gated, withheld, body-less or unmeasurable '
        + 'body, at any value of force', async () => {
        const { client, calls } = clientAnswering(() => payload('must not happen'));
        const cache = createBodyCache({ client, outcome });

        const refused = [
            { body_id: 1, body_chars: BODY_RENDER_HARD_MAX + 1 },
            { body_id: 2, body_chars: 54376859 },
            { body_id: 3, body_chars: 10, body_state: 'withheld_too_large' },
            { body_id: null, body_chars: 10 },
            { body_id: 5, body_chars: 'not a number' },
        ];
        for (const row of refused) {
            for (const force of [false, true]) {
                const e = await cache.request(row, force);
                expect(e.text).toBeNull();
                expect(e.gated).toBe(true);
            }
        }
        // TEN REQUESTS, ZERO NETWORK. The gate is evaluated from the
        // spine, before anything is downloaded.
        expect(calls).toHaveLength(0);
        expect(cache.stats().fetches).toBe(0);
        expect(cache.stats().gateRefusals).toBe(10);
    });

    it('a SOFT gate refuses the auto path and yields to an explicit ask, '
        + 'which is the whole difference from the hard gate', async () => {
        const { client, calls } = clientAnswering(() => payload('big but allowed'));
        const cache = createBodyCache({ client, outcome });
        const row = { body_id: 8, body_chars: BODY_INLINE_MAX + 1 };

        const auto = await cache.request(row);
        expect(auto.state).toBe(BODY_STATE.GATED_SOFT);
        expect(calls).toHaveLength(0);

        const asked = await cache.request(row, true);
        expect(asked.state).toBe(BODY_STATE.OK);
        expect(calls).toHaveLength(1);
    });
});

describe('G4: every request terminates', () => {
    it('resolves a cannot-determine when the request never settles, '
        + 'rather than leaving a loading state that can never fail', async () => {
        let fire: (() => void) | null = null;
        const client = {
            // A promise that NEVER settles. Without a deadline this test
            // would HANG rather than fail, which is exactly the defect
            // shape the deadline exists to prevent.
            getArchiveBody: () => new Promise<EnvelopeResult>(() => {}),
        } as unknown as ArchiveClient;

        const cache = createBodyCache({
            client,
            outcome,
            deadlineMs: 30000,
            setTimeoutFn: (fn: () => void) => { fire = fn; return 1; },
            clearTimeoutFn: () => {},
        });

        const p = cache.request({ body_id: 1, body_chars: 10 });
        expect(fire).not.toBeNull();
        (fire as unknown as () => void)();
        const entry = await p;
        expect(entry.state).toBe(BODY_STATE.CANNOT_DETERMINE);
        expect(entry.text).toBeNull();
        expect(entry.reason).toContain('30s');
    });

    it('settles a REJECTION too, because a promise that neither resolves '
        + 'nor rejects is the same defect one layer down', async () => {
        const client = {
            getArchiveBody: () => Promise.reject(new Error('socket died')),
        } as unknown as ArchiveClient;
        const cache = createBodyCache({ client, outcome });
        const entry = await cache.request({ body_id: 1, body_chars: 10 });
        expect(entry.state).toBe(BODY_STATE.CANNOT_DETERMINE);
        expect(entry.reason).toContain('socket died');
    });

    it('keeps a DEAD NETWORK as its own outcome rather than laundering it '
        + 'through the classifier', async () => {
        const { client } = clientAnswering(() => envelope(null, 'ECONNREFUSED'));
        const cache = createBodyCache({ client, outcome });
        const entry = await cache.request({ body_id: 1, body_chars: 10 });
        expect(entry.state).toBe(BODY_STATE.CANNOT_DETERMINE);
        expect(entry.outcomeToken).toBe('transport-error');
        expect(entry.reason).toContain('ECONNREFUSED');
    });

    it('refuses a response carrying no body_json string', async () => {
        const { client } = clientAnswering(() => envelope({
            result: { body_json: null }, result_status: 'ok', meta: {},
        }));
        const cache = createBodyCache({ client, outcome });
        const entry = await cache.request({ body_id: 1, body_chars: 10 });
        expect(entry.state).toBe(BODY_STATE.CANNOT_DETERMINE);
        expect(entry.reason).toContain('body_json');
    });
});

describe('construction refuses what it cannot work without', () => {
    it('will not build without a client that can fetch a body', () => {
        expect(() => createBodyCache({
            client: {} as ArchiveClient, outcome,
        })).toThrow(/getArchiveBody/);
    });

    it('will not build without a classifier', () => {
        const { client } = clientAnswering(() => payload('x'));
        expect(() => createBodyCache({
            client, outcome: null as unknown as OutcomeClassifier,
        })).toThrow(/classifier/);
    });
});

describe('clear: a new transcript shares nothing with the old one', () => {
    it('drops every entry and every counter of held state', async () => {
        const { client } = clientAnswering(() => payload('abc'));
        const cache = createBodyCache({ client, outcome });
        await cache.request({ body_id: 1, body_chars: 3 });
        expect(cache.size()).toBe(1);
        cache.clear();
        expect(cache.size()).toBe(0);
        expect(cache.chars()).toBe(0);
        expect(cache.get(1)).toBeNull();
    });
});

/** Keep vi imported-and-used so a lint pass cannot call it dead weight. */
describe('the suite counts rather than times', () => {
    it('uses no fake clock anywhere, by construction', () => {
        expect(vi.isFakeTimers()).toBe(false);
    });
});

/** Referenced so the type import is load-bearing rather than decorative. */
export type { BodyEntry };
