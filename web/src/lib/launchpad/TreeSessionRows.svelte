<!--
  TreeSessionRows - one group's session rows, live and ended, in order.

  A FLAT RENDER, DELIBERATELY. There used to be a fold here that hid a
  restarted session's abandoned predecessor behind a disclosure counting
  the earlier sessions it had superseded. That mechanism existed to
  explain a duplicate the RESTART path was creating: it inserted a second
  row and left the first one behind carrying the same title, so a group
  listed it twice and gained another entry on every restart. A restart
  now reuses the session's own row (src/core/session_restart.py,
  `rebind_instance`), so there is no predecessor, no duplicate and
  nothing to disclose. The fix moved to where the defect was.

  THE EACH BLOCK IS KEYED, AND THAT IS THE WHOLE PERFORMANCE CLAIM. Every
  poll tick hands this component a brand new array of brand new objects.
  Keyed on `rowKey`, Svelte matches them against the nodes already on
  screen and updates only the values that moved; unkeyed, it would
  rebuild the list, which is the legacy behaviour with extra steps. See
  ./project-groups.ts for why the key has three parts.
-->
<script lang="ts">
    import EndedSessionRow from './EndedSessionRow.svelte';
    import ProjectSessionRow from './ProjectSessionRow.svelte';
    import { rowKey, type TreeSessionRow } from './project-groups';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        sessions: TreeSessionRow[];
        /** tmux name to newest `last_work_at`. Absent means UNRECORDED. */
        workStamps: Map<string, string>;
        /** tmux name to this browser's socket state, when it has one. */
        transports?: Map<string, string>;
        host: ProjectTreeHost;
        t?: Translate;
    }

    let {
        sessions,
        workStamps,
        transports = new Map<string, string>(),
        host,
        t,
    }: Props = $props();
</script>

{#each sessions as row (rowKey(row))}
    {#if row.ended}
        <EndedSessionRow {row} {host} {t} />
    {:else}
        <ProjectSessionRow
            {row}
            workStamp={workStamps.get(row.name) ?? null}
            transport={transports.get(row.name) ?? null}
            {host}
            {t}
        />
    {/if}
{/each}
