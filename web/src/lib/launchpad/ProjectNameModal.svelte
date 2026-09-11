<!--
  ProjectNameModal - name and describe a project, ported from
  `Launchpad.showProjectNameModal`.

  IT COLLECTS, IT DOES NOT VALIDATE. The name rule lives in
  `project-folder.ts` and the refusal sentence in
  `client/js/labels/project-create.js`, and the CREATE FLOW is what loops:
  refuse, show the sentence, re-open this with what was typed still in the
  field. Putting the rule in here would give the flow a second opinion to
  disagree with, and the flow is the one that has to be right because it
  is the one that posts.

  AN EMPTY NAME DOES NOT RESOLVE, IT REFOCUSES. That is the legacy
  behaviour and it is not the same as a refusal: nothing has been typed
  yet, so there is nothing to explain. A cancel is the only way out that
  resolves null.

  ENTER WALKS THE FIELDS. Enter on the name moves to the description, and
  only when the name is non-empty; Enter on the description submits. The
  hand-written version bound `keypress` for this, which does not fire for
  every key in every browser - `keydown` does, and Enter behaves
  identically on both.

  THE FOLDER HINT IS A `<div>`, NOT AN INPUT. The path is being reported,
  not asked for, which is why "open an existing folder" can show it here
  while "start empty" has nothing to show yet.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { PROJECT_CREATE_KEYS } from '../../../../client/js/labels/project-create.js';
    import type { Translate } from '../sessions/types';
    import type { ProjectDetails } from './modal-types';
    import ModalShell from './ModalShell.svelte';

    interface Props {
        /** The header sentence, already translated by the caller. */
        title: string;
        /** The primary button's label, already translated. */
        confirmLabel: string;
        /** Prefill for the name field, e.g. a refused name being re-asked. */
        defaultName?: string;
        /** A folder to REPORT above the fields, or null to show none. */
        pathHint?: string | null;
        t?: Translate;
        close: (value: ProjectDetails | null) => void;
    }

    let {
        title,
        confirmLabel,
        defaultName = '',
        pathHint = null,
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
    let name = $state(defaultName);
    let description = $state('');
    let nameEl: HTMLInputElement | null = $state(null);
    let descEl: HTMLInputElement | null = $state(null);

    // Focus after the overlay has been laid out, the same 100ms the
    // hand-written version used. It is a `setTimeout`, never a bare
    // `requestAnimationFrame` await: a background tab never runs rAF
    // callbacks, and nothing here may depend on a frame that may never
    // come (gotcha 9).
    $effect(() => {
        const timer = setTimeout(() => {
            nameEl?.focus();
            if (defaultName) nameEl?.select();
        }, 100);
        return () => clearTimeout(timer);
    });

    /**
     * Resolve with the typed values, or refocus when the name is empty.
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
     * Enter on the name field moves to the description, never submits.
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

<ModalShell {title} onCancel={() => close(null)}>
    {#if pathHint}
        <div class="modal-input-group">
            <div class="modal-label">{t(PROJECT_CREATE_KEYS.folderLabel)}</div>
            <div class="folder-picker-path">{pathHint}</div>
        </div>
    {/if}
    <div class="modal-input-group">
        <label class="modal-label" for="modal-project-name"
            >{t(PROJECT_CREATE_KEYS.nameLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="modal-project-name"
            placeholder={t(PROJECT_CREATE_KEYS.namePlaceholder)}
            autocomplete="off"
            bind:this={nameEl}
            bind:value={name}
            onkeydown={onNameKey}
        />
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.nameHint)}</div>
    </div>
    <div class="modal-input-group">
        <label class="modal-label" for="modal-project-description"
            >{t(PROJECT_CREATE_KEYS.descriptionLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="modal-project-description"
            placeholder={t(PROJECT_CREATE_KEYS.descriptionPlaceholder)}
            autocomplete="off"
            bind:this={descEl}
            bind:value={description}
            onkeydown={onDescKey}
        />
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.descriptionHint)}</div>
    </div>
    {#snippet footer()}
        <button class="modal-btn modal-btn-secondary" id="modal-cancel" onclick={() => close(null)}
            >{t(PROJECT_CREATE_KEYS.cancel)}</button
        >
        <button class="modal-btn modal-btn-primary" id="modal-confirm" onclick={submit}
            >{confirmLabel}</button
        >
    {/snippet}
</ModalShell>
