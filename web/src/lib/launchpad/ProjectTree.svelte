<!--
  ProjectTree - the two-level project-to-session tree, and slice 4's whole
  visible surface.

  IT REPLACES A REPAINT WITH A SUBSCRIPTION, AND THAT IS THE POINT.
  `renderProjectList()` built a string, asked
  `client/js/project-list-render-guard.js` whether it was worth writing,
  and on a yes wrote `#project-list.innerHTML` and re-registered every
  per-row listener. The guard did its job: an UNCHANGED tick already
  cost zero mutations, and it already stopped the tick while the screen
  was hidden. Two things it could not do, and both are structural:

    1. A CHANGED tick was never cheap. One flipped status dot rebuilt
       roughly 800 nodes and rebound about 45 listeners, because the
       whole subtree was the unit of change.
    2. IT BOUGHT CORRECTNESS WITH STALENESS. `isBusy()` SKIPPED the
       paint entirely while a row menu was open or a rename input had
       focus, because an `innerHTML` write under either destroys what
       the user is doing. So a status change landing during one was
       simply not shown.

  Reading the store reactively removes both. A tick writes only the
  values that moved, so a dot changes without touching its neighbours,
  and there is no repaint to skip - the dot may update with a menu still
  open. Measured, not asserted: ./mutation-count.test.ts counts records
  off a real `MutationObserver` across twelve simulated ticks.

  IT IS MOUNTED ONCE, NOT ON EVERY TICK. `Launchpad.renderProjectList()`
  is now one call to `ensurePanel`, which is a no-op once a live panel is
  mounted on the CURRENT `#project-list` element. Every legacy caller
  keeps working and the tick costs one map lookup.

  NO THEME IS PAINTED HERE, ON MOUNT OR EVER.
  `ThemeNavigation.applyForTarget` is a total function and is the only
  writer; a component that called `Themes.applyTheme` would be a second
  one, and a missing else in a second writer is what leaves the previous
  session's theme on screen. ./theme-discipline.test.ts scans every file
  in this slice for the call.
-->
<script lang="ts">
    import AttentionGroup from './AttentionGroup.svelte';
    import NoProjectGroup from './NoProjectGroup.svelte';
    import ProjectNode from './ProjectNode.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        archivedNoticeText,
        authorityBannerText,
        PROJECT_TREE_KEYS,
    } from '../../../../client/js/labels/project-tree.js';
    import { sessionStore } from '../sessions/store.svelte';
    import { archivedNotice, authorityBanner } from './project-chrome';
    import { buildProjectSessionGroups } from './project-groups';
    import { projectNodeView } from './project-node';
    import {
        browserControl,
        type ProjectChromeControl,
    } from './project-chrome-control';
    import {
        browserProjectTreeHost,
        type ProjectTreeHost,
    } from './project-tree-host';
    import { uiPrefs } from '../ui/prefs.svelte';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** Everything outside this tree that it reaches. */
        host?: ProjectTreeHost;
        /** The one control of this section that sits outside the mount. */
        control?: ProjectChromeControl;
        /** tmux name to this browser's socket state, when it has one. */
        transports?: Map<string, string>;
        /** The translator. Injected only so a test can drive a locale. */
        t?: Translate;
    }

    let {
        host = browserProjectTreeHost(),
        control = browserControl(),
        transports = new Map<string, string>(),
        t = reactiveT,
    }: Props = $props();

    /**
     * Flip the archive filter, then RE-FETCH.
     *
     * Description: archived projects are ASKED FOR, never held
     *   client-side and filtered, so there is one rule about what is on
     *   screen - whatever the last request returned - instead of two that
     *   can drift. `Launchpad.loadProjects()` reads the preference this
     *   just wrote, which is why the write comes first.
     * Inputs: none. Output: Promise<void>.
     */
    async function toggleArchivedProjects(): Promise<void> {
        uiPrefs.setArchivedProjectsVisible(!uiPrefs.archivedProjectsVisible);
        await host.reloadProjects();
    }

    // The filter is a SIBLING of this mount, so it is written rather than
    // rendered. See ./project-chrome-control.ts for why the heading stays
    // legacy markup. The effect repaints it whenever the preference moves,
    // including the first time anything reads it.
    $effect(() => {
        const on = uiPrefs.archivedProjectsVisible;
        control.setArchivedToggle(
            on,
            on
                ? t(PROJECT_TREE_KEYS.archivedHide)
                : t(PROJECT_TREE_KEYS.archivedShow),
        );
    });

    $effect(() => {
        control.bindArchivedToggle(() => void toggleArchivedProjects());
    });

    /**
     * The join, recomputed whenever any of its seven inputs moves.
     *
     * Every field is read off the store's accessors, so this is one
     * `$derived` subscribing to all of them rather than a render call
     * somebody has to remember to make.
     */
    const groups = $derived(
        buildProjectSessionGroups({
            runningSessions: sessionStore.runningSessions,
            sessionRecords: sessionStore.sessionRecords,
            sessionAttribution: sessionStore.sessionAttribution,
            sessionAttributionByInstance: sessionStore.sessionAttributionByInstance,
            sessionAttributionAmbiguous: sessionStore.sessionAttributionAmbiguous,
            sessionAttributionListingOk: sessionStore.sessionAttributionListingOk,
            sessionAttributionListingDetail: sessionStore.sessionAttributionListingDetail,
        }),
    );

    const nodes = $derived(
        sessionStore.projects.map((project, index) =>
            projectNodeView(project, index, {
                presence: sessionStore.projectPresence,
                byProjectId: groups.byProjectId,
            }),
        ),
    );

    // THE BANNER IS DRAWN IN BOTH THE EMPTY AND THE POPULATED CASE. An
    // empty list is exactly when the user most needs to know whether the
    // datastore answered, because "no projects" and "your projects could
    // not be read" look identical without it.
    const banner = $derived(authorityBannerText(
        authorityBanner(sessionStore.projectAuthority), t,
    ));
    const archived = $derived(archivedNoticeText(
        archivedNotice(sessionStore.archivedFetchOk, sessionStore.projects), t,
    ));
    const authorityState = $derived(authorityBanner(sessionStore.projectAuthority));
    const archivedState = $derived(
        archivedNotice(sessionStore.archivedFetchOk, sessionStore.projects),
    );
</script>

{#if banner}
    <div
        class="project-authority-banner"
        class:project-authority-banner-unknown={authorityState.kind === 'unknown'}
        class:project-authority-banner-unreadable={authorityState.kind === 'degraded'}
        data-authority-state={authorityState.kind === 'degraded'
            ? authorityState.mode
            : 'unknown'}
        data-writable={authorityState.kind === 'degraded'
            ? String(authorityState.writable)
            : undefined}
    >
        {banner}
    </div>
{/if}

{#if archived}
    <div
        class="project-archived-notice"
        class:project-archived-notice--unknown={archivedState.kind === 'unknown'}
    >
        {archived}
    </div>
{/if}

{#if nodes.length === 0}
    <div class="launchpad-empty">
        {t(PROJECT_TREE_KEYS.emptyTitle)}<br />
        <small>{t(PROJECT_TREE_KEYS.emptyHint)}</small>
    </div>
{:else}
    <!-- KEYED ON THE PROJECT NAME, which is what the whole surface
         already keys on: the node key, the collapse set, the archive and
         edit handlers and the deep-link resolver all address a project by
         name. An unstable key here rebuilds every node on every tick and
         nothing about the markup looks wrong when it does. -->
    {#each nodes as view (view.nodeKey)}
        <ProjectNode
            {view}
            workStamps={sessionStore.workStampByName}
            {transports}
            {host}
            {t}
        />
    {/each}
{/if}

<NoProjectGroup
    sessions={groups.noProject}
    workStamps={sessionStore.workStampByName}
    {transports}
    {host}
    {t}
/>
<AttentionGroup items={groups.needsAttention} {host} {t} />
