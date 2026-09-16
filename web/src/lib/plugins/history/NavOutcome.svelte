<!--
  NavOutcome - a refusal, rendered where the person clicked.

  A FAILED BRANCH NEVER COLLAPSES INTO A LEAF. When expanding a host
  answers cannot_determine, that host renders the COULD NOT EVALUATE
  block INLINE, at that node, and every sibling stays usable. A branch
  that quietly renders as childless is a claim that the host has no
  corpora - a verdict nobody measured.

  THE BLOCK ITSELF IS THE COMPOSITION ROOT'S. `archive-outcome-view.js`
  is a later slice and this tree reaches for no global, so `render` is a
  PROP: an envelope in, an element out. When it is absent the envelope's
  own reasons are not drawn and the transport reason still is, which is
  the degraded state and not a blank one.

  IT IS AN `<li>` because every caller appends it into a `<ul>` level,
  which is what the vanilla renderer did.
-->
<script lang="ts">
    import { CLASS } from './nav-vocab';

    interface Props {
        /** The envelope to render, or null. */
        envelope: unknown;
        /** Why there is no envelope at all, or null. */
        transportError?: string | null;
        /** Turns an envelope into an element, or null when unsupplied. */
        render?: ((envelope: unknown) => Element | null) | null;
    }

    let { envelope, transportError = null, render = null }: Props = $props();

    /** Where the composition root's outcome element is mounted. */
    let slot = $state<HTMLDivElement | null>(null);

    $effect(() => {
        const host = slot;
        if (!host) return;
        host.textContent = '';
        if (typeof render !== 'function') return;
        // A TRANSPORT FAILURE IS RENDERED AS A NULL ENVELOPE, which is
        // exactly how `archive-outcome.js` produces `transport-error`.
        // Passing the envelope through on a transport failure would ask
        // the interpreter to read a body that never arrived.
        const payload = transportError ? null : envelope;
        if (payload === null || payload === undefined) return;
        const block = render(payload);
        if (block) host.appendChild(block);
    });
</script>

<li class={CLASS.outcome}>
    <div bind:this={slot}></div>
    {#if transportError}
        <p class={CLASS.transportReason}>{transportError}</p>
    {/if}
</li>
