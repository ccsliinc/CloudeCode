/**
 * WHAT A PARENT MUST SUPPLY TO MOUNT THE CONVERSATION VIEW.
 *
 * THIS FILE IS THE SHELL CONTRACT, WRITTEN DOWN. Adam is replacing the
 * entire application shell (issue #175), so this view must mount into
 * one that does not exist yet. Everything it cannot get from its own
 * subtree is here, as a prop, and this list IS the answer to "what does
 * a host have to provide" - which is the question
 * `docs/archive-shell-contract.md` exists to track.
 *
 * ONE OF THESE IS AN `app-screen` GAP, and it is the SAME third gap
 * slice 7 reported rather than a fourth. `AppScreen.mount(container,
 * route, context, api)` can describe a container, a route, a context and
 * a granted client, and nothing else. Slice 6 needed a SCROLLPORT and
 * used a prop; slice 5 needed a MODAL HOST and used a prop; slice 7
 * needed a FRAME SCHEDULER and used `raf`. This view coalesces its
 * repaints into one animation frame and pays the anti-jump scroll debt
 * inside that frame exactly as the reader does, so it needs the same
 * scheduler for the same reason. NO FOURTH GAP WAS FOUND.
 *
 * THE SCROLLPORT IS OURS, NOT THE PARENT'S, and that differs from slice
 * 6 on purpose, for slice 7's reason: `.archive-chat__scroller` is the
 * element whose `scrollTop` the anti-jump contract writes, and that debt
 * must be paid in the SAME call as the height write, a call the parent
 * is not in. The scroller has no height of its own, so this is still
 * shell-independent.
 *
 * Kept out of the component so `ChatView.svelte` stays under this
 * project's 500-line guideline, and so the contract can be read without
 * reading the implementation.
 */
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';

/** Where a subagent drill wants to go, reported to the parent. */
export interface SubagentTarget {
    readonly transcriptId: string | null;
    readonly agentId: string | null;
    readonly label: string | null;
    readonly ordinal: number | null;
}

/** The conversation view's props. */
export interface ChatProps {
    /** The granted archive client from slice 2. Required. */
    client: ArchiveClient;
    /**
     * The outcome classifier, injected the same way `state.ts` injects
     * it: `archive-outcome.js` is a later slice and this tree reaches for
     * no global.
     */
    outcome: OutcomeClassifier;
    /**
     * Which transcript the chain STARTS at. The view holds one chain at
     * a time - its geometry, its open panels and its cursor are all keyed
     * to the level being shown - so a parent changing this should build a
     * NEW view (`{#key}`) rather than swap the prop.
     */
    transcriptId: number | string;
    /**
     * A name for the root level of the breadcrumb, or null.
     *
     * NULL IS RENDERED AS NOT KNOWN, never as an invented "Transcript".
     * A breadcrumb that fills in a plausible name is exactly the kind of
     * filler that stops people asking why the name is missing.
     */
    label?: string | null;
    /** Turns per request. The pager's label states it. */
    pageTurns?: number;
    /** Rows kept rendered beyond each viewport edge. */
    overscan?: number;
    /**
     * THE FRAME SCHEDULER, the third `app-screen` gap, shared with slice
     * 7. A test passes a synchronous one and drives paints by hand; jsdom
     * fires no real animation frame, so a view reaching for the global
     * would leave its own measurement pass unmeasured in every test.
     */
    raf?: (fn: () => void) => unknown;
    /**
     * Render a non-renderable envelope. Supplied by the composition root
     * because `archive-outcome-view.js` is slice 9's port. When absent
     * the token and the transport reason are still stated in words, so a
     * failure is never a blank pane.
     */
    renderOutcome?: ((envelope: unknown) => Element | null) | null;
    /**
     * Told whenever the drill chain moves, so a host can keep an address
     * bar or a title in step. OPTIONAL: the view navigates itself and
     * does not need a parent's permission to drill.
     */
    onDrill?: ((target: SubagentTarget | null, depth: number) => void) | null;
}
