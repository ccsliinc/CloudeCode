<!--
  TranscriptReader - one transcript's byte-exact line spine, windowed so
  a 94.7 MiB, 23,553-line file opens without killing the tab. (Both
  measured on the live corpus 2026-09-17, transcript 512.)

  IT ASSUMES NO SHELL, which is the requirement it was built against.
  Adam is replacing the entire application shell (issue #175), so this
  must mount into a shell that does not exist yet. It declares no width,
  no position and no viewport unit; it never reads the current header or
  sidebar and calls no `querySelector` outside its own subtree; it
  measures every row height rather than assuming one; and it takes
  everything shell-shaped as a prop.

  A THIRD `app-screen` GAP, REPORTED RATHER THAN WORKED AROUND QUIETLY.
  `docs/archive-shell-contract.md` already names two: `AppScreen.mount`
  can describe neither the SCROLLING ANCESTOR (slice 6, `scrollport`)
  nor a MODAL HOST (slice 5, `modalHost`). This slice hits a third: IT
  CAN DESCRIBE NO FRAME SCHEDULER. The reader coalesces a burst of
  resolved body fetches into ONE repaint per animation frame and pays
  the anti-jump scroll debt inside that frame, and a test needs to drive
  that synchronously - jsdom fires no real frame, so a reader reaching
  for the global would be untestable and its measurement pass
  unmeasured. `raf` is therefore a PROP.

  THE SCROLLPORT IS OURS, NOT THE PARENT'S, AND THAT DIFFERS FROM SLICE
  6 ON PURPOSE. `.archive-reader__scroller` is the element whose
  `scrollTop` the anti-jump contract writes, and that debt must be paid
  in the SAME call as the height write - a call the parent is not in. So
  the reader owns its scroller and takes no `scrollport` prop. It is
  still shell-independent: the scroller has no height of its own.

  WHERE THE REST OF THE REASONING LIVES, so it sits beside the code it
  governs rather than being restated here: the anti-jump contract and
  the honest scrollbar in `reader-virtual.ts`; the size gate and the
  credential masking in `reader-gate.ts` and `reader-mask.ts`; the four
  cache guarantees in `reader-body-cache.ts`; why every body must pass
  through one function in `reader-body-policy.ts`; the pager's in-flight
  guard in `reader-paging.ts`; and the class-name vocabulary that is
  commitment 1 of issue #173 in `reader-vocab.ts`.

  Replaces client/js/archive-reader.js, archive-reader-dom.js,
  archive-reader-body.js, archive-reader-paging.js,
  archive-reader-select.js, archive-line-render.js,
  archive-virtual-list.js, archive-body-cache.js, archive-body-gate.js
  and archive-screen-reader.js.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { ACTIONS, CLASS, READER_OK } from './reader-vocab';
    import { createActionRouter } from './reader-actions';
    import {
        groupRows, isRun, paintPlan, type ReaderItem, type SpineRow,
    } from './reader-rows';
    import { createList, estimateItem } from './reader-virtual';
    import { createBodyCache, type BodyCache } from './reader-body-cache';
    import { createBodyPolicy } from './reader-body-policy';
    import { createPager, DEFAULT_PAGE_ROWS } from './reader-paging';
    import { emptySpine, sentinelText, type SpineState } from './reader-load';
    import { createOpenApi } from './reader-open';
    import { viewportHeight, watchScroller } from './reader-measure.svelte';
    import { createFramePass } from './reader-frame';
    import { createSelection } from './keys';
    import { createSelectionApi } from './reader-select';
    import { headerFacts as buildHeaderFacts } from './reader-header';
    import ReaderRow from './ReaderRow.svelte';
    import ReaderProgressRun from './ReaderProgressRun.svelte';
    import ReaderStatus from './ReaderStatus.svelte';
    import type { ReaderProps } from './reader-props';

    let {
        client, outcome, transcriptId, lineNo = null,
        pageRows = DEFAULT_PAGE_ROWS, overscan, raf, renderOutcome = null,
    }: ReaderProps = $props();

    /**
     * The default scheduler. Immediate when no browser frame exists.
     *
     * READ INSIDE THE CLOSURE, not captured at init. A prop read at the
     * top level captures only its FIRST value, so a parent that swaps
     * schedulers would be silently ignored - and in a test that is the
     * difference between driving paints by hand and waiting forever on a
     * frame jsdom never fires.
     */
    function scheduleFrame(fn: () => void): void {
        if (raf) { raf(fn); return; }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(fn);
            return;
        }
        fn();
    }

    /** Everything the fetch layer owns. Replaced, never mutated. */
    let spine = $state<SpineState>(emptySpine());

    /**
     * Which progress runs are open, KEYED BY THE RUN'S `from` LINE
     * NUMBER, NOT BY ITEM INDEX.
     *
     * An append can re-group - a run at the end of the old spine merges
     * with progress rows at the start of the new page and every later
     * index shifts - so an index key would silently land somebody's
     * expansions on the wrong rows. A run's `from` is its first row's
     * `line_no`, which appending cannot move.
     */
    let expanded = $state<Record<number, boolean>>({});

    /** The scroller. OURS; see the component header for why. */
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

    /** Bumped when the cache changes, so entries re-read. */
    let cacheTick = $state(0);

    /** Bumped when the pager's in-flight guard flips. */
    let pagerTick = $state(0);

    /** The selection cursor: a COUNT and an INDEX, never an element. */
    const selection = createSelection();
    let selected = $state(-1);

    /**
     * The geometry engine. ONE PER READER, built at construction.
     *
     * `overscan` is read once on purpose: it is a tuning constant a
     * parent sets when it mounts, and re-creating the engine mid-life
     * would throw away every measured height the reader has converged on.
     */
    const list = createList({ overscan: untrack(() => overscan) });

    /**
     * The body cache. ONE PER READER, and it is cleared when the
     * transcript changes: a new transcript's `line_no` values can
     * numerically coincide with the old one's and they are not the same
     * rows.
     */
    const cache: BodyCache = createBodyCache({
        client: untrack(() => client),
        outcome: untrack(() => outcome),
    });

    const items = $derived(groupRows(spine.rows));

    const policy = createBodyPolicy({
        cache,
        items: () => untrack(() => items),
        schedule: () => { cacheTick += 1; },
    });

    const pager = createPager({
        onLoadMore: () => () => openApi.loadMore(),
        spineComplete: () => untrack(() => spine.complete),
        notify: () => { pagerTick += 1; },
    });

    /** Is the item at `index` an EXPANDED progress run? */
    function isExpandedAt(index: number): boolean {
        const it = items[index];
        return isRun(it) && expanded[it.from] === true;
    }

    /**
     * Rebuild the geometry from the current items.
     *
     * Description: an EXPANDED run estimates as its children stacked;
     *   the real height is measured next frame like any other row.
     *   `setCount` PRESERVES the cursor index when the count grows, so an
     *   appended page never moves somebody's selection.
     */
    function reseed(): void {
        list.setCount(items.length, (i) => {
            const it = items[i];
            return estimateItem(it, isRun(it) ? it.rows : null, isExpandedAt(i));
        });
        // setCount PRESERVES the cursor index when the count grows, so an
        // appended page never moves somebody's selection.
        selection.setCount(items.length);
        selected = selection.index();
        spacerPx = list.totalHeight();
    }

    /** The render window for the current scroll position. */
    const win = $derived.by(() => {
        // Named reads so the window re-derives when any of them moves.
        void paintTick; void items; void spacerPx;
        return list.windowFor(scrollTop, viewport || 0);
    });

    /** The rows actually in the DOM, with their entries resolved. */
    const painted = $derived.by(() => {
        void cacheTick;
        return paintPlan(items, win.first, win.last, (it) => policy.entryFor(it));
    });

    /**
     * THE MEASUREMENT FRAME, which lives in `reader-frame.ts`. One
     * coalesced pass per animation frame reads the painted rows' real
     * heights and pays the anti-jump scroll debt inside the same call.
     */
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
     * OPENING, PAGING AND DEEP-LINK LANDING, which live in
     * `reader-open.ts`. The state stays here, in the reactive graph; the
     * orchestration goes there, where it is testable with two plain
     * functions.
     */
    const openApi = createOpenApi({
        client: untrack(() => client),
        outcome: untrack(() => outcome),
        transcriptId: untrack(() => transcriptId),
        pageRows: untrack(() => pageRows),
        list,
        spine: () => untrack(() => spine),
        setSpine: (next) => { spine = next; },
        items: () => untrack(() => items),
        expandRun: (from: number) => { expanded = { ...expanded, [from]: true }; },
        reseed: () => reseed(),
        scroller: () => scroller,
        readGeometry: () => readGeometry(),
        resetForNewTranscript: () => { cache.clear(); expanded = {}; },
    });

    /** Toggle one progress run. A non-run index is a no-op. */
    function setProgressExpanded(index: number, on: boolean): void {
        const it = items[index];
        if (!isRun(it)) return;
        const next = { ...expanded };
        if (on) next[it.from] = true; else delete next[it.from];
        expanded = next;
        reseed();
        schedule();
    }

    /**
     * THE ONE CLICK ROUTER, which lives in `reader-actions.ts`.
     *
     * Rows emit an action NAME and an index and decide nothing. The hard
     * gate is guarded by two things that are NOT this router - the
     * action does not exist in its subtree, and the cache refuses the
     * fetch whatever `force` says - because relying on a router to be
     * the gate is how a gate ends up one refactor from being open.
     */
    const onAction = createActionRouter({
        setProgressExpanded: (i: number, on: boolean) => setProgressExpanded(i, on),
        renderAnyway: (i: number) => policy.renderAnyway(i),
        entryFor: (it) => policy.entryFor(it),
        items: () => untrack(() => items),
        schedule: () => schedule(),
        // A NAMED NO-OP. The reader does not own the app's download
        // mechanism and inventing one here would be a shell assumption;
        // the affordance exists, is honest about doing nothing, and the
        // href it would have used is on the entry.
        download: (href: string) => { void href; },
    });

    /**
     * THE SELECTION VERBS, which live in `reader-select.ts`.
     *
     * The cursor is a COUNT and an INDEX and never an element, which is
     * what lets a selection survive its row leaving the DOM - and rows
     * leave the DOM on every scroll here.
     */
    const selectApi = createSelectionApi({
        selection,
        list,
        scroller: () => scroller,
        viewportHeight: () => viewport || viewportHeight(scroller),
        items: () => untrack(() => items),
        isExpandedAt: (i: number) => isExpandedAt(i),
        setProgressExpanded: (i: number, on: boolean) => setProgressExpanded(i, on),
        renderAnyway: (i: number) => policy.renderAnyway(i).then((e) => {
            schedule();
            return e;
        }),
        publish: (i: number) => { selected = i; readGeometry(); },
    });

    /** Move the selection cursor and keep the selected row in view. */
    export function moveSelection(delta: number): number {
        return selectApi.moveSelection(delta);
    }

    /** Select one row outright. `selectIndex(-1)` clears the selection. */
    export function selectIndex(index: number): number {
        return selectApi.selectIndex(index);
    }

    /**
     * Open the selected row. A progress run TOGGLES; anything else goes
     * through the "open this row" verb. NOTHING SELECTED is a third
     * outcome and resolves null rather than acting on row zero.
     */
    export function openSelected(): Promise<unknown> {
        return selectApi.openSelected();
    }

    /** THE SINGLE ENTRY POINT for "load the next window". Also the `m` key. */
    export function requestMoreLines(): Promise<unknown> {
        return pager.requestMoreLines();
    }

    /**
     * Open the transcript.
     *
     * Description: EXPORTED RATHER THAN RUN FROM AN EFFECT, exactly as
     *   `NavRail.ensureViewLoaded` is, so the composition root decides
     *   WHEN the first request goes out. A screen mounting this behind a
     *   route, or before a token exists, must be able to hold it back.
     *   The cost of that design is that a parent which forgets the call
     *   gets an idle reader with no request made - which is precisely the
     *   defect the dev harness caught by LOOKING AT THE PAGE, so the
     *   harness calls it.
     */
    export function open(): Promise<string> {
        return openApi.open(untrack(() => lineNo));
    }

    /**
     * The current spine state, for a caller and for tests.
     *
     * NOT NAMED `state`: a local binding called `state` shadows the
     * `$state` RUNE for the whole module, and every rune in this file
     * then compiles into a store subscription on it. The component still
     * builds and simply stops being reactive - a warning, not an error.
     */
    export function spineNow(): SpineState { return spine; }
    /** The laid-out items. */
    export function laidOut(): readonly ReaderItem[] { return items; }
    /** The geometry engine. */
    export function geometry() { return list; }
    /** The body cache. */
    export function bodies(): BodyCache { return cache; }
    /** The selection cursor's index, or -1. */
    export function selectedIndex(): number { return selectApi.selectedIndex(); }
    /** The window last derived. */
    export function renderWindow() { return win; }

    // Reseed whenever the laid-out items change. `untrack` on the write
    // targets keeps this from re-entering itself.
    $effect(() => {
        void items;
        untrack(() => { reseed(); schedule(); });
    });

    /**
     * ASK FOR THE BODIES IN THE WINDOW.
     *
     * THIS EFFECT IS THE LOADER, AND ITS ABSENCE IS INVISIBLE. Without
     * it the reader mounts, paints every row, makes ZERO body requests,
     * logs nothing and errors nowhere - every row simply says "not
     * loaded yet" forever, which is indistinguishable from a transcript
     * whose bodies are genuinely absent. It is the same defect the dev
     * harness caught by LOOKING AT THE PAGE when its first draft never
     * called `NavRail.ensureViewLoaded()`, and it was caught here by
     * counting requests rather than by reading rendered text.
     *
     * It tracks `win` so a scroll brings new rows' bodies with it, and
     * `spine.rows` so an appended page is covered too. `requestBodies`
     * is itself idempotent - it skips anything cached, in flight, or
     * refused by the gate - so a re-run costs a loop and no network.
     */
    $effect(() => {
        const w = win;
        void spine.rows;
        untrack(() => policy.requestBodies(w));
    });

    // Watch our own scroller. It is ours, so this needs no prop.
    $effect(() => {
        if (!scroller) return undefined;
        readGeometry();
        return watchScroller(scroller, () => { readGeometry(); schedule(); });
    });

    /** The header's two sentences, from the transcript record. */
    const headerFacts = $derived(
        buildHeaderFacts(spine.header as Record<string, unknown> | null),
    );

    /** The outcome element a composition root supplied, if any. */
    const outcomeNode = $derived.by(() => {
        if (spine.token === READER_OK || !renderOutcome || !spine.envelope) return null;
        return renderOutcome(spine.envelope);
    });

</script>

<section class={CLASS.root} data-reader="archive">
    <ReaderStatus
        facts={headerFacts}
        token={spine.token}
        transportError={spine.transportError}
        {outcomeNode}
    />

    <!--
      `hidden` RATHER THAN AN `{#if}`. The scroller must keep its
      scrollTop across a paging refusal: unmounting it would reset the
      reader to the top of the file every time a page failed, which reads
      as the transcript reloading itself.
    -->
    <!--
      THE SCROLLER IS FOCUSABLE ON PURPOSE, AND THE LINT IS A KNOWN
      FALSE POSITIVE HERE. A scrollable region that is not keyboard
      focusable cannot be scrolled by a keyboard user at all, which
      is a real WCAG failure; `a11y_no_noninteractive_tabindex` does
      not model that case. The vanilla shell set the same attribute
      on the same element. Named as a forced choice.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
        class={CLASS.scroller}
        bind:this={scroller}
        tabindex="0"
        role="group"
        aria-label="transcript lines"
        hidden={spine.token !== READER_OK}
    >
        <div class={CLASS.spacer} style="height: {spacerPx}px">
            <div
                class={CLASS.window}
                bind:this={windowEl}
                style="transform: translateY({win.offsetTop}px)"
            >
                {#each painted as p (p.key)}
                    {#if isRun(p.item)}
                        <ReaderProgressRun
                            run={p.item}
                            expanded={expanded[p.item.from] === true}
                            index={p.index}
                            selected={p.index === selected}
                            entryFor={(r: SpineRow) => policy.entryFor(r)}
                            {onAction}
                        />
                    {:else}
                        <ReaderRow
                            row={p.item}
                            entry={p.entry}
                            index={p.index}
                            selected={p.index === selected}
                            {onAction}
                        />
                    {/if}
                {/each}

                {#if !spine.complete && spine.rows.length > 0}
                    <!--
                      A PARTIAL SPINE ENDS IN A NAMED SENTINEL, not in a
                      silent stop. A list that just ends looks complete.
                    -->
                    <p class={CLASS.sentinel}>{sentinelText(spine.rows.length)}</p>
                    <button
                        type="button"
                        class={CLASS.more}
                        data-action={ACTIONS.LOAD_MORE}
                        disabled={pagerTick >= 0 && pager.isLoadingMore()}
                        aria-busy={pager.isLoadingMore() ? 'true' : undefined}
                        onclick={() => requestMoreLines()}
                    >{pager.label(pageRows)}</button>
                {/if}
            </div>
        </div>
    </div>
</section>
