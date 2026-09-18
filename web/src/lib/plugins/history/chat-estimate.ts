/**
 * HEIGHT GUESSES FOR CHAT BUBBLES, before any of them have been drawn.
 *
 * Ported from `client/js/archive-chat-estimate.js`, constant for
 * constant. It feeds slice 7's `createList` - the SAME geometry engine
 * the raw reader uses - as its `estimate` callback.
 *
 * WHY SLICE 7's `estimateHeight` COULD NOT BE REUSED. A raw line is one
 * monospace blob whose height is a function of one number, `body_chars`.
 * A chat turn is a header, plus N blocks each with its own disclosure
 * state, plus optionally an envelope panel and a subagent list. Two
 * turns with identical character counts differ by hundreds of pixels
 * depending on how many of those characters are inside a collapsed
 * `<details>`. Feeding chat turns to `estimateHeight` would produce a
 * scrollbar wrong by an order of magnitude on any tool-heavy transcript,
 * and the anti-jump compensation would spend the whole scroll paying off
 * that error.
 *
 * WHAT IS LOAD-BEARING HERE AND WHAT IS NOT, because the distinction
 * matters and it is easy to overthink this file:
 *
 *   LOAD-BEARING (1): THE CAP. The corpus holds a single line of 37 MB.
 *   At one pixel per wrapped line that is roughly three million pixels
 *   for ONE row, which makes every other row in the transcript
 *   unreachable by dragging the scrollbar because the thumb resolves to
 *   nothing. `TURN_MAX_PX` is what stops a pathological row eating the
 *   whole document's geometry.
 *
 *   LOAD-BEARING (2): THE OPEN-PANEL TERMS. A bubble's height CHANGES
 *   when somebody clicks, unlike a raw line's. `ChatView` re-estimates
 *   that one row before the repaint, so the growth is accounted for in
 *   the same frame it appears; without the panel terms below there would
 *   be nothing to re-estimate WITH, and opening a panel above the
 *   viewport shoves the content under the reader's eyes down by the
 *   panel's height.
 *
 *   NOT LOAD-BEARING: THE PARTICULAR PIXEL NUMBERS. `createList`
 *   measures every row it actually paints and pays the delta owed by
 *   rows above the viewport in the SAME frame, so an estimate's job is
 *   only to be (a) finite, (b) positive and (c) not so far off that the
 *   scrollbar thumb is a lie before you have scrolled anywhere.
 *   Precision beyond that buys nothing, because the measurement
 *   supersedes it the moment the row is on screen.
 *
 * NO DOM. Pure arithmetic over the turn shape.
 */
import { COLLAPSED_BY_DEFAULT } from './chat-vocab';
import { textState, TEXT_STATE, type ChatBlockRaw } from './chat-mask';
import { isRun, type ChatItem, type OpenState } from './chat-turn';

/** Header strip: speaker, time, model, the two buttons. Pixels. */
export const TURN_CHROME_PX = 46;

/**
 * Characters on one wrapped line of PROSE at the reader's measure.
 *
 * Description: wider than the raw reader's 96 because this text is
 *   proportional and the column is not gutter-indented.
 */
export const CHARS_PER_LINE = 110;

/** Rendered line box for prose. Pixels. */
export const LINE_HEIGHT_PX = 21;

/** A block rendering only its `<summary>` until opened. Pixels. */
export const COLLAPSED_BLOCK_PX = 28;

/** A block withheld or unevaluated: three short lines of stated reason. */
export const STATED_BLOCK_PX = 66;

/** Ceiling for one turn's CONTENT before it is measured. Pixels. */
export const TURN_MAX_PX = 420;

/** The collapsed progress chip, which is a single control. Pixels. */
export const PROGRESS_ROW_PX = 30;

/** The envelope panel, open: nineteen definition rows and three headings. */
export const INFO_PANEL_PX = 380;

/** One subagent row in the expanded list. Pixels. */
export const SUBAGENT_ROW_PX = 38;

/** The subagent list's own heading line. Pixels. */
export const SUBAGENT_HEAD_PX = 40;

/**
 * Pixels for one content block, given how this view will render it.
 *
 * Description: a COLLAPSED block costs its summary line and nothing
 *   more, however enormous its payload. This is the single biggest
 *   source of error in a naive character-count estimate: a 200 KB tool
 *   result is 28 pixels tall until somebody opens it.
 * Inputs: block.
 * Output: pixels, always finite and positive.
 * Example: blockHeight({type: 'tool_use', text_length: 9000}) // -> 28
 */
export function blockHeight(block: ChatBlockRaw | null | undefined): number {
    if (!block || typeof block !== 'object') return STATED_BLOCK_PX;
    if (COLLAPSED_BY_DEFAULT[String(block.type)] === true) return COLLAPSED_BLOCK_PX;
    if (textState(block) !== TEXT_STATE.INCLUDED) return STATED_BLOCK_PX;
    // `text_length` ONLY, NEVER THE TEXT ITSELF. This server always
    // sends the full projected length beside a preview, and reading the
    // string here would put a second `.text` reader in the chat family -
    // which is what makes "only `chat-mask.ts` touches a block's text" a
    // grep rather than a promise. An unreadable length estimates as one
    // line, which the measurement pass corrects on the next frame.
    const n = Number.isFinite(block.text_length) && (block.text_length as number) >= 0
        ? block.text_length as number : 0;
    const lines = Math.max(1, Math.ceil(n / CHARS_PER_LINE));
    return COLLAPSED_BLOCK_PX + LINE_HEIGHT_PX * lines;
}

/**
 * Pixels for one laid-out item, before it is drawn.
 *
 * Description: the open panels are part of the geometry, so a turn whose
 *   "i" is open is estimated taller rather than being corrected by a
 *   jump on the next frame. THE CAP APPLIES TO THE CONTENT, BEFORE the
 *   panels are added: a panel the reader deliberately opened must not be
 *   squeezed out of the estimate by a huge block above it, because the
 *   whole point of the cap is that UNOPENED content does not dominate.
 * Inputs: item - a turn or a folded progress run. open - which panels
 *   are open on that row, or null.
 * Output: pixels, always finite and at least TURN_CHROME_PX.
 * Example: estimateItem({role: 'user', blocks: [{type: 'text',
 *   text_length: 220}]}, null) // -> 46 + 28 + 21*2 = 116
 */
export function estimateItem(
    item: ChatItem | null | undefined, open: OpenState | null,
): number {
    if (!item || typeof item !== 'object') return TURN_CHROME_PX;
    if (isRun(item)) return PROGRESS_ROW_PX;
    const s = open || {};

    let h = TURN_CHROME_PX;
    const blocks = item.blocks;
    if (!Array.isArray(blocks)) {
        // A could-not-evaluate renders a stated sentence, taller than a
        // line of prose and shorter than a payload.
        h += STATED_BLOCK_PX * 2;
    } else if (blocks.length === 0) {
        h += STATED_BLOCK_PX;
    } else {
        for (const b of blocks as ChatBlockRaw[]) h += blockHeight(b);
    }

    if (h > TURN_MAX_PX) h = TURN_MAX_PX;

    if (s.infoOpen) h += INFO_PANEL_PX;
    if (s.subOpen) {
        const subs = Array.isArray(item.subagents) ? (item.subagents as unknown[]).length : 0;
        h += SUBAGENT_HEAD_PX + SUBAGENT_ROW_PX * (subs > 0 ? subs : 2);
    }
    return h;
}

/**
 * An estimator bound to a list of items and a per-row open state, in the
 * shape `createList` wants.
 *
 * Description: built as a closure because `setCount` calls
 *   `estimate(index)` and nothing else.
 * Inputs: items, openAt - the open panels of one row, or null.
 * Output: a function of index.
 * Example: list.setCount(n, estimator(items, openAt))
 */
export function estimator(
    items: readonly ChatItem[],
    openAt: (index: number) => OpenState | null,
): (index: number) => number {
    return (index: number) => estimateItem(
        items ? items[index] : null,
        typeof openAt === 'function' ? openAt(index) : null,
    );
}
