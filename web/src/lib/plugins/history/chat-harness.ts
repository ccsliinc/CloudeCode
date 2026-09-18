/**
 * THE SHARED TEST HARNESS for the mounted conversation view: a fake
 * archive client, turn fixtures, and a synchronous frame scheduler.
 *
 * WHY IT IS ITS OWN FILE. `ChatView.behaviour.test.ts`,
 * `ChatView.commitments.test.ts` and `chat-mask.test.ts` all mount or
 * drive the real component against the real modules and need the same
 * doubles. Two copies would drift, and the one that drifted would be the
 * one proving the security property. It is a `.ts` rather than a
 * `.test.ts` so the test glob does not try to run it as a suite.
 *
 * THE CANARY IS IMPORTED FROM SLICE 7's HARNESS, NOT REDECLARED. A
 * second copy is a second thing to keep in step, and the one that
 * drifted would be the one proving a gate refuses. The reason it is not
 * key-shaped is recorded there: a realistic `sk-live-...` string trips
 * this repo's own pre-commit gitleaks gate, and a fixture that has to be
 * waved past a secret scanner teaches the next person to wave the
 * scanner past something real.
 */
import { CANARY, env, outcome, syncRaf } from './reader-harness';
import type { ArchiveClient } from './client';
import type { EnvelopeResult } from '../types';

export { CANARY, env, outcome, syncRaf };

/** A `/messages` page envelope. `result` is the turns array, as live. */
export function turnsPage(
    turns: unknown[], hasMore: boolean | null = null, nextCursor: string | null = null,
): EnvelopeResult {
    const paging: Record<string, unknown> = {};
    if (hasMore !== null) paging.has_more = hasMore;
    if (nextCursor !== null) paging.next_cursor = nextCursor;
    return env({ result: turns, result_status: 'ok', meta: { paging } });
}

/** One turn, with sane defaults a test can override. */
export function turn(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        line_no: 1,
        record_type: 'assistant',
        role: 'assistant',
        role_state: 'role',
        ts: '2026-01-01T00:00:00Z',
        model: 'claude-opus-5',
        body_id: 1,
        blocks: [{ seq: 0, type: 'text', text: 'hello', text_state: 'included',
            text_length: 5, text_truncated: false }],
        blocks_state: 'extracted',
        subagents: [],
        subagents_state: 'none_spawned',
        secret_finding_count: 0,
        info: {},
        ...over,
    };
}

/** One content block, with sane defaults. */
export function block(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        seq: 0,
        type: 'text',
        text: 'hello',
        text_state: 'included',
        text_length: 5,
        text_truncated: false,
        tool_name: null,
        tool_use_id: null,
        is_error: null,
        ...over,
    };
}

/**
 * A turn the masker MUST refuse: a declared secret with no findings
 * array, which is the measured live shape of this server's `/messages`
 * response - blocks carry no `secrets` key at all.
 */
export function refusedTurn(over: Record<string, unknown> = {}): Record<string, unknown> {
    return turn({
        secret_finding_count: 1,
        blocks: [block({ text: `api_key=${CANARY}`, text_length: 8 + CANARY.length })],
        ...over,
    });
}

/**
 * A turn the masker CAN mask: one well-formed UTF-16 finding.
 *
 * Description: the POSITIVE control that keeps the refusal tests honest.
 *   A masker that refused everything would pass every disclosure test and
 *   render nothing at all.
 */
export function maskableTurn(over: Record<string, unknown> = {}): Record<string, unknown> {
    const body = `head ${CANARY} tail`;
    return turn({
        secret_finding_count: 1,
        blocks: [block({
            text: body,
            text_length: body.length,
            secrets: [{
                utf16_state: 'computed',
                match_offset_utf16: body.indexOf(CANARY),
                match_length_utf16: CANARY.length,
            }],
        })],
        ...over,
    });
}

/** What `fakeChatClient` was asked, so a test can count requests. */
export interface ChatAskLog {
    readonly messages: { id: unknown; opts: Record<string, unknown> }[];
}

/** How `fakeChatClient` should answer. */
export interface ChatAnswers {
    /** The first `/messages` page. */
    readonly page?: EnvelopeResult;
    /** Later pages, consumed in order; the last repeats. */
    readonly morePages?: readonly EnvelopeResult[];
    /** Answer a specific transcript id, for drill-down tests. */
    readonly byId?: Record<string, EnvelopeResult>;
}

/**
 * A granted-client double, recording what it was asked.
 *
 * Description: ONLY `listArchiveMessages` is implemented. The rest are
 *   absent rather than stubbed, so a view that started calling one would
 *   fail loudly here instead of silently getting an empty answer.
 * Inputs: answers.
 * Output: the client and the ask log.
 */
export function fakeChatClient(answers: ChatAnswers = {}): {
    client: ArchiveClient; asked: ChatAskLog;
} {
    const asked: ChatAskLog = { messages: [] };
    let pageCount = 0;
    const client = {
        listArchiveMessages(id: unknown, opts: Record<string, unknown> = {}) {
            asked.messages.push({ id, opts });
            const byId = answers.byId;
            if (byId && Object.prototype.hasOwnProperty.call(byId, String(id))) {
                return Promise.resolve(byId[String(id)] as EnvelopeResult);
            }
            if (pageCount === 0) {
                pageCount += 1;
                return Promise.resolve(answers.page ?? turnsPage([], false));
            }
            const more = answers.morePages ?? [];
            const at = Math.min(pageCount - 1, more.length - 1);
            pageCount += 1;
            return Promise.resolve(
                at >= 0 ? (more[at] as EnvelopeResult) : turnsPage([], false),
            );
        },
    } as unknown as ArchiveClient;
    return { client, asked };
}

/**
 * A response carrying NO archive envelope at all.
 *
 * Description: what an UNROUTED path answers - FastAPI's `{"detail":
 *   "Not Found"}`, which has no `result_status`. The discriminator is
 *   that field's presence, not the HTTP code, because a missing
 *   TRANSCRIPT answers 404 WITH a complete envelope.
 */
export function unroutedResponse(): EnvelopeResult {
    return {
        envelope: { detail: 'Not Found' },
        httpStatus: 404,
        headers: null,
        transportError: null,
        refusedByGrant: false,
    } as EnvelopeResult;
}

/** Let every pending microtask settle. */
export function flush(times = 6): Promise<void> {
    let p = Promise.resolve();
    for (let i = 0; i < times; i += 1) p = p.then(() => {});
    return p;
}
