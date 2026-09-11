/**
 * The two menus that start something, and the clone flow one of them
 * routes into.
 *
 * PORTED FROM `Launchpad.startNewClaudeProject`,
 * `startSessionInExistingProject` and `showCloneFromGithubModal`, deleted
 * in the same commit.
 *
 * "NEW CLAUDE PROJECT" HOLDS NO LAUNCH LOGIC OF ITS OWN. Its three
 * options differ only in where the folder comes from - made fresh, cloned
 * from a remote, or already on disk - and each routes straight into the
 * flow that already implements it. There is nothing here to drift.
 *
 * "NEW SESSION" ADDS A SESSION TO A PROJECT AND NEVER CREATES ONE, and
 * it keeps THREE OUTCOMES APART. If the project list was never read
 * successfully it says CANNOT DETERMINE and refuses, because an empty
 * list after a failed fetch is not evidence that there are no projects.
 * If the list WAS read and is genuinely empty it says so and points at
 * "new claude project". Otherwise it offers the projects, with the
 * MISSING and CANNOT-DETERMINE rows visible, named and refused exactly as
 * they are on the home screen - a broken project that vanished from the
 * picker would be a project the user cannot see is broken.
 *
 * THE PRESENCE SENTENCES COME FROM THE PROJECT TREE'S ASSEMBLER. Slice 4
 * already wrote them and this surface says the same thing about the same
 * state, so it calls `presenceBadgeText` rather than adding a second pair
 * of keys that could drift into saying it differently.
 *
 * THE CLONE'S PROVIDER GATE FIRES BEFORE THE FORM, not after it.
 * `POST /projects/clone` both clones the repo to disk AND persists the
 * project row in one shot, so that request must never fire before the
 * user has committed to launching.
 */
import { PROJECT_CREATE_KEYS } from '../../../../client/js/labels/project-create.js';
import { presenceBadgeText } from '../../../../client/js/labels/project-tree.js';
import type { ProjectRow, Translate } from '../sessions/types';
import type { CreateHost } from './create-host';
import type { ChoiceItem } from './modal-types';
import type { ModalOpeners } from './modals';
import { createProjectFlow } from './create-flow';
import { openProjectFromFolderFlow } from './open-folder-flow';

/** Which of the three starting points the user picked, or none. */
export type NewProjectChoice = 'empty' | 'clone' | 'folder' | null;

/**
 * Build the three rows of the "new claude project" menu.
 *
 * Description: extracted so the copy and the keys can be asserted
 *   without opening a modal. The order is the order it shipped in: the
 *   fresh folder first, because it is the common case.
 * Inputs: t (function).
 * Output: ChoiceItem[].
 * Example: newProjectItems(t)[0].key  // 'empty'
 */
export function newProjectItems(t: Translate): ChoiceItem[] {
    return [
        {
            key: 'empty',
            label: t(PROJECT_CREATE_KEYS.newProjectEmpty),
            sub: t(PROJECT_CREATE_KEYS.newProjectEmptySub),
        },
        {
            key: 'clone',
            label: t(PROJECT_CREATE_KEYS.newProjectClone),
            sub: t(PROJECT_CREATE_KEYS.newProjectCloneSub),
        },
        {
            key: 'folder',
            label: t(PROJECT_CREATE_KEYS.newProjectFolder),
            sub: t(PROJECT_CREATE_KEYS.newProjectFolderSub),
        },
    ];
}

/**
 * Ask how a new claude project should start, then run that flow.
 *
 * Inputs: host; modals; t.
 * Output: Promise<NewProjectChoice> - what was chosen, null on cancel.
 * Example: await startNewClaudeProject(host, modals, t);
 */
export async function startNewClaudeProject(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
): Promise<NewProjectChoice> {
    const how = await modals.choice({
        title: t(PROJECT_CREATE_KEYS.newProjectTitle),
        items: newProjectItems(t),
    });
    if (how === 'empty') {
        await createProjectFlow(host, modals, t, null);
        return 'empty';
    }
    if (how === 'clone') {
        await cloneFromGithubFlow(host, modals, t);
        return 'clone';
    }
    if (how === 'folder') {
        await openProjectFromFolderFlow(host, modals, t);
        return 'folder';
    }
    return null;
}

/**
 * Build the picker rows for the projects that already exist.
 *
 * Description: EVERY project stays visible, including the broken ones.
 *   A `missing` or `unreachable` presence disables the row and prints
 *   its reason where the path would go, which is the same treatment the
 *   home screen gives it. `unchecked` is not a refusal: not having
 *   looked is not evidence of absence.
 * Inputs: projects (ProjectRow[]); presenceFor (function); t.
 * Output: ChoiceItem[].
 * Example: existingProjectItems(projects, host.presenceFor, t)
 */
export function existingProjectItems(
    projects: ProjectRow[],
    presenceFor: (project: ProjectRow) => Record<string, unknown> | null,
    t: Translate,
): ChoiceItem[] {
    return projects.map((project) => {
        const row = presenceFor(project);
        const presence = row ? String(row.presence ?? 'unchecked') : 'unchecked';
        const detail = row && row.presence_detail ? String(row.presence_detail) : null;
        const reason = presenceBadgeText(presence, detail, t);
        return {
            key: String(project.name ?? ''),
            label: String(project.name ?? ''),
            sub: String(project.path ?? ''),
            disabled: presence === 'missing' || presence === 'unreachable',
            reason,
        };
    });
}

/** Why the "new session" menu ended, named. */
export type NewSessionOutcome = 'opened' | 'cancelled' | 'cannot_determine' | 'none';

/**
 * Add a session to a project that already exists, and never create one.
 *
 * Inputs: host; modals; t.
 * Output: Promise<NewSessionOutcome>.
 * Example: await startSessionInExistingProject(host, modals, t);
 */
export async function startSessionInExistingProject(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
): Promise<NewSessionOutcome> {
    if (host.projectsListingOk() === false) {
        await modals.choice({
            title: t(PROJECT_CREATE_KEYS.newSessionTitle),
            items: [],
            emptyMessage: t(PROJECT_CREATE_KEYS.newSessionCannotDetermine),
            emptyKind: 'unknown',
        });
        return 'cannot_determine';
    }
    const projects = host.projects() || [];
    if (projects.length === 0) {
        await modals.choice({
            title: t(PROJECT_CREATE_KEYS.newSessionTitle),
            items: [],
            emptyMessage: t(PROJECT_CREATE_KEYS.newSessionNone),
            emptyKind: 'info',
        });
        return 'none';
    }
    const chosen = await modals.choice({
        title: t(PROJECT_CREATE_KEYS.newSessionPickTitle),
        items: existingProjectItems(projects, (p) => host.presenceFor(p), t),
    });
    if (!chosen) return 'cancelled';
    const project = projects.find((p) => String(p.name ?? '') === chosen);
    if (!project) return 'cancelled';
    await host.selectProject(project, null);
    return 'opened';
}

/** Why a clone ended, named. */
export type CloneOutcome = 'opened' | 'cancelled_provider' | 'cancelled' | 'failed';

/**
 * Clone a github repo into a new project and open a session in it.
 *
 * Description: the provider gate first, then the form. The form owns the
 *   request and its six inline failures, because those are things the
 *   user can fix without losing what they typed; only a SUCCESS closes
 *   it. What happens after a success - refresh the list, enter the
 *   session with the provider choice already made - is this flow's job
 *   and not the modal's.
 * Inputs: host; modals; t.
 * Output: Promise<CloneOutcome>.
 * Example: await cloneFromGithubFlow(host, modals, t);
 */
export async function cloneFromGithubFlow(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
): Promise<CloneOutcome> {
    const choice = await host.chooseProvider();
    if (!choice) return 'cancelled_provider';

    const project = await modals.clone({
        clone: (payload) => host.cloneProject(payload),
    });
    if (!project) return 'cancelled';

    try {
        await host.reloadProjects();
        await host.selectProject(
            {
                name: project.name,
                path: project.path,
                description: project.description || null,
            },
            choice,
        );
        return 'opened';
    } catch (error) {
        console.error('CloudeWeb: failed to open the cloned project:', error);
        host.showError(
            t(PROJECT_CREATE_KEYS.createFailed, {
                reason: error instanceof Error && error.message
                    ? error.message
                    : t('error.server_unreachable'),
            }),
        );
        return 'failed';
    }
}
