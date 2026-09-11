<!--
  One paragraph of help prose, with its inline markers expanded.

  NO `{@html}` ANYWHERE ON THIS PATH, and that is the whole reason this
  is a component rather than a string builder. `richSegments` returns
  DATA - a list of {kind, text} - and this renders each run through
  Svelte's own `{expr}` escaping. The plan's section 4 names an `{@html}`
  as the review trigger for this screen; the one surface that needed
  rich text is how it avoids being one.

  See ./rich-text.ts for why the markers exist at all: a paragraph split
  into fragments around its <code> spans fixes the english word order
  into the template, and word order is exactly what a translation
  changes.
-->
<script lang="ts">
    import { richSegments } from './rich-text';

    interface Props {
        /** An already-translated, already-interpolated message. */
        message: string;
        /** Where a `<<link>>` run points. */
        href?: string | null;
    }

    const { message, href = null }: Props = $props();

    const segments = $derived(richSegments(message));
</script>

{#each segments as segment (segment)}
    {#if segment.kind === 'code'}
        <code>{segment.text}</code>
    {:else if segment.kind === 'em'}
        <em>{segment.text}</em>
    {:else if segment.kind === 'link' && href}
        <a {href} target="_blank" rel="noopener">{segment.text}</a>
    {:else}{segment.text}{/if}
{/each}
