/**
 * Opening a folder that already exists as a project, and the unique-name
 * rule that flow needs.
 *
 * PORTED FROM `Launchpad.openProjectFromFolder`, `saveProjectWithUniqueName`
 * and `showFolderPickerModal`, deleted in the same commit.
 * `openProjectFromFolder` is not named in the slice plan, and it is here
 * anyway for one reason: it is the ONLY caller of the two that are, so
 * leaving it in `launchpad.js` would have left a method reaching across
 * the seam four separate times for a flow whose every step had already
 * moved. `startNewClaudeProject` routes into it as its third option, and
 * that route is now one call inside this tree instead of a round trip
 * out to the legacy object and back.
 *
 * IT POSTS `working_dir`, AND THAT IS CORRECT. This is one of the three
 * shipped flows that take a folder from anywhere on disk - the others are
 * the new-console FAB and clone - which is exactly why the folder-step
 * restriction was attached to `project_parent_dir`, a field nothing used
 * to send. Restricting `working_dir` would start refusing folders this
 * flow has always accepted.
 *
 * THE FOLDER IS PICKED FIRST, then the name is CONFIRMED rather than
 * invented: the default name is the folder's own basename, so the common
 * case is one keystroke. Nothing is written until the provider gate has
 * also answered, so cancelling at any of the three steps leaves no
 * project row behind for a session that was never created.
 *
 * A UNIQUE NAME IS FOUND, NEVER FORCED. `POST /projects` refuses a
 * duplicate name; when it does, an existing row for the SAME PATH is
 * reused (that is the same project, already added) and otherwise a
 * numbered suffix is tried. Twenty attempts, then it gives up with a
 * message that carries a catalog KEY rather than an English sentence -
 * the thrown string this replaced went straight to the screen through
 * `showError(error.message)` with nothing marking it as copy.
 */
import {
    PROJECT_CREATE_KEYS,
    uniqueNameFailure,
} from '../../../../client/js/labels/project-create.js';
import type { ProjectRow, Translate } from '../sessions/types';
import type { CreateHost } from './create-host';
import type { ModalOpeners } from './modals';

/** How many numbered names are tried before giving up. */
export const UNIQUE_NAME_ATTEMPTS = 20;

/** An error carrying a catalog key instead of an English sentence. */
export interface KeyedError extends Error {
    cloudeKey?: string;
}

/**
 * Save a project, working around a name that is already taken.
 *
 * Description: returns the name that was ACTUALLY saved, which is not
 *   always the name asked for. An existing row with the same PATH is the
 *   same project and is reused rather than duplicated under a numbered
 *   name; only a genuine name collision on a different folder is
 *   suffixed. An error that is not a name collision is re-raised
 *   unchanged, because it is the server saying something else entirely.
 * Inputs: host; row ({name, path, description}).
 * Output: Promise<string> - the saved name.
 * Example: await saveProjectWithUniqueName(host, {name: 'api', path: '/a'});
 */
export async function saveProjectWithUniqueName(
    host: CreateHost,
    row: { name: string; path: string; description?: string | null },
): Promise<string> {
    let attempt = row.name;
    for (let i = 0; i < UNIQUE_NAME_ATTEMPTS; i += 1) {
        try {
            await host.createProject({
                name: attempt,
                path: row.path,
                description: row.description ?? null,
            });
            return attempt;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            if (!message.includes('already exists')) throw error;
            const existing = host
                .projects()
                .find((project: ProjectRow) => project.path === row.path);
            if (existing && existing.name) return String(existing.name);
            attempt = `${row.name} (${i + 2})`;
        }
    }
    const failure: KeyedError = new Error(PROJECT_CREATE_KEYS.uniqueNameFailed);
    failure.cloudeKey = PROJECT_CREATE_KEYS.uniqueNameFailed;
    throw failure;
}

/** Why opening a folder ended, named. */
export type OpenFolderOutcome =
    | 'opened'
    | 'cancelled_folder'
    | 'cancelled_name'
    | 'cancelled_provider'
    | 'no_picker'
    | 'failed';

/**
 * Add a folder already on this machine as a project, and open it.
 *
 * Description: pick the folder, confirm the name and description, gate on
 *   the provider, THEN persist and enter. The provider gate sits before
 *   the write so a cancelled launch leaves no project row pointing at a
 *   session that was never created.
 * Inputs: host; modals; t.
 * Output: Promise<OpenFolderOutcome>.
 * Example: await openProjectFromFolderFlow(host, modals, t);
 */
export async function openProjectFromFolderFlow(
    host: CreateHost,
    modals: ModalOpeners,
    t: Translate,
): Promise<OpenFolderOutcome> {
    try {
        const picker = host.folderPicker();
        if (!picker) {
            // The picker is a separate module this slice does not
            // migrate. Its absence is a load-order fault, and saying so
            // beats a browse button that silently does nothing.
            host.showError(t(PROJECT_CREATE_KEYS.folderPickerUnavailable));
            return 'no_picker';
        }
        const selectedPath = await picker();
        if (!selectedPath) return 'cancelled_folder';

        const defaultName = selectedPath.split('/').filter(Boolean).pop() || selectedPath;
        const details = await modals.name({
            title: t(PROJECT_CREATE_KEYS.nameAddTitle),
            confirmLabel: t(PROJECT_CREATE_KEYS.confirmOpen),
            defaultName,
            pathHint: selectedPath,
        });
        if (!details) return 'cancelled_name';

        const choice = await host.chooseProvider();
        if (!choice) return 'cancelled_provider';

        host.updateStatus(t(PROJECT_CREATE_KEYS.editStatusUpdating, { name: details.name }));
        const savedName = await saveProjectWithUniqueName(host, {
            name: details.name,
            path: selectedPath,
            description: details.description || null,
        });
        await host.reloadProjects();
        await host.selectProject(
            {
                name: savedName,
                path: selectedPath,
                description: details.description || null,
            },
            choice,
        );
        return 'opened';
    } catch (error) {
        console.error('CloudeWeb: failed to open project from folder:', error);
        host.showError(
            t(PROJECT_CREATE_KEYS.createFolderFailed, {
                reason: uniqueNameFailure(error, t),
            }),
        );
        return 'failed';
    }
}
