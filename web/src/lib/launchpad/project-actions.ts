/**
 * What a project row can do to itself: archive, restore, rename.
 *
 * PORTED FROM `Launchpad.archiveProject`, `unarchiveProject`,
 * `editProject` and `showEditProjectModal`, deleted in the same commit.
 * The project tree (slice 4) is the caller and already reaches these
 * three by name through its host, so this slice repoints that host at
 * these functions rather than leaving a second copy behind.
 *
 * ARCHIVING ASKS AND RESTORING DOES NOT, and that asymmetry is
 * deliberate. Archiving takes something off the screen; restoring only
 * ever adds a row back, and a confirm on a harmless, self-evident,
 * instantly reversible action is friction that teaches people to click
 * through the dialogs that do matter.
 *
 * THE CONFIRM COPY NAMES THE REAL CONSEQUENCES, which on this app is a
 * standing rule rather than a style preference: archiving keeps the
 * project in full, does NOT archive its sessions, and does not touch the
 * folder on disk. A dialog that warned about nothing would be the kind
 * this project has already paid for.
 *
 * A RENAME THAT CHANGES NOTHING WRITES NOTHING. The comparison is
 * against what was on the row, so re-saving the same values is a no-op
 * rather than a PATCH the server has to decide about.
 */
import { PROJECT_CREATE_KEYS } from '../../../../client/js/labels/project-create.js';
import type { ProjectRow, Translate } from '../sessions/types';
import type { CreateHost } from './create-host';
import type { ModalOpeners } from './modals';

/** The message an API error carried, or the named unreachable fallback. */
function reasonOf(error: unknown, t: Translate): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message || t('error.server_unreachable');
}

/**
 * Archive a project after asking, then refresh the list.
 *
 * Description: the confirm is the whole of the safety here - the call
 *   itself is a soft archive the user can undo from the same screen with
 *   "show archived" on. A refusal at the dialog returns without touching
 *   anything.
 * Inputs: host; t; projectName (string).
 * Output: Promise<boolean> - true when it was archived.
 * Example: await archiveProjectFlow(host, t, 'Punchlist Test');
 */
export async function archiveProjectFlow(
    host: CreateHost,
    t: Translate,
    projectName: string,
): Promise<boolean> {
    try {
        const confirmed = await host.confirm(
            t(PROJECT_CREATE_KEYS.archiveTitle),
            t(PROJECT_CREATE_KEYS.archiveMessage, { name: projectName }),
            t(PROJECT_CREATE_KEYS.archiveDetails),
            t(PROJECT_CREATE_KEYS.archiveConfirm),
            t(PROJECT_CREATE_KEYS.cancel),
        );
        if (!confirmed) return false;
        await host.archiveProject(projectName);
        await host.reloadProjects();
        return true;
    } catch (error) {
        console.error('CloudeWeb: failed to archive project:', error);
        host.showError(t(PROJECT_CREATE_KEYS.archiveFailed, { reason: reasonOf(error, t) }));
        return false;
    }
}

/**
 * Put an archived project back in the default list. No confirm.
 *
 * Inputs: host; t; projectName (string).
 * Output: Promise<boolean> - true when it was restored.
 * Example: await unarchiveProjectFlow(host, t, 'Punchlist Test');
 */
export async function unarchiveProjectFlow(
    host: CreateHost,
    t: Translate,
    projectName: string,
): Promise<boolean> {
    try {
        await host.unarchiveProject(projectName);
        await host.reloadProjects();
        return true;
    } catch (error) {
        console.error('CloudeWeb: failed to restore project:', error);
        host.showError(t(PROJECT_CREATE_KEYS.restoreFailed, { reason: reasonOf(error, t) }));
        return false;
    }
}

/** Why an edit ended, named rather than boolean. */
export type EditOutcome = 'updated' | 'cancelled' | 'unchanged' | 'failed';

/**
 * Rename a project's LABEL, and its description with it.
 *
 * Description: the folder on disk is never renamed - only the launcher
 *   label changes, which is what the modal says above the fields. A 409
 *   name collision arrives as a rejection whose message contains "already
 *   exists" and is shown on the launchpad's error line, exactly as it was
 *   before this moved.
 * Inputs: host; modals; t; project (ProjectRow).
 * Output: Promise<EditOutcome>.
 * Example: await editProjectFlow(host, modals, t, project);
 */
export async function editProjectFlow(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
    project: ProjectRow,
): Promise<EditOutcome> {
    const currentName = String(project.name ?? '');
    const currentDescription = String(project.description ?? '');
    try {
        const result = await modals.edit({
            projectName: currentName,
            projectPath: String(project.path ?? ''),
            projectDescription: currentDescription,
        });
        if (!result) return 'cancelled';

        const nameChanged = result.name !== currentName;
        const descChanged = result.description !== currentDescription;
        if (!nameChanged && !descChanged) return 'unchanged';

        host.updateStatus(t(PROJECT_CREATE_KEYS.editStatusUpdating, { name: currentName }));
        const fields: Record<string, unknown> = {};
        if (nameChanged) fields.newName = result.name;
        if (descChanged) fields.description = result.description;
        await host.updateProject(currentName, fields);
        await host.reloadProjects();
        host.updateStatus(t(PROJECT_CREATE_KEYS.editStatusDone));
        return 'updated';
    } catch (error) {
        console.error('CloudeWeb: failed to update project:', error);
        host.showError(t(PROJECT_CREATE_KEYS.editFailed, { reason: reasonOf(error, t) }));
        return 'failed';
    }
}
