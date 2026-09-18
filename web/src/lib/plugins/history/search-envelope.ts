/**
 * SEARCH'S ENVELOPE INTERPRETATION: what a `scan.status` means, what
 * coverage the server actually achieved, and what a resumable scan is
 * offering. Ported from `client/js/archive-search-render.js`, rule for
 * rule.
 *
 * WHY THIS IS SEPARATE FROM `search-run.ts`. Everything here is a PURE
 * FUNCTION of an envelope. The sibling file owns the QUERY - the live
 * cursors, the accumulated hits, the in-flight request and the resume
 * chain. Reading a server's own account of what it did is a different
 * job from deciding what to ask it next, and this is the first of the
 * two.
 *
 * THE PROPERTY THIS FILE EXISTS TO PROTECT. A zero-hit result means a
 * completely different thing under two of the four scan statuses:
 *
 *   complete          I read the whole scope. There is nothing there.
 *   budget_exhausted  I stopped partway. I do not know what is in the
 *                     2,615 transcripts I never opened.
 *   limit_reached     I filled the page. There are more MATCHES.
 *   not_run           No scan happened at all. Every count is null.
 *
 * A zero-hit `budget_exhausted` rendered like a zero-hit `complete` is
 * the false green this whole screen exists to prevent, and this is the
 * file where it would be manufactured.
 *
 * TWO CURSORS, TWO MEANINGS, NEVER CROSSED. `resumeAffordance` reads ONE
 * named field per scan status and there is no fallback between them. A
 * missing cursor is reported as a BLOCKED affordance NAMING the field
 * that was absent, never silently swapped for the other one - because
 * reading the wrong field yields null, which looks like "cannot resume":
 * a plausible, quiet, wrong answer.
 *
 * `result_status: "ok"` DOES NOT MEAN THE SCOPE WAS READ. Measured:
 * q=restic&project_id=12&limit=3 answered `ok` with `limit_reached`,
 * `transcripts_scanned: 1`, `transcripts_not_scanned: 3415`. So the
 * coverage line renders on EVERY outcome including `ok`.
 *
 * NEVER A BYTE PROGRESS BAR. `scan.bytes_scanned` is a CHARGE: measured
 * at 551,648,566 against a `budget_bytes` of 536,870,912, 2.75 percent
 * OVER its own budget. A quantity that exceeds its own budget cannot be
 * a fraction of anything. Progress is transcripts over transcripts, both
 * integers, both monotone.
 *
 * THIS FILE IS THE ONLY INTERPRETER OF `meta.scan.status`, for the same
 * reason `archive-outcome.js` is the only interpreter of
 * `result_status`: two branch sets on one field drift, and one starts
 * calling a `budget_exhausted` a `complete`.
 *
 * Pure. No DOM, no fetch, no framework.
 */
import { RESUME_KINDS, SCAN_STATUSES, SCAN_UNKNOWN, type ResumeKind } from './search-vocab';

/** A parsed search envelope, as this module reads it. */
export interface SearchEnvelope {
    readonly meta?: unknown;
    readonly result?: unknown;
}

/** How, and whether, a response can be continued, and from WHICH cursor. */
export interface ResumeAffordance {
    /** A RESUME_KINDS value. */
    readonly kind: ResumeKind;
    /** The cursor to send, or null. */
    readonly cursor: string | null;
    /**
     * The ONLY meta field consulted, named so a test can assert the
     * WIRING rather than the prose. A test on the sentence passes when
     * the sentence is right and the field read is wrong.
     */
    readonly field: string | null;
    /** The control's label. */
    readonly label: string;
    /** True when the control must be emitted disabled. */
    readonly blocked: boolean;
    /** Why, in words a person can act on. */
    readonly reason: string;
}

/** Scan progress as a fraction of TRANSCRIPTS. Never bytes. */
export interface ScanProgress {
    readonly scanned: number | null;
    readonly inScope: number | null;
    /** Null whenever either integer is missing, so no bar over a guess. */
    readonly fraction: number | null;
}

/**
 * Read a plain object off an unknown, or an empty one.
 *
 * Description: an arrays-are-objects trap is deliberately not guarded
 *   here, because every field read downstream is a named scalar and an
 *   array answers `undefined` for all of them.
 * Inputs: v - anything. Output: a record, never null.
 */
function obj(v: unknown): Record<string, unknown> {
    return (v && typeof v === 'object') ? v as Record<string, unknown> : {};
}

/**
 * Read an integer field, or null.
 *
 * Description: NULL IS NOT ZERO. A count the server did not send must
 *   render as NOT KNOWN, because a zero is a positive claim that nothing
 *   was in scope.
 * Inputs: v - anything. Output: the number, or null.
 */
function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Read `meta.scan.status`, checked for MEMBERSHIP.
 *
 * Description: never defaults to `complete`. A value this client does
 *   not recognise, or an absent scan block, answers `unknown`, which is
 *   a real answer meaning "whether anything remains unread is NOT
 *   KNOWN".
 * Inputs: envelope - a parsed search response, or null.
 * Output: a SCAN_STATUSES value, or `unknown`.
 * Example: scanStatus({meta: {scan: {status: 'budget_exhausted'}}})
 *   // -> 'budget_exhausted'
 */
export function scanStatus(envelope: SearchEnvelope | null | undefined): string {
    const value = obj(obj(obj(envelope).meta).scan).status;
    return SCAN_STATUSES.includes(value as string) ? value as string : SCAN_UNKNOWN;
}

/**
 * Decide how, and whether, this response can be continued.
 *
 * Description: THE ONE RULE - each scan status reads exactly ONE named
 *   cursor field and there is no fallback to the other. Falling back
 *   would produce a control that resumes the wrong dimension:
 *   continuing the SCAN when the person asked for more MATCHES silently
 *   re-reads scope they have already seen, and continuing the PAGE when
 *   the scan is unfinished skips the transcripts nobody opened while
 *   looking like it did not.
 * Inputs: envelope - a parsed search response, or null.
 * Output: a ResumeAffordance. `field` names the ONLY meta field read.
 * Example:
 *   resumeAffordance({meta: {scan: {status: 'limit_reached'},
 *                            paging: {next_cursor: 'abc'}}}).field
 *   // -> 'meta.paging.next_cursor'
 */
export function resumeAffordance(
    envelope: SearchEnvelope | null | undefined,
): ResumeAffordance {
    const status = scanStatus(envelope);
    const meta = obj(obj(envelope).meta);

    if (status === 'complete') {
        return {
            kind: RESUME_KINDS.NONE, cursor: null, field: null, blocked: false,
            label: 'nothing to resume',
            reason: 'The scan reported complete: every transcript in scope was read.',
        };
    }
    if (status === 'not_run') {
        return {
            kind: RESUME_KINDS.NOT_RUN, cursor: null, field: null, blocked: true,
            label: 'nothing to resume',
            reason: 'No scan ran, so there is no position to resume from. Every count '
                + 'on this response is null, not zero: nothing was measured.',
        };
    }
    if (status === 'limit_reached') {
        const paging = obj(meta.paging);
        const next = typeof paging.next_cursor === 'string' ? paging.next_cursor : null;
        return {
            kind: RESUME_KINDS.MORE_HITS,
            cursor: next,
            field: 'meta.paging.next_cursor',
            blocked: next === null,
            label: 'load more matches',
            reason: next === null
                ? 'The page limit was reached but meta.paging.next_cursor is absent, so '
                    + 'the next page cannot be requested.'
                : 'The page limit was reached. There are more MATCHES beyond this page. '
                    + 'This does not say the whole scope was read.',
        };
    }
    if (status === 'budget_exhausted') {
        const scan = obj(meta.scan);
        const resume = typeof scan.resume_cursor === 'string' ? scan.resume_cursor : null;
        return {
            kind: RESUME_KINDS.MORE_SCOPE,
            cursor: resume,
            field: 'meta.scan.resume_cursor',
            blocked: resume === null,
            label: 'resume the scan',
            reason: resume === null
                ? 'The scan budget was spent but meta.scan.resume_cursor is absent, so '
                    + 'the unread part of the scope cannot be reached from here.'
                : 'The scan budget was spent before the scope was finished. Resuming '
                    + 'reads MORE OF THE SCOPE, not more matches from what was read.',
        };
    }
    return {
        kind: RESUME_KINDS.UNKNOWN, cursor: null, field: null, blocked: true,
        label: 'nothing to resume',
        reason: 'The server reported no scan status this client recognises, so whether '
            + 'anything remains unread is NOT KNOWN.',
    };
}

/**
 * The coverage sentence, rendered on EVERY outcome including `ok`.
 *
 * Description: `ok` is compatible with having read one transcript out of
 *   3,416, so an `ok` that silently implies a complete search is the
 *   same false green in a nicer suit.
 * Inputs: envelope - a parsed search response, or null.
 * Output: a sentence, never empty.
 * Example: coverageSentence(limitReached)
 *   // -> 'coverage: 1 of 3416 transcripts in scope were read. ...'
 */
export function coverageSentence(envelope: SearchEnvelope | null | undefined): string {
    const meta = obj(obj(envelope).meta);
    const scanned = num(obj(meta.scan).transcripts_scanned);
    const inScope = num(obj(meta.scope).transcripts_in_scope);
    if (scanned === null || inScope === null) {
        return 'coverage: NOT KNOWN. The server did not report how much of the scope it '
            + 'read, so this result says nothing about what was not read.';
    }
    let line = `coverage: ${scanned} of ${inScope} transcripts in scope were read.`;
    if (scanned < inScope) {
        line += ` ${inScope - scanned} were NOT read; nothing is known about them.`;
    }
    return line;
}

/**
 * Scan progress as a fraction of TRANSCRIPTS.
 *
 * Description: never bytes - see the header on `bytes_scanned`
 *   overshooting its own budget. `fraction` is null whenever either
 *   integer is missing, so a caller cannot render a bar over a guess.
 * Inputs: envelope - a parsed search response, or null.
 * Output: a ScanProgress.
 * Example: scanProgress(null).fraction // -> null
 */
export function scanProgress(envelope: SearchEnvelope | null | undefined): ScanProgress {
    const meta = obj(obj(envelope).meta);
    const scanned = num(obj(meta.scan).transcripts_scanned);
    const inScope = num(obj(meta.scope).transcripts_in_scope);
    const fraction = (scanned !== null && inScope !== null && inScope > 0)
        ? scanned / inScope
        : null;
    return { scanned, inScope, fraction };
}
