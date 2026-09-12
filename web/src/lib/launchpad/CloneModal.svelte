<!--
  CloneModal - clone a repo into a new project, ported from
  `Launchpad.showCloneFromGithubModal`.

  IT COLLECTS A PARENT DIRECTORY, and it always did. Clone is one of the
  three shipped flows that post a folder chosen from anywhere on disk, so
  it posts `parentDir` and NOT `project_parent_dir`: the restricted field
  is the one nothing used to send, and attaching a root restriction to a
  field these flows already use would start refusing folders they have
  always accepted.

  THE REQUEST RUNS FROM INSIDE THE MODAL, unlike every other modal in this
  slice, and that is not an oversight. `POST /projects/clone` both clones
  to disk and persists the project row in one shot, and its six failure
  modes are things the user can fix in this form - a bad url, an
  unauthenticated gh, a name collision. A modal that closed and printed
  the error somewhere else would throw away everything they typed. So the
  clone call is a prop, the failure is inline, and only a SUCCESS closes.

  WHILE IT IS IN FLIGHT NOTHING DISMISSES IT. Escape, click-outside and
  cancel are all suspended, because dismissing the form does not cancel
  the `gh repo clone` the server is already running, and a modal that
  vanishes while work continues is worse than one that will not close.
  `dismissable={!busy}` is the whole of that rule.

  ONE `busy` FLAG DISABLES FIVE CONTROLS. The hand-written version set
  `disabled` on each of them by hand, twice, once to disable and once to
  restore - ten statements where a missed one leaves a live control on a
  form mid-request. Here it is one piece of state five attributes read.

  THE ERROR IS SET ONCE, on the failure path, never cleared before the
  await and re-set after. A status line emptied before a request and
  refilled after it is two paints where the user sees one state.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        PROJECT_CREATE_KEYS,
        cloneFailure,
    } from '../../../../client/js/labels/project-create.js';
    import type { Translate } from '../sessions/types';
    import type { ClonedProject } from './modal-types';
    import ModalShell from './ModalShell.svelte';

    /** The body `POST /projects/clone` is given. */
    interface ClonePayload {
        repoUrl: string;
        parentDir: string;
        description?: string;
    }

    interface Props {
        /** `API.cloneProjectFromGithub`, injected so a test can refuse. */
        clone: (payload: ClonePayload) => Promise<ClonedProject>;
        /** The parent directory the field starts on. */
        defaultParentDir?: string;
        t?: Translate;
        close: (value: ClonedProject | null) => void;
    }

    let { clone, defaultParentDir = '~/projects', t = reactiveT, close }: Props = $props();

    let repoUrl = $state('');
    // A MODAL'S PROP IS A SEED, NOT A BINDING, and that is the whole
    // reason this reads its initial value on purpose. Each modal is
    // mounted fresh by `openModal` for one question and unmounted when it
    // answers, so there is no later prop change to miss - and the field
    // belongs to the user the moment they type in it. Reacting to the
    // prop would overwrite what they typed.
    // svelte-ignore state_referenced_locally
    let parentDir = $state(defaultParentDir);
    let description = $state('');
    let status = $state('');
    let statusIsError = $state(false);
    let busy = $state(false);
    let urlEl: HTMLInputElement | null = $state(null);
    let parentEl: HTMLInputElement | null = $state(null);
    let descEl: HTMLInputElement | null = $state(null);

    $effect(() => {
        const timer = setTimeout(() => urlEl?.focus(), 100);
        return () => clearTimeout(timer);
    });

    /**
     * Send the clone, keeping the form open on every failure.
     *
     * Description: refuses an empty url before anything is sent, because
     *   the server's own refusal for that is a 422 whose text says
     *   nothing a user can act on. On success it closes with the project
     *   row; the caller refreshes the list and enters the session, which
     *   is work this modal has no business doing.
     * Inputs: none. Output: Promise<void>.
     */
    async function submit(): Promise<void> {
        if (busy) return;
        const url = repoUrl.trim();
        if (!url) {
            status = t(PROJECT_CREATE_KEYS.cloneNeedsUrl);
            statusIsError = true;
            urlEl?.focus();
            return;
        }
        busy = true;
        status = t(PROJECT_CREATE_KEYS.cloneBusy);
        statusIsError = false;
        try {
            const project = await clone({
                repoUrl: url,
                parentDir: parentDir.trim() || defaultParentDir,
                description: description.trim() || undefined,
            });
            close(project);
        } catch (error) {
            console.error('CloneModal: clone-from-github failed:', error);
            status = cloneFailure(error, t);
            statusIsError = true;
            busy = false;
        }
    }

    /**
     * Enter walks url to parent to description, then submits.
     *
     * Inputs: event (KeyboardEvent); next (element or null). Output: void.
     */
    function onFieldKey(event: KeyboardEvent, next: HTMLInputElement | null): void {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (next) {
            next.focus();
            return;
        }
        void submit();
    }
</script>

<ModalShell
    title={t(PROJECT_CREATE_KEYS.cloneTitle)}
    dismissable={!busy}
    onCancel={() => close(null)}
>
    <div class="modal-input-group">
        <label class="modal-label" for="modal-clone-url"
            >{t(PROJECT_CREATE_KEYS.cloneUrlLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="modal-clone-url"
            placeholder={t(PROJECT_CREATE_KEYS.cloneUrlPlaceholder)}
            autocomplete="off"
            spellcheck="false"
            disabled={busy}
            bind:this={urlEl}
            bind:value={repoUrl}
            onkeydown={(e) => onFieldKey(e, repoUrl.trim() ? parentEl : null)}
        />
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.cloneUrlHint)}</div>
    </div>
    <div class="modal-input-group">
        <label class="modal-label" for="modal-clone-parent"
            >{t(PROJECT_CREATE_KEYS.cloneParentLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="modal-clone-parent"
            placeholder={defaultParentDir}
            autocomplete="off"
            spellcheck="false"
            disabled={busy}
            bind:this={parentEl}
            bind:value={parentDir}
            onkeydown={(e) => onFieldKey(e, descEl)}
        />
        <div class="modal-description">{t(PROJECT_CREATE_KEYS.cloneParentHint)}</div>
    </div>
    <div class="modal-input-group">
        <label class="modal-label" for="modal-clone-description"
            >{t(PROJECT_CREATE_KEYS.descriptionLabel)}</label
        >
        <input
            type="text"
            class="modal-input"
            id="modal-clone-description"
            placeholder={t(PROJECT_CREATE_KEYS.cloneDescriptionPlaceholder)}
            autocomplete="off"
            disabled={busy}
            bind:this={descEl}
            bind:value={description}
            onkeydown={(e) => onFieldKey(e, null)}
        />
    </div>
    {#if status}
        <div
            class="modal-description"
            class:folder-picker-status--error={statusIsError}
            id="modal-clone-status"
            role="status"
            aria-live="polite"
        >
            {status}
        </div>
    {/if}
    {#snippet footer()}
        <button
            class="modal-btn modal-btn-secondary"
            id="modal-clone-cancel"
            disabled={busy}
            onclick={() => close(null)}>{t(PROJECT_CREATE_KEYS.cancel)}</button
        >
        <button
            class="modal-btn modal-btn-primary"
            id="modal-clone-confirm"
            disabled={busy}
            onclick={submit}>{t(PROJECT_CREATE_KEYS.cloneConfirm)}</button
        >
    {/snippet}
</ModalShell>
