<!--
  ChatInfo - the "i" panel: the envelope of one chat turn, on demand.

  EVERY FIELD IS ALWAYS RENDERED, EVEN WHEN ABSENT. A field the server
  did not send renders as NOT KNOWN, never as a blank cell and never by
  being omitted from the list. A missing row and a row with no value look
  identical to a reader and they mean different things: one is "this turn
  has no model", the other is "nobody told me". This panel is where
  people come when something is confusing, so it is the last place that
  may quietly drop a fact. `data-known` carries the distinction for a
  test and for a stylesheet without either parsing the copy.

  NOTHING HERE IS MASKED BECAUSE NOTHING HERE IS BODY TEXT - identifiers,
  timestamps, a model name and integer counts. The one branch that could
  change that is the extra-keys list; see `chat-info.ts`.

  NO LISTENERS. The "i" button lives on the turn and is routed by
  `ChatView`'s one click router, because bubbles are recycled on every
  paint and a listener bound to one would leak.

  Ported from client/js/archive-chat-info.js.
-->
<script lang="ts">
    import { CLASS } from './chat-vocab';
    import type { InfoPanel, InfoRow } from './chat-info';

    interface Props {
        /** The panel, already shaped by `chat-info.infoPanel`. */
        panel: InfoPanel;
    }

    let { panel }: Props = $props();
</script>

{#snippet rows(list: readonly InfoRow[], cls: string)}
    <dl class={cls}>
        {#each list as row (row.label)}
            <dt class={CLASS.infoKey}>{row.label}</dt>
            <dd
                class={CLASS.infoValue}
                data-known={row.known ? 'true' : 'false'}
                data-field={row.label}
            >{row.value}</dd>
        {/each}
    </dl>
{/snippet}

<div class={CLASS.info} role="group" aria-label="Message envelope detail" data-panel="info">
    {#if panel.missing}
        <p class={CLASS.infoNone}>
            NOT KNOWN. The envelope was requested for a turn this view does not
            hold.
        </p>
    {:else}
        <p class={CLASS.infoHead}>
            Envelope detail. Every field the server sent, and every field it did
            not.
        </p>
        {@render rows(panel.rows, CLASS.infoList)}
        <p class={CLASS.infoUsageHead}>Token usage</p>
        {@render rows(panel.usage, CLASS.infoUsage)}
        {#if panel.extra.length}
            <!--
              SHOWN RATHER THAN DROPPED. A server that grows a field must
              not have it silently disappear, which is how a fact becomes
              invisible for a year.
            -->
            <p class={CLASS.infoExtraHead}>
                Other fields this view does not have a name for
            </p>
            {@render rows(panel.extra, CLASS.infoExtra)}
        {/if}
    {/if}
</div>
