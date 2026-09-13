/**
 * The archive keyboard map. PORTED from `client/js/archive-keys.js`,
 * deleted in the same commit.
 *
 * ONE PURE FUNCTION DOES THE DECIDING. `resolve(event, context)` takes a
 * key event and the screen's current shape and returns an ACTION NAME or
 * null. It touches no DOM, dispatches nothing and reads no globals, so
 * every branch of the map is testable and the binding table is one thing
 * rather than a handler spread across five files.
 *
 * THE ESCAPE LADDER IS ORDERED, AND THE ORDER IS THE WHOLE POINT.
 * Escape means "back out of the innermost thing", and the innermost
 * thing is not always the same:
 *
 *   1. a modal is open        -> the modal owns it. This function
 *                                returns null and leaves it to
 *                                ModalStack, which already routes Escape
 *                                to the top overlay. Two owners for one
 *                                key is how a modal closes and the
 *                                screen behind it also navigates.
 *   2. the filter has text    -> clear the filter
 *   3. a search is showing    -> dismiss the search results
 *   4. on a narrow viewport   -> go back one pane
 *   5. otherwise              -> nothing. Escape does NOT leave the
 *                                archive screen, because an accidental
 *                                Escape throwing away a 3,416-row paging
 *                                position is a hostile default.
 *
 * A KEY IS NEVER CLAIMED WHILE A TEXT FIELD HAS FOCUS, except Escape and
 * Enter. `context.inTextField` is the CALLER'S MEASUREMENT, not a guess
 * made here: a single-letter binding that fires while somebody is typing
 * into the filter is the most common way a keyboard map becomes
 * something people turn off.
 *
 * THE HELP MODAL IS IN `./keys-help.ts` AND IS NOT RE-EXPORTED FROM
 * HERE, WHICH IS THE ONE SHAPE CHANGE IN THIS PORT. The vanilla file
 * carried an `openHelp` that reached `window.ArchiveKeysHelp` and threw
 * a named ReferenceError when the script had not loaded - a load-order
 * guard for a world of classic scripts that do not import each other.
 * Inside the bundle there is no load order to get wrong: `keys-help.ts`
 * is imported, so it is either there or the build failed. The guard
 * would be a branch that can no longer fire, which is worse than no
 * guard because a reader would believe it protects something. The seam
 * that publishes `window.ArchiveKeys` re-attaches `openHelp` for the
 * legacy callers that still hold that name; see
 * `../archive-state-install.ts`.
 */

/** One action this map can produce. */
export type ArchiveAction =
    | 'next-row' | 'prev-row' | 'open-row' | 'back-pane'
    | 'focus-filter' | 'focus-search' | 'clear-filter' | 'dismiss-search'
    | 'load-more' | 'open-export' | 'toggle-scheme' | 'toggle-view'
    | 'open-help';

/**
 * Every action this map can produce.
 *
 * Exported so the composition root binds against names rather than
 * string literals, and so a test can assert the set has not silently
 * grown.
 */
export const ACTIONS = {
    NEXT_ROW: 'next-row',
    PREV_ROW: 'prev-row',
    OPEN_ROW: 'open-row',
    BACK_PANE: 'back-pane',
    FOCUS_FILTER: 'focus-filter',
    FOCUS_SEARCH: 'focus-search',
    CLEAR_FILTER: 'clear-filter',
    DISMISS_SEARCH: 'dismiss-search',
    LOAD_MORE: 'load-more',
    OPEN_EXPORT: 'open-export',
    TOGGLE_SCHEME: 'toggle-scheme',
    TOGGLE_VIEW: 'toggle-view',
    OPEN_HELP: 'open-help',
} as const satisfies Record<string, ArchiveAction>;

/**
 * Single-character bindings, active only when no text field has focus.
 *
 * Kept as DATA rather than as a switch so the whole map is one readable
 * table and a duplicate binding is visible.
 */
export const PLAIN_KEYS: Readonly<Record<string, ArchiveAction>> = {
    'j': ACTIONS.NEXT_ROW,
    'k': ACTIONS.PREV_ROW,
    '/': ACTIONS.FOCUS_FILTER,
    's': ACTIONS.FOCUS_SEARCH,
    'm': ACTIONS.LOAD_MORE,
    'e': ACTIONS.OPEN_EXPORT,
    't': ACTIONS.TOGGLE_SCHEME,
    'v': ACTIONS.TOGGLE_VIEW,
    // '?' is Shift+/ and `event.key` reports the CHARACTER PRODUCED, so
    // the browser hands us a literal '?' while '/' arrives only
    // unshifted. Binding the character is the whole implementation: no
    // shiftKey branch, '/' still resolves to FOCUS_FILTER, and
    // hasCommandModifier already excludes Shift.
    '?': ACTIONS.OPEN_HELP,
};

/** Named keys, active regardless of the single-character rule. */
export const NAMED_KEYS: Readonly<Record<string, ArchiveAction>> = {
    'ArrowDown': ACTIONS.NEXT_ROW,
    'ArrowUp': ACTIONS.PREV_ROW,
    'Enter': ACTIONS.OPEN_ROW,
};

/** As much of a key event as this map reads. A literal works. */
export interface KeyLike {
    readonly key?: unknown;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly altKey?: boolean;
    /**
     * PRESENT AND DELIBERATELY NEVER CONSULTED. A real KeyboardEvent
     * always carries it, and `hasCommandModifier` deliberately leaves it
     * out of the modifier set: Shift+letter is still a letter, and
     * claiming it would break capitalised typing nowhere while blocking
     * nothing useful here. It is declared so a caller passing a real
     * event - or a test proving the field is ignored - is not refused by
     * the type for handing over a fact this map chooses not to use.
     */
    readonly shiftKey?: boolean;
}

/** The screen's current shape, as the caller measured it. */
export interface KeyContext {
    /** Focus is in an input or textarea. */
    readonly inTextField?: boolean;
    /** A modal is registered on top. */
    readonly modalOpen?: boolean;
    /** Current filter contents. */
    readonly filterText?: string;
    /** Search results are showing. */
    readonly searchOpen?: boolean;
    /** Viewport is below the one-pane breakpoint. */
    readonly narrow?: boolean;
    /** A previous pane exists. */
    readonly canGoBack?: boolean;
}

/**
 * Does this event carry a modifier meaning it belongs to the browser or
 * the OS rather than to this screen?
 *
 * Description: Shift is deliberately NOT in this set. Shift+letter is
 *   still a letter, and claiming it would break capitalised typing
 *   nowhere while blocking nothing useful here.
 * Inputs: event. Output: boolean.
 */
export function hasCommandModifier(event: KeyLike | null | undefined): boolean {
    return !!(event && (event.ctrlKey || event.metaKey || event.altKey));
}

/**
 * Resolve the Escape ladder.
 *
 * Description: separated out because its ORDER is the contract and it
 *   deserves to be read in one place.
 * Inputs: context - see `resolve`.
 * Output: an action, or null when Escape belongs to something else (a
 *   modal) or means nothing here.
 */
export function resolveEscape(context: KeyContext | null | undefined): ArchiveAction | null {
    const c = context || {};
    // Rung 1. A modal owns Escape outright. Returning an action here
    // would close the modal AND navigate the screen behind it.
    if (c.modalOpen) return null;
    if (c.filterText) return ACTIONS.CLEAR_FILTER;
    if (c.searchOpen) return ACTIONS.DISMISS_SEARCH;
    if (c.narrow && c.canGoBack) return ACTIONS.BACK_PANE;
    // Rung 5. Deliberately nothing. Escape does not leave the screen.
    return null;
}

/**
 * Map one key event to an action name.
 *
 * Inputs: event - a real KeyboardEvent works; so does a literal.
 *   context - the screen's shape, measured by the caller.
 * Output: an action, or null when this map claims nothing. NULL IS A
 *   REAL ANSWER: it means the key belongs to the browser, to a text
 *   field, or to a modal, and swallowing it would be a bug rather than a
 *   no-op.
 * Example: resolve({key: 'j'}, {})                      // 'next-row'
 *          resolve({key: 'j'}, {inTextField: true})     // null
 *          resolve({key: 'Escape'}, {modalOpen: true})  // null
 */
export function resolve(
    event: KeyLike | null | undefined, context: KeyContext | null | undefined,
): ArchiveAction | null {
    const e = event || {};
    const c = context || {};
    const key = e.key;
    if (typeof key !== 'string' || !key) return null;

    if (key === 'Escape') return resolveEscape(c);

    // A modal that is open owns every key except Escape, which the
    // branch above already handed to it. Claiming j/k under a modal
    // scrolls the list underneath while somebody reads a dialog.
    if (c.modalOpen) return null;

    if (hasCommandModifier(e)) return null;

    // Enter inside a text field submits that field; the composition root
    // decides what that means for the filter or the search box, and this
    // map does not second-guess it.
    if (key === 'Enter') {
        return c.inTextField ? null : ACTIONS.OPEN_ROW;
    }

    // Arrows work while typing: moving a selection is not typing, and a
    // person filtering a list expects to arrow into the results without
    // leaving the field.
    if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) {
        return NAMED_KEYS[key]!;
    }

    if (c.inTextField) return null;

    if (Object.prototype.hasOwnProperty.call(PLAIN_KEYS, key)) {
        return PLAIN_KEYS[key]!;
    }
    return null;
}

/** One row of the human-readable binding table. */
export interface Binding {
    readonly keys: string;
    readonly action: ArchiveAction;
    readonly note: string;
}

/**
 * The human-readable binding table, for the help panel and for a test
 * that asserts every action is reachable.
 *
 * Description: THE HELP PANEL RENDERS THIS AND HOLDS NO LIST OF ITS OWN.
 *   A help panel that lies is worse than no help panel, and two tables
 *   always drift.
 * Inputs: none. Output: the bindings, in display order.
 */
export function bindings(): readonly Binding[] {
    return [
        { keys: 'j / ArrowDown', action: ACTIONS.NEXT_ROW, note: 'next row' },
        { keys: 'k / ArrowUp', action: ACTIONS.PREV_ROW, note: 'previous row' },
        { keys: 'Enter', action: ACTIONS.OPEN_ROW, note: 'open the selected row' },
        { keys: '/', action: ACTIONS.FOCUS_FILTER, note: 'focus the filter' },
        { keys: 's', action: ACTIONS.FOCUS_SEARCH, note: 'focus the search box' },
        { keys: 'm', action: ACTIONS.LOAD_MORE, note: 'load the next page' },
        { keys: 'e', action: ACTIONS.OPEN_EXPORT, note: 'open the export modal' },
        { keys: 't', action: ACTIONS.TOGGLE_SCHEME, note: 'cycle the scheme split' },
        { keys: 'v', action: ACTIONS.TOGGLE_VIEW, note: 'conversation view / raw view' },
        { keys: '?', action: ACTIONS.OPEN_HELP, note: 'show this key list' },
        { keys: 'Escape', action: ACTIONS.CLEAR_FILTER,
          note: 'clear the filter, then dismiss search, then go back one pane' },
    ];
}

/**
 * The index meaning "nothing is selected" - a real state with its own
 * behaviour in `move`, not merely a sentinel for "empty".
 */
const NOTHING_SELECTED = -1;

/** A pure index cursor over a virtualized list. */
export interface Selection {
    /** How many rows the cursor indexes. */
    count(): number;
    /**
     * Tell the cursor how many rows exist now. GROWING PRESERVES THE
     * INDEX - paging appends rows and must not move a selection.
     */
    setCount(n: unknown): void;
    /** The selected index, -1 when none. */
    index(): number;
    /** Select an index; out of range clamps, negative clears. */
    select(i: unknown): number;
    /** Move by delta and return where it landed. */
    move(delta: unknown): number;
    /** Whether anything is selected. */
    has(): boolean;
}

/**
 * Build a PURE index cursor for a virtualized list.
 *
 * Description: it holds a COUNT and an INDEX and no rows whatsoever,
 *   which is what makes a selection survive its row scrolling out of the
 *   render window: there is no element for the cursor to lose. No DOM,
 *   no globals, no reference to the data it indexes.
 * Inputs: none. Output: Selection.
 * Example: sel.setCount(3); sel.move(-1)   // -> 2, k on a fresh list
 *          selects the END. sel.setCount(9) leaves the index at 2,
 *          because paging appended rows and must not move a selection.
 */
export function createSelection(): Selection {
    let count = 0;
    let index = NOTHING_SELECTED;

    /**
     * Coerce a caller-supplied number, treating anything non-finite as 0
     * rather than letting NaN poison the cursor.
     */
    function toInt(value: unknown): number {
        const n = Number(value);
        return isFinite(n) ? (n < 0 ? Math.ceil(n) : Math.floor(n)) : 0;
    }

    /**
     * The MOVEMENT clamp: into [0, count-1], or NOTHING_SELECTED when
     * the list is empty. A negative lands on 0, because moving up past
     * the first row means "stay there".
     */
    function clampIntoRange(i: number): number {
        if (count <= 0) return NOTHING_SELECTED;
        if (i < 0) return 0;
        if (i >= count) return count - 1;
        return i;
    }

    /**
     * The SELECTION clamp: clampIntoRange except that a negative is an
     * explicit clear, `select(-1)` being the documented way to select
     * nothing. The two genuinely differ, so they are two functions
     * rather than one with a flag.
     */
    function clampOrClear(i: number): number {
        if (i < 0) return NOTHING_SELECTED;
        return clampIntoRange(i);
    }

    return {
        count: () => count,

        setCount(n: unknown): void {
            const next = toInt(n);
            count = next > 0 ? next : 0;
            if (count === 0) {
                index = NOTHING_SELECTED;
            } else if (index >= count) {
                index = count - 1;
            }
            // NOTHING_SELECTED stays: a list that gains rows from empty
            // has still had nothing selected.
        },

        index: () => index,

        select(i: unknown): number {
            index = clampOrClear(toInt(i));
            return index;
        },

        /**
         * From NOTHING_SELECTED a POSITIVE delta selects the first row
         * and a NEGATIVE delta selects the LAST, so k on a fresh list
         * selects the end rather than doing nothing. Clamps at both
         * ends: NO wraparound, because wrapping from the last line of a
         * 30,805-line transcript to the first is a hostile surprise.
         */
        move(delta: unknown): number {
            const d = toInt(delta);
            if (count <= 0) return (index = NOTHING_SELECTED);
            if (d === 0) return index;
            if (index === NOTHING_SELECTED) {
                index = d > 0 ? 0 : count - 1;
                return index;
            }
            index = clampIntoRange(index + d);
            return index;
        },

        has: () => index !== NOTHING_SELECTED,
    };
}
