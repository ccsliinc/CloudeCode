/**
 * Archive navigation rail - hosts, corpora, projects, and the
 * unattributed bucket, with a filter over the rows already fetched.
 *
 * WHAT THIS FILE IS FOR. The corpus is 2 hosts, 3 corpora, 80 projects
 * and 21,039 transcripts (measured live 2026-08-31). There is no global
 * search, so this tree is the ONLY way into the archive, and a level
 * that fails quietly is a level nobody can get past.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 *   1. A FAILED BRANCH NEVER COLLAPSES INTO A LEAF. When expanding a
 *      host answers cannot_determine, that host renders the COULD NOT
 *      EVALUATE block INLINE, at that node, and every sibling stays
 *      usable. A branch that quietly renders as childless is a claim
 *      that the host has no corpora - a verdict nobody measured.
 *
 *   2. THE UNATTRIBUTED BUCKET IS ALWAYS GIVEN A SHAPE. Corpus 2
 *      reports unattributed_transcript_count: 5 (measured). Those five
 *      belong to no project and are therefore INVISIBLE from the project
 *      tree by construction - the same never-onboarded blind spot that
 *      makes a thing safe from every check because no check can see it.
 *      The rail renders them as their own node, always, including when
 *      the count is 0 (it says 0) and when the server did not report one
 *      (it says NOT KNOWN).
 *
 *   3. "UNATTRIBUTED" AND "host_attribution: cannot_determine" ARE
 *      DIFFERENT CONDITIONS AND ARE NEVER MERGED. The first is a
 *      transcript with no project, the second one whose HOST link was
 *      not established. Either can be true without the other, so
 *      merging them invents a population that does not exist.
 *
 * THE FILTER IS HONEST ABOUT ITS OWN SCOPE, in words, every time it is
 * non-empty: "filter matches 3 of 71 loaded projects. This filters rows
 * already fetched, not the whole corpus." A filter that reads like a
 * search of the corpus is a false green with a text box on it.
 *
 * Does not read `result_status`, `scope_status` or `scan.status`. Every
 * envelope goes to ArchiveOutcomeView.renderOutcomeBlock, which routes
 * through archive-outcome.js, the client's only status interpreter.
 *
 * No innerHTML anywhere: host 2's display_name carries a real U+2019
 * and slugs are filesystem paths.
 */

console.log('[ArchiveNav Module] Loading...');

(function () {
    'use strict';

    // The vocabulary and the pure row renderers live in
    // archive-nav-row.js, which MUST load before this file. They are
    // re-exported below so ArchiveNav stays the one name a caller has
    // to know.
    var ROW = window.ArchiveNavRow;
    if (!ROW) {
        console.error('[ArchiveNav] MISSING DEPENDENCY: window.ArchiveNavRow. ' +
            'Load client/js/archive-nav-row.js BEFORE this file; the rail ' +
            'cannot render a single row without it.');
    }
    var ROOT_CLASS = ROW.ROOT_CLASS;
    var NODE_KINDS = ROW.NODE_KINDS;
    var NOT_KNOWN = ROW.NOT_KNOWN;
    var el = ROW.el;
    var renderCount = ROW.renderCount;
    var filterRows = ROW.filterRows;
    var describeFilter = ROW.describeFilter;
    var labelFor = ROW.labelFor;
    var idFor = ROW.idFor;
    var countFor = ROW.countFor;
    var renderRow = ROW.renderRow;
    var renderOutcomeInto = ROW.renderOutcomeInto;

    /**
     * Description: build the navigation rail.
     * Inputs: options (object) -
     *   document (Document) - defaults to window.document.
     *   api (object) - anything exposing listArchiveHosts,
     *     listArchiveCorpora, listArchiveProjects. Injected so tests do
     *     not need a network.
     *   onSelect (function(kind, id, row)) - called when a leaf or the
     *     unattributed node is chosen.
     * Output: {element, loadHosts, expand, setFilter, rowsLoaded}
     * Example:
     *   var nav = ArchiveNav.create({api: window.API, onSelect: fn});
     *   document.body.appendChild(nav.element);
     *   await nav.loadHosts();
     */
    function create(options) {
        var opts = options || {};
        var doc = opts.document || (typeof window !== 'undefined' ? window.document : null);
        if (!doc) throw new Error('ArchiveNav.create needs a document');
        var api = opts.api;
        var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};

        var root = el(doc, 'nav', ROOT_CLASS, null);
        root.setAttribute('aria-label', 'Archive navigation');

        var filterInput = el(doc, 'input', ROOT_CLASS + '__filter', null);
        filterInput.setAttribute('type', 'search');
        filterInput.setAttribute('placeholder', 'filter projects (fuzzy)');
        filterInput.setAttribute('aria-label', 'Filter the rows already loaded');

        // VIEW TOGGLE. Merged is the default because the machine a
        // project was born on is not how anyone navigates to it. The
        // by-machine tree is kept, not replaced - the information moved
        // from a level to a badge, and this is the way back to it.
        var viewBar = el(doc, 'div', ROOT_CLASS + '__viewbar', null);
        var mergedBtn = el(doc, 'button', ROOT_CLASS + '__view ' + ROOT_CLASS + '__view--on', 'All projects');
        mergedBtn.setAttribute('type', 'button');
        mergedBtn.setAttribute('data-view', 'merged');
        var byHostBtn = el(doc, 'button', ROOT_CLASS + '__view', 'By machine');
        byHostBtn.setAttribute('type', 'button');
        byHostBtn.setAttribute('data-view', 'hosts');
        var hostSelect = doc.createElement('select');
        hostSelect.setAttribute('class', ROOT_CLASS + '__hostfilter');
        hostSelect.setAttribute('aria-label', 'Show only projects from one machine');
        viewBar.appendChild(mergedBtn);
        viewBar.appendChild(byHostBtn);
        viewBar.appendChild(hostSelect);

        var filterNote = el(doc, 'p', ROOT_CLASS + '__filter-note', null);
        var hostList = el(doc, 'ul', ROOT_CLASS + '__level ' + ROOT_CLASS + '__level--hosts', null);
        var mergedList = el(doc, 'ul', ROOT_CLASS + '__level ' + ROOT_CLASS + '__level--merged', null);
        root.appendChild(viewBar);
        root.appendChild(filterInput);
        root.appendChild(filterNote);
        root.appendChild(mergedList);
        root.appendChild(hostList);
        hostList.setAttribute('hidden', 'hidden');

        /** Rows fetched per level, keyed 'hosts' | 'corpora:<id>' | 'projects:<id>'. */
        var loaded = {};
        /** Server-declared totals per level key, for the honest filter note. */
        var totals = {};
        var filterText = '';
        /** 'merged' (default) or 'hosts'. */
        var view = 'merged';
        /** Merged project nodes, their unattributed rows, and the host filter. */
        var merged = { nodes: [], unattributed: [], hosts: [] };
        var hostFilter = null;
        var lastPaint = { rendered: 0, total: 0 };

        /**
         * Description: render one level's rows into a slot, applying the
         *   active filter and stating what it filtered.
         * Inputs: slot (Element), key (string), kind (string),
         *         rows (Array), fields (Array<string>), expandable (bool)
         * Output: void.
         */
        function paint(slot, key, kind, rows, fields, expandable) {
            slot.textContent = '';
            var visible = filterRows(rows, filterText, fields);
            if (filterText && visible.length === 0) {
                // Not an outcome block: nothing was measured here, the
                // person's own filter excluded everything. Saying that
                // is different from "the server returned nothing".
                var none = el(doc, 'li', ROOT_CLASS + '__filter-empty',
                    'No loaded rows match this filter. ' +
                    describeFilter(0, rows.length, totals[key] || null, kind + 's'));
                slot.appendChild(none);
                return;
            }
            for (var i = 0; i < visible.length; i++) {
                slot.appendChild(renderRow(doc, kind, visible[i], {
                    expandable: expandable,
                    onActivate: activate
                }));
            }
        }

        /**
         * Description: handle a click on any row: expand a container,
         *   or hand a leaf to the caller.
         * Inputs: kind (string), id (number|string), row (object).
         * Output: void.
         */
        function activate(kind, id, row) {
            if (kind === NODE_KINDS.HOST || kind === NODE_KINDS.CORPUS) {
                expand(kind, id);
                return;
            }
            onSelect(kind, id, row);
        }

        /**
         * Description: find a node's child slot in the rendered tree.
         * Inputs: kind (string), id (number|string).
         * Output: Element|null.
         */
        function slotFor(kind, id) {
            var nodes = root.querySelectorAll('[data-node-kind="' + kind + '"]');
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-node-id') === String(id)) {
                    return nodes[i].querySelector('.' + ROOT_CLASS + '__children');
                }
            }
            return null;
        }

        /**
         * Description: fetch and render the top level.
         * Inputs: none. Output: Promise<string> - the outcome token, so a
         *   caller (or a test) can assert what happened without reading
         *   the DOM.
         */
        function loadHosts() {
            return Promise.resolve(api.listArchiveHosts()).then(function (r) {
                var classified = window.ArchiveOutcome.classify(r.transportError ? null : r.envelope);
                if (!window.ArchiveOutcome.isRenderable(classified.token)) {
                    renderOutcomeInto(doc, hostList, r.envelope, r.transportError);
                    return classified.token;
                }
                loaded.hosts = (r.envelope && r.envelope.result) || [];
                totals.hosts = loaded.hosts.length;
                paint(hostList, 'hosts', NODE_KINDS.HOST, loaded.hosts,
                      ['display_name', 'hostname'], true);
                if (classified.token === 'partial') {
                    // Rows AND the banner. Dropping the rows to show the
                    // banner would hide what did come back; dropping the
                    // banner would claim the list is complete.
                    renderPartialTail(hostList, r.envelope);
                }
                return classified.token;
            });
        }

        /**
         * Description: append the partial banner AFTER the rows that did
         *   arrive, so both are visible at once.
         * Inputs: slot (Element), envelope (object). Output: void.
         */
        function renderPartialTail(slot, envelope) {
            var tail = el(doc, 'li', ROOT_CLASS + '__outcome', null);
            tail.appendChild(window.ArchiveOutcomeView.renderOutcomeBlock(
                envelope, { document: doc }));
            slot.appendChild(tail);
        }

        /**
         * Description: expand a host into its corpora, or a corpus into
         *   its projects plus its unattributed node.
         * Inputs: kind (string) - HOST or CORPUS. id (number|string).
         * Output: Promise<string> - the outcome token.
         */
        function expand(kind, id) {
            var slot = slotFor(kind, id);
            if (!slot) return Promise.resolve('not-found');
            slot.textContent = '';
            slot.appendChild(el(doc, 'li', ROOT_CLASS + '__loading', 'loading...'));

            var isHost = kind === NODE_KINDS.HOST;
            var key = (isHost ? 'corpora:' : 'projects:') + id;
            var call = isHost ? api.listArchiveCorpora(id) : api.listArchiveProjects(id);

            return Promise.resolve(call).then(function (r) {
                var classified = window.ArchiveOutcome.classify(r.transportError ? null : r.envelope);
                if (!window.ArchiveOutcome.isRenderable(classified.token)) {
                    renderOutcomeInto(doc, slot, r.envelope, r.transportError);
                    return classified.token;
                }
                var rows = (r.envelope && r.envelope.result) || [];
                loaded[key] = rows;
                totals[key] = rows.length;
                paint(slot, key, isHost ? NODE_KINDS.CORPUS : NODE_KINDS.PROJECT, rows,
                      isHost ? ['corpus_key', 'root_path'] : ['slug', 'observed_cwd'], isHost);
                if (!isHost) appendUnattributedNode(slot, id);
                if (classified.token === 'partial') renderPartialTail(slot, r.envelope);
                return classified.token;
            });
        }

        /**
         * Description: give the no-project transcripts a visible node,
         *   ALWAYS, including when the count is 0 or unreported. The
         *   count comes from the corpora listing, where the server
         *   already reported it.
         * Inputs: slot (Element), corpusId (number|string). Output: void.
         */
        function appendUnattributedNode(slot, corpusId) {
            var corpora = [];
            for (var k in loaded) {
                if (k.indexOf('corpora:') === 0) corpora = corpora.concat(loaded[k]);
            }
            var match = null;
            for (var i = 0; i < corpora.length; i++) {
                if (String(corpora[i].corpus_id) === String(corpusId)) match = corpora[i];
            }
            slot.appendChild(renderRow(doc, NODE_KINDS.UNATTRIBUTED,
                match || { corpus_id: corpusId }, { expandable: false, onActivate: activate }));
        }

        /**
         * Description: re-filter every level already on screen.
         * Inputs: text (string). Output: void.
         */
        function setFilter(text) {
            filterText = String(text === null || text === undefined ? '' : text);
            if (view === 'merged') { paintMerged(); return; }
            if (loaded.hosts) {
                paint(hostList, 'hosts', NODE_KINDS.HOST, loaded.hosts,
                      ['display_name', 'hostname'], true);
            }
            filterNote.textContent = filterText
                ? describeFilter(filterRows(loaded.hosts || [], filterText,
                        ['display_name', 'hostname']).length,
                    (loaded.hosts || []).length, totals.hosts || null, 'hosts')
                : '';
        }

        /**
         * Description: fetch the merged project list - the default view.
         *   One request, not paginated: 77 nodes, and a page of a merged
         *   tree would let someone conclude a project lives on one
         *   machine because the row proving otherwise fell on page 2.
         * Inputs: none. Output: Promise<string> - the outcome token.
         */
        function loadMergedProjects() {
            if (typeof api.listArchiveMergedProjects !== 'function') {
                renderOutcomeInto(doc, mergedList, null,
                    'api.listArchiveMergedProjects is not available in this build');
                return Promise.resolve('transport-error');
            }
            return Promise.resolve(api.listArchiveMergedProjects()).then(function (r) {
                var classified = window.ArchiveOutcome.classify(
                    r.transportError ? null : r.envelope);
                if (!window.ArchiveOutcome.isRenderable(classified.token)) {
                    renderOutcomeInto(doc, mergedList, r.envelope, r.transportError);
                    return classified.token;
                }
                var env = r.envelope || {};
                var meta = env.meta || {};
                merged.nodes = env.result || [];
                merged.unattributed = (meta.unattributed && meta.unattributed.by_corpus) || [];
                merged.hosts = meta.hosts || [];
                totals.merged = merged.nodes.length;
                window.ArchiveNavMerged.paintHostSelect(doc, hostSelect, merged.hosts);
                paintMerged();
                if (classified.token === 'partial') renderPartialTail(mergedList, r.envelope);
                return classified.token;
            });
        }

        /**
         * Description: repaint the merged list under the current fuzzy
         *   filter and machine filter, and restate what the filter did.
         * Inputs: none. Output: void.
         */
        function paintMerged() {
            // A MISSING DEPENDENCY IS RENDERED, NEVER THROWN. If
            // archive-nav-merged.js was not loaded, the merged view
            // cannot paint - and an exception here would take the whole
            // rail down on a keystroke, leaving a blank pane that looks
            // exactly like an archive with no projects in it. Say what
            // is missing, where the person is looking.
            if (!window.ArchiveNavMerged) {
                renderOutcomeInto(doc, mergedList, null,
                    'window.ArchiveNavMerged is missing: load ' +
                    'client/js/archive-nav-merged.js (and ' +
                    'archive-nav-fuzzy.js) before archive-nav.js');
                lastPaint = { rendered: 0, total: 0, hiddenUnattributed: 0 };
                return;
            }
            lastPaint = window.ArchiveNavMerged.paint(doc, mergedList, {
                nodes: merged.nodes,
                unattributed: merged.unattributed,
                hostId: hostFilter,
                filterText: filterText,
                onActivate: activate
            });
            filterNote.textContent = filterText
                ? describeFilter(lastPaint.rendered, lastPaint.total,
                                 totals.merged || null, 'projects')
                : '';
        }

        /**
         * Description: switch between the merged list and the
         *   by-machine drill-down. Both stay in the DOM; only one is
         *   visible, so switching back does not refetch.
         * Inputs: next (string) - 'merged' or 'hosts'. Output: Promise.
         */
        function setView(next) {
            view = next === 'hosts' ? 'hosts' : 'merged';
            var isMerged = view === 'merged';
            mergedBtn.setAttribute('class', ROOT_CLASS + '__view' +
                (isMerged ? ' ' + ROOT_CLASS + '__view--on' : ''));
            byHostBtn.setAttribute('class', ROOT_CLASS + '__view' +
                (isMerged ? '' : ' ' + ROOT_CLASS + '__view--on'));
            if (isMerged) {
                hostList.setAttribute('hidden', 'hidden');
                mergedList.removeAttribute('hidden');
                hostSelect.removeAttribute('hidden');
                return merged.nodes.length ? Promise.resolve('ok') : loadMergedProjects();
            }
            mergedList.setAttribute('hidden', 'hidden');
            hostSelect.setAttribute('hidden', 'hidden');
            hostList.removeAttribute('hidden');
            return loaded.hosts ? Promise.resolve('ok') : loadHosts();
        }

        mergedBtn.addEventListener('click', function () { setView('merged'); });
        byHostBtn.addEventListener('click', function () { setView('hosts'); });
        hostSelect.addEventListener('change', function () {
            hostFilter = hostSelect.value || null;
            paintMerged();
        });
        filterInput.addEventListener('input', function () { setFilter(filterInput.value || ''); });

        return {
            element: root,
            loadHosts: loadHosts,
            loadMergedProjects: loadMergedProjects,
            setView: setView,
            /**
             * Description: load whatever the ACTIVE view needs, and
             *   nothing else. The screen used to call loadHosts() on
             *   every route, which fetched the drill-down the user was
             *   NOT looking at and never fetched the merged list that
             *   is the default view - so the rail opened empty, with no
             *   request made and no error to see. An empty list and a
             *   list nobody asked for render identically, which is the
             *   false green this rail is written against.
             *
             *   Idempotent: setView() already refuses to refetch a
             *   loaded view, so calling this on every route costs one
             *   request per view per session.
             * Inputs: none. Output: Promise.
             */
            ensureViewLoaded: function () { return setView(view); },
            /**
             * Description: the active view, for tests and the shell.
             * Inputs: none. Output: string - 'merged' | 'hosts'.
             */
            view: function () { return view; },
            /**
             * Description: narrow the merged list to one machine.
             * Inputs: hostId (number|string|null) - null for all.
             * Output: void.
             */
            setHostFilter: function (hostId) {
                hostFilter = (hostId === null || hostId === undefined || hostId === '')
                    ? null : String(hostId);
                hostSelect.value = hostFilter === null ? '' : hostFilter;
                paintMerged();
            },
            /**
             * Description: what the last paint rendered, so a test can
             *   assert the filter without recounting the DOM.
             * Inputs: none. Output: object.
             */
            lastPaint: function () { return lastPaint; },
            mergedNodes: function () { return merged.nodes.slice(); },
            expand: expand,
            setFilter: setFilter,
            // The composition root needs THREE things from the filter, and
            // had none of them: something to focus for `/`, the current
            // text (it was passing a hardcoded '' into ArchiveKeys.resolve,
            // which made rung 2 of the Escape ladder unreachable), and a
            // way to clear it.
            filterInput: filterInput,
            /**
             * Description: the filter box's current text.
             * Inputs: none. Output: string - '' when nothing is filtered.
             */
            filterText: function () { return filterText; },
            /**
             * Description: clear the filter and repaint, which is Escape
             *   rung 2. Clears the INPUT as well as the state: clearing
             *   only the state leaves the box showing text that no longer
             *   filters anything, which reads as a broken filter.
             * Inputs: none. Output: void.
             */
            clearFilter: function () {
                filterInput.value = '';
                setFilter('');
            },
            /**
             * Description: rows fetched for one level key, for tests.
             * Inputs: key (string). Output: Array.
             */
            rowsLoaded: function (key) { return (loaded[key] || []).slice(); }
        };
    }

    window.ArchiveNav = {
        create: create,
        filterRows: filterRows,
        describeFilter: describeFilter,
        labelFor: labelFor,
        renderCount: renderCount,
        NODE_KINDS: NODE_KINDS,
        ROOT_CLASS: ROOT_CLASS,
        NOT_KNOWN: NOT_KNOWN
    };
    console.log('[ArchiveNav Module] Exported as window.ArchiveNav');
})();
