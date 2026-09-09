<!--
  AttributionPrompt - Stage C, the card that asks "did you start these?".

  THE FIRST LEGACY SCREEN ELEMENT ACTUALLY REPLACED. Slice 1 of the
  strangler migration: `client/js/launchpad.js` lost five methods and two
  fields in the same commit that added this file, and `loadProjects()`
  now calls `CloudeWeb.launchpad.mountAttributionPrompt()` at the exact
  line its own render used to run on.

  IT IS A PORT, NOT A REDESIGN. Every class name, element id, attribute
  and sentence below is the one the legacy renderer emitted, so
  `client/css/attribution-prompt.css` styles it unchanged, all 26 themes
  keep working with no theme work, and the two archived pixel verifiers
  under scripts/archive/verify/ still find what they measure. The
  decision ladder behind it lives in ./attribution.ts, which is where the
  reasons are written down.

  NO COLOUR IS DECLARED HERE AND NO {@html} IS USED. The card is painted
  entirely by the existing stylesheet, keyed off these class names; two
  copies of a palette is two palettes. Every string that reaches the DOM
  goes through Svelte's own escaping, which is what replaced the legacy
  `_escapeHtml` calls - a label is free-form user text and one of the
  test fixtures is literally `<b>not html</b>`.
-->
<script lang="ts">
    import {
        adoptAttributed,
        browserHost,
        close,
        declineAttributed,
        isClosed,
        loadPrompt,
        viewFor,
        type AttributionHost,
        type SessionAttributionPrompt,
    } from './attribution';

    interface Props {
        /**
         * Everything outside this component that it reaches. Defaults to
         * the legacy globals; a caller passes one in only to test.
         */
        host?: AttributionHost;
    }

    let { host = browserHost() }: Props = $props();

    /** The fetched body, or null for "we could not ask". */
    let prompt = $state<SessionAttributionPrompt | null>(null);
    /**
     * Whether the user asked to choose individually. UI only, and it
     * resets on every reload exactly as it did in the legacy card, whose
     * reload rebuilt the markup from the template with the tick boxes
     * hidden again.
     */
    let picking = $state(false);
    /**
     * The close, mirrored into component state so the view recomputes
     * when it changes. The durable copy is the module's, because this
     * component is remounted on every `loadProjects()`.
     */
    let hasClosed = $state(isClosed());
    /** Which rows are ticked, keyed by tmux name. Ticked by default. */
    let ticked = $state<Record<string, boolean>>({});

    const view = $derived(viewFor(prompt, host, hasClosed));

    /**
     * Fetch the question set and reset the per-render UI state.
     *
     * Inputs: none. Output: Promise<void>.
     */
    async function reload(): Promise<void> {
        prompt = await loadPrompt(host);
        picking = false;
        ticked = {};
    }

    /**
     * Every row's tmux name, ticked or not.
     *
     * Inputs: none. Output: string[].
     */
    function allNames(): string[] {
        return view.kind === 'pending' ? view.rows.map((r) => r.tmuxName) : [];
    }

    /**
     * The ticked rows' tmux names. A row with no entry is ticked, which
     * is what `checked` in the legacy markup meant.
     *
     * Inputs: none. Output: string[].
     */
    function pickedNames(): string[] {
        return allNames().filter((name) => ticked[name] !== false);
    }

    /**
     * Adopt, then reload the card, then reload the running sessions.
     *
     * Description: that order is the legacy order and it matters - the
     *   running list is what the user watches the session ARRIVE in, so
     *   it is refreshed after the answer has been recorded.
     * Inputs: names (string[]) - the sessions to adopt.
     * Output: Promise<void>.
     */
    async function adopt(names: string[]): Promise<void> {
        if (names.length === 0) return;
        await adoptAttributed(names, host);
        await reload();
        host.refreshRunningSessions();
    }

    /**
     * Record "leave these as external", then reload the card.
     *
     * Description: no running-sessions refresh. Declining moves nothing.
     * Inputs: names (string[]) - the sessions left external.
     * Output: Promise<void>.
     */
    async function decline(names: string[]): Promise<void> {
        if (names.length === 0) return;
        await declineAttributed(names, host);
        await reload();
    }

    /**
     * Close the card for this page session. Not an answer, not persisted.
     *
     * Inputs: none. Output: void.
     */
    function dismiss(): void {
        close();
        hasClosed = true;
    }

    // Fetched as the component initialises, which is the moment the
    // legacy `loadAttributionPrompt()` ran. Not awaited: the card paints
    // nothing until there is something to paint, and a failed fetch
    // leaves it painting nothing.
    void reload();
</script>

{#if view.kind === 'unavailable'}
    <div
        class="attribution-prompt attribution-prompt--unknown"
        data-attribution-state="unavailable"
    >{view.notice}</div>
{:else if view.kind === 'pending'}
    <section
        class="attribution-prompt"
        class:attribution-prompt--picking={picking}
        data-attribution-state="pending"
        aria-label="sessions we could not attribute"
    >
        <button
            type="button"
            class="attribution-prompt__close"
            id="attribution-prompt-close"
            aria-label="close for now"
            onclick={dismiss}
        >x</button>
        <p class="attribution-prompt__notice">{view.notice}</p>
        <ul class="attribution-prompt__list">
            {#each view.rows as row (row.tmuxName)}
                <li class="attribution-prompt__row" data-tmux-name={row.tmuxName}>
                    <label class="attribution-prompt__pick">
                        <input
                            type="checkbox"
                            class="attribution-prompt__check"
                            data-tmux-name={row.tmuxName}
                            checked={ticked[row.tmuxName] !== false}
                            onchange={(event) => {
                                ticked[row.tmuxName] = event.currentTarget.checked;
                            }}
                        />
                        <span
                            class="attribution-prompt__name"
                            title="tmux session: {row.tmuxName}"
                        >{row.shown}</span>
                    </label>
                    <span class="attribution-prompt__meta">started {row.started}</span>
                    <span class="attribution-prompt__why" data-reason={row.reason}
                    >{row.why}</span>
                    {#if row.hints.length}
                        <ul class="attribution-prompt__hints">
                            {#each row.hints as hint}
                                <li class="attribution-prompt__hint">{hint}</li>
                            {/each}
                        </ul>
                    {/if}
                </li>
            {/each}
        </ul>
        <div
            class="attribution-prompt__actions attribution-prompt__actions--all"
            hidden={picking}
        >
            <button
                type="button"
                class="attribution-prompt__btn attribution-prompt__btn--primary"
                id="attribution-adopt-all"
                onclick={() => adopt(allNames())}
            >adopt all</button>
            <button
                type="button"
                class="attribution-prompt__btn"
                id="attribution-choose"
                onclick={() => { picking = true; }}
            >choose individually</button>
            <button
                type="button"
                class="attribution-prompt__btn"
                id="attribution-decline-all"
                onclick={() => decline(allNames())}
            >leave as external</button>
        </div>
        <div
            class="attribution-prompt__actions attribution-prompt__actions--picked"
            hidden={!picking}
        >
            <button
                type="button"
                class="attribution-prompt__btn attribution-prompt__btn--primary"
                id="attribution-adopt-picked"
                onclick={() => adopt(pickedNames())}
            >adopt the ticked ones</button>
            <button
                type="button"
                class="attribution-prompt__btn"
                id="attribution-decline-picked"
                onclick={() => decline(pickedNames())}
            >leave the ticked ones external</button>
        </div>
        <p class="attribution-prompt__footnote"
        >closing this without answering brings it back next time. leaving them external is remembered.</p>
    </section>
{/if}
