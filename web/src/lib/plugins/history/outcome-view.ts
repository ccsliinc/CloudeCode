/**
 * THE OUTCOME BLOCK'S MODEL: what a `cannot_determine` LOOKS LIKE,
 * computed. Ported from `client/js/archive-outcome-view.js`, rule for
 * rule, minus the DOM.
 *
 * WHY THIS IS THE MOST IMPORTANT FILE IN THE ARCHIVE UI. The archive
 * server pays real cost to distinguish "I looked and found nothing" from
 * "I could not look" from "I ran out of budget partway". The classifier
 * carries that distinction as far as a token. THIS carries it the last
 * step, to the pixel, where there is no outer check left to catch a
 * mistake. If an empty result and a `cannot_determine` reach the screen
 * looking alike, every layer of care underneath is spent for nothing and
 * the person reading the screen is told a verdict nobody measured.
 *
 * IT DOES NOT CLASSIFY, AND THAT IS LOAD-BEARING. `result_status`,
 * `scope_status` and `meta.scan.status` are read by exactly two modules
 * in this client: `archive-outcome.js` (the injected `OutcomeClassifier`
 * from `state.ts`, which slices 5, 6 and 7 all consume and which this
 * REUSES rather than re-deriving) and `search-envelope.ts` for the scan
 * status alone. THIS FILE READS ONLY INTEGERS AND STRINGS OUT OF `meta`.
 * Two branch sets on one status field drift, and one of them starts
 * calling a `partial` an `ok` - a search that gave up after 801 of 3,416
 * transcripts reported as a complete answer.
 *
 * TWO MEASURED FACTS THAT DRIVE THE COPY (live server, 2026-08-31):
 *
 *   1. `scan.bytes_scanned` IS A CHARGE, NOT WORK DONE. Measured, it
 *      reported 551,648,566 against a `budget_bytes` of 536,870,912,
 *      2.75 percent OVER its own budget, and 91,950,363 bytes in
 *      0.0756 s - an impossible 1.22 GB/s - because a whole transcript
 *      is charged when the page limit is hit after reading a fraction of
 *      it. A quantity that exceeds its own budget cannot be a fraction
 *      of anything. Progress here is ALWAYS transcripts over
 *      transcripts. `bytes_scanned` renders as a raw number, LABELLED a
 *      charge.
 *
 *   2. `result_status: "ok"` DOES NOT MEAN THE WHOLE SCOPE WAS READ.
 *      Measured: `q=restic&project_id=12&limit=3` answered `ok` with
 *      `scan.status: limit_reached` and `transcripts_not_scanned: 3415`
 *      of 3,416. So the `ok` block states its coverage too. An `ok` that
 *      silently implies a complete search is the same false green in a
 *      nicer suit.
 *
 * NO `innerHTML` ANYWHERE, and the port makes that structural rather
 * than disciplined: this module returns DATA and Svelte's `{...}`
 * interpolation escapes. Host display names carry real non-ASCII -
 * measured, host 2 is "Joseph's Mac mini (2)" with a U+2019 - and
 * server-supplied `reason` strings are rendered verbatim by requirement.
 *
 * Pure. No DOM, no fetch, no framework.
 */
import {
    DEFAULT_ACTIONS, LABELS, NO_REASON_SUPPLIED, NO_REASON_TEXT,
    NO_RESUME_CURSOR_REASON, UNNAMED_SCOPE, UNNAMED_SUBJECT, type ActionDef,
} from './outcome-vocab';

/** One `unevaluated` entry, as the server sends it. */
export interface OutcomeReason {
    readonly subject?: unknown;
    readonly reason?: unknown;
}

/** One reason, ready to paint. Both halves are always non-empty. */
export interface ReasonRow {
    readonly subject: string;
    readonly text: string;
}

/** The three scan integers plus the charge and the cursor. */
export interface ScanNumbers {
    readonly scanned: number | null;
    readonly notScanned: number | null;
    readonly inScope: number | null;
    /** A CHARGE the server levies, never a numerator or a denominator. */
    readonly bytesCharged: number | null;
    readonly resumeCursor: string | null;
}

/** One affordance, ready to paint, with its blocked reason if any. */
export interface ActionRow extends ActionDef {
    readonly disabled: boolean;
    /** Why it is disabled, or null. A control that silently fails is worse. */
    readonly blockedReason: string | null;
}

/** The coverage line, split into its three named cells. */
export interface CoverageRow {
    readonly counts: string;
    readonly gap: string | null;
    readonly charge: string | null;
}

/** The whole block, computed. */
export interface OutcomeBlockModel {
    readonly token: string;
    readonly label: string;
    readonly headline: string;
    readonly reasons: readonly ReasonRow[];
    readonly coverage: CoverageRow | null;
    readonly actions: readonly ActionRow[];
}

/** Read a plain object off an unknown, or an empty one. */
function obj(v: unknown): Record<string, unknown> {
    return (v && typeof v === 'object') ? v as Record<string, unknown> : {};
}

/** Read a finite number, or null. NULL IS NOT ZERO. */
function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Describe the scope the server said it was working in.
 *
 * Description: reads only `meta.scope`, which carries ids and names,
 *   never a status. NEVER RETURNS AN EMPTY STRING: a blank scope reads
 *   as if nothing was searched.
 * Inputs: meta - the envelope's meta object.
 * Output: e.g. "project 12", or the literal `UNNAMED_SCOPE`.
 * Example: describeScope({scope: {kind: 'project', project_id: 12}})
 *   // -> 'project 12'
 */
export function describeScope(meta: unknown): string {
    const scope = obj(meta).scope;
    if (!scope || typeof scope !== 'object') return UNNAMED_SCOPE;
    const s = scope as Record<string, unknown>;
    const kind = typeof s.kind === 'string' ? s.kind : 'scope';
    const id = s[`${kind}_id`];
    const name = s.display_name ?? s.corpus_key ?? s.slug;
    let out = kind;
    if (id !== null && id !== undefined) out += ` ${String(id)}`;
    if (name) out += ` (${String(name)})`;
    return out;
}

/**
 * Pull the scan integers out of `meta`.
 *
 * Description: never reads `scan.status` and never returns bytes as a
 *   fraction of anything. Any field the server did not supply is null,
 *   and the caller renders NOT KNOWN rather than inventing a zero.
 * Inputs: meta - the envelope's meta object.
 * Output: a ScanNumbers.
 * Example: scanNumbers({}).scanned // -> null
 */
export function scanNumbers(meta: unknown): ScanNumbers {
    const m = obj(meta);
    const scan = obj(m.scan);
    const scope = obj(m.scope);
    return {
        scanned: num(scan.transcripts_scanned),
        notScanned: num(scan.transcripts_not_scanned),
        inScope: num(scope.transcripts_in_scope),
        bytesCharged: num(scan.bytes_scanned),
        resumeCursor: typeof scan.resume_cursor === 'string' ? scan.resume_cursor : null,
    };
}

/**
 * The one-sentence headline for a token.
 *
 * Description: this is the sentence that must never be shared between
 *   two outcomes. "searched all" in the `empty` branch is LOAD-BEARING
 *   WORDING, not decoration: it is the proof that a COMPLETE empty
 *   search makes a positive claim about the whole scope, where a
 *   budget-exhausted one must refuse to. Keep the phrase if you reword
 *   this.
 * Inputs: token - the classifier's token. meta - the envelope's meta.
 *   n - `scanNumbers(meta)`.
 * Output: a sentence, always non-empty.
 * Example: headlineFor('partial', meta, n)
 */
export function headlineFor(token: string, meta: unknown, n: ScanNumbers): string {
    const scope = describeScope(meta);
    if (token === 'empty') {
        const searched = (n.scanned !== null && n.inScope !== null)
            ? `searched all ${n.scanned} of ${n.inScope} transcripts in ${scope}`
            : `searched ${scope} in full`;
        return `Search a wider scope: ${searched}, and none matched.`;
    }
    if (token === 'partial') {
        const left = n.notScanned !== null ? String(n.notScanned) : 'an unreported number of';
        return `Resume the scan: ${left} transcripts in ${scope} were never read, so `
            + 'nothing is known about them.';
    }
    if (token === 'cannot-determine') {
        return `Try again: the server answered but could not establish a result for `
            + `${scope}, which is not the same as finding nothing.`;
    }
    if (token === 'not-found') {
        return `Go up to the containing scope: the server looked and established that `
            + `${scope} does not exist.`;
    }
    if (token === 'transport-error') {
        return `Try again: nothing at all is known about ${scope}, because the server did `
            + 'not answer or answered with something this client could not read.';
    }
    return `Results from ${scope}.`;
}

/**
 * The server's `unevaluated` entries, ready to paint.
 *
 * Description: A BLOCK WHOSE TOKEN MEANS "SOMETHING WENT UNMEASURED" AND
 *   WHICH CARRIES NO REASONS STILL RENDERS A NAMED LINE saying the
 *   reason was not supplied. A blank cell is not an answer. `ok` and
 *   `empty` with no reasons yield an empty list, where there is
 *   genuinely nothing unevaluated.
 * Inputs: token - the classifier's token. reasons - the server's array.
 * Output: rows to paint, possibly empty.
 * Example: reasonRows('partial', []) // -> [{subject: 'partial', ...}]
 */
export function reasonRows(
    token: string, reasons: readonly OutcomeReason[] | null | undefined,
): readonly ReasonRow[] {
    const list = Array.isArray(reasons) ? reasons : [];
    if (list.length === 0) {
        const needs = token !== 'ok' && token !== 'empty';
        return needs ? [{ subject: token, text: NO_REASON_SUPPLIED }] : [];
    }
    return list.map((r) => {
        const one = obj(r);
        return {
            subject: one.subject === undefined || one.subject === null
                ? UNNAMED_SUBJECT : String(one.subject),
            text: one.reason === undefined || one.reason === null
                ? NO_REASON_TEXT : String(one.reason),
        };
    });
}

/**
 * Scan coverage as transcript COUNTS.
 *
 * Description: NEVER as a byte fraction - see the header, `bytes_scanned`
 *   overshot its own budget by 2.75 percent in a live measurement, so it
 *   cannot be a numerator or a denominator. It is emitted only as a raw
 *   number, LABELLED a charge, so a reader cannot mistake it for work
 *   completed.
 * Inputs: n - `scanNumbers(meta)`.
 * Output: a CoverageRow, or null when the server reported no scan at all.
 * Example: coverageRow({scanned: 1, inScope: 3416, ...})
 */
export function coverageRow(n: ScanNumbers): CoverageRow | null {
    if (n.scanned === null && n.inScope === null && n.bytesCharged === null) return null;
    const scanned = n.scanned === null ? 'NOT KNOWN' : String(n.scanned);
    const inScope = n.inScope === null ? 'NOT KNOWN' : String(n.inScope);
    return {
        counts: `Transcripts read: ${scanned} of ${inScope} in scope.`,
        gap: n.notScanned !== null ? ` Not read: ${n.notScanned}.` : null,
        charge: n.bytesCharged !== null
            ? ` Scan charge: ${n.bytesCharged} bytes (a charge the server levies, not a `
                + 'measure of work done).'
            : null,
    };
}

/**
 * The action row for one token.
 *
 * Description: `partial` is the one token whose primary action can be
 *   IMPOSSIBLE - a partial with no `resume_cursor` cannot be resumed.
 *   The control is STILL EMITTED, because the actions channel is what
 *   keeps the outcomes structurally distinct, but it is DISABLED and
 *   carries a stated reason. A control that silently fails is worse than
 *   a stated blocker.
 *
 *   `omit` exists because TWO IDENTICAL PRIMARY BUTTONS IS A BUG, NOT
 *   REDUNDANCY. The search panel renders its OWN, kind-aware resume
 *   control, which knows more-hits from more-scope from nothing; this
 *   generic block cannot make that distinction and would offer one
 *   undifferentiated button for three different situations. Measured
 *   before the option existed: a partial search painted "Resume the
 *   scan" twice, a few hundred pixels apart, from two modules that did
 *   not know about each other. A caller that draws its own says so here.
 * Inputs: token - the classifier's token. n - `scanNumbers(meta)`.
 *   extra - view-specific additions. omit - actions the caller draws
 *   itself.
 * Output: rows to paint.
 * Example: actionRows('partial', n, [], ['resume']) // -> []
 */
export function actionRows(
    token: string,
    n: ScanNumbers,
    extra?: readonly ActionDef[] | null,
    omit?: readonly string[] | null,
): readonly ActionRow[] {
    const skip = new Set(omit ?? []);
    const defs = [...(DEFAULT_ACTIONS[token] ?? []), ...(extra ?? [])];
    return defs.filter((d) => !skip.has(d.action)).map((d) => {
        const blocked = d.action === 'resume' && !n.resumeCursor;
        return {
            action: d.action,
            label: d.label,
            disabled: blocked,
            blockedReason: blocked ? NO_RESUME_CURSOR_REASON : null,
        };
    });
}

/**
 * Build the whole outcome block from an envelope and a token.
 *
 * Description: THE TOKEN IS PASSED IN, NOT DERIVED. Classification is
 *   the injected `OutcomeClassifier`'s exclusive business (see the file
 *   header), so this function takes its answer and never re-reads
 *   `result_status`. A caller that has a transport error and therefore
 *   no envelope passes the `transport-error` token with a null envelope,
 *   which is exactly the shape that produces the strongest block.
 * Inputs: token - the classifier's token. envelope - the parsed
 *   response, or null. reasons - the classifier's `unevaluated` array.
 *   extra - view-specific actions. omit - actions the caller draws
 *   itself.
 * Output: an OutcomeBlockModel. Every field is non-empty or an honest
 *   null; there is no shape of this that renders as blank.
 * Example: outcomeBlock('partial', env, reasons, null, ['resume']).actions
 *   // -> []
 */
export function outcomeBlock(
    token: string,
    envelope: unknown,
    reasons?: readonly OutcomeReason[] | null,
    extra?: readonly ActionDef[] | null,
    omit?: readonly string[] | null,
): OutcomeBlockModel {
    const meta = obj(envelope).meta;
    const n = scanNumbers(meta);
    return {
        token,
        // A TOKEN WITH NO LABEL RENDERS AS THE TOKEN, never as blank. A
        // classifier that grows a seventh token must be visible on
        // screen rather than silently unlabelled.
        label: LABELS[token] ?? token,
        headline: headlineFor(token, meta, n),
        reasons: reasonRows(token, reasons),
        coverage: coverageRow(n),
        actions: actionRows(token, n, extra, omit),
    };
}
