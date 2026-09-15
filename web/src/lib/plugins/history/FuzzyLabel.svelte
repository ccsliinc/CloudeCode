<!--
  FuzzyLabel - one label with its fuzzy-matched characters marked.

  ONE PLACE WRITES LABEL TEXT, which is what the vanilla `fillLabel` was
  for. Every label in this pane is clipped with an ellipsis rather than
  wrapped, so the `title` attribute carrying the full text is not a nicety
  - without it a long name becomes unreadable with no way back. The
  attribute is set by the CALLER here rather than by this component,
  because the caller owns the element that gets clipped; this component
  owns only the inside of it.

  NO innerHTML AND NO {@html}. session_ref and source_path are
  file-derived strings and the vanilla renderer refused innerHTML for
  exactly that reason. The marks are real elements in a keyed each, so
  the refusal survives the port by construction rather than by
  discipline.

  NO MATCHER MEANS ONE PLAIN SEGMENT, which is the vanilla fallback
  (`spans && spans.length && window.ArchiveFuzzy` - all three had to hold
  before it segmented anything).
-->
<script lang="ts">
    import { CLASS } from './tlist-vocab';
    import type { FuzzyMatcher, LabelSegment, MatchSpan } from './tlist-fuzzy';

    interface Props {
        /** The full text of the label. */
        text: string;
        /** Matched ranges, or null when nothing is typed. */
        spans?: readonly MatchSpan[] | null;
        /** The injected matcher, which owns how a span becomes segments. */
        fuzzy?: FuzzyMatcher | null;
    }

    let { text, spans = null, fuzzy = null }: Props = $props();

    const safe = $derived(
        String(text === null || text === undefined ? '' : text),
    );

    const segments = $derived<readonly LabelSegment[]>(
        spans && spans.length && fuzzy
            ? fuzzy.segments(safe, spans)
            : [{ text: safe, hit: false }],
    );
</script>

{#each segments as seg, i (i)}
    {#if seg.hit}
        <mark class={CLASS.hit}>{seg.text}</mark>
    {:else}
        {seg.text}
    {/if}
{/each}
