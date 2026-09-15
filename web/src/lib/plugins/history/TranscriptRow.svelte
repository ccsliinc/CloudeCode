<!--
  TranscriptRow - one transcript in the archive list.

  EVERY CLASS NAME COMES FROM `tlist-vocab.ts` AND NONE IS WRITTEN HERE.
  Issue #173 promises Adam's re-skin that this migration introduces no
  new class name, and the only way to hold that promise is to make the
  template unable to spell one. `CLASS` is the table; a class not in it
  does not exist. That also keeps
  `tests/test_archive_tlist_styled.node.mjs`'s antijoin meaningful: the
  names are recoverable from one file rather than scattered through
  markup.

  THE NAME LEADS, AND A GUESS NEVER RENDERS AS A NAME. The row used to
  lead with a bare UUID, the one field on it nobody recognises. It now
  leads with the title when there is one and with the session_ref when
  there is not, and `data-is-title` carries which - because rendering the
  ref in the title's own treatment would present every unnamed session as
  though somebody had named it after its UUID. The badge beside it says
  what produced the name, and `custom-title` (a person typed it) and
  `last-prompt` (an excerpt off the last thing typed, measured values
  include "yes" and "exirt") must never look alike.

  `session_ref` IS NOT AN IDENTITY. Measured: `journal` names 14
  different transcripts. `transcript_id` is on the `<li>` AND on the
  button, so no click path can end up keyed on the label.

  THE MODIFIER IS A LITERAL FROM THE TABLE, never `'__source--' + kind`.
  A computed class cannot be recovered from the source by the stylesheet
  antijoin, so a modifier with no rule anywhere would render in
  user-agent defaults and no test could see it - which is the exact
  defect that test exists for.

  THE `title` ATTRIBUTE IS THE OTHER HALF OF TRUNCATION. Every label in
  this pane is clipped with an ellipsis rather than wrapped, so without
  it a long name becomes unreadable with no way back.

  Ported from `renderRow` in client/js/archive-tlist-row.js.
-->
<script lang="ts">
    import { CLASS } from './tlist-vocab';
    import {
        displayTitle,
        isUnestablished,
        titleSource,
        type TranscriptRowData,
    } from './tlist-row';
    import { formatBytes, formatCount, formatTimestamp } from './format';
    import type { FuzzyMatcher, SpanMap } from './tlist-fuzzy';
    import FuzzyLabel from './FuzzyLabel.svelte';

    interface Props {
        /** One row as the archive listing routes return it. */
        row: TranscriptRowData;
        /**
         * True only in the unattributed listing. Drives the NO PROJECT
         * badge, which is a SEPARATE condition from host attribution and
         * is never merged with it.
         */
        unattributed?: boolean;
        /** Fuzzy match spans by column key, or null when nothing is typed. */
        spans?: SpanMap | null;
        /** The injected fuzzy matcher, for highlighting. Optional. */
        fuzzy?: FuzzyMatcher | null;
        /** Whether the keyboard cursor is on this row. */
        selected?: boolean;
        /** Open this transcript. Called with the id, never with the ref. */
        onSelect?: (transcriptId: number | string, row: TranscriptRowData) => void;
    }

    let {
        row,
        unattributed = false,
        spans = null,
        fuzzy = null,
        selected = false,
        onSelect,
    }: Props = $props();

    const shown = $derived(displayTitle(row));
    const source = $derived(titleSource(row));
    const hostUnestablished = $derived(isUnestablished(row.host_attribution));
    const refText = $derived(
        row.session_ref === null || row.session_ref === undefined
            ? 'no session_ref recorded'
            : String(row.session_ref),
    );

    /**
     * Hand the id to the caller. Guarded because `onSelect` is optional
     * and a list rendered for inspection has no handler.
     * Inputs: none. Output: void.
     */
    function open(): void {
        if (typeof onSelect !== 'function') return;
        if (row.transcript_id === null || row.transcript_id === undefined) return;
        onSelect(row.transcript_id, row);
    }
</script>

<li
    class={CLASS.row}
    data-transcript-id={String(row.transcript_id)}
    data-scheme={String(row.session_ref_scheme || 'unknown')}
    data-selected={selected ? 'true' : 'false'}
>
    <button
        class={CLASS.open}
        type="button"
        data-action="open-transcript"
        data-transcript-id={String(row.transcript_id)}
        onclick={open}
    >
        <span
            class={CLASS.title}
            data-is-title={shown.isTitle ? 'true' : 'false'}
            title={shown.text}
        >
            <FuzzyLabel text={shown.text} spans={spans?.title ?? null} {fuzzy} />
        </span>

        <span
            class="{CLASS.source} {source.mod}"
            data-title-source={row.title_source === null
                || row.title_source === undefined
                ? 'none'
                : String(row.title_source)}
            title={source.hint}
        >{source.label}</span>

        <span class={CLASS.ref} title={refText}>
            <FuzzyLabel text={refText} spans={spans?.ref ?? null} {fuzzy} />
        </span>

        <span class={CLASS.id}>transcript {row.transcript_id}</span>
        <span class={CLASS.lines}>{formatCount(row.line_count)} lines</span>
        <span class={CLASS.bytes}>{formatBytes(row.raw_byte_length)}</span>

        <span class={CLASS.ingested} title={formatTimestamp(row.ingested_at)}>
            <FuzzyLabel
                text={formatTimestamp(row.ingested_at)}
                spans={spans?.date ?? null}
                {fuzzy}
            />
        </span>

        {#if unattributed}
            <span class="{CLASS.badge} {CLASS.badgeNoProject}"
                >NO PROJECT: this transcript is attributed to no project</span>
        {/if}
        {#if hostUnestablished}
            <span class="{CLASS.badge} {CLASS.badgeHostUnknown}"
                >HOST NOT ESTABLISHED: host_attribution is {String(
                    row.host_attribution,
                )}. This is a separate condition from having no project.</span>
        {/if}
    </button>
</li>
