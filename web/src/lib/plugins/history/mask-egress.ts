/**
 * THE ONE DOOR. Every piece of archive text that reaches a screen or
 * leaves this app passes through a function in this file.
 *
 * WHY A SINGLE CHOKEPOINT RATHER THAN A RULE EACH. Slice 7 established
 * that a masker which can be forgotten is fail-open: the body renders,
 * unmasked, and every rendering test passes with the credential on
 * screen. That argument is why `reader-mask.ts` is a hard import rather
 * than an injected seam. THIS SLICE ADDS THE SECOND HALF OF THE SAME
 * ARGUMENT: a rule enforced in the renderer is enforced in ONE renderer,
 * and this slice has two egress paths, not one.
 *
 *   A SNIPPET is a window into a body, painted in a list.
 *   AN EXPORT is text the person carries out of the app entirely.
 *
 * They are the two places a credential most easily escapes, and they had
 * nothing in common in the vanilla: `archive-search-render.js` decided
 * about previews and `archive-export.js` never thought about the
 * question at all. Two rules drift. One door does not, and it is the
 * only thing a control can be pointed at.
 *
 * WHAT THIS FILE DOES NOT DO: it does not re-implement masking. Bodies
 * go to `reader-mask.ts`'s `maskBody`, imported, because a second
 * implementation of the UTF-16 offset rule is a second place to get the
 * astral-character drift wrong. This file is a DOOR, not a masker.
 *
 * THE TWO GATES ARE DIFFERENT MEASUREMENTS AND BOTH ARE HELD.
 * `src/core/archive_snippet_gate.py` decides about a WINDOW with a
 * 60-character contextual `scan_text`, about 34 microseconds.
 * `reader-mask.ts` masks a WHOLE BODY by declared OFFSET and refuses
 * whenever it cannot account for every finding. Neither subsumes the
 * other: the gate can pass a window whose body is known dirty (the 9.7
 * percent measurement in `mask-vocab.ts`), and the masker cannot be run
 * on a snippet at all, because a snippet carries no offsets. So a
 * snippet is gated and a body is masked, and the two verdicts are kept
 * in two functions with two names.
 *
 * NOTHING HERE EVER PUTS MATCHED TEXT INTO A RETURN VALUE, A REASON
 * STRING, A LOG LINE OR AN ERROR, exactly as `reader-mask.ts` promises.
 * The reason strings carry states, counts and words only.
 *
 * Pure. No DOM, no fetch, no framework, no globals.
 */
import { maskBody, type MaskResult, type SecretFinding } from './reader-mask';
import {
    ABSENT_STATE_REASON, DECLARED_FINDINGS_REASON, NO_PREVIEW_TEXT,
    SNIPPET_INCLUDED, UNRECOGNISED_STATE_REASON, WITHHELD_REASONS,
} from './mask-vocab';

/** Preview text cleared for rendering. */
export const EGRESS_TEXT = 'text';

/** The server declined to send preview text, or this client declined it. */
export const EGRESS_WITHHELD = 'withheld';

/** No preview text existed. Not a withholding. See `mask-vocab.ts`. */
export const EGRESS_NONE = 'none';

/** One search hit, as the egress door reads it. Nothing else is touched. */
export interface HitLike {
    /** The preview text. Readable ONLY through `snippetEgress`. */
    readonly snippet?: unknown;
    /** The gate's verdict about the window. */
    readonly snippet_state?: unknown;
    /** The BODY's declared finding count, an independent measurement. */
    readonly secret_finding_count?: unknown;
}

/** Preview text that may be painted. */
export interface EgressText {
    readonly kind: typeof EGRESS_TEXT;
    readonly text: string;
}

/** A preview deliberately not supplied. `text` is absent by construction. */
export interface EgressWithheld {
    readonly kind: typeof EGRESS_WITHHELD;
    /** The state as the server spelled it, or null when it sent none. */
    readonly state: string | null;
    /** Why, in words. Never contains preview text. */
    readonly reason: string;
    /** The body's declared finding count, or null when unstated. */
    readonly findingCount: number | null;
}

/** A preview that does not exist. Also carries no text. */
export interface EgressNone {
    readonly kind: typeof EGRESS_NONE;
    readonly reason: string;
}

/** What `snippetEgress` answers. There is no fourth shape. */
export type SnippetEgress = EgressText | EgressWithheld | EgressNone;

/**
 * Read the body's declared finding count off a hit.
 *
 * Description: a NON-INTEGER is not a zero. `null`, `undefined`, a
 *   string and a float all mean "the server did not state a count", and
 *   the caller must be able to tell that from a stated zero, because one
 *   of them is evidence and the other is its absence.
 * Inputs: hit - the raw hit.
 * Output: the count, or null when none was stated.
 */
function declaredFindings(hit: HitLike): number | null {
    const n = hit.secret_finding_count;
    return Number.isInteger(n) ? (n as number) : null;
}

/**
 * Decide whether one search hit's preview text may be painted.
 *
 * Description: THE ALLOW-LIST, and it is the whole of this slice's
 *   security posture for search. Four rungs, every one of which refuses:
 *
 *     1. The hit is not an object. Refuse.
 *     2. `snippet_state` is not EXACTLY `included`. Refuse, naming the
 *        state. This covers the three withholding states the vanilla
 *        deny-list missed, plus every state a future server invents.
 *     3. The BODY declares one or more secret findings. Refuse even
 *        though the gate passed the window - see
 *        `DECLARED_FINDINGS_REASON`, and the 1,211-of-12,522
 *        measurement behind it. This rung is what the gate structurally
 *        cannot do, because it is looking at a window and this is a fact
 *        about the body.
 *     4. `snippet` is not a string. Answer `none`, which is a preview
 *        that does not exist rather than one that was withheld.
 *
 *   ONLY a hit that survives all four yields text, and the text is the
 *   server's own bytes, untouched. There is no rung on which this
 *   function edits preview text: a partially-scrubbed snippet would be
 *   the half-masked body `reader-mask.ts` refuses to produce, one layer
 *   up and with no offsets to be right about.
 *
 * Inputs: hit - one entry of a search response's `result` array.
 * Output: a SnippetEgress. Only the `text` shape carries a string.
 * Example:
 *   snippetEgress({snippet: 'hello', snippet_state: 'included',
 *                  secret_finding_count: 0})
 *   // -> {kind: 'text', text: 'hello'}
 *   snippetEgress({snippet: 'k=AKIA...', snippet_state: 'included',
 *                  secret_finding_count: 3})
 *   // -> {kind: 'withheld', state: 'included', findingCount: 3, ...}
 */
export function snippetEgress(hit: HitLike | null | undefined): SnippetEgress {
    if (!hit || typeof hit !== 'object') {
        return {
            kind: EGRESS_WITHHELD, state: null, findingCount: null,
            reason: ABSENT_STATE_REASON,
        };
    }

    const raw = hit.snippet_state;
    const state = typeof raw === 'string' ? raw : null;
    const count = declaredFindings(hit);

    // RUNG 2. Anything that is not the one allowed spelling withholds.
    // Note the ORDER of the two refusal wordings: a state this client
    // recognises is described by what tripped, and one it does not is
    // described as unevaluated. Neither can render text.
    if (state !== SNIPPET_INCLUDED) {
        const named = state === null
            ? ABSENT_STATE_REASON
            : (WITHHELD_REASONS[state] ?? UNRECOGNISED_STATE_REASON);
        return { kind: EGRESS_WITHHELD, state, findingCount: count, reason: named };
    }

    // RUNG 3. The gate passed the WINDOW. The BODY still declares
    // findings, which the gate's window scan structurally cannot see.
    if (count !== null && count > 0) {
        return {
            kind: EGRESS_WITHHELD, state, findingCount: count,
            reason: DECLARED_FINDINGS_REASON,
        };
    }

    // RUNG 4. Cleared, but there is nothing to show.
    if (typeof hit.snippet !== 'string') {
        return { kind: EGRESS_NONE, reason: NO_PREVIEW_TEXT };
    }

    return { kind: EGRESS_TEXT, text: hit.snippet };
}

/**
 * Mask a whole archive body on its way to a screen or to a file.
 *
 * Description: DELEGATES, and that is the point. `reader-mask.ts` owns
 *   the UTF-16 offset rule, the five refusal cases and the
 *   highest-offset-down splice; re-deriving any of that here would be a
 *   second implementation of the astral-character drift, which is the
 *   bug slice 7 measured at four, eight and twelve characters of a live
 *   credential left on screen. This wrapper exists only so that the
 *   export path and the snippet path name ONE module, which is what lets
 *   `mask-egress.test.ts` assert about both at once.
 * Inputs: body - `body_json` exactly as the server sent it. findings -
 *   the `secrets` array. declaredCount - `secret_finding_count`, read
 *   from a different column than the array.
 * Output: a MaskResult. A refusal carries `text: null`.
 * Example: bodyEgress(body, secrets, 1).status // -> 'ok'
 */
export function bodyEgress(
    body: unknown,
    findings: readonly SecretFinding[] | null | undefined,
    declaredCount: unknown,
): MaskResult {
    return maskBody(body, findings, declaredCount);
}

/** One line of a client-composed export, after the door. */
export interface EgressLine {
    /** Text cleared to leave the app. Never carries withheld material. */
    readonly text: string;
    /** True when this line stands in for something that was refused. */
    readonly substituted: boolean;
}

/**
 * Compose ONE line of a client-composed export from an egress VERDICT.
 *
 * Description: IT TAKES THE VERDICT, NOT THE HIT, AND THAT IS THE WHOLE
 *   DESIGN. `snippetEgress` is the single producer of a `SnippetEgress`,
 *   and the screen and the export are its two CONSUMERS - reading the
 *   same object rather than each calling the door and hoping the two
 *   calls agree. A second call could be made with a different argument,
 *   at a different moment, against a mutated record; one verdict cannot
 *   disagree with itself.
 *
 *   It also means this function is STRUCTURALLY UNABLE to reach a raw
 *   hit. There is no argument here through which preview text could
 *   arrive except a verdict that already cleared it, and `locator` is
 *   composed by the caller from transcript id, line number and offset -
 *   none of which is body content.
 *
 *   A refusal becomes a STATED SUBSTITUTION LINE, never an omission: a
 *   hit dropped silently from an export under-reports what was found,
 *   which is the same false green in a file instead of on a screen.
 * Inputs: locator - the non-body facts naming where the hit is. verdict
 *   - what `snippetEgress` answered for that hit.
 * Output: an EgressLine. `substituted` is true whenever the preview was
 *   refused or absent, so a caller can count them honestly.
 * Example: exportLine('transcript 4 line 292', verdict).substituted // -> true
 */
export function exportLine(locator: string, verdict: SnippetEgress): EgressLine {
    if (verdict.kind === EGRESS_TEXT) {
        return { text: `${locator}\t${verdict.text}`, substituted: false };
    }
    if (verdict.kind === EGRESS_NONE) {
        return { text: `${locator}\t[${verdict.reason}]`, substituted: true };
    }
    const state = verdict.state === null ? 'no state reported' : verdict.state;
    return {
        text: `${locator}\t[PREVIEW WITHHELD (${state}): ${verdict.reason}]`,
        substituted: true,
    };
}
