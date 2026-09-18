/**
 * THE EXPORT SURFACE'S VOCABULARY, AND THE TWO KINDS OF EXPORT IT MUST
 * NEVER LET A READER CONFUSE.
 *
 * KIND ONE: THE SERVER'S BYTE-EXACT TRANSCRIPT EXPORT. The bytes on
 * disk, unaltered, served by `src/core/message_model_export.py` through
 * `/archive/transcripts/{id}/export` and `.../export/verified`. Two
 * TRANSPORTS of ONE wire format (the raw `.jsonl`), not two formats:
 *
 *   verified   <= 8 MiB, 98.9 percent of transcripts. The server hashes
 *              the bytes before sending and puts BOTH hashes in headers.
 *   streaming  larger. No hash of what was sent, because uvicorn
 *              implements no HTTP trailers.
 *
 * THIS CLIENT NEVER COMPOSES, RE-SERIALISES, RE-ENCODES OR MASKS THOSE
 * BYTES, and that is not an oversight. Byte-exactness is the entire
 * value of the archive: a transcript that came back masked would not be
 * the bytes that were on disk, its sha256 would not match the one the
 * server published, and it would be worthless as evidence. The masking
 * lens belongs on a RENDERING, never on the artefact. So for kind one
 * this module does a PREFLIGHT and reports an integrity finding; it
 * moves no bytes at all, which is also why it cannot contradict the
 * server's export. There is exactly one implementation of that export
 * and it is the server's.
 *
 * KIND TWO: A CLIENT-COMPOSED EXPORT. Text this client builds out of
 * what is on screen - today, a set of search results - and hands to the
 * person. It is NOT byte-exact, is NOT evidence, and says so in its own
 * first line. It is composed from body-derived text, so it is the one
 * export that MUST go through `mask-egress.ts`, and it does: see
 * `export-compose.ts`, which cannot reach a snippet any other way.
 *
 * THE TWO ARE KEPT APART BY NAME, BY FILE AND BY HEADER LINE, because
 * the failure mode of confusing them runs in both directions. Masking
 * kind one destroys the archive's only real property. Failing to mask
 * kind two puts a credential in a file on somebody's desktop.
 *
 * Every string in `CLASS` below is byte-for-byte a class already emitted
 * by `client/js/archive-export.js`. Ported from it. Pure data, no DOM.
 */

/** Root class of the export modal. */
export const ROOT_CLASS = 'archive-export';

/**
 * Every class name this feature emits, spelled once.
 *
 * Description: the single source of truth for commitment 1 on this
 *   surface. `modal-overlay`, `modal-content` and `modal-header` are the
 *   app's GLOBAL modal classes, carried verbatim from the vanilla and
 *   declared here so the commitments test sees them declared rather than
 *   escaping as unknowns.
 */
export const CLASS = {
    root: ROOT_CLASS,
    overlay: `${ROOT_CLASS}-overlay`,
    content: `${ROOT_CLASS}__content`,
    header: `${ROOT_CLASS}__header`,
    slot: `${ROOT_CLASS}__slot`,
    body: `${ROOT_CLASS}__body`,
    label: `${ROOT_CLASS}__label`,
    reason: `${ROOT_CLASS}__reason`,
    filename: `${ROOT_CLASS}__filename`,
    bytes: `${ROOT_CLASS}__bytes`,
    shaExpected: `${ROOT_CLASS}__sha-expected`,
    shaActual: `${ROOT_CLASS}__sha-actual`,
    shasum: `${ROOT_CLASS}__shasum`,
    collision: `${ROOT_CLASS}__collision`,
    blocked: `${ROOT_CLASS}__blocked`,
    blockedLabel: `${ROOT_CLASS}__blocked-label`,
    blockedReason: `${ROOT_CLASS}__blocked-reason`,
    actions: `${ROOT_CLASS}__actions`,
    retry: `${ROOT_CLASS}__retry`,
    cancel: `${ROOT_CLASS}__cancel`,

    modalOverlay: 'modal-overlay',
    modalContent: 'modal-content',
    modalHeader: 'modal-header',
} as const;

/**
 * Classes this modal emits that match NO rule in any of the 12 archive
 * stylesheets, measured 2026-09-18.
 *
 * Description: ALL PRE-EXISTING, emitted today by
 *   `client/js/archive-export.js`'s `open()`. The three `modal-*`
 *   classes are styled in `client/css/styles.css`, which is NOT one of
 *   the twelve archive files the antijoin reads, so they appear unstyled
 *   to it and are named here rather than quietly filtered out, so a
 *   fourth cannot join them without somebody editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    `${ROOT_CLASS}__slot`,
    `${ROOT_CLASS}-overlay`,
    'modal-overlay',
    'modal-content',
    'modal-header',
];

/**
 * The states the export modal can be in.
 *
 * Description: `BLOCKED_NO_CREDENTIAL` is a state of the DOWNLOAD,
 *   ORTHOGONAL to the integrity states, and it renders ALONGSIDE them
 *   rather than instead of them: the integrity finding is true and
 *   useful whether or not the bytes can be fetched.
 */
export const STATES = {
    PREFLIGHT: 'preflight',
    VERIFIED: 'verified',
    UNVERIFIABLE: 'unverifiable',
    BUSY: 'busy',
    NOT_FOUND: 'not-found',
    CANNOT_DETERMINE: 'cannot-determine',
    BLOCKED_NO_CREDENTIAL: 'blocked-no-credential',
} as const;

/** One export state. */
export type ExportState = (typeof STATES)[keyof typeof STATES];

/**
 * The banner word for each state.
 *
 * Description: `VERIFIED` is the ONLY state that may be styled as
 *   success. `UNVERIFIABLE` is a COULD NOT EVALUATE, not a failure and
 *   not a pass, and its wording says so: no green, no checkmark, not
 *   dismissible.
 */
export const LABELS: Readonly<Record<string, string>> = {
    [STATES.VERIFIED]: 'INTEGRITY VERIFIED BEFORE SENDING',
    [STATES.UNVERIFIABLE]: 'INTEGRITY: COULD NOT BE EVALUATED',
    [STATES.BUSY]: 'THE SERVER IS BUSY',
    [STATES.NOT_FOUND]: 'NOT FOUND',
    [STATES.CANNOT_DETERMINE]: 'COULD NOT EVALUATE',
    [STATES.PREFLIGHT]: 'CHECKING',
};

/** HTTP status the server uses for "too large to verify". */
export const HTTP_TOO_LARGE = 413;

/** HTTP status the server uses for "already at the concurrency cap". */
export const HTTP_BUSY = 503;

/** HTTP status for a transcript id that is not in the archive. */
export const HTTP_NOT_FOUND = 404;

/** The `data-action` values the modal answers to. */
export const ACTIONS = {
    RETRY: 'retry',
    CANCEL: 'cancel',
} as const;

/**
 * The two FORMATS a CLIENT-COMPOSED export may take. Kind two only.
 *
 * Description: DELIBERATELY NOT `jsonl`. The archive's own artefact is
 *   `.jsonl` and a client-composed file wearing that extension would sit
 *   in a downloads folder looking exactly like a byte-exact transcript
 *   export while being a lossy, masked, reordered summary of a search.
 *   The two must not be confusable on disk any more than they are in
 *   this file.
 */
export const COMPOSED_FORMATS = {
    /** Tab-separated locator and preview, one line per hit. */
    TEXT: 'text',
    /** A JSON document with the same fields, for a script to read. */
    JSON: 'json',
} as const;

/** One composed-export format. */
export type ComposedFormat = (typeof COMPOSED_FORMATS)[keyof typeof COMPOSED_FORMATS];

/**
 * The first line of every client-composed export.
 *
 * Description: NORMATIVE. It states what the file is NOT before it
 *   states what it is, because the thing a reader must not do with it -
 *   treat it as the archive's byte-exact artefact - is the thing they
 *   would otherwise assume.
 */
export const COMPOSED_BANNER =
    'cloude archive: composed search results. NOT a byte-exact transcript '
    + 'export and NOT evidence. Previews are masked by this client and some '
    + 'are withheld; see each line. The byte-exact export is a separate '
    + 'server endpoint and is never produced here.';
