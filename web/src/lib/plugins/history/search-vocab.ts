/**
 * THE SEARCH PANEL'S VOCABULARY: every class name it may emit, every
 * `data-action` it answers to, the four scan statuses and the five
 * resume kinds.
 *
 * THIS FILE IS THE WHOLE OF COMMITMENT 1 ("no new class names") for the
 * search surface, and it is a straight carry-over of the mechanism
 * slice 5's `nav-vocab.ts`, slice 6's `tlist-vocab.ts` and slice 7's
 * `reader-vocab.ts` established. Every string in `CLASS` below is
 * byte-for-byte a class already emitted by
 * `client/js/archive-search-render.js` or `client/js/archive-search.js`.
 *
 * NOTHING HERE IS COMPUTED. The vanilla built its withheld-preview
 * modifier as `ROOT_CLASS + '__preview ' + ROOT_CLASS + '__preview--withheld'`,
 * a two-class string. Both halves are LITERALS below, because a computed
 * modifier is invisible to the stylesheet antijoin and a modifier with
 * no rule anywhere renders in user-agent defaults with no test able to
 * see it.
 *
 * Ported from client/js/archive-search-render.js. Pure data, no DOM, no
 * imports.
 */

/** Root class of the search panel. */
export const ROOT_CLASS = 'archive-search';

/**
 * Every class name this feature emits, spelled once.
 *
 * Description: the single source of truth for commitment 1. A template
 *   that needs a class reads it from here; a template wanting a class
 *   not in here is introducing a new class name and
 *   `SearchPanel.commitments.test.ts` fails the build.
 */
export const CLASS = {
    root: ROOT_CLASS,
    coverage: `${ROOT_CLASS}__coverage`,
    hits: `${ROOT_CLASS}__hits`,
    footer: `${ROOT_CLASS}__footer`,
    resume: `${ROOT_CLASS}__resume`,
    resumeReason: `${ROOT_CLASS}__resume-reason`,
    resumeBtn: `${ROOT_CLASS}__resume-btn`,

    hit: `${ROOT_CLASS}__hit`,
    hitLoc: `${ROOT_CLASS}__hit-loc`,
    hitTranscript: `${ROOT_CLASS}__hit-transcript`,
    hitRef: `${ROOT_CLASS}__hit-ref`,
    hitLine: `${ROOT_CLASS}__hit-line`,
    hitOffset: `${ROOT_CLASS}__hit-offset`,

    preview: `${ROOT_CLASS}__preview`,
    previewWithheld: `${ROOT_CLASS}__preview--withheld`,
    previewLabel: `${ROOT_CLASS}__preview-label`,
    previewNote: `${ROOT_CLASS}__preview-note`,

    transportReason: `${ROOT_CLASS}__transport-reason`,
} as const;

/**
 * Classes this panel emits that match NO rule in any of the 12 archive
 * stylesheets, measured 2026-09-18 against all 4,444 lines.
 *
 * Description: PRE-EXISTING. `archive-search__footer` is emitted today
 *   by `client/js/archive-search.js`'s `create()`. It is KEPT because
 *   dropping it would be a change to the emitted markup, which is the
 *   exact thing this table exists to hold still, and it is NAMED here
 *   rather than quietly filtered in the test so that a second cannot
 *   join it without somebody editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    `${ROOT_CLASS}__footer`,
];

/**
 * Every `meta.scan.status` this client recognises.
 *
 * Description: MEMBERSHIP IS CHECKED, NOT EQUALITY AGAINST `complete`,
 *   so a status the server invents later reports as unrecognised rather
 *   than silently as a finished scan. A zero-hit `budget_exhausted`
 *   rendered like a zero-hit `complete` tells a person the archive holds
 *   no occurrence of their term when 76 percent of the scope was never
 *   read.
 */
export const SCAN_STATUSES: readonly string[] = [
    'complete', 'budget_exhausted', 'limit_reached', 'not_run',
];

/** A scan status this client does not recognise. Never `complete`. */
export const SCAN_UNKNOWN = 'unknown';

/**
 * What the two cursors MEAN, kept apart by name.
 *
 * Description: no call site may confuse "more matches beyond this page
 *   boundary" with "more of the scope was never opened". Measured live
 *   2026-08-31, the two are exactly complementary, which is what makes
 *   reading the wrong one easy to do and hard to notice:
 *   `limit_reached` sets `meta.paging.next_cursor` and leaves
 *   `meta.scan.resume_cursor` null; `budget_exhausted` does the reverse.
 */
export const RESUME_KINDS = {
    NONE: 'none',
    MORE_HITS: 'more-hits',
    MORE_SCOPE: 'more-scope',
    NOT_RUN: 'not-run',
    UNKNOWN: 'unknown',
} as const;

/** One resume kind. */
export type ResumeKind = (typeof RESUME_KINDS)[keyof typeof RESUME_KINDS];

/**
 * The `data-action` values the panel's delegated handlers answer to.
 *
 * Description: kept as a table because the click router, the templates
 *   emitting the buttons and the tests asserting which affordances EXIST
 *   all have to agree, and a literal retyped in three places is three
 *   places to get it wrong.
 */
export const ACTIONS = {
    OPEN_HIT: 'open-hit',
    LOAD_MORE_HITS: 'load-more-hits',
    RESUME_SCAN: 'resume-scan',
} as const;

/** One search action name. */
export type SearchAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/** The banner word over a withheld preview. Upper case, as the vanilla. */
export const PREVIEW_WITHHELD_LABEL = 'PREVIEW WITHHELD';

/**
 * The sentence every withheld preview leads with.
 *
 * Description: NORMATIVE and the wording is load-bearing. A withheld
 *   preview is a REAL HIT at a REAL position, and the server says so
 *   itself (`withholding_never_suppresses_a_hit: true`). Rendering it as
 *   an error would under-report the count; rendering it as empty would
 *   imply the preview held nothing.
 */
export const WITHHELD_LEAD =
    'This match IS real and IS at the position named above.';

/** What the coverage line says before any answer has arrived. */
export const COVERAGE_PENDING = 'scanning. coverage so far: NOT KNOWN.';
