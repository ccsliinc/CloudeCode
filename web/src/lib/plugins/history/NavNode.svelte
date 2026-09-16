<!--
  NavNode - one host, corpus or unattributed row.

  A PROJECT IS NOT DRAWN HERE. It is a card and it lives in
  `NavProjectCard.svelte`. The vanilla row renderer delegated the project
  kind at CALL time, so a build that forgot the card file still rendered
  projects as plain rows; a Svelte import cannot be forgotten, so the
  branch moved up to the caller and this component draws the three kinds
  that are genuinely rows.

  LABELS TRUNCATE (CSS ellipsis), NEVER WRAP. A wrapped row in a 272px
  rail pushes every sibling down and makes the tree unscannable. The full
  text goes in `title` so nothing is lost.

  THE UNATTRIBUTED NODE IS NAMED IN WORDS as well as by class, because
  its whole purpose is that it is easy to not notice. THE TONE FOLLOWS
  THE VERDICT: an ANSWERED bucket must not be painted in the warning
  colour, or the rail keeps asking a question that has already been
  answered and the colour stops meaning anything on the nodes that are
  genuinely open.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { CLASS, NODE_KINDS, NODE_MOD, type NodeKind } from './nav-vocab';
    import {
        countFor, idFor, labelFor, renderCount, titleFor, unattributedNote,
        type NavRowData,
    } from './nav-row';

    interface Props {
        kind: NodeKind;
        row: NavRowData;
        /** Whether this node can be opened into a child level. */
        expandable?: boolean;
        /** Whether its child level is open right now. */
        expanded?: boolean;
        /** Chosen, or opened. Called with the kind, the id and the row. */
        onActivate?: (kind: NodeKind, id: number | string | null, row: NavRowData) => void;
        /** Why this node is shown, when it is an unattributed one. */
        reason?: string | null;
        /** The child level, rendered by the caller that knows its shape. */
        children?: Snippet;
    }

    let {
        kind, row, expandable = false, expanded = false, onActivate,
        reason = null, children,
    }: Props = $props();

    const id = $derived(idFor(kind, row));
    const label = $derived(labelFor(kind, row));
    const tip = $derived(titleFor(kind, row));
    /**
     * `label` is always included, so a truncated LABEL is still readable
     * on hover even when there is no extra detail to add.
     */
    const title = $derived(tip ? `${label}\n${tip}` : label);
    const note = $derived(
        kind === NODE_KINDS.UNATTRIBUTED ? unattributedNote(row) : null,
    );
</script>

<li
    class="{CLASS.node} {NODE_MOD[kind]}"
    data-node-kind={kind}
    data-node-id={id === null ? '' : String(id)}
    data-unattributed-reason={reason}
>
    <button
        class={CLASS.row}
        type="button"
        data-action={expandable ? 'expand' : 'select'}
        aria-expanded={expandable ? expanded : undefined}
        {title}
        onclick={() => onActivate?.(kind, id, row)}
    >
        <span class={CLASS.label}>{label}</span>
        <span class={CLASS.count}>{renderCount(countFor(kind, row))}</span>
        {#if note}
            <span class="{CLASS.note}{note.answered ? ` ${CLASS.noteAnswered}` : ''}"
            >{note.text}</span>
        {/if}
    </button>
    {#if expandable}
        <ul class={CLASS.children}>
            {#if expanded}
                {@render children?.()}
            {/if}
        </ul>
    {/if}
</li>
