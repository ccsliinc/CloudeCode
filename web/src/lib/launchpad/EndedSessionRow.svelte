<!--
  EndedSessionRow - one session whose process is gone, in the tree.

  The same shape as a live row so the tree does not visually fragment,
  differing in exactly the ways a human must be able to see WITHOUT
  hovering anything:

    - the word ENDED, as text. Colour alone never carries meaning here,
      and a dot is a 9px hint at best.
    - the `stopped` status dot from the shared vocabulary, not a second
      signal invented for this surface.
    - NO `role="button"`, NO `tabindex`, and NO row click handler. This
      is the important one: a dead row that looks identical to a live one
      is worse than a hidden one, because he would click it and try to
      attach to a tmux session that does not exist.
    - restart and archive instead, which are the only two things that CAN
      be done to a record with no process behind it.

  THE GUARD THAT USED TO ENFORCE THAT IS GONE, BY CONSTRUCTION. The
  legacy listener was DELEGATED on `#project-list` and matched the row
  CLASS, not the role, so dropping `role="button"` off the markup only
  stopped the row LOOKING clickable - the whole row still attached on
  click, and an explicit `if (row.dataset.ended === '1')` early return
  was what stopped it. Here the handler is on the element, this element
  has none, and there is nothing to guard.

  RESTART IS A NEW SESSION IN THE SAME DIRECTORY, NEVER A RESURRECTION,
  and it is the same implementation RECENT offers. Archive is a SOFT
  archive: `archived_at` is stamped, the row keeps every column, and a
  restart brings it back. `session_uuid` is what both are keyed on, never
  the tmux name - tmux reuses names, and two rows can differ only by
  creation epoch.
-->
<script lang="ts">
    import StatusLed from '../StatusLed.svelte';
    import AgentFamilyPill from './AgentFamilyPill.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import { PROJECT_TREE_KEYS } from '../../../../client/js/labels/project-tree.js';
    import { RECENT_KEYS } from '../../../../client/js/labels/recent-session.js';
    import type { TreeSessionRow } from './project-groups';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        row: TreeSessionRow;
        host: ProjectTreeHost;
        t?: Translate;
    }

    let { row, host, t = reactiveT }: Props = $props();

    const owned = $derived(!!row.created_by_cloude);
    const uuid = $derived(row.session_uuid || '');
    const displayName = $derived(host.displayLabel(row));
</script>

<div
    class={['project-session-row', 'project-session-row--ended']}
    data-name={row.name}
    data-ended="1"
    data-lifecycle="stopped"
    data-uuid={uuid}
>
    <!-- The literal `stopped`, not this row's own status field: an ended
         row is ended whatever the last live probe happened to say. -->
    <StatusLed status="stopped" />
    <span class="project-session-row__name">{displayName}</span>
    <span class={['badge', 'badge-ended']}>{t(PROJECT_TREE_KEYS.badgeEnded)}</span>
    <span class="badge {owned ? 'badge-tmux' : 'badge-external'}"
        >{owned ? t(PROJECT_TREE_KEYS.badgeTmux) : t(PROJECT_TREE_KEYS.badgeExternal)}</span
    >
    <AgentFamilyPill family={row.agent_family} source={row.agent_family_source} {t} />
    <button
        type="button"
        class="ended-session-restart"
        data-uuid={uuid}
        onclick={() => host.restartEnded(row)}>{t(RECENT_KEYS.restartAction)}</button
    >
    <button
        type="button"
        class="ended-session-delete"
        data-uuid={uuid}
        title={t(RECENT_KEYS.archiveActionTitle)}
        aria-label={t(RECENT_KEYS.archiveActionAria)}
        onclick={() => host.archiveRecord(uuid)}>{t(RECENT_KEYS.archiveAction)}</button
    >
</div>
