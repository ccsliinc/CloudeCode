/**
 * Masks flagged secret material in an archive body before it is
 * rendered. Ported from `client/js/archive-mask.js`, rule for rule.
 *
 * WHY THIS IS PORTED RATHER THAN INJECTED. Slices 5 and 6 inject the
 * things belonging to later slices - the outcome classifier, the fuzzy
 * matcher - and degrade gracefully when they are absent. THAT PATTERN IS
 * WRONG FOR THIS ONE. An injected masker that a composition root forgets
 * to supply is a fail-OPEN seam: the body renders, unmasked, with the
 * credential on screen, and every rendering test passes. A gate that
 * fails open is not a gate. So the masker is a hard import with no
 * optional path, and `reader-gate.ts` cannot be constructed without it.
 * `client/js/archive-mask.js` is NOT deleted, because
 * `client/js/archive-chat-block.js` (the chat view, a later slice) is
 * still a consumer.
 *
 * THE SERVER FLAGS. IT NEVER REDACTS. Byte-exactness is the whole point
 * of the archive: a body that came back redacted would not be the bytes
 * that were on disk. So the server returns the real body plus a findings
 * array, and masking is the client's job. This is a LENS over stored
 * bytes, not a change to them.
 *
 * THE TRAP, MEASURED, AND IT SURVIVES THE PORT UNCHANGED. A JavaScript
 * string is indexed in UTF-16 code units; a Python string in code
 * points. Every character outside the Basic Multilingual Plane is one
 * code point and TWO UTF-16 code units, so a Python-computed offset and
 * a JavaScript index diverge by one per astral character and the
 * divergence grows monotonically through the body. Measured on real
 * corpus body 379, live server, 2026-08-31: 19,831 code points against
 * 19,843 code units, three findings of the same 40-character credential,
 * drift +4 / +8 / +12. Masking finding 1 with `match_offset` instead of
 * `match_offset_utf16` slides the window four units LEFT and LEAVES THE
 * LAST FOUR CHARACTERS OF THE CREDENTIAL ON SCREEN, with no error and
 * output that reads like plausible prose. So the `_utf16` fields are the
 * ONLY ones this file may read, and it never reads `match_offset` or
 * `match_length` at all.
 *
 * REFUSAL IS THE DEFAULT, NOT THE EDGE CASE. Half-masked output is worse
 * than no output, because it looks like it worked. Every input this
 * module cannot fully account for produces a refusal with null text.
 *
 * NOTHING HERE EVER PUTS MATCHED TEXT INTO A RETURN VALUE, A REASON
 * STRING OR AN ERROR. The reason strings carry counts, offsets, lengths
 * and states only.
 *
 * Pure. No DOM, no fetch, no framework, no globals.
 */

/** `status` meaning the body MUST NOT be rendered at all. */
export const MASK_REFUSED = 'mask-refused';

/** `status` meaning the returned text is safe to render. */
export const MASK_OK = 'ok';

/**
 * The replacement text.
 *
 * Description: fixed width and self-describing - it must be obvious that
 *   something was removed BY THIS VIEW and not that the archive stored
 *   asterisks. FIXED WIDTH IS DELIBERATE: a marker whose length is
 *   proportional to the secret publishes the credential's length, a
 *   small leak taken for no benefit. Offsets of not-yet-applied findings
 *   stay valid because the splice runs from the HIGHEST offset down, not
 *   because the string's length is preserved.
 */
export const SECRET_MARKER = '[SECRET REDACTED IN THIS VIEW]';

/** One entry of an API `secrets` array, as this module reads it. */
export interface SecretFinding {
    /** 'computed' when the server derived the UTF-16 pair from the body. */
    readonly utf16_state?: unknown;
    /** Offset in UTF-16 code units. The ONLY offset this file may read. */
    readonly match_offset_utf16?: unknown;
    /** Length in UTF-16 code units. The ONLY length this file may read. */
    readonly match_length_utf16?: unknown;
}

/** A mask that succeeded. `text` is always a string. */
export interface MaskOk {
    readonly status: typeof MASK_OK;
    readonly text: string;
    readonly masked: number;
}

/** A mask that refused. `text` is `null` by construction. */
export interface MaskRefused {
    readonly status: typeof MASK_REFUSED;
    readonly text: null;
    readonly reason: string;
    readonly findingCount: number;
}

/** What `maskBody` answers. There is no third shape. */
export type MaskResult = MaskOk | MaskRefused;

/**
 * Build a refusal.
 *
 * Description: centralised so that `text: null` is structurally
 *   impossible to forget on a refusal path.
 * Inputs: reason - why, in words a person can act on. NEVER contains
 *   body content or matched text. findingCount - how many secrets are
 *   believed to be in the body, so a view can say "3 secrets, positions
 *   unknown".
 * Output: a MaskRefused.
 */
function refuse(reason: string, findingCount: number): MaskRefused {
    return {
        status: MASK_REFUSED,
        text: null,
        reason,
        findingCount: Number.isInteger(findingCount) ? findingCount : 0,
    };
}

/**
 * Is one finding usable for masking a JavaScript string?
 *
 * Description: every branch returning false is a distinct way of saying
 *   "I do not know where the secret is", and each one poisons the WHOLE
 *   body rather than just its own window.
 * Inputs: f - one entry from an API `secrets` array. len - the body's
 *   length in UTF-16 code units, i.e. plain `body.length`.
 * Output: true only if the UTF-16 window is fully known and lies inside
 *   the string.
 * Example: findingIsUsable({utf16_state: 'computed',
 *   match_offset_utf16: 5201, match_length_utf16: 40}, 19843) // true
 */
function findingIsUsable(f: SecretFinding | null | undefined, len: number): boolean {
    if (!f || typeof f !== 'object') return false;

    // THREE-OUTCOME GATE. `utf16_state` is 'computed' when the server
    // derived the pair, or 'cannot_determine' when it could not.
    // NORMATIVE: on cannot_determine we do NOT fall back to the
    // code-point offsets and we do NOT render the body. A body carrying
    // a finding whose position is unknown is a body with a credential at
    // an unknown location, and there is no partial masking that is safe.
    if (f.utf16_state !== 'computed') return false;

    const o = f.match_offset_utf16;
    const l = f.match_length_utf16;

    // Number.isInteger is false for undefined, null, NaN, Infinity,
    // strings and non-integral numbers, which is every shape of "the
    // field is not a usable index".
    if (!Number.isInteger(o) || !Number.isInteger(l)) return false;
    const off = o as number;
    const length = l as number;
    if (off < 0 || length <= 0) return false;

    // `len` is body.length, which IS the UTF-16 code-unit count. Do NOT
    // compute a code-point length with [...body].length and compare
    // against a UTF-16 offset; that reintroduces the original bug inside
    // the validator, where it is even harder to see.
    if (off + length > len) return false;

    return true;
}

/**
 * Name WHY a finding is unusable.
 *
 * Description: distinguishes the server's own `cannot_determine` from a
 *   window that is structurally broken. A refusal that does not say what
 *   it could not evaluate is a blank cell, and a blank cell is not an
 *   answer.
 * Inputs: f - the rejected finding. len - body length in UTF-16 units.
 * Output: a string carrying offsets, lengths and state only. Never body
 *   text.
 */
function unusableReason(f: SecretFinding | null | undefined, len: number): string {
    const state = f && f.utf16_state;
    if (state === 'cannot_determine') {
        return 'a finding reports utf16_state=cannot_determine, so its '
            + 'position in a JavaScript string is not known';
    }
    return 'a finding has no usable UTF-16 window (utf16_state='
        + String(state)
        + ' offset=' + String(f && f.match_offset_utf16)
        + ' length=' + String(f && f.match_length_utf16)
        + ' bodyLength=' + len + ')';
}

/**
 * Replace every flagged secret in a body with a fixed-width marker,
 * using ONLY the UTF-16 offsets. Refuses outright rather than masking
 * approximately.
 *
 * Description: the five cases below are the whole contract, and each one
 *   is a measured shape rather than a hypothetical. There is no return
 *   value of this function that hands back partially-masked text.
 * Inputs: body - the `body_json` exactly as the server sent it.
 *   findings - the `secrets` array from GET /archive/bodies/{id}. `null`
 *   and `undefined` are NOT the same as `[]`; see cases 1 and 2.
 *   declaredCount - `secret_finding_count` from the line or body row, an
 *   INDEPENDENT count read from a different column than the array.
 * Output: a MaskResult. A refusal always carries `text: null`.
 * Example:
 *   maskBody(body, [{utf16_state: 'computed', match_offset_utf16: 5201,
 *     match_length_utf16: 40}], 1)
 *   // -> {status: 'ok', text: '...[SECRET REDACTED IN THIS VIEW]...', masked: 1}
 */
export function maskBody(
    body: unknown,
    findings: readonly SecretFinding[] | null | undefined,
    declaredCount: unknown,
): MaskResult {
    const declared = Number.isInteger(declaredCount) ? declaredCount as number : 0;

    if (typeof body !== 'string') {
        return refuse('body is not a string', declared);
    }

    const list = Array.isArray(findings) ? findings as readonly SecretFinding[] : null;

    // CASE 1: the server says there are no secrets and sent no findings.
    // Render as-is. The archive is byte-exact and masking must be a
    // no-op when there is nothing to mask.
    if (declared === 0 && (list === null || list.length === 0)) {
        return { status: MASK_OK, text: body, masked: 0 };
    }

    // CASE 2: the server says there ARE secrets but gave us no findings
    // array. This is the live /lines?include_bodies=true shape as
    // measured 2026-08-31: line 292 of transcript 4 carries
    // secret_finding_count 3, a 19,831-character body with the real
    // credentials in it, and NO `secrets` key at all. We know a
    // credential is in this string and we do not know where. Refuse.
    if (declared > 0 && (list === null || list.length === 0)) {
        return refuse(
            'the body declares ' + declared + ' secret finding(s) but carries '
            + 'no findings array, so their positions are unknown',
            declared,
        );
    }

    // CASE 3: fewer findings than declared. The count and the array come
    // from different columns and can disagree; something was dropped in
    // transit or in serialization. Masking what we have would leave the
    // rest visible WHILE LOOKING MASKED, which is worse than refusing.
    // This is a positive control on the masking INPUT: trusting only the
    // array means a body whose array was dropped renders unmasked with
    // no complaint.
    if (declared > 0 && (list as readonly SecretFinding[]).length < declared) {
        return refuse(
            'the body declares ' + declared + ' secret finding(s) but only '
            + (list as readonly SecretFinding[]).length + ' were returned',
            declared,
        );
    }

    // CASE 4: any finding whose UTF-16 window is not fully known poisons
    // the WHOLE body, not just its own window.
    const items = list as readonly SecretFinding[];
    const len = body.length;
    for (const f of items) {
        if (!findingIsUsable(f, len)) {
            return refuse(unusableReason(f, len), declared || items.length);
        }
    }

    // CASE 5: mask.
    //
    // Merge overlapping windows first. Two independent splices over one
    // region produce garbage, and overlapping detector hits are a real
    // shape rather than a hypothetical. THE MERGE IS SAFE BY
    // CONSTRUCTION: the union of two windows covers every code unit
    // either covered, so no character of either match can survive it.
    const windows = items
        .map((f) => ({
            start: f.match_offset_utf16 as number,
            end: (f.match_offset_utf16 as number) + (f.match_length_utf16 as number),
        }))
        .sort((a, b) => a.start - b.start);

    const merged: { start: number; end: number }[] = [];
    for (const w of windows) {
        const last = merged.length ? merged[merged.length - 1] : undefined;
        if (last && w.start <= last.end) {
            if (w.end > last.end) last.end = w.end;
        } else {
            merged.push({ start: w.start, end: w.end });
        }
    }

    // Splice from the HIGHEST offset down, so an applied replacement
    // cannot shift the offsets of the ones still pending. This is what
    // keeps the remaining findings valid; it is the reason the marker
    // does not need to be the same width as the secret.
    let out = body;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
        const w = merged[i];
        if (!w) continue;
        out = out.slice(0, w.start) + SECRET_MARKER + out.slice(w.end);
    }
    return { status: MASK_OK, text: out, masked: merged.length };
}
