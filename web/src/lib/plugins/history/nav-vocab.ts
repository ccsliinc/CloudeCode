/**
 * The navigation rail's VOCABULARY: every class name it may emit, the
 * four node kinds, and the literals the rail prints.
 *
 * THIS FILE IS THE WHOLE OF COMMITMENT 1 ("no new class names"), and it
 * is the same mechanism slice 6 used in `tlist-vocab.ts`, for the same
 * reason. Issue #173 promises Adam that his re-skin lands on top of this
 * migration rather than fighting it, and the only thing that can enforce
 * that is ONE table of literals a test can read. Every string in CLASS
 * below is a byte-for-byte copy of one already emitted by
 * `client/js/archive-nav.js`, `archive-nav-row.js`, `archive-nav-card.js`,
 * `archive-nav-merged.js`, `archive-nav-tree.js` or `archive-nav-info.js`.
 *
 * FOUR OF THESE HAVE NO STYLESHEET RULE AND THAT IS PRE-EXISTING.
 * `__level--hosts`, `__level--merged`, `__hilite` and
 * `archive-nav-info__section--machines` are emitted by the vanilla rail
 * today and match nothing in any of the 12 archive stylesheets. They are
 * kept because DROPPING one is a change to the emitted markup, which is
 * the thing this table exists to hold still, and because three of the
 * four are hooks a test or a future rule reads rather than paint. They
 * are named in `UNSTYLED_PRE_EXISTING` so the fact stays recorded rather
 * than becoming a hole the next class slips through.
 *
 * `modal-overlay` IS THE APP'S OWN CLASS AND IS NOT OURS TO RENAME.
 * `client/js/modal-stack.js` enumerates `:scope > .modal-overlay` on the
 * body to decide whether a foreign dialog has been layered over the
 * stack. A different class here would make the info modal invisible to
 * that check and let an Escape meant for a confirm dialog close this one
 * underneath it.
 *
 * NOTHING HERE IS COMPUTED. `NODE_MOD` is a literal per kind rather than
 * `'__node--' + kind`, on the same grounds slice 6 gave: a computed
 * class cannot be recovered from the source by the stylesheet antijoin,
 * so a modifier with no rule anywhere would render in user-agent
 * defaults and no test could see it.
 *
 * Pure data. No DOM, no imports, no state.
 */

/** Root element class for the rail. */
export const ROOT_CLASS = 'archive-nav';

/** Root element class for the project info modal. Its own tree. */
export const INFO_ROOT_CLASS = 'archive-nav-info';

/**
 * Node kinds this rail can render.
 *
 * `unattributed` IS A FIRST-CLASS KIND, not a flag on a corpus. It is a
 * selectable scope with its own listing endpoint, and modelling it as a
 * flag would make "no project" unrepresentable in the tree that has to
 * show it.
 */
export const NODE_KINDS = {
    HOST: 'host',
    CORPUS: 'corpus',
    PROJECT: 'project',
    UNATTRIBUTED: 'unattributed',
} as const;

/** One of the four node kinds. */
export type NodeKind = (typeof NODE_KINDS)[keyof typeof NODE_KINDS];

/** Every class name the rail emits, spelled once. */
export const CLASS = {
    root: ROOT_CLASS,
    filter: `${ROOT_CLASS}__filter`,
    filterNote: `${ROOT_CLASS}__filter-note`,
    filterEmpty: `${ROOT_CLASS}__filter-empty`,
    order: `${ROOT_CLASS}__order`,
    orderLabel: `${ROOT_CLASS}__order-label`,
    orderSelect: `${ROOT_CLASS}__order-select`,
    level: `${ROOT_CLASS}__level`,
    levelHosts: `${ROOT_CLASS}__level--hosts`,
    levelMerged: `${ROOT_CLASS}__level--merged`,
    node: `${ROOT_CLASS}__node`,
    row: `${ROOT_CLASS}__row`,
    label: `${ROOT_CLASS}__label`,
    count: `${ROOT_CLASS}__count`,
    children: `${ROOT_CLASS}__children`,
    loading: `${ROOT_CLASS}__loading`,
    note: `${ROOT_CLASS}__note`,
    noteAnswered: `${ROOT_CLASS}__note--answered`,
    hosts: `${ROOT_CLASS}__hosts`,
    hostBadge: `${ROOT_CLASS}__host-badge`,
    outcome: `${ROOT_CLASS}__outcome`,
    transportReason: `${ROOT_CLASS}__transport-reason`,
    hilite: `${ROOT_CLASS}__hilite`,
    hit: `${ROOT_CLASS}__hit`,
    card: `${ROOT_CLASS}__card`,
    cardMain: `${ROOT_CLASS}__card-main`,
    counts: `${ROOT_CLASS}__counts`,
    countSessions: `${ROOT_CLASS}__count--sessions`,
    countTotal: `${ROOT_CLASS}__count--total`,
    countValue: `${ROOT_CLASS}__count-value`,
    countNoun: `${ROOT_CLASS}__count-noun`,
    countOf: `${ROOT_CLASS}__count-of`,
    infoBtn: `${ROOT_CLASS}__info-btn`,
    when: `${ROOT_CLASS}__when`,
    whenUnknown: `${ROOT_CLASS}__when--unknown`,
    unsorted: `${ROOT_CLASS}__unsorted`,
} as const;

/** The `__node--<kind>` modifier per kind, as four literals. */
export const NODE_MOD: Readonly<Record<NodeKind, string>> = {
    [NODE_KINDS.HOST]: `${ROOT_CLASS}__node--host`,
    [NODE_KINDS.CORPUS]: `${ROOT_CLASS}__node--corpus`,
    [NODE_KINDS.PROJECT]: `${ROOT_CLASS}__node--project`,
    [NODE_KINDS.UNATTRIBUTED]: `${ROOT_CLASS}__node--unattributed`,
};

/** Every class name the project info modal emits, spelled once. */
export const INFO_CLASS = {
    root: INFO_ROOT_CLASS,
    /** The app's own overlay class. See the header: not ours to rename. */
    appOverlay: 'modal-overlay',
    overlay: `${INFO_ROOT_CLASS}__overlay`,
    head: `${INFO_ROOT_CLASS}__head`,
    title: `${INFO_ROOT_CLASS}__title`,
    close: `${INFO_ROOT_CLASS}__close`,
    body: `${INFO_ROOT_CLASS}__body`,
    section: `${INFO_ROOT_CLASS}__section`,
    sectionMachines: `${INFO_ROOT_CLASS}__section--machines`,
    sectionTitle: `${INFO_ROOT_CLASS}__section-title`,
    field: `${INFO_ROOT_CLASS}__field`,
    term: `${INFO_ROOT_CLASS}__term`,
    value: `${INFO_ROOT_CLASS}__value`,
    valueUnknown: `${INFO_ROOT_CLASS}__value--unknown`,
    lede: `${INFO_ROOT_CLASS}__lede`,
    machines: `${INFO_ROOT_CLASS}__machines`,
    machine: `${INFO_ROOT_CLASS}__machine`,
    machineLink: `${INFO_ROOT_CLASS}__machine-link`,
    machineName: `${INFO_ROOT_CLASS}__machine-name`,
    machineCount: `${INFO_ROOT_CLASS}__machine-count`,
    note: `${INFO_ROOT_CLASS}__note`,
} as const;

/**
 * The classes above that match no rule in any of the 12 archive
 * stylesheets, TODAY, before this port. Measured by substring antijoin
 * over `client/css/archive*.css` on 2026-09-16.
 *
 * Named here rather than quietly filtered in the guard test, so a fifth
 * one cannot join them without somebody editing this list.
 */
export const UNSTYLED_PRE_EXISTING: readonly string[] = [
    CLASS.levelHosts,
    CLASS.levelMerged,
    CLASS.hilite,
    INFO_CLASS.sectionMachines,
];

/**
 * The unattributed node's name. It says WHAT THESE TRANSCRIPTS ARE, not
 * merely what they lack: their source path has no `.claude/projects`
 * layer, so the slug deriver returned "none declared" rather than
 * failing to derive one. A bare count next to the word "unattributed"
 * reads as an attribution failure somebody ought to chase; this reads as
 * an answer.
 *
 * It deliberately does NOT say "audit logs". Every one of the five such
 * transcripts measured on 2026-09-02 was a local-agent sandbox audit
 * log, and that is a fact about that day's corpus, not about the
 * category. The dated measurement lives in the tooltip.
 */
export const UNATTRIBUTED_LABEL = 'transcripts with no project layer';

/** The tooltip on the unattributed node. A DATED observation. */
export const UNATTRIBUTED_TITLE =
    'Their source path has no .claude/projects layer, so no project could '
    + 'be declared for them.\nMeasured 2026-09-02: all 5 were local-agent '
    + 'sandbox audit logs (permission and decision trails), not conversations.';

/** The two views the rail can be in. `merged` is the default. */
export const VIEWS = { MERGED: 'merged', HOSTS: 'hosts' } as const;

/** One of the two views. */
export type NavView = (typeof VIEWS)[keyof typeof VIEWS];
