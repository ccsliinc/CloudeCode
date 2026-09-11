<!--
  ModalShell - the overlay, the header and the two ways out, once.

  ALL FIVE MODALS THIS SLICE PORTS HAD THEIR OWN COPY of this: an
  `.modal-overlay` div, a click handler comparing `e.target === overlay`,
  a keydown handler testing `e.key === 'Escape'`, and a `.modal-content`
  with a header, a body and a footer. Five copies is five chances for one
  to forget escape, which is how a modal becomes unclosable on a keyboard.

  THE DISMISS GUARD IS A PROP, NOT A FLAG THIS OWNS. The clone modal
  refuses escape and click-outside WHILE A CLONE IS IN FLIGHT, because
  dismissing the form does not cancel the `gh repo clone` the server is
  already running, and a modal that vanishes while work continues is
  worse than one that will not close. That is the caller's fact, so it
  comes in as `dismissable`.

  CLICK-OUTSIDE TESTS THE TARGET, NOT `contains`. A click that starts on
  the overlay and ends on the content is not a click outside; comparing
  the event target to the overlay itself is what the hand-written
  versions did and is what keeps a drag-select out of the body from
  closing the modal.

  THE KEY LISTENER IS ON THE OVERLAY, not on `document`, for four of the
  five - the choice modal is the exception and keeps its own capturing
  document listener, because its arrow keys have to win against whatever
  has focus underneath. Svelte's `on:keydown` on a focusable container
  reproduces the legacy behaviour exactly.

  NO COLOUR LITERAL AND NO NEW CLASS. Every class here already exists in
  client/css/styles.css and client/css/modal-stack.css, so all 26 themes
  keep working with no theme change at all.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        /** The header sentence, already translated by the caller. */
        title: string;
        /** The modal body. */
        children: Snippet;
        /** The footer's buttons. */
        footer: Snippet;
        /** False suspends escape and click-outside, e.g. while busy. */
        dismissable?: boolean;
        /** Called when the user dismisses without choosing. */
        onCancel: () => void;
    }

    let { title, children, footer, dismissable = true, onCancel }: Props = $props();

    /**
     * Dismiss on Escape, unless the caller has suspended dismissal.
     *
     * Inputs: event (KeyboardEvent). Output: void.
     */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        if (!dismissable) return;
        onCancel();
    }

    /**
     * Dismiss on a click that landed on the overlay and nothing else.
     *
     * Inputs: event (MouseEvent). Output: void.
     */
    function onOverlayClick(event: MouseEvent): void {
        if (event.target !== event.currentTarget) return;
        if (!dismissable) return;
        onCancel();
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={onKeydown}
    onclick={onOverlayClick}
>
    <div class="modal-content">
        <div class="modal-header">&raquo; {title}</div>
        <div class="modal-body">{@render children()}</div>
        <div class="modal-footer">{@render footer()}</div>
    </div>
</div>
