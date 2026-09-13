<!--
  The prompt rail: a thin strip of ticks down the terminal's right edge,
  one per prompt the user typed.

  THE DOM HALF ONLY. Every rule about what a tick points at, when the
  strip rescans and what "current" means lives in ./rail-model.svelte.ts,
  which is also where the marker arithmetic is written down.

  HIDING IS `hidden`, NOT A DISPLAY OVERRIDE, and the guard rule below is
  not belt and braces. `[hidden] { display: none }` lives in the
  USER-AGENT stylesheet, where ANY author `display` declaration outranks
  it. This project has already paid for that once: measured 2026-09-01, a
  `hidden` archive panel whose class carried `display: flex` rendered
  anyway and squeezed the list beside it. The rule declares no `display`
  today, so the guard is what stops one being added later and painting an
  empty strip over the terminal in every session that has no prompts and
  on every alternate-screen app.

  THE TOOLTIP IS RENDERED AS WELL AS SET AS `title`. A `title` covers a
  mouse; a thumb never hovers, so the strip also paints this box and the
  tick hands it a measured `top`.
-->
<script lang="ts">
    import PromptTick from './PromptTick.svelte';
    import type { RailModel } from './rail-model.svelte';

    interface Props {
        /** The model this strip paints. */
        rail: RailModel;
    }

    let { rail }: Props = $props();

    /** The strip element, handed to the model so it can measure itself. */
    let el = $state<HTMLDivElement | null>(null);
    /** The touch tooltip's text, its offset, and whether it is showing. */
    let tipText = $state('');
    let tipTop = $state('');
    let tipShown = $state(false);

    $effect(() => {
        rail.setElement(el);
        // THE CLICK IS BOUND BY HAND, NOT AS `onclick`, AND THAT IS THE
        // WHOLE OF THE TOUCH FIX. Svelte 5 DELEGATES `onclick`: it puts
        // one listener on the mount root and none on this element.
        // Chrome's touch adjustment picks a tap's target by looking for
        // a clickable node inside the finger's contact rect, and it
        // reads the element's OWN listeners, so a delegated handler is
        // invisible to it. Measured on a real phone viewport before this
        // line existed: a mouse click at x=369 jumped the viewport
        // 9976 -> 32, and a TAP at the same point was re-targeted onto
        // `xterm-link-layer` and did nothing at all. A real listener
        // here is what makes the strip a tap target the browser can see.
        if (!el) return () => rail.setElement(null);
        const node = el;
        node.addEventListener('click', jumpNear);
        return () => {
            node.removeEventListener('click', jumpNear);
            rail.setElement(null);
        };
    });

    /**
     * Show the tooltip beside one tick.
     *
     * Inputs: tip (string) - the sentence; top (string) - a CSS length.
     * Output: void.
     */
    function peek(tip: string, top: string): void {
        if (!tip) return;
        tipText = tip;
        tipTop = top;
        tipShown = true;
    }

    /**
     * A click anywhere down the strip jumps to the nearest tick.
     *
     * Description: this is what makes the 24px strip the tap target the
     *   stylesheet below has always claimed it was. Without it only the
     *   12x3 mark was clickable, so the promise in that comment was
     *   prose and a thumb aimed at the strip hit nothing.
     *
     *   IT CANNOT DOUBLE-FIRE ON A TICK. A tick is a `<button>` INSIDE
     *   this element, so its own click bubbles here as well; the target
     *   is compared against the strip itself rather than tested for a
     *   tick class, which also covers anything added inside the strip
     *   later without that element having to know this handler exists.
     *
     *   THE OFFSET IS MEASURED, NOT ASSUMED. `clientY` is viewport
     *   relative and every tick's `y` is strip relative, so the strip's
     *   own box is what converts between them.
     * Inputs: event (MouseEvent) - a click on the strip.
     * Output: void.
     */
    function jumpNear(event: MouseEvent): void {
        if (!el || event.target !== el) return;
        const ordinal = rail.ordinalNear(event.clientY - el.getBoundingClientRect().top);
        if (ordinal) rail.jumpTo(ordinal);
    }
</script>

<!--
  THE STRIP'S CLICK ADDS NO KEYBOARD PATH BECAUSE IT NEEDS NONE. Every
  tick is a real `<button>`, focusable and operable by Enter and Space,
  so a keyboard user already reaches every jump the strip offers. A key
  handler here would put a second, invisible target in the tab order
  that duplicates the buttons inside it. The click itself is bound in
  the effect above rather than as an `onclick` here; the comment there
  says why, and moving it back onto this tag breaks touch silently.
-->
<div
    bind:this={el}
    class="terminal-prompt-rail"
    aria-label="prompts in this session"
    hidden={rail.hidden}
    onmouseleave={() => {
        tipShown = false;
    }}
    role="presentation"
>
    <div class="prompt-rail-tooltip" role="tooltip" hidden={!tipShown} style:top={tipTop}>
        {tipText}
    </div>
    {#each rail.tickViews as tick (tick.ordinal)}
        <PromptTick {tick} onjump={(ordinal) => rail.jumpTo(ordinal)} onpeek={peek} />
    {/each}
</div>

<style>
    /* 24px is a tap target, not a tick. The tick inside it is 12x3 and
     * right-aligned, so the strip is mostly empty space a thumb can hit,
     * and `jumpNear` above is what makes that empty space act on a tap.
     * Widening the tick instead is the wrong fix: the mark's size is what
     * keeps a long rail readable. */
    .terminal-prompt-rail {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 24px;
        pointer-events: auto;
        /* The affordance for the tap target `jumpNear` implements, and a
         * second signal to the same touch-adjustment heuristic the hand
         * bound listener feeds. */
        cursor: pointer;
    }

    /* THE ONE RULE THE MODEL ASKS THIS FILE FOR. See the header. */
    .terminal-prompt-rail[hidden] {
        display: none !important;
    }

    .prompt-rail-tooltip {
        position: absolute;
        right: 28px;
        z-index: 32;
        max-width: min(280px, 60vw);
        padding: 4px 8px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md, 4px);
        background: var(--color-bg-elevated);
        color: var(--color-fg);
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.35;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        pointer-events: none;
        box-shadow: var(--shadow-modal);
    }

    .prompt-rail-tooltip[hidden] {
        display: none;
    }
</style>
