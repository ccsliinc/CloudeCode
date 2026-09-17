<!--
  ReaderRow - one archive line: its head, its metadata line and its body.

  ROLE IS NULL ON 44.93 PERCENT OF BODIES and `ts` is NULL on 33,480
  (both measured 2026-08-31). A reader keyed on role blanks half its
  rows, so the label comes from `roleLabel`'s NORMATIVE chain - role,
  then record_type, then the literal words "no role recorded" - and the
  rung that produced it travels out as `data-role-source` so a test can
  assert WHICH one fired rather than only what it said. A blank cell is a
  could-not-evaluate laundered into whitespace.

  THE RECORD TYPE IS ALWAYS SHOWN, even when it also supplied the role
  label. Two columns saying the same thing is cheaper than a reader
  guessing which one they are looking at.

  SUBAGENT LINEAGE IS TEXT, NOT COLOUR. A sidechain line came from a
  spawned agent's own file, and conflating it with the main thread is how
  a transcript reads as if the operator said something an agent said.
  Three of this app's 23 themes zero every radius token on purpose, so
  every badge here differs by its WORDS and its `data-badge` before any
  styling is considered.

  THE MODEL COLUMN IS NOT ALL CLAUDE. Measured, the 13 values include
  `nemotron-3-super` and a literal `<synthetic>`. Nothing here tests for
  a "claude-" prefix, and the value renders as text exactly as stored,
  angle brackets and all.

  Ported from `renderLine` and `renderMeta` in
  client/js/archive-line-render.js.
-->
<script lang="ts">
    import { CLASS, NO_RECORD_TYPE_TEXT } from './reader-vocab';
    import {
        bodyView, familyFor, familyModFor, roleLabel, type SpineRow,
    } from './reader-rows';
    import { formatChars, formatTimestamp, NOT_KNOWN } from './format';
    import ReaderBody from './ReaderBody.svelte';
    import type { BodyEntry } from './reader-body-cache';

    interface Props {
        /** The spine row to draw. */
        row: SpineRow;
        /** Its cache entry, or null meaning NOT REQUESTED. */
        entry: BodyEntry | null;
        /**
         * Its index in the laid-out items, for the measurement read, or
         * NULL when this row is a child of an expanded progress run.
         *
         * A CHILD MUST NOT CARRY ONE. `reconcileMeasured` writes the
         * height it reads off a `data-index` node into the offset table
         * at that index, and a child of a run is not a laid-out item -
         * its own height is part of the RUN's. Stamping the run's index
         * on it would write the child's height as the run's, on every
         * child, and the offset table would converge on whichever child
         * was read last.
         */
        index: number | null;
        /** True when the selection cursor is on this row. */
        selected: boolean;
        /** Run one body action. The row does not decide what it does. */
        onAction: (action: string, index: number) => void;
        /** The index actions report under. A child reports its run's. */
        actionIndex?: number;
    }

    let { row, entry, index, selected, onAction, actionIndex }: Props = $props();

    /** Where an action lands: this row's index, or its run's. */
    const reportAt = $derived(
        typeof actionIndex === 'number' ? actionIndex : (index ?? -1),
    );

    const family = $derived(familyFor(row.record_type));
    const label = $derived(roleLabel(row));
    const sizeText = $derived(
        Number.isFinite(row.body_chars) ? formatChars(row.body_chars) : null,
    );
    const view = $derived(bodyView(entry, sizeText));

    /** The timestamp, or the shared not-known token. Never a blank. */
    const tsText = $derived(row.ts ? formatTimestamp(row.ts) : NOT_KNOWN);

    /** The agent badge's words, or null when this line names no agent. */
    const agentText = $derived(
        row.agent_id !== null && row.agent_id !== undefined
            && String(row.agent_id).length
            ? `agent ${String(row.agent_id)}`
            : null,
    );

    /**
     * The compact-boundary badge's words.
     *
     * Description: the point in the file where context was compacted
     *   away. Everything before it survives only as whatever the summary
     *   kept, which is a fact about the transcript's FIDELITY and belongs
     *   on the row rather than in a footnote.
     */
    const compactText = $derived(
        `compact boundary${row.compact_subtype
            ? ` (${String(row.compact_subtype)})` : ''}`,
    );
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
    class="{CLASS.row} {familyModFor(family)}"
    data-line-no={String(row.line_no)}
    data-record-type={String(row.record_type || '')}
    data-family={family}
    data-role-source={label.source}
    data-index={index === null ? undefined : index}
    data-selected={selected ? 'true' : undefined}
    tabindex={selected ? 0 : -1}
>
    <div class={CLASS.head}>
        <span class={CLASS.lineno}>{String(row.line_no)}</span>
        <span class={CLASS.role}>{label.text}</span>
        <span class={CLASS.type}>{String(row.record_type || NO_RECORD_TYPE_TEXT)}</span>
    </div>

    <div class={CLASS.meta}>
        <span class={CLASS.ts}>{tsText}</span>
        {#if typeof row.model === 'string' && row.model.length}
            <span class={CLASS.model}>{row.model}</span>
        {/if}
        {#if sizeText !== null}
            <span class={CLASS.size}>{sizeText}</span>
        {/if}
        {#if row.is_sidechain}
            <span class="{CLASS.badge} {CLASS.badgeSidechain}" data-badge="sidechain"
                >sidechain</span>
        {/if}
        {#if agentText !== null}
            <span class="{CLASS.badge} {CLASS.badgeAgent}" data-badge="agent"
                >{agentText}</span>
        {/if}
        {#if row.is_compact_boundary}
            <span class="{CLASS.badge} {CLASS.badgeCompact}" data-badge="compact-boundary"
                >{compactText}</span>
        {/if}
    </div>

    <ReaderBody {view} onAction={(a) => onAction(a, reportAt)} />
</article>
