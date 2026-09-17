/**
 * The transcript reader's VOCABULARY: every class name it may emit,
 * every `data-action` it answers to, the record-type families and the
 * eight body states.
 *
 * THIS FILE IS THE WHOLE OF COMMITMENT 1 ("no new class names"), and it
 * is a straight carry-over of the mechanism slice 5's `nav-vocab.ts` and
 * slice 6's `tlist-vocab.ts` established. Issue #173 promises Adam that
 * his re-skin lands on top of this migration rather than fighting it,
 * and the only thing that can enforce that is ONE list of literals a
 * test can read. Every string in `CLASS` below is byte-for-byte a class
 * already emitted by `client/js/archive-line-render.js`,
 * `client/js/archive-reader-dom.js`, `client/js/archive-reader.js` or
 * `renderTranscriptHeader` in `./format.ts`.
 *
 * NOTHING HERE IS COMPUTED. The vanilla renderer built its family
 * modifier as `ROW_CLASS + '--' + family`, which a stylesheet antijoin
 * cannot recover from the source: a modifier with no rule anywhere would
 * render in user-agent defaults and no test could see it. `FAMILY_MOD`
 * is therefore a literal table, exactly as `TITLE_SOURCES[k].mod` is in
 * slice 6.
 *
 * Ported from client/js/archive-line-render.js and
 * client/js/archive-reader-dom.js. Pure data, no DOM, no imports.
 */

/** Root class of the reader shell. */
export const ROOT_CLASS = 'archive-reader';

/** Root class of ONE rendered line. A different BEM block on purpose. */
export const ROW_CLASS = 'archive-row';

/**
 * Every class name this feature emits, spelled once.
 *
 * Description: the single source of truth for commitment 1. A template
 *   that needs a class reads it from here; a template wanting a class
 *   not in here is introducing a new class name, and
 *   `TranscriptReader.commitments.test.ts` fails the build.
 */
export const CLASS = {
    root: ROOT_CLASS,
    header: `${ROOT_CLASS}__header`,
    headerFacts: `${ROOT_CLASS}__header-facts`,
    title: `${ROOT_CLASS}__title`,
    facts: `${ROOT_CLASS}__facts`,
    status: `${ROOT_CLASS}__status`,
    scroller: `${ROOT_CLASS}__scroller`,
    spacer: `${ROOT_CLASS}__spacer`,
    window: `${ROOT_CLASS}__window`,
    sentinel: `${ROOT_CLASS}__sentinel`,
    more: `${ROOT_CLASS}__more`,

    row: ROW_CLASS,
    head: `${ROW_CLASS}__head`,
    lineno: `${ROW_CLASS}__lineno`,
    role: `${ROW_CLASS}__role`,
    type: `${ROW_CLASS}__type`,
    meta: `${ROW_CLASS}__meta`,
    ts: `${ROW_CLASS}__ts`,
    model: `${ROW_CLASS}__model`,
    size: `${ROW_CLASS}__size`,
    badge: `${ROW_CLASS}__badge`,
    badgeSidechain: `${ROW_CLASS}__badge--sidechain`,
    badgeAgent: `${ROW_CLASS}__badge--agent`,
    badgeCompact: `${ROW_CLASS}__badge--compact`,
    body: `${ROW_CLASS}__body`,
    placeholder: `${ROW_CLASS}__placeholder`,
    text: `${ROW_CLASS}__text`,
    maskedNote: `${ROW_CLASS}__masked-note`,
    refusalLabel: `${ROW_CLASS}__refusal-label`,
    refusal: `${ROW_CLASS}__refusal`,
    action: `${ROW_CLASS}__action`,
    gateLabel: `${ROW_CLASS}__gate-label`,
    gate: `${ROW_CLASS}__gate`,
    loading: `${ROW_CLASS}__loading`,
    chip: `${ROW_CLASS}__chip`,
    range: `${ROW_CLASS}__range`,
    progressChildren: `${ROW_CLASS}__progress-children`,
} as const;

/**
 * Classes this reader emits that match NO rule in any of the 12 archive
 * stylesheets, measured 2026-09-17 against all 4,444 lines.
 *
 * Description: ALL FOUR ARE PRE-EXISTING. `archive-row__ts`,
 *   `archive-row__model` and `archive-row__size` are emitted today by
 *   `client/js/archive-line-render.js`'s `renderMeta`;
 *   `archive-reader__header-facts` is emitted today by
 *   `renderTranscriptHeader` in `./format.ts`. They are KEPT because
 *   dropping one would be a change to the emitted markup, which is the
 *   exact thing this table exists to hold still, and they are NAMED here
 *   rather than quietly filtered in the test so that a fifth cannot join
 *   them without somebody editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    `${ROW_CLASS}__ts`,
    `${ROW_CLASS}__model`,
    `${ROW_CLASS}__size`,
    `${ROOT_CLASS}__header-facts`,
];

/** The five rendering families the 26 measured record types collapse to. */
export const FAMILIES = {
    TURN: 'turn',
    TOOL: 'tool',
    PROGRESS: 'progress',
    NOTE: 'note',
    META: 'meta',
} as const;

/** One family name. */
export type Family = (typeof FAMILIES)[keyof typeof FAMILIES];

/**
 * The family modifier class, per family, as a LITERAL table.
 *
 * Description: never `${ROW_CLASS}--${family}`. See the file header: a
 *   computed modifier is invisible to the stylesheet antijoin, which is
 *   the only mechanism enforcing commitment 2.
 */
export const FAMILY_MOD: Readonly<Record<string, string>> = {
    turn: `${ROW_CLASS}--turn`,
    tool: `${ROW_CLASS}--tool`,
    progress: `${ROW_CLASS}--progress`,
    note: `${ROW_CLASS}--note`,
    meta: `${ROW_CLASS}--meta`,
};

/** The modifier a collapsed or expanded progress RUN carries. */
export const PROGRESS_RUN_MOD = `${ROW_CLASS}--progress-run`;

/**
 * Which record types render as which family.
 *
 * Description: the 26 record types measured in this corpus 2026-08-31
 *   collapse to five families; ANYTHING NOT LISTED renders as `meta`,
 *   which is a plain honest row rather than a crash. A 27th record type
 *   upstream must not break the reader and must not silently look like a
 *   conversation turn.
 */
export const RECORD_FAMILY: Readonly<Record<string, Family>> = {
    user: FAMILIES.TURN,
    assistant: FAMILIES.TURN,
    tool_use_summary: FAMILIES.TOOL,
    result: FAMILIES.TOOL,
    progress: FAMILIES.PROGRESS,
    summary: FAMILIES.NOTE,
    system: FAMILIES.NOTE,
    'ai-title': FAMILIES.NOTE,
    'custom-title': FAMILIES.NOTE,
    'last-prompt': FAMILIES.NOTE,
};

/**
 * Rendered when a line has neither a role nor a record type. The literal
 * words are NORMATIVE: a blank cell is a could-not-evaluate laundered
 * into whitespace, and `role` is NULL on 44.93 percent of bodies.
 */
export const NO_ROLE_TEXT = 'no role recorded';

/** Rendered in place of an absent record type, for the same reason. */
export const NO_RECORD_TYPE_TEXT = 'no record type';

/**
 * The `data-action` values the ONE delegated listener answers to.
 *
 * Description: kept as a table because the click router, the templates
 *   that emit the buttons and the tests that assert which affordances
 *   EXIST all have to agree, and a literal retyped in three places is
 *   three places to get it wrong.
 */
export const ACTIONS = {
    LOAD_MORE: 'load-more-lines',
    EXPAND: 'expand-progress',
    COLLAPSE: 'collapse-progress',
    RENDER_ANYWAY: 'render-anyway',
    DOWNLOAD_BODY: 'download-body',
    RETRY_BODY: 'retry-body',
} as const;

/** One action name. */
export type ReaderAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * The eight states a body can be in.
 *
 * Description: exported as constants so callers compare against a name
 *   rather than retyping a string literal. `CANNOT_DETERMINE` is a
 *   first-class member of the set and NOT an error flavour: "the server
 *   refused to say" is a different finding from "there is no body" and
 *   from "the body is withheld", and a reader that cannot tell the three
 *   apart will report one of them wrongly.
 *
 *   The wire spellings are byte-identical to `archive-body-gate.js`'s,
 *   because a spine row's `body_state` and a legacy consumer both still
 *   compare against them.
 */
export const BODY_STATE = {
    OK: 'included',
    GATED_SOFT: 'gated-soft',
    GATED_HARD: 'gated-hard',
    WITHHELD: 'withheld-server',
    MASK_REFUSED: 'mask-refused',
    CANNOT_DETERMINE: 'cannot-determine',
    LOADING: 'loading',
    NO_BODY: 'no-body',
} as const;

/** One body state. */
export type BodyState = (typeof BODY_STATE)[keyof typeof BODY_STATE];

/**
 * The `body_state` value the SERVER sends when it withheld a body
 * itself. Deliberately NOT one of the eight above: different alphabets
 * for different layers, exactly as `state.ts` keeps `cannot_determine`
 * (wire, underscored) apart from `cannot-determine` (token, hyphenated).
 */
export const WIRE_WITHHELD_TOO_LARGE = 'withheld_too_large';

/** `data-body-state` value for a body nobody has asked for yet. */
export const NOT_REQUESTED = 'not-requested';

/** The reader's two non-outcome states, as `state.ts` spells them. */
export const READER_IDLE = 'idle';
/** In flight. Not an outcome token. */
export const READER_LOADING = 'loading';
/** The one token that reaches the virtual list. */
export const READER_OK = 'ok';
