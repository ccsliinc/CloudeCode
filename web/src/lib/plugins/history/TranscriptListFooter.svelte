<!--
  TranscriptListFooter - the paging control, the outcome block and the
  three sentences `has_more` can produce.

  `has_more` IS A THREE-OUTCOME FIELD AND THIS IS WHERE THAT SHOWS.
  The server returns `null` on every failure path - measured, the
  budget_exhausted search answered `"has_more": null`. The load-more
  control is drawn on `=== true` and on nothing else; `false` states a
  measured end; `null` states an unknown OUT LOUD. Treating null as false
  claims the end of a list that was never read, which is the quietest
  possible way to lose 3,366 of a project's 3,416 transcripts.

  A FILTER THAT MATCHES NOTHING IS A STATED EMPTY, never a blank pane.
  A blank pane is indistinguishable from a list that has not loaded, so
  the one case where this component draws neither rows nor a control is
  also the case where it says the most.

  THE OUTCOME BLOCK IS MOUNTED, NOT INTERPOLATED. The composition root
  supplies a function returning an Element, because
  `archive-outcome-view.js` is a later slice and still vanilla. `{@html}`
  would be the innerHTML this pane has refused since it shipped:
  session_ref and source_path are file-derived strings.
-->
<script lang="ts">
    import { CLASS } from './tlist-vocab';
    import { describeFooter } from './tlist-paging';
    import { formatCount } from './format';

    interface Props {
        /** `has_more` AS RECEIVED. Three-valued; null is not false. */
        hasMore: boolean | null;
        /** Rows fetched so far. */
        loaded: number;
        /** True while a page request is in flight. */
        busy: boolean;
        /** True before the first page has arrived at all. */
        loading: boolean;
        /** True when a typed filter matched none of the loaded rows. */
        filteredEmpty: boolean;
        /** Why the server did not answer, or null when it did. */
        transportError: string | null;
        /** The envelope to render, or null. */
        outcomeEnvelope: unknown;
        /** Turns an envelope into an element, or null when unsupplied. */
        renderOutcome?: ((envelope: unknown) => Element | null) | null;
        /** Fetch the next page. */
        onLoadMore?: () => void;
    }

    let {
        hasMore,
        loaded,
        busy,
        loading,
        filteredEmpty,
        transportError,
        outcomeEnvelope,
        renderOutcome = null,
        onLoadMore,
    }: Props = $props();

    const footer = $derived(describeFooter(hasMore, formatCount(loaded)));

    /** Where the composition root's outcome element is mounted. */
    let slot = $state<HTMLDivElement | null>(null);

    // A FILTERED EMPTY IS RENDERED FROM A SYNTHESISED ENVELOPE carrying
    // the same fields the server would send, so it goes through the ONE
    // outcome renderer like every other empty. There is no second
    // rendering path and the view cannot tell where the envelope came
    // from - which is what stops "your filter matched nothing" drifting
    // into looking different from "the server returned nothing".
    $effect(() => {
        const host = slot;
        if (!host) return;
        host.textContent = '';
        if (typeof renderOutcome !== 'function') return;
        const envelope = filteredEmpty
            ? {
                result: [], result_status: 'ok', scope_status: 'resolved',
                unevaluated: [], meta: {},
            }
            : outcomeEnvelope;
        if (envelope === null || envelope === undefined) return;
        const block = renderOutcome(envelope);
        if (block) host.appendChild(block);
    });
</script>

<div class={CLASS.footer}>
    {#if loading}
        <p class={CLASS.loading}>loading...</p>
    {:else}
        <div bind:this={slot}></div>

        {#if transportError}
            <p class={CLASS.transportReason}>{transportError}</p>
        {/if}

        {#if filteredEmpty}
            <p class={CLASS.end}>
                None of the {formatCount(loaded)} rows loaded so far match the
                name/ref/date filter. Rows on pages that have not been loaded
                were NOT searched.
            </p>
        {:else if footer.offerMore}
            <button
                class={CLASS.more}
                type="button"
                data-action="load-more"
                disabled={busy}
                onclick={() => onLoadMore?.()}
            >{footer.text}</button>
        {:else}
            <p class="{CLASS.end}{footer.unknown ? ` ${CLASS.endUnknown}` : ''}"
                >{footer.text}</p>
        {/if}
    {/if}
</div>
