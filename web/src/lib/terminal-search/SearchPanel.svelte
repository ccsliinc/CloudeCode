<!--
  The session search panel, and the rail beside it.

  A small overlay inside `.terminal-container`: a query field, a match
  counter, previous / next, "deep dive", close, and the mount point for
  the prompt rail down the terminal's right edge. Ported from
  `client/js/terminal-search-chrome.js` (the markup) and
  `client/js/terminal-search.js` (the lifecycle, now
  ./search-controller.svelte.ts).

  TWO ROOTS, AND THE RAIL HOST IS A SIBLING OF THE PANEL RATHER THAN A
  CHILD. The rail runs the full height of the terminal down its right
  edge and the panel is a small box in one corner, so nesting them would
  tie the rail's geometry to the panel's.

  AN OVERLAY, NEVER AN IN-FLOW CHILD, and this is the file that enforces
  it. `.terminal-container` is a flex column, so an in-flow child of it
  takes rows away from `#terminal`; the ResizeObserver reads that as a
  real geometry change, ships a pty_resize, tmux raises SIGWINCH and
  claude answers with `ESC[2J`, which on the alternate screen erases the
  conversation. A panel whose whole job is FINDING things in the
  scrollback must not be able to wipe the scrollback on its way in.
  `#localServersContainer` paid for this lesson first. What makes
  `.terminal-container` a containing block is the single
  `position: relative` on it in `client/css/styles.css`; this file relies
  on that and deliberately does not restate it, because two
  `position: relative` declarations on one element is how one of them
  gets deleted as a duplicate and the other turns out to be the one that
  mattered.

  WHERE IT SITS. TOP-RIGHT, ON THE OWNER'S 2026-09-13 INSTRUCTION: "make
  the search bar wider, on the right side of the screen (notifications
  should appear under), and auto-focus to the search box." It was
  top-left until then, and the comment above `.terminal-container` in
  client/index.html says not to put a floating control back in this
  corner. THAT PROHIBITION IS ABOUT A PERSISTENT ONE. What it was written
  for is the folded tool strip that lived here permanently and covered
  output across the pane's full width, and the 45px session-editor button
  that replaced it and grew back into one; both are gone, the corner is
  empty, and this panel is neither - it is transient, it is only on
  screen while the user is searching, and Esc removes it. Bottom is still
  refused on a desktop: that is where claude's input box is, and the user
  has to keep seeing what they are typing while they search.

  Under 769px it moves to the BOTTOM anyway, for thumb reach, above where
  the on-screen keyboard comes up. That is the same line the tools FAB
  and the d-pad already break on; a third "mobile" number is how a row
  ends up with a hole in it at some width nobody tested.

  Z-INDEX 1110, WHICH IS ABOVE THE TOAST STACK. The panel is the one the
  user just asked for, so it wins any overlap. See the rules at the foot
  of the style block for the offset that stops the two overlapping at
  all.
-->
<script lang="ts">
    import PromptRail from './PromptRail.svelte';
    import type { SearchController } from './search-controller.svelte';

    interface Props {
        /** The panel's state and every decision it makes. */
        controller: SearchController;
    }

    let { controller }: Props = $props();

    /** The panel root and the query field, handed to the controller. */
    let panelEl = $state<HTMLDivElement | null>(null);
    let inputEl = $state<HTMLInputElement | null>(null);

    $effect(() => {
        controller.setPanelElement(panelEl);
        return () => controller.setPanelElement(null);
    });

    $effect(() => {
        controller.setInputElement(inputEl);
        return () => controller.setInputElement(null);
    });

    /**
     * Publish the panel's bottom edge so the toast stack can start below
     * it.
     *
     * The toast container is `position: fixed` on `body`, so it is not a
     * descendant of anything this component can style a variable onto -
     * hence documentElement. It is MEASURED rather than computed because
     * the panel's viewport `top` is the header's height plus the pane's
     * padding, and the header is not one number: it changes with the
     * breakpoint and with the deep-link banner above it. One read, on
     * open, which is safe here because `opened` has already been flushed
     * to the DOM by the time an effect runs.
     *
     * A STALE VALUE CANNOT MOVE ANYTHING. The rule that consumes it is
     * gated on `body:has(.terminal-search-panel.is-open)`, so the toast
     * stack is back where it was the moment the panel closes whether or
     * not this clears - and it clears anyway.
     */
    $effect(() => {
        const root = panelEl?.ownerDocument?.documentElement;
        if (!root) return;
        if (!controller.opened) {
            root.style.removeProperty('--terminal-search-toast-top');
            return;
        }
        const bottom = panelEl?.getBoundingClientRect?.().bottom ?? 0;
        root.style.setProperty('--terminal-search-toast-top', `${Math.round(bottom) + 12}px`);
        return () => root.style.removeProperty('--terminal-search-toast-top');
    });
</script>

<div
    bind:this={panelEl}
    class="terminal-search-panel"
    class:is-open={controller.opened}
    role="search"
    aria-label="search this session"
>
    <div class="terminal-search__row">
        <!-- autocomplete, autocorrect, autocapitalize and spellcheck are
             every one of them off on purpose: a terminal query is a path,
             a flag or an identifier, and an autocapitalised or
             autocorrected one silently searches for something else. -->
        <input
            bind:this={inputEl}
            bind:value={controller.query}
            oninput={() => controller.onType()}
            type="search"
            class="terminal-search__input"
            aria-label="search this session"
            placeholder="search this session"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
        />
        <!-- Polite, not assertive: the count changes on every keystroke
             and an assertive region would interrupt a screen reader
             mid-word. -->
        <span class="terminal-search__count" aria-live="polite">{controller.countText}</span>
        <button
            type="button"
            class="terminal-search__btn"
            aria-label="previous match (shift+enter)"
            title="previous match (shift+enter)"
            onclick={() => controller.step('prev')}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                    d="M12 10 8 6l-4 4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </button>
        <button
            type="button"
            class="terminal-search__btn"
            aria-label="next match (enter)"
            title="next match (enter)"
            onclick={() => controller.step('next')}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                    d="m4 6 4 4 4-4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </button>
        <button
            type="button"
            class="terminal-search__deep"
            disabled={!controller.deepEnabled}
            title={controller.deepTitle}
            onclick={() => controller.openDeepDive()}>deep dive</button
        >
        <button
            type="button"
            class="terminal-search__btn"
            aria-label="close search (esc)"
            title="close search (esc)"
            onclick={() => controller.close()}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                    d="m4 4 8 8M12 4l-8 8"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                />
            </svg>
        </button>
    </div>
</div>

<!-- The host is INERT (`pointer-events: none`) so an empty 24px strip -
     the rail is hidden on the alternate screen and when there are no
     prompts - cannot eat clicks on the terminal's last column. The rail
     turns pointer events back on for itself. -->
<div class="terminal-prompt-rail-host">
    <PromptRail rail={controller.rail} />
</div>

<style>
    /* -----------------------------------------------------------------
     * The xterm decoration colours.
     *
     * DECLARED HERE, READ BY THE ENGINE, VALIDATED BEFORE USE. xterm
     * wants a colour string it can parse into a cell decoration, and
     * `client/js/terminal-search-engine.js` hands it these values
     * directly, so they must be HEX and nothing else - the engine
     * refuses anything that is not and falls back to its own defaults.
     * That is why these are not `var(--color-accent...)` chains: several
     * of the accent tokens are `rgba()`, which reads perfectly in CSS
     * and would be refused here. A theme overriding these must use hex.
     *
     * They live on `.terminal-container` rather than `:root` so a
     * per-session theme scoped to the pane can move them, which is also
     * why this rule is `:global` - the container belongs to
     * client/index.html, not to this component.
     * --------------------------------------------------------------- */
    :global(.terminal-container) {
        --terminal-search-match-bg: #4d3b30;
        --terminal-search-match-border: #8a5a44;
        --terminal-search-match-ruler: #8a5a44;
        --terminal-search-active-bg: #d77757;
        --terminal-search-active-border: #e88768;
        --terminal-search-active-ruler: #d77757;
    }

    .terminal-search-panel {
        display: none;
        position: absolute;
        top: 15px;
        /* 24px of prompt rail plus the same 15px gutter the panel used to
         * keep on the left, so the panel stops short of the rail rather
         * than covering its top ticks. */
        right: 39px;
        /* ABOVE THE TOAST STACK (1100, client/css/toast.css) rather than
         * the 31 this used to carry. Both now live in the pane's top
         * right, and the panel is the thing the user just asked for, so
         * it wins any overlap outright instead of relying on the offset
         * below being right. Still under the row menu (1200) and the
         * modals (9998+), neither of which can reach this corner. */
        z-index: 1110;

        /* 560px fits a full path or a long flag beside the counter and
         * the four controls without the field collapsing, and still
         * leaves the pane readable behind it; the calc is the same
         * "never overflow" clamp as before, now counting the rail. */
        width: min(560px, calc(100% - 54px));
        box-sizing: border-box;
        padding: 6px 8px;

        border: 1px solid var(--color-accent-border, var(--color-border));
        border-radius: var(--radius-lg, 8px);
        background: var(--color-bg-elevated, var(--color-bg-card));
        color: var(--color-fg);
        box-shadow: 0 6px 18px var(--color-accent-shadow-soft, rgba(0, 0, 0, 0.35));

        font-family: var(--font-mono);
        font-size: 13px;
        line-height: 1.4;
    }

    .terminal-search-panel.is-open {
        display: block;
    }

    .terminal-search__row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    /* min-width: 0 is the flex-item half of "this field may shrink".
     * Without it the input's automatic minimum size is its intrinsic
     * width and the row overflows the panel rather than the field
     * getting narrower. */
    .terminal-search__input {
        flex: 1 1 auto;
        min-width: 0;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md, 4px);
        background: var(--color-bg-card);
        color: var(--color-fg);
        font-family: inherit;
        font-size: 13px;
    }

    .terminal-search__input:focus {
        border-color: var(--color-accent);
        outline: none;
    }

    /* WebKit paints its own round clear button inside a `type=search`,
     * which sits on top of the count at this width and is not themeable.
     * The panel has its own close control and Esc; this one is noise. */
    .terminal-search__input::-webkit-search-cancel-button {
        -webkit-appearance: none;
        appearance: none;
    }

    /* Tabular numerals so `9 of 40` and `10 of 40` do not shove the
     * buttons sideways on every step through the matches. */
    .terminal-search__count {
        flex: 0 0 auto;
        min-width: 0;
        color: var(--color-fg-muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    /* Width, height and justify-content are declared on purpose.
     * styles.css carries a bare `button { width: var(--control-size);
     * height: var(--control-size); justify-content: center; }`, and a
     * class beats it ONLY for the properties the class actually
     * declares. Check the computed value, not the rule you wrote. */
    .terminal-search__btn {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: none;
        border-radius: var(--radius-md, 4px);
        background: transparent;
        color: var(--color-fg-muted);
        cursor: pointer;
    }

    .terminal-search__btn:hover:not(:disabled),
    .terminal-search__btn:focus-visible {
        background: var(--color-bg-hover);
        color: var(--color-accent);
        outline: none;
        /* Cancels styles.css's global `button:hover` scale, which would
         * grow a 26px control inside a fixed-height row. */
        transform: none;
    }

    .terminal-search__deep {
        flex: 0 0 auto;
        width: auto;
        height: 26px;
        padding: 0 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md, 4px);
        background: transparent;
        color: var(--color-fg-muted);
        font-family: inherit;
        font-size: 11px;
        white-space: nowrap;
        cursor: pointer;
    }

    .terminal-search__deep:hover:not(:disabled),
    .terminal-search__deep:focus-visible {
        border-color: var(--color-accent);
        color: var(--color-accent);
        outline: none;
        transform: none;
    }

    /* Disabled says WHY in its title, and the controller always sets
     * one. Dimmed rather than hidden: a control that vanishes reads as a
     * missing feature, one that is greyed out reads as a rule with a
     * reason. */
    .terminal-search__deep:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .terminal-prompt-rail-host {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 24px;
        z-index: 31;
        pointer-events: none;
    }

    /* -----------------------------------------------------------------
     * The header trigger, which this component does not render.
     *
     * SCOPED THE WAY client/css/session-editor-header.css SCOPES THE
     * SESSION EDITOR: hidden by default with an id selector (`.btn-icon`
     * declares `display: flex`, so a class would lose), then allowed on
     * the ONE screen a session control names anything on. An allow-list,
     * not a deny-list, so a fifth sessionless screen cannot leak it.
     *
     * AND DESKTOP ONLY, ON A MEASURED CONSTRAINT. `.controls` is
     * flex-shrink: 0 and the session TITLE is what gives up space. At
     * 330px the resolved --control-size is 40px, so the four controls
     * already there occupy 40*4 + 8*3 = 184px, plus a 40px sidebar
     * toggle and 24px of padding, leaving 82px for the title - which is
     * what tests/test_mobile_only_fab_and_header_editor.node.mjs
     * measures. A fifth always-on control takes that to 232px and leaves
     * 34, under that test's own 40px floor: the header would not
     * overflow, the session name would just stop being readable.
     *
     * So the phone gets this control through the terminal tools menu
     * instead, which is hidden above 768px - the two are exact
     * complements, with no width at which both or neither is reachable.
     * The hotkey works at every width regardless.
     * --------------------------------------------------------------- */
    :global(#terminalSearchBtn) {
        display: none;
    }

    @media (min-width: 769px) {
        :global(body:has(#terminal-screen.active) #terminalSearchBtn) {
            display: flex;
        }
    }

    /* -----------------------------------------------------------------
     * Phone: the panel moves to the bottom.
     *
     * `bottom` and `top: auto` together, so the desktop `top` above is
     * fully cancelled rather than fighting the `bottom` beside it.
     * --------------------------------------------------------------- */
    @media (max-width: 768px) {
        .terminal-search-panel {
            top: auto;
            bottom: 15px;
            left: 8px;
            /* Cancels the desktop `right` so `left` + `width` decide the
             * box, rather than leaving all three set at once. */
            right: auto;
            width: calc(100% - 16px);
        }
    }

    /* -----------------------------------------------------------------
     * The toast stack starts BELOW the panel while the panel is open.
     *
     * The owner's ask, verbatim: "on the right side of the screen
     * (notifications should appear under)". Both now occupy the top
     * right, so without this they land on top of each other.
     *
     * DESKTOP ONLY, because under 769px the panel is at the BOTTOM and
     * the toasts are already clear of it - pushing them down there would
     * move them for nothing. The `:has()` gate is what makes the offset
     * exist only while the panel does, so a closed panel restores the
     * stack with no teardown step to forget. The 60px fallback is
     * toast.css's own value, so a missing measurement changes nothing.
     * --------------------------------------------------------------- */
    @media (min-width: 769px) {
        :global(body:has(.terminal-search-panel.is-open) .toast-container) {
            top: var(--terminal-search-toast-top, 60px);
        }
    }
</style>
