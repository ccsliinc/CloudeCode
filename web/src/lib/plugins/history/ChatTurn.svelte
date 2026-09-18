<!--
  ChatTurn - one chat bubble: a turn, its blocks, its "i", and its
  subagents.

  THE DEFAULT STATE OF A BUBBLE IS PROSE AND NOTHING ELSE. The envelope
  is behind the "i". Thinking, tool calls and tool results are behind
  their own disclosures. Subagents are behind a counted expander.
  Everything is reachable in one click from where you already are;
  nothing is in your way before you click.

  ROLE IS NEVER SIGNALLED BY COLOUR ALONE. Three of this app's themes -
  terminal, gameboy, legacy_apple - deliberately zero every radius token,
  so a bubble there is a rectangle and the chat metaphor cannot lean on
  rounded corners either. Every turn carries the role as TEXT in its
  header plus a `data-role` attribute for the stylesheet to hang a border
  or an indent on. Strip the CSS entirely and the transcript still reads
  as a conversation.

  A ROW IS A PURE FUNCTION OF (view, open). It holds no state of its own:
  bubbles are recycled on every paint by the virtual list, so a captured
  flag would render the wrong turn's open panel. Which panels are open
  lives in `ChatView` and arrives as props.

  THE TWO HEADER CONTROLS ARE REAL `<button>`s with real accessible
  names, never clickable spans: the "i" is the affordance the whole
  feature hangs off and it has to be reachable by keyboard and by a
  screen reader. "i" is not a sentence, so the sentence is its aria-label.

  Ported from client/js/archive-chat-turn.js.
-->
<script lang="ts">
    import { ACTIONS, CLASS } from './chat-vocab';
    import ChatBlock from './ChatBlock.svelte';
    import ChatInfo from './ChatInfo.svelte';
    import ChatSubagents from './ChatSubagents.svelte';
    import { infoPanel } from './chat-info';
    import { panelFor, type SubagentControl } from './chat-subagents';
    import type { ChatTurnRaw, ChatTurnView } from './chat-turn';

    interface Props {
        /** The bubble, already shaped by `chat-turn.turnView`. */
        view: ChatTurnView;
        /** The raw turn, read ONLY by the two on-demand panels. */
        turn: ChatTurnRaw;
        /** This row's index in the laid-out list. */
        index: number;
        infoOpen: boolean;
        subOpen: boolean;
        /** Flip one panel. The row decides nothing. */
        onToggle: (index: number, key: 'infoOpen' | 'subOpen', on: boolean) => void;
        /** Drill into one subagent. */
        onOpenSubagent: (control: SubagentControl) => void;
    }

    let { view, turn, index, infoOpen, subOpen, onToggle, onOpenSubagent }: Props = $props();

    /**
     * The envelope panel, built only while it is open.
     *
     * Description: a bubble is one of up to 30,805 rows and the panel is
     *   nineteen fields plus six usage rows plus whatever extras the
     *   server grew. Shaping it for every row on every paint would be
     *   work for something nobody asked to see.
     */
    const info = $derived(infoOpen ? infoPanel(turn) : null);

    /** The subagent panel, built only while it is open. */
    const subs = $derived(subOpen ? panelFor(turn) : null);
</script>

<article
    class={CLASS.turn}
    data-role={view.role}
    data-record-type={view.recordType}
    data-index={index}
    data-line-no={view.lineNo ?? undefined}
    data-body-id={view.bodyId ?? undefined}
>
    <header class={CLASS.turnHead}>
        <span
            class={CLASS.who}
            data-role={view.role}
            data-role-state={view.roleInferred ? view.roleState : undefined}
        >{view.roleText}{view.roleInferred ? ' (inferred)' : ''}</span>

        <time class={CLASS.ts}>{view.ts}</time>

        {#if view.model}
            <span class={CLASS.model}>{view.model}</span>
        {/if}

        {#if view.secretCount > 0}
            <span class={CLASS.secrets} data-secrets={view.secretCount}
            >{view.secretCount} flagged secret(s)</span>
        {/if}

        <button
            type="button"
            class={CLASS.toggle}
            data-action={ACTIONS.INFO}
            aria-label="Envelope detail for this message"
            aria-expanded={infoOpen ? 'true' : 'false'}
            data-open={infoOpen ? 'true' : 'false'}
            onclick={() => onToggle(index, 'infoOpen', !infoOpen)}
        >i</button>

        {#if view.expander}
            <button
                type="button"
                class={CLASS.toggle}
                data-action={ACTIONS.SUBAGENTS}
                data-subagent-state={view.expander.state}
                aria-label="{view.expander.label} spawned by this message"
                aria-expanded={subOpen ? 'true' : 'false'}
                data-open={subOpen ? 'true' : 'false'}
                onclick={() => onToggle(index, 'subOpen', !subOpen)}
            >{view.expander.label}</button>
        {/if}
    </header>

    {#if info}
        <ChatInfo panel={info} />
    {/if}

    <div class={CLASS.turnBody} data-blocks={view.blocksData}>
        {#if view.body.kind === 'blocks'}
            {#each view.body.blocks as b (b.key)}
                <ChatBlock view={b} />
            {/each}
        {:else}
            <!--
              TWO DIFFERENT FINDINGS, TWO DIFFERENT SENTENCES, told apart
              by `data-blocks` above. An empty ARRAY is the server saying
              this turn carried no content blocks; a MISSING array is the
              server not having told us, which is a could-not-evaluate.
            -->
            <p class={CLASS.noBlocks}>{view.body.sentence}</p>
        {/if}
    </div>

    {#if subs}
        <ChatSubagents panel={subs} onOpen={onOpenSubagent} />
    {/if}
</article>
