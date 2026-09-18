<!--
  ChatChain - the drill-chain breadcrumb: which conversation you are in,
  and how you get back.

  EVERY LEVEL EXCEPT THE LAST IS A CONTROL that goes there; the last is
  marked current and is NOT a control, because a button that does nothing
  is worse than a label. That is what makes a four-deep chain one click
  from the top instead of four - and the nesting really does go that
  deep: measured, the corpus links 519 transcripts at depth 3, 274 at 4
  and 158 at 5.

  A ONE-LEVEL CHAIN STILL RENDERS. It is how the reader knows they are at
  the top rather than lost, and it is where the chain appears from as
  soon as they drill.

  A LEVEL WHOSE LABEL IS NOT KNOWN SAYS SO. A breadcrumb that invents
  "Subagent" for a row the server never named is a fact manufactured by
  the navigation.

  Ported from the render half of client/js/archive-chat-stack.js.
-->
<script lang="ts">
    import { ACTIONS, CLASS } from './chat-vocab';
    import { crumbText, type ChainLevel } from './chat-stack';

    interface Props {
        /** The chain, root first. */
        levels: readonly ChainLevel[];
        /** Go back up to one level, dropping everything below it. */
        onUp: (index: number) => void;
    }

    let { levels, onUp }: Props = $props();
</script>

<nav class={CLASS.chain} aria-label="Subagent drill chain" data-depth={levels.length}>
    {#if levels.length === 0}
        <p class={CLASS.chainNone}>No conversation open.</p>
    {:else}
        {#each levels as level, i (i)}
            {#if i === levels.length - 1}
                <span class={CLASS.chainHere} aria-current="true" data-level={i}
                >{crumbText(level)}</span>
            {:else}
                <button
                    type="button"
                    class={CLASS.chainUp}
                    data-action={ACTIONS.CHAIN_UP}
                    data-level={i}
                    aria-label="Back up to {crumbText(level)}"
                    onclick={() => onUp(i)}
                >{crumbText(level)}</button>
                <span class={CLASS.chainSep}>&gt;</span>
            {/if}
        {/each}
    {/if}
</nav>
