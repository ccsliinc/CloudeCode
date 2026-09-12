<!--
  ProjectNode - one project, its card, and the sessions under it.

  EVERY DECISION IS MADE IN ./project-node.ts AND READ HERE AS A VALUE.
  Presence resolution, the disabled rule, the project-id ladder, whether
  the node can fold at all: those are rules, and a rule buried in a
  template literal is a rule no test can name. This file branches on a
  typed view object.

  TWO INDEPENDENT DIMENSIONS. `archived` and `presence` are orthogonal:
  a project can be archived AND missing, and the badges say different
  things - "I retired this" against "the folder is gone". ARCHIVING NEVER
  DISABLES A ROW. An archived project is still openable and its sessions
  were never touched.

  REFUSING IS NOT THE SAME AS DOING NOTHING. A MISSING or CANNOT
  DETERMINE row refuses every action, and the refusal SAYS SO and names
  the path. It used to be a bare `return`: the click was swallowed with
  no message, no log line and no request, so the row presented as a
  button that does nothing - and on a fresh install every seeded row was
  in that state, so the whole first screen was dead clicks.

  ARCHIVE IS THE ONLY DESTRUCTIVE-SHAPED CONTROL ON THIS ROW. A hard
  delete used to sit beside it and is gone from the UI on the owner's
  instruction: "sessions and projects can be archived not deleted". The
  server route is untouched and nothing in the client calls it. Archive
  is NOT disabled by presence, deliberately - a project whose folder has
  gone missing is precisely one a user wants to archive, and refusing
  that would leave the row permanently stuck on the screen it is trying
  to leave.
-->
<script lang="ts">
    import Glyph from '../Glyph.svelte';
    import TreeSessionRows from './TreeSessionRows.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        PROJECT_TREE_KEYS,
        presenceBadgeText,
        sessionCountLabel,
        workTitle,
    } from '../../../../client/js/labels/project-tree.js';
    import { treeCollapse } from './tree-collapse.svelte';
    import type { ProjectNodeView } from './project-node';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        view: ProjectNodeView;
        workStamps: Map<string, string>;
        transports?: Map<string, string>;
        host: ProjectTreeHost;
        t?: Translate;
    }

    let {
        view,
        workStamps,
        transports = new Map<string, string>(),
        host,
        t = reactiveT,
    }: Props = $props();

    const collapsed = $derived(treeCollapse.isCollapsed(view.nodeKey));
    const sessionsId = $derived('project-node-sessions-' + view.nodeKey);
    const presenceText = $derived(
        presenceBadgeText(view.presenceState, view.presenceDetail, t),
    );

    /** The element the refusal explanation anchors itself to. */
    let itemEl: HTMLDivElement | null = $state(null);

    /**
     * Open the project, or say why it will not open.
     *
     * Inputs: none. Output: void.
     */
    function openOrRefuse(): void {
        if (view.isDisabled) {
            host.explainRefused(view.project, itemEl);
            return;
        }
        host.selectProject(view.project);
    }

    /**
     * Archive or restore, whichever this row currently offers.
     *
     * Inputs: none. Output: Promise<void>.
     */
    async function toggleArchived(): Promise<void> {
        if (view.isArchived) await host.unarchiveProject(view.name);
        else await host.archiveProject(view.name);
    }
</script>

<div
    class="project-node"
    class:project-node--archived={view.isArchived}
    data-project-node="project"
    data-project-name={view.name}
    data-work={view.work.state}
    data-work-at={view.work.at}
    title={workTitle(view.work, t)}
>
    <div class="project-node__row">
        <!-- THE GUTTER IS ALWAYS PRESENT, even when there is nothing to
             fold. `.project-node__row` is a grid whose first column is a
             fixed `--project-gutter`, so a foldless project has to stay
             two grid children wide or its card slides left and the whole
             column stops lining up. -->
        <div class="project-node__gutter">
            {#if view.foldable}
                <button
                    type="button"
                    class="project-node__toggle"
                    data-node-key={view.nodeKey}
                    aria-expanded={!collapsed}
                    aria-label={t(PROJECT_TREE_KEYS.toggleAria, { name: view.name })}
                    aria-controls={view.hasChildren ? sessionsId : undefined}
                    onclick={() => treeCollapse.toggle(view.nodeKey)}
                >
                    <span class="project-node__chevron" aria-hidden="true">&#9658;</span>
                    <!-- The count chip is drawn ONLY when there ARE
                         children, because a bare "0" would be a claim
                         about sessions that the fold is not making. -->
                    {#if view.hasChildren}
                        <span class="project-node__count">{view.children.length}</span>
                    {/if}
                </button>
            {/if}
        </div>
        <!-- THE CARD IS A CLICKABLE DIV WITH NO ROLE AND NO TAB STOP,
             AND THAT IS THE PORT RATHER THAN AN OVERSIGHT. The legacy
             element was exactly this, and giving it `role="button"` plus
             a `tabindex` here would add one focus stop per project ahead
             of the two real buttons already inside it - a tab-order
             change smuggled in under a migration. The keyboard gap is
             real and is its own change; `role="presentation"` would be
             worse than the gap, because it also forbids the
             `aria-disabled` that tells a screen reader this row refuses.
             svelte-ignore a11y_click_events_have_key_events
             svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            bind:this={itemEl}
            class="project-item"
            class:project-presence-disabled={view.isDisabled}
            class:project-presence-missing={view.presenceState === 'missing'}
            class:project-presence-unreachable={view.presenceState === 'unreachable'}
            class:project-item--archived={view.isArchived}
            data-index={view.index}
            data-name={view.name}
            aria-disabled={view.isDisabled ? 'true' : undefined}
            onclick={openOrRefuse}
        >
            <button
                class="project-edit-btn"
                data-name={view.name}
                title={t(PROJECT_TREE_KEYS.actionEdit)}
                aria-label={t(PROJECT_TREE_KEYS.actionEdit)}
                disabled={view.isDisabled}
                onclick={(e) => {
                    e.stopPropagation();
                    host.editProject(view.project);
                }}><Glyph name="pencil" /></button
            >
            <button
                class="project-archive-btn"
                data-name={view.name}
                data-archived={view.isArchived ? '1' : '0'}
                title={view.isArchived
                    ? t(PROJECT_TREE_KEYS.actionRestoreTitle)
                    : t(PROJECT_TREE_KEYS.actionArchiveTitle)}
                aria-label={view.isArchived
                    ? t(PROJECT_TREE_KEYS.actionRestoreAria)
                    : t(PROJECT_TREE_KEYS.actionArchiveAria)}
                onclick={(e) => {
                    e.stopPropagation();
                    void toggleArchived();
                }}
                >{#if view.isArchived}&#x21ba;{:else}<Glyph name="archive" />{/if}</button
            >
            <div class="project-name">&raquo; {view.name}</div>
            <div class="project-path">{view.path}</div>
            <!-- A project with no description renders NO ELEMENT AT ALL.
                 It used to render the literal filler "no description": a
                 full line of type on every row that says nothing, and on
                 the real screen the single largest avoidable cost,
                 because every project in the live datastore has an empty
                 one. The description is the part of the row a collapsed
                 node sheds, alongside its sessions. -->
            {#if view.hasDescription}
                <div class="project-description" style:display={collapsed ? 'none' : null}>
                    {view.description}
                </div>
            {/if}
            {#if view.isArchived}
                <div class="project-archived-badge">{t(PROJECT_TREE_KEYS.badgeArchived)}</div>
            {/if}
            {#if presenceText}
                <div
                    class={[
                        'project-presence-badge',
                        `project-presence-badge-${view.presenceState}`,
                    ]}
                >
                    {presenceText}
                </div>
            {/if}
        </div>
    </div>
    {#if view.hasChildren}
        <div
            class="project-node__sessions"
            id={sessionsId}
            style:display={collapsed ? 'none' : null}
        >
            <TreeSessionRows
                sessions={view.children}
                {workStamps}
                {transports}
                {host}
                {t}
            />
        </div>
    {/if}
</div>
