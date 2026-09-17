/**
 * THE PAGER'S GUARD AND THE SPINE REDUCERS.
 *
 * Both are pure, so the whole paging contract is asserted without a
 * network, a document or a component - the same split slice 6 used for
 * `tlist-paging.ts`.
 *
 * THE TWO PROPERTIES WORTH THE FILE: a second caller JOINS the in-flight
 * page rather than starting a second one (or the reader appends two
 * pages out of order), and a REJECTION clears the guard exactly like a
 * resolution (or a failed page leaves a dead button that is
 * indistinguishable from the end of the transcript).
 */
import { describe, expect, it } from 'vitest';
import {
    createPager, DEFAULT_PAGE_ROWS, PAGE_COMPLETE, PAGE_FAILED, PAGE_NO_PAGER,
} from './reader-paging';
import {
    appendSpine, applySpine, emptySpine, fetchSpine, loadingSpine,
    nextStartLine, sentinelText, NEXT_LINE_STEP, TOKEN_TRANSPORT_ERROR,
} from './reader-load';
import type { OutcomeClassifier } from './state';
import type { ArchiveClient } from './client';
import type { EnvelopeResult } from '../types';

/** A classifier reading `has_more` out of `meta.paging`, as the real one does. */
const outcome: OutcomeClassifier = {
    classify(envelope: unknown) {
        const e = envelope as { result_status?: string; meta?: unknown } | null;
        return {
            token: e?.result_status || 'transport_failed',
            reasons: [],
            meta: (e?.meta as Record<string, unknown>) || null,
        };
    },
    isRenderable: (t: string) => t === 'ok' || t === 'partial',
    hasMore(envelope: unknown) {
        const m = (envelope as { meta?: { paging?: { has_more?: unknown } } } | null)?.meta;
        const v = m?.paging?.has_more;
        return typeof v === 'boolean' ? v : null;
    },
};

/** One envelope result. */
function env(body: unknown, transportError: string | null = null): EnvelopeResult {
    return {
        envelope: body, httpStatus: transportError ? 0 : 200, headers: null,
        transportError, refusedByGrant: false,
    } as EnvelopeResult;
}

/** A /lines page carrying `rows`, with an explicit `has_more`. */
function page(rows: unknown[], hasMore: boolean | null = null, status = 'ok') {
    return env({
        result: rows, result_status: status,
        meta: { paging: hasMore === null ? {} : { has_more: hasMore } },
    });
}

/** A transcript header envelope. */
function head(record: unknown, status = 'ok') {
    return env({ result: record, result_status: status, meta: {} });
}

describe('createPager: one guard, two callers', () => {
    /** A pager whose callback the test settles by hand. */
    function harness(opts: { complete?: boolean; wired?: boolean } = {}) {
        let calls = 0;
        let notifies = 0;
        let settle: ((v: unknown) => void) | null = null;
        let reject: ((e: unknown) => void) | null = null;
        const cb = () => {
            calls += 1;
            return new Promise<unknown>((res, rej) => { settle = res; reject = rej; });
        };
        const pager = createPager({
            onLoadMore: () => (opts.wired === false ? null : cb),
            spineComplete: () => opts.complete === true,
            notify: () => { notifies += 1; },
        });
        return {
            pager,
            calls: () => calls,
            notifies: () => notifies,
            /**
             * Let the pending microtask run.
             *
             * THE CALLBACK IS INVOKED ONE MICROTASK LATE, on purpose and
             * exactly as the vanilla pager did: the guard is armed
             * SYNCHRONOUSLY (`inFlight` is assigned before
             * `requestMoreLines` returns, which is what makes a second
             * caller join) and the callback runs off
             * `Promise.resolve().then(...)`. So a test asserting the
             * CALL COUNT has to flush first; a test asserting the GUARD
             * does not.
             */
            flush: () => Promise.resolve().then(() => {}),
            settle: (v: unknown) => (settle as unknown as (v: unknown) => void)(v),
            reject: (e: unknown) => (reject as unknown as (e: unknown) => void)(e),
        };
    }

    it('A SECOND CALLER JOINS THE FIRST, so a key cannot double-fetch '
        + 'while the button is mid-flight and append two pages', async () => {
        const h = harness();
        const a = h.pager.requestMoreLines();
        const b = h.pager.requestMoreLines();
        // THE GUARD IS ARMED SYNCHRONOUSLY: the second caller gets the
        // FIRST promise back, before any callback has run.
        expect(a).toBe(b);
        expect(h.pager.isLoadingMore()).toBe(true);
        await h.flush();
        expect(h.calls()).toBe(1);
        h.settle('ok');
        await a;
        expect(h.pager.isLoadingMore()).toBe(false);
    });

    it('A REJECTION CLEARS THE GUARD EXACTLY LIKE A RESOLUTION, or the '
        + 'button is a dead end that looks like the end of the file',
    async () => {
        const h = harness();
        const p = h.pager.requestMoreLines();
        await h.flush();
        h.reject(new Error('the page did not come back'));
        await expect(p).resolves.toBe(PAGE_FAILED);
        expect(h.pager.isLoadingMore()).toBe(false);
        // AND IT IS ASKABLE AGAIN. That is the property.
        const again = h.pager.requestMoreLines();
        await h.flush();
        expect(h.calls()).toBe(2);
        h.settle('ok');
        await again;
    });

    it('answers THREE NAMED STRINGS that are not a fetch, never null', async () => {
        await expect(harness({ complete: true }).pager.requestMoreLines())
            .resolves.toBe(PAGE_COMPLETE);
        await expect(harness({ wired: false }).pager.requestMoreLines())
            .resolves.toBe(PAGE_NO_PAGER);
        // And the three are distinguishable from each other.
        expect(new Set([PAGE_COMPLETE, PAGE_NO_PAGER, PAGE_FAILED]).size).toBe(3);
    });

    it('does not call the callback at all when there is nothing left', async () => {
        const h = harness({ complete: true });
        void h.pager.requestMoreLines();
        await h.flush();
        expect(h.calls()).toBe(0);
    });

    it('repaints when the guard flips, so the busy state is visible', async () => {
        const h = harness();
        const p = h.pager.requestMoreLines();
        expect(h.notifies()).toBe(1);
        await h.flush();
        h.settle('ok');
        await p;
        expect(h.notifies()).toBe(2);
    });

    it("states the page size in the button's label, both ways", () => {
        const h = harness();
        expect(h.pager.label(500)).toBe('Load 500 more lines');
        void h.pager.requestMoreLines();
        expect(h.pager.label(500)).toBe('Loading 500 more lines...');
        expect(DEFAULT_PAGE_ROWS).toBe(500);
    });
});

describe('applySpine: three outcomes, explicitly, twice', () => {
    const rows = [{ line_no: 1 }, { line_no: 2 }];

    it('keeps the HEADER and the SPINE as independent findings', () => {
        // A failed header must not blank a spine that arrived.
        const a = applySpine(emptySpine(), {
            head: env(null, 'ECONNREFUSED'), page: page(rows, false), windowed: false,
        }, outcome);
        expect(a.header).toBeNull();
        expect(a.rows).toHaveLength(2);
        expect(a.token).toBe('ok');

        // And a failed spine must not discard a header that did arrive.
        const b = applySpine(emptySpine(), {
            head: head({ transcript_id: 5767, line_count: 30805 }),
            page: page([], null, 'budget_exhausted'),
            windowed: false,
        }, outcome);
        expect(b.header).toMatchObject({ transcript_id: 5767 });
        expect(b.token).toBe('budget_exhausted');
        expect(b.rows).toHaveLength(0);
    });

    it('keeps a TRANSPORT FAILURE apart from an unreadable envelope and '
        + 'from an empty transcript', () => {
        const dead = applySpine(emptySpine(), {
            head: head(null), page: env(null, 'ECONNREFUSED'), windowed: false,
        }, outcome);
        expect(dead.token).toBe(TOKEN_TRANSPORT_ERROR);
        expect(dead.transportError).toBe('ECONNREFUSED');
        expect(dead.envelope).toBeNull();

        const refused = applySpine(emptySpine(), {
            head: head(null), page: page([], null, 'not_found'), windowed: false,
        }, outcome);
        expect(refused.token).toBe('not_found');
        expect(refused.transportError).toBeNull();
        expect(refused.envelope).not.toBeNull();

        const empty = applySpine(emptySpine(), {
            head: head(null), page: page([], false), windowed: false,
        }, outcome);
        expect(empty.token).toBe('ok');
        expect(empty.rows).toHaveLength(0);
        expect(empty.complete).toBe(true);
    });

    it('ONLY AN EXPLICIT `has_more === false` PROVES THE SPINE COMPLETE. '
        + 'null renders the sentinel rather than an end nobody measured', () => {
        const nullish = applySpine(emptySpine(), {
            head: head(null), page: page(rows, null), windowed: false,
        }, outcome);
        expect(nullish.complete).toBe(false);

        const measured = applySpine(emptySpine(), {
            head: head(null), page: page(rows, false), windowed: false,
        }, outcome);
        expect(measured.complete).toBe(true);
    });

    it('A WINDOWED SPINE IS NEVER COMPLETE, even when the server says '
        + "has_more is false: every line before the offset is missing", () => {
        const w = applySpine(emptySpine(), {
            head: head(null), page: page(rows, false), windowed: true,
        }, outcome);
        expect(w.complete).toBe(false);
    });

    it('loadingSpine paints a named in-flight state and clears the last '
        + 'failure', () => {
        const failed = { ...emptySpine(), token: 'not_found', transportError: 'x' };
        const l = loadingSpine(failed);
        expect(l.token).toBe('loading');
        expect(l.transportError).toBeNull();
        expect(l.envelope).toBeNull();
    });
});

describe('appendSpine: the SAME transcript, one page further on', () => {
    const first = applySpine(emptySpine(), {
        head: head(null), page: page([{ line_no: 1 }, { line_no: 2 }], true), windowed: false,
    }, outcome);

    it('APPENDS rather than replaces', () => {
        const next = appendSpine(first, page([{ line_no: 3 }], false), outcome);
        expect(next.rows.map((r) => r.line_no)).toEqual([1, 2, 3]);
        expect(next.complete).toBe(true);
    });

    it('KEEPS THE ROWS ALREADY HELD when a page fails. Discarding the '
        + 'transcript would be a far worse answer than saying so', () => {
        const dead = appendSpine(first, env(null, 'ECONNREFUSED'), outcome);
        expect(dead.rows).toHaveLength(2);
        expect(dead.token).toBe(TOKEN_TRANSPORT_ERROR);

        const refused = appendSpine(first, page([], null, 'budget_exhausted'), outcome);
        expect(refused.rows).toHaveLength(2);
        expect(refused.token).toBe('budget_exhausted');
    });
});

describe('nextStartLine: never a number and a reason together', () => {
    it('answers one past the last line held, because start_line is '
        + 'INCLUSIVE', () => {
        expect(NEXT_LINE_STEP).toBe(1);
        expect(nextStartLine([{ line_no: 499 }])).toEqual({ next: 500 });
        expect(nextStartLine([{ line_no: 1 }, { line_no: 7110 }])).toEqual({ next: 7111 });
    });

    it('NAMES WHY there is no position, rather than answering zero', () => {
        for (const bad of [[], null, undefined]) {
            const r = nextStartLine(bad as never);
            expect(r.next).toBeUndefined();
            expect(r.reason).toBeTruthy();
        }
        const noLine = nextStartLine([{ line_no: 'seven' }] as never);
        expect(noLine.next).toBeUndefined();
        expect(noLine.reason).toContain('line_no');
    });
});

describe('fetchSpine: a deep link asks the SERVER for the window it wants', () => {
    /** A client recording the options it was handed. */
    function recordingClient() {
        const asked: Record<string, unknown>[] = [];
        const client = {
            getArchiveTranscript: () => Promise.resolve(head(null)),
            listArchiveLines: (_id: unknown, opts: Record<string, unknown>) => {
                asked.push(opts);
                return Promise.resolve(page([], false));
            },
        } as unknown as ArchiveClient;
        return { client, asked };
    }

    it('sends start_line when a line was asked for, and NOT otherwise', async () => {
        const a = recordingClient();
        await fetchSpine(a.client, 5767, 7111, 500);
        expect(a.asked[0]).toEqual({ limit: 500, startLine: 7111 });

        const b = recordingClient();
        const r = await fetchSpine(b.client, 5767, null, 500);
        expect(b.asked[0]).toEqual({ limit: 500 });
        expect(r.windowed).toBe(false);
    });

    it('SENDS start_line 0, which is a real request for the first line '
        + 'and must not be dropped as falsy', async () => {
        const a = recordingClient();
        const r = await fetchSpine(a.client, 5767, 0, 500);
        expect(a.asked[0]).toEqual({ limit: 500, startLine: 0 });
        expect(r.windowed).toBe(true);
    });
});

describe('sentinelText', () => {
    it('says how much is loaded, because a list that just ends looks '
        + 'complete', () => {
        expect(sentinelText(500)).toContain('500');
        expect(sentinelText(500)).toContain('not loaded yet');
    });
});
