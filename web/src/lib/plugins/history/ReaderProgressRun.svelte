<!--
  ReaderProgressRun - a run of consecutive `progress` lines as ONE
  counted row, collapsed or expanded.

  `progress` IS 917,436 ROWS, 37.49 PERCENT OF ALL BODIES (measured
  2026-08-31). NOTHING IS HIDDEN: the count and the line range are both
  stated, and the run is one action away from being expanded. A filter
  that silently removed 37 percent of a byte-exact archive would be a
  client-side lie about the file's contents, which is why this folds
  rather than filters.

  EXPANDING IS AN ORDINARY HEIGHT CORRECTION, not a separate layout
  mode. A collapsed run participates in the offset table as one row at
  `PROGRESS_ROW_PX`; expanded, it is its children stacked, and the real
  height is measured next frame exactly like any other row. That is why
  the virtual list needs no notion of a run at all.

  Ported from `renderProgressRun` in client/js/archive-line-render.js.
-->
<script lang="ts">
    import { ACTIONS, CLASS, PROGRESS_RUN_MOD } from './reader-vocab';
    import { rangeText, type ProgressRun } from './reader-rows';
    import ReaderRow from './ReaderRow.svelte';
    import type { BodyEntry } from './reader-body-cache';
    import type { SpineRow } from './reader-rows';

    interface Props {
        /** The folded run. */
        run: ProgressRun;
        /** Whether its children are showing. */
        expanded: boolean;
        /** Its index in the laid-out items, for the measurement read. */
        index: number;
        /** True when the selection cursor is on this run. */
        selected: boolean;
        /** The body-request policy's reader, for expanded children. */
        entryFor: (row: SpineRow) => BodyEntry | null;
        /** Toggle, or run a child's body action. */
        onAction: (action: string, index: number) => void;
    }

    let { run, expanded, index, selected, entryFor, onAction }: Props = $props();

    const toggle = $derived(expanded ? ACTIONS.COLLAPSE : ACTIONS.EXPAND);
</script>

<!--
  THE ROVING TABINDEX IS KEPT, AND THE LINT IS SILENCED DELIBERATELY.
  `a11y_no_noninteractive_tabindex` fires because an `<article>` has no
  interactive role. The alternatives were both worse. Giving the row
  `role="option"` inside a `role="listbox"` would be the textbook roving
  cursor, and it is INVALID here: a row legitimately contains buttons
  ("Render anyway", "Expand"), and an `option` may not contain
  interactive descendants, so a screen reader would stop announcing them.
  Dropping the tabindex would make the selection cursor unreachable by
  keyboard, which is the feature `reader-select` exists for. So the
  vanilla shape is preserved verbatim: exactly one RENDERED row carries
  `tabindex="0"`, every other carries `-1`, and a selection outside the
  window puts the attribute nowhere - the cursor still holds the index
  and the row gets it back when it next paints. Named as a forced choice.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
    class="{CLASS.row} {PROGRESS_RUN_MOD}"
    data-record-type="progress"
    data-family="progress"
    data-progress-count={String(run.count)}
    data-expanded={expanded ? 'true' : 'false'}
    data-line-no={String(run.from)}
    data-index={index}
    data-selected={selected ? 'true' : undefined}
    tabindex={selected ? 0 : -1}
>
    <div class={CLASS.head}>
        <span class={CLASS.lineno}>{String(run.from)}</span>
        <span class={CLASS.chip}>progress x {run.count}</span>
        <span class={CLASS.range}>{rangeText(run)}</span>
        <button
            type="button"
            class={CLASS.action}
            data-action={toggle}
            onclick={() => onAction(toggle, index)}
        >{expanded ? 'Collapse' : 'Expand'}</button>
    </div>

    {#if expanded}
        <div class={CLASS.progressChildren}>
            {#each run.rows as child (child.line_no)}
                <!--
                  `index` IS NULL, DELIBERATELY. A child is not a
                  laid-out item; its height is part of this run's, and
                  stamping the run's index on it would make the
                  reconcile write a child's height as the run's. It
                  still reports its ACTIONS under the run's index, which
                  is where the click router can resolve them.
                -->
                <ReaderRow
                    row={child}
                    entry={entryFor(child)}
                    index={null}
                    actionIndex={index}
                    selected={false}
                    onAction={onAction}
                />
            {/each}
        </div>
    {/if}
</article>
