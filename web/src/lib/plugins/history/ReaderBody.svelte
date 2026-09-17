<!--
  ReaderBody - the body region of one transcript row, in whichever of the
  eight states it is in.

  A BODY WITH FINDINGS IS NEVER RENDERED UNMASKED. This component does
  not read `body_json`, does not read `secrets`, and does not slice a
  string by offset. It renders `view.text`, which `reader-rows.bodyView`
  took from a cache entry, which `reader-body-cache.ingest` produced by
  running `reader-mask.maskBody`, and which is `null` on every refusal
  path. The ONLY way to render text here is to hand it text a masker
  already approved. That is deliberate: the failure mode of "mask in the
  renderer" is a half-masked body, and a half-masked body does not look
  like a failure, it looks like a success with a short hex tail.

  NO `{@html}`, ANYWHERE, AND NO `innerHTML`. Every string reaches the
  DOM as a Svelte text interpolation, which escapes. Bodies are raw JSONL
  out of somebody's transcript and may contain anything at all; the model
  column carries a literal `<synthetic>` (measured) and must render as
  those nine characters rather than be parsed as markup or dropped as a
  placeholder.

  WHICH ACTIONS EXIST IS DATA, NOT A BRANCH. `view.actions` comes from
  `reader-rows.ts`'s table, so the hard gate's guarantee - that NO render
  action exists in its subtree at any depth - is a row of that table
  rather than a `disabled` attribute somebody can flip. This template
  cannot add one back without editing the table, which the commitments
  test reads.

  Ported from `renderBody` in client/js/archive-line-render.js.
-->
<script lang="ts">
    import { CLASS } from './reader-vocab';
    import type { BodyView } from './reader-rows';

    interface Props {
        /** What to draw, already decided by `reader-rows.bodyView`. */
        view: BodyView;
        /**
         * Run one of `view.actions`. The component emits the action NAME
         * and never decides what it does, so the click router stays in
         * one place.
         */
        onAction: (action: string) => void;
    }

    let { view, onAction }: Props = $props();
</script>

<div class={CLASS.body} data-body-state={view.dataState}>
    {#if view.kind === 'text'}
        <pre class={CLASS.text}>{view.text}</pre>
        {#if view.masked > 0}
            <!--
              SAY THAT A LENS WAS APPLIED. The archive is byte-exact on
              disk; this view is not, and a reader who is not told will
              read the marker as stored content.
            -->
            <p class={CLASS.maskedNote} data-masked-count={view.masked}>
                {view.masked} secret{view.masked === 1 ? '' : 's'} masked in this
                view. The archived bytes are unchanged.
            </p>
        {/if}
    {:else if view.kind === 'refusal'}
        <p class={CLASS.refusalLabel}>{view.label}</p>
        <p class={CLASS.refusal}>{view.sentence}</p>
    {:else if view.kind === 'gate'}
        <p class={CLASS.gateLabel}>{view.label}</p>
        <p class={CLASS.gate}>{view.sentence}</p>
    {:else if view.kind === 'loading'}
        <p class={CLASS.loading}>{view.sentence}</p>
    {:else if view.kind === 'outcome'}
        <p class={CLASS.gate}>{view.sentence}</p>
    {:else}
        <p class={CLASS.placeholder}>{view.sentence}</p>
    {/if}

    {#each view.actions as act (act.action)}
        <button
            type="button"
            class={CLASS.action}
            data-action={act.action}
            onclick={() => onAction(act.action)}
        >{act.label}</button>
    {/each}
</div>
