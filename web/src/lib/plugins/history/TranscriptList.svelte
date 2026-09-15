<!--
  TranscriptList - a project's transcripts, or a corpus's unattributed
  ones, paged by opaque keyset cursor and windowed so the DOM stays
  bounded.

  IT ASSUMES NO SHELL, AND THAT IS THE REQUIREMENT IT WAS BUILT AGAINST.
  Adam is replacing the entire application shell (issue #175): new nav,
  new sidebar, a full re-skin, with Archive becoming a first-class
  sidebar item. So this component must mount into a shell that does not
  exist yet. Concretely it:
    - does not own the viewport. `.archive-tlist` is `display: flex;
      flex-direction: column; min-height: 0` and declares no width, no
      position and no viewport unit, so it fills whatever box a parent
      hands it. That was already true of the vanilla markup and reusing
      the class verbatim preserves it.
    - never reads the current header or sidebar, and calls no
      `querySelector` outside its own subtree.
    - takes its SCROLLPORT from a prop. The scrolling element is an
      ancestor this component does not own (`archive-tlist.css:145`: "the
      pane is `overflow: auto`"), and finding it with `closest()` would
      be exactly the reach-around this brief forbids. See the gap note
      below.
    - depends on no fixed pixel chrome. The one number it reads off the
      page, the row height, is MEASURED from a rendered row rather than
      assumed, and is re-measured whenever the list changes.

  THE GAP IN THE `app-screen` SURFACE, STATED RATHER THAN WORKED AROUND
  QUIETLY. `AppScreen.mount(container, route, context, api)` hands a
  screen a container, a route, a context and a granted client, and has no
  notion of the SCROLLPORT the screen's body lives in. There is nothing
  in the contract to ask for one. So `scrollport` is a PROP, and it is
  the temporary seam: when the surface grows a way to describe its
  container's scrolling ancestor, this prop is what gets replaced.

  THE WINDOW IS THE PIECE THE VANILLA LIST NEVER HAD. `paint()` cleared
  its `<ul>` and rebuilt one `<li>` with eight child spans for EVERY
  loaded row on every repaint, including one caused by a single keystroke
  in a fuzzy input. Project 12 holds 3,416 transcripts. `tlist-window.ts`
  bounds the rendered rows to the viewport plus overscan, and the keyed
  `{#each}` supplies the node reuse the vanilla reader had to keep a Map
  of detached nodes to get. See that file's header for what the original
  guaranteed and which half of it Svelte already provides.

  THE SPACERS CARRY NO CLASS, AND THAT IS A FORCED CHOICE WORTH NAMING.
  Windowing needs two spacers to keep the scrollbar honest. Commitment 1
  forbids a new class name and commitment 2 forbids touching any of the
  12 archive stylesheets, so the spacers are unclassed `<li>` elements
  with an inline height. Measured before choosing: `grep -nE
  '(^|[ ,>+~])(li|ul)([ ,>:{]|$)' client/css/archive*.css` returns ZERO
  across all 12 files, so nothing styles a bare `li` today and the
  spacers inherit layout only. The residual risk is real and is the
  reason this paragraph exists: a re-skin that writes
  `.archive-tlist__rows > li` rather than `.archive-tlist__row` WILL
  paint them. The alternative considered and rejected was inline padding
  on the `<ul>`, which would have clobbered `.archive-tlist__rows`'
  declared `padding: 8px` AND its phone-width override to `8px 6px` -
  a visual change to a stylesheet this work promised not to touch,
  delivered by the back door.

  `has_more` IS A THREE-OUTCOME FIELD. The server returns `null` on every
  failure path. The load-more control is offered on `=== true` and
  nothing else; `null` renders "whether there is more: NOT KNOWN".
  Treating null as false claims the end of a list that was never read.

  A FILTER THAT MATCHES NOTHING IS A STATED EMPTY, never a blank pane,
  which is indistinguishable from a list that has not loaded.

  Replaces client/js/archive-transcript-list.js.
-->
<script lang="ts">
    import { CLASS, COLUMNS, DEFAULT_SCHEME, SCHEME_DEFS } from './tlist-vocab';
    import {
        describeFilter,
        fuzzyNote,
        nextScheme,
        rowValue,
        type TranscriptRowData,
    } from './tlist-row';
    import {
        applyPage,
        canLoadMore,
        emptyPaging,
        fetchPage,
        type ListScope,
        type PagingState,
    } from './tlist-paging';
    import {
        computeWindow,
        scrollToShow,
        DEFAULT_OVERSCAN,
        type RenderWindow,
    } from './tlist-window';
    import { isFiltering, visibleRows, type FuzzyMatcher } from './tlist-fuzzy';
    import {
        measureRowHeight,
        readScrollport,
        watchScrollport,
        type Measurements,
    } from './tlist-measure.svelte';
    import { createSelection } from './keys';
    import TranscriptRow from './TranscriptRow.svelte';
    import TranscriptListFilter from './TranscriptListFilter.svelte';
    import TranscriptListFooter from './TranscriptListFooter.svelte';
    import type { ArchiveClient } from './client';
    import type { OutcomeClassifier } from './state';

    interface Props {
        /** The granted archive client from slice 2. Required. */
        client: ArchiveClient;
        /**
         * The outcome classifier, injected the same way `state.ts`
         * injects it: `archive-outcome.js` is still vanilla and this
         * tree reaches for no global.
         */
        outcome: OutcomeClassifier;
        /** Which listing to show. Changing it starts a NEW listing. */
        scope: ListScope;
        /**
         * The SCROLLING ancestor. Null means the window cannot be
         * measured, and an unmeasured window renders every loaded row -
         * the vanilla behaviour - rather than guessing a subset.
         */
        scrollport?: Element | null;
        /** The fuzzy matcher, or null for no client-side filtering. */
        fuzzy?: FuzzyMatcher | null;
        /** Rows kept rendered beyond each viewport edge. */
        overscan?: number;
        /** Open one transcript. Called with the id, never with the ref. */
        onSelect?: (transcriptId: number | string, row: TranscriptRowData) => void;
        /**
         * Render a non-renderable envelope. Supplied by the composition
         * root because `archive-outcome-view.js` is a later slice. When
         * absent the outcome's own reasons are not drawn, and the
         * transport reason still is.
         */
        renderOutcome?: ((envelope: unknown) => Element | null) | null;
    }

    let {
        client,
        outcome,
        scope,
        scrollport = null,
        fuzzy = null,
        overscan = DEFAULT_OVERSCAN,
        onSelect,
        renderOutcome = null,
    }: Props = $props();

    /** Paging: rows, cursor, has_more, the server's filter block. */
    // Built WITHOUT the scope on purpose. The scope effect below is what
    // loads a listing, and seeding this from the prop would read it once at
    // construction and then silently disagree with it forever.
    let paging = $state<PagingState>(emptyPaging());
    /** The scheme filter in force. Server-side; changing it RELOADS. */
    let scheme = $state<string>(DEFAULT_SCHEME);
    /** The typed fuzzy text, per column. Client-side; changing it repaints. */
    let queries = $state<Record<string, string>>(blankQueries());
    /** True while a page request is in flight. */
    let busy = $state(false);

    /**
     * The three numbers the window needs, all MEASURED and none assumed.
     * Zero anywhere means "not measured", which `computeWindow` refuses
     * on by rendering every loaded row - the vanilla behaviour.
     */
    let m = $state<Measurements>({ viewportHeight: 0, scrollTop: 0, rowHeight: 0 });

    /** The `<ul>`, for measuring a real row off it. */
    let rowsEl = $state<HTMLUListElement | null>(null);

    /**
     * The keyboard cursor. REUSED FROM SLICE 4 rather than rebuilt:
     * `keys.ts::createSelection` is documented as "a pure index cursor
     * over a virtualized list", holds a COUNT and an INDEX and no rows,
     * and therefore survives its row scrolling out of the render window -
     * there is no element for it to lose. That property is what a
     * windowed list needs and it already existed.
     */
    const selection = createSelection();
    /** Mirror of `selection.index()`, so the template reacts to a move. */
    let selectedIndex = $state(-1);

    /** A blank query map, one empty string per fuzzy column. */
    function blankQueries(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const col of COLUMNS) out[col.key] = '';
        return out;
    }

    /** The rows to draw, after the client-side fuzzy filter. */
    const visible = $derived(
        visibleRows(paging.rows, queries, fuzzy, rowValue),
    );

    /** Whether any column is actually being filtered. */
    const filtering = $derived(isFiltering(queries, fuzzy));

    /** Which of `visible` are actually in the DOM. */
    const win = $derived<RenderWindow>(
        computeWindow({
            count: visible.length,
            scrollTop: m.scrollTop,
            viewportHeight: m.viewportHeight,
            rowHeight: m.rowHeight,
            overscan,
        }),
    );

    /** The window's slice of `visible`, with each row's absolute index. */
    const windowed = $derived(
        win.last < win.first
            ? []
            : visible
                .slice(win.first, win.last + 1)
                .map((m, i) => ({ ...m, index: win.first + i })),
    );

    /** The server-side filter's honesty line. */
    const splitNote = $derived(
        describeFilter(paging.rows.length, paging.filters),
    );

    /** The client-side filter's own, separate honesty line. */
    const fuzzyLine = $derived(
        fuzzyNote(visible.length, paging.rows.length, paging.hasMore, filtering),
    );

    /**
     * True when a typed filter matched none of the loaded rows. A stated
     * empty, never a blank pane.
     */
    const filteredEmpty = $derived(
        visible.length === 0 && paging.rows.length > 0 && filtering,
    );

    // A SCOPE CHANGE IS A DIFFERENT QUESTION, so it discards every prior
    // row rather than appending to them. Keyed on the scope's own fields
    // rather than on object identity, so a parent that rebuilds an
    // equivalent object on every render does not reload the list.
    $effect(() => {
        const key = `${scope.kind}:${String(scope.id)}`;
        void key;
        void load();
    });

    // MEASUREMENT, NOT ASSUMPTION, AND THE SCROLLPORT IS GIVEN RATHER
    // THAN FOUND. A null port leaves every number at zero, which
    // `computeWindow` refuses on - so a list with no scrolling ancestor
    // renders exactly what the vanilla list rendered.
    $effect(() => watchScrollport(scrollport, () => {
        readScrollport(scrollport, m);
    }));

    // ROW HEIGHT IS READ OFF A REAL ROW, never from a constant. The rows
    // are not uniform - the 769px media query forces four of the eight
    // spans onto their own line - so a constant would be a fabricated
    // measurement. Re-read whenever the rendered set or the viewport
    // changes, so crossing that breakpoint corrects itself.
    $effect(() => {
        void windowed.length;
        void m.viewportHeight;
        m.rowHeight = measureRowHeight(rowsEl, m.rowHeight);
    });

    // The cursor is told how many rows exist. GROWING PRESERVES THE
    // INDEX, which is `createSelection`'s own documented rule and is why
    // paging cannot move a selection.
    $effect(() => {
        selection.setCount(visible.length);
        selectedIndex = selection.index();
    });

    /**
     * Start a NEW listing, discarding every prior row.
     * Inputs: none. Output: the outcome token of the first page.
     * Example: await load()  // -> 'ok'
     */
    export async function load(): Promise<string> {
        if (scope.id === null || scope.id === undefined) return 'no-scope';
        paging = emptyPaging(scope);
        busy = true;
        try {
            const r = await fetchPage(client, scope, scheme, null);
            paging = applyPage(emptyPaging(scope), r, outcome);
            return paging.token;
        } finally {
            busy = false;
        }
    }

    /**
     * Fetch the next page. REFUSES when the previous response supplied no
     * cursor, rather than re-requesting page one, which would duplicate
     * rows in a list somebody has paged 68 times.
     * Inputs: none. Output: the outcome token, or 'no-cursor'.
     */
    export async function loadMore(): Promise<string> {
        if (!canLoadMore(paging) || busy) return 'no-cursor';
        busy = true;
        try {
            const r = await fetchPage(client, scope, scheme, paging.nextCursor);
            paging = applyPage(paging, r, outcome);
            return paging.token;
        } finally {
            busy = false;
        }
    }

    /**
     * Change the scheme filter and RE-QUERY the scope.
     *
     * It reloads rather than repaints, because the filter is the
     * server's: "show me the conversations" is a different query, not a
     * subset of the rows this list happens to hold. The cursor is
     * discarded deliberately - one minted under one filter positions
     * inside that filter's result set, and replaying it under another
     * would skip rows.
     * Inputs: value - a SCHEME_FILTERS value.
     * Output: the reload's outcome token, or 'no-scope'.
     */
    export async function setSchemeFilter(value: string): Promise<string> {
        // Recorded BEFORE the reload, not after: the control must show
        // the choice the moment it is made, not when the server answers.
        // The reload can fail; the choice was still made.
        scheme = value || DEFAULT_SCHEME;
        return load();
    }

    /**
     * Advance to the next scheme filter, which is what the `t` key does.
     * Inputs: none. Output: the reload's outcome token.
     */
    export function cycleScheme(): Promise<string> {
        return setSchemeFilter(nextScheme(scheme, SCHEME_DEFS));
    }

    /**
     * Move the keyboard cursor and bring its row into view.
     * Inputs: delta - rows to move, negative for up.
     * Output: the index landed on, -1 when the list is empty.
     * Example: moveSelection(1)  // j
     */
    export function moveSelection(delta: number): number {
        selectedIndex = selection.move(delta);
        const to = scrollToShow(
            selectedIndex, m.scrollTop, m.viewportHeight, m.rowHeight,
        );
        if (to !== null && scrollport) {
            (scrollport as HTMLElement).scrollTop = to;
            m.scrollTop = to;
        }
        return selectedIndex;
    }

    /**
     * Open the selected transcript, which is what Enter does.
     * Inputs: none. Output: true when something was opened.
     */
    export function openSelected(): boolean {
        const at = selection.index();
        const hit = at >= 0 ? visible[at] : null;
        if (!hit || typeof onSelect !== 'function') return false;
        const id = hit.row.transcript_id;
        if (id === null || id === undefined) return false;
        onSelect(id, hit.row);
        return true;
    }

    /** The rows fetched so far, for a test or a parent. */
    export function rows(): readonly TranscriptRowData[] {
        return paging.rows;
    }

    /** The paging cursor, for a test. */
    export function cursor(): string | null {
        return paging.nextCursor;
    }

    /** `has_more` AS RECEIVED. Three-valued. */
    export function hasMore(): boolean | null {
        return paging.hasMore;
    }

    /** The scheme filter in force. */
    export function currentScheme(): string {
        return scheme;
    }

    /** The render window in force, for a test asserting the bound. */
    export function renderWindow(): RenderWindow {
        return win;
    }
</script>

<section class={CLASS.root}>
    <div class={CLASS.header}>
        <TranscriptListFilter
            {scheme}
            {queries}
            note={fuzzyLine}
            hideScheme={scope.kind === 'unattributed'}
            onScheme={(v) => { void setSchemeFilter(v); }}
            onQuery={(q) => { queries = { ...q }; }}
        />
    </div>

    <p class={CLASS.splitNote}>{splitNote}</p>

    <ul class={CLASS.rows} bind:this={rowsEl}>
        <!-- THE SPACERS CARRY NO CLASS. See the header: a new class name
             is forbidden and so is touching any archive stylesheet, and
             no rule in those 12 files matches a bare `li`. Rendered only
             when non-zero, so an unwindowed list has exactly the vanilla
             markup, spacer-free. -->
        {#if win.padTop > 0}
            <li aria-hidden="true" style="height: {win.padTop}px"></li>
        {/if}

        {#each windowed as item (item.row.transcript_id)}
            <TranscriptRow
                row={item.row}
                spans={item.spans}
                {fuzzy}
                unattributed={scope.kind === 'unattributed'}
                selected={item.index === selectedIndex}
                {onSelect}
            />
        {/each}

        {#if win.padBottom > 0}
            <li aria-hidden="true" style="height: {win.padBottom}px"></li>
        {/if}
    </ul>

    <TranscriptListFooter
        hasMore={paging.hasMore}
        loaded={paging.rows.length}
        {busy}
        loading={busy && paging.rows.length === 0}
        {filteredEmpty}
        transportError={paging.transportError}
        outcomeEnvelope={paging.outcomeEnvelope}
        {renderOutcome}
        onLoadMore={() => { void loadMore(); }}
    />
</section>
