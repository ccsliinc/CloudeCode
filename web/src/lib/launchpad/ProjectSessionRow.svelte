<!--
  ProjectSessionRow - one LIVE session under a project node.

  A read-only summary row: status dot, name, ownership badge, family
  pill. Kill, rename and mark-unread stay exclusively on the flat running
  list; this row does not duplicate them.

  THE LED GOES THROUGH THE COMPONENT, WHICH GOES THROUGH `ledStateFor`.
  It passes the same four signals the running-sessions card passes, for
  the same reason: one component, one meaning per colour, on every
  surface. A project-tree row painting a plainer light than the card
  above it would be two answers to one question. `transport` is included
  because a disconnected socket outranks every server signal, and it is
  the one signal no `/sessions/list` response can carry.

  THE ROW ITSELF IS THE BUTTON, and slice 4 gave it the keyboard half it
  never had. The legacy markup carried `role="button" tabindex="0"` with
  a delegated CLICK listener and nothing bound to Enter or Space, so a
  keyboard user could focus a row that announced itself as a button and
  could not press it. Svelte's a11y checks refuse that shape, correctly.

  NO THEME IS PAINTED HERE. `pinned_theme` rides on the row and is read
  by `ThemeNavigation.applyForTarget` when a navigation happens, which is
  the one total function that owns theme application. A component that
  called `Themes.applyTheme` on mount would put a second writer beside it
  and leave the previous session's theme on screen the moment the two
  disagreed.
-->
<script lang="ts">
    import StatusLed from '../StatusLed.svelte';
    import AgentFamilyPill from './AgentFamilyPill.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        PROJECT_TREE_KEYS,
        workTitle,
    } from '../../../../client/js/labels/project-tree.js';
    import { SESSION_WORK_UNRECORDED_KEY, workAttrs } from './project-node';
    import type { TreeSessionRow } from './project-groups';
    import type { ProjectTreeHost } from './project-tree-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        row: TreeSessionRow;
        /** The newest `last_work_at` for this row's name, or null. */
        workStamp?: string | null;
        /** Whether THIS browser holds a live socket for this session. */
        transport?: string | null;
        host: ProjectTreeHost;
        t?: Translate;
    }

    let {
        row,
        workStamp = null,
        transport = null,
        host,
        t = reactiveT,
    }: Props = $props();

    const owned = $derived(!!row.created_by_cloude);
    const work = $derived(workAttrs(workStamp, SESSION_WORK_UNRECORDED_KEY));
    const displayName = $derived(host.displayLabel(row));

    /**
     * Open this session, by whichever of the two routes applies.
     *
     * Description: an ACTIVE row already has a backend in this browser,
     *   so it re-enters the terminal it left; anything else is an
     *   open-or-adopt. Both routes are the legacy methods, called through
     *   the host, so a session behaves identically whichever surface it
     *   was clicked from.
     * Inputs: none. Output: Promise<void>.
     */
    async function open(): Promise<void> {
        if (row.is_active) {
            await host.returnToActive(row.session_id ?? null);
            return;
        }
        await host.attachSession(row.name);
    }

    /**
     * Enter and Space activate the row, because it says it is a button.
     *
     * Inputs: event - the keyboard event. Output: void.
     */
    function onKey(event: KeyboardEvent): void {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void open();
    }
</script>

<div
    class="project-session-row"
    data-name={row.name}
    data-active={row.is_active ? '1' : '0'}
    data-work={work.state}
    data-work-at={work.at}
    title={workTitle(work, t)}
    role="button"
    tabindex="0"
    onclick={open}
    onkeydown={onKey}
>
    <StatusLed
        status={row.status}
        unread={!!row.unread}
        startupGate={row.startup_gate ?? null}
        statusSource={row.status_source ?? null}
        {transport}
    />
    <span class="project-session-row__name">{displayName}</span>
    <span class="badge {owned ? 'badge-tmux' : 'badge-external'}"
        >{owned ? t(PROJECT_TREE_KEYS.badgeTmux) : t(PROJECT_TREE_KEYS.badgeExternal)}</span
    >
    <AgentFamilyPill family={row.agent_family} source={row.agent_family_source} {t} />
</div>
