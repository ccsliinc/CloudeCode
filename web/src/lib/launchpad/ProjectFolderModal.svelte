<!--
  ProjectFolderModal - the folder step "start empty" never had.

  THE BUG THIS EXISTS TO PREVENT, in one sentence: the new-project chain
  was "+" > new claude project > start empty > provider > name this
  project > create session, and nothing in it ever asked where the project
  should live, so the server fell back to
  `work_path = settings.get_working_dir() / session_id` and a project the
  user named `Punchlist Test` was created at `.../ses_5a756046` and
  recorded there as its permanent home. That fallback still exists for an
  old client and now logs at warning level. This step is why the current
  client never reaches it.

  THE PREVIEW IS THE FEATURE. The user is shown the full path that will be
  created BEFORE anything is created, because the original defect was a
  user never being told where their project went.

  IT POSTS THE PARENT, NOT THE PATH. `parent` is what the create request
  carries as `project_parent_dir`; the server joins the name itself and
  canonicalises with `os.path.realpath`, so a symlinked parent is recorded
  in its LONG spelling. A client-composed path would record the short
  spelling, and the short spelling of a symlinked directory is how one
  directory becomes two projects, two transcript directories and two
  session rows (gotcha 6). `path` travels for the preview and for tests.

  A MISSING DEFAULT IS CANNOT DETERMINE, NOT "there is no default". The
  browse endpoint with no argument returns the configured projects root,
  so the default lives in the server config and has no second copy here.
  When it cannot be asked the field stays EMPTY with a prompt, rather than
  being filled with a guess the user would accept without reading.

  CREATE IS DISABLED, NOT SILENTLY IGNORED, while the name is refused or
  the parent is blank, and the reason is on screen in the status line.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        PROJECT_CREATE_KEYS,
        nameRefusal,
    } from '../../../../client/js/labels/project-create.js';
    import type { Translate } from '../sessions/types';
    import type { FolderChoice } from './modal-types';
    import { composePath, validateName } from './project-folder';
    import ModalShell from './ModalShell.svelte';

    interface Props {
        /** The project name already collected by the name step. */
        name: string;
        /** `GET /browse` with no path: the configured projects root. */
        defaultParent: () => Promise<string | null>;
        /** The existing folder picker's `open()`, or null when absent. */
        openPicker: (() => Promise<string | null>) | null;
        t?: Translate;
        close: (value: FolderChoice | null) => void;
    }

    let { name, defaultParent, openPicker, t = reactiveT, close }: Props = $props();

    let parent = $state('');
    let placeholder = $state('');
    let pickerProblem = $state(false);
    let parentEl: HTMLInputElement | null = $state(null);

    const verdict = $derived(validateName(name));
    const refusal = $derived(nameRefusal(verdict, t));
    const path = $derived(composePath(parent, name));
    const ready = $derived(verdict.ok && parent.trim().length > 0);

    /** The one status line, and which of its three states it is in. */
    const status = $derived.by(() => {
        if (pickerProblem) {
            return { text: t(PROJECT_CREATE_KEYS.folderPickerUnavailable), error: true };
        }
        if (refusal) return { text: refusal, error: true };
        if (!parent.trim()) {
            return { text: t(PROJECT_CREATE_KEYS.folderChoosePrompt), error: false };
        }
        return { text: '', error: false };
    });

    // ONE ASSIGNMENT, AFTER THE AWAIT. `parent` is not cleared first: a
    // field emptied before a fetch and refilled after it is two publishes
    // where the user sees one state, which is the repaint defect slices 4
    // and 5 each found one field over. It starts empty and is set once.
    $effect(() => {
        let live = true;
        placeholder = t(PROJECT_CREATE_KEYS.folderParentLoading);
        defaultParent()
            .then((dir) => {
                if (!live) return;
                if (dir && !parent) parent = dir;
                else if (!dir) placeholder = t(PROJECT_CREATE_KEYS.folderParentUnavailable);
            })
            .catch(() => {
                // A default that cannot be read is CANNOT DETERMINE, and
                // the empty field with its prompt already says so. The
                // host logs the cause; re-raising here would take down a
                // modal the user can still complete by typing a path.
                if (live) placeholder = t(PROJECT_CREATE_KEYS.folderParentUnavailable);
            });
        const timer = setTimeout(() => parentEl?.focus(), 100);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    });

    /**
     * Open the existing folder picker and take its answer as the parent.
     *
     * Description: the picker is `client/js/folder-picker-modal.js`,
     *   which this slice does NOT migrate and no longer injects an
     *   escaper into - it has carried its own default escaper since it
     *   was extracted. A picker that is not loaded is reported in the
     *   status line rather than throwing, because typing a path is still
     *   a complete way through this step.
     * Inputs: none. Output: Promise<void>.
     */
    async function browse(): Promise<void> {
        if (!openPicker) {
            pickerProblem = true;
            return;
        }
        const picked = await openPicker();
        if (picked) {
            pickerProblem = false;
            parent = picked;
        }
    }

    /**
     * Resolve with the chosen parent and the path it composes.
     *
     * Inputs: none. Output: void.
     */
    function confirm(): void {
        if (!ready) return;
        close({ parent: parent.trim(), path });
    }
</script>

<ModalShell title={t(PROJECT_CREATE_KEYS.folderTitle)} onCancel={() => close(null)}>
    <div class="modal-input-group">
        <label class="modal-label" for="project-parent-input"
            >{t(PROJECT_CREATE_KEYS.folderParentLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="project-parent-input"
            {placeholder}
            autocomplete="off"
            spellcheck="false"
            bind:this={parentEl}
            bind:value={parent}
        />
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.folderParentHint)}</div>
    </div>
    <div class="modal-input-group">
        <div class="modal-label">{t(PROJECT_CREATE_KEYS.folderFullPath)}</div>
        <div class="folder-picker-path" id="project-path-preview">
            {path || t(PROJECT_CREATE_KEYS.folderNoPath)}
        </div>
        <div
            class="folder-picker-status"
            class:folder-picker-status--error={status.error}
            id="project-path-status"
            role="status"
            aria-live="polite"
        >
            {status.text}
        </div>
    </div>
    {#snippet footer()}
        <button
            class="modal-btn modal-btn-secondary"
            id="project-folder-cancel"
            onclick={() => close(null)}>{t(PROJECT_CREATE_KEYS.cancel)}</button
        >
        <button class="modal-btn modal-btn-secondary" id="project-folder-browse" onclick={browse}
            >{t(PROJECT_CREATE_KEYS.folderBrowse)}</button
        >
        <button
            class="modal-btn modal-btn-primary"
            id="project-folder-confirm"
            disabled={!ready}
            onclick={confirm}>{t(PROJECT_CREATE_KEYS.confirmCreate)}</button
        >
    {/snippet}
</ModalShell>
