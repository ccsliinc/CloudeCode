<!--
  One tick on the prompt rail.

  A 12x3 MARK inside a 24px HIT BOX, which are two different things and
  the distinction is the whole point. The button spans the strip's full
  width and is transparent; the visible mark is its `::after`, 12x3 and
  right-aligned. Ported from the `tickEl` builder in
  `client/js/terminal-prompt-rail.js` with the same three state classes.

  THE HIT BOX IS WIDE BECAUSE THE BROWSER RELOCATES A TAP, and that was
  measured rather than assumed. Chrome's touch adjustment does not aim a
  finger at whatever `elementFromPoint` returns: it expands the contact
  into a rect and snaps to the clickable node it scores best. On a 390px
  phone viewport a tap at x=369, three pixels inside the strip, was
  MOVED to x=362 - outside the strip entirely - and delivered to
  `xterm-link-layer`, the terminal-wide overlay beside it. A click
  listener on the strip does not win that contest and neither does
  `cursor: pointer`; both were tried and measured. A real `<button>`
  under the finger does. The strip's own handler still covers the gaps
  BETWEEN ticks, where there is no button to snap to.

  IT IS A REAL BUTTON. It is a keyboard-reachable jump target and it
  carries the same sentence in `title` (for a mouse) and `aria-label`
  (for a screen reader and for the touch tooltip beside it).
-->
<script lang="ts">
    import type { TickView } from './rail-model.svelte';

    interface Props {
        /** Everything painted about this tick. */
        tick: TickView;
        /** Jump the viewport to this tick's first prompt. */
        onjump: (ordinal: number) => void;
        /** Show the touch tooltip for this tick. */
        onpeek: (tip: string, top: string) => void;
    }

    let { tick, onjump, onpeek }: Props = $props();

    /** The tick's own offset down the strip, as a CSS length. */
    const top = $derived(`${tick.y}px`);
</script>

<button
    type="button"
    class="prompt-tick"
    class:is-dim={tick.dim}
    class:is-current={tick.current}
    class:is-cluster={tick.cluster}
    data-ordinal={tick.ordinal}
    style:top
    title={tick.tip}
    aria-label={tick.tip}
    onclick={() => onjump(tick.ordinal)}
    onmouseover={() => onpeek(tick.tip, top)}
    onfocus={() => onpeek(tick.tip, top)}
    ontouchstart={() => onpeek(tick.tip, top)}
></button>

<style>
    /* THE HIT BOX. Transparent, and as wide as the strip, so a thumb
     * aimed at this tick's row lands on a real button. See the header. */
    .prompt-tick {
        position: absolute;
        right: 0;
        width: 24px;
        height: 3px;
        padding: 0;
        border: none;
        background: none;
        cursor: pointer;
    }

    /* THE MARK. 12x3, right-aligned, and the only part that is painted.
     * Every state below moves THIS, never the box around it, so the hit
     * region cannot drift as the rail changes. */
    .prompt-tick::after {
        content: '';
        position: absolute;
        top: 0;
        right: 0;
        width: 12px;
        height: 100%;
        border-radius: 1px;
        background: var(--color-fg-muted);
        transition:
            width 0.1s ease,
            background 0.1s ease,
            opacity 0.1s ease;
    }

    /* Filtered out by the query. DIMMED, NEVER REMOVED: a rail that
     * dropped its non-matching ticks would change every remaining tick's
     * position on each keystroke, so the one the user was reaching for
     * moves out from under the pointer as they type. */
    .prompt-tick.is-dim {
        opacity: 0.3;
    }

    /* Where the viewport is. Wider as well as accented, because the whole
     * rail is 3px tall per tick and colour alone at that size is
     * invisible to a colour-blind user and to anybody at arm's length. */
    .prompt-tick.is-current::after {
        width: 16px;
        background: var(--color-accent);
        opacity: 1;
    }

    /* Several prompts merged into one tick because the rail ran out of
     * pixels. Taller rather than wider so it cannot be mistaken for the
     * current one; its tooltip reads `#7-#9`. */
    .prompt-tick.is-cluster {
        height: 5px;
    }

    .prompt-tick:hover::after,
    .prompt-tick:focus-visible::after {
        width: 18px;
        background: var(--color-accent-strong, var(--color-accent));
        outline: 1px solid var(--color-accent);
        outline-offset: 1px;
    }

    /* Cancels styles.css's global `button:hover` scale, on the BOX: a
     * scaled hit box is a hit box that moves under the finger. */
    .prompt-tick:hover,
    .prompt-tick:focus-visible {
        transform: none;
    }

    /* The focus ring belongs to the mark, which is what is visible. */
    .prompt-tick:focus-visible {
        outline: none;
    }

    /* A taller MARK on a phone, where the hit box is already the full
     * strip width. Height is declared on the box and the mark tracks it
     * at 100%, so the two cannot come apart. */
    @media (max-width: 768px) {
        .prompt-tick {
            height: 4px;
        }

        .prompt-tick.is-cluster {
            height: 7px;
        }
    }
</style>
