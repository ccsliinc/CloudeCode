<!--
  THE DEVELOPMENT PREVIEW HARNESS. SCAFFOLDING, NOT SLICE 3, AND NOT A
  CONTRACT.

  WHAT IT IS FOR. Slice 5 (`NavRail`) and slice 6 (`TranscriptList`) were
  both built shell-independent, because Adam is replacing the whole
  application shell (issue #175) and the screen that will host them does
  not exist yet. That was the right call and it left two finished
  components nobody could click. This file is the smallest thing that
  mounts BOTH and wires the ONE interaction neither can demonstrate
  alone: choosing a project in the rail drives the listing in the list.

  WHAT IT IS NOT. It is not the archive screen. It owns no route, reads
  no address bar, publishes no global, defines no class name and is
  imported by nothing under `web/src/`. When the real shell arrives,
  `mv web/dev-harness ~/.Trash/` and delete the `dev:harness` script;
  nothing breaks, which is the whole design and is pinned by
  `src/dev-harness-isolation.test.ts`.

  THE LAYOUT IS THE ONE THING IT HAD TO INVENT, AND IT IS CONTAINED TWO
  WAYS. Both components deliberately declare no width, no position and
  no viewport unit: each fills whatever box a parent hands it, so
  SOMETHING has to be that parent and that something is below. It is
  contained by (1) using NO class attributes at all - every rule in the
  `<style>` block is an ELEMENT selector, which Svelte compiles with this
  component's own scope hash and which therefore cannot match a node
  rendered by NavRail, by TranscriptList or by any of the twelve archive
  stylesheets - and (2) using no `:global(...)`, anywhere in
  `web/dev-harness/`. A grep for either is a test, not a promise.

  THE SCROLLPORT IS WHY THE RIGHT PANE EXISTS. `TranscriptList` takes
  the SCROLLING ancestor as a prop rather than reaching for it with
  `closest()`, and windows its rows against it. The `<section>` below is
  that ancestor, `overflow: auto` is what makes it one, and
  `bind:this` is how the component is handed it.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { NavRail, TranscriptList, countFor, NODE_KINDS } from '../src/lib/plugins/history/index';
    import type {
        ArchiveClient, ListScope, NavRowData, NodeKind,
    } from '../src/lib/plugins/history/index';
    import { harnessFuzzy, harnessModalStack, harnessOutcome } from './harness-legacy';

    interface Props {
        /** The granted archive client both components are handed. */
        client: ArchiveClient;
        /** Drop the stored token and go back to the login panel. */
        onSignOut: () => void;
    }

    let { client, onSignOut }: Props = $props();

    /**
     * The listing on screen, or null before anything has been picked.
     * NULL IS RENDERED AS A PROMPT, NEVER AS AN EMPTY LIST: a scope with
     * a null id would send `/archive/projects/null/transcripts`, and an
     * empty list and a list nobody asked for render identically.
     */
    let scope = $state<ListScope | null>(null);

    /** What the rail last handed over, for the pane heading. */
    let chosenLabel = $state<string | null>(null);

    /**
     * The scrolling ancestor handed to `TranscriptList`. `$state` rather
     * than a plain `let` so the component sees it the moment the binding
     * lands, whichever order mount happens to run in.
     */
    let scrollport = $state<HTMLElement | null>(null);

    /** The one classifier in the client. Throws if the module is absent. */
    const outcome = harnessOutcome();
    /** Optional, degrades to no client-side filtering. */
    const fuzzy = harnessFuzzy();
    /** Optional, degrades to no Escape routing on the details modal. */
    const modalStack = harnessModalStack();

    /**
     * Where the rail remembers its order choice. `localStorage` already
     * satisfies `ModeStore`; passing the real one means the preview
     * exercises the real persistence rather than a stub of it.
     */
    const orderStore = typeof localStorage !== 'undefined' ? localStorage : null;

    /** Where the details modal parents its overlay, as in the real app. */
    const modalHost = typeof document !== 'undefined' ? document.body : null;

    /**
     * The rail's instance, for the ONE call a parent has to make.
     *
     * THE RAIL DOES NOT LOAD ITSELF, AND THAT IS ITS CONTRACT, NOT A
     * BUG. `ensureViewLoaded()` is exported rather than run from an
     * effect so that the composition root decides WHEN the first request
     * goes out - a screen that mounts the rail behind a route, or before
     * a token exists, must be able to hold it back. The cost of that
     * design is exactly this: a parent that forgets the call gets a rail
     * that paints its filter, its order control and "No projects in this
     * view", with no request made and no error to see. That is the empty
     * list this component's own header calls the false green, and the
     * first draft of this harness reproduced it faithfully. It was
     * caught by LOOKING AT THE PAGE; it compiled, mounted and logged
     * nothing.
     */
    let rail = $state<ReturnType<typeof NavRail> | undefined>(undefined);

    onMount(() => {
        void rail?.ensureViewLoaded();
    });

    /**
     * A node was chosen in the rail: start a new listing in the list.
     *
     * Description: THE INTERACTION THIS HARNESS EXISTS TO SHOW. The rail
     *   calls this only for a leaf - `project` or `unattributed`; a host
     *   or a corpus expands inside the rail and never reaches here - and
     *   those two kinds are exactly `ListScope`'s two kinds, so the map
     *   is one to one and invents nothing.
     *
     *   `inScope` IS READ THROUGH `countFor`, the rail's own reader,
     *   rather than by picking a field name here. The two kinds carry
     *   the count under DIFFERENT names (`transcript_count` against
     *   `unattributed_transcript_count`) and a second spelling of that
     *   rule is a second thing to keep in step. A count that is not a
     *   number stays null, which the list renders as NOT KNOWN.
     * Inputs: kind - 'project' or 'unattributed'. id - the project id, or
     *   the corpus id for the unattributed listing. row - the clicked row.
     * Output: void.
     */
    function select(kind: NodeKind, id: number | string | null, row: NavRowData): void {
        if (id === null) return;
        const listKind = kind === NODE_KINDS.UNATTRIBUTED ? 'unattributed' : 'project';
        scope = { kind: listKind, id, inScope: countFor(kind, row) };
        chosenLabel = labelOf(kind, id, row);
    }

    /**
     * A short heading for the chosen node. HARNESS TEXT, NOT THE RAIL'S.
     *
     * Description: deliberately NOT `labelFor` from `nav-row.ts`. That
     *   function is what the rail paints INSIDE itself, and reproducing
     *   its output in harness chrome would put a second renderer of the
     *   same thing on screen beside the first, which is how two
     *   renderings come to disagree. This is a scaffold caption and
     *   reads like one.
     * Inputs: kind, id, row. Output: a plain string.
     */
    function labelOf(kind: NodeKind, id: number | string, row: NavRowData): string {
        const path = row['full_path'];
        const name = typeof path === 'string' && path !== '' ? path : `id ${id}`;
        return `${kind}: ${name}`;
    }

    /**
     * One transcript was clicked in the list.
     *
     * Description: THE READER IS SLICE 7 AND DOES NOT EXIST, so this
     *   says so out loud instead of pretending. Opening nothing silently
     *   would read as a broken list.
     * Inputs: transcriptId. Output: void.
     */
    function openTranscript(transcriptId: number | string): void {
        console.info(`[dev-harness] transcript ${transcriptId} was chosen. The `
            + 'reader is slice 7 and is not built, so there is nothing to open.');
    }
</script>

<main>
    <header>
        <span>dev harness - real NavRail and real TranscriptList, real archive API</span>
        <button type="button" onclick={onSignOut}>forget token</button>
    </header>
    <div>
        <nav>
            <NavRail
                bind:this={rail}
                {client}
                {outcome}
                onSelect={select}
                store={orderStore}
                {modalStack}
                {modalHost}
            />
        </nav>
        <section bind:this={scrollport}>
            {#if scope === null}
                <p>pick a project in the rail on the left.</p>
            {:else}
                <p>{chosenLabel}</p>
                <TranscriptList
                    {client}
                    {outcome}
                    {scope}
                    {scrollport}
                    {fuzzy}
                    onSelect={openTranscript}
                />
            {/if}
        </section>
    </div>
</main>

<style>
    /*
      ELEMENT SELECTORS ONLY, AND NO `:global`. Svelte stamps each rule
      below with this component's scope hash, so `nav` compiles to
      `nav.svelte-<hash>` and matches exactly the one element rendered
      here. Nothing in NavRail, in TranscriptList or in the twelve
      archive stylesheets carries that hash, so nothing below can reach
      them. That is the containment claim, and it holds because there is
      no class attribute and no `:global(...)` in this directory.
    */
    main {
        display: flex;
        flex-direction: column;
        height: 100vh;
        min-height: 0;
        background: var(--color-bg-page, #1a1a1a);
        color: var(--color-fg, #d4d4d4);
        font-family: system-ui, sans-serif;
    }

    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex: 0 0 auto;
        padding: 6px 12px;
        font-size: 11px;
        color: var(--color-fg-muted, #9a9a9a);
        border-bottom: 1px solid var(--color-border, #444);
    }

    header button {
        font-size: 11px;
        padding: 3px 8px;
        color: var(--color-fg-muted, #9a9a9a);
        background: transparent;
        border: 1px solid var(--color-border, #444);
        border-radius: var(--radius-sm, 4px);
        cursor: pointer;
    }

    div {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
    }

    /* The rail declares no width of its own, by design. This is it. */
    nav {
        flex: 0 0 320px;
        min-height: 0;
        overflow: auto;
        border-right: 1px solid var(--color-border, #444);
    }

    /* THE SCROLLPORT. `overflow: auto` is what makes it one. */
    section {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
    }

    section p {
        flex: 0 0 auto;
        margin: 0;
        padding: 8px 12px;
        font-size: 11px;
        color: var(--color-fg-muted, #9a9a9a);
    }
</style>
