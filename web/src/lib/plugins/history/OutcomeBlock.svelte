<!--
  OutcomeBlock - one archive outcome, on FOUR independent channels.

  THE WORK IS IN `outcome-view.ts`. This file paints a model and decides
  nothing: no branch here reads `result_status`, `scope_status` or
  `meta.scan.status`, and the token arrives already classified by the
  injected `OutcomeClassifier` that slices 5, 6 and 7 all consume. A
  second interpreter of those fields is how a `partial` starts rendering
  as an `ok`.

  THE FOUR CHANNELS, and no single one is load-bearing on its own: the
  WORDS (including the server's `unevaluated` reasons, verbatim), the
  CLASS (`archive-outcome--<token>`, a literal from `TOKEN_MOD`), the
  ATTRIBUTE (`data-outcome`) and the ACTIONS - which affordances EXIST in
  this subtree, the hardest channel to fake because it is structural.
  Colour is not a channel; nor is border-radius, since three of this
  app's 23 themes zero every radius token on purpose.

  NO `{@html}`. Every string reaches the DOM through interpolation, which
  escapes. Server `reason` strings are rendered verbatim by requirement
  and host display names carry real non-ASCII, so this is not a
  hypothetical.

  A DISABLED ACTION IS EMITTED, NOT DROPPED. A `partial` with no
  `resume_cursor` cannot be resumed; the control still exists, disabled,
  carrying `data-blocked-reason`. Dropping it would erase the structural
  difference between two outcomes, which is the one channel that cannot
  be faked.
-->
<script lang="ts">
    import { CLASS, TOKEN_MOD } from './outcome-vocab';
    import type { OutcomeBlockModel } from './outcome-view';

    interface Props {
        /** The computed block. Built by `outcomeBlock()`, never here. */
        model: OutcomeBlockModel;
        /** Why the server did not answer, or null when it did. */
        transportError?: string | null;
        /** Fired when an affordance is used. The host decides what happens. */
        onAction?: (action: string) => void;
    }

    let { model, transportError = null, onAction }: Props = $props();

    /**
     * The modifier class for this token.
     *
     * Description: read from the LITERAL table, never composed. A
     *   computed `--${token}` is invisible to the stylesheet antijoin
     *   that enforces commitment 2, so a modifier with no rule anywhere
     *   would render in user-agent defaults with no test able to see it.
     *   A token with no entry contributes NO class rather than an
     *   invented one.
     */
    const mod = $derived(TOKEN_MOD[model.token] ?? '');
</script>

<div
    class="{CLASS.root} {mod}"
    data-outcome={model.token}
>
    <p class={CLASS.label}>{model.label}</p>
    <p class={CLASS.headline}>{model.headline}</p>

    {#if model.reasons.length > 0}
        <ul class={CLASS.reasons}>
            {#each model.reasons as reason (reason.subject + reason.text)}
                <li class={CLASS.reason}>
                    <span class={CLASS.reasonSubject}>{reason.subject}</span>
                    <span class={CLASS.reasonText}>{reason.text}</span>
                </li>
            {/each}
        </ul>
    {/if}

    {#if model.coverage}
        <p class={CLASS.coverage}>
            <span class={CLASS.coverageCounts}>{model.coverage.counts}</span>
            {#if model.coverage.gap}
                <span class={CLASS.coverageGap}>{model.coverage.gap}</span>
            {/if}
            {#if model.coverage.charge}
                <span class={CLASS.coverageCharge}>{model.coverage.charge}</span>
            {/if}
        </p>
    {/if}

    {#if transportError}
        <p class={CLASS.transportReason}>{transportError}</p>
    {/if}

    <div class={CLASS.actions}>
        {#each model.actions as act (act.action)}
            <button
                class={CLASS.action}
                type="button"
                data-action={act.action}
                disabled={act.disabled}
                data-blocked-reason={act.blockedReason}
                onclick={() => onAction?.(act.action)}
            >{act.label}</button>
        {/each}
    </div>
</div>
