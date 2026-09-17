/**
 * THE SHARED TEST HARNESS for the mounted reader: a fake archive client,
 * a classifier, and spine fixtures.
 *
 * WHY IT IS ITS OWN FILE. `TranscriptReader.behaviour.test.ts` and
 * `TranscriptReader.commitments.test.ts` both mount the real component
 * against the real modules, and they need the same doubles. Two copies
 * would drift, and the one that drifted would be the one proving the
 * security property. It is a `.ts` rather than a `.test.ts` so the test
 * glob does not try to run it as a suite - the same reason
 * `tests/helpers/led_state_for.mjs` lives outside `tests/*.node.mjs`.
 */
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';
import type { EnvelopeResult } from '../types';

/**
 * The canary. Its presence in the DOM is a credential disclosure.
 *
 * IT IS DELIBERATELY NOT KEY-SHAPED, and that is not cosmetic: a
 * realistic `sk-live-...` string trips this repo's own pre-commit
 * gitleaks gate (rule `generic-api-key`), which refuses the commit. A
 * test fixture that has to be waved past a secret scanner teaches the
 * next person to wave the scanner past something real. Nothing here
 * needs realism - the masker is driven by OFFSETS and LENGTHS the test
 * computes from this string, never by its shape - so the canary says
 * what it is instead.
 */
export const CANARY = 'CANARY-IF-YOU-SEE-THIS-A-GATE-FAILED-OPEN';

/**
 * A classifier standing in for the still-vanilla `archive-outcome.js`.
 *
 * It carries `unevaluated` into `reasons` and reads `has_more` out of
 * `meta.paging`, because the real one does both
 * (`client/js/archive-outcome.js:113` and its `hasMore`).
 */
export const outcome: OutcomeClassifier = {
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
    hasMore(envelope: unknown) {
        const v = (envelope as { meta?: { paging?: { has_more?: unknown } } } | null)
            ?.meta?.paging?.has_more;
        return typeof v === 'boolean' ? v : null;
    },
};

/** One envelope result, shaped as the granted client returns it. */
export function env(body: unknown, transportError: string | null = null): EnvelopeResult {
    return {
        envelope: body, httpStatus: transportError ? 0 : 200, headers: null,
        transportError, refusedByGrant: false,
    } as EnvelopeResult;
}

/** A /lines page envelope. */
export function linesPage(rows: unknown[], hasMore: boolean | null = null): EnvelopeResult {
    return env({
        result: rows,
        result_status: 'ok',
        meta: { paging: hasMore === null ? {} : { has_more: hasMore } },
    });
}

/** One spine row, with sane defaults a test can override. */
export function spineRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        line_no: 1,
        record_type: 'assistant',
        role: 'assistant',
        ts: '2026-01-01T00:00:00Z',
        model: 'claude-opus-5',
        body_id: 1,
        body_chars: 120,
        body_state: 'included',
        ...over,
    };
}

/** What `fakeClient` was asked, so a test can count requests. */
export interface AskLog {
    readonly lines: Record<string, unknown>[];
    readonly bodies: unknown[];
    readonly transcripts: unknown[];
}

/** How `fakeClient` should answer. */
export interface FakeAnswers {
    /** The transcript header record, or null for none. */
    readonly header?: unknown;
    /** The first /lines page. */
    readonly page?: EnvelopeResult;
    /** Later /lines pages, consumed in order; the last repeats. */
    readonly morePages?: readonly EnvelopeResult[];
    /** Answer one body id. Defaults to a clean 120-char body. */
    readonly body?: (id: unknown) => EnvelopeResult;
}

/**
 * A granted-client double, recording what it was asked.
 *
 * Description: only the three endpoints the reader uses are implemented.
 *   The rest are absent rather than stubbed, so a reader that started
 *   calling one would fail loudly here instead of silently getting an
 *   empty answer.
 * Inputs: answers - what to reply with.
 * Output: the client and the ask log.
 * Example: const {client, asked} = fakeClient({page: linesPage(rows, false)});
 */
export function fakeClient(answers: FakeAnswers = {}): {
    client: ArchiveClient; asked: AskLog;
} {
    const asked: AskLog = { lines: [], bodies: [], transcripts: [] };
    let pageCount = 0;
    const client = {
        getArchiveTranscript(id: unknown) {
            asked.transcripts.push(id);
            return Promise.resolve(env({
                result: answers.header ?? null, result_status: 'ok', meta: {},
            }));
        },
        listArchiveLines(_id: unknown, opts: Record<string, unknown> = {}) {
            asked.lines.push(opts);
            if (pageCount === 0) {
                pageCount += 1;
                return Promise.resolve(answers.page ?? linesPage([], false));
            }
            const more = answers.morePages ?? [];
            const at = Math.min(pageCount - 1, more.length - 1);
            pageCount += 1;
            return Promise.resolve(
                at >= 0 ? (more[at] as EnvelopeResult) : linesPage([], false),
            );
        },
        getArchiveBody(id: unknown) {
            asked.bodies.push(id);
            if (answers.body) return Promise.resolve(answers.body(id));
            return Promise.resolve(env({
                result: {
                    body_json: 'x'.repeat(120), secrets: [], secret_finding_count: 0,
                },
                result_status: 'ok',
                meta: {},
            }));
        },
    } as unknown as ArchiveClient;
    return { client, asked };
}

/**
 * A body payload the masker MUST refuse: a declared secret with no
 * findings array, which is the measured live /lines shape.
 */
export function refusedBodyPayload(): EnvelopeResult {
    return env({
        result: {
            body_json: `api_key=${CANARY}`,
            secrets: null,
            secret_finding_count: 1,
        },
        result_status: 'ok',
        meta: {},
    });
}

/**
 * A body payload the masker CAN mask: one well-formed UTF-16 finding.
 *
 * Description: the POSITIVE control that keeps the refusal tests honest.
 *   A masker that refused everything would pass every disclosure test
 *   and render nothing at all.
 */
export function maskableBodyPayload(): EnvelopeResult {
    const body = `head ${CANARY} tail`;
    return env({
        result: {
            body_json: body,
            secrets: [{
                utf16_state: 'computed',
                match_offset_utf16: body.indexOf(CANARY),
                match_length_utf16: CANARY.length,
            }],
            secret_finding_count: 1,
        },
        result_status: 'ok',
        meta: {},
    });
}

/**
 * A SYNCHRONOUS frame scheduler.
 *
 * Description: THE THIRD `app-screen` GAP, exercised. jsdom never fires
 *   a real animation frame, so a reader reaching for the global
 *   `requestAnimationFrame` would never reconcile in a test and its
 *   measurement pass would be unmeasured. Passing this as the `raf` prop
 *   drives paints by hand.
 */
export function syncRaf(fn: () => void): number {
    fn();
    return 0;
}

/** Let every pending microtask settle. */
export function flush(times = 4): Promise<void> {
    let p = Promise.resolve();
    for (let i = 0; i < times; i += 1) p = p.then(() => {});
    return p;
}
