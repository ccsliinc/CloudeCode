/**
 * WHAT A BREADCRUMB SEGMENT SAYS. PORTED from `client/js/archive-crumb.js`,
 * which is deleted in the same commit. The vocabulary only - building the
 * PATH and rendering the nodes stay in `./route.ts`, beside the route
 * patterns.
 *
 * NO NUMERIC ID EVER REACHES A CRUMB. The screen used to render
 * `ARCHIVE > project 48 > transcript 5767`, which names two database
 * primary keys and nothing a person recognises. Worse, it reads like
 * information: somebody looking at it has no way to tell that the row
 * they clicked had a perfectly good name the crumb declined to use.
 * `hasNumericId` exists so a test can assert the absence rather than
 * trusting that nobody reintroduces one.
 *
 * THREE OUTCOMES PER SEGMENT, AND THE MIDDLE ONE IS THE INTERESTING ONE.
 * A segment is either
 *   - a NAME - `display_name` for a project, `title` for a session;
 *   - a REFERENCE standing in for a name, when no name exists but
 *     something file-derived does (a project's `full_path` slug, a
 *     session's `session_ref`). It is labelled as such rather than
 *     presented as a name;
 *   - NOT KNOWN, when the fact simply has not arrived. This is a real
 *     state and not a rare one: a deep link paints its crumb before the
 *     header request resolves, so for a beat the app genuinely does not
 *     know what it is showing. It says so, and is repainted when the
 *     answer lands. Filling that beat with `transcript 5767` was the old
 *     behaviour and it is the false-green shape - an unknown rendered as
 *     a fact.
 *
 * `session_ref` IS NOT AN IDENTITY and never becomes one here: it is
 * display text only. Measured, `journal` names 14 different transcripts.
 * The route stays keyed on `transcript_id`, which is exactly why the id
 * must not ALSO be the label - the label is free to be the readable
 * thing precisely because the URL is carrying the identity.
 *
 * Pure. No DOM, no fetch, no globals.
 */
import type { ArchiveRoute } from './route';

/**
 * What a segment renders when the fact has not arrived. Spelled once,
 * and deliberately not a blank: an empty crumb slot is indistinguishable
 * from a screen with no location at all.
 */
export const PROJECT_UNKNOWN = 'project NOT NAMED YET';

/** The same, for a transcript. */
export const SESSION_UNKNOWN = 'session NOT NAMED YET';

/**
 * Marks a segment whose text is a file-derived reference rather than a
 * name anybody chose.
 */
export const REF_PREFIX = 'ref ';

/** Which of the three a segment turned out to be. */
export type SegmentKind = 'name' | 'ref' | 'unknown';

/** One crumb segment: what it says, and what kind of fact that is. */
export interface CrumbSegment {
    readonly text: string;
    readonly kind: SegmentKind;
}

/** A nav project node, as much of it as the crumb reads. */
export interface ProjectNode {
    project_id?: number | null;
    display_name?: string | null;
    full_path?: string | null;
    members?: readonly ProjectNode[] | null;
}

/** A transcript list row or header, as much of it as the crumb reads. */
export interface TranscriptRow {
    title?: string | null;
    session_ref?: string | null;
}

/**
 * The crumb segment for a project.
 * Inputs: node - a nav project node, or null when the rail has not
 *   supplied one yet. Reads `display_name` (the folder name alone) and
 *   falls back to `full_path` (the original slug).
 * Output: CrumbSegment.
 * Example: projectSegment({display_name: 'Infrastructure'})
 *          // -> {text: 'Infrastructure', kind: 'name'}
 */
export function projectSegment(node: ProjectNode | null | undefined): CrumbSegment {
    const n = node || {};
    if (typeof n.display_name === 'string' && n.display_name.length > 0) {
        return { text: n.display_name, kind: 'name' };
    }
    if (typeof n.full_path === 'string' && n.full_path.length > 0) {
        // The slug IS the only thing known about this project, so it is
        // shown - labelled, so it does not read as a chosen name.
        return { text: REF_PREFIX + n.full_path, kind: 'ref' };
    }
    return { text: PROJECT_UNKNOWN, kind: 'unknown' };
}

/**
 * The crumb segment for a transcript.
 * Inputs: row - a transcript list row or a transcript header result, or
 *   null before either has arrived.
 * Output: CrumbSegment.
 * Example: sessionSegment({session_ref: 'journal'})
 *          // -> {text: 'ref journal', kind: 'ref'}
 */
export function sessionSegment(row: TranscriptRow | null | undefined): CrumbSegment {
    const r = row || {};
    if (typeof r.title === 'string' && r.title.length > 0) {
        return { text: r.title, kind: 'name' };
    }
    if (typeof r.session_ref === 'string' && r.session_ref.length > 0) {
        return { text: REF_PREFIX + r.session_ref, kind: 'ref' };
    }
    return { text: SESSION_UNKNOWN, kind: 'unknown' };
}

/** Whatever has been learned about the project and transcript in view. */
export interface CrumbFacts {
    project?: ProjectNode | null;
    transcript?: TranscriptRow | null;
}

/**
 * The whole crumb tail for a route, in order, given whatever facts have
 * arrived.
 *
 * Description: the ROOT label is added by `route.renderCrumb`; this
 *   returns only what follows it.
 * Inputs: route - {view, projectId, transcriptId}. facts - the nav node
 *   and the row/header, either of which may be absent.
 * Output: segment texts, none of which is a bare id.
 * Example: labels({view: 'transcript', projectId: 8, transcriptId: 5},
 *                 {project: {display_name: 'Infra'}, transcript: null})
 *          // -> ['Infra', 'session NOT NAMED YET']
 */
export function labels(
    route: Partial<ArchiveRoute> | null | undefined,
    facts: CrumbFacts | null | undefined,
): string[] {
    const r = route || {};
    const f = facts || {};
    const out: string[] = [];
    const hasProject = r.projectId !== null && r.projectId !== undefined;
    const hasTranscript = r.transcriptId !== null && r.transcriptId !== undefined;
    if (hasProject) out.push(projectSegment(f.project).text);
    if (hasTranscript) {
        // A transcript reached by a direct link has no project in the
        // route at all. Saying so is a fact; silently rendering a
        // one-segment path implies the transcript has no project.
        if (!hasProject) out.push('project NOT KNOWN from this link');
        out.push(sessionSegment(f.transcript).text);
    }
    return out;
}

/**
 * Does any segment render a bare numeric id?
 *
 * Description: exists so the absence can be ASSERTED rather than
 *   assumed - the defect this module replaces produced perfectly
 *   plausible output, so nothing about a crumb's appearance would reveal
 *   a regression.
 * Inputs: parts. Output: true if any segment is `<word> <digits>` or is
 *   itself only digits.
 * Example: hasNumericId(['project 48'])  // -> true
 */
export function hasNumericId(parts: readonly string[] | null | undefined): boolean {
    const list = Array.isArray(parts) ? parts : [];
    for (const part of list) {
        if (/(^|\s)\d+\s*$/.test(String(part))) return true;
    }
    return false;
}

/** What a tracker offers: learn a fact, read back the ones that apply. */
export interface CrumbTracker {
    learnProject(id: number | string | null, node: ProjectNode | null): void;
    learnTranscript(id: number | string | null, row: TranscriptRow | null): void;
    facts(route: Partial<ArchiveRoute> | null): CrumbFacts;
    labelsFor(route: Partial<ArchiveRoute> | null): string[];
}

/**
 * Remember what has been learned about the project and the transcript
 * currently open, so a crumb can be repainted the moment a fact arrives.
 *
 * Description: IT IS KEYED, AND THAT IS THE WHOLE POINT. A fact is
 *   stored against the id it describes, and read back only for the id
 *   the route names. Storing "the last row clicked" instead would render
 *   the PREVIOUS session's name over the current one for as long as the
 *   header request took - a wrong name, which is worse than the numeric
 *   id it replaced, because a wrong name is believable.
 *
 *   It holds ONE entry per kind rather than a growing cache: the crumb
 *   only ever describes what is open now, so a cache would be an
 *   unbounded map serving a question that is never asked about anything
 *   else.
 * Inputs: none. Output: CrumbTracker.
 * Example: const t = createTracker();
 *          t.learnProject(8, {display_name: 'Infra'});
 *          t.labelsFor({view: 'project', projectId: 8});
 */
export function createTracker(): CrumbTracker {
    let project: { id: number | string | null; node: ProjectNode | null } =
        { id: null, node: null };
    let transcript: { id: number | string | null; row: TranscriptRow | null } =
        { id: null, row: null };

    function learnProject(id: number | string | null, node: ProjectNode | null): void {
        if (id === null || id === undefined || !node) return;
        project = { id, node };
    }

    function learnTranscript(id: number | string | null, row: TranscriptRow | null): void {
        if (id === null || id === undefined || !row) return;
        transcript = { id, row };
    }

    /** The facts that describe THIS route, and no others. */
    function facts(route: Partial<ArchiveRoute> | null): CrumbFacts {
        const r = route || {};
        return {
            project: project.id === r.projectId ? project.node : null,
            transcript: transcript.id === r.transcriptId ? transcript.row : null,
        };
    }

    return {
        learnProject,
        learnTranscript,
        facts,
        labelsFor: (route) => labels(route, facts(route)),
    };
}

/**
 * Map EVERY project id a merged node answers for onto that node, so a
 * deep link can be named without a rail click.
 *
 * Description: IT INDEXES THE MEMBERS, NOT JUST THE NODE. A merged node
 *   carries `project_id` for its FIRST member only, because the merge
 *   folds one node per distinct `observed_cwd` and has to pick a
 *   representative for the existing per-project route. Measured on the
 *   live corpus 2026-09-01: 80 project rows merge to 77 nodes, so 3 real
 *   project ids belong to a node that does not carry them at the top
 *   level - exactly the 3 projects that exist on both machines. Indexing
 *   only `node.project_id` would leave a deep link to any of those 3
 *   rendering NOT NAMED YET forever, and it would do so for the three
 *   projects most likely to be shared, which is the worst possible
 *   sample to be wrong about.
 * Inputs: nodes - merged project nodes.
 * Output: String(project_id) -> node. Empty when nodes is not an array,
 *   which keeps a caller's lookup a miss rather than a throw.
 * Example: indexNodes([{project_id: 4, members: [{project_id: 9}]}])
 *          // -> {'4': node, '9': the SAME node}
 */
export function indexNodes(
    nodes: readonly ProjectNode[] | null | undefined,
): Record<string, ProjectNode> {
    const list = Array.isArray(nodes) ? nodes : [];
    const out: Record<string, ProjectNode> = {};
    for (const node of list) {
        if (!node) continue;
        if (node.project_id !== null && node.project_id !== undefined) {
            out[String(node.project_id)] = node;
        }
        const members = Array.isArray(node.members) ? node.members : [];
        for (const m of members) {
            if (m && m.project_id !== null && m.project_id !== undefined) {
                out[String(m.project_id)] = node;
            }
        }
    }
    return out;
}
