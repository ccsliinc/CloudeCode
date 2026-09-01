/**
 * The reader pane's TOOLBAR - the transcript search box and the export
 * button.
 *
 * WHY IT IS NOT IN `archive-reader.js`. Both controls are CROSS-PANE:
 * search writes its hits into the LIST column and export opens a modal,
 * and the reader knows about neither. Putting them there would give the
 * renderer a reason to reach out of its own pane, which is the coupling
 * that file is built to avoid.
 *
 * WHY IT IS NOT IN `archive-screen.js` EITHER. It was, and the
 * composition root went over the repo's 500-line cap when the pane
 * resizers and the crumb's knowledge landed. The seam is honest rather
 * than arbitrary: everything here is DOM construction for one strip of
 * controls, it decides nothing, and it hands back the two nodes the
 * composition root needs to keep (the input, so `/` can focus it, and
 * the export button).
 *
 * Exports window.ArchiveScreenTools.
 */

console.log('[ArchiveScreenTools Module] Loading...');

(function () {
    'use strict';

    /**
     * Description: build the toolbar and insert it at the top of the
     *   reader pane.
     * Inputs: options (object) -
     *   document (Document), pane (Element) - the reader pane,
     *   rootClass (string), onSearch (function(text)),
     *   onExport (function()).
     * Output: {element, searchInput, searchBtn, exportBtn}
     * Example: ArchiveScreenTools.create({document: document,
     *              pane: readPane, rootClass: 'archive-screen',
     *              onSearch: runSearch, onExport: openExport})
     */
    function create(options) {
        var opts = options || {};
        var doc = opts.document;
        var pane = opts.pane;
        if (!doc || !pane) throw new Error('ArchiveScreenTools.create needs a document and a pane');
        var cls = opts.rootClass || 'archive-screen';
        var onSearch = typeof opts.onSearch === 'function' ? opts.onSearch : function () {};
        var onExport = typeof opts.onExport === 'function' ? opts.onExport : function () {};

        /** Description: element with a class, text and attributes.
         *  Inputs: tag, suffix, text, map. Output: Element. */
        function el(tag, suffix, text, map) {
            var n = doc.createElement(tag);
            n.setAttribute('class', cls + suffix);
            if (text !== null && text !== undefined) n.textContent = text;
            var names = Object.keys(map || {});
            for (var i = 0; i < names.length; i++) n.setAttribute(names[i], map[names[i]]);
            return n;
        }

        var tools = el('div', '__tools', null, {});
        var searchInput = el('input', '__search-input', null, {
            type: 'search',
            placeholder: 'search this transcript',
            'aria-label': 'Search in the open transcript'
        });
        var searchBtn = el('button', '__search-btn', 'Search',
                           { type: 'button', 'data-action': 'run-search' });
        var exportBtn = el('button', '__export-btn', 'Export',
                           { type: 'button', 'data-action': 'open-export' });
        tools.appendChild(searchInput);
        tools.appendChild(searchBtn);
        tools.appendChild(exportBtn);
        pane.insertBefore(tools, pane.firstChild);

        searchBtn.addEventListener('click', function () { onSearch(searchInput.value); });
        searchInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') onSearch(searchInput.value);
        });
        exportBtn.addEventListener('click', function () { onExport(); });

        return { element: tools, searchInput: searchInput,
                 searchBtn: searchBtn, exportBtn: exportBtn };
    }

    window.ArchiveScreenTools = { create: create };
    console.log('[ArchiveScreenTools Module] Exported as window.ArchiveScreenTools');
})();
