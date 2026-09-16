<!--
  NavLevel - the contents of one level of the by-machine drill-down,
  drawn into whatever `<ul>` its caller put it in.

  IT IS RECURSIVE, WHICH IS THE WHOLE REASON THE VANILLA DOM HELPERS ARE
  GONE. `archive-nav-tree.js::slotFor` ran `querySelectorAll` over the
  rendered rail to find the `<ul>` belonging to a node, because the
  vanilla rail mutated a tree it had already drawn. This renders the tree
  FROM the state, so a level's contents are simply the state for its key
  and there is nothing to go looking for.

  A LEVEL THAT MATCHED NOTHING IS A STATED EMPTY, NOT AN OUTCOME BLOCK.
  Nothing was measured there: the person's own filter excluded
  everything, and saying that is different from "the server returned
  nothing".

  THE PARTIAL BANNER IS APPENDED, NEVER SUBSTITUTED. Rows AND the
  banner: dropping the rows to show the banner hides what did come back,
  dropping the banner claims the list is complete.

  THE UNATTRIBUTED NODE IS APPENDED TO EVERY EXPANDED CORPUS, always,
  and whether it is SHOWN is `shouldShowUnattributed`'s call, made in
  `nav-merged.ts` and not re-litigated here.
-->
<script lang="ts">
    import { CLASS, NODE_KINDS, type NodeKind } from './nav-vocab';
    import { describeFilter, filterRows, type NavRowData } from './nav-row';
    import {
        childKind, emptyLevel, levelKey, loadedCorpora, unattributedRowFor,
        LEVEL_FIELDS, type DrillState, type LevelState,
    } from './nav-drill';
    import { shouldShowUnattributed } from './nav-row';
    import NavNode from './NavNode.svelte';
    import NavOutcome from './NavOutcome.svelte';
    import NavProjectCard from './NavProjectCard.svelte';
    import type { OverlayFallback, Presentation } from './nav-card';
    import NavLevelSelf from './NavLevel.svelte';

    interface Props {
        /** The kind of node this level LISTS. */
        kind: NodeKind;
        /** The key this level is stored under in `drill`. */
        levelId: string;
        /** Every level fetched so far. */
        drill: DrillState;
        /** Which level keys are open. */
        open: ReadonlySet<string>;
        /** The rail's substring filter text. */
        filterText: string;
        /** The client-side presentation overlay, or null. */
        overlay?: OverlayFallback | null;
        /** Turns an envelope into an element, or null. */
        renderOutcome?: ((envelope: unknown) => Element | null) | null;
        /** A row was clicked: expand it, or hand it to the caller. */
        onActivate: (kind: NodeKind, id: number | string | null, row: NavRowData) => void;
        /** Open the details modal for a project. */
        onInfo?: (row: NavRowData, presentation: Presentation) => void;
    }

    let {
        kind, levelId, drill, open, filterText, overlay = null,
        renderOutcome = null, onActivate, onInfo,
    }: Props = $props();

    const level = $derived<LevelState>(drill[levelId] || emptyLevel());
    const fields = $derived(LEVEL_FIELDS[kind] || []);
    const visible = $derived(filterRows(level.rows, filterText, fields));
    /** Whether the person's own filter, rather than the server, emptied this. */
    const filteredEmpty = $derived(!!filterText && visible.length === 0);
    /** Hosts and corpora open into a child level; projects are leaves. */
    const expandable = $derived(kind !== NODE_KINDS.PROJECT);
</script>

{#if level.token === 'loading'}
    <li class={CLASS.loading}>loading...</li>
{:else if level.outcomeEnvelope !== null || level.transportError !== null}
    <NavOutcome
        envelope={level.outcomeEnvelope}
        transportError={level.transportError}
        render={renderOutcome}
    />
{:else if filteredEmpty}
    <li class={CLASS.filterEmpty}>
        No loaded rows match this filter.
        {describeFilter(0, level.rows.length, level.total, `${kind}s`)}
    </li>
{:else}
    {#each visible as row, i (i)}
        {#if kind === NODE_KINDS.PROJECT}
            <NavProjectCard {row} {overlay} {onActivate} {onInfo} />
        {:else}
            {@const id = kind === NODE_KINDS.HOST ? row.host_id : row.corpus_id}
            {@const childId = levelKey(kind, id as number | string)}
            <NavNode
                {kind}
                {row}
                expandable={expandable}
                expanded={open.has(childId)}
                {onActivate}
            >
                <NavLevelSelf
                    kind={childKind(kind)}
                    levelId={childId}
                    {drill}
                    {open}
                    {filterText}
                    {overlay}
                    {renderOutcome}
                    {onActivate}
                    {onInfo}
                />
                {#if kind === NODE_KINDS.CORPUS && open.has(childId)}
                    <!-- APPENDED UNCONDITIONALLY, which is what the vanilla
                         drill-down does and is deliberately NOT the merged
                         view's rule. `appendUnattributedNode` renders the
                         node whatever its count says; only the MERGED list
                         runs `shouldShowUnattributed` and suppresses a
                         measured zero. The two paths genuinely differ and
                         folding them would hide a node in the tree that is
                         shown there today - the one population that is
                         invisible from the project tree by construction, so
                         the one place a wrong hide is permanent. The verdict
                         still rides on the node as `reason`, so the decision
                         stays inspectable. -->
                    {@const uRow = unattributedRowFor(
                        loadedCorpora(drill), id as number | string)}
                    <NavNode
                        kind={NODE_KINDS.UNATTRIBUTED}
                        row={uRow}
                        reason={shouldShowUnattributed(uRow).reason}
                        {onActivate}
                    />
                {/if}
            </NavNode>
        {/if}
    {/each}

    {#if level.partialEnvelope !== null}
        <NavOutcome envelope={level.partialEnvelope} render={renderOutcome} />
    {/if}
{/if}
