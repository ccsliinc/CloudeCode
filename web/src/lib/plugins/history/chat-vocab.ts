/**
 * The conversation view's VOCABULARY: every class name it may emit,
 * every `data-action` it answers to, the role labels, the block-type
 * labels and the set of block types that are collapsed by default.
 *
 * THIS FILE IS THE WHOLE OF COMMITMENT 1 ("no new class names"), and it
 * is the same mechanism slice 5's `nav-vocab.ts`, slice 6's
 * `tlist-vocab.ts` and slice 7's `reader-vocab.ts` established. Issue
 * #173 promises Adam that his re-skin lands on top of this migration
 * rather than fighting it, and the only thing that can enforce that is
 * ONE list of literals a test can read. Every string in `CLASS` below is
 * byte-for-byte a class already emitted by `client/js/archive-chat-view.js`,
 * `archive-chat-turn.js`, `archive-chat-block.js`, `archive-chat-info.js`,
 * `archive-chat-subagents.js` or `archive-chat-stack.js`.
 *
 * NOTHING HERE IS COMPUTED. The vanilla built `ROOT_CLASS + '--progress'`
 * and friends by concatenation, which a stylesheet antijoin cannot
 * recover from the source: a modifier with no rule anywhere would render
 * in user-agent defaults and no test could see it. Every modifier is a
 * literal.
 *
 * SIX BEM BLOCKS, NOT ONE. The vanilla chat view is six files, each with
 * its own `ROOT_CLASS`, and they are six blocks in `archive-chat.css`
 * too. Flattening them into one prefix would be a change to the emitted
 * markup, which is the exact thing this table exists to hold still.
 *
 * Ported from the six `client/js/archive-chat-*.js` renderers. Pure
 * data, no DOM, no imports.
 */

/** Root class of the conversation view shell. */
export const ROOT_CLASS = 'archive-chat';

/** Root class of ONE chat bubble. A different BEM block on purpose. */
export const TURN_CLASS = 'archive-chat-turn';

/** Root class of one content block inside a bubble. */
export const BLOCK_CLASS = 'archive-chat-block';

/** Root class of the envelope panel behind the "i". */
export const INFO_CLASS = 'archive-chat-info';

/** Root class of the subagent list hanging off one turn. */
export const SUBAGENTS_CLASS = 'archive-chat-subagents';

/** Root class of the drill-chain breadcrumb. */
export const CHAIN_CLASS = 'archive-chat-chain';

/**
 * Every class name this feature emits, spelled once.
 *
 * Description: the single source of truth for commitment 1. A template
 *   that needs a class reads it from here; a template wanting a class
 *   not in here is introducing a new class name, and
 *   `ChatView.commitments.test.ts` fails the build.
 */
export const CLASS = {
    root: ROOT_CLASS,
    chainSlot: `${ROOT_CLASS}__chain`,
    status: `${ROOT_CLASS}__status`,
    scroller: `${ROOT_CLASS}__scroller`,
    spacer: `${ROOT_CLASS}__spacer`,
    window: `${ROOT_CLASS}__window`,
    sentinel: `${ROOT_CLASS}__sentinel`,
    sentinelText: `${ROOT_CLASS}__sentinel-text`,
    sentinelNoPager: `${ROOT_CLASS}__sentinel-nopager`,
    pager: `${ROOT_CLASS}__pager`,

    turn: TURN_CLASS,
    turnHead: `${TURN_CLASS}__head`,
    who: `${TURN_CLASS}__who`,
    ts: `${TURN_CLASS}__ts`,
    model: `${TURN_CLASS}__model`,
    secrets: `${TURN_CLASS}__secrets`,
    toggle: `${TURN_CLASS}__toggle`,
    turnBody: `${TURN_CLASS}__body`,
    noBlocks: `${TURN_CLASS}__no-blocks`,
    progressChip: `${TURN_CLASS}__progress-chip`,

    block: BLOCK_CLASS,
    label: `${BLOCK_CLASS}__label`,
    type: `${BLOCK_CLASS}__type`,
    tool: `${BLOCK_CLASS}__tool`,
    error: `${BLOCK_CLASS}__error`,
    len: `${BLOCK_CLASS}__len`,
    bodyText: `${BLOCK_CLASS}__text`,
    withheld: `${BLOCK_CLASS}__withheld`,
    withheldHead: `${BLOCK_CLASS}__withheld-head`,
    withheldSize: `${BLOCK_CLASS}__withheld-size`,
    withheldWhy: `${BLOCK_CLASS}__withheld-why`,
    refused: `${BLOCK_CLASS}__refused`,
    refusedHead: `${BLOCK_CLASS}__refused-head`,
    refusedWhy: `${BLOCK_CLASS}__refused-why`,
    truncated: `${BLOCK_CLASS}__truncated`,
    truncatedNote: `${BLOCK_CLASS}__truncated-note`,
    disclosure: `${BLOCK_CLASS}__disclosure`,
    summary: `${BLOCK_CLASS}__summary`,

    info: INFO_CLASS,
    infoNone: `${INFO_CLASS}__none`,
    infoHead: `${INFO_CLASS}__head`,
    infoList: `${INFO_CLASS}__list`,
    infoKey: `${INFO_CLASS}__key`,
    infoValue: `${INFO_CLASS}__value`,
    infoUsage: `${INFO_CLASS}__usage`,
    infoUsageHead: `${INFO_CLASS}__usage-head`,
    infoExtra: `${INFO_CLASS}__extra`,
    infoExtraHead: `${INFO_CLASS}__extra-head`,

    subagents: SUBAGENTS_CLASS,
    subRow: `${SUBAGENTS_CLASS}__row`,
    subOpen: `${SUBAGENTS_CLASS}__open`,
    subOrdinal: `${SUBAGENTS_CLASS}__ordinal`,
    subName: `${SUBAGENTS_CLASS}__name`,
    subStarted: `${SUBAGENTS_CLASS}__started`,
    subTid: `${SUBAGENTS_CLASS}__tid`,
    subList: `${SUBAGENTS_CLASS}__list`,
    subBasis: `${SUBAGENTS_CLASS}__basis`,
    subMulti: `${SUBAGENTS_CLASS}__multi`,
    subUnlinked: `${SUBAGENTS_CLASS}__unlinked`,

    chain: CHAIN_CLASS,
    chainNone: `${CHAIN_CLASS}__none`,
    chainUp: `${CHAIN_CLASS}__up`,
    chainSep: `${CHAIN_CLASS}__sep`,
    chainHere: `${CHAIN_CLASS}__here`,
} as const;

/**
 * The two modifier classes, as LITERALS.
 *
 * Description: never `${TURN_CLASS}--${kind}`. See the file header: a
 *   computed modifier is invisible to the stylesheet antijoin, which is
 *   the only mechanism enforcing commitment 2.
 */
export const MOD = {
    /** A folded run of progress records, which is not a bubble. */
    turnProgress: `${TURN_CLASS}--progress`,
    /** The subagent panel when the server could not say what ran. */
    subagentsUnknown: `${SUBAGENTS_CLASS}--unknown`,
} as const;

/**
 * Classes this view emits that match NO rule in any of the 12 archive
 * stylesheets, measured 2026-09-18 against all 4,444 lines.
 *
 * Description: ALL TWELVE ARE PRE-EXISTING - every one is emitted today
 *   by a `client/js/archive-chat-*.js` renderer and matches nothing in
 *   `client/css/archive-chat.css` or in any sibling sheet. They are KEPT
 *   because dropping one would be a change to the emitted markup, which
 *   is the exact thing this table exists to hold still, and they are
 *   NAMED here rather than quietly filtered inside the test so a
 *   thirteenth cannot join them without somebody editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    `${BLOCK_CLASS}__len`,
    `${BLOCK_CLASS}__refused-why`,
    `${BLOCK_CLASS}__type`,
    `${BLOCK_CLASS}__withheld-size`,
    `${BLOCK_CLASS}__withheld-why`,
    `${CHAIN_CLASS}__none`,
    `${INFO_CLASS}__none`,
    `${SUBAGENTS_CLASS}--unknown`,
    `${SUBAGENTS_CLASS}__name`,
    `${SUBAGENTS_CLASS}__row`,
    `${TURN_CLASS}__body`,
    `${TURN_CLASS}__no-blocks`,
];

/**
 * The `data-action` values the ONE delegated click router answers to.
 *
 * Description: kept as a table because the router, the templates that
 *   emit the buttons and the tests that assert which affordances EXIST
 *   all have to agree, and a literal retyped in three places is three
 *   places to get it wrong.
 */
export const ACTIONS = {
    /** Toggle the envelope panel behind the "i". */
    INFO: 'toggle-turn-info',
    /** Toggle the counted subagent list on one turn. */
    SUBAGENTS: 'toggle-turn-subagents',
    /** Expand a folded run of progress records. */
    EXPAND_PROGRESS: 'expand-progress',
    /** Re-fold one. */
    COLLAPSE_PROGRESS: 'collapse-progress',
    /** Drill into one subagent transcript. */
    OPEN_SUBAGENT: 'open-subagent',
    /** Jump to one level of the drill chain. */
    CHAIN_UP: 'chain-up',
    /** Ask for a further page of turns. */
    LOAD_MORE: 'chat-load-more',
} as const;

/** One action name. */
export type ChatAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * How each role is announced.
 *
 * Description: the KEY is what the server sends; the value is what a
 *   person reads. A role not in this table is rendered under its own raw
 *   name - an unknown speaker is still a speaker, and folding it into
 *   "assistant" would attribute somebody's words to the wrong party.
 */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
    user: 'You',
    assistant: 'Claude',
    system: 'System',
    tool: 'Tool',
};

/**
 * How each block type is introduced in the label strip.
 *
 * Description: a type not in this table renders under its own raw name
 *   rather than being silently dropped: an unrecognised block is still
 *   content somebody needs to know arrived. `_string_content` is the
 *   server's name for a message whose `content` was a bare JSON string,
 *   which is by far the most common shape of a user turn, so it must not
 *   render under an internal-looking underscore name.
 */
export const TYPE_LABELS: Readonly<Record<string, string>> = {
    text: 'Text',
    _string_content: 'Text',
    thinking: 'Thinking',
    redacted_thinking: 'Thinking (redacted by the model)',
    tool_use: 'Tool call',
    tool_result: 'Tool result',
    image: 'Image',
    document: 'Document',
};

/**
 * Block types whose content is COLLAPSED behind a disclosure by default.
 *
 * Description: prose is the thing the reader came for; a tool payload
 *   and a thinking trace are the envelope around it, reachable in one
 *   click and not in the way.
 */
export const COLLAPSED_BY_DEFAULT: Readonly<Record<string, boolean>> = {
    thinking: true,
    redacted_thinking: true,
    tool_use: true,
    tool_result: true,
};

/**
 * Rendered wherever a fact was not supplied.
 *
 * Description: uppercase and unmistakable, so a scan of a panel finds
 *   the gaps. A blank cell is a could-not-evaluate laundered into
 *   whitespace.
 */
export const NOT_KNOWN = 'NOT KNOWN';

/** The view's two non-outcome states, as `state.ts` spells them. */
export const CHAT_IDLE = 'idle';
/** In flight. Not an outcome token. */
export const CHAT_LOADING = 'loading';
/** The token that reaches the virtual list with rows. */
export const CHAT_OK = 'ok';
/** The token that reaches it WITH rows and a banner beside them. */
export const CHAT_PARTIAL = 'partial';
