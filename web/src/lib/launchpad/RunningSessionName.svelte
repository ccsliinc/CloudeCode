<!--
  RunningSessionName - the row's name, and the inline editor it becomes.

  THIS EDITS THE LABEL, NOT THE HANDLE. `sessions.title` is free-form text
  a human typed; the tmux name is an internal handle derived from it once,
  at creation, and never moved again. This control used to seed itself
  from that handle and enforce the handle's own `^[A-Za-z0-9_-]{1,64}$`
  against it, which did two things: it refused "Media Compression" in the
  browser against a server that accepts it happily, and it showed a user
  who HAD a label the handle instead, so a plain Enter stored a
  handle-derived string over their own label. Silent data loss.

  THE SEED IS THE RENDERED TEXT. Display and seed agree by construction
  rather than by two functions happening to match: both read
  `displayName`, so if the row's display half ever regresses to the
  handle, the seed regresses with it and one test catches both.

  A REPAINT NO LONGER DELETES WHAT THE USER IS TYPING, AND THAT IS WHY
  `client/js/session-list-busy-guard.js` IS GONE. Every legacy branch
  ended in an `innerHTML` write over this whole list, so a poll tick that
  landed while the input was open destroyed the field, the caret and the
  typed text with no error anywhere - and the signature diff did not save
  it, because a status flip on any OTHER row is a real change and paints.
  The guard's answer was to SKIP the paint, which bought correctness with
  staleness. Here the input is a node Svelte owns and a tick touches only
  the values that moved, so there is nothing to destroy and nothing to
  skip.

  BLUR SAVES, ESCAPE CANCELS, ENTER SAVES, and an UNCHANGED value writes
  nothing on any of the three. See ./running-actions.ts::saveRename for
  why the unchanged guard is measured against the seed.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
    import { saveRename } from './running-actions';
    import type { RunningHost } from './running-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** What the row is showing, and what the box opens on. */
        displayName: string;
        /** The handle the editor was opened against. Null means no editor. */
        renameKey: string | null;
        /** Whether the editor is open right now. Owned by the parent row. */
        editing: boolean;
        /** Tell the parent the editor has closed. */
        onclose: () => void;
        host: RunningHost;
        t?: Translate;
    }

    let {
        displayName,
        renameKey,
        editing,
        onclose,
        host,
        t = reactiveT,
    }: Props = $props();

    /** The inline refusal shown under the box. Null while there is none. */
    let error = $state<string | null>(null);
    /** True from the moment a save is accepted, so blur cannot re-enter. */
    let settled = $state(false);
    /** The live input, focused and selected once it exists. */
    let input = $state<HTMLInputElement | null>(null);

    // FOCUS WHEN THE BOX APPEARS, not on every update. The effect reads
    // `input`, which moves exactly once per open, so re-running it on a
    // poll tick is impossible - a `setTimeout(..., 0)` would have been a
    // race against Svelte's own flush rather than a guard against one.
    $effect(() => {
        const el = input;
        if (!el) return;
        el.focus();
        el.select();
    });

    /**
     * Abandon the edit, writing nothing.
     *
     * Inputs: none. Output: void.
     */
    function cancel(): void {
        if (settled) return;
        settled = true;
        error = null;
        onclose();
    }

    /**
     * Try to store what was typed.
     *
     * Description: THREE OUTCOMES, and only one of them closes the box on
     *   a write. `unchanged` closes having written nothing, which is what
     *   makes seeding a label-less session with its handle safe;
     *   `refused` keeps the box open with the reason under it and the
     *   text selected, because a refusal the user cannot see and cannot
     *   correct is worse than no validation at all.
     * Inputs: none. Output: Promise<void>.
     */
    async function save(): Promise<void> {
        if (settled || !renameKey || !input) return;
        const typed = input.value;
        const outcome = await saveRename(
            renameKey, typed, displayName, host, t,
        );
        if (outcome.state === 'refused') {
            error = outcome.reason;
            if (input) {
                input.focus();
                input.select();
            }
            return;
        }
        settled = true;
        error = null;
        onclose();
    }

    /**
     * Enter saves, Escape cancels, and nothing reaches the row.
     *
     * Description: the row is itself a button, so a key that bubbled out
     *   of this box would open the session the user is renaming.
     * Inputs: event. Output: void.
     */
    function onKey(event: KeyboardEvent): void {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            void save();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
        }
    }
</script>

{#if editing && renameKey}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <input
        bind:this={input}
        type="text"
        class="running-session-rename-input"
        value={displayName}
        maxlength={host.labelMaxChars()}
        spellcheck="false"
        autocomplete="off"
        aria-label={t(RUNNING_SESSION_KEYS.renameInputAria)}
        onkeydown={onKey}
        onclick={(event) => event.stopPropagation()}
        onblur={() => void save()}
    />
    {#if error}
        <span class="running-session-rename-error">{error}</span>
    {/if}
{:else}
    <span class="running-session-name">{displayName}</span>
{/if}
