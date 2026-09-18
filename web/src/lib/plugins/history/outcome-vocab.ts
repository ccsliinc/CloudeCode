/**
 * THE OUTCOME BLOCK'S VOCABULARY: the six tokens, their banner words,
 * and the action set each one ALWAYS carries.
 *
 * WHY THE ACTIONS ARE A TABLE AND NOT A RENDERING DECISION. The outcome
 * block distinguishes its six tokens on FOUR independent channels, and
 * the actions are the fourth:
 *
 *   1. TEXT      the words a person reads, including the server's own
 *                `unevaluated` reasons rendered verbatim.
 *   2. CLASS     the styling hook, `archive-outcome--<token>`.
 *   3. ATTRIBUTE `data-outcome`, the machine-readable token.
 *   4. ACTIONS   which affordances EXIST in the subtree.
 *
 * The fourth is the hardest to fake, because it is a structural fact
 * rather than a string the renderer chose. So the sets below are
 * ADDITIVE-ONLY: a call site may add view-specific actions, and can
 * never remove these, which means no view can accidentally erase the
 * structural difference between two outcomes.
 *
 * COLOUR IS NOT A CHANNEL. Neither is border-radius: three of this app's
 * 23 themes (`terminal`, `gameboy`, `legacy_apple`) zero every radius
 * token on purpose, so a meaning carried by a rounded corner is a
 * meaning those themes cannot express.
 *
 * Ported from client/js/archive-outcome-view.js. Every class name below
 * is byte-for-byte one it already emits. Pure data, no DOM, no imports.
 */

/** Root class of every outcome block. */
export const ROOT_CLASS = 'archive-outcome';

/** Every class name this feature emits, spelled once. Commitment 1. */
export const CLASS = {
    root: ROOT_CLASS,
    label: `${ROOT_CLASS}__label`,
    headline: `${ROOT_CLASS}__headline`,
    reasons: `${ROOT_CLASS}__reasons`,
    reason: `${ROOT_CLASS}__reason`,
    reasonSubject: `${ROOT_CLASS}__reason-subject`,
    reasonText: `${ROOT_CLASS}__reason-text`,
    coverage: `${ROOT_CLASS}__coverage`,
    coverageCounts: `${ROOT_CLASS}__coverage-counts`,
    coverageGap: `${ROOT_CLASS}__coverage-gap`,
    coverageCharge: `${ROOT_CLASS}__coverage-charge`,
    actions: `${ROOT_CLASS}__actions`,
    action: `${ROOT_CLASS}__action`,
    transportReason: `${ROOT_CLASS}__transport-reason`,
} as const;

/**
 * The per-token modifier class, as a LITERAL table.
 *
 * Description: never `${ROOT_CLASS}--${token}`. A computed modifier is
 *   invisible to the stylesheet antijoin, which is the only mechanism
 *   enforcing commitment 2, so a modifier with no rule anywhere would
 *   render in user-agent defaults and no test could see it. Same rule,
 *   same reason, as `reader-vocab.ts`'s `FAMILY_MOD`.
 */
export const TOKEN_MOD: Readonly<Record<string, string>> = {
    ok: `${ROOT_CLASS}--ok`,
    empty: `${ROOT_CLASS}--empty`,
    partial: `${ROOT_CLASS}--partial`,
    'cannot-determine': `${ROOT_CLASS}--cannot-determine`,
    'not-found': `${ROOT_CLASS}--not-found`,
    'transport-error': `${ROOT_CLASS}--transport-error`,
};

/**
 * Classes this block emits that match NO rule in any of the 12 archive
 * stylesheets, measured 2026-09-18.
 *
 * Description: ALL PRE-EXISTING, emitted today by
 *   `client/js/archive-outcome-view.js`. Named here rather than quietly
 *   filtered in the test so a sixth cannot join them without somebody
 *   editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    `${ROOT_CLASS}__reason`,
    `${ROOT_CLASS}__reason-text`,
    `${ROOT_CLASS}__coverage-counts`,
    `${ROOT_CLASS}__coverage-gap`,
    `${ROOT_CLASS}__coverage-charge`,
    // THE SIX TOKEN MODIFIERS, AND THIS IS A REAL MEASUREMENT RATHER
    // THAN A CONVENIENCE. `.archive-outcome--` appears ZERO times across
    // all 4,444 lines of the twelve archive stylesheets, measured
    // 2026-09-18, while `client/js/archive-outcome-view.js` has emitted
    // `ROOT_CLASS + '--' + token` since it shipped. So channel 2 - the
    // styling hook - currently hangs no rule for ANY outcome, and the
    // block is told apart on text, attribute and actions alone. That is
    // a gap in the STYLESHEETS, which commitment 2 forbids this port
    // from closing, so it is recorded here instead of being quietly
    // fixed or quietly dropped. Dropping the modifier would remove the
    // hook Adam's re-skin needs in order to close it.
    `${ROOT_CLASS}--ok`,
    `${ROOT_CLASS}--empty`,
    `${ROOT_CLASS}--partial`,
    `${ROOT_CLASS}--cannot-determine`,
    `${ROOT_CLASS}--not-found`,
    `${ROOT_CLASS}--transport-error`,
];

/**
 * The banner word for each token.
 *
 * Description: deliberately not sentence case. This is the line a
 *   person's eye lands on first, and the six must be unmistakable from
 *   across a room.
 */
export const LABELS: Readonly<Record<string, string>> = {
    ok: 'RESULTS',
    empty: 'NO MATCHES',
    partial: 'INCOMPLETE - I DID NOT FINISH LOOKING',
    'cannot-determine': 'COULD NOT EVALUATE',
    'not-found': 'NOT FOUND',
    'transport-error': 'NO ANSWER FROM THE SERVER',
};

/** One affordance the block emits. `action` becomes `data-action`. */
export interface ActionDef {
    readonly action: string;
    readonly label: string;
}

/** The action set every block of a given token ALWAYS carries. */
export const DEFAULT_ACTIONS: Readonly<Record<string, readonly ActionDef[]>> = {
    ok: [{ action: 'new-search', label: 'new search' }],
    empty: [
        { action: 'broaden-scope', label: 'search a wider scope' },
        { action: 'new-search', label: 'new search' },
    ],
    partial: [{ action: 'resume', label: 'resume the scan' }],
    'cannot-determine': [{ action: 'retry', label: 'try again' }],
    'not-found': [{ action: 'go-up', label: 'go up to the containing scope' }],
    'transport-error': [
        { action: 'retry', label: 'try again' },
        { action: 'show-details', label: 'show the raw response' },
    ],
};

/** What a block says when the server supplied no reason for an outcome. */
export const NO_REASON_SUPPLIED =
    'The server supplied no reason for this outcome. What went unmeasured is '
    + 'itself NOT KNOWN.';

/** Rendered in place of an absent reason subject. A blank cell is not an answer. */
export const UNNAMED_SUBJECT = 'unnamed subject';

/** Rendered in place of absent reason text, for the same reason. */
export const NO_REASON_TEXT = 'no reason text supplied';

/** What `describeScope` says when `meta` carried no scope at all. */
export const UNNAMED_SCOPE = 'the requested scope';

/** Why a `resume` action is disabled when the scan reported no cursor. */
export const NO_RESUME_CURSOR_REASON =
    'the server returned no resume_cursor, so this scan cannot be continued';
