<!--
  ReaderStatus - the reader's header facts and its non-ok states.

  WHY IT IS ITS OWN COMPONENT. `TranscriptReader.svelte` owns the
  scroller, the frame loop and the windowing. This owns what the reader
  says when it is NOT showing rows, which changes for entirely different
  reasons, and splitting it keeps that component under this project's
  500-line guideline without inventing a seam.

  A FAILURE IS NEVER A BLANK PANE. The token is always stated in words,
  the transport reason too when there is one, and a host-supplied richer
  block is appended beneath. A reader that failed silently is
  indistinguishable from a transcript with no lines, which is the false
  green this whole screen is built to avoid.

  THE HOST'S OUTCOME BLOCK IS APPENDED, NEVER `{@html}`-ed.
  `archive-outcome-view.js` is a later slice and returns a real DOM
  `Element`; an action attaches it and removes it on teardown, so Svelte
  is not asked to own a subtree it did not build and no string is ever
  parsed as markup.

  NULL HEADER IS NOT AN EMPTY HEADER. It means no header request has
  succeeded yet, so nothing is rendered rather than blank facts being
  invented. See `reader-header.ts`.
-->
<script lang="ts">
    import { CLASS, READER_OK, READER_LOADING } from './reader-vocab';
    import type { HeaderFacts } from './reader-header';

    interface Props {
        /** The two header sentences, or null when no record arrived. */
        facts: HeaderFacts | null;
        /** The reader's outcome token, or 'idle' / 'loading'. */
        token: string;
        /** Why there is no envelope, or null when the server answered. */
        transportError: string | null;
        /** A host-rendered outcome element, or null. */
        outcomeNode: Element | null;
    }

    let { facts, token, transportError, outcomeNode }: Props = $props();

    /**
     * Attach a host-rendered outcome element.
     *
     * Description: an ACTION rather than `{@html}`, because the host
     *   hands back a real Element and a string would have to be parsed.
     *   The teardown removes exactly the node it added, so a token change
     *   cannot leave two stacked blocks behind.
     * Inputs: node - the mount point. el - the element, or null.
     * Output: a Svelte action handle.
     */
    function attach(node: HTMLElement, el: Element | null): { destroy(): void } {
        if (el) node.appendChild(el);
        return {
            destroy(): void {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            },
        };
    }
</script>

<div class={CLASS.header}>
    {#if facts}
        <div class={CLASS.headerFacts}>
            <h2 class={CLASS.title}>{facts.title}</h2>
            <p class={CLASS.facts}>{facts.facts}</p>
        </div>
    {/if}
</div>

<div class={CLASS.status} data-reader-state={token}>
    {#if token !== READER_OK}
        <p class={CLASS.facts}>
            {#if token === READER_LOADING}
                Loading this transcript...
            {:else if transportError}
                The request did not complete: {transportError}
            {:else}
                This transcript could not be read. The server answered {token}.
            {/if}
        </p>
        {#if outcomeNode}
            <div use:attach={outcomeNode}></div>
        {/if}
    {/if}
</div>
