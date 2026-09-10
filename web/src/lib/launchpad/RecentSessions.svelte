<!--
  RecentSessions - the RECENT group: stored history, not a live tmux probe.

  SLICE 2 OF THE STRANGLER MIGRATION. `client/js/launchpad.js` lost nine
  methods, two preference accessors and three fields in the same commit
  that added this file, and `client/js/session-recent-visibility.js` went
  with them. `loadRecentSessions()`'s one call site is now
  `CloudeWeb.launchpad.mountRecentSessions()`, at the exact line its own
  render used to run on.

  IT IS A PORT, NOT A REDESIGN. Every class name, attribute and control
  below is the one the legacy renderer emitted, so `client/css/styles.css`
  and `client/css/recent-deleted.css` style it unchanged and all 26 themes
  keep working with no theme work. The decision ladder lives in
  ./recent.ts, the actions in ./recent-actions.ts, and the copy in
  client/js/labels/recent-session.js reading the catalog - none of it is
  in here, which is what keeps this file a switch over four cases.

  NO COLOUR IS DECLARED HERE, NO {@html} IS USED, AND CASING IS THE
  STYLESHEET'S JOB. `.recent-session-lifecycle` and
  `.recent-session-deleted` already carry `text-transform: uppercase`, so
  the catalog holds `ended` and `archived` in lowercase like every other
  message and the pixels are unchanged. Every string that reaches the DOM
  goes through Svelte's own escaping, which is what replaced the legacy
  `_escapeHtml` calls - a title is free-form user text.

  THE THREE-OUTCOME CONTRACT IS THE ONE THING TO NOT BREAK HERE. A state
  that is not `ok` renders `view.kind === 'unavailable'`, which paints the
  notice and NO rows. There is no branch in this template that can render
  an empty list for a non-ok state, because the row list only exists
  inside the `rows` case.
-->
<script lang="ts">
    import StatusLed from '../StatusLed.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import { sessionStore } from '../sessions/store.svelte';
    import { uiPrefs } from '../ui/prefs.svelte';
    import { RECENT_KEYS } from '../../../../client/js/labels/recent-session.js';
    import { recentView, type Translate } from './recent';
    import {
        archiveSessionRecord,
        browserHost,
        restartRecentSession,
        type RecentHost,
    } from './recent-actions';
    import { browserChrome, type RecentChrome } from './recent-chrome';

    interface Props {
        /** Everything outside this component that it reaches. */
        host?: RecentHost;
        /** The three heading elements that sit outside the mount. */
        chrome?: RecentChrome;
        /** The translator. Injected only so a test can drive a locale. */
        t?: Translate;
    }

    let {
        host = browserHost(() => refresh()),
        chrome = browserChrome(),
        t = reactiveT,
    }: Props = $props();

    /**
     * The live sessions, mirrored into state so the view recomputes.
     *
     * They still come from the legacy launchpad singleton, which is not
     * reactive; slice 3 moves them into the store and this field goes
     * with it. Read once per refresh rather than per render, so a paint
     * cannot depend on when it happened to run.
     */
    // svelte-ignore state_referenced_locally
    // Reading `host` once at init IS the intent. It is a seam, injected
    // by whoever mounts this and never reassigned afterwards, so there
    // is no later value to capture; making it a `$derived` would rebuild
    // the whole host object on every unrelated repaint.
    let live = $state(host.liveSessions());

    const view = $derived(
        recentView(
            sessionStore.recentPayload,
            live,
            uiPrefs.archivedSessionsVisible,
            (name) => host.deriveDisplayName(name),
            t,
        ),
    );

    /**
     * Re-read the group, carrying the archive filter as it stands.
     *
     * Inputs: none. Output: Promise<void>. Never rejects: the store
     *   records a failure as `probe_unavailable`, which is a state the
     *   view can render, rather than as an absence it cannot.
     */
    async function refresh(): Promise<void> {
        await sessionStore.refreshRecent(
            (includeArchived) => host.fetchRecent(includeArchived),
            uiPrefs.archivedSessionsVisible,
            t,
        );
        live = host.liveSessions();
    }

    /**
     * Flip the archive filter, then RE-FETCH.
     *
     * Description: archived rows are ASKED FOR, never held client-side
     *   and filtered, so there is one rule about what is on screen -
     *   whatever the last request returned - instead of two that can
     *   drift. It also means the toggle cannot show stale archived rows
     *   from an earlier fetch.
     * Inputs: none. Output: Promise<void>.
     */
    async function toggleArchived(): Promise<void> {
        uiPrefs.setArchivedSessionsVisible(!uiPrefs.archivedSessionsVisible);
        await refresh();
    }

    // The heading's three elements are siblings of this mount, so they
    // are written rather than rendered. See ./recent-chrome.ts for why
    // the heading itself stays legacy markup until a later slice.
    $effect(() => {
        chrome.setCount(
            view.kind === 'hidden' ? '' : view.count,
            view.kind === 'unavailable' ? view.state : 'ok',
        );
        // THE SECTION STAYS UP WHILE THE ARCHIVE FILTER IS ON, and that
        // is not cosmetic: the toggle lives in this heading, so hiding
        // the section on an empty result would take away the only
        // control that can turn it back off.
        chrome.setSectionVisible(view.kind !== 'hidden');
    });

    $effect(() => {
        const on = uiPrefs.archivedSessionsVisible;
        chrome.setArchiveToggle(on, t(on ? RECENT_KEYS.archiveHide : RECENT_KEYS.archiveShow));
    });

    // Bound once per page through a module-scope slot, so remounting
    // cannot stack listeners and cannot strand a stale one.
    // svelte-ignore state_referenced_locally
    // Same reasoning as `live` above: `chrome` is an injected seam, not
    // state. The BINDING must happen once per mount and not inside an
    // effect, because an effect would re-register on every repaint - and
    // the module-scope slot inside `bindArchiveToggle` is what makes
    // re-registering safe, not something to lean on every frame.
    chrome.bindArchiveToggle(() => {
        void toggleArchived();
    });

    // Fetched as the component initialises, which is the moment the
    // legacy `loadRecentSessions()` ran. Not awaited: a slow or failing
    // read must not hold up whatever mounted this.
    void refresh();
</script>

{#if view.kind === 'unavailable'}
    <div class="recent-sessions-attention" role="status" data-state={view.state}>
        <div class="recent-sessions-attention__title">{view.title}</div>
        <div class="recent-sessions-attention__detail">{view.detail}</div>
    </div>
{:else if view.kind === 'empty'}
    <div class="launchpad-empty">{view.message}</div>
{:else if view.kind === 'rows'}
    {#each view.rows as row (row.uuid || row.name)}
        <div
            class="recent-session-row"
            class:recent-session-row--deleted={row.archived}
            data-uuid={row.uuid}
            data-lifecycle={row.lifecycle}
            data-deleted={row.archived ? '1' : undefined}
        >
            <!--
              THE SAME ENDED SIGNAL THE TREE USES, not a second
              vocabulary. The dot is only shown for a row we can actually
              call ended: a lifecycle we could not evaluate keeps its own
              word and gets no dot asserting a state nobody measured.
            -->
            {#if row.canRestart}
                <StatusLed status="stopped" />
            {/if}
            <span class="recent-session-name">{row.name}</span>
            <span class="recent-session-lifecycle">{row.lifecycleLabel}</span>
            <!--
              A ROW THE USER ALREADY ARCHIVED IS MARKED, NOT BLENDED IN.
              It is only on screen because the filter is on, and an
              archived row drawn identically to a live one would make the
              toggle look like it did nothing. It KEEPS restart, which is
              what recovers it: rebind_instance clears `archived_at`.
            -->
            {#if row.archived}
                <span
                    class="recent-session-deleted"
                    title={t(RECENT_KEYS.archiveBadgeTitle)}
                >{t(RECENT_KEYS.archiveBadge)}</span>
            {/if}
            {#if row.restart}
                <button
                    type="button"
                    class="recent-session-restart"
                    data-uuid={row.restart.sessionUuid}
                    data-title={row.restart.title}
                    data-working-dir={row.restart.workingDir}
                    data-agent-type={row.restart.agentType}
                    onclick={() => restartRecentSession(row.restart, host, t)}
                >{t(RECENT_KEYS.restartAction)}</button>
            {/if}
            <!--
              An archived row loses this control: archiving an already
              archived row is a no-op the server answers "already
              deleted" to, and a control that cannot change anything is
              furniture. Every other row gets it, INCLUDING one whose
              lifecycle is unknown - hiding a row from your own list is
              safe whatever state it is in, unlike restart, which is
              gated. The class name stays `ended-session-delete` because
              the stylesheet and the project tree both key on it.
            -->
            {#if !row.archived}
                <button
                    type="button"
                    class="ended-session-delete"
                    data-uuid={row.uuid}
                    title={t(RECENT_KEYS.archiveActionTitle)}
                    aria-label={t(RECENT_KEYS.archiveActionAria)}
                    onclick={() => archiveSessionRecord(row.uuid, host, t)}
                >{t(RECENT_KEYS.archiveAction)}</button>
            {/if}
        </div>
    {/each}
{/if}
