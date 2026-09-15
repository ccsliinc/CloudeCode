/**
 * THE PAGING CONTRACT, AND THE THREE THINGS THIS LIST MUST REFUSE TO
 * RENDER.
 *
 * A LIST THAT RENDERS SOMETHING NO MATTER WHAT IT IS GIVEN PASSES EVERY
 * POSITIVE TEST AND IS USELESS. So the three refusals get named negative
 * controls, each phrased so that deleting the guard it covers turns it
 * red rather than leaving it quietly green:
 *   N1 a NON-RENDERABLE envelope must append NO rows and must not
 *      restart paging, because a client paging 3,416 rows that restarts
 *      on its own renders duplicates forever.
 *   N2 `has_more: null` must NOT offer a load-more control. `null` is
 *      the server's failure answer on every path - measured, the
 *      budget_exhausted search answered exactly that - and rendering it
 *      as `false` claims the end of a list nobody read.
 *   N3 a page with rows already on screen must KEEP them when a later
 *      page fails, rather than blanking a pane somebody had paged into.
 *
 * Node environment: every assertion here is about a value a pure
 * function returned, so a DOM would be a dependency bought for nothing.
 */
import { describe, it, expect } from 'vitest';
import {
    applyPage,
    canLoadMore,
    describeFooter,
    emptyPaging,
    fetchPage,
    type ListScope,
    type PagingState,
} from './tlist-paging';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/**
 * A classifier standing in for `archive-outcome.js`, which is still
 * vanilla and is injected rather than imported.
 * Inputs: renderable - which tokens count as renderable.
 * Output: an OutcomeClassifier reading `result_status` off the envelope.
 */
function classifier(renderable: readonly string[] = ['ok', 'partial']): OutcomeClassifier {
    return {
        classify(envelope: unknown) {
            const e = envelope as {
                result_status?: string;
                meta?: Record<string, unknown>;
            } | null;
            return {
                token: e?.result_status || 'transport_failed',
                reasons: [],
                meta: e?.meta || null,
            };
        },
        isRenderable: (token: string) => renderable.indexOf(token) !== -1,
        hasMore(envelope: unknown) {
            const e = envelope as { has_more?: boolean | null } | null;
            if (!e || e.has_more === undefined) return null;
            return e.has_more;
        },
    };
}

/** One EnvelopeResult carrying `envelope`, as the granted client resolves. */
function served(envelope: unknown, httpStatus = 200): EnvelopeResult {
    return {
        envelope,
        httpStatus,
        headers: null,
        transportError: null,
        refusedByGrant: false,
    };
}

/** One EnvelopeResult for a server that could not be reached. */
function dead(reason: string): EnvelopeResult {
    return {
        envelope: null,
        httpStatus: null,
        headers: null,
        transportError: reason,
        refusedByGrant: false,
    };
}

/** N rows with sequential ids, enough to page. */
function page(n: number, from = 1) {
    return Array.from({ length: n }, (_, i) => ({
        transcript_id: from + i,
        session_ref: `ref-${from + i}`,
        session_ref_scheme: 'uuid',
    }));
}

const SCOPE: ListScope = { kind: 'project', id: 12, inScope: 3416 };

describe('applyPage: appending a renderable page', () => {
    it('appends rows and records the cursor and has_more', () => {
        const next = applyPage(
            emptyPaging(SCOPE),
            served({
                result: page(50),
                result_status: 'ok',
                has_more: true,
                meta: { paging: { next_cursor: 'c1' } },
            }),
            classifier(),
        );
        expect(next.rows).toHaveLength(50);
        expect(next.nextCursor).toBe('c1');
        expect(next.hasMore).toBe(true);
        expect(next.token).toBe('ok');
        expect(canLoadMore(next)).toBe(true);
    });

    it('APPENDS rather than replacing, so paging accumulates', () => {
        const first = applyPage(
            emptyPaging(SCOPE),
            served({
                result: page(50), result_status: 'ok', has_more: true,
                meta: { paging: { next_cursor: 'c1' } },
            }),
            classifier(),
        );
        const second = applyPage(
            first,
            served({
                result: page(50, 51), result_status: 'ok', has_more: false,
                meta: { paging: {} },
            }),
            classifier(),
        );
        expect(second.rows).toHaveLength(100);
        expect(second.rows[0]?.transcript_id).toBe(1);
        expect(second.rows[99]?.transcript_id).toBe(100);
        expect(canLoadMore(second)).toBe(false);
    });

    it('keeps a partial page\'s rows AND its envelope, as one state', () => {
        const next = applyPage(
            emptyPaging(SCOPE),
            served({ result: page(7), result_status: 'partial', meta: {} }),
            classifier(),
        );
        expect(next.rows).toHaveLength(7);
        expect(next.keepRows).toBe(true);
        expect(next.outcomeEnvelope).not.toBeNull();
    });
});

describe('applyPage: the refusals', () => {
    it('N1 NEGATIVE CONTROL: a non-renderable envelope appends NO rows '
        + 'and clears the cursor rather than restarting', () => {
        const next = applyPage(
            emptyPaging(SCOPE),
            served({
                // Rows ARE present in the body. A component that read
                // `envelope.result` without asking whether the outcome was
                // renderable would show them as though they were an answer.
                result: page(9),
                result_status: 'budget_exhausted',
                has_more: null,
                meta: { paging: { next_cursor: 'c-should-not-be-used' } },
            }),
            classifier(),
        );
        expect(next.rows).toHaveLength(0);
        expect(next.nextCursor).toBeNull();
        expect(canLoadMore(next)).toBe(false);
        expect(next.token).toBe('budget_exhausted');
    });

    it('N3 NEGATIVE CONTROL: rows already on screen SURVIVE a later '
        + 'failed page', () => {
        const loaded = applyPage(
            emptyPaging(SCOPE),
            served({
                result: page(50), result_status: 'ok', has_more: true,
                meta: { paging: { next_cursor: 'c1' } },
            }),
            classifier(),
        );
        const failed = applyPage(loaded, dead('network unreachable'), classifier());
        expect(failed.rows).toHaveLength(50);
        expect(failed.keepRows).toBe(true);
        expect(failed.transportError).toBe('network unreachable');
        // AND the cursor is gone, so nothing auto-restarts at page one.
        expect(failed.nextCursor).toBeNull();
    });

    it('carries a transport failure as a finding, never as a rejection', () => {
        const next = applyPage(emptyPaging(SCOPE), dead('deadline'), classifier());
        expect(next.transportError).toBe('deadline');
        expect(next.outcomeEnvelope).toBeNull();
        expect(next.hasMore).toBeNull();
    });
});

describe('describeFooter: has_more is three-valued', () => {
    it('offers the control on true and ONLY on true', () => {
        expect(describeFooter(true, '50').offerMore).toBe(true);
    });

    it('N2 NEGATIVE CONTROL: null offers NO control and says NOT KNOWN', () => {
        const f = describeFooter(null, '3,416');
        expect(f.offerMore).toBe(false);
        expect(f.unknown).toBe(true);
        expect(f.text).toContain('NOT KNOWN');
        // The sentence has to say the two are different, or a reader
        // takes the absent control as "that is all of them".
        expect(f.text).toContain('not the same as');
    });

    it('states a measured end on false, and does not call it unknown', () => {
        const f = describeFooter(false, '3,416');
        expect(f.offerMore).toBe(false);
        expect(f.unknown).toBe(false);
        expect(f.text).toContain('End of the list');
        expect(f.text).toContain('3,416');
    });
});

describe('fetchPage: which route a scope maps to', () => {
    it('sends the scheme filter for a project, as the wire value', async () => {
        const calls: Array<Record<string, unknown>> = [];
        const client = {
            listArchiveTranscripts(id: unknown, opts: unknown) {
                calls.push({ route: 'transcripts', id, opts });
                return Promise.resolve(served({ result: [], result_status: 'ok' }));
            },
            listArchiveUnattributed() {
                calls.push({ route: 'unattributed' });
                return Promise.resolve(served({ result: [], result_status: 'ok' }));
            },
        } as unknown as Parameters<typeof fetchPage>[0];

        await fetchPage(client, SCOPE, 'uuid', null);
        expect(calls[0]?.route).toBe('transcripts');
        expect((calls[0]?.opts as { sessionRefScheme?: unknown }).sessionRefScheme)
            .toBe('uuid');

        // 'all' must become NULL, not the string 'all'. Sending
        // `session_ref_scheme=all` is an unknown scheme and answers 400.
        await fetchPage(client, SCOPE, 'all', null);
        expect((calls[1]?.opts as { sessionRefScheme?: unknown }).sessionRefScheme)
            .toBeNull();
    });

    it('NEVER sends a scheme filter on the unattributed route', async () => {
        const seen: unknown[] = [];
        const client = {
            listArchiveTranscripts() {
                throw new Error('wrong route for an unattributed scope');
            },
            listArchiveUnattributed(id: unknown, opts: unknown) {
                seen.push(opts);
                return Promise.resolve(served({ result: [], result_status: 'ok' }));
            },
        } as unknown as Parameters<typeof fetchPage>[0];

        await fetchPage(
            client,
            { kind: 'unattributed', id: 3, inScope: null },
            'uuid',
            null,
        );
        expect(seen).toHaveLength(1);
        expect(Object.keys(seen[0] as object)).not.toContain('sessionRefScheme');
    });
});

describe('canLoadMore', () => {
    it('refuses with no cursor, so a failed page cannot restart at one', () => {
        expect(canLoadMore(emptyPaging(SCOPE))).toBe(false);
        const withEmpty = { ...emptyPaging(SCOPE), nextCursor: '' } as PagingState;
        expect(canLoadMore(withEmpty)).toBe(false);
    });
});
