<!--
  ChatBlock - one content block of one chat turn, rendered for a person
  rather than for a parser.

  IT NEVER SEES A RAW BLOCK. Its only content prop is a `ChatBlockView`,
  whose `content` came out of `chat-mask.blockText`, which ran
  `reader-gate.applyMask` - slice 7's masker, hard-imported, no injected
  seam. This component does not read `text`, does not read `secrets` and
  does not slice a string by offset. The field it paints is called `safe`
  rather than `text` on purpose, so "did anything in the chat family read
  a raw block" stays a mechanical grep; see `ChatView.commitments.test.ts`.

  THAT IS NOT STYLE, IT IS THE CONTROL. The failure mode of masking in
  the renderer is a HALF-masked body, and a half-masked body does not
  look like a failure - it looks like a success with a short hex tail
  that reads as prose. `applyMask` refuses a whole body whenever it
  cannot account for every finding the server declared, and a refusal
  arrives here as `kind: 'refusal'` carrying counts and a reason and no
  text at all.

  PROSE IS OPEN, ENVELOPE IS CLOSED. A text block renders its text
  directly. Thinking, tool calls and tool results render inside a
  `<details>` collapsed by default, so the conversation reads as a
  conversation and the machinery is one click away. That is the owner's
  rule - not information overload, but everything reachable - expressed
  as markup.

  FOUR OUTCOMES, NEVER TWO. Included text, a mask refusal, a block the
  server WITHHELD (naming its length, because "too big to send" and
  "empty" are different findings), and a block whose state cannot be
  determined. An empty div would collapse all four into "nothing here".

  NO `{@html}` AND NO `innerHTML`. Block text is arbitrary bytes out of
  somebody's transcript and must never be parsed as markup.

  Ported from client/js/archive-chat-block.js.
-->
<script lang="ts">
    import { CLASS } from './chat-vocab';
    import type { ChatBlockView } from './chat-turn';

    interface Props {
        /** What to draw, already decided by `chat-turn.turnBody`. */
        view: ChatBlockView;
    }

    let { view }: Props = $props();
</script>

{#snippet label()}
    <!--
      THE LABEL STRIP IS RENDERED FOR EVERY BLOCK including plain text,
      because a reader scanning a conversation needs to tell prose from a
      tool payload without opening either.
    -->
    <span class={CLASS.label}>
        <span class={CLASS.type}>{view.typeLabel}</span>
        {#if view.toolName}<span class={CLASS.tool}>{view.toolName}</span>{/if}
        {#if view.isError}
            <!--
              NAMED IN TEXT, not only coloured: three themes zero every
              radius token and colour alone is not a signal anyone can
              rely on.
            -->
            <span class={CLASS.error} data-error="true">ERROR</span>
        {/if}
        {#if view.lengthLabel}<span class={CLASS.len}>{view.lengthLabel}</span>{/if}
    </span>
{/snippet}

{#snippet content()}
    {#if view.content.kind === 'text'}
        {#if view.content.truncated}
            <!--
              TRUNCATION IS A PARTIAL ANSWER AND MUST SAY SO. Text that
              simply stops, with no marker, reads as the whole thing: the
              reader draws a conclusion from an excerpt believing they
              saw all of it.
            -->
            <div class={CLASS.truncated} data-truncated="true">
                <div class={CLASS.bodyText} data-text-state="included"
                     data-masked-count={view.content.masked || undefined}
                >{view.content.safe}</div>
                <p class={CLASS.truncatedNote}>
                    TRUNCATED BY THE SERVER.
                    {#if view.content.truncated.full !== null}
                        This is about {view.content.truncated.shown} of
                        {view.content.truncated.full} characters; the rest was
                        not sent.
                    {:else}
                        Part of this block was not sent; how much is NOT KNOWN.
                    {/if}
                    Open the raw view for the whole record.
                </p>
            </div>
        {:else}
            <div class={CLASS.bodyText} data-text-state="included"
                 data-masked-count={view.content.masked || undefined}
            >{view.content.safe}</div>
        {/if}
    {:else if view.content.kind === 'refusal'}
        <div class={CLASS.refused} data-text-state="mask-refused" role="status">
            <p class={CLASS.refusedHead}>{view.content.head}</p>
            <p class={CLASS.refusedWhy}>{view.content.why}</p>
        </div>
    {:else}
        <!--
          WITHHELD AND CANNOT-DETERMINE SHARE ONE BOX AND DIFFERENT
          WORDS, and that is a FORCED CHOICE named in the commit message.
          The vanilla rendered the unknown case through
          `archive-outcome-view.js`, which is slice 9's port; reaching for
          that global here would be the injected-seam anti-pattern this
          slice's masker deliberately refuses. `data-text-state` keeps the
          two apart for a stylesheet and for a test, and the sentences
          keep them apart for a reader.
        -->
        <div class={CLASS.withheld} data-text-state={view.content.kind === 'withheld'
            ? 'withheld' : 'cannot-determine'}>
            <p class={CLASS.withheldHead}>{view.content.head}</p>
            <p class={CLASS.withheldSize}>{view.content.size}</p>
            <p class={CLASS.withheldWhy}>{view.content.why}</p>
        </div>
    {/if}
{/snippet}

<div
    class={CLASS.block}
    data-block-type={view.type}
    data-block-seq={view.seq === null ? undefined : view.seq}
    data-tool-use-id={view.toolUseId ?? undefined}
    data-text-state={view.dataState}
>
    {#if view.collapsed}
        <details class={CLASS.disclosure}>
            <summary class={CLASS.summary}>{@render label()}</summary>
            {@render content()}
        </details>
    {:else}
        {@render label()}
        {@render content()}
    {/if}
</div>
