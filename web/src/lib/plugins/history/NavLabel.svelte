<!--
  NavLabel - one rail label with its fuzzy-matched characters marked.

  NO innerHTML AND NO {@html}. Slugs and folder names in this corpus are
  filesystem paths containing real punctuation and a U+2019; they are
  text and they reach the DOM as text. The marks are real elements in a
  keyed each, so the refusal survives the port by construction rather
  than by discipline.

  THE GUARD IS THE VANILLA GUARD, KEPT VERBATIM IN MEANING: positions
  index the string the MATCHER read, so they are only applied when the
  text being drawn IS that string. The card draws the overlay's name,
  which may be an override the matcher never saw - marking position 4 of
  a name nobody searched would mark an arbitrary character. `matched`
  carries that comparison in from the caller, which owns both strings.

  THE PLAIN RUNS ARE BARE TEXT, not the unclassed `<span>` the vanilla
  builder emitted. That is a markup simplification and it is named
  because commitment 1 is about class names: it emits none, and
  `.archive-nav__hilite` - which has no rule in any of the 12
  stylesheets and never had one - is still emitted, so nothing a
  stylesheet can reach has changed.
-->
<script lang="ts">
    import { CLASS } from './nav-vocab';
    import { segments, type NavSegment } from './nav-fuzzy';

    interface Props {
        /** The full text of the label. */
        text: string;
        /** Matched character indices, or null when nothing is typed. */
        positions?: readonly number[] | null;
        /**
         * Whether those positions were measured against THIS text. False
         * draws the label plain, which is the vanilla fallback.
         */
        matched?: boolean;
    }

    let { text, positions = null, matched = false }: Props = $props();

    const safe = $derived(String(text === null || text === undefined ? '' : text));

    const runs = $derived<readonly NavSegment[]>(
        matched && positions && positions.length
            ? segments(safe, positions)
            : [{ text: safe, hit: false }],
    );
</script>

<span class={CLASS.hilite}>
    {#each runs as run, i (i)}
        {#if run.hit}
            <mark class={CLASS.hit}>{run.text}</mark>
        {:else}
            {run.text}
        {/if}
    {/each}
</span>
