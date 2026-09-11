<!--
  RunningSessionRow - one card in the home screen's running-sessions list.

  THE CARD IS A LIST OF CONTROLS, NOT A BLOCK OF MARKUP, and section 6 of
  the migration plan asks for exactly that: row controls come from arrays
  (`host.actionsFor`, `host.cardActions`) rather than from five buttons
  written into the template, so adding a `session-card-action` later is
  one concat rather than a rewrite. Mark unread already arrives that way.

  THE LED GOES THROUGH THE COMPONENT, WHICH GOES THROUGH `ledStateFor`.
  Four signals, because a bare status string cannot express any of them:
  the persisted `unread` flag, the `startup_gate` probe, `status_source`
  (provenance, tooltip only) and `transport` (whether THIS browser's
  socket to the session is up, which no server response can report). Drop
  one and the card's light silently disagrees with the sidebar row for the
  same session. NO COMPONENT MAY INLINE DOT MARKUP.

  IDENTITY IS CAPTURED AT PAINT TIME. Every control closes over the `row`
  it was rendered from and none of them re-reads the DOM when clicked: the
  list refreshes on a 5s tick, and an action that resolved its row on
  activation could act on whatever took its place.

  NO THEME IS PAINTED HERE, ON MOUNT OR EVER. `pinned_theme` rides on the
  row as an attribute and a custom property, and `ThemeNavigation
  .applyForTarget` is the one total function that applies a theme when a
  navigation happens. A component that called `Themes.applyTheme` would be
  a second writer, and a missing else in a second writer is what leaves
  the previous session's theme on screen.

  THE ROW IS THE BUTTON, and the nested controls stop their own clicks.
  The legacy version bound ONE delegated listener on the container and
  decided what had been hit by walking `closest()` upward through six
  selectors; the same decision is expressed here by each control owning
  its own handler. The keyboard half is new: the legacy row had no role,
  no tabindex and no key handling, so it was mouse-only.
-->
<script lang="ts">
    import StatusLed from '../StatusLed.svelte';
    import AgentFamilyPill from './AgentFamilyPill.svelte';
    import Glyph from '../Glyph.svelte';
    import RunningSessionName from './RunningSessionName.svelte';
    import StartupGateBadge from './StartupGateBadge.svelte';
    import WrapperPill from './WrapperPill.svelte';
    import { t as reactiveT } from '../i18n/index.svelte';
    import {
        RUNNING_SESSION_KEYS,
        relativeAge,
    } from '../../../../client/js/labels/running-session.js';
    import { sessionDisplayLabel } from '../sessions/session-label';
    import { runRowAction } from './running-actions';
    import {
        offersFork,
        renamePencilView,
        sessionRowId,
        themeCueView,
    } from './running-row';
    import type { RunningHost } from './running-host';
    import type { RunningSessionRow as Row, Translate } from '../sessions/types';

    interface Props {
        row: Row;
        host: RunningHost;
        /** Recomputed by the list once per tick, so ages move together. */
        nowMs?: number | null;
        t?: Translate;
    }

    let { row, host, nowMs = null, t = reactiveT }: Props = $props();

    /** Whether the inline rename editor is open on this row. */
    let editing = $state(false);

    const owned = $derived(!!row.created_by_cloude);
    const displayName = $derived(sessionDisplayLabel(row));
    const pencil = $derived(renamePencilView(row));
    const rowId = $derived(sessionRowId(row));
    const theme = $derived(themeCueView(
        row.pinned_theme, (id) => host.themeColors(id),
    ));
    const actions = $derived(host.actionsFor(row.status));
    const cardActions = $derived(host.cardActions(row.name, !!row.unread));
    const age = $derived(
        row.created_at_epoch
            ? relativeAge(row.created_at_epoch, t, nowMs ?? undefined)
            : null,
    );

    /**
     * Open this session, by whichever of the two routes applies.
     *
     * Description: an ACTIVE row already has a backend in this browser, so
     *   it re-enters the terminal it left; anything else is an
     *   open-or-adopt. Both routes are the legacy methods, reached through
     *   the host, so a session behaves identically whichever surface it
     *   was clicked from.
     * Inputs: none. Output: Promise<void>.
     */
    async function open(): Promise<void> {
        if (editing) return;
        if (row.is_active) {
            await host.returnToActive(row.session_id ?? null);
            return;
        }
        await host.attachSession(row.name);
    }

    /**
     * Enter and Space activate the row, because it says it is a button.
     *
     * Inputs: event. Output: void.
     */
    function onKey(event: KeyboardEvent): void {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void open();
    }

    /**
     * Open the inline rename editor.
     *
     * Description: only the `renameable` state can reach this - the other
     *   two render a different class with no handler at all, which is what
     *   keeps a control the UI has just called unavailable out of the
     *   click path by construction rather than by a second check.
     * Inputs: event. Output: void.
     */
    function beginRename(event: Event): void {
        event.stopPropagation();
        if (pencil.state !== 'renameable') return;
        editing = true;
    }

    /**
     * Swallow a click on a pencil that cannot act.
     *
     * Description: without this the click falls through to the row and
     *   opens or adopts the session, which is a surprising side effect
     *   from an affordance the UI has just said is unavailable. The reason
     *   is already on the element as `title` and `aria-label`, so there is
     *   nothing further to say.
     * Inputs: event. Output: void.
     */
    function swallow(event: Event): void {
        event.stopPropagation();
    }
</script>

<div
    class="running-session-row {owned ? 'owned' : 'external'}"
    data-name={row.name}
    data-active={row.is_active ? '1' : '0'}
    data-session-id={row.session_id ?? undefined}
    data-session-theme={theme ? theme.themeId : undefined}
    style={theme ? `--session-theme-accent: ${theme.accent};` : undefined}
    role="button"
    tabindex="0"
    onclick={open}
    onkeydown={onKey}
>
    <div class="running-session-top">
        <StatusLed
            status={row.status}
            unread={!!row.unread}
            startupGate={row.startup_gate ?? null}
            statusSource={row.status_source ?? null}
            transport={host.transportFor(row.name) ?? null}
        />
        <RunningSessionName
            {displayName}
            renameKey={pencil.renameKey}
            {editing}
            onclose={() => { editing = false; }}
            {host}
            {t}
        />
        <StartupGateBadge gate={row.startup_gate ?? null} {t} />
        {#if theme}
            <!-- THE SAME ELEMENT THE SIDEBAR ROW RENDERS, in the same
                 place relative to the name, because one rule used to paint
                 both surfaces and moving the cue on one alone would
                 relocate the collision rather than remove it. `role="img"`
                 with a name rather than `aria-hidden`, so the cue is not
                 colour-only. -->
            <span
                class="session-theme-swatch"
                role="img"
                aria-label={t(RUNNING_SESSION_KEYS.themeSwatch, { name: theme.name })}
                title={t(RUNNING_SESSION_KEYS.themeSwatch, { name: theme.name })}
            ></span>
        {/if}
        {#if pencil.state === 'renameable'}
            <span
                class="running-session-rename"
                role="button"
                tabindex="0"
                aria-label={t(pencil.reasonKey)}
                title={t(pencil.reasonKey)}
                data-rename-sid={pencil.renameKey}
                data-rename-name={row.name}
                onclick={beginRename}
                onkeydown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    beginRename(event);
                }}><Glyph name="pencil" /></span
            >
        {:else}
            <!-- THE CONTROL IS NEVER OMITTED. An absent affordance is
                 indistinguishable from a broken one: the user cannot tell
                 "you may not do this" from "this app forgot to draw the
                 button". A different class keeps it out of the live path. -->
            <!-- NO KEYBOARD HANDLER, DELIBERATELY, AND THAT IS WHY THE
                 TWO CHECKS ARE SILENCED HERE. The element carries no
                 `tabindex`, so no keyboard can reach it; the click
                 handler exists ONLY to stop a mouse click falling through
                 to the row, which would open or adopt the session from an
                 affordance the UI has just called unavailable. A keydown
                 handler that did nothing would satisfy the rule and add a
                 control that answers keys while announcing itself
                 disabled. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <span
                class="running-session-rename-unavailable"
                aria-disabled="true"
                aria-label={t(pencil.reasonKey)}
                title={t(pencil.reasonKey)}
                onclick={swallow}><Glyph name="pencil" /></span
            >
        {/if}
        {#if offersFork(row)}
            <button
                type="button"
                class="running-session-fork"
                data-fork-name={row.name}
                title={t(RUNNING_SESSION_KEYS.forkTitle)}
                aria-label={t(RUNNING_SESSION_KEYS.forkAria)}
                onclick={(event) => {
                    event.stopPropagation();
                    void host.forkSession(row.name);
                }}>{t(RUNNING_SESSION_KEYS.forkAction)}</button
            >
        {/if}
        <!-- THE `session-card-action` SURFACE. Mark unread arrives here as
             a CONTRIBUTION rather than as hardcoded markup, so
             `ui.show_mark_unread_control` is read once, by the plugin's
             own `enabled`, and this surface and the sidebar menu hide
             together off one config key. An empty list is what the flag
             being off looks like. -->
        {#each cardActions as action (action.id)}
            <span
                class="mark-unread-toggle"
                class:mark-unread-toggle--active={row.unread}
                role="button"
                tabindex="0"
                aria-pressed={row.unread ? 'true' : 'false'}
                title={action.label}
                aria-label={action.label}
                data-mark-unread={row.name}
                data-row-menu-item={action.id}
                data-unread-current={row.unread ? 'true' : 'false'}
                onclick={(event) => {
                    event.stopPropagation();
                    void host.runCardAction(action.id, row.name, !!row.unread);
                }}
                onkeydown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    void host.runCardAction(action.id, row.name, !!row.unread);
                }}
                ><Glyph name={row.unread ? 'envelope-filled' : 'envelope-outline'} /></span
            >
        {/each}
        <!-- X (close) on a running row, trash (remove) on a stopped one,
             restart beside either - built from the SHARED
             `SessionRowActions.actionsFor`, so the launcher, the
             conversation sidebar and any future session surface draw the
             same glyph with the same tooltip for the same meaning. A
             second status list here is how two surfaces come to disagree
             about one session. -->
        {#each actions as action (action.id)}
            <button
                type="button"
                class={['session-row-action', 'running-session-kill',
                    action.extraClass]}
                data-session-action={action.id}
                data-session-name={row.name}
                title={t(action.labelKey)}
                aria-label={t(action.labelKey)}
                onclick={(event) => {
                    event.stopPropagation();
                    void runRowAction(row, action.id, host, t);
                }}><Glyph name={action.glyph} /></button
            >
        {/each}
    </div>
    <div class="running-session-badges">
        <span class="badge {owned ? 'badge-tmux' : 'badge-external'}"
            >{owned
                ? t(RUNNING_SESSION_KEYS.badgeTmux)
                : t(RUNNING_SESSION_KEYS.badgeExternal)}</span
        >
        <AgentFamilyPill
            family={row.agent_family}
            source={row.agent_family_source}
            {t}
        />
        <WrapperPill label={row.agent_wrapper_label} {t} />
        {#if age}
            <span class="running-session-age">{age}</span>
        {/if}
        {#if rowId !== null}
            <!-- THE PARENT LINK IS NOT RENDERED. It used to append an
                 arrow to `parent_session_id`, which for a restart made
                 before row reuse landed pointed at the ABANDONED
                 predecessor - and those rows are excluded from every list,
                 so the arrow pointed at a row that appears nowhere on
                 screen. A reference the user cannot follow is noise. -->
            <span
                class="running-session-id"
                title={t(RUNNING_SESSION_KEYS.rowIdTitle, { id: rowId })}
                >#{rowId}</span
            >
        {/if}
    </div>
</div>
