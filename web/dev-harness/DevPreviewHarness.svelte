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
    import {
        NavRail, TranscriptList, TranscriptReader, countFor, labelFor, NODE_KINDS,
    } from '../src/lib/plugins/history/index';
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
     *
     *   IT ALSO CLOSES AN OPEN READER, AND THAT IS THE WHOLE OF PUNCHLIST
     *   DEFECT 1. The reader branch below is tested BEFORE the listing
     *   branch, so while `openId` was set the rail's selection changed
     *   `scope` and `chosenLabel` behind a transcript that stayed on
     *   screen. Nothing threw, nothing logged, and the request for the
     *   new listing went out and was applied, so from the outside it read
     *   as a rail that had stopped responding to clicks. A parent that
     *   owns BOTH pieces of view state has to move both of them, or the
     *   one it forgets silently outranks the one it set.
     * Inputs: kind - 'project' or 'unattributed'. id - the project id, or
     *   the corpus id for the unattributed listing. row - the clicked row.
     * Output: void.
     */
    function select(kind: NodeKind, id: number | string | null, row: NavRowData): void {
        if (id === null) return;
        const listKind = kind === NODE_KINDS.UNATTRIBUTED ? 'unattributed' : 'project';
        scope = { kind: listKind, id, inScope: countFor(kind, row) };
        chosenLabel = labelOf(kind, id, row);
        openId = null;
    }

    /**
     * A short heading for the chosen node. HARNESS CHROME, ONE RENDERER.
     *
     * Description: IT CALLS `labelFor`, the rail's own reader, and the
     *   first draft deliberately did not. That draft read `full_path`
     *   directly, which is the SLUG, so the caption printed
     *   '-Users-jsugamele-Library-Mobile-Documents-...' over a rail row
     *   that was painting whatever `display_name` the server had sent.
     *   Two renderers of one name is exactly how they come to disagree,
     *   and here they disagreed the moment a project had a name at all.
     *   The caption keeps its own `kind:` prefix, which is the part that
     *   is genuinely scaffold text.
     *
     *   NOTE WHAT THIS DOES NOT FIX. `labelFor` prefers `display_name`
     *   and falls back to the slug, and on this install the server sends
     *   a null `display_name` for every project, so the slug is still
     *   what both now print. That is a data gap in the archive, not a
     *   rendering choice: see the note in the report.
     * Inputs: kind, id, row. Output: a plain string.
     */
    function labelOf(kind: NodeKind, id: number | string, row: NavRowData): string {
        const name = labelFor(kind, row) || `id ${id}`;
        return `${kind}: ${name}`;
    }

    /**
     * The transcript open in the reader, or null for none.
     *
     * NULL IS RENDERED AS THE LIST, NOT AS AN EMPTY READER. A reader
     * mounted on a null id would request `/archive/transcripts/null` and
     * paint a refusal for a transcript nobody asked for.
     */
    let openId = $state<number | string | null>(null);

    /**
     * The reader's instance, for the ONE call a parent has to make.
     *
     * THE READER DOES NOT LOAD ITSELF, AND THAT IS ITS CONTRACT, exactly
     * as `NavRail.ensureViewLoaded()` is. `open()` is exported rather than
     * run from an effect so the composition root decides WHEN the first
     * request goes out. The cost of that design is a parent which forgets
     * the call getting a reader that paints its idle state with no
     * request made and no error to see - the false green this harness's
     * own header describes, and the bug its first draft shipped. So the
     * call below is the whole reason this binding exists.
     */
    let reader = $state<ReturnType<typeof TranscriptReader> | undefined>(undefined);

    /**
     * One transcript was clicked in the list: open it in the reader.
     *
     * Description: THE INTERACTION SLICE 7 EXISTS FOR. The list hands
     *   back the `transcript_id` and never the `session_ref`, which is
     *   not an identity - measured, `journal` names 14 different
     *   transcripts - so this is keyed on the id it was given.
     * Inputs: transcriptId. Output: void.
     */
    function openTranscript(transcriptId: number | string): void {
        openId = transcriptId;
    }

    /** Go back to the transcript list. */
    function closeTranscript(): void {
        openId = null;
    }

    // Open the transcript the moment one is chosen, and again whenever a
    // DIFFERENT one is. `untrack` is not needed: `open()` writes only the
    // reader's own state, not ours.
    $effect(() => {
        const id = openId;
        if (id === null) return;
        void reader?.open();
    });
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
            {#if openId !== null}
                <p>
                    reading transcript {openId}
                    <button type="button" onclick={closeTranscript}>back to the list</button>
                </p>
                <!--
                  KEYED ON THE ID. Choosing a DIFFERENT transcript must
                  build a NEW reader rather than hand the old one a new
                  prop: the reader holds one transcript's geometry, body
                  cache and expansions, and a `line_no` from the old file
                  can numerically coincide with one from the new.
                -->
                {#key openId}
                    <TranscriptReader
                        bind:this={reader}
                        {client}
                        {outcome}
                        transcriptId={openId}
                    />
                {/key}
            {:else if scope === null}
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
