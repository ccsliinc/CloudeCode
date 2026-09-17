/**
 * THE READER'S SELECTION API: the four verbs that move, read and act on
 * the reader's selection cursor.
 *
 * Ported from `client/js/archive-reader-select.js`, and split out for
 * the reason that file gives: the cursor itself lives in `keys.ts`
 * (`createSelection`), which owns a COUNT and an INDEX and nothing else;
 * the component owns the scroller. Neither owns the JOIN between them -
 * "move the cursor AND keep the selected row on screen AND repaint" -
 * and that join is what this file is. Keeping it out of the component
 * also keeps the component under this project's 500-line guideline
 * without inventing a seam: every function here reads the cursor and
 * writes the scroller, and nothing else in the reader does both.
 *
 * THE SELECTION IS A PURE INDEX CURSOR, never an element. That is what
 * lets it survive its own row being unmounted by the virtual window,
 * which happens constantly - rows leave the DOM on every scroll. A
 * selection holding an element would go stale within one frame.
 *
 * NOTHING_SELECTED (-1) IS A THIRD OUTCOME, not a failure and not a row.
 * Every function here returns it rather than throwing or returning 0,
 * because "no row is selected" and "row zero is selected" are different
 * findings and a caller must be able to tell them apart.
 *
 * No DOM of its own: it is handed the scroller and the geometry engine.
 */
import { scrollRowIntoView } from './reader-measure.svelte';
import { isRun, type ReaderItem } from './reader-rows';
import type { Selection } from './keys';
import type { VirtualList } from './reader-virtual';

/** The selection cursor's value for "nothing". */
export const NOTHING_SELECTED = -1;

/** What the selection API needs from the reader. All getters; see below. */
export interface SelectionContext {
    /** The cursor from `keys.ts::createSelection`. */
    readonly selection: Selection;
    /** The geometry engine this reader owns. */
    readonly list: VirtualList;
    /**
     * The scroller element, or null before it is bound.
     *
     * A GETTER precisely because the element does not exist when this
     * factory runs.
     */
    scroller(): Element | null;
    /** The scroller's usable height. */
    viewportHeight(): number;
    /** The current grouped items. A GETTER: regrouping reassigns them. */
    items(): readonly ReaderItem[];
    /** Whether the item at `index` is an EXPANDED progress run. */
    isExpandedAt(index: number): boolean;
    /** Toggle one progress run. */
    setProgressExpanded(index: number, on: boolean): void;
    /** Fetch a soft-gated body because the reader asked. */
    renderAnyway(index: number): Promise<unknown>;
    /** Publish the new index, so the row paints as selected. */
    publish(index: number): void;
}

/** The selection API's public shape. */
export interface SelectionApi {
    selectedIndex(): number;
    moveSelection(delta: number): number;
    selectIndex(index: number): number;
    openSelected(): Promise<unknown>;
}

/**
 * Build the selection API for one reader instance.
 *
 * Inputs: ctx - the reader's cursor, geometry and getters.
 * Output: a SelectionApi.
 * Example:
 *   const sel = createSelectionApi(ctx);
 *   sel.moveSelection(1);   // the `j` key
 */
export function createSelectionApi(ctx: SelectionContext): SelectionApi {
    /** The selected item index, or NOTHING_SELECTED. */
    function selectedIndex(): number {
        return ctx.selection ? ctx.selection.index() : NOTHING_SELECTED;
    }

    /** Reveal the row at `i` and publish it. Shared by both movers. */
    function land(i: number): number {
        ctx.publish(i);
        scrollRowIntoView(ctx.list, ctx.scroller(), i, ctx.viewportHeight());
        return i;
    }

    /**
     * Move the selection cursor and keep the selected row in view.
     * Inputs: delta - rows; negative moves up.
     * Output: the new index, or NOTHING_SELECTED.
     */
    function moveSelection(delta: number): number {
        if (!ctx.selection) return NOTHING_SELECTED;
        return land(ctx.selection.move(delta));
    }

    /**
     * Select one row outright. `selectIndex(-1)` CLEARS the selection,
     * which is a documented third outcome rather than row zero.
     * Inputs: index. Output: the new index.
     */
    function selectIndex(index: number): number {
        if (!ctx.selection) return NOTHING_SELECTED;
        return land(ctx.selection.select(index));
    }

    /**
     * Open the selected row.
     *
     * Description: a progress run TOGGLES - Enter on a collapsed run is
     *   unambiguously "show me this" - and anything else goes through
     *   `renderAnyway`, the existing "open this row" verb. NOTHING
     *   SELECTED resolves null rather than acting on row zero.
     * Output: the cache entry, or null.
     */
    function openSelected(): Promise<unknown> {
        const i = selectedIndex();
        const it = i >= 0 ? ctx.items()[i] : null;
        if (!it) return Promise.resolve(null);
        if (isRun(it)) {
            ctx.setProgressExpanded(i, !ctx.isExpandedAt(i));
            return Promise.resolve(null);
        }
        return ctx.renderAnyway(i);
    }

    return { selectedIndex, moveSelection, selectIndex, openSelected };
}
