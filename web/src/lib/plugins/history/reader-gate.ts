/**
 * THE BODY GATE POLICY and the MASK APPLICATION: the size thresholds
 * that decide whether a transcript body may be fetched at all, and the
 * one function that applies `reader-mask.ts`'s findings to text before
 * anything can render it.
 *
 * Ported from `client/js/archive-body-gate.js`, threshold for threshold
 * and refusal for refusal.
 *
 * THIS FILE IS TWO GATES WEARING ONE NAME, and conflating them is how
 * one gets weakened while the other is being discussed:
 *
 *   GATE A, `gateFor()`, is a RESOURCE gate. It stops a 54 MB body being
 *   pulled into the tab by scrolling past it. Its failure mode is a dead
 *   tab, not a disclosure.
 *
 *   GATE B, `applyMask()`, is the SECURITY control. It is what stops a
 *   credential reaching the screen, and it is the half that must never
 *   be loosened, simplified or made optional. Note it is NOT the
 *   server's `withheld_secret_bearing` snippet gate
 *   (`src/core/archive_snippet_gate.py`) - that one governs SEARCH
 *   SNIPPETS and never reaches the reader. This is the reader's own,
 *   and it is strictly stronger: the snippet gate withholds a snippet,
 *   this refuses a whole body whenever it cannot account for every
 *   finding the server declared.
 *
 * THE GATE IS EVALUATED FROM THE SPINE, BEFORE ANY NETWORK HAPPENS.
 * That is the whole point of separating size from content: the spine
 * already carries the byte length, so nothing has to be downloaded to
 * decide that it must not be downloaded. Measured 2026-08-31 on the live
 * server, the server's own MAX_BODY_BYTES is 67,108,864 and the largest
 * body in this corpus is 54,376,859 chars, so THE SERVER GATE NEVER
 * FIRES and the client gate is the ONLY gate.
 *
 * THE HARD GATE IS NOT A STRONGER SOFT GATE. A soft gate is "not
 * automatically, but you may ask"; a hard gate is "never, whatever
 * `force` says". Collapsing them into one threshold with a flag is how a
 * render-anyway button ends up able to hang the tab.
 *
 * A MASK REFUSAL FAILS CLOSED. If the masker cannot account for every
 * finding it declared, the text does not render at all - a partially
 * masked body is worse than no body, because it looks safe.
 *
 * Pure. No DOM, no fetch, no framework.
 */
import { maskBody, MASK_REFUSED, type SecretFinding } from './reader-mask';
import { BODY_STATE, WIRE_WITHHELD_TOO_LARGE, type BodyState } from './reader-vocab';

/**
 * Above this many UTF-16 code units a body is not auto-fetched and not
 * auto-rendered; the row shows the size and a "render anyway" action.
 * 256 KiB.
 */
export const BODY_INLINE_MAX = 262144;

/**
 * Above this many UTF-16 code units a body is never fetched and never
 * rendered: download only, with the reason stated. There is no render
 * option at any depth of the UI. 2 MiB.
 *
 * A 54 MB `<pre>` IS A DEAD TAB. Not slow, dead: the layout pass over a
 * single text node that size cannot be interrupted and the browser
 * offers no way back. That is why the hard gate has no escape hatch,
 * where the soft gate at 256 KiB does.
 */
export const BODY_RENDER_HARD_MAX = 2097152;

/** Hard cap on cached bodies, by count. */
export const BODY_CACHE_MAX_ENTRIES = 300;

/** Hard cap by total characters. 32 MiB of text. */
export const BODY_CACHE_MAX_CHARS = 33554432;

/**
 * Deadline for one body fetch, milliseconds. A 54 MB body is a
 * legitimate slow transfer, so this is generous; what it is not is
 * absent. A request with no terminal condition is a state that can never
 * fail.
 */
export const BODY_DEADLINE_MS = 30000;

/** What `gateFor` answers. `chars` is null whenever the size is unknown. */
export interface GateVerdict {
    /** One of the eight body states. `included` never means "fetched". */
    readonly state: BodyState;
    /** The body's size in UTF-16 code units, or null when not known. */
    readonly chars: number | null;
    /** Why, in words a person can act on. Null only on `included`. */
    readonly reason: string | null;
}

/** The spine fields `gateFor` reads. It reads nothing else, ever. */
export interface GateRow {
    readonly body_id?: unknown;
    readonly body_chars?: unknown;
    readonly body_state?: unknown;
}

/**
 * Decide, from spine metadata alone, whether a body may be fetched and
 * rendered.
 *
 * Description: NORMATIVE - every fetch path calls this first and honours
 *   it. Nothing here reads a body, and nothing here touches the network.
 * Inputs: row - a spine row; reads `body_chars`, `body_state` and
 *   `body_id` only.
 * Output: a GateVerdict whose `state` is included | gated-soft |
 *   gated-hard | withheld-server | no-body | cannot-determine.
 *   `included` means "small enough to fetch", NOT "already fetched".
 * Example: gateFor({body_id: 1, body_chars: 54376859})
 *   // -> {state: 'gated-hard', chars: 54376859, reason: '...'}
 */
export function gateFor(row: GateRow | null | undefined): GateVerdict {
    if (!row || typeof row !== 'object') {
        return {
            state: BODY_STATE.CANNOT_DETERMINE,
            chars: null,
            reason: 'no spine row for this line',
        };
    }
    // The server's own refusal wins outright: it is a finding the server
    // made about its own limits and the client must render it as the
    // server's, not restate it as its own.
    if (row.body_state === WIRE_WITHHELD_TOO_LARGE) {
        return {
            state: BODY_STATE.WITHHELD,
            chars: Number.isFinite(row.body_chars) ? row.body_chars as number : null,
            reason: 'the server withheld this body as too large',
        };
    }
    if (row.body_id === null || row.body_id === undefined) {
        return {
            state: BODY_STATE.NO_BODY,
            chars: null,
            reason: 'this line has no body row',
        };
    }
    const chars = row.body_chars;
    // A size we cannot read is not a small size. Refusing to guess here
    // is the difference between a gate and a coin flip.
    if (!Number.isFinite(chars) || (chars as number) < 0) {
        return {
            state: BODY_STATE.CANNOT_DETERMINE,
            chars: null,
            reason: 'body_chars is ' + String(chars)
                + ', so the size of this body is not known',
        };
    }
    const n = chars as number;
    if (n > BODY_RENDER_HARD_MAX) {
        return {
            state: BODY_STATE.GATED_HARD,
            chars: n,
            reason: 'this body is ' + n + ' characters, past the '
                + BODY_RENDER_HARD_MAX + ' character hard limit. Rendering it '
                + 'would hang the tab with no way back, so there is no render '
                + 'option.',
        };
    }
    if (n > BODY_INLINE_MAX) {
        return {
            state: BODY_STATE.GATED_SOFT,
            chars: n,
            reason: 'this body is ' + n + ' characters, past the '
                + BODY_INLINE_MAX + ' character inline limit.',
        };
    }
    return { state: BODY_STATE.OK, chars: n, reason: null };
}

/**
 * The gate states that may NEVER be fetched, whatever `force` says.
 *
 * Description: a LIST rather than a comparison, so a ninth state cannot
 *   silently classify itself as fetchable by not matching an if-chain.
 *   `GATED_SOFT` is deliberately absent: it is the one refusal a person
 *   may lift.
 */
export const NEVER_FETCH: readonly BodyState[] = [
    BODY_STATE.GATED_HARD,
    BODY_STATE.WITHHELD,
    BODY_STATE.NO_BODY,
    BODY_STATE.CANNOT_DETERMINE,
];

/**
 * Whether a gate verdict forbids fetching outright.
 *
 * Description: its own function so the cache's refusal and any future
 *   caller read the SAME rule, rather than two if-chains that drift.
 * Inputs: state - a gate verdict's state.
 * Output: true when no value of `force` may fetch this body.
 * Example: forbidsFetch('gated-hard') // -> true
 */
export function forbidsFetch(state: BodyState | string): boolean {
    return NEVER_FETCH.indexOf(state as BodyState) !== -1;
}

/** What `applyMask` folds a masked body into. */
export interface MaskApplication {
    readonly state: BodyState;
    /** The safe text, or `null` on EVERY refusal path. */
    readonly text: string | null;
    readonly masked: number;
    readonly reason: string | null;
    readonly findingCount: number;
}

/**
 * Run the masker over a fetched body and fold its result into a cache
 * entry shape.
 *
 * Description: the ONLY place this module turns body text into something
 *   renderable. `text` is null on every refusal path, by construction.
 * Inputs: body - the raw `body_json`. findings - the `secrets` array.
 *   declaredCount - `secret_finding_count`.
 * Output: a MaskApplication.
 * Example: applyMask('abc', [], 0)
 *   // -> {state: 'included', text: 'abc', masked: 0, ...}
 */
export function applyMask(
    body: unknown,
    findings: readonly SecretFinding[] | null | undefined,
    declaredCount: unknown,
): MaskApplication {
    const mask = maskBody(body, findings, declaredCount);
    if (mask.status === MASK_REFUSED) {
        return {
            state: BODY_STATE.MASK_REFUSED,
            text: null,
            masked: 0,
            reason: mask.reason,
            findingCount: mask.findingCount,
        };
    }
    return {
        state: BODY_STATE.OK,
        text: mask.text,
        masked: mask.masked,
        reason: null,
        findingCount: Number.isInteger(declaredCount) ? declaredCount as number : 0,
    };
}

/** The shape `reasonFrom` reads off a classifier result. */
export interface ClassifiedLike {
    readonly token: string;
    readonly reasons?: readonly { subject?: unknown; reason?: unknown }[] | null;
}

/**
 * One-line reason from a classified failure envelope.
 *
 * Description: names what could not be evaluated rather than leaving a
 *   blank. A refusal that does not say what it could not evaluate is a
 *   blank cell, and a blank cell is not an answer.
 * Inputs: c - an outcome classifier result.
 * Output: a sentence.
 * Example: reasonFrom({token: 'budget_exhausted', reasons: []})
 *   // -> 'the body request returned budget_exhausted and carried no reason'
 */
export function reasonFrom(c: ClassifiedLike): string {
    const first = c.reasons && c.reasons.length ? c.reasons[0] : null;
    if (first && first.reason) {
        return (first.subject ? String(first.subject) + ': ' : '')
            + String(first.reason);
    }
    return 'the body request returned ' + c.token + ' and carried no reason';
}
