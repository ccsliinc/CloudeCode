/**
 * The transcript list's VOCABULARY: every class name it may emit, the
 * three scheme filters, the title-source table and the fuzzy columns.
 *
 * THIS FILE IS THE WHOLE OF COMMITMENT 1 ("no new class names"), AND
 * THAT IS WHY IT EXISTS SEPARATELY. Issue #173 promises Adam that his
 * re-skin lands on top of this migration rather than fighting it, and
 * the only mechanism that can enforce that is one list of literals that
 * a test can read. `tests/test_archive_tlist_styled.node.mjs` already
 * antijoins the vanilla renderers against the stylesheets; the Svelte
 * port keeps that property by keeping its class names in one readable
 * table instead of scattering them through templates. Every string in
 * CLASS below is a byte-for-byte copy of one already emitted by
 * `client/js/archive-tlist-row.js` or `client/js/archive-tlist-filter.js`.
 *
 * NOTHING HERE IS COMPUTED. The vanilla row renderer already refused to
 * build `'__source--' + kind`, on the grounds that a computed class
 * cannot be recovered from the source by the stylesheet antijoin, so a
 * modifier with no rule anywhere would render in user-agent defaults
 * and no test could see it. That reasoning survives the port intact and
 * is why `TITLE_SOURCES[k].mod` is a literal.
 *
 * Ported from client/js/archive-tlist-row.js and
 * client/js/archive-tlist-filter.js. Pure data, no DOM, no imports.
 */

/** Root element class. Every other class below is derived from it. */
export const ROOT_CLASS = 'archive-tlist';

/** Rows requested per page. The server's own default is 50. */
export const PAGE_SIZE = 50;

/**
 * Every class name this feature emits, spelled once.
 *
 * Description: the single source of truth for commitment 1. A template
 *   that needs a class reads it from here; a template that wants a
 *   class not in here is introducing a new class name and the guard
 *   test fails the build.
 *
 *   `schemeOption` HAS NO STYLESHEET RULE AND THAT IS PRE-EXISTING.
 *   `.archive-tlist__scheme-option` is emitted by the vanilla filter
 *   header and matches nothing in any of the 12 archive stylesheets.
 *   It is kept because a browser gives an `<option>` almost no styling
 *   anyway and because DROPPING it would be a change to the emitted
 *   markup, which is the thing this table exists to hold still.
 */
export const CLASS = {
    root: ROOT_CLASS,
    header: `${ROOT_CLASS}__header`,
    splitNote: `${ROOT_CLASS}__split-note`,
    rows: `${ROOT_CLASS}__rows`,
    footer: `${ROOT_CLASS}__footer`,
    row: `${ROOT_CLASS}__row`,
    open: `${ROOT_CLASS}__open`,
    title: `${ROOT_CLASS}__title`,
    source: `${ROOT_CLASS}__source`,
    ref: `${ROOT_CLASS}__ref`,
    id: `${ROOT_CLASS}__id`,
    lines: `${ROOT_CLASS}__lines`,
    bytes: `${ROOT_CLASS}__bytes`,
    ingested: `${ROOT_CLASS}__ingested`,
    badge: `${ROOT_CLASS}__badge`,
    badgeNoProject: `${ROOT_CLASS}__badge--no-project`,
    badgeHostUnknown: `${ROOT_CLASS}__badge--host-unknown`,
    hit: `${ROOT_CLASS}__hit`,
    more: `${ROOT_CLASS}__more`,
    end: `${ROOT_CLASS}__end`,
    endUnknown: `${ROOT_CLASS}__end--unknown`,
    loading: `${ROOT_CLASS}__loading`,
    transportReason: `${ROOT_CLASS}__transport-reason`,
    filters: `${ROOT_CLASS}__filters`,
    schemeBox: `${ROOT_CLASS}__scheme-box`,
    schemeLabel: `${ROOT_CLASS}__scheme-label`,
    scheme: `${ROOT_CLASS}__scheme`,
    schemeOption: `${ROOT_CLASS}__scheme-option`,
    fuzzy: `${ROOT_CLASS}__fuzzy`,
    fuzzyInput: `${ROOT_CLASS}__fuzzy-input`,
    fuzzyNote: `${ROOT_CLASS}__fuzzy-note`,
} as const;

/** The three scheme filters this list offers. */
export const SCHEME_FILTERS = {
    ALL: 'all',
    CONVERSATIONS: 'uuid',
    SIDECHAINS: 'agent',
} as const;

/**
 * THE DEFAULT IS THE OWNER'S OWN SESSIONS, NOT EVERYTHING.
 *
 * Measured on the live corpus 2026-08-31: 19,588 of 21,039 transcripts
 * (93.1 percent) are `agent`-scheme sidechain FILES written by
 * subagents, and only 1,451 are `uuid`-scheme top-level sessions.
 * Defaulting to `all` opened this list on 93 percent noise and buried
 * the 7 percent anybody was looking for. `all` stays one click away and
 * is still the only view that hides nothing.
 */
export const DEFAULT_SCHEME: string = SCHEME_FILTERS.CONVERSATIONS;

/** One row of the scheme table: its wire value, its label and its hint. */
export interface SchemeDef {
    readonly v: string;
    readonly label: string;
    readonly hint: string;
}

/**
 * The three filters in the order the options are drawn AND the order
 * `t` cycles through them. One table, so the control order and the
 * keyboard order cannot drift into disagreeing.
 */
export const SCHEME_DEFS: readonly SchemeDef[] = [
    {
        v: SCHEME_FILTERS.ALL,
        label: 'Everything',
        hint: 'Every transcript in this project, sessions and agent '
            + 'sidechains together. The only view that hides nothing.',
    },
    {
        v: SCHEME_FILTERS.CONVERSATIONS,
        label: 'My sessions',
        hint: 'Top-level sessions (session_ref_scheme = uuid), named or '
            + 'not. About 7 percent of the corpus; the default.',
    },
    {
        v: SCHEME_FILTERS.SIDECHAINS,
        label: 'Agent sidechains',
        hint: 'Transcript files written by subagents '
            + '(session_ref_scheme = agent). About 93 percent of the corpus.',
    },
];

/** How one `title_source` value renders, and what it means. */
export interface TitleSourceDef {
    readonly label: string;
    readonly kind: string;
    readonly mod: string;
    readonly hint: string;
}

/**
 * What each `title_source` means, and how it must LOOK.
 *
 * A HUMAN-CHOSEN NAME AND A MACHINE GUESS MUST NOT RENDER ALIKE.
 * `custom-title` is a name somebody typed; `last-prompt` is an excerpt
 * the ingest lifted off the session's last prompt, frequently a
 * fragment and sometimes actively misleading. Showing both as plain
 * bold text would present a guess with the authority of a name.
 *
 * A TABLE, NOT A COMPARISON: a `title_source` this client has never
 * heard of classifies as NOT KNOWN rather than defaulting into
 * whichever branch an if-chain happened to end on.
 */
export const TITLE_SOURCES: Readonly<Record<string, TitleSourceDef>> = {
    'custom-title': {
        label: 'NAMED',
        kind: 'human',
        mod: `${ROOT_CLASS}__source--human`,
        hint: 'A name a person chose for this session. Nothing outranks it.',
    },
    'ai-title': {
        label: 'AI-NAMED',
        kind: 'derived',
        mod: `${ROOT_CLASS}__source--derived`,
        hint: 'Generated, but generated ABOUT the session as a whole, and '
            + 'stable. Not a name anybody chose.',
    },
    summary: {
        label: 'FROM SUMMARY',
        kind: 'derived',
        mod: `${ROOT_CLASS}__source--derived`,
        hint: 'Generated to describe the session, but written for '
            + 'compaction rather than for naming.',
    },
    'last-prompt': {
        label: 'LAST PROMPT, NOT A NAME',
        kind: 'weak',
        mod: `${ROOT_CLASS}__source--weak`,
        hint: 'NOT a title. It is the text of the last thing typed in this '
            + 'session - measured values include "yes" and "exirt". Shown '
            + 'only because a bad name beats a UUID.',
    },
    cannot_determine: {
        label: 'NAME LOOKUP FAILED',
        kind: 'cannot-determine',
        mod: `${ROOT_CLASS}__source--cannot-determine`,
        hint: 'The server could not read this session’s title records. '
            + 'This is NOT the same as the session having no name - nobody '
            + 'has established either way.',
    },
};

/**
 * How an ABSENT title_source renders. Distinct from an unrecognised
 * one: "there is no name" is a measurement, "I do not know what
 * produced this name" is not.
 */
export const TITLE_SOURCE_NONE: TitleSourceDef = {
    label: 'NOT NAMED',
    kind: 'none',
    mod: `${ROOT_CLASS}__source--none`,
    hint: 'This session has no title from any source. The reference below '
        + 'is shown in its place; it is not a name.',
};

/** How an UNRECOGNISED title_source renders. */
export const TITLE_SOURCE_UNKNOWN: TitleSourceDef = {
    label: 'NAME SOURCE NOT KNOWN',
    kind: 'cannot-determine',
    mod: `${ROOT_CLASS}__source--cannot-determine`,
    hint: 'A title was supplied but this client cannot tell what produced '
        + 'it, so it cannot say whether it is a chosen name or a derived '
        + 'guess.',
};

/**
 * Attribution values that mean "not established". A LIST rather than a
 * comparison, so a new server value cannot silently classify itself as
 * established.
 */
export const UNESTABLISHED_ATTRIBUTION: readonly string[] = [
    'cannot_determine',
    'unknown',
];

/** One fuzzy-filterable column. */
export interface FuzzyColumn {
    readonly key: string;
    readonly label: string;
    readonly placeholder: string;
}

/**
 * The three fuzzy columns, in the order they are drawn. `key` is the
 * name a caller reads a row's value by; nothing here knows the row
 * shape beyond passing this string back.
 */
export const COLUMNS: readonly FuzzyColumn[] = [
    { key: 'title', label: 'Name', placeholder: 'filter by name' },
    { key: 'ref', label: 'Ref', placeholder: 'filter by ref' },
    { key: 'date', label: 'Date', placeholder: 'filter by date' },
];
