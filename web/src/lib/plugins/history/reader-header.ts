/**
 * THE TRANSCRIPT HEADER'S TWO SENTENCES.
 *
 * Ported from `renderTranscriptHeader` in `./format.ts`, which builds
 * the same two elements imperatively. IT IS A SECOND SPELLING OF ONE
 * RULE AND THAT IS DELIBERATE, because the alternative is worse: the
 * function there returns a DOM `Element`, and appending a foreign
 * element into a Svelte template means the framework neither owns nor
 * updates it, so a header that changed would need a manual teardown and
 * rebuild on every transcript switch. What the two must agree on is the
 * CLASS NAMES and the WORDS, so both are taken from the same places -
 * the vocabulary table and `format.ts`'s own formatters - and only the
 * element construction differs.
 *
 * NULL IS NOT AN EMPTY HEADER. It means no header request has succeeded
 * yet, and the caller renders NOTHING rather than inventing blank facts.
 * That is `renderTranscriptHeader`'s own contract, carried across.
 *
 * A FACT THAT IS NOT KNOWN SAYS SO. `line count NOT KNOWN` is not the
 * same as `0 lines`, and a transcript whose size the server did not
 * report must not render as a zero-byte file.
 *
 * Pure. No DOM, no framework.
 */
import { formatBytes, formatCount, NOT_KNOWN } from './format';

/** The fields of the server's transcript record this reads. */
export interface TranscriptHeaderRecord {
    readonly transcript_id?: unknown;
    readonly session_ref?: unknown;
    readonly source_path?: unknown;
    readonly line_count?: unknown;
    readonly raw_byte_length?: unknown;
}

/** The two strings the header renders. */
export interface HeaderFacts {
    /** The heading: a session ref, a path, or the id. Never blank. */
    readonly title: string;
    /** The line count and the size, or NOT KNOWN for either. */
    readonly facts: string;
}

/**
 * Turn one transcript record into the header's two sentences.
 *
 * Description: the title chain is session_ref, then source_path, then
 *   the literal `transcript <id>` - never a blank heading, because a
 *   blank heading is a could-not-evaluate rendered as whitespace.
 * Inputs: header - the record, or null when none has succeeded.
 * Output: the two strings, or NULL when there is no record. Null means
 *   "render nothing", not "render an empty header".
 * Example: headerFacts({transcript_id: 5767, line_count: 30805,
 *   raw_byte_length: 91950363})
 *   // -> {title: 'transcript 5767', facts: '30,805 lines  /  87.7 MiB'}
 */
export function headerFacts(
    header: TranscriptHeaderRecord | null | undefined,
): HeaderFacts | null {
    if (!header) return null;
    const title = (header.session_ref || header.source_path
        || `transcript ${String(header.transcript_id)}`) as string;
    const lines = Number.isFinite(header.line_count)
        ? `${formatCount(header.line_count)} lines`
        : `line count ${NOT_KNOWN}`;
    const size = Number.isFinite(header.raw_byte_length)
        ? formatBytes(header.raw_byte_length)
        : `size ${NOT_KNOWN}`;
    return { title, facts: `${lines}  /  ${size}` };
}
