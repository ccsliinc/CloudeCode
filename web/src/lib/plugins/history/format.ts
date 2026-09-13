/**
 * Pure display formatting for the archive screen: byte counts, character
 * counts, timestamps, relative ages, sha256 abbreviation and long-slug
 * shortening. PORTED from `client/js/archive-format.js`, deleted in the
 * same commit.
 *
 * WHY EVERY FUNCTION HERE HAS A THIRD RETURN. A formatter is the last
 * place anyone looks for a false green, which is exactly why it is a
 * good place for one to hide. `formatBytes(undefined)` returning "0 B"
 * is a formatter inventing a measurement: it renders a confident,
 * specific, wrong fact in the same typeface as a real one, and no
 * downstream check can tell the difference afterwards. So every function
 * in this file returns the NOT_KNOWN sentinel for input it cannot
 * account for, and never a zero, never a dash, never an empty string.
 * "size: NOT KNOWN" is actionable. A blank cell is not.
 *
 * TWO UNIT FACTS THIS FILE ENCODES, from the live API (2026-08-31). The
 * archive reports `body_chars` in UNICODE CODE POINTS and `body_bytes`
 * in BYTES, and the search response says so explicitly in
 * meta.offset_units / meta.body_size_units. They are different numbers
 * for the same body and they are not interchangeable: body 379 is 19,831
 * code points, 19,843 UTF-16 code units, and a different byte count
 * again. formatChars and formatBytes are therefore separate functions
 * with separate units in their output, so a caller cannot pass one to
 * the other and get a plausible-looking wrong label.
 *
 * THE TYPES ARE `unknown`, NOT `number`, AND THAT IS DELIBERATE IN THE
 * PORT. Every one of these is reached from a server envelope, so the
 * argument genuinely can be anything; typing it `number` would move the
 * refusal from a value the caller can render into a compile error the
 * caller never sees, and the NOT_KNOWN return - the whole point of the
 * file - would become unreachable on the path that needs it.
 *
 * Pure. No DOM beyond the one explicit renderer at the bottom, no fetch,
 * no globals.
 */

/** What every function here returns when it cannot evaluate its input. */
export const NOT_KNOWN = 'NOT KNOWN';

/**
 * Bytes per binary step. Binary because the API's own caps are binary
 * (MAX_BODY_BYTES 67,108,864 = 64 MiB).
 */
const BYTES_PER_STEP = 1024;

/** Binary byte unit ladder, ascending. */
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Decimal places used for every unit above plain bytes. */
const BYTE_DECIMALS = 1;

/** One step on the relative-age ladder. */
interface AgeStep {
    readonly seconds: number;
    readonly one: string;
    readonly many: string;
}

/** Seconds in each relative-age step. Largest first; first match wins. */
const AGE_STEPS: readonly AgeStep[] = [
    { seconds: 31557600, one: 'year', many: 'years' },
    { seconds: 2629800, one: 'month', many: 'months' },
    { seconds: 86400, one: 'day', many: 'days' },
    { seconds: 3600, one: 'hour', many: 'hours' },
    { seconds: 60, one: 'minute', many: 'minutes' },
    { seconds: 1, one: 'second', many: 'seconds' },
];

/**
 * How many leading hex characters of a sha256 to show. Twelve is the
 * git-ish convention and is unambiguous across the corpus' 6,240
 * secret-bearing bodies.
 */
export const SHA_ABBREV_CHARS = 12;

/** A full sha256 in lowercase hex. */
const SHA256_HEX_CHARS = 64;

/** Default maximum rendered width for a slug, in characters. */
export const SLUG_MAX_CHARS = 48;

/** What replaces the elided middle of a shortened slug. */
const SLUG_ELLIPSIS = '...';

/**
 * Is this a real, finite, non-negative number we can format?
 *
 * Description: rejects NaN, Infinity, null, undefined, strings and
 *   negatives, all of which are "I was not given a measurement".
 * Inputs: n - anything. Output: boolean, narrowing to number.
 */
function isCountable(n: unknown): n is number {
    return typeof n === 'number' && isFinite(n) && n >= 0;
}

/**
 * Group an integer with thousands separators.
 *
 * Description: hand-rolled rather than `toLocaleString`, which would
 *   make two machines render the same corpus differently.
 * Inputs: n - a non-negative finite number.
 * Output: string, e.g. 2447028 -> '2,447,028'.
 */
function group(n: number): string {
    const whole = String(Math.floor(n));
    let out = '';
    let count = 0;
    for (let i = whole.length - 1; i >= 0; i--) {
        out = whole.charAt(i) + out;
        count++;
        if (count % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
}

/**
 * Render a byte count in binary units.
 * Inputs: bytes - a non-negative finite byte count.
 * Output: string, or NOT_KNOWN when `bytes` is not a usable number.
 * Example: formatBytes(54376879)   // -> '51.9 MiB'
 *          formatBytes(0)          // -> '0 B'
 *          formatBytes(undefined)  // -> 'NOT KNOWN'   (not '0 B')
 */
export function formatBytes(bytes: unknown): string {
    if (!isCountable(bytes)) return NOT_KNOWN;
    if (bytes < BYTES_PER_STEP) return group(bytes) + ' B';
    let value = bytes;
    let unit = 0;
    while (value >= BYTES_PER_STEP && unit < BYTE_UNITS.length - 1) {
        value = value / BYTES_PER_STEP;
        unit++;
    }
    return value.toFixed(BYTE_DECIMALS) + ' ' + BYTE_UNITS[unit];
}

/**
 * Render a character count.
 *
 * Description: deliberately NOT abbreviated into units. `body_chars` is
 *   in unicode code points and the exact number is what the size gates
 *   are evaluated against, so rounding it in the UI would make a gated
 *   row's stated size disagree with the reason it was gated.
 * Inputs: chars - a non-negative finite code-point count.
 * Output: string, or NOT_KNOWN.
 * Example: formatChars(54376859)   // -> '54,376,859 chars'
 */
export function formatChars(chars: unknown): string {
    if (!isCountable(chars)) return NOT_KNOWN;
    return group(chars) + (chars === 1 ? ' char' : ' chars');
}

/**
 * Render a plain count of things, with separators and no unit.
 * Inputs: n - a non-negative finite count.
 * Output: string, or NOT_KNOWN.
 * Example: formatCount(3416)   // -> '3,416'
 */
export function formatCount(n: unknown): string {
    if (!isCountable(n)) return NOT_KNOWN;
    return group(n);
}

/**
 * Parse an API timestamp into epoch milliseconds.
 *
 * Description: shared by formatTimestamp and formatRelativeAge so the
 *   two can never disagree about whether a string is parseable.
 * Inputs: iso - e.g. '2026-08-30T16:01:00.290244Z'.
 * Output: epoch ms, or null when unparseable.
 */
function epochMs(iso: unknown): number | null {
    if (typeof iso !== 'string' || iso === '') return null;
    const ms = Date.parse(iso);
    return isFinite(ms) ? ms : null;
}

/** Zero-pad a number to two digits. */
function pad2(n: number): string {
    return (n < 10 ? '0' : '') + n;
}

/**
 * Render an API timestamp for display, in the viewer's local time zone.
 * Inputs: iso - an ISO 8601 timestamp from the API.
 * Output: string, or NOT_KNOWN when the value is absent or does not
 *   parse. Never the epoch, and never today's date as a stand-in.
 * Example: formatTimestamp('2026-08-30T16:01:00.290244Z')
 *          // -> '2026-08-30 12:01:00' (rendered in local time)
 */
export function formatTimestamp(iso: unknown): string {
    const ms = epochMs(iso);
    if (ms === null) return NOT_KNOWN;
    const d = new Date(ms);
    return d.getFullYear() + '-'
        + pad2(d.getMonth() + 1) + '-'
        + pad2(d.getDate()) + ' '
        + pad2(d.getHours()) + ':'
        + pad2(d.getMinutes()) + ':'
        + pad2(d.getSeconds());
}

/**
 * Render how long ago a timestamp was.
 *
 * Description: `nowMs` is a PARAMETER rather than a call to `Date.now()`
 *   so this function is pure and a test can pin the clock instead of
 *   asserting against a moving target.
 * Inputs: iso - an ISO 8601 timestamp. nowMs - the reference instant.
 * Output: string, or NOT_KNOWN when either input is unusable. A
 *   timestamp in the FUTURE returns 'in the future' rather than a
 *   negative age: a negative duration is a fact about clock skew, not
 *   about the record, and rendering it as '-3 days ago' invites the
 *   reader to treat it as a real age.
 * Example: formatRelativeAge('2026-08-30T16:01:00Z',
 *            Date.parse('2026-08-31T16:01:00Z'))   // -> '1 day ago'
 */
export function formatRelativeAge(iso: unknown, nowMs: unknown): string {
    const ms = epochMs(iso);
    if (ms === null) return NOT_KNOWN;
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) return NOT_KNOWN;
    const deltaSeconds = Math.floor((nowMs - ms) / 1000);
    if (deltaSeconds < 0) return 'in the future';
    if (deltaSeconds < 1) return 'just now';
    for (const step of AGE_STEPS) {
        if (deltaSeconds >= step.seconds) {
            const count = Math.floor(deltaSeconds / step.seconds);
            return count + ' ' + (count === 1 ? step.one : step.many) + ' ago';
        }
    }
    return 'just now';
}

/**
 * Shorten a sha256 to its leading characters for display.
 *
 * Description: REFUSES anything that is not a full lowercase-hex
 *   sha256, because silently truncating some other string produces an
 *   identifier-looking thing that identifies nothing.
 * Inputs: hex - a 64-character lowercase hex digest.
 * Output: SHA_ABBREV_CHARS characters, or NOT_KNOWN.
 * Example: abbreviateSha('0236d0f5...')   // -> '0236d0f520b4'
 */
export function abbreviateSha(hex: unknown): string {
    if (typeof hex !== 'string') return NOT_KNOWN;
    if (hex.length !== SHA256_HEX_CHARS) return NOT_KNOWN;
    if (!/^[0-9a-f]+$/.test(hex)) return NOT_KNOWN;
    return hex.slice(0, SHA_ABBREV_CHARS);
}

/**
 * Shorten a long project slug for a fixed-width rail, eliding the
 * MIDDLE rather than the tail.
 *
 * Description: project slugs in this corpus are path-derived and their
 *   distinguishing part is at the END, so a tail truncation renders a
 *   column of identical prefixes that cannot be told apart.
 *
 *   Operates on CODE POINTS, not UTF-16 code units, so a slug containing
 *   astral characters is never cut through the middle of a surrogate
 *   pair (which would render as a replacement glyph).
 * Inputs: text - the slug. maxChars - budget in code points, default
 *   SLUG_MAX_CHARS; values below the ellipsis width are unusable.
 * Output: string, or NOT_KNOWN when `text` is not a string.
 * Example: shortenSlug('-Users-jsugamele-Development-Assistants-Infrastructure', 30)
 *          // -> '-Users-jsuga...s-Infrastructure'
 */
export function shortenSlug(text: unknown, maxChars?: unknown): string {
    if (typeof text !== 'string') return NOT_KNOWN;
    const limit = (typeof maxChars === 'number' && isFinite(maxChars))
        ? Math.floor(maxChars) : SLUG_MAX_CHARS;
    if (limit <= SLUG_ELLIPSIS.length) return NOT_KNOWN;

    // Array.from splits on code points, so a surrogate pair stays
    // intact. String.prototype.slice would happily cut one in half.
    const points = Array.from(text);
    if (points.length <= limit) return text;

    const keep = limit - SLUG_ELLIPSIS.length;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return points.slice(0, head).join('')
        + SLUG_ELLIPSIS
        + (tail > 0 ? points.slice(points.length - tail).join('') : '');
}

/** Class prefix used by renderTranscriptHeader when a caller supplies none. */
const READER_ROOT_CLASS = 'archive-reader';

/** The fields of the server's transcript header record that are read here. */
interface TranscriptHeader {
    readonly transcript_id?: unknown;
    readonly session_ref?: unknown;
    readonly source_path?: unknown;
    readonly line_count?: unknown;
    readonly raw_byte_length?: unknown;
}

/**
 * Build one element with a class and, optionally, text.
 *
 * Description: text always goes through a TEXT NODE, never innerHTML -
 *   a transcript path is data and this app's CSP forbids inline script
 *   for the same reason.
 * Inputs: doc, tag, cls, text. Output: Element.
 */
function el(
    doc: Document, tag: string, cls: string | null, text: string | null,
): Element {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== null && text !== undefined) {
        node.appendChild(doc.createTextNode(String(text)));
    }
    return node;
}

/**
 * Render the transcript header facts as an element.
 *
 * Description: it stays visible through a cannot-determine on the LINES,
 *   because the header's facts came from a different request that
 *   succeeded, and hiding them would discard a real measurement.
 *
 *   FIELD NAMES ARE THE SERVER'S, NOT INVENTED ONES, and that cost real
 *   time. Measured 2026-08-31 against the live
 *   GET /api/v1/archive/transcripts/5767: the header record carries
 *   `transcript_id`, `source_path` and `raw_byte_length`. This block
 *   previously read `header.byte_length`, `header.path` and `header.id`
 *   - none of which the server sends - so a fully successful header
 *   request rendered "30,805 lines / size NOT KNOWN" over a byte count
 *   the app already held. The unit test passed throughout, because its
 *   fixture used the same invented names.
 * Inputs: doc. header - the server's header record, or null. rootClass.
 * Output: Element, or null when `header` is null. NULL IS NOT AN EMPTY
 *   HEADER: it means no header request has succeeded yet, and the caller
 *   renders nothing rather than inventing blank facts.
 * Example: renderTranscriptHeader(document,
 *            {transcript_id: 5767, line_count: 30805,
 *             raw_byte_length: 91950363}, 'archive-reader');
 */
export function renderTranscriptHeader(
    doc: Document, header: TranscriptHeader | null, rootClass?: string | null,
): Element | null {
    if (!doc) throw new Error('renderTranscriptHeader needs a document');
    if (!header) return null;
    const rc = rootClass || READER_ROOT_CLASS;
    const box = el(doc, 'div', rc + '__header-facts', null);
    const title = (header.session_ref || header.source_path
        || ('transcript ' + String(header.transcript_id))) as string;
    box.appendChild(el(doc, 'h2', rc + '__title', title));
    box.appendChild(el(doc, 'p', rc + '__facts',
        (Number.isFinite(header.line_count as number)
            ? formatCount(header.line_count) + ' lines'
            : 'line count ' + NOT_KNOWN) + '  /  '
        + (Number.isFinite(header.raw_byte_length as number)
            ? formatBytes(header.raw_byte_length)
            : 'size ' + NOT_KNOWN)));
    return box;
}

/** Everything the legacy tree reaches as `window.ArchiveFormat`. */
export const archiveFormat = {
    renderTranscriptHeader,
    formatBytes,
    formatChars,
    formatCount,
    formatTimestamp,
    formatRelativeAge,
    abbreviateSha,
    shortenSlug,
    NOT_KNOWN,
    SLUG_MAX_CHARS,
    SHA_ABBREV_CHARS,
};
