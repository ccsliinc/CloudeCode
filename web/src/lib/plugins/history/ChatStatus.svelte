<!--
  ChatStatus - what the conversation view says when it is NOT showing
  turns, and the banner it shows beside them when the answer was partial.

  A FAILURE IS NEVER A BLANK PANE. The token is always stated in words,
  the transport reason too when there is one, and a host-supplied richer
  block is appended beneath. A chat pane that failed silently is
  indistinguishable from a transcript with no messages, which is the
  false green this whole screen exists to avoid - and the transcript this
  view was built against has 30,805 lines.

  A FORCED CHOICE, NAMED IN THE COMMIT MESSAGE: the sentence carries NO
  CLASS AT ALL. The vanilla rendered this region through
  `archive-outcome-view.js`, whose `archive-outcome-*` vocabulary belongs
  to slice 9. Borrowing an unrelated chat class for a failure sentence
  would be worse than plain type, and inventing one would break
  commitment 1, so the `<p>` is unclassed and inherits the app's base
  type inside `.archive-chat__status`.

  THE HOST'S OUTCOME BLOCK IS APPENDED, NEVER `{@html}`-ed.
  `archive-outcome-view.js` returns a real DOM Element; an action
  attaches it and removes exactly the node it added on teardown, so
  Svelte is not asked to own a subtree it did not build and no string is
  ever parsed as markup.
-->
<script lang="ts">
    import { CHAT_OK, CLASS } from './chat-vocab';

    interface Props {
        /** The outcome token, or 'idle' / 'loading'. */
        token: string;
        /** Why there is no envelope, or null when the server answered. */
        transportError: string | null;
        /** A host-rendered outcome element, or null. */
        outcomeNode: Element | null;
    }

    let { token, transportError, outcomeNode }: Props = $props();

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

<div class={CLASS.status} data-chat-state={token}>
    {#if token !== CHAT_OK}
        <p>
            {#if token === 'loading'}
                Loading this conversation...
            {:else if token === 'idle'}
                No conversation open.
            {:else if transportError}
                The request did not complete: {transportError}
            {:else if token === 'partial'}
                This is a PARTIAL answer. Some of the conversation was reached and
                some was not; what follows is what arrived.
            {:else}
                This conversation could not be built. The server answered {token}.
                That is not a claim that the transcript is empty; the raw view
                reads the same transcript from a different endpoint.
            {/if}
        </p>
        {#if outcomeNode}
            <div use:attach={outcomeNode}></div>
        {/if}
    {/if}
</div>
