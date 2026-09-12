/**
 * The five modals this slice owns, as one injectable set of openers.
 *
 * WHY THE FLOWS DO NOT IMPORT THE COMPONENTS. A flow is an ORDER - ask
 * the provider, ask the name, ask the folder, then and only then create -
 * and the order is the thing that has to be right, because getting it
 * wrong writes a folder on disk that the user did not ask for and cannot
 * find. An order is testable; a component that mounts into
 * `document.body` and waits for a click is not, at least not without
 * making every ordering test a DOM test. So the flow takes this
 * interface, the browser hands it :func:`browserModals`, and a test hands
 * it four recorded answers.
 *
 * IT IS NOT AN ABSTRACTION OVER MODALS IN GENERAL. There are exactly
 * five, they are named after what they ask for, and adding a sixth means
 * adding a member here. A generic `open(component, props)` would put the
 * component choice back in the flow and lose the whole point.
 *
 * EVERY OPENER RESOLVES `null` ON CANCEL. See `web/src/lib/modal.ts`.
 */
import { openModal } from '../modal';
import ChoiceModal from './ChoiceModal.svelte';
import CloneModal from './CloneModal.svelte';
import EditProjectModal from './EditProjectModal.svelte';
import ProjectFolderModal from './ProjectFolderModal.svelte';
import ProjectNameModal from './ProjectNameModal.svelte';
import type {
    ChoiceOptions,
    ClonedProject,
    EditResult,
    FolderChoice,
    ProjectDetails,
} from './modal-types';

/** What the name step is asked for. */
export interface NameRequest {
    /** The header sentence, already translated. */
    title: string;
    /** The primary button's label, already translated. */
    confirmLabel: string;
    /** Prefill, which is how a refused name comes back still typed. */
    defaultName?: string;
    /** A folder to report above the fields. */
    pathHint?: string | null;
}

/** What the folder step is asked for. */
export interface FolderRequest {
    /** The project name, for the preview and for the name rule. */
    name: string;
    /** Where the parent field starts, asked of the server. */
    defaultParent: () => Promise<string | null>;
    /** The existing folder picker, or null when it is not loaded. */
    openPicker: (() => Promise<string | null>) | null;
}

/** What the edit modal is asked for. */
export interface EditRequest {
    projectName: string;
    projectPath: string;
    projectDescription?: string | null;
}

/** What the clone modal is asked for. */
export interface CloneRequest {
    clone: (payload: {
        repoUrl: string;
        parentDir: string;
        description?: string;
    }) => Promise<ClonedProject>;
    defaultParentDir?: string;
}

/** The five things these flows can ask a human. */
export interface ModalOpeners {
    name(request: NameRequest): Promise<ProjectDetails | null>;
    folder(request: FolderRequest): Promise<FolderChoice | null>;
    choice(options: ChoiceOptions): Promise<string | null>;
    edit(request: EditRequest): Promise<EditResult | null>;
    clone(request: CloneRequest): Promise<ClonedProject | null>;
}

/**
 * The openers that actually mount components into the document.
 *
 * Description: one `openModal` call each, with the request passed
 *   through as props. Nothing here decides anything; the deciding is in
 *   the flows and in the components.
 * Inputs: none.
 * Output: ModalOpeners.
 * Example: const modals = browserModals();
 */
export function browserModals(): ModalOpeners {
    return {
        name: (request) => openModal<ProjectDetails, Record<string, unknown>>(
            ProjectNameModal as never,
            request as unknown as Record<string, unknown>,
        ),
        folder: (request) => openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            request as unknown as Record<string, unknown>,
        ),
        choice: (options) => openModal<string, Record<string, unknown>>(
            ChoiceModal as never,
            options as unknown as Record<string, unknown>,
        ),
        edit: (request) => openModal<EditResult, Record<string, unknown>>(
            EditProjectModal as never,
            request as unknown as Record<string, unknown>,
        ),
        clone: (request) => openModal<ClonedProject, Record<string, unknown>>(
            CloneModal as never,
            request as unknown as Record<string, unknown>,
        ),
    };
}
