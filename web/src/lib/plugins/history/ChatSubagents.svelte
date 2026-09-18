<!--
  ChatSubagents - the subagent list hanging off one turn, in the order
  they ran.

  "subagents should be listed in time order so we know which was 1st,
  2nd, 3rd." That sentence is the whole specification and it contains a
  trap: AN ORDINAL IS A CLAIM. Printing "1st" asserts that this run
  started before the other two. The server knows on what basis it ordered
  them and says so in `order_basis`, so the sentence above the list
  renders that word rather than inventing a confidence of its own -
  `start_ts` is a measured clock, `file_position` is the order the spawns
  were written, and a view printing identical ordinals for both would be
  upgrading a file offset into a clock.

  AN UNRESOLVED ROW IS LISTED, COUNTED, AND DISABLED WITH ITS REASON. The
  server's own meta says an unresolved entry means the run is REAL AND
  UNIDENTIFIED, never that no run happened. Dropping it would report
  "this turn spawned nothing" for a turn that spawned five.

  ONE SPAWN CAN CARRY SEVERAL CONTROLS under one ordinal, because one
  agent session_ref can name two transcripts - the same run collected
  from two machines. All of them are listed; none is picked for the
  reader.

  Ported from client/js/archive-chat-subagents.js.
-->
<script lang="ts">
    import { ACTIONS, CLASS, MOD } from './chat-vocab';
    import { LOOKUP_FAILED } from './chat-subagents';
    import type { SubagentControl, SubagentPanel } from './chat-subagents';

    interface Props {
        /** The panel, already shaped by `chat-subagents.panelFor`. */
        panel: SubagentPanel;
        /** Drill into one resolved transcript. */
        onOpen: (control: SubagentControl) => void;
    }

    let { panel, onOpen }: Props = $props();
</script>

{#if panel.state === LOOKUP_FAILED}
    <!--
      "I COULD NOT LOOK" IS NOT "IT SPAWNED NONE", and the two must not
      render the same. A FORCED CHOICE, named in the commit message: the
      vanilla put an `archive-outcome` block here and that vocabulary
      belongs to slice 9, so the same finding is stated in words inside
      this block's own `--unknown` modifier.
    -->
    <div
        class="{CLASS.subagents} {MOD.subagentsUnknown}"
        data-subagent-state={LOOKUP_FAILED}
        data-panel="subagents"
    >
        <p class={CLASS.subBasis}>{panel.sentence}</p>
    </div>
{:else}
    <div
        class={CLASS.subagents}
        data-subagent-state="known"
        data-order-basis={panel.basis}
        data-subagent-count={panel.count}
        data-panel="subagents"
    >
        <p class={CLASS.subBasis}>{panel.sentence}</p>
        <ol class={CLASS.subList}>
            {#each panel.rows as row (row.key)}
                <li class={CLASS.subRow}>
                    {#each row.controls as c (c.key)}
                        <button
                            type="button"
                            class={CLASS.subOpen}
                            data-action={ACTIONS.OPEN_SUBAGENT}
                            data-openable={c.openable ? 'true' : 'false'}
                            data-transcript-id={c.transcriptId ?? undefined}
                            data-agent-id={c.agentId ?? undefined}
                            data-link-state={c.linkState ?? undefined}
                            title={c.openable ? undefined : c.tail}
                            disabled={!c.openable}
                            onclick={() => onOpen(c)}
                        >
                            <span class={CLASS.subOrdinal} data-ordinal={c.ordinalData}
                            >{c.ordinal}</span>
                            <span class={CLASS.subName}>{c.name}</span>
                            <span class={CLASS.subStarted}>{c.started}</span>
                            <span class={CLASS.subTid}>{c.tail}</span>
                        </button>
                    {/each}
                    {#if row.multi}
                        <p class={CLASS.subMulti}>{row.multi}</p>
                    {/if}
                </li>
            {/each}
        </ol>
        {#if panel.unlinked}
            <!--
              COUNTED OUT LOUD, not left for the reader to notice by
              scanning for disabled buttons. A list where two of five
              cannot be opened is a partial answer and says so.
            -->
            <p class={CLASS.subUnlinked}>{panel.unlinked}</p>
        {/if}
    </div>
{/if}
