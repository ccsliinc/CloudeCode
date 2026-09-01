/**
 * The transcript list's FILTER HEADER: the compact scheme chooser and
 * the three per-column fuzzy inputs.
 *
 * WHY THE SCHEME CHOOSER IS A DISCLOSURE AND NOT A `<select>`. The three
 * options already carry an `aria-pressed` contract, written on EVERY
 * option rather than only the active one so the off state stays a state
 * (see archive-transcript-list.js). A native `<select>` has no
 * `aria-pressed` and no way to grow one, so swapping to it would have
 * silently dropped that contract while looking like a pure size win.
 * The options stay real buttons; what changed is that they live behind a
 * trigger that names the current choice, so the header costs ONE row
 * instead of three.
 *
 * THE TWO FILTERS HAVE DIFFERENT SCOPES AND MUST NEVER BE DESCRIBED IN
 * ONE SENTENCE. The scheme filter is SERVER-side: it re-queries the
 * whole project, so its counts are scope counts. The fuzzy filter is
 * CLIENT-side over the rows ALREADY FETCHED, and it cannot see a row on
 * a page nobody has loaded. Merging the two notes would make one of them
 * a lie in whichever direction the reader happened to guess. They are
 * rendered as two separate lines, each naming its own scope, and the
 * fuzzy line says out loud when more pages exist.
 *
 * NOTHING HERE FETCHES, PAGES OR HOLDS ROWS. It emits changes through
 * two callbacks and renders what it is told. The stateful list owns the
 * rows and the cursor; this owns a header.
 *
 * Exports window.ArchiveTlistFilter.
 */

console.log('[ArchiveTlistFilter Module] Loading...');

(function () {
    'use strict';

    /**
     * The three fuzzy columns, in the order they are drawn. `key` is the
     * name a caller reads a row's value by; nothing here knows the row
     * shape beyond passing this string back.
     * @type {Array<{key: string, label: string, placeholder: string}>}
     */
    var COLUMNS = [
        { key: 'title', label: 'Name', placeholder: 'filter by name' },
        { key: 'ref', label: 'Ref', placeholder: 'filter by ref' },
        { key: 'date', label: 'Date', placeholder: 'filter by date' }
    ];

    /**
     * Description: build the filter header.
     * Inputs: options (object) -
     *   document (Document), rootClass (string),
     *   schemeDefs (Array<{v, label, hint}>), scheme (string) - the one
     *     active at build time, onScheme (function(value)),
     *   onQuery (function(queries)) - called on every keystroke with the
     *     full column -> text map.
     * Output: {element, setScheme, queries, setNote, clearQueries}
     */
    function create(options) {
        var opts = options || {};
        var doc = opts.document;
        if (!doc) throw new Error('ArchiveTlistFilter.create needs a document');
        var rootClass = opts.rootClass || 'archive-tlist';
        var defs = opts.schemeDefs || [];
        var scheme = opts.scheme;
        var onScheme = typeof opts.onScheme === 'function' ? opts.onScheme : function () {};
        var onQuery = typeof opts.onQuery === 'function' ? opts.onQuery : function () {};

        var queries = {};
        var optionButtons = [];
        var root = el('div', rootClass + '__filters', null);
        var trigger = null;
        var menu = null;
        var note = el('p', rootClass + '__fuzzy-note', null);

        /** Description: element with a class and optional text.
         *  Inputs: tag, cls, text. Output: Element. */
        function el(tag, cls, text) {
            var n = doc.createElement(tag);
            if (cls) n.setAttribute('class', cls);
            if (text !== null && text !== undefined) n.textContent = String(text);
            return n;
        }

        /** Description: the label of the active scheme, for the trigger.
         *  Inputs: none. Output: string. */
        function activeLabel() {
            for (var i = 0; i < defs.length; i++) {
                if (defs[i].v === scheme) return defs[i].label;
            }
            // An unrecognised value is NAMED, not silently shown as the
            // first option - a trigger that displays a choice nobody made
            // is how a filter becomes untrustworthy.
            return 'UNKNOWN FILTER (' + String(scheme) + ')';
        }

        /** Description: repaint the trigger text and every option's
         *  aria-pressed. Inputs: none. Output: void. */
        function paintPressed() {
            if (trigger) {
                trigger.textContent = 'Showing: ' + activeLabel();
                trigger.setAttribute('data-scheme-active', String(scheme));
                trigger.setAttribute('title',
                    'Showing: ' + activeLabel() + '. Click to change which ' +
                    'kind of transcript this list asks the server for.');
            }
            for (var i = 0; i < optionButtons.length; i++) {
                var b = optionButtons[i];
                b.setAttribute('aria-pressed',
                    b.getAttribute('data-scheme-filter') === scheme ? 'true' : 'false');
            }
        }

        /** Description: open or close the option menu. Inputs: open
         *  (boolean). Output: void. */
        function setOpen(open) {
            menu.hidden = !open;
            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }

        /** Description: build the trigger plus its menu of real buttons.
         *  Inputs: none. Output: Element. */
        function buildScheme() {
            var box = el('div', rootClass + '__scheme-box', null);
            trigger = el('button', rootClass + '__scheme-trigger', null);
            trigger.setAttribute('type', 'button');
            trigger.setAttribute('aria-haspopup', 'true');
            trigger.setAttribute('aria-expanded', 'false');
            trigger.setAttribute('data-action', 'open-scheme-menu');
            menu = el('div', rootClass + '__scheme-menu', null);
            menu.setAttribute('role', 'group');
            menu.setAttribute('aria-label', 'Session reference scheme filter');
            menu.hidden = true;
            for (var i = 0; i < defs.length; i++) {
                menu.appendChild(buildOption(defs[i]));
            }
            trigger.addEventListener('click', function () {
                setOpen(menu.hidden);
            });
            box.appendChild(trigger);
            box.appendChild(menu);
            return box;
        }

        /** Description: one option button. Inputs: def. Output: Element. */
        function buildOption(def) {
            var b = el('button', rootClass + '__scheme', def.label);
            b.setAttribute('type', 'button');
            b.setAttribute('data-scheme-filter', def.v);
            if (def.hint) b.setAttribute('title', def.hint);
            b.addEventListener('click', function () {
                setOpen(false);
                setScheme(def.v);
                onScheme(def.v);
            });
            optionButtons.push(b);
            return b;
        }

        /** Description: build the three fuzzy inputs. Inputs: none.
         *  Output: Element. */
        function buildFuzzy() {
            var box = el('div', rootClass + '__fuzzy', null);
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label',
                'Filter the rows already loaded, by name, ref or date');
            for (var i = 0; i < COLUMNS.length; i++) {
                box.appendChild(buildInput(COLUMNS[i]));
            }
            return box;
        }

        /** Description: one column input. Inputs: col. Output: Element. */
        function buildInput(col) {
            var input = el('input', rootClass + '__fuzzy-input', null);
            input.setAttribute('type', 'search');
            input.setAttribute('data-fuzzy-column', col.key);
            input.setAttribute('placeholder', col.placeholder);
            input.setAttribute('title',
                'Fuzzy filter on ' + col.label.toLowerCase() +
                '. Matches characters in order, not as one block, and only' +
                ' across the rows already loaded into this list.');
            input.setAttribute('aria-label',
                'Filter loaded rows by ' + col.label.toLowerCase());
            input.addEventListener('input', function () {
                queries[col.key] = input.value || '';
                onQuery(readQueries());
            });
            return input;
        }

        /** Description: a copy of the typed queries. Inputs: none.
         *  Output: Object<string,string>. */
        function readQueries() {
            var out = {};
            for (var i = 0; i < COLUMNS.length; i++) {
                out[COLUMNS[i].key] = queries[COLUMNS[i].key] || '';
            }
            return out;
        }

        /** Description: record a scheme without emitting a change, so
         *  the caller can reflect a value it set itself. Inputs: value.
         *  Output: void. */
        function setScheme(value) {
            scheme = value;
            paintPressed();
        }

        /**
         * Description: write the fuzzy filter's OWN honesty line. It
         *   describes the rows fetched so far and NOTHING else, and it
         *   states the unknown case as an unknown: `hasMore === true`
         *   means there are more pages, `null` means the server did not
         *   say, and those are three different sentences.
         * Inputs: shown (number) - rows after filtering, loaded (number)
         *   - rows fetched, hasMore (boolean|null).
         * Output: void.
         */
        function setNote(shown, loaded, hasMore) {
            if (!isActive()) {
                note.textContent = '';
                return;
            }
            var line = 'Name/ref/date filter: ' + shown + ' of the ' + loaded +
                ' rows LOADED SO FAR match. This filter runs in the browser over' +
                ' the rows already fetched - it does not ask the server, and it' +
                ' cannot see a row on a page nobody has loaded.';
            if (hasMore === true) {
                line += ' There ARE more pages in this scope; load them to filter them.';
            } else if (hasMore !== false) {
                line += ' Whether more pages exist: NOT KNOWN, so rows may be' +
                    ' missing from what this filter can reach.';
            }
            note.textContent = line;
        }

        /** Description: is any column being filtered? Inputs: none.
         *  Output: boolean. */
        function isActive() {
            return !!(window.ArchiveFuzzy && window.ArchiveFuzzy.isActive(readQueries()));
        }

        root.appendChild(buildScheme());
        root.appendChild(buildFuzzy());
        root.appendChild(note);
        paintPressed();

        return {
            element: root,
            setScheme: setScheme,
            setNote: setNote,
            isActive: isActive,
            /** Description: the typed queries. Output: Object. */
            queries: readQueries,
            /** Description: the option buttons, for tests. Output: Array. */
            options: function () { return optionButtons.slice(); },
            /** Description: the trigger button, for tests. Output: Element. */
            trigger: function () { return trigger; },
            /** Description: the note element, for tests. Output: Element. */
            note: function () { return note; }
        };
    }

    window.ArchiveTlistFilter = { create: create, COLUMNS: COLUMNS };
    console.log('[ArchiveTlistFilter Module] Exported as window.ArchiveTlistFilter');
})();
