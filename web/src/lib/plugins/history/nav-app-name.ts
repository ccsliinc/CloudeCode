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
 * THE SOURCE IS THE WHOLE CONTRACT. `app_name_source` has five values
 * and only two of them mean a name was measured:
 *
 *   as_written          a project row's own recorded folder slugifies to
 *                       this archive slug. The strongest rung.
 *   canonical_spelling  it matched once the spelling was resolved - the
 *                       symlink case. Still exact, still measured.
 *   none                the index WAS read and nothing in it matches.
 *   ambiguous           two projects at different real directories
 *                       produce this one slug. A genuine collision.
 *   cannot_determine    the app database could not be read at all.
 *
 * THE LAST THREE ARE NOT "NO NAME", AND TREATING THEM AS ONE IS THE
 * FAILURE THIS MODULE EXISTS TO PREVENT. `none` and `cannot_determine`
 * render identically to a person and mean opposite things - "nothing
 * matched" against "nobody looked" - and `ambiguous` is the server
 * refusing to pick between two real candidates. A rail that shrugged at
 * all three and invented a name from whatever was nearest would be
 * presenting a guess in the place a measurement goes, which is the one
 * thing the server's own refusal ladder was written to stop. So a name
 * renders ONLY on the two approved rungs; everything else falls through
 * to the path the card already drew, unchanged.
 *
 * 27 OF 100 PROJECTS LEGITIMATELY DO NOT RESOLVE, measured 2026-09-18:
 * 16 temporary or scratch directories, 2 path artifacts, and 9 real
 * SUBDIRECTORIES of named projects that have no project row of their
 * own. Those cards showing a slug is the CORRECT answer and not a gap to
 * paper over.
 *
 * Pure data. No DOM, no fetch, no state.
 */
import type { NavRowData } from './nav-row';

/** The field the app's name for a project arrives under. */
export const APP_NAME_FIELD = 'app_display_name';

/** The field its provenance arrives under. */
export const APP_NAME_SOURCE_FIELD = 'app_name_source';

/** The field the app's own description arrives under. */
export const APP_DESCRIPTION_FIELD = 'app_description';

/** The field the app's own project id arrives under. */
export const APP_PROJECT_ID_FIELD = 'app_project_id';

/**
 * Every value `app_name_source` may carry. A mirror of the server's
 * `MATCH_KINDS` in `src/core/archive_display_names.py`, spelled here so
 * a test can assert the client understands the whole vocabulary rather
 * than only the half it happens to render.
 */
export const APP_NAME_SOURCES = {
    AS_WRITTEN: 'as_written',
    CANONICAL_SPELLING: 'canonical_spelling',
    NONE: 'none',
    AMBIGUOUS: 'ambiguous',
    CANNOT_DETERMINE: 'cannot_determine',
} as const;

/** One of the five values `app_name_source` may carry. */
export type AppNameSource = (typeof APP_NAME_SOURCES)[keyof typeof APP_NAME_SOURCES];

/**
 * THE ONLY TWO RUNGS ON WHICH A NAME MAY BE DRAWN. A mirror of the
 * server's `MATCH_KINDS_NAMED`. Spelled as a frozen list rather than as
 * an inline comparison so there is exactly one place to read, and so a
 * third value cannot join it without somebody editing this line.
 */
export const APP_NAME_SOURCES_NAMED: readonly string[] = Object.freeze([
    APP_NAME_SOURCES.AS_WRITTEN,
    APP_NAME_SOURCES.CANONICAL_SPELLING,
]);

/** What the refusals mean, for the card's own tooltip. */
export const APP_NAME_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
    [APP_NAME_SOURCES.NONE]:
        'No project in the app database is recorded at this folder, so the '
        + 'archive path is the only name there is for it.',
    [APP_NAME_SOURCES.AMBIGUOUS]:
        'Two or more projects in the app database resolve to this same '
        + 'folder, so which one the archive meant cannot be established. '
        + 'The path is shown rather than a guess.',
    [APP_NAME_SOURCES.CANNOT_DETERMINE]:
        'The app database could not be read, so no name was looked up. That '
        + 'is not the same as this project having no name.',
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
     * Why there is no name, when there is none and the server said why.
     * Empty string when a name WAS measured, or when the row carries no
     * source field at all (an older server, which said nothing).
     */
    readonly refusal: string;
}

/** The answer for a row that carries none of these fields at all. */
const ABSENT: AppName = Object.freeze({
    name: null, source: null, description: null,
    projectId: null, named: false, refusal: '',
});

/**
 * Is this a source on which a name may actually be drawn?
 *
 * Description: the one predicate. Everything else in this module and
 *   every caller outside it asks this rather than comparing strings, so
 *   the approved set has a single definition.
 * Inputs: source (unknown) - whatever arrived in `app_name_source`.
 * Output: boolean - true only for `as_written` and `canonical_spelling`.
 * Example: isNamedSource('ambiguous')   // -> false
 */
export function isNamedSource(source: unknown): boolean {
    return typeof source === 'string'
        && APP_NAME_SOURCES_NAMED.indexOf(source) !== -1;
}

/**
 * Resolve one project node's app-database name, with the refusal intact.
 *
 * Description: A NAME IS DRAWN ONLY WHEN THE SERVER SAID IT MEASURED
 *   ONE. Two conditions, both required: the source is one of the two
 *   approved rungs, AND the name itself is a non-empty string. The
 *   second is not belt and braces - a server that reported an approved
 *   rung with a blank name would otherwise paint an empty label where a
 *   path used to be, which reads as a bug in the rail rather than as a
 *   bug in the join. The description and the project id ride the SAME
 *   gate, because a description is a claim about a project row we just
 *   declined to name.
 * Inputs: row (NavRowData | null | undefined) - one merged project node.
 * Output: AppName - `named` false means the caller draws what it drew
 *   before this feature existed.
 * Example: appNameFor({app_display_name: 'Cloude Code',
 *            app_name_source: 'as_written'}).name   // -> 'Cloude Code'
 * Example: appNameFor({app_display_name: 'Cloude Code',
 *            app_name_source: 'ambiguous'}).name    // -> null
 */
export function appNameFor(row: NavRowData | null | undefined): AppName {
    const r = row || {};
    const rawSource = r[APP_NAME_SOURCE_FIELD];
    const source = typeof rawSource === 'string' && rawSource ? rawSource : null;
    if (source === null) return ABSENT;

    const rawName = r[APP_NAME_FIELD];
    const name = typeof rawName === 'string' && rawName.trim() ? rawName : null;
    if (!isNamedSource(source) || name === null) {
        return {
            name: null,
            source,
            description: null,
            projectId: null,
            named: false,
            refusal: APP_NAME_REFUSALS[source] || '',
        };
    }

    const rawDescription = r[APP_DESCRIPTION_FIELD];
    const rawId = r[APP_PROJECT_ID_FIELD];
    return {
        name,
        source,
        description: typeof rawDescription === 'string' && rawDescription.trim()
            ? rawDescription
            : null,
        projectId: typeof rawId === 'number' || typeof rawId === 'string'
            ? rawId
            : null,
        named: true,
        refusal: '',
    };
}

/** How each approved rung reads to a person, for the details modal. */
const NAMED_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
    [APP_NAME_SOURCES.AS_WRITTEN]:
        'the app database, matched on the folder exactly as that project '
        + 'records it.',
    [APP_NAME_SOURCES.CANONICAL_SPELLING]:
        'the app database, matched once the folder spelling was resolved. '
        + 'The project is declared at a symlink of the same directory.',
});

/**
 * One sentence saying where this project's name came from, or why there
 * is not one.
 *
 * Description: the details modal has room to say what the card's face
 *   cannot. It NEVER returns a bare word: `none` and `cannot_determine`
 *   are the pair a reader collapses, so each gets its own sentence
 *   rather than its own token.
 * Inputs: app (AppName) - what `appNameFor` resolved.
 * Output: the sentence, or '' when the server sent no source at all.
 * Example: appNameSentence(appNameFor(node))
 */
export function appNameSentence(app: AppName): string {
    if (app.source === null) return '';
    if (app.named) return NAMED_SENTENCE[app.source] || '';
    return app.refusal;
}
