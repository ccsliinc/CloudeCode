/**
 * WHAT A PARENT MUST SUPPLY TO MOUNT THE READER.
 *
 * THIS FILE IS THE SHELL CONTRACT, WRITTEN DOWN. Adam is replacing the
 * entire application shell (issue #175), so the reader must mount into
 * one that does not exist yet. Everything it cannot get from its own
 * subtree is here, as a prop, and this list IS the answer to "what does
 * a host have to provide" - which is the question
 * `docs/archive-shell-contract.md` exists to track.
 *
 * THREE OF THESE ARE `app-screen` GAPS, not permanent design.
 * `AppScreen.mount(container, route, context, api)` can describe a
 * container, a route, a context and a granted client, and nothing else.
 * Slice 6 needed a SCROLLPORT and used a prop; slice 5 needed a MODAL
 * HOST and used a prop; this slice needs a FRAME SCHEDULER and uses
 * `raf`. When the surface grows ways to describe them, these are the
 * props that get replaced.
 *
 * Kept out of the component so `TranscriptReader.svelte` stays under
 * this project's 500-line guideline, and so the contract can be read
 * without reading the implementation.
 */
import type { ArchiveClient } from './client';
import type { OutcomeClassifier } from './state';

/** The reader's props. */
export interface ReaderProps {
    /** The granted archive client from slice 2. Required. */
    client: ArchiveClient;
    /**
     * The outcome classifier, injected the same way `state.ts` injects
     * it: `archive-outcome.js` is a later slice and this tree reaches
     * for no global.
     */
    outcome: OutcomeClassifier;
    /**
     * Which transcript. A reader holds ONE at a time - its geometry,
     * body cache and expansions are all keyed to it, and a `line_no` can
     * numerically coincide across two files - so a parent changing this
     * should build a NEW reader (`{#key}`) rather than swap the prop.
     */
    transcriptId: number | string;
    /** Open at this line, or null for the first page. */
    lineNo?: number | null;
    /** Rows per request. The pager's label states it. */
    pageRows?: number;
    /** Rows kept rendered beyond each viewport edge. */
    overscan?: number;
    /**
     * THE FRAME SCHEDULER, and the third `app-screen` gap. A test passes
     * a synchronous one and drives paints by hand; jsdom fires no real
     * animation frame, so a reader reaching for the global would leave
     * its own measurement pass unmeasured in every test.
     */
    raf?: (fn: () => void) => unknown;
    /**
     * Render a non-renderable envelope. Supplied by the composition root
     * because `archive-outcome-view.js` is a later slice. When absent the
     * token and the transport reason are still stated, so a failure is
     * never a blank pane.
     */
    renderOutcome?: ((envelope: unknown) => Element | null) | null;
}
