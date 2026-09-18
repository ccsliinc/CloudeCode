<!--
  NavRail - the archive's navigation rail: the merged project list by
  default, the by-machine drill-down behind it, a fuzzy filter, an order
  control and the project details modal.

  IT ASSUMES NO SHELL, AND THAT IS THE REQUIREMENT IT WAS BUILT AGAINST.
  Adam is replacing the entire application shell (issue #175): new nav,
  new sidebar, a full re-skin, with Archive becoming a first-class
  sidebar item. So this component must mount into a shell that does not
  exist yet. Concretely it:
    - does not own the viewport. `.archive-nav` declares no width, no
      position and no viewport unit, so it fills whatever box a parent
      hands it. That was already true of the vanilla markup and reusing
      the class verbatim preserves it.
    - never reads the current header or sidebar, and calls no
      `querySelector` at all, inside its subtree or out of it. The
      vanilla rail called `querySelectorAll` to find a node's child slot;
      the tree is rendered from state here, so the call has no successor.
    - reaches NO host global. `window.ArchiveNavOrder`,
      `window.ArchiveNavMerged`, `window.ArchiveNavFuzzy`,
      `window.ArchiveNavCard`, `window.ArchiveNavInfo`,
      `window.ArchiveNavDrill`, `window.ArchiveNavTree`,
      `window.ArchiveOutcome`, `window.ArchiveOutcomeView`,
      `window.ArchiveProjectOverlay`, `window.ModalStack` and
      `window.localStorage` are ALL gone; every one arrives as an import
      or a prop.
    - depends on no fixed pixel chrome and measures nothing off the page.

  WHAT A PARENT MUST SUPPLY, in full: a granted `client`, an `outcome`
  classifier, and `onSelect`. Everything else is optional and degrades
  named rather than silently: no `store` means the order choice is not
  remembered, no `modalStack` means the details modal has no Escape
  routing, no `renderOutcome` means a refusal's own reasons are not
  drawn and its transport reason still is, no `overlay` means no
  client-side presentation fallback.

  THE GAP IN THE app-screen SURFACE, STATED RATHER THAN WORKED AROUND.
  `AppScreen.mount(container, route, context, api)` hands a screen a
  container, a route, a context and a granted client. It has no way to
  describe an OVERLAY HOST and no way to hand over the modal stack, even
  though `docs/archive-shell-contract.md` records `window.ModalStack` as
  a REQUIRED host global that survives all nine slices. Reaching for
  either from inside this tree would be exactly the reach-around this
  work forbids, so `modalStack` and `modalHost` are PROPS and they are
  the temporary seam - the same shape slice 6 used for its `scrollport`.
  They are TWO props because they answer two questions and a shell could
  reasonably replace one without the other: what routes Escape, and
  where overlays are parented. Neither is optional in practice on this
  app, and `NavInfoModal.svelte` records what breaks when one is absent.

  NO VIEW BAR. The "All projects" / "By machine" buttons and the machine
  dropdown were REMOVED at the owner's instruction: "i dont think we
  need the button and dropdown on the left column." Merged is the only
  view anyone can reach by clicking. THE BY-MACHINE TREE IS NOT DELETED,
  only unexposed: `setView`, `view` and `setHostFilter` are exported and
  still work, so a deep link and a test still reach it.

  LOAD WHAT THE ACTIVE VIEW NEEDS, AND NOTHING ELSE. The screen used to
  call `loadHosts()` on every route, which fetched the drill-down the
  user was NOT looking at and never fetched the merged list that is the
  default - so the rail opened empty, with no request made and no error
  to see. An empty list and a list nobody asked for render identically,
  which is the false green this rail is written against.

  Replaces client/js/archive-nav.js, archive-nav-row.js,
  archive-nav-card.js, archive-nav-info.js, archive-nav-merged.js,
  archive-nav-order.js, archive-nav-fuzzy.js, archive-nav-drill.js and
  archive-nav-tree.js.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { CLASS, NODE_KINDS, VIEWS, type NavView, type NodeKind } from './nav-vocab';
    import { describeFilter, type NavRowData } from './nav-row';
    import { paintMerged } from './nav-merged';
    import { applyMerged, emptyMerged, type MergedState } from './nav-merged-load';
    import {
        DEFAULT_MODE, MODES, isMode, readMode, writeMode, type ModeStore,
    } from './nav-order';
    import {
        applyLevel, emptyLevel, fetchLevel, levelKey, HOSTS_KEY,
        type DrillState,
    } from './nav-drill';
    import type { OverlayFallback, Presentation } from './nav-card';
    import type { ModalStackLike } from './keys-help';
    import NavLevel from './NavLevel.svelte';
    import NavOutcome from './NavOutcome.svelte';
    import NavProjectCard from './NavProjectCard.svelte';
    import NavNode from './NavNode.svelte';
    import NavInfoModal from './NavInfoModal.svelte';
    import type { ArchiveClient } from './client';
    import type { OutcomeClassifier } from './state';

    interface Props {
        /** The granted archive client from slice 2. Required. */
        client: ArchiveClient;
        /**
         * The outcome classifier, injected the same way `state.ts`
         * injects it: `archive-outcome.js` is still vanilla and this tree
         * reaches for no global.
         */
        outcome: OutcomeClassifier;
        /** A leaf or the unattributed node was chosen. Required. */
        onSelect: (kind: NodeKind, id: number | string | null, row: NavRowData) => void;
        /** Where the order choice is remembered, or null for not at all. */
        store?: ModeStore | null;
        /** The host's modal stack. See the header: a temporary seam. */
        modalStack?: ModalStackLike | null;
        /**
         * Where the details modal's overlay is parented. `document.body`
         * for this app. Null leaves it in this component's subtree,
         * which paints correctly and loses Escape routing - the second
         * half of the same seam. See `NavInfoModal.svelte`.
         */
        modalHost?: Element | null;
        /** A client-side presentation overlay, for a build with no endpoint. */
        overlay?: OverlayFallback | null;
        /** Turns a refusal envelope into an element, or null. */
        renderOutcome?: ((envelope: unknown) => Element | null) | null;
    }

    let {
        client, outcome, onSelect, store = null, modalStack = null,
        modalHost = null, overlay = null, renderOutcome = null,
    }: Props = $props();

    /** 'merged' or 'hosts'. Merged is the only one reachable by clicking. */
    let view = $state<NavView>(VIEWS.MERGED);
    /** The fuzzy filter text. Client-side; changing it repaints. */
    let filterText = $state('');
    /** The machine filter, or null for every machine. */
    let hostFilter = $state<string | null>(null);

    /**
     * THE STORED ORDER IS READ ONCE, not per paint. Reading it on every
     * repaint would hit localStorage on every keystroke in the filter box.
     */
    // Read ONCE, deliberately outside the reactive graph: the stored
    // choice is a starting value, not a binding. Re-reading it would
    // hit localStorage on every repaint and would also fight the
    // person's own change the moment he made one.
    const initialOrder = untrack(() => readMode(store).mode);
    let orderMode = $state<string>(initialOrder);

    /** The merged listing: nodes, the unattributed rows, the machines. */
    let merged = $state<MergedState>(emptyMerged());

    /** Every drill-down level fetched so far, keyed by `levelKey`. */
    let drill = $state<DrillState>({});
    /** Which drill-down level keys are open. */
    let open = $state<ReadonlySet<string>>(new Set<string>());

    /** The project whose details modal is up, or null. At most one. */
    let info = $state<{ row: NavRowData; presentation: Presentation } | null>(null);

    /** Everything the merged view draws, recomputed only when an input moves. */
    const painted = $derived(paintMerged(
        merged.nodes, merged.unattributed, hostFilter, filterText, orderMode,
    ));

    /**
     * The honest filter sentence, or '' when nothing is filtered. A
     * filter that reads like a search of the corpus is a false green
     * with a text box on it.
     */
    const filterNote = $derived(filterText
        ? (view === VIEWS.MERGED
            ? describeFilter(painted.rendered, painted.total, merged.total, 'projects')
            : describeFilter(
                (drill[HOSTS_KEY] || emptyLevel()).rows.length,
                (drill[HOSTS_KEY] || emptyLevel()).rows.length,
                (drill[HOSTS_KEY] || emptyLevel()).total,
                'hosts',
            ))
        : '');

    /** Replace one drill level, without mutating the map in place. */
    function putLevel(key: string, next: DrillState[string]): void {
        drill = { ...drill, [key]: next };
    }

    /**
     * Fetch the merged project list - the default view.
     *
     * Description: ONE request, not paginated. 77 nodes, and a page of a
     *   merged tree would let someone conclude a project lives on one
     *   machine because the row proving otherwise fell on page 2.
     * Inputs: none. Output: the outcome token.
     * Example: await loadMergedProjects()   // -> 'ok'
     */
    export async function loadMergedProjects(): Promise<string> {
        merged = applyMerged(await client.listArchiveMergedProjects(), outcome);
        return merged.token;
    }

    /**
     * Fetch and hold the top level of the by-machine drill-down.
     * Inputs: none. Output: the outcome token.
     */
    export async function loadHosts(): Promise<string> {
        putLevel(HOSTS_KEY, { ...emptyLevel(), token: 'loading' });
        const r = await client.listArchiveHosts();
        const next = applyLevel(r, outcome);
        putLevel(HOSTS_KEY, next);
        return next.token;
    }

    /**
     * Expand a host into its corpora, or a corpus into its projects.
     *
     * Description: a level already fetched is reopened without a second
     *   request, which is what makes collapsing and reopening free.
     * Inputs: kind - HOST or CORPUS. id.
     * Output: the outcome token, or 'not-found' when the id is unusable.
     * Example: await expand('host', 2)   // -> 'ok'
     */
    export async function expand(
        kind: NodeKind, id: number | string | null,
    ): Promise<string> {
        if (id === null || id === undefined) return 'not-found';
        const key = levelKey(kind, id);
        const next = new Set(open);
        if (next.has(key)) {
            next.delete(key);
            open = next;
            return drill[key]?.token || 'idle';
        }
        next.add(key);
        open = next;
        if (drill[key] && drill[key].token !== 'idle') return drill[key].token;
        putLevel(key, { ...emptyLevel(), token: 'loading' });
        const r = await fetchLevel(client, kind, id);
        const level = applyLevel(r, outcome);
        putLevel(key, level);
        return level.token;
    }

    /**
     * A row was clicked: expand a container, or hand a leaf to the caller.
     * Inputs: kind, id, row. Output: void.
     */
    function activate(kind: NodeKind, id: number | string | null, row: NavRowData): void {
        if (kind === NODE_KINDS.HOST || kind === NODE_KINDS.CORPUS) {
            void expand(kind, id);
            return;
        }
        onSelect(kind, id, row);
    }

    /**
     * Switch between the merged list and the by-machine drill-down.
     * Inputs: next - 'merged' or 'hosts'. Output: the outcome token.
     */
    export async function setView(next: string): Promise<string> {
        view = next === VIEWS.HOSTS ? VIEWS.HOSTS : VIEWS.MERGED;
        if (view === VIEWS.MERGED) {
            return merged.nodes.length ? 'ok' : loadMergedProjects();
        }
        return drill[HOSTS_KEY] ? 'ok' : loadHosts();
    }

    /**
     * Load whatever the ACTIVE view needs, and nothing else.
     *
     * Description: idempotent. `setView` refuses to refetch a loaded
     *   view, so calling this on every route costs one request per view
     *   per session.
     * Inputs: none. Output: the outcome token.
     */
    export function ensureViewLoaded(): Promise<string> {
        return setView(view);
    }

    /**
     * Change the order as a click would: set it, persist it, repaint.
     * Inputs: mode - a MODES id. Output: whether it was a mode at all.
     */
    export function setOrder(mode: string): boolean {
        if (!isMode(mode)) return false;
        orderMode = mode;
        writeMode(mode, store);
        return true;
    }

    /**
     * Narrow the merged list to one machine.
     * Inputs: hostId - null, undefined or '' for all. Output: void.
     */
    export function setHostFilter(hostId: number | string | null | undefined): void {
        hostFilter = (hostId === null || hostId === undefined || hostId === '')
            ? null : String(hostId);
    }

    /**
     * Set the filter text, which is what typing does.
     * Inputs: text. Output: void.
     */
    export function setFilter(text: string): void {
        filterText = String(text === null || text === undefined ? '' : text);
    }

    /**
     * Clear the filter, which is Escape rung 2.
     *
     * Description: clears the INPUT as well as the state. Clearing only
     *   the state leaves the box showing text that no longer filters
     *   anything, which reads as a broken filter.
     * Inputs: none. Output: void.
     */
    export function clearFilter(): void {
        filterText = '';
    }

    /** The filter box's current text, for the Escape ladder. */
    export function currentFilter(): string {
        return filterText;
    }

    /** The filter input, so `/` has something to focus. */
    export function filterElement(): HTMLInputElement | null {
        return filterEl;
    }

    /** The active view, for a test and for the shell. */
    export function currentView(): NavView {
        return view;
    }

    /** The active order id. */
    export function currentOrder(): string {
        return orderMode;
    }

    /** What the last paint rendered, so a test need not recount the DOM. */
    export function lastPaint(): { rendered: number; total: number; hiddenUnattributed: number } {
        return {
            rendered: painted.rendered,
            total: painted.total,
            hiddenUnattributed: painted.hiddenUnattributed,
        };
    }

    /** The merged nodes as fetched, for a test. */
    export function mergedNodes(): readonly MergedState['nodes'][number][] {
        return merged.nodes;
    }

    /** Rows fetched for one drill level key, for a test. */
    export function rowsLoaded(key: string): readonly NavRowData[] {
        return (drill[key] || emptyLevel()).rows;
    }

    /** Open the details modal without a click, for a deep link or a test. */
    export function openInfo(row: NavRowData, presentation: Presentation): void {
        info = { row, presentation };
    }

    /** The open details modal's row, or null. */
    export function infoModal(): NavRowData | null {
        return info ? info.row : null;
    }

    let filterEl = $state<HTMLInputElement | null>(null);
</script>

<nav class={CLASS.root} aria-label="Archive navigation">
    <input
        bind:this={filterEl}
        class={CLASS.filter}
        type="search"
        placeholder="filter projects (fuzzy)"
        aria-label="Filter the rows already loaded"
        value={filterText}
        oninput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
    />

    <!-- A REAL <select>, not a div dressed as one: it inherits the
         platform's keyboard handling, its focus ring and its
         screen-reader semantics for free. -->
    <div class={CLASS.order}>
        <label class={CLASS.orderLabel} for="archive-nav-order">Order</label>
        <select
            class={CLASS.orderSelect}
            id="archive-nav-order"
            aria-label="Order the project list"
            value={orderMode}
            onchange={(e) => setOrder((e.currentTarget as HTMLSelectElement).value || DEFAULT_MODE)}
        >
            {#each MODES as mode (mode.id)}
                <option value={mode.id}>{mode.label}</option>
            {/each}
        </select>
    </div>

    <p class={CLASS.filterNote}>{filterNote}</p>

    <ul class="{CLASS.level} {CLASS.levelMerged}" hidden={view !== VIEWS.MERGED}>
        {#if merged.outcomeEnvelope !== null || merged.transportError !== null}
            <NavOutcome
                envelope={merged.outcomeEnvelope}
                transportError={merged.transportError}
                render={renderOutcome}
            />
        {:else}
            {#each painted.projects as hit (hit.row.project_id ?? hit.index)}
                <NavProjectCard
                    row={hit.row}
                    {overlay}
                    positions={hit.positions}
                    matchField={hit.field}
                    unsorted={hit.unsorted}
                    onActivate={activate}
                    onInfo={(row, presentation) => openInfo(row, presentation)}
                />
            {/each}

            <!-- AFTER the projects and NOT subject to the fuzzy filter:
                 these are a scope, not a project, and filtering them out
                 by name would hide the one population that is already
                 invisible from the project tree. -->
            {#each painted.unattributed as entry (String(entry.row.corpus_id))}
                <NavNode
                    kind={NODE_KINDS.UNATTRIBUTED}
                    row={{
                        corpus_id: entry.row.corpus_id,
                        unattributed_transcript_count: entry.row.transcript_count,
                        counted: entry.row.counted,
                    }}
                    reason={entry.reason}
                    onActivate={activate}
                />
            {/each}

            {#if painted.rendered === 0}
                <li class={CLASS.filterEmpty}>
                    {#if filterText}
                        No loaded projects match this filter.
                        {describeFilter(0, painted.total, painted.total, 'projects')}
                    {:else}
                        No projects in this view.
                    {/if}
                </li>
            {/if}

            {#if merged.partialEnvelope !== null}
                <NavOutcome envelope={merged.partialEnvelope} render={renderOutcome} />
            {/if}
        {/if}
    </ul>

    <ul class="{CLASS.level} {CLASS.levelHosts}" hidden={view !== VIEWS.HOSTS}>
        <NavLevel
            kind={NODE_KINDS.HOST}
            levelId={HOSTS_KEY}
            {drill}
            {open}
            {filterText}
            {overlay}
            {renderOutcome}
            onActivate={activate}
            onInfo={(row, presentation) => openInfo(row, presentation)}
        />
    </ul>

    {#if info}
        <NavInfoModal
            row={info.row}
            presentation={info.presentation}
            stack={modalStack}
            host={modalHost}
            {renderOutcome}
            onFilterHost={(hostId) => setHostFilter(hostId)}
            onClose={() => { info = null; }}
        />
    {/if}
</nav>

<style>
    /* THE CHROME ABOVE THE CARDS. Scoped, so it cannot reach the
     * vanilla rail that is still shipping; `NavProjectCard.svelte`
     * carries the full argument for leaving the 12 shared stylesheets
     * alone. Measured on the parity page's whole-rail column: the
     * order control's bottom edge and the first card's top edge were
     * BOTH at 82px, so the list touched the control with no
     * separation, while the rail's padding and the order control each
     * had 8px. The rhythm read 8 / 8 / 0 and now reads 8 / 6 / 8 - and
     * the chrome is 12px shorter, so the first card starts HIGHER than
     * before despite gaining a real gap. The select drops to its own
     * label's 0.8rem, so the pair reads as one control. */
    .archive-nav__filter { padding: 6px 10px; }

    .archive-nav__order { margin-top: 6px; }

    .archive-nav__order-select { padding: 4px 8px; font-size: 0.8rem; }

    /* The separation the list never had. */
    .archive-nav__level { margin-top: 8px; }
</style>
