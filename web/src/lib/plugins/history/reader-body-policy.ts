/**
 * THE READER'S BODY-REQUEST POLICY: which cache entry a row renders
 * with, which bodies the reader may fetch on its own, and what happens
 * when a person asks for one the auto path refused.
 *
 * Ported from `client/js/archive-reader-body.js`.
 *
 * WHY THIS IS ITS OWN FILE. `TranscriptReader.svelte` owns the
 * scroller, the frame loop and the click routing. This is the one part
 * of it that owns a POLICY rather than a mechanism, and the policy is
 * the security-relevant part: EVERY BODY THAT REACHES A ROW PASSES
 * THROUGH `entryFor`, which is what makes `reader-mask.ts`'s masking
 * unavoidable. Any future shortcut that renders a body WITHOUT going
 * through this file is a credential-disclosure path. It is much easier
 * to hold that invariant in a 120-line file than in a 500-line
 * component.
 *
 * FOUR CASES, NOT TWO. `entryFor` distinguishes cached, in flight,
 * refused by a gate, and NOT REQUESTED. The fourth is the one that
 * matters: a row outside the fetch window returns null and renders as a
 * sized placeholder, NEVER as a spinner, because a spinner that can
 * never resolve is a false "working on it" for a request nobody made.
 *
 * THE GATE IS EVALUATED BEFORE ANY NETWORK HAPPENS. `requestBodies`
 * auto-fetches ONLY the freely renderable class; a 54 MB body is never
 * pulled by scrolling past it. The hard gate is unreachable even from
 * the explicit path - `cache.request` refuses it whatever `force` says
 * - so `renderAnyway` can only ever lift a SOFT gate.
 *
 * No DOM, no framework.
 */
import { BODY_STATE } from './reader-vocab';
import { isRun, type ReaderItem, type SpineRow } from './reader-rows';
import type { BodyCache, BodyEntry } from './reader-body-cache';
import type { ReaderWindow } from './reader-virtual';

/** What the policy needs from the reader. */
export interface BodyPolicyContext {
    /** The body cache, or null when no client was supplied. */
    readonly cache: BodyCache | null;
    /** The current grouped items. A GETTER: regrouping reassigns them. */
    items(): readonly ReaderItem[];
    /** Queue one repaint. Called when a fetch settles. */
    schedule(): void;
}

/** The policy's public shape. */
export interface BodyPolicy {
    entryFor(item: ReaderItem | null | undefined): BodyEntry | null;
    requestBodies(win: ReaderWindow): void;
    renderAnyway(index: number): Promise<BodyEntry | null>;
}

/**
 * Whether an item can have a body at all.
 *
 * Description: its own function so the three callers below read the SAME
 *   rule. A run has no body of its own (its children do), and a row with
 *   a null `body_id` is the measured appearance-row shape.
 * Inputs: item - a reader item.
 * Output: true when the item names a body row.
 */
function hasBodyId(item: ReaderItem | null | undefined): item is SpineRow {
    if (!item || isRun(item)) return false;
    return item.body_id !== null && item.body_id !== undefined;
}

/**
 * Build the body-request policy for one reader instance.
 *
 * Inputs: ctx - the reader's cache and getters.
 * Output: a BodyPolicy.
 * Example:
 *   const policy = createBodyPolicy(ctx);
 *   const entry = policy.entryFor(item);   // may be null: not requested
 */
export function createBodyPolicy(ctx: BodyPolicyContext): BodyPolicy {
    /**
     * The cache entry a row should render with.
     *
     * Description: distinguishes all four cases - cached, in flight,
     *   refused by a gate, and NOT REQUESTED (null).
     * Inputs: item - a reader item.
     * Output: the entry, or null meaning nobody has asked.
     */
    function entryFor(item: ReaderItem | null | undefined): BodyEntry | null {
        const { cache } = ctx;
        if (!cache || !item || isRun(item)) return null;
        // A LINE WITH NO BODY ROW IS A MEASURED FACT, NOT A ROW NOBODY
        // ASKED ABOUT. The vanilla `entryFor` returned null here, which
        // renders the NOT REQUESTED placeholder - "not loaded yet" - and
        // that is a promise the reader cannot keep, because there is
        // nothing to load. It also made `STATE_NO_BODY` unreachable
        // through this path, even though `archive-line-render.js`
        // documents it as "a real, measured shape: an appearance row
        // with a null body_id. It is a fact about the file, not a
        // failure." Answering the gate's verdict is what the author
        // plainly intended; NAMED as a deliberate behaviour change.
        if (!hasBodyId(item)) {
            const verdict = cache.gateFor(item as SpineRow);
            return {
                state: verdict.state,
                text: null,
                chars: 0,
                masked: 0,
                reason: verdict.reason,
                findingCount: 0,
                bodyHref: null,
                gated: true,
            };
        }
        const hit = cache.get(item.body_id);
        if (hit) return hit;
        if (cache.isLoading(item.body_id)) {
            return {
                state: BODY_STATE.LOADING,
                text: null,
                chars: 0,
                masked: 0,
                reason: null,
                findingCount: 0,
                bodyHref: null,
            };
        }
        const gate = cache.gateFor(item);
        if (gate.state === BODY_STATE.OK) return null;
        return {
            state: gate.state,
            text: null,
            chars: 0,
            masked: 0,
            reason: gate.reason,
            findingCount: 0,
            bodyHref: typeof item.body_href === 'string' ? item.body_href : null,
            gated: true,
        };
    }

    /**
     * Ask the cache for the bodies in the render window, honouring the
     * gates.
     *
     * Description: NORMATIVE - `cache.request` evaluates the gate from
     *   the SPINE before any network happens, so a 54 MB body is never
     *   fetched by the auto path. The extra `gateFor` here is not
     *   redundant: it keeps the loop from even entering the request path
     *   for anything but the freely renderable class, so the gate-refusal
     *   counter measures explicit asks rather than every scroll.
     */
    function requestBodies(win: ReaderWindow): void {
        const { cache } = ctx;
        if (!cache) return;
        const items = ctx.items();
        for (let i = win.first; i <= win.last; i += 1) {
            const it = items[i];
            if (!hasBodyId(it)) continue;
            if (cache.get(it.body_id) || cache.isLoading(it.body_id)) continue;
            const gate = cache.gateFor(it);
            // Only the freely renderable class is auto-fetched.
            // Everything else waits for the reader to ask, or can never
            // be asked for at all.
            if (gate.state !== BODY_STATE.OK) continue;
            void cache.request(it).then(() => ctx.schedule());
        }
    }

    /**
     * Fetch a soft-gated body because the reader asked.
     *
     * Description: THE HARD GATE IS UNREACHABLE FROM HERE.
     *   `cache.request` refuses it whatever `force` says, so this can
     *   only ever lift a SOFT gate. That is why `force` is safe to wire
     *   to a button.
     * Inputs: index - the item index.
     * Output: the cache entry, or null when the item has no body.
     */
    function renderAnyway(index: number): Promise<BodyEntry | null> {
        const it = ctx.items()[index];
        if (!hasBodyId(it) || !ctx.cache) return Promise.resolve(null);
        return ctx.cache.request(it, true).then((e) => {
            ctx.schedule();
            return e;
        });
    }

    return { entryFor, requestBodies, renderAnyway };
}
