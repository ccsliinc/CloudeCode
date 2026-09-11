<!--
  ChoiceModal - the one-of-N picker, ported from
  `Launchpad._showChoiceModal`.

  IT REUSES THE FOLDER PICKER'S VISUAL LANGUAGE rather than inventing a
  second kind of list: `.folder-picker-list`, `.folder-picker-item` and
  `.folder-picker-empty` already exist and already theme. No class here
  is new, so all 26 themes keep working with no theme change.

  A ROW CAN BE VISIBLE, NAMED AND REFUSED. That is how a project whose
  folder is MISSING or whose presence CANNOT BE DETERMINED stays on the
  list with its reason printed, instead of silently vanishing from a
  picker - the same treatment those rows get on the home screen itself.
  `disabled` is what refuses; `reason` is what is said instead of `sub`.

  THE EMPTY STATE IS THE CALLER'S SENTENCE, NOT A DEFAULT. "you have
  none" and "I could not find out" are different answers and only the
  caller knows which one it holds, which is why `emptyMessage` comes in
  and why `emptyKind` renders as a class rather than as a tone this file
  picks.

  THE KEY LISTENER IS ON `document`, CAPTURING, and that is deliberate
  rather than copied. The arrow keys have to win against whatever had
  focus when the picker opened - the terminal, a sidebar row, a text
  input - and a listener on the overlay only sees keys once focus is
  inside it. It is removed when the modal closes, which is the half the
  hand-written version got right and the half easiest to lose in a port.

  SELECTION SKIPS DISABLED ROWS in both directions and wraps, so a list
  whose only usable row is the last one still opens on it.
-->
<script lang="ts">
    import { t as reactiveT } from '../i18n/index.svelte';
    import { PROJECT_CREATE_KEYS } from '../../../../client/js/labels/project-create.js';
    import type { Translate } from '../sessions/types';
    import type { ChoiceItem } from './modal-types';
    import ModalShell from './ModalShell.svelte';

    interface Props {
        /** The header sentence, already translated. */
        title: string;
        /** The keyboard hint, already translated, or null for the default. */
        hint?: string | null;
        items?: ChoiceItem[];
        /** What to say when there is nothing to choose from. */
        emptyMessage?: string | null;
        /** `info` or `unknown`; becomes a modifier class. */
        emptyKind?: string;
        t?: Translate;
        close: (value: string | null) => void;
    }

    let {
        title,
        hint = null,
        items = [],
        emptyMessage = null,
        emptyKind = 'info',
        t = reactiveT,
        close,
    }: Props = $props();

    /** Indices of the rows that can actually be chosen. */
    const selectable = $derived(
        items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0),
    );

    let active = $state(-1);
    // THE ROW ELEMENTS ARE BOUND, NOT QUERIED. A `querySelector` scoped
    // to this component's own container would be correct here and is
    // still not worth it: `theme-discipline.test.ts` forbids the call
    // outright in a component, because "reaches into its own DOM" and
    // "reaches into someone else's" are indistinguishable to a source
    // scan, and the guard is more valuable strict than clever.
    const rowEls: Array<HTMLDivElement | null> = $state([]);

    // The first selectable row starts active. Derived once from the
    // incoming list rather than reassigned on every render, so moving the
    // selection is not undone by the next repaint.
    $effect(() => {
        if (active === -1 && selectable.length) active = selectable[0] ?? -1;
    });

    // Keep the active row in view. `block: 'nearest'` is what the
    // hand-written version used: it scrolls only when the row is actually
    // out of the box, so walking a short list does not jump the page.
    $effect(() => {
        if (active < 0) return;
        const row = rowEls[active];
        // Capability-checked rather than assumed: `scrollIntoView` is a
        // browser affordance and not part of the DOM spec jsdom
        // implements, and a missing scroll must never break a picker
        // that is otherwise perfectly usable.
        if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    });

    /**
     * Move the selection by one selectable row, wrapping at both ends.
     *
     * Inputs: direction (number) - 1 down, -1 up. Output: void.
     */
    function step(direction: number): void {
        if (!selectable.length) return;
        const at = selectable.indexOf(active);
        const next = at < 0 ? 0 : (at + direction + selectable.length) % selectable.length;
        active = selectable[next] ?? active;
    }

    /**
     * Choose a row by index, refusing a disabled one.
     *
     * Inputs: index (number). Output: void.
     */
    function choose(index: number): void {
        const item = items[index];
        if (!item || item.disabled) return;
        close(item.key);
    }

    $effect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(null);
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                step(1);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                step(-1);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                if (active >= 0) choose(active);
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    });
</script>

<ModalShell {title} onCancel={() => close(null)}>
    <div class="folder-picker-list" tabindex="-1">
        {#if items.length}
            {#each items as item, i (item.key)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="folder-picker-item"
                    class:folder-picker-item-disabled={item.disabled}
                    class:folder-picker-item-active={i === active}
                    data-choice-index={i}
                    aria-disabled={item.disabled ? 'true' : undefined}
                    bind:this={rowEls[i]}
                    onclick={() => choose(i)}
                >
                    <div class="folder-picker-item-label">{item.label}</div>
                    {#if item.disabled && item.reason}
                        <div class="folder-picker-item-sub">{item.reason}</div>
                    {:else if item.sub}
                        <div class="folder-picker-item-sub">{item.sub}</div>
                    {/if}
                </div>
            {/each}
        {:else}
            <div class="folder-picker-empty folder-picker-empty--{emptyKind}">
                {emptyMessage || t(PROJECT_CREATE_KEYS.choiceEmptyFallback)}
            </div>
        {/if}
    </div>
    <div class="modal-description">
        {items.length
            ? hint || t(PROJECT_CREATE_KEYS.choiceHint)
            : t(PROJECT_CREATE_KEYS.choiceEmptyHint)}
    </div>
    {#snippet footer()}
        <button class="modal-btn modal-btn-secondary" data-choice-cancel onclick={() => close(null)}>
            {items.length ? t(PROJECT_CREATE_KEYS.cancel) : t(PROJECT_CREATE_KEYS.choiceOk)}
        </button>
    {/snippet}
</ModalShell>
