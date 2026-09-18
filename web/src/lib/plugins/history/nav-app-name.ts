/**
 * THE APP DATABASE'S NAME FOR A PROJECT, AND THE REFUSAL THAT GUARDS IT.
 *
 * WHAT THE SERVER SENDS AND WHY IT IS ADDITIVE. `GET /archive/projects`
 * now carries `app_display_name`, `app_description`, `app_project_id`
 * and `app_name_source` on every node, beside the fields that were
 * already there. It overwrites nothing: `display_name` is the ARCHIVE's
 * own derivation from `observed_cwd` and stays exactly what it was. The
 * new value comes from a DIFFERENT database (`cloude.db`), so it travels
 * under its own names with its own source field and a client chooses.
 *
 * THE SOURCE IS THE WHOLE CONTRACT. `app_name_source` has EIGHT values,
 * produced by two rungs, and only three of them mean a name may be
 * drawn. It is a mirror of `MATCH_KINDS` in
 * `src/core/archive_name_kinds.py`:
 *
 *   as_written          a project row's own recorded folder slugifies to
 *                       this archive slug. The strongest rung.
 *   canonical_spelling  it matched once the spelling was resolved - the
 *                       symlink case. Still exact, still measured.
 *   derived_cwd         NO project row produces this slug, so the name
 *                       was COMPOSED from the working directory the
 *                       transcripts themselves recorded. See below.
 *   none                the index WAS read and nothing in it matches.
 *   ambiguous           two projects at different real directories
 *                       produce this one slug. A genuine collision.
 *   cwd_conflict        two different real DIRECTORIES were recorded
 *                       under one slug. The cwd rung's own collision,
 *                       kept apart from `ambiguous` so a reader can tell
 *                       WHICH layer could not decide.
 *   scratch_path        the recorded directory is a per-run temp
 *                       directory, so there is no name to have.
 *   cannot_determine    the app database could not be read at all.
 *
 * THE DERIVED RUNG IS AN OPT-IN, AND THIS FILE IS WHERE THE CLIENT
 * TAKES IT. The server deliberately left its own `MATCH_KINDS_NAMED`
 * at two values, so a client that was never updated keeps rendering
 * paths for the new rungs rather than silently starting to trust a
 * DERIVED name. `MATCH_KINDS_NAMED_WITH_DERIVED` is the set a client
 * that HAS decided may use, and `APP_NAME_SOURCES_NAMED` below is this
 * client's copy of it. Measured 2026-09-18 on the real corpus: 8 of the
 * 98 archive projects resolve this way, every one of them a real
 * subdirectory of a project the app database names - `Production /
 * tools/unifi_tunnel_reset`, `.dotfiles / setup`, `Media /
 * .claude/worktrees/vibrant-leakey-ea30bb`. They are parent-qualified
 * on purpose: a bare leaf like `scripts` tells the owner nothing.
 *
 * THE OTHER FOUR REFUSALS ARE NOT "NO NAME", AND TREATING THEM AS ONE
 * IS THE FAILURE THIS MODULE EXISTS TO PREVENT. `none` and
 * `cannot_determine` render identically to a person and mean opposite
 * things - "nothing matched" against "nobody looked" - while
 * `ambiguous` and `cwd_conflict` are two different layers refusing to
 * pick between two real candidates. A rail that shrugged at all four
 * and invented a name from whatever was nearest would be presenting a
 * guess in the place a measurement goes, which is the one thing the
 * server's own refusal ladder was written to stop.
 *
 * `scratch_path` IS THE ONE OUTCOME THAT IS NEITHER. It is a MEASURED
 * namelessness: the server read a real working directory and it was a
 * per-run temp directory. So it draws no name and it does not draw a
 * path either; `nav-scratch-label.ts` holds that decision and the
 * reasoning behind it. 17 of 98 projects on this install are that.
 *
 * Pure data. No DOM, no fetch, no state.
 */
import type { NavRowData } from './nav-row';
import { scratchLabel } from './nav-scratch-label';

/** The field the app's name for a project arrives under. */
export const APP_NAME_FIELD = 'app_display_name';

/** The field its provenance arrives under. */
export const APP_NAME_SOURCE_FIELD = 'app_name_source';

/** The field the app's own description arrives under. */
export const APP_DESCRIPTION_FIELD = 'app_description';

/** The field the app's own project id arrives under. */
export const APP_PROJECT_ID_FIELD = 'app_project_id';

/** How the cwd rung recognised a slug. Null on every other rung. */
export const APP_NAME_EVIDENCE_FIELD = 'app_name_evidence';

/** The working directory the transcripts recorded. Null on most rows. */
export const APP_NAME_CWD_FIELD = 'app_name_cwd';

/**
 * The project a DERIVED name hangs under. Its own field because
 * `app_project_id` means "this slug IS project N" while this one means
 * "this slug is INSIDE project N", and a client that navigated on the
 * first meaning would open the wrong project for every derived row.
 */
export const APP_NAME_ANCHOR_FIELD = 'app_name_anchor_project_id';

/**
 * Every value `app_name_source` may carry. A mirror of the server's
 * `MATCH_KINDS` in `src/core/archive_name_kinds.py`, spelled here so
 * a test can assert the client understands the whole vocabulary rather
 * than only the half it happens to render.
 */
export const APP_NAME_SOURCES = {
    AS_WRITTEN: 'as_written',
    CANONICAL_SPELLING: 'canonical_spelling',
    DERIVED_CWD: 'derived_cwd',
    NONE: 'none',
    AMBIGUOUS: 'ambiguous',
    CWD_CONFLICT: 'cwd_conflict',
    SCRATCH_PATH: 'scratch_path',
    CANNOT_DETERMINE: 'cannot_determine',
} as const;

/** One of the eight values `app_name_source` may carry. */
export type AppNameSource = (typeof APP_NAME_SOURCES)[keyof typeof APP_NAME_SOURCES];

/** How the cwd rung recognised a slug, when it did. */
export const APP_NAME_EVIDENCE = {
    PATH_MATCH: 'cwd_path_match',
    LEAF_MATCH: 'cwd_leaf_match',
} as const;

/**
 * THE ONLY THREE RUNGS ON WHICH A NAME MAY BE DRAWN. This client's copy
 * of the server's `MATCH_KINDS_NAMED_WITH_DERIVED`, which is the opt-in
 * set - NOT `MATCH_KINDS_NAMED`, which the server holds at two values
 * for clients that have not decided. Spelled as a frozen list rather
 * than as an inline comparison so there is exactly one place to read,
 * and so a fourth value cannot join it without somebody editing this
 * line.
 */
export const APP_NAME_SOURCES_NAMED: readonly string[] = Object.freeze([
    APP_NAME_SOURCES.AS_WRITTEN,
    APP_NAME_SOURCES.CANONICAL_SPELLING,
    APP_NAME_SOURCES.DERIVED_CWD,
]);

/** What the refusals mean, for the card's own tooltip. */
export const APP_NAME_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
    [APP_NAME_SOURCES.NONE]:
        'No project in the app database is recorded at this folder, and the '
        + 'archive holds no working directory that could name it, so the '
        + 'archive path is the only name there is for it.',
    [APP_NAME_SOURCES.AMBIGUOUS]:
        'Two or more projects in the app database resolve to this same '
        + 'folder, so which one the archive meant cannot be established. '
        + 'The path is shown rather than a guess.',
    [APP_NAME_SOURCES.CWD_CONFLICT]:
        'The transcripts filed under this slug recorded two or more '
        + 'different real directories, so which folder it names cannot be '
        + 'established. The path is shown rather than a guess.',
    [APP_NAME_SOURCES.CANNOT_DETERMINE]:
        'The app database could not be read, so no name was looked up. That '
        + 'is not the same as this project having no name.',
    [APP_NAME_SOURCES.SCRATCH_PATH]:
        'The working directory recorded for this work is a per-run '
        + 'temporary directory, so there is no project name to have.',
});

/** The app database's answer for one project, after the refusal. */
export interface AppName {
    /**
     * The name to draw. NON-NULL ONLY on an approved source, so a caller
     * that renders `name ?? something` cannot accidentally draw a value
     * from a rung that refused.
     */
    readonly name: string | null;
    /** `app_name_source` verbatim, or null when the field is absent. */
    readonly source: string | null;
    /** The app's own description, gated behind the same approval. */
    readonly description: string | null;
    /** The app's own project id, gated behind the same approval. */
    readonly projectId: number | string | null;
    /** True only when a name was measured and may be drawn. */
    readonly named: boolean;
    /**
     * True only on `scratch_path`: the server MEASURED a per-run temp
     * directory. Never true at the same time as `named`, because a
     * throwaway directory has no name to be drawn.
     */
    readonly scratch: boolean;
    /**
     * `cwd_path_match` or `cwd_leaf_match` on a derived name, null
     * everywhere else. It is provenance, not a name, so it is NOT gated
     * behind the approval - a reader is entitled to know how a row was
     * recognised even when the answer was a refusal.
     */
    readonly evidence: string | null;
    /**
     * The working directory the transcripts recorded, when the cwd rung
     * read one. Ungated for the same reason as `evidence`, and it is
     * what keeps a scratch row's real path reachable.
     */
    readonly cwd: string | null;
    /** The project a DERIVED name hangs under. Gated with the name. */
    readonly anchorProjectId: number | string | null;
    /**
     * Why there is no name, when there is none and the server said why.
     * Empty string when a name WAS measured, or when the row carries no
     * source field at all (an older server, which said nothing).
     */
    readonly refusal: string;
}

/** The answer for a row that carries none of these fields at all. */
const ABSENT: AppName = Object.freeze({
    name: null, source: null, description: null,
    projectId: null, named: false, scratch: false,
    evidence: null, cwd: null, anchorProjectId: null, refusal: '',
});

/** A non-empty string, or null. The one place that judgement is spelled. */
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Is this a source on which a name may actually be drawn?
 *
 * Description: the one predicate. Everything else in this module and
 *   every caller outside it asks this rather than comparing strings, so
 *   the approved set has a single definition.
 * Inputs: source (unknown) - whatever arrived in `app_name_source`.
 * Output: boolean - true for `as_written`, `canonical_spelling` and
 *   `derived_cwd`, false for every other value including ones this
 *   client has never heard of.
 * Example: isNamedSource('ambiguous')   // -> false
 */
export function isNamedSource(source: unknown): boolean {
    return typeof source === 'string'
        && APP_NAME_SOURCES_NAMED.indexOf(source) !== -1;
}

/**
 * Is this the MEASURED namelessness of a per-run temp directory?
 *
 * Description: kept apart from `isNamedSource` because the two lead to
 *   different presentations and neither is the other's negation - a
 *   scratch row draws neither a name nor a path. Exactly one value
 *   answers true, and it is spelled once here.
 * Inputs: source (unknown) - whatever arrived in `app_name_source`.
 * Output: boolean.
 * Example: isScratchSource('scratch_path')   // -> true
 */
export function isScratchSource(source: unknown): boolean {
    return source === APP_NAME_SOURCES.SCRATCH_PATH;
}

/**
 * Resolve one project node's app-database name, with the refusal intact.
 *
 * Description: A NAME IS DRAWN ONLY WHEN THE SERVER SAID IT MEASURED
 *   ONE. Two conditions, both required: the source is one of the three
 *   approved rungs, AND the name itself is a non-empty string. The
 *   second is not belt and braces - a server that reported an approved
 *   rung with a blank name would otherwise paint an empty label where a
 *   path used to be, which reads as a bug in the rail rather than as a
 *   bug in the join. The description, the project id and the anchor
 *   ride the SAME gate, because each is a claim about a project row we
 *   just declined to name.
 *
 *   THE EVIDENCE AND THE cwd DO NOT RIDE IT, and that asymmetry is
 *   deliberate. They are provenance about the LOOKUP rather than
 *   content borrowed from a project row, and a refused row is exactly
 *   where a reader most wants them: a `cwd_conflict` card can say which
 *   directories collided, and a `scratch_path` card keeps its real path
 *   reachable on hover while its face says `scratch / <leaf>`.
 * Inputs: row (NavRowData | null | undefined) - one merged project node.
 * Output: AppName - `named` false means the caller draws what it drew
 *   before this feature existed, unless `scratch` is true.
 * Example: appNameFor({app_display_name: 'Cloude Code',
 *            app_name_source: 'as_written'}).name   // -> 'Cloude Code'
 * Example: appNameFor({app_display_name: 'Cloude Code',
 *            app_name_source: 'ambiguous'}).name    // -> null
 */
export function appNameFor(row: NavRowData | null | undefined): AppName {
    const r = row || {};
    const source = text(r[APP_NAME_SOURCE_FIELD]);
    if (source === null) return ABSENT;

    const evidence = text(r[APP_NAME_EVIDENCE_FIELD]);
    const cwd = text(r[APP_NAME_CWD_FIELD]);
    const name = text(r[APP_NAME_FIELD]);
    if (!isNamedSource(source) || name === null) {
        return {
            name: null,
            source,
            description: null,
            projectId: null,
            named: false,
            scratch: isScratchSource(source),
            evidence,
            cwd,
            anchorProjectId: null,
            refusal: APP_NAME_REFUSALS[source] || '',
        };
    }

    const rawId = r[APP_PROJECT_ID_FIELD];
    const rawAnchor = r[APP_NAME_ANCHOR_FIELD];
    return {
        name,
        source,
        description: text(r[APP_DESCRIPTION_FIELD]),
        projectId: typeof rawId === 'number' || typeof rawId === 'string'
            ? rawId
            : null,
        named: true,
        scratch: false,
        evidence,
        cwd,
        anchorProjectId: typeof rawAnchor === 'number' || typeof rawAnchor === 'string'
            ? rawAnchor
            : null,
        refusal: '',
    };
}

/**
 * The face a scratch row shows, or null when this is not one.
 *
 * Description: the one place the card asks "is this throwaway, and what
 *   does it say". Returns null rather than an empty string so a caller
 *   cannot fall into drawing a blank label, and it is derived from the
 *   MEASURED cwd only - a row the server called scratch while sending
 *   no directory still gets the bare qualifier rather than a path.
 * Inputs: app (AppName) - what `appNameFor` resolved.
 * Output: string | null.
 * Example: scratchFaceFor(appNameFor(node))   // -> 'scratch / permprobe'
 */
export function scratchFaceFor(app: AppName): string | null {
    return app.scratch ? scratchLabel(app.cwd) : null;
}

/** How each approved rung reads to a person, for the details modal. */
const NAMED_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
    [APP_NAME_SOURCES.AS_WRITTEN]:
        'the app database, matched on the folder exactly as that project '
        + 'records it.',
    [APP_NAME_SOURCES.CANONICAL_SPELLING]:
        'the app database, matched once the folder spelling was resolved. '
        + 'The project is declared at a symlink of the same directory.',
    [APP_NAME_SOURCES.DERIVED_CWD]:
        'the working directory the transcripts themselves recorded. No '
        + 'project in the app database is declared at this folder, so the '
        + 'name is composed from the nearest project that contains it and '
        + 'the real path below it. It is derived, not recorded.',
});

/**
 * One sentence saying where this project's name came from, or why there
 * is not one.
 *
 * Description: the details modal has room to say what the card's face
 *   cannot. It NEVER returns a bare word: `none` and `cannot_determine`
 *   are the pair a reader collapses, so each gets its own sentence
 *   rather than its own token, and `ambiguous` and `cwd_conflict` are
 *   the same trap one rung down. A DERIVED name says out loud that it
 *   was derived, because the whole cost of opting in to that rung is
 *   that the face stops distinguishing a composed name from a recorded
 *   one and this field has to.
 * Inputs: app (AppName) - what `appNameFor` resolved.
 * Output: the sentence, or '' when the server sent no source at all.
 * Example: appNameSentence(appNameFor(node))
 */
export function appNameSentence(app: AppName): string {
    if (app.source === null) return '';
    if (app.named) return NAMED_SENTENCE[app.source] || '';
    return app.refusal;
}
