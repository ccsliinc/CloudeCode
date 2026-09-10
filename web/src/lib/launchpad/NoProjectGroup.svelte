<!--
  NoProjectGroup - the home for every session whose working directory WAS
  read and sits inside no known project.

  `project_attribution === 'none'` is a REAL, MEASURED ANSWER - distinct
  from NEEDS ATTENTION, which is reserved for sessions that could NOT be
  evaluated - so this renders as an ordinary collapsible group and never
  as a warning. It is omitted entirely when empty, matching every other
  optional group on this screen.

  ITS FOLD IS THE SAME MECHANISM A PROJECT NODE USES, keyed on the
  synthetic `__no_project__` node key rather than on a project name,
  because there is no project to name it after.
-->
<script lang="ts">
    import TreeSessionRows from './TreeSessionRows.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        PROJECT_TREE_KEYS,
        sessionCountLabel,
    } from '../../../../client/js/labels/project-tree.js';
    import { NO_PROJECT_NODE_KEY, treeCollapse } from './tree-collapse.svelte';
    import type { TreeSessionRow } from './project-groups';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        sessions: TreeSessionRow[];
        workStamps: Map<string, string>;
        transports?: Map<string, string>;
        host: ProjectTreeHost;
        t?: Translate;
    }

    let {
        sessions,
        workStamps,
        transports = new Map<string, string>(),
        host,
        t = reactiveT,
    }: Props = $props();

    const collapsed = $derived(treeCollapse.isCollapsed(NO_PROJECT_NODE_KEY));
    const sessionsId = 'project-node-sessions-' + NO_PROJECT_NODE_KEY;
</script>

{#if sessions.length > 0}
    <div class={['project-node', 'project-node--virtual']} data-project-node="no-project">
        <button
            type="button"
            class={['project-node__header', 'project-node__toggle']}
            data-node-key={NO_PROJECT_NODE_KEY}
            aria-expanded={!collapsed}
            aria-controls={sessionsId}
            onclick={() => treeCollapse.toggle(NO_PROJECT_NODE_KEY)}
        >
            <span class="project-node__chevron" aria-hidden="true">&#9658;</span>
            <span class="project-node__title">{t(PROJECT_TREE_KEYS.noProject)}</span>
            <span class="project-node__count">{sessionCountLabel(sessions.length, t)}</span>
        </button>
        <!-- `style:display` rather than `hidden`, because that is the
             property the legacy fold wrote and the stylesheet has never
             had a rule for the attribute. A fold is ONE attribute write
             on ONE element now; it used to be a whole-subtree repaint. -->
        <div
            class="project-node__sessions"
            id={sessionsId}
            style:display={collapsed ? 'none' : null}
        >
            <TreeSessionRows {sessions} {workStamps} {transports} {host} {t} />
        </div>
    </div>
{/if}
