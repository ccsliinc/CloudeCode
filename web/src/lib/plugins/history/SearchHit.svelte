<!--
  SearchHit - one search result, with its preview verdict already
  decided.

  IT CANNOT PAINT A WITHHELD PREVIEW. Its only prop is a `HitView`, which
  has no `snippet` field and no raw hit on it; the one route to preview
  text is `view.preview`, and text exists on exactly one of that union's
  three shapes. So `{view.preview.text}` below is reachable only inside
  the `kind === 'text'` branch, and the other two branches have nothing
  to interpolate even if somebody tried. That is the security property as
  a type error rather than as a rule in a review.

  A WITHHELD PREVIEW IS A REAL HIT AND TAKES THE SAME ROW SHAPE. The
  server says so itself (`withholding_never_suppresses_a_hit: true`), so
  the locating facts - transcript, session_ref, line, offset, length -
  are painted identically on every verdict, and only the preview cell
  differs. Dropping the row would under-report the count; painting it
  quieter would make a withheld hit read as an absent one.

  `data-snippet-state` CARRIES THE SERVER'S WORD, NOT THIS CLIENT'S. An
  operator reading the DOM needs to know which state the server actually
  sent, including one this client refuses to recognise. The RENDERING
  decision is `view.preview`, and the two are deliberately allowed to
  disagree: a `data-snippet-state="included"` beside a withheld cell is
  exactly the 9.7-percent case, visible.

  NO `{@html}`. Snippets are body-derived text from a corpus that holds
  every character a file can hold.
-->
<script lang="ts">
    import { CLASS, PREVIEW_WITHHELD_LABEL, WITHHELD_LEAD } from './search-vocab';
    import { EGRESS_NONE, EGRESS_TEXT, EGRESS_WITHHELD } from './mask-egress';
    import { NO_TRANSCRIPT_ID, type HitView } from './search-hit';

    interface Props {
        /** The hit, already through the egress door. */
        view: HitView;
        /** Open this hit. Absent leaves the control inert but present. */
        onOpen?: (transcriptId: number | string, lineNo: number | null) => void;
    }

    let { view, onOpen }: Props = $props();

    /**
     * How many findings the body declares, as a phrase.
     *
     * Description: a count the server did not state renders as the
     *   general phrase rather than as zero, because zero is a positive
     *   claim that the body is clean and nobody measured that here.
     */
    const findings = $derived(
        view.preview.kind === EGRESS_WITHHELD && view.preview.findingCount !== null
            ? `${view.preview.findingCount} secret finding(s)`
            : 'secret findings',
    );
</script>

<li
    class={CLASS.hit}
    data-transcript-id={view.transcriptId}
    data-line-no={view.lineNo}
    data-snippet-state={view.snippetState}
    data-preview={view.withheld ? 'withheld' : null}
>
    <button
        class={CLASS.hitLoc}
        type="button"
        data-action="open-hit"
        data-transcript-id={view.transcriptId}
        disabled={!view.openable}
        data-blocked-reason={view.openable ? null : NO_TRANSCRIPT_ID}
        onclick={() => {
            if (view.transcriptId !== null) onOpen?.(view.transcriptId, view.lineNo);
        }}
    >
        <span class={CLASS.hitTranscript}>{view.transcriptLabel}</span>
        <span class={CLASS.hitRef}>{view.refLabel}</span>
        <span class={CLASS.hitLine}>{view.lineLabel}</span>
        <span class={CLASS.hitOffset}>{view.offsetLabel}</span>
    </button>

    {#if view.preview.kind === EGRESS_TEXT}
        <div class={CLASS.preview}>{view.preview.text}</div>
    {:else if view.preview.kind === EGRESS_NONE}
        <div class={CLASS.preview}>{view.preview.reason}</div>
    {:else if view.preview.kind === EGRESS_WITHHELD}
        <div class="{CLASS.preview} {CLASS.previewWithheld}">
            <span class={CLASS.previewLabel}>{PREVIEW_WITHHELD_LABEL}</span>
            <span class={CLASS.previewNote}
                >{WITHHELD_LEAD} The server or this client declined to show preview text
                because {findings} are involved: {view.preview.reason}. Open the line to
                read it with offset masking applied.</span
            >
        </div>
    {/if}
</li>
