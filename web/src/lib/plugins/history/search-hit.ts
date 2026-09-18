/**
 * ONE SEARCH HIT, AS A VIEW MODEL: its LOCATING FACTS, and its preview
 * verdict from the egress door.
 *
 * THE SHAPE IS THE SECURITY PROPERTY. `HitView` has no `snippet` field
 * and no raw hit on it. A template holding a `HitView` cannot paint
 * preview text except out of `preview`, which is a `SnippetEgress` and
 * carries a string on exactly one of its three shapes. That is a
 * stronger guarantee than a rule in a renderer, because a renderer
 * obeying a rule is one edit away from not obeying it, and this is one
 * edit away from a type error.
 *
 * `mask-egress.ts` is a HARD IMPORT here for the same reason
 * `reader-mask.ts` is one in slice 7: an injected gate a composition
 * root forgets to supply is fail-OPEN - the preview renders, with the
 * credential in it, and every rendering test passes. This module cannot
 * be constructed without the door.
 *
 * A WITHHELD PREVIEW IS A REAL HIT, and the locating facts are built the
 * same way for every verdict. The server says so itself
 * (`withholding_never_suppresses_a_hit: true`). Dropping a withheld row
 * would under-report the count; rendering it without saying why would
 * imply the preview was empty. Both are wrong, so the row is built AND
 * labelled.
 *
 * ROUTING IS ON `transcript_id` ONLY. `session_ref` names 14 different
 * transcripts in this corpus and is a LABEL, not an identity; opening on
 * it would take a person to whichever one sorted first.
 *
 * Pure. No DOM, no fetch, no framework.
 */
import { snippetEgress, type HitLike, type SnippetEgress } from './mask-egress';

/** One raw hit, as the search endpoint sends it. */
export interface SearchHitRecord extends HitLike {
    readonly transcript_id?: unknown;
    readonly session_ref?: unknown;
    readonly line_no?: unknown;
    readonly match_offset?: unknown;
    readonly match_length?: unknown;
}

/**
 * One hit, ready to paint.
 *
 * Description: CARRIES NO RAW HIT AND NO `snippet`. Everything a
 *   template may render is a field on this object, and the only one that
 *   can be preview text is `preview`.
 */
export interface HitView {
    /** The routing key. Null when the server sent no usable id. */
    readonly transcriptId: number | string | null;
    /** `transcript <id>`, or a refusal phrase. Never blank. */
    readonly transcriptLabel: string;
    /** The label, or the literal phrase for an absent one. Never blank. */
    readonly refLabel: string;
    /** `line <n>`, or a refusal phrase. */
    readonly lineLabel: string;
    /** `offset <n>, length <n>`, with NOT KNOWN for either half. */
    readonly offsetLabel: string;
    /** The line number, for a deep link. Null when unusable. */
    readonly lineNo: number | null;
    /** The egress verdict. The ONLY route to preview text. */
    readonly preview: SnippetEgress;
    /** The state as the server spelled it, for `data-snippet-state`. */
    readonly snippetState: string;
    /** True when the preview was withheld, for `data-preview`. */
    readonly withheld: boolean;
    /** True when this hit can be opened. False disables the control. */
    readonly openable: boolean;
}

/** What a hit with no usable transcript id says, rather than nothing. */
export const NO_TRANSCRIPT_ID = 'no transcript id recorded';

/** What a hit with no session_ref says. A blank cell is not an answer. */
export const NO_SESSION_REF = 'no session_ref recorded';

/** What an unreported integer renders as. Never a zero. */
export const NOT_KNOWN = 'NOT KNOWN';

/**
 * Read an id that may legitimately be a number or a string.
 *
 * Description: the archive's transcript ids are integers on every
 *   measured response, and the route accepts a string, so both are taken
 *   and anything else refuses. An EMPTY string refuses too: a URL built
 *   from it addresses the collection, not a member.
 * Inputs: v - anything. Output: the id, or null.
 */
function idOf(v: unknown): number | string | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.length > 0) return v;
    return null;
}

/**
 * Read an integer, or null.
 *
 * Description: NULL IS NOT ZERO. Line 0 and "no line reported" are
 *   different findings and a reader must be able to tell them apart.
 * Inputs: v - anything. Output: the integer, or null.
 */
function intOf(v: unknown): number | null {
    return Number.isInteger(v) ? v as number : null;
}

/**
 * Build the view model for one search hit.
 *
 * Description: the locating facts are composed FIRST and identically for
 *   every verdict, then the preview verdict is attached. That order is
 *   deliberate: it makes it structurally impossible for a withheld
 *   preview to take a different, quieter row shape, which is how a
 *   withheld hit starts reading as an absent one.
 * Inputs: hit - one entry of a search response's `result` array.
 * Output: a HitView. Never throws on a malformed hit; every unusable
 *   field becomes a named refusal phrase.
 * Example:
 *   hitView({transcript_id: 4, line_no: 292, snippet_state: 'included',
 *            snippet: 'text', secret_finding_count: 0}).preview.kind
 *   // -> 'text'
 */
export function hitView(hit: SearchHitRecord | null | undefined): HitView {
    const h: SearchHitRecord = (hit && typeof hit === 'object') ? hit : {};
    const transcriptId = idOf(h.transcript_id);
    const lineNo = intOf(h.line_no);
    const offset = intOf(h.match_offset);
    const length = intOf(h.match_length);
    const preview = snippetEgress(h);
    const rawState = h.snippet_state;

    return {
        transcriptId,
        transcriptLabel: transcriptId === null
            ? NO_TRANSCRIPT_ID
            : `transcript ${transcriptId}`,
        refLabel: typeof h.session_ref === 'string' && h.session_ref.length > 0
            ? h.session_ref
            : NO_SESSION_REF,
        lineLabel: lineNo === null ? `line ${NOT_KNOWN}` : `line ${lineNo}`,
        offsetLabel: `offset ${offset === null ? NOT_KNOWN : offset}, `
            + `length ${length === null ? NOT_KNOWN : length}`,
        lineNo,
        preview,
        // The ATTRIBUTE reports what the SERVER said, verbatim, including
        // a state this client refuses to recognise - an operator reading
        // the DOM needs the server's own word, not this client's opinion
        // of it. The RENDERING decision is `preview`, and the two are
        // deliberately allowed to disagree.
        snippetState: typeof rawState === 'string' ? rawState : 'unknown',
        withheld: preview.kind === 'withheld',
        // A hit with no transcript id cannot be opened. The control is
        // still emitted, disabled, with the reason on it: a control that
        // silently fails is worse than a stated blocker.
        openable: transcriptId !== null,
    };
}

/**
 * The locator line for one hit, for a client-composed export.
 *
 * Description: composed ONLY from fields that are not body content -
 *   transcript id, session_ref, line, offset, length - so it can be
 *   handed to `exportLine` without any route by which preview text could
 *   ride along inside it. `session_ref` is corpus metadata the archive
 *   already prints on every listing; it is not a body and is not gated.
 * Inputs: view - a built HitView.
 * Output: one tab-free locator string.
 * Example: hitLocator(view) // -> 'transcript 4 | abc | line 292 | offset 10, length 40'
 */
export function hitLocator(view: HitView): string {
    return [
        view.transcriptLabel, view.refLabel, view.lineLabel, view.offsetLabel,
    ].join(' | ');
}
