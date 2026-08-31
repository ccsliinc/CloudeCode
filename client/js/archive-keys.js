/**
 * Archive keyboard map.
 *
 * ONE PURE FUNCTION DOES THE DECIDING. `resolve(event, context)` takes a
 * key event and the screen's current shape and returns an ACTION NAME or
 * null. It touches no DOM, dispatches nothing and reads no globals, so
 * every branch of the map is testable under plain Node and the binding
 * table is one thing rather than a handler spread across five files.
 *
 * THE ESCAPE LADDER IS ORDERED, AND THE ORDER IS THE WHOLE POINT.
 * Escape means "back out of the innermost thing", and the innermost
 * thing is not always the same:
 *
 *   1. a modal is open        -> the modal owns it. This function
 *                                returns null and leaves it to
 *                                modal-stack.js, which already routes
 *                                Escape to the top overlay. Two owners
 *                                for one key is how a modal closes and
 *                                the screen behind it also navigates.
 *   2. the filter has text    -> clear the filter
 *   3. a search is showing    -> dismiss the search results
 *   4. on a narrow viewport   -> go back one pane
 *   5. otherwise              -> nothing. Escape does NOT leave the
 *                                archive screen, because an accidental
 *                                Escape throwing away a 3,416-row
 *                                paging position is a hostile default.
 *
 * A KEY IS NEVER CLAIMED WHILE A TEXT FIELD HAS FOCUS, except Escape and
 * Enter. `context.inTextField` is the caller's measurement, not a guess
 * made here: a single-letter binding that fires while somebody is typing
 * into the filter is the most common way a keyboard map becomes
 * something people turn off.
 *
 * Pure. No DOM, no globals beyond the export.
 */

console.log('[ArchiveKeys Module] Loading...');

(function () {
    'use strict';

    /**
     * Every action this map can produce. Exported so the composition
     * root binds against names rather than string literals, and so a
     * test can assert the set has not silently grown.
     * @type {Object<string,string>}
     */
    var ACTIONS = {
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
        TOGGLE_SCHEME: 'toggle-scheme'
    };

    /**
     * Single-character bindings, active only when no text field has
     * focus. Kept as data rather than as a switch so the whole map is
     * one readable table and a duplicate binding is visible.
     * @type {Object<string,string>}
     */
    var PLAIN_KEYS = {
        'j': ACTIONS.NEXT_ROW,
        'k': ACTIONS.PREV_ROW,
        '/': ACTIONS.FOCUS_FILTER,
        's': ACTIONS.FOCUS_SEARCH,
        'm': ACTIONS.LOAD_MORE,
        'e': ACTIONS.OPEN_EXPORT,
        't': ACTIONS.TOGGLE_SCHEME
    };

    /**
     * Named keys, active regardless of the single-character rule where
     * noted in resolve().
     * @type {Object<string,string>}
     */
    var NAMED_KEYS = {
        'ArrowDown': ACTIONS.NEXT_ROW,
        'ArrowUp': ACTIONS.PREV_ROW,
        'Enter': ACTIONS.OPEN_ROW
    };

    /**
     * Description: whether an event carries a modifier that means it
     *   belongs to the browser or the OS rather than to this screen.
     *   Shift is deliberately NOT in this set: Shift+letter is still a
     *   letter, and claiming it would break capitalised typing nowhere
     *   while blocking nothing useful here.
     * Inputs: event (object) - {ctrlKey, metaKey, altKey}.
     * Output: boolean.
     */
    function hasCommandModifier(event) {
        return !!(event && (event.ctrlKey || event.metaKey || event.altKey));
    }

    /**
     * Description: resolve the Escape ladder. Separated out because its
     *   ORDER is the contract and it deserves to be read in one place.
     * Inputs: context (object) - see resolve().
     * Output: string|null - an ACTIONS value, or null when Escape
     *   belongs to something else (a modal) or means nothing here.
     */
    function resolveEscape(context) {
        var c = context || {};
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
     * Description: map one key event to an action name.
     * Inputs: event (object) - {key, ctrlKey, metaKey, altKey}. A real
     *           KeyboardEvent works; so does a literal, which is what
     *           the tests pass.
     *         context (object) -
     *           inTextField (boolean) - focus is in an input/textarea.
     *           modalOpen (boolean)   - a modal is registered on top.
     *           filterText (string)   - current filter contents.
     *           searchOpen (boolean)  - search results are showing.
     *           narrow (boolean)      - viewport is below the one-pane
     *                                   breakpoint.
     *           canGoBack (boolean)   - a previous pane exists.
     * Output: string|null - an ACTIONS value, or null when this map
     *   claims nothing. Null is a real answer: it means the key belongs
     *   to the browser, to a text field, or to a modal, and swallowing
     *   it would be a bug rather than a no-op.
     * Example:
     *   resolve({key: 'j'}, {})                       // -> 'next-row'
     *   resolve({key: 'j'}, {inTextField: true})      // -> null
     *   resolve({key: 'Escape'}, {modalOpen: true})   // -> null
     */
    function resolve(event, context) {
        var e = event || {};
        var c = context || {};
        var key = e.key;
        if (typeof key !== 'string' || !key) return null;

        if (key === 'Escape') return resolveEscape(c);

        // A modal that is open owns every key except Escape, which the
        // branch above already handed to it. Claiming j/k under a modal
        // scrolls the list underneath while somebody reads a dialog.
        if (c.modalOpen) return null;

        if (hasCommandModifier(e)) return null;

        // Enter inside a text field submits that field; the composition
        // root decides what that means for the filter or the search box,
        // and this map does not second-guess it.
        if (key === 'Enter') {
            return c.inTextField ? null : ACTIONS.OPEN_ROW;
        }

        // Arrows work while typing: moving a selection is not typing,
        // and a person filtering a list expects to arrow into the
        // results without leaving the field.
        if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) {
            return NAMED_KEYS[key];
        }

        if (c.inTextField) return null;

        if (Object.prototype.hasOwnProperty.call(PLAIN_KEYS, key)) {
            return PLAIN_KEYS[key];
        }
        return null;
    }

    /**
     * Description: the human-readable binding table, for a help panel or
     *   a test that asserts every action is reachable.
     * Inputs: none.
     * Output: Array<{keys: string, action: string, note: string}>
     */
    function bindings() {
        return [
            { keys: 'j / ArrowDown', action: ACTIONS.NEXT_ROW, note: 'next row' },
            { keys: 'k / ArrowUp', action: ACTIONS.PREV_ROW, note: 'previous row' },
            { keys: 'Enter', action: ACTIONS.OPEN_ROW, note: 'open the selected row' },
            { keys: '/', action: ACTIONS.FOCUS_FILTER, note: 'focus the filter' },
            { keys: 's', action: ACTIONS.FOCUS_SEARCH, note: 'focus the search box' },
            { keys: 'm', action: ACTIONS.LOAD_MORE, note: 'load the next page' },
            { keys: 'e', action: ACTIONS.OPEN_EXPORT, note: 'open the export modal' },
            { keys: 't', action: ACTIONS.TOGGLE_SCHEME, note: 'cycle the scheme split' },
            { keys: 'Escape', action: ACTIONS.CLEAR_FILTER,
              note: 'clear the filter, then dismiss search, then go back one pane' }
        ];
    }

    window.ArchiveKeys = {
        resolve: resolve,
        resolveEscape: resolveEscape,
        bindings: bindings,
        hasCommandModifier: hasCommandModifier,
        ACTIONS: ACTIONS,
        PLAIN_KEYS: PLAIN_KEYS,
        NAMED_KEYS: NAMED_KEYS
    };
    console.log('[ArchiveKeys Module] Exported as window.ArchiveKeys');
})();
