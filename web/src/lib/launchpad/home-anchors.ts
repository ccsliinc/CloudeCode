/**
 * The four ids outside code addresses on this screen, written down.
 *
 * THEY ARE ANCHORS, NOT IMPLEMENTATION DETAIL, and the whole of slice 7's
 * risk is concentrated in them. Three legacy surfaces reach into the home
 * screen's DOM by id, and none of them can import anything from this
 * tree:
 *
 *   - `client/js/app.js` toggles `.active` on `#launchpad-screen`.
 *     That element stays in `client/index.html` and is the MOUNT TARGET,
 *     so the shell never renders it and never touches its classes.
 *   - `client/js/app.js` RE-PARENTS the one `#statusText` node into
 *     `#home-bar-status`, so the dot is moved rather than copied and the
 *     string keeps exactly one author.
 *   - `client/js/app.js` writes `#home-bar-status-text` from that node's
 *     `data-status`, through a MutationObserver, so the label cannot go
 *     stale.
 *   - `client/js/globalAudioToggle.js` inserts its one button as
 *     `#home-bar-status`'s SIBLING, which makes `.home-bar` a
 *     load-bearing parent as well.
 *
 * THE RE-PARENTING IS LEFT EXACTLY AS IT IS. Section 6 of the migration
 * plan asks slice 7 to give both surfaces a named anchor in the Svelte
 * home bar and leave them re-parenting into it - explicitly NOT to invent
 * a message bus for them. A bus would be a second way for one component
 * to change another's DOM, dressed up; an anchor is the contract stated
 * out loud.
 *
 * WHAT THIS COSTS THE SHELL: every one of these nodes must be STATIC
 * markup in `HomeScreen.svelte`. A `{#if}` or a keyed `{#each}` over them
 * would re-create the node and silently drop whatever had been moved in,
 * and the symptom - a status light that vanishes on the second visit to
 * the home screen - looks nothing like its cause.
 */

/**
 * The mount target. NOT rendered by the shell: it is in
 * `client/index.html` and `app.js` toggles `.active` on it.
 */
export const SCREEN_ID = 'launchpad-screen';

/** Where `App._placeStatusLight` moves `#statusText`. */
export const STATUS_ANCHOR_ID = 'home-bar-status';

/** What `App._syncStatusLabel` writes the status string into. */
export const STATUS_LABEL_ID = 'home-bar-status-text';

/** The bar itself, which `GlobalAudioToggle.place` inserts into. */
export const HOME_BAR_CLASS = 'home-bar';

/**
 * Every id an outside surface addresses, as one list.
 *
 * Description: a list rather than four constants used separately,
 *   because the guard that matters is "are they ALL still there" and a
 *   guard has to be able to iterate. `HomeScreen.behaviour.test.ts`
 *   removes one of these and asserts the check goes red.
 */
export const HOME_ANCHOR_IDS: readonly string[] = [
    SCREEN_ID,
    STATUS_ANCHOR_ID,
    STATUS_LABEL_ID,
];

/**
 * Which anchors are present in a document.
 *
 * Description: reports the MISSING ones rather than a bare boolean, so a
 *   failure names what to go and look for. `#launchpad-screen` is
 *   included even though the shell does not render it: a shell mounted
 *   somewhere else entirely would still satisfy every other id, and
 *   that is exactly the regression worth catching.
 * Inputs: doc - the document to look in.
 * Output: the ids that are absent. Empty means every anchor is present.
 * Example: missingHomeAnchors(document)   // []
 */
export function missingHomeAnchors(doc: Document | null | undefined): string[] {
    if (!doc) return [...HOME_ANCHOR_IDS];
    return HOME_ANCHOR_IDS.filter((id) => !doc.getElementById(id));
}

/**
 * Whether the home bar is a real, re-parentable element.
 *
 * Description: the audio toggle inserts BEFORE `#home-bar-status` into
 *   that span's own parent, so the check is that the anchor has one and
 *   that it carries the bar's class. A detached anchor would pass a bare
 *   `getElementById` and still lose the button.
 * Inputs: doc. Output: boolean.
 * Example: homeBarIsReparentable(document)   // true
 */
export function homeBarIsReparentable(doc: Document | null | undefined): boolean {
    const anchor = doc?.getElementById(STATUS_ANCHOR_ID);
    const parent = anchor?.parentElement;
    return !!parent && parent.classList.contains(HOME_BAR_CLASS);
}
