/**
 * THE ONE CLICK ROUTER. Rows emit an action NAME and an index and decide
 * nothing; everything an action DOES is here.
 *
 * Ported from the delegated listener in
 * `client/js/archive-reader-dom.js`, which put it in its own file for
 * the same reason: rows are recycled on every scroll, so a listener
 * bound to one would leak and go stale within a frame. The Svelte port
 * does not need event delegation - a keyed `{#each}` moves nodes rather
 * than rebuilding them, and a handler travels with its row - but the
 * ROUTING still belongs in one place, because "which action does what"
 * is a policy and a template full of inline handlers is where a hard
 * gate quietly acquires a render.
 *
 * TWO INDEPENDENT REFUSALS GUARD THE HARD GATE, and this file is neither
 * of them. `RENDER_ANYWAY` does not EXIST in a hard-gated row's subtree
 * (`reader-rows.ts`'s action table) AND `cache.request` refuses that
 * body whatever `force` says (`reader-gate.forbidsFetch`). This router
 * would honour a `render-anyway` it was handed; it is never handed one,
 * and it is not the thing that makes that true. Relying on a router to
 * be the gate is how a gate ends up one refactor from being open.
 *
 * No DOM, no framework.
 */
import { ACTIONS } from './reader-vocab';
import type { ReaderItem } from './reader-rows';
import type { BodyEntry } from './reader-body-cache';

/** What the router needs from the reader. */
export interface ActionContext {
    /** Toggle one progress run. */
    setProgressExpanded(index: number, on: boolean): void;
    /** Fetch a soft-gated body because the reader asked. */
    renderAnyway(index: number): Promise<unknown>;
    /** The cache entry a row renders with, or null. */
    entryFor(item: ReaderItem | null | undefined): BodyEntry | null;
    /** The current grouped items. A GETTER: regrouping reassigns them. */
    items(): readonly ReaderItem[];
    /** Queue one repaint. */
    schedule(): void;
    /** Hand a body's download href to whoever owns downloads. */
    download(href: string): void;
}

/**
 * Build the click router for one reader instance.
 *
 * Description: an UNRECOGNISED action is ignored rather than guessed at,
 *   which matches the vanilla listener: it answered three action names
 *   and returned on anything else. Guessing would run somebody else's
 *   verb on a row they did not press.
 * Inputs: ctx - the reader's verbs and getters.
 * Output: the router, taking an action name and an item index.
 * Example: const run = createActionRouter(ctx); run('expand-progress', 4);
 */
export function createActionRouter(
    ctx: ActionContext,
): (action: string, index: number) => void {
    return function run(action: string, index: number): void {
        if (action === ACTIONS.EXPAND) {
            ctx.setProgressExpanded(index, true);
            return;
        }
        if (action === ACTIONS.COLLAPSE) {
            ctx.setProgressExpanded(index, false);
            return;
        }
        if (action === ACTIONS.RENDER_ANYWAY || action === ACTIONS.RETRY_BODY) {
            // BOTH LAND ON THE SAME VERB, and that is correct rather than
            // lazy: `render-anyway` lifts a SOFT gate and `retry-body`
            // re-asks after a refusal, and in both cases the honest
            // request is "fetch this body because a person asked". The
            // gate decides what that means; this does not.
            void ctx.renderAnyway(index).then(() => ctx.schedule());
            return;
        }
        if (action === ACTIONS.DOWNLOAD_BODY) {
            const entry = ctx.entryFor(ctx.items()[index]);
            // NO HREF, NO DOWNLOAD. A row whose entry carries none is a
            // body the server never offered a link for, and inventing a
            // URL for it would be a guess about somebody else's route.
            if (entry && entry.bodyHref) ctx.download(entry.bodyHref);
        }
    };
}
