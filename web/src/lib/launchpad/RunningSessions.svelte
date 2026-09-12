<!--
  RunningSessions - the home screen's flat list of live sessions, and
  slice 5's whole visible surface.

  IT REPLACES A REPAINT WITH A SUBSCRIPTION. `renderRunningSessions()`
  built a JSON signature of every row, compared it to `_lastRunningSig`,
  and on a difference wrote `#running-sessions-list.innerHTML` and rebound
  one delegated listener. Three things that shape could not do, and all
  three are structural rather than bugs in it:

    1. A CHANGED TICK WAS NEVER CHEAP. One flipped status dot rebuilt
       every row on the screen, because the whole list was the unit of
       change.
    2. IT BOUGHT CORRECTNESS WITH STALENESS.
       `client/js/session-list-busy-guard.js` SKIPPED the paint entirely
       while an inline rename input was open or a row menu was up, because
       an `innerHTML` write under either destroys what the user is doing.
       So a status change landing during one was simply not shown. That
       file is deleted in this commit; a component's rows are not rebuilt,
       so there is nothing to guard and nothing to skip.
    3. A FIELD LEFT OUT OF THE SIGNATURE STAYED STALE FOREVER. The
       signature had to fingerprint every field the markup read -
       `agent_wrapper_label` and `startup_gate` were each added to it
       after shipping, each because the value changed with nothing else on
       the row changing at all. A subscription cannot have that bug: the
       template reads the field, so the field is the dependency.

  IT IS MOUNTED ONCE, NOT ON EVERY TICK. `Launchpad.renderRunningSessions()`
  is one call to `ensurePanel`, which is a no-op once a live panel is
  mounted on the CURRENT `#running-sessions-list` element.

  ZERO ROWS IS TWO DIFFERENT SITUATIONS, and the difference is the whole
  reason the attention block exists. With a listing that RAN it means the
  user has no sessions, and the section hides. With a listing that did not
  run it means we do not know, and hiding the section would render "cannot
  determine" as "nothing to see". So the unknown case SHOWS the section
  carrying only the attention block, which deliberately has NO action
  controls: acting on a session whose existence we cannot confirm either
  does nothing or does something to the wrong thing.
-->
<script lang="ts">
    import RunningSessionRow from './RunningSessionRow.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        RUNNING_SESSION_KEYS,
        listingAttentionDetail,
        runningCountLabel,
        runningCountUnavailableLabel,
    } from '../../../../client/js/labels/running-session.js';
    import { sessionStore } from '../sessions/store.svelte';
    import { browserRunningChrome, type RunningChrome } from './running-chrome';
    import { browserRunningHost, type RunningHost } from './running-host';
    import type { Translate } from '../sessions/types';

    interface Props {
        /** Everything outside this list that it reaches. */
        host?: RunningHost;
        /** The two writes this section makes outside its own mount. */
        chrome?: RunningChrome;
        /** Injectable clock, so a test can age rows without moving time. */
        nowMs?: number | null;
        t?: Translate;
    }

    let {
        host = browserRunningHost(),
        chrome = browserRunningChrome(),
        nowMs = null,
        t = reactiveT,
    }: Props = $props();

    const rows = $derived(sessionStore.runningSessions);
    const listing = $derived(sessionStore.runningSessionsListing);
    const listingOk = $derived(!listing || listing.ok !== false);

    // THE SECTION HIDES ONLY ON A MEASURED ZERO. `listingOk` false with no
    // rows is the third outcome and keeps the section on screen carrying
    // the attention block alone.
    const sectionVisible = $derived(rows.length > 0 || !listingOk);

    const countText = $derived(
        listingOk
            ? runningCountLabel(rows.length, t)
            : runningCountUnavailableLabel(t),
    );

    // The heading is a SIBLING of this mount and is written rather than
    // rendered, so the collapse listener the legacy shell bound to it at
    // boot survives. See ./running-chrome.ts.
    $effect(() => {
        chrome.setCount(countText, listingOk);
    });
    $effect(() => {
        chrome.setSectionVisible(sectionVisible);
    });
</script>

{#if !listingOk}
    <div
        class="running-sessions-attention"
        role="status"
        data-listing-ok="0"
        data-listing-reason={listing.reason || 'probe_error'}
    >
        <div class="running-sessions-attention__head">
            {t(RUNNING_SESSION_KEYS.attentionHead)}
        </div>
        <div class="running-sessions-attention__title">
            {t(RUNNING_SESSION_KEYS.attentionTitle)}
        </div>
        <div class="running-sessions-attention__detail">
            {listingAttentionDetail(listing, t)}
        </div>
        <div class="running-sessions-attention__note">
            {t(RUNNING_SESSION_KEYS.attentionNote)}
        </div>
    </div>
{/if}

<!-- KEYED ON THE TMUX NAME, which is what this whole surface already keys
     on: `data-name`, the unread flag, the rename target, the destroy call
     and the fork all address a session by it. An unstable key here moves
     every row on every tick and nothing about the markup looks wrong when
     it does - which is exactly the defect slice 4 measured at 6,048
     mutation records a tick and could only see in a real browser. -->
{#each rows as row (row.name)}
    <RunningSessionRow {row} {host} {nowMs} {t} />
{/each}
