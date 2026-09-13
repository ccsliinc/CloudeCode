/**
 * The search engine: one thin, testable layer over xterm's search add-on.
 * ----------------------------------------------------------------------
 * WHY A WRAPPER AT ALL, rather than the panel calling the add-on. Three
 * reasons, and the third is the one that matters.
 *
 *   1. ONE ADD-ON PER TERMINAL, EVER. `term.loadAddon` is not idempotent:
 *      call it twice and the terminal carries two search add-ons, each
 *      with its own decoration set, each answering `onDidChangeResults`,
 *      and every count the panel paints is doubled. The panel opens and
 *      closes many times over one session, so `attach` has to be safe to
 *      call on every open. The registry is a WeakMap keyed on the TERM
 *      INSTANCE, so a session swap that builds a new terminal gets a new
 *      add-on and the old entry is collected with the old terminal.
 *
 *   2. A MISSING ADD-ON MUST NOT BREAK THE PANEL. `client/index.html`
 *      loads the vendored bundle as a plain script; a failed static
 *      fetch leaves `window.SearchAddon` undefined. Every method here
 *      then warns once and answers "no results" rather than throwing,
 *      because a search box that finds nothing is survivable and a
 *      terminal that will not open is not.
 *
 *   3. THE RAIL AND THE HIGHLIGHTS MUST AGREE ABOUT WHAT MATCHES.
 *      `predicate()` is the ONE definition of "this text matches the
 *      query", exported so the prompt rail dims its ticks by exactly the
 *      rule the add-on highlights cells by. Two implementations of one
 *      question is two answers the first time somebody edits one.
 *
 * THE HARD-WRAP GAP, STATED RATHER THAN HIDDEN. The add-on rejoins rows
 * that xterm itself wrapped - the ones whose buffer line reports
 * `isWrapped` - so a match spanning a soft wrap is found. It cannot
 * rejoin rows CLAUDE hard-wrapped: Claude's renderer emits its own
 * newline and pads the next row, so those are two unrelated buffer lines
 * with no `isWrapped` flag between them (the same distinction
 * `client/js/copy-output.js` already has to make when it rebuilds
 * paragraphs). A word Claude split across its own line break therefore
 * does not match as one token. Searching for either half still finds the
 * row. This is a property of the add-on, not something a caller can
 * configure, and the honest answer to it is Deep dive, which searches
 * the transcript rather than the screen.
 *
 * COLOURS COME FROM THE THEME, AND ARE VALIDATED BEFORE USE. xterm wants
 * a CSS colour string it can parse into a cell decoration; a token that
 * resolved to `rgba(...)`, to the empty string, or to a `var()` chain
 * that never bottomed out would be handed straight to the renderer. So
 * every read is checked against a hex pattern and falls back to the
 * hardcoded default when it is not one. A refusal costs the theme its
 * highlight colour; a bad value costs the highlight entirely.
 */

console.log('[TerminalSearchEngine Module] Loading...');

(function () {
    'use strict';

    /**
     * The add-on's own cap on how many matches it will decorate. Past it
     * the count is reported but the highlights stop, which the panel
     * renders as `1000+` rather than pretending to a precise number.
     * @type {number}
     */
    var HIGHLIGHT_LIMIT = 1000;

    /**
     * Decoration colours, as CSS custom properties read off
     * `.terminal-container`, with the fallback used when the property is
     * absent or is not a hex colour. Declared in the
     * `:global(.terminal-container)` block of
     * `web/src/lib/terminal-search/SearchPanel.svelte`, which ships them
     * in `client/dist/app.css`.
     * @type {Array<{option: string, prop: string, fallback: string}>}
     */
    var DECORATION_COLOURS = [
        { option: 'matchBackground', prop: '--terminal-search-match-bg', fallback: '#4d3b30' },
        { option: 'matchBorder', prop: '--terminal-search-match-border', fallback: '#8a5a44' },
        { option: 'matchOverviewRuler', prop: '--terminal-search-match-ruler', fallback: '#8a5a44' },
        { option: 'activeMatchBackground', prop: '--terminal-search-active-bg', fallback: '#d77757' },
        { option: 'activeMatchBorder', prop: '--terminal-search-active-border', fallback: '#e88768' },
        { option: 'activeMatchColorOverviewRuler', prop: '--terminal-search-active-ruler', fallback: '#d77757' }
    ];

    /** `#rgb`, `#rrggbb` or `#rrggbbaa`. Anything else is refused. */
    var HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

    /**
     * term instance -> its one SearchAddon. A WeakMap so a disposed
     * terminal takes its add-on entry with it.
     * @type {WeakMap<object, object>}
     */
    var addons = new WeakMap();

    /** Result subscribers, called with {resultIndex, resultCount}. */
    var resultListeners = [];

    /** The last term `attach` was given, so next/prev need no argument. */
    var activeTerm = null;

    /** The query and options the last `find` ran with. */
    var lastQuery = '';
    var lastOptions = null;

    /** Said once, not once per keystroke. */
    var warnedMissing = false;

    /**
     * The add-on constructor, or null when the vendored bundle did not
     * load. Read fresh each time rather than cached at module load: this
     * file and the bundle are two separate script tags, and a cache taken
     * at load would be permanently null if the order ever changed.
     *
     * @returns {Function|null}
     */
    function addonClass() {
        var ns = (typeof window !== 'undefined') ? window.SearchAddon : null;
        return (ns && typeof ns.SearchAddon === 'function') ? ns.SearchAddon : null;
    }

    /**
     * Warn once that there is no add-on, and answer false so every caller
     * can `if (!available()) return ...` in one line.
     *
     * @returns {boolean} true when the add-on can be used.
     */
    function available() {
        if (addonClass()) return true;
        if (!warnedMissing) {
            warnedMissing = true;
            console.warn('TerminalSearchEngine: xterm-addon-search did not load; '
                + 'search is a no-op. Check the /static/vendor/xterm/ script tag.');
        }
        return false;
    }

    /**
     * Read one themed colour off `.terminal-container`.
     *
     * @param {string} prop - the custom property name.
     * @param {string} fallback - used when it is absent or not a hex colour.
     * @returns {string} a hex colour string.
     */
    function themedColour(prop, fallback) {
        try {
            var host = document.querySelector('.terminal-container');
            if (!host || typeof window.getComputedStyle !== 'function') return fallback;
            var value = window.getComputedStyle(host).getPropertyValue(prop);
            value = (value || '').trim();
            return HEX_COLOUR.test(value) ? value : fallback;
        } catch (err) {
            console.warn('TerminalSearchEngine: could not read ' + prop, err);
            return fallback;
        }
    }

    /**
     * The decoration block handed to every find call.
     *
     * @returns {object} xterm ISearchDecorationOptions.
     */
    function decorations() {
        var out = {};
        DECORATION_COLOURS.forEach(function (c) {
            out[c.option] = themedColour(c.prop, c.fallback);
        });
        return out;
    }

    /**
     * Load the add-on onto a terminal, at most once per terminal.
     *
     * @param {object} term - the xterm Terminal.
     * @returns {object|null} the add-on, or null when unavailable.
     */
    function attach(term) {
        if (!term) return null;
        activeTerm = term;
        if (addons.has(term)) return addons.get(term);
        if (!available()) return null;

        var Addon = addonClass();
        var addon;
        try {
            addon = new Addon({ highlightLimit: HIGHLIGHT_LIMIT });
            term.loadAddon(addon);
        } catch (err) {
            console.warn('TerminalSearchEngine: loadAddon failed', err);
            return null;
        }
        if (addon.onDidChangeResults) {
            addon.onDidChangeResults(function (r) {
                emit(r);
            });
        }
        addons.set(term, addon);
        return addon;
    }

    /**
     * The add-on for the active terminal, without loading one.
     * @returns {object|null}
     */
    function current() {
        return (activeTerm && addons.has(activeTerm)) ? addons.get(activeTerm) : null;
    }

    /**
     * Tell every subscriber what the add-on last reported.
     *
     * A `resultCount` of -1 is the add-on saying "I have not counted",
     * which is NOT the same as zero and must never be painted as
     * `no matches`. It is passed through as null so the panel can say
     * nothing rather than say something false.
     *
     * @param {object} r - {resultIndex, resultCount} from the add-on.
     * @returns {void}
     */
    function emit(r) {
        var count = (r && typeof r.resultCount === 'number' && r.resultCount >= 0)
            ? r.resultCount : null;
        var index = (r && typeof r.resultIndex === 'number' && r.resultIndex >= 0)
            ? r.resultIndex : null;
        var payload = { resultIndex: index, resultCount: count, limit: HIGHLIGHT_LIMIT };
        resultListeners.slice().forEach(function (fn) {
            try {
                fn(payload);
            } catch (err) {
                console.warn('TerminalSearchEngine: a results listener threw', err);
            }
        });
    }

    /**
     * Subscribe to result counts.
     *
     * @param {Function} cb - called with {resultIndex, resultCount, limit}.
     * @returns {Function} unsubscribe.
     */
    function onResults(cb) {
        if (typeof cb !== 'function') return function () {};
        resultListeners.push(cb);
        return function () {
            var i = resultListeners.indexOf(cb);
            if (i !== -1) resultListeners.splice(i, 1);
        };
    }

    /**
     * Build the option block one find call uses.
     *
     * @param {object|null} opts - {regex, caseSensitive, incremental}.
     * @returns {object} xterm ISearchOptions.
     */
    function searchOptions(opts) {
        var o = opts || {};
        return {
            regex: !!o.regex,
            caseSensitive: !!o.caseSensitive,
            wholeWord: false,
            incremental: o.incremental !== false,
            decorations: decorations()
        };
    }

    /**
     * Run a search.
     *
     * @param {string} q - the query. Empty clears instead of searching.
     * @param {object} [opts] - {regex, caseSensitive, incremental}.
     * @param {string} [dir] - 'next' (default) or 'prev'.
     * @returns {boolean} true when the add-on reported a match.
     */
    function find(q, opts, dir) {
        lastQuery = q || '';
        lastOptions = opts || null;
        if (!lastQuery) {
            clear();
            return false;
        }
        var addon = current() || attach(activeTerm);
        if (!addon) return false;
        try {
            return dir === 'prev'
                ? !!addon.findPrevious(lastQuery, searchOptions(opts))
                : !!addon.findNext(lastQuery, searchOptions(opts));
        } catch (err) {
            // A malformed regex is a user typing, not a defect: report it
            // as "no match" and let them keep typing.
            console.warn('TerminalSearchEngine: find failed', err);
            return false;
        }
    }

    /**
     * Advance to the next match of the query already running.
     *
     * `incremental` is forced OFF here. Incremental means "extend the
     * match I am already on if it still matches", which is right while
     * the user types and would make Enter stand still.
     *
     * @returns {boolean}
     */
    function next() {
        var o = Object.assign({}, lastOptions || {}, { incremental: false });
        return find(lastQuery, o, 'next');
    }

    /**
     * Step back to the previous match of the running query.
     * @returns {boolean}
     */
    function prev() {
        var o = Object.assign({}, lastOptions || {}, { incremental: false });
        return find(lastQuery, o, 'prev');
    }

    /**
     * Drop every highlight and forget the query.
     * @returns {void}
     */
    function clear() {
        lastQuery = '';
        var addon = current();
        if (addon && typeof addon.clearDecorations === 'function') {
            try {
                addon.clearDecorations();
            } catch (err) {
                console.warn('TerminalSearchEngine: clearDecorations failed', err);
            }
        }
        emit({ resultIndex: -1, resultCount: 0 });
    }

    /**
     * The one definition of "this text matches the query", shared with
     * the prompt rail so a dimmed tick and a highlighted cell can never
     * disagree.
     *
     * An EMPTY query matches EVERYTHING, deliberately: the rail's resting
     * state is every tick lit, and a predicate that answered false for an
     * empty box would blank the rail the moment the panel opened.
     *
     * @param {string} q - the query.
     * @param {object} [opts] - {regex, caseSensitive}.
     * @returns {Function} (text: string) => boolean.
     */
    function predicate(q, opts) {
        var o = opts || {};
        var query = q || '';
        if (!query) return function () { return true; };

        if (o.regex) {
            var re;
            try {
                re = new RegExp(query, o.caseSensitive ? '' : 'i');
            } catch (err) {
                // An unfinished regex matches nothing rather than
                // everything: a half-typed `(` must not light the rail up
                // as though every prompt qualified.
                return function () { return false; };
            }
            return function (text) {
                re.lastIndex = 0;
                return re.test(String(text == null ? '' : text));
            };
        }

        if (o.caseSensitive) {
            return function (text) {
                return String(text == null ? '' : text).indexOf(query) !== -1;
            };
        }
        var needle = query.toLowerCase();
        return function (text) {
            return String(text == null ? '' : text).toLowerCase().indexOf(needle) !== -1;
        };
    }

    window.TerminalSearchEngine = {
        attach: attach,
        find: find,
        next: next,
        prev: prev,
        clear: clear,
        onResults: onResults,
        predicate: predicate,
        HIGHLIGHT_LIMIT: HIGHLIGHT_LIMIT
    };
})();

console.log('[TerminalSearchEngine Module] Exported as window.TerminalSearchEngine');
