/**
 * Everything one project row DECIDES, with none of what it draws.
 *
 * SLICE 4. `Launchpad._projectListHtml` was 181 lines and almost none of
 * it was markup: it resolved presence twice, decided whether a row was
 * disabled, decided which of two independent badges to draw, resolved a
 * project id through a two-rung ladder and then decided whether the node
 * could fold at all. Those are RULES, and a rule buried in a template
 * literal is a rule no test can name.
 *
 * SO THE TEMPLATE READS A TYPED VIEW OBJECT AND BRANCHES ON IT. That is
 * what lets ./project-node.test.ts assert BEHAVIOUR - "an unreachable
 * project refuses its actions" - instead of asserting that some string
 * contains some class name, which is the assertion that has to be
 * rewritten every time anybody touches the CSS.
 *
 * TWO DIMENSIONS THAT ARE NOT THE SAME DIMENSION. `archived` and
 * `presence` are orthogonal: a project can be archived AND missing, and
 * the two badges say different things - "I retired this" against "the
 * folder is gone". Archiving never disables a row; an archived project
 * is still openable and its sessions were never touched. Collapsing the
 * two into one state is a bug this row has already had.
 *
 * PURE. No DOM, no store, no rune.
 */
import type { ProjectPresenceRow, ProjectRow } from '../sessions/types';
import type { TreeSessionRow } from './project-groups';

/**
 * How the filesystem answered about a project's folder.
 *
 * Description: `unchecked` is the fourth outcome and the important one -
 *   it is what a project the boot import has not reached yet reads as,
 *   and it renders exactly like a healthy row with every action allowed,
 *   because NOT YET PROBED IS NOT EVIDENCE OF ANYTHING WRONG.
 *   `missing` and `unreachable` are never rendered the same way:
 *   collapsing "your project is gone" and "I could not check" into one
 *   look is the exact bug the presence table exists to expose.
 */
export type PresenceState = 'unchecked' | 'present' | 'missing' | 'unreachable';

/** One project row, as the template reads it. */
export interface ProjectNodeView {
    /** The project itself, for the handlers that take it whole. */
    project: ProjectRow;
    /** Its index in `projects`, which the legacy click handler keyed on. */
    index: number;
    /** The name, as both a label and the handlers' key. */
    name: string;
    /** The configured path, shown under the name. */
    path: string;
    /** Trimmed description, or '' when there is none. */
    description: string;
    /** True when a description element should exist at all. */
    hasDescription: boolean;
    /** The filesystem verdict. */
    presenceState: PresenceState;
    /** The server's own reason, for `unreachable` only. May be null. */
    presenceDetail: string | null;
    /** True for `missing` and `unreachable`. EVERY action is refused. */
    isDisabled: boolean;
    /** Orthogonal to presence. Never disables anything. */
    isArchived: boolean;
    /** The resolved row id, or null when nothing can prove one. */
    projectId: number | null;
    /** This node's children, live first then ended. */
    children: TreeSessionRow[];
    /** True when there is at least one child. */
    hasChildren: boolean;
    /** The collapse key. Stable across repaints, so it keys the each block. */
    nodeKey: string;
    /** True when there is something to fold: children, a description, or both. */
    foldable: boolean;
    /** The work-recency attributes for the node itself. */
    work: WorkAttrs;
}

/**
 * The DOM attributes that make an UNRECORDED row visibly distinct
 * instead of silently last.
 *
 * Description: a row with no measured work carries
 *   `data-work="unrecorded"` (which the stylesheet targets) and a title
 *   saying so in words, so "nothing has happened here yet" never reads
 *   as "this is the stalest thing you own". Both sit at the bottom of a
 *   list ordered by work time, and without this they are
 *   indistinguishable there - which is the exact collapse the ordering
 *   change exists to undo.
 */
export interface WorkAttrs {
    /** `recorded` or `unrecorded`. Always one of the two, never absent. */
    state: 'recorded' | 'unrecorded';
    /** The ISO stamp, present only when `state` is `recorded`. */
    at: string | null;
    /**
     * The catalog key for the hover explanation, for `unrecorded` only.
     * A key rather than a sentence: this module holds no copy.
     */
    titleKey: string | null;
}

/** The unrecorded title for a PROJECT: ordered below every worked project. */
export const PROJECT_WORK_UNRECORDED_KEY = 'project.work.unrecorded';
/** The unrecorded title for a SESSION: ordered below every worked session. */
export const SESSION_WORK_UNRECORDED_KEY = 'session.work.unrecorded';

/**
 * Turn a work stamp into the attribute triple a row renders.
 *
 * Description: ONE rule with two callers, because a project and a
 *   session differ only in which sentence they hover. Writing it twice
 *   is how the two drift into disagreeing about what a null stamp means.
 *
 *   NULL IS UNRECORDED, AND UNRECORDED IS NOT "OLD". `work_at` is
 *   `MAX(sessions.last_work_at)` and is never inferred from
 *   `last_opened_at`, because opening is not working.
 * Inputs: stamp - an ISO timestamp, or null/undefined for unrecorded.
 *   titleKey - the catalog key to hover when unrecorded.
 * Output: WorkAttrs.
 * Example: workAttrs(null, PROJECT_WORK_UNRECORDED_KEY)
 *   // {state: 'unrecorded', at: null, titleKey: 'project.work.unrecorded'}
 */
export function workAttrs(
    stamp: string | null | undefined,
    titleKey: string,
): WorkAttrs {
    if (stamp) return { state: 'recorded', at: stamp, titleKey: null };
    return { state: 'unrecorded', at: null, titleKey };
}

/**
 * Resolve one project's presence row, root spelling first.
 *
 * Description: presence is indexed by BOTH raw config path and
 *   normalised root. ROOT IS TRIED FIRST because the authoritative
 *   project list is keyed by root, and two spellings of one folder must
 *   resolve to one badge - which on this owner's box, where the projects
 *   live behind a symlink into iCloud, is most of them.
 * Inputs: project - one row of `GET /projects`. presence - the map.
 * Output: ProjectPresenceRow | null.
 * Example: presenceFor(project, store.projectPresence)
 */
export function presenceFor(
    project: ProjectRow,
    presence: Map<string, ProjectPresenceRow>,
): ProjectPresenceRow | null {
    const root = typeof project.root === 'string' ? project.root : null;
    const path = typeof project.path === 'string' ? project.path : null;
    if (root && presence.has(root)) return presence.get(root) || null;
    if (path && presence.has(path)) return presence.get(path) || null;
    return null;
}

/**
 * Resolve the row id whose children belong to this project.
 *
 * Description: A TWO-RUNG LADDER, AND THE ORDER IS WHAT FIXED THE
 *   TRIPLICATION. The id now arrives ON THE PROJECT ITSELF from
 *   `GET /projects`, which reads the authoritative `projects` table. It
 *   used to be looked up in the PRESENCE map keyed by raw config path,
 *   and three config entries pointing at one directory all found the
 *   SAME presence row and therefore all drew the same two child
 *   sessions. The presence map is still consulted as a FALLBACK so a
 *   project the boot import has not reached yet still resolves.
 *
 *   NULL IS "NO CHILDREN WE CAN PROVE", NEVER ROW 0. `project.id` is
 *   null in the degraded config.json fallback, because a config entry
 *   has no row; a `|| 0` here would hand that project every session
 *   attributed to row zero.
 * Inputs: project - one row of `GET /projects`.
 *   presenceRow - its presence row, or null.
 * Output: number | null.
 * Example: resolveProjectId({id: 7}, null)  // 7
 */
export function resolveProjectId(
    project: ProjectRow,
    presenceRow: ProjectPresenceRow | null,
): number | null {
    const own = project.id;
    if (own !== null && own !== undefined) return own as number;
    if (presenceRow) {
        const fromPresence = (presenceRow as { id?: unknown }).id;
        if (fromPresence !== null && fromPresence !== undefined) {
            return fromPresence as number;
        }
    }
    return null;
}

/** What `projectNodeView` needs besides the project itself. */
export interface NodeDeps {
    presence: Map<string, ProjectPresenceRow>;
    byProjectId: Map<number, TreeSessionRow[]>;
}

/**
 * Decide everything one project row renders from.
 *
 * Description: the whole per-project half of `_projectListHtml`, as a
 *   value. See the header for why this is not a template.
 *
 *   THE SLIM ROW IS A DECISION, NOT A STYLE. A project with no
 *   description used to render the literal filler "no description": a
 *   full line of type on every row that says nothing, and on the real
 *   screen the single largest avoidable cost, because every project in
 *   the live datastore has an empty description. No description now
 *   means NO ELEMENT AT ALL, which is `hasDescription`.
 *
 *   THE COUNT CHIP IS DRAWN ONLY WHEN THERE ARE CHILDREN, because a
 *   bare "0" would be a claim about sessions that the fold is not
 *   making. The node is FOLDABLE when it has something to fold, which
 *   is children, a description, or both.
 * Inputs: project, index, deps.
 * Output: ProjectNodeView.
 * Example: projectNodeView(p, 0, {presence, byProjectId})
 */
export function projectNodeView(
    project: ProjectRow,
    index: number,
    deps: NodeDeps,
): ProjectNodeView {
    const presenceRow = presenceFor(project, deps.presence);
    const rawState = presenceRow
        ? (presenceRow as { presence?: unknown }).presence
        : undefined;
    const presenceState: PresenceState =
        rawState === 'missing' || rawState === 'unreachable' || rawState === 'present'
            ? rawState
            : 'unchecked';
    const isDisabled = presenceState === 'missing' || presenceState === 'unreachable';
    const presenceDetail = presenceRow
        ? ((presenceRow as { presence_detail?: unknown }).presence_detail as string)
            || null
        : null;

    const rawDescription = (
        typeof project.description === 'string' ? project.description : ''
    ).trim();

    const projectId = resolveProjectId(project, presenceRow);
    const children = projectId !== null
        ? (deps.byProjectId.get(projectId) || [])
        : [];
    const hasChildren = children.length > 0;
    const hasDescription = rawDescription.length > 0;
    const name = typeof project.name === 'string' ? project.name : '';

    return {
        project,
        index,
        name,
        path: typeof project.path === 'string' ? project.path : '',
        description: rawDescription,
        hasDescription,
        presenceState,
        presenceDetail,
        isDisabled,
        isArchived: !!project.archived_at,
        projectId,
        children,
        hasChildren,
        nodeKey: 'project:' + name,
        foldable: hasChildren || hasDescription,
        work: workAttrs(
            typeof project.work_at === 'string' ? project.work_at : null,
            PROJECT_WORK_UNRECORDED_KEY,
        ),
    };
}
