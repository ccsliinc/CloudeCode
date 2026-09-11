<!--
  EditProjectModal - rename a project's LABEL, ported from
  `Launchpad.showEditProjectModal`.

  THE FOLDER ON DISK IS NEVER RENAMED, and the modal says so in the one
  place the user can see it: the folder is shown as read-only text above
  the fields. A project is a label plus a directory, and only the label
  moves here.

  IT COLLECTS AND RESOLVES, it does not save. `editProject` in
  `project-actions.ts` is what compares the result to what was there, does
  nothing when nothing changed, and shows the server's refusal when the
  new name collides. Splitting those apart is what lets the no-change case
  be tested without a server.

  AN EMPTY NAME REFOCUSES RATHER THAN RESOLVING, the same rule the name
  modal holds: a project with no label is not a thing this app can render.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { PROJECT_CREATE_KEYS } from '../../../../client/js/labels/project-create.js';
    import type { Translate } from '../sessions/types';
    import type { EditResult } from './modal-types';
    import ModalShell from './ModalShell.svelte';

    interface Props {
        /** The project's current label. */
        projectName: string;
        /** The project's folder, reported and never edited. */
        projectPath: string;
        /** The project's current description, '' when it has none. */
        projectDescription?: string | null;
        t?: Translate;
        close: (value: EditResult | null) => void;
    }

    let {
        projectName,
        projectPath,
        projectDescription = '',
        t = reactiveT,
        close,
    }: Props = $props();

    // A MODAL'S PROP IS A SEED, NOT A BINDING, and that is the whole
    // reason this reads its initial value on purpose. Each modal is
    // mounted fresh by `openModal` for one question and unmounted when it
    // answers, so there is no later prop change to miss - and the field
    // belongs to the user the moment they type in it. Reacting to the
    // prop would overwrite what they typed.
    // svelte-ignore state_referenced_locally
    let name = $state(projectName);
    // svelte-ignore state_referenced_locally
    let description = $state(projectDescription || '');
    let nameEl: HTMLInputElement | null = $state(null);
    let descEl: HTMLInputElement | null = $state(null);

    $effect(() => {
        const timer = setTimeout(() => {
            nameEl?.focus();
            nameEl?.select();
        }, 100);
        return () => clearTimeout(timer);
    });

    /**
     * Resolve with the edited values, or refocus on an empty name.
     *
     * Inputs: none. Output: void.
     */
    function submit(): void {
        const trimmed = name.trim();
        if (!trimmed) {
            nameEl?.focus();
            return;
        }
        close({ name: trimmed, description: description.trim() });
    }

    /**
     * Enter on the name moves to the description, never submits.
     *
     * Inputs: event (KeyboardEvent). Output: void.
     */
    function onNameKey(event: KeyboardEvent): void {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (name.trim()) descEl?.focus();
    }

    /**
     * Enter on the description submits.
     *
     * Inputs: event (KeyboardEvent). Output: void.
     */
    function onDescKey(event: KeyboardEvent): void {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submit();
    }
</script>

<ModalShell title={t(PROJECT_CREATE_KEYS.editTitle)} onCancel={() => close(null)}>
    <div class="modal-input-group">
        <div class="modal-label">{t(PROJECT_CREATE_KEYS.folderLabel)}</div>
        <div class="folder-picker-path">{projectPath}</div>
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.editFolderHint)}</div>
    </div>
    <div class="modal-input-group">
        <label class="modal-label" for="edit-project-name"
            >{t(PROJECT_CREATE_KEYS.nameLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="edit-project-name"
            autocomplete="off"
            bind:this={nameEl}
            bind:value={name}
            onkeydown={onNameKey}
        />
    </div>
    <div class="modal-input-group">
        <label class="modal-label" for="edit-project-description"
            >{t(PROJECT_CREATE_KEYS.descriptionLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="edit-project-description"
            placeholder={t(PROJECT_CREATE_KEYS.descriptionPlaceholder)}
            autocomplete="off"
            bind:this={descEl}
            bind:value={description}
            onkeydown={onDescKey}
        />
    </div>
    {#snippet footer()}
        <button
            class="modal-btn modal-btn-secondary"
            id="edit-modal-cancel"
            onclick={() => close(null)}>{t(PROJECT_CREATE_KEYS.cancel)}</button
        >
        <button class="modal-btn modal-btn-primary" id="edit-modal-save" onclick={submit}
            >{t(PROJECT_CREATE_KEYS.editSave)}</button
        >
    {/snippet}
</ModalShell>
