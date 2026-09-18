<!--
  ChatView - one transcript read as a CONVERSATION: turns, roles, tool
  calls, tool results, thinking blocks and subagent drill-down, windowed
  so a 23,553-line file opens without killing the tab.

  THIS IS THE VIEW THE WHOLE FEATURE EXISTS FOR. "im looking at a bunch
  of raw json so it does not read properly" is a defect report about the
  DEFAULT. The raw reader (slice 7) is the byte-exact record and stays
  one switch away, because some questions can only be answered by the
  bytes.

  IT ASSUMES NO SHELL. Adam is replacing the entire application shell
  (issue #175), so this must mount into a shell that does not exist yet.
  It declares no width, no position and no viewport unit; it never reads
  the current header or sidebar and calls no `querySelector` outside its
  own subtree; it measures every bubble rather than assuming a height;
  and it takes everything shell-shaped as a prop. See `chat-props.ts` -
  that file IS the contract.

  NO FOURTH `app-screen` GAP. `docs/archive-shell-contract.md` names
  three: no scrollport description (slice 6), no modal host (slice 5), no
  frame scheduler (slice 7). This view needs the THIRD one, for the same
  reason, and needs nothing new.

  VARIABLE-HEIGHT ROWS ARE THE HARD PART, and slice 7's engine already
  solved it - what changes is how badly the FIRST guess can be wrong. A
  raw line's height is a function of one number. A bubble's is a function
  of its block mix AND of which panels the reader has opened, so the
  initial error per row is larger and, crucially, it CHANGES when
  somebody clicks. Two consequences are handled here and nowhere else:

    1. Every panel toggle re-estimates THAT ONE ROW before the repaint,
       so the row grows in the geometry in the same frame it grows on
       screen. Without it, opening an envelope panel on a row above the
       viewport shoves the content under the reader's eyes down by 380
       pixels.
    2. The measurement frame runs on EVERY paint, not only after a data
       change, because a bubble's real height also depends on the
       viewport width and therefore changes on resize with no state
       change at all.

  EVERY BYTE OF BLOCK TEXT ON SCREEN CAME THROUGH `chat-mask.blockText`,
  which runs slice 7's `applyMask`. This component never touches a raw
  block's text and neither does any template under it; see
  `chat-mask.ts`'s header and `ChatView.commitments.test.ts`.

  Replaces client/js/archive-chat-view.js, archive-chat-screen.js,
  archive-chat-turn.js, archive-chat-block.js, archive-chat-info.js,
  archive-chat-subagents.js, archive-chat-stack.js,
  archive-chat-estimate.js and archive-chat-clicks.js.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { ACTIONS, CHAT_OK, CLASS, MOD } from './chat-vocab';
    import {
        emptyChat, sentinelText, DEFAULT_PAGE_TURNS, NO_PAGER_TEXT, type ChatState,
    } from './chat-load';
    import { createChatOpenApi } from './chat-open';
    import { isRun, itemKey, progressChipLabel, turnView, type OpenState } from './chat-turn';
    import { estimator, estimateItem } from './chat-estimate';
    import { createStack } from './chat-stack';
    import type { SubagentControl } from './chat-subagents';
    import type { ChatProps } from './chat-props';
    import ChatTurn from './ChatTurn.svelte';
    import ChatChain from './ChatChain.svelte';
    import ChatStatus from './ChatStatus.svelte';
    // REUSED, NOT REBUILT. The geometry engine, the measurement frame,
    // the scroller watcher and the pager are slice 7's, unchanged. A
    // second windowing engine for the same corpus is a second set of
    // anti-jump arithmetic to get right.
    import { createList } from './reader-virtual';
    import { createFramePass } from './reader-frame';
    import { watchScroller } from './reader-measure.svelte';
    import { createPager } from './reader-paging';

    let {
        client, outcome, transcriptId, label = null, pageTurns = DEFAULT_PAGE_TURNS,
        overscan, raf, renderOutcome = null, onDrill = null,
    }: ChatProps = $props();

    /**
     * The default scheduler. Immediate when no browser frame exists.
     *
     * READ INSIDE THE CLOSURE, not captured at init. A prop read at the
     * top level captures only its FIRST value, so a parent that swapped
     * schedulers would be silently ignored - and in a test that is the
     * difference between driving paints by hand and waiting forever on a
     * frame jsdom never fires.
     */
    function scheduleFrame(fn: () => void): void {
        if (raf) { raf(fn); return; }
        if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(fn); return; }
        fn();
    }

    /** Everything the fetch layer owns. Replaced, never mutated. */
    let chat = $state<ChatState>(emptyChat());

    /**
     * Which panels are open, KEYED BY THE ROW'S INDEX.
     *
     * INDEX IS SAFE HERE AND IT IS NOT IN SLICE 7, and the difference is
     * worth stating. The reader keys expansions by a run's `from` line
     * because an append can RE-GROUP and shift every later index. This
     * view resets the whole map on a navigation and appends only at the
     * end, so an index already painted never moves. A subagent drill is a
     * navigation, which is exactly when the map is cleared.
     */
    let panels = $state<Record<number, OpenState>>({});

    /** The scroller. OURS; see `chat-props.ts` for why. */
    let scroller = $state<HTMLElement | null>(null);
    /** The translated render window element. Measured, never styled. */
    let windowEl = $state<HTMLElement | null>(null);

    /** Live scroll geometry, re-read on every scroll and resize. */
    let scrollTop = $state(0);
    let viewport = $state(0);

    /** The honest content height, written by the reconcile. */
    let spacerPx = $state(0);

    /** Bumped to force a re-derive after a measurement pass. */
    let paintTick = $state(0);
    /** Bumped when the pager's in-flight guard flips. */
    let pagerTick = $state(0);
    /** Bumped when the drill chain moves. */
    let chainTick = $state(0);

    /**
     * The drill chain. ONE PER VIEW, built at construction.
     *
     * It is a STACK and not a "previous id" because a subagent is a
     * transcript rendered by this same view, so the nesting has no fixed
     * depth; see `chat-stack.ts`.
     */
    const stack = createStack();

    /**
     * The geometry engine. ONE PER VIEW, built at construction.
     *
     * `overscan` is read once on purpose: it is a tuning constant a
     * parent sets when it mounts, and re-creating the engine mid-life
     * would throw away every measured height converged on so far.
     */
    const list = createList({ overscan: untrack(() => overscan) });

    const items = $derived(chat.items);

    /** The open panels of one row, or null. Allocates nothing. */
    function openAt(index: number): OpenState | null {
        return panels[index] || null;
    }

    /** Rebuild the geometry from the current items and open state. */
    function reseed(): void {
        list.setCount(items.length, estimator(items, openAt));
        spacerPx = list.totalHeight();
    }

    const pager = createPager({
        onLoadMore: () => () => nav.loadMore(),
        // THREE-VALUED, READ AS ONE THING HERE. Only an explicit `true`
        // stops the pager; `null` means the server did not say, and a
        // pager that refused on a null would end the conversation on a
        // number nobody read.
        spineComplete: () => untrack(() => chat.complete) === true,
        notify: () => { pagerTick += 1; },
    });

    /** The render window for the current scroll position. */
    const win = $derived.by(() => {
        void paintTick; void items; void spacerPx;
        return list.windowFor(scrollTop, viewport || 0);
    });

    /**
     * The rows actually in the DOM, shaped one by one.
     *
     * `turnView` runs HERE and not over the whole list, because it masks
     * every block of every turn it touches and there can be 30,805 of
     * them. Shaping a row nobody can see is work for nothing.
     */
    const painted = $derived.by(() => {
        const out: { index: number; key: string; item: (typeof items)[number] }[] = [];
        for (let i = win.first; i <= win.last; i += 1) {
            const it = items[i];
            if (!it) continue;
            out.push({ index: i, key: itemKey(it), item: it });
        }
        return out;
    });

    /** THE MEASUREMENT FRAME, slice 7's, unchanged. */
    const frame = createFramePass({
        list,
        scroller: () => scroller,
        windowEl: () => windowEl,
        scrollTop: () => untrack(() => scrollTop),
        viewport: () => untrack(() => viewport),
        applied: (totalHeight: number, top: number) => {
            spacerPx = totalHeight;
            scrollTop = top;
            paintTick += 1;
        },
        raf: (fn: () => void) => scheduleFrame(fn),
    });

    /** Queue one measurement pass on the next animation frame. */
    function schedule(): void { frame.schedule(); }

    /** Re-read the live scroll geometry. */
    function readGeometry(): void {
        const g = frame.geometry();
        scrollTop = g.scrollTop;
        viewport = g.viewport;
    }

    /**
     * Flip one panel of one row.
     *
     * Description: re-estimates THAT ONE ROW before the repaint, so the
     *   growth is accounted for in the same frame it appears. Without it
     *   the reconciliation would still converge, but only after the row
     *   had already shoved everything below it on screen.
     */
    function toggle(index: number, key: 'infoOpen' | 'subOpen', on: boolean): void {
        if (!Number.isInteger(index)) return;
        panels = { ...panels, [index]: { ...(panels[index] || {}), [key]: on } };
        list.measure(index, estimateItem(items[index], openAt(index)));
        schedule();
    }

    /** Expand or re-fold one run of progress records. */
    function setProgressExpanded(index: number, on: boolean): void {
        const it = items[index];
        if (!isRun(it)) return;
        panels = { ...panels, [index]: { ...(panels[index] || {}), progressExpanded: on } };
        list.measure(index, estimateItem(it, openAt(index)));
        schedule();
    }

    /**
     * OPENING, PAGING AND DRILLING, which live in `chat-open.ts`. The
     * state stays here, in the reactive graph; the sequencing and the
     * stale-response ticket go there, where they are testable with plain
     * functions.
     */
    const nav = createChatOpenApi({
        client: untrack(() => client),
        outcome: untrack(() => outcome),
        pageTurns: untrack(() => pageTurns),
        stack,
        state: () => untrack(() => chat),
        setState: (next) => { chat = next; },
        resetForLevel: () => {
            panels = {};
            if (scroller) scroller.scrollTop = 0;
            scrollTop = 0;
        },
        reseed: () => reseed(),
        schedule: () => schedule(),
        chainMoved: () => { chainTick += 1; },
        announce: (target, depth) => { if (onDrill) onDrill(target, depth); },
    });

    /**
     * Open the transcript at the TOP of a NEW chain.
     *
     * Description: EXPORTED RATHER THAN RUN FROM AN EFFECT, exactly as
     *   `TranscriptReader.open` and `NavRail.ensureViewLoaded` are, so
     *   the composition root decides WHEN the first request goes out. The
     *   cost of that design is that a parent which forgets the call gets
     *   an idle view with no request made - which is precisely the defect
     *   the dev harness caught by LOOKING AT THE PAGE, so the harness
     *   calls it.
     */
    export function open(): Promise<string> {
        return nav.open(untrack(() => transcriptId), untrack(() => label));
    }

    /** THE SINGLE ENTRY POINT for "load the next page of turns". */
    export function requestMoreTurns(): Promise<unknown> {
        return pager.requestMoreLines();
    }

    /**
     * The current state, for a caller and for tests.
     *
     * NOT NAMED `state`: a local binding called `state` shadows the
     * `$state` RUNE for the whole module and every rune in this file then
     * compiles into a store subscription on it. The component still
     * builds and simply stops being reactive - a warning, not an error.
     */
    export function chatNow(): ChatState { return chat; }
    /** The laid-out items. */
    export function laidOut() { return items; }
    /** The geometry engine. */
    export function geometry() { return list; }
    /** The drill chain. */
    export function chain() { return stack; }
    /** The window last derived. */
    export function renderWindow() { return win; }
    /** Which panels are open, for tests. */
    export function openState(): Record<number, OpenState> { return panels; }

    // Watch our own scroller. It is ours, so this needs no prop.
    $effect(() => {
        if (!scroller) return undefined;
        readGeometry();
        return watchScroller(scroller, () => { readGeometry(); schedule(); });
    });

    /** The breadcrumb levels, re-read whenever the chain moves. */
    const levels = $derived.by(() => { void chainTick; return stack.levels(); });

    /** The outcome element a composition root supplied, if any. */
    const outcomeNode = $derived.by(() => {
        if (chat.token === CHAT_OK || !renderOutcome || !chat.envelope) return null;
        return renderOutcome(chat.envelope);
    });

    /** Is the scroller allowed to paint rows at all. */
    const renderable = $derived(outcome.isRenderable(chat.token));

    /** Can a further page actually be ASKED FOR right now. */
    const canPage = $derived(chat.cursor !== null);
</script>

<section class={CLASS.root} data-view="chat" data-chat-state={chat.token}>
    <div class={CLASS.chainSlot}>
        <ChatChain {levels} onUp={(i) => { void nav.goUp(i); }} />
    </div>

    <ChatStatus token={chat.token} transportError={chat.transportError} {outcomeNode} />

    <!--
      `hidden` RATHER THAN AN `{#if}`. The scroller must keep its
      scrollTop across a paging refusal: unmounting it would reset the
      view to the top of the conversation every time a page failed, which
      reads as the transcript reloading itself.
    -->
    <!--
      THE SCROLLER IS FOCUSABLE ON PURPOSE, AND THE LINT IS A KNOWN FALSE
      POSITIVE HERE. A scrollable region that is not keyboard focusable
      cannot be scrolled by a keyboard user at all, which is a real WCAG
      failure; `a11y_no_noninteractive_tabindex` does not model that case.
      The vanilla set the same attribute on the same element. Named as a
      forced choice.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
        class={CLASS.scroller}
        bind:this={scroller}
        tabindex="0"
        role="group"
        aria-label="conversation turns"
        hidden={!renderable}
    >
        <div class={CLASS.spacer} style="height: {spacerPx}px">
            <div
                class={CLASS.window}
                bind:this={windowEl}
                style="transform: translateY({win.offsetTop}px)"
            >
                {#each painted as p (p.key)}
                    {#if isRun(p.item)}
                        <div
                            class="{CLASS.turn} {MOD.turnProgress}"
                            data-kind="progress-run"
                            data-from={p.item.from}
                            data-index={p.index}
                        >
                            <button
                                type="button"
                                class={CLASS.progressChip}
                                aria-expanded={panels[p.index]?.progressExpanded
                                    ? 'true' : 'false'}
                                data-action={panels[p.index]?.progressExpanded
                                    ? ACTIONS.COLLAPSE_PROGRESS : ACTIONS.EXPAND_PROGRESS}
                                onclick={() => setProgressExpanded(
                                    p.index, !panels[p.index]?.progressExpanded,
                                )}
                            >{progressChipLabel(p.item, panels[p.index]?.progressExpanded === true)}</button>
                        </div>
                    {:else}
                        <ChatTurn
                            view={turnView(p.item)}
                            turn={p.item}
                            index={p.index}
                            infoOpen={panels[p.index]?.infoOpen === true}
                            subOpen={panels[p.index]?.subOpen === true}
                            onToggle={toggle}
                            onOpenSubagent={(c) => { void nav.drillInto(c); }}
                        />
                    {/if}
                {/each}

                {#if renderable && chat.complete !== true && items.length > 0}
                    <!--
                      A CONVERSATION THAT JUST STOPS LOOKS FINISHED. The
                      sentinel is painted only when the window reaches the
                      last row, so it sits at the bottom of the content
                      rather than floating.
                    -->
                    {#if win.last >= items.length - 1}
                        <div class={CLASS.sentinel} data-complete={String(chat.complete)}>
                            <p class={CLASS.sentinelText}
                            >{sentinelText(items.length, chat.complete)}</p>
                            {#if canPage}
                                <button
                                    type="button"
                                    class={CLASS.pager}
                                    data-action={ACTIONS.LOAD_MORE}
                                    disabled={pagerTick >= 0 && pager.isLoadingMore()}
                                    aria-busy={pager.isLoadingMore() ? 'true' : undefined}
                                    onclick={() => requestMoreTurns()}
                                >{pager.isLoadingMore() ? 'Loading...' : 'Load more turns'}</button>
                            {:else if chat.complete === false}
                                <!-- NO BUTTON WITHOUT A HANDLER. -->
                                <p class={CLASS.sentinelNoPager}>{NO_PAGER_TEXT}</p>
                            {/if}
                        </div>
                    {/if}
                {/if}
            </div>
        </div>
    </div>
</section>
