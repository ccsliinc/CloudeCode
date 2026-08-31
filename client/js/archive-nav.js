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

    /** Root element class. @type {string} */
    var ROOT_CLASS = 'archive-nav';

    /**
     * Node kinds this rail can render. `unattributed` is a first-class
     * kind, not a flag on a corpus, because it is a selectable scope
     * with its own listing endpoint.
     * @type {Object<string,string>}
     */
    var NODE_KINDS = {
        HOST: 'host',
        CORPUS: 'corpus',
        PROJECT: 'project',
        UNATTRIBUTED: 'unattributed'
    };

    /**
     * The literal rendered wherever a count was not supplied. Never a
     * zero: "the server did not tell me" and "there are none" are
     * different findings.
     * @type {string}
     */
    var NOT_KNOWN = 'NOT KNOWN';

    /**
     * Description: build one element with a class and optional text.
     *   Text always reaches the DOM as a text node.
     * Inputs: doc (Document), tag (string), cls (string|null),
     *   text (string|number|null).
     * Output: Element.
     */
    function el(doc, tag, cls, text) {
        var node = doc.createElement(tag);
        if (cls) node.setAttribute('class', cls);
        if (text !== null && text !== undefined) node.textContent = String(text);
        return node;
    }

    /**
     * Description: render a count that may be absent. A missing number
     *   renders as NOT KNOWN, never as 0.
     * Inputs: n (number|null|undefined).
     * Output: string.
     * Example: renderCount(null) // -> 'NOT KNOWN'
     */
    function renderCount(n) {
        if (typeof n !== 'number' || !isFinite(n)) return NOT_KNOWN;
        return window.ArchiveFormat
            ? window.ArchiveFormat.formatCount(n)
            : String(n);
    }

    /**
     * Description: case-insensitive substring filter over already-loaded
     *   rows. Pure, exported so a test can assert it without a DOM.
     * Inputs: rows (Array<object>) - nav rows.
     *         needle (string) - the filter text; '' matches everything.
     *         fields (Array<string>) - row properties to search.
     * Output: Array<object> - the matching subset, order preserved.
     * Example: filterRows([{slug:'abc'}], 'B', ['slug'])  // -> [{slug:'abc'}]
     */
    function filterRows(rows, needle, fields) {
        var list = Array.isArray(rows) ? rows : [];
        var q = String(needle === null || needle === undefined ? '' : needle).toLowerCase();
        if (!q) return list.slice();
        var keys = Array.isArray(fields) && fields.length ? fields : ['slug'];
        return list.filter(function (row) {
            for (var i = 0; i < keys.length; i++) {
                var v = row && row[keys[i]];
                if (typeof v === 'string' && v.toLowerCase().indexOf(q) !== -1) return true;
            }
            return false;
        });
    }

    /**
     * Description: the sentence a filter must always carry, naming what
     *   it did and did NOT look at. Pure.
     * Inputs: matched (number) - rows the filter kept.
     *         loaded (number) - rows this rail has fetched.
     *         total (number|null) - rows the server says exist, or null.
     *         noun (string) - e.g. 'projects'.
     * Output: string - empty only when the filter is inactive.
     * Example: describeFilter(3, 71, 3416, 'projects')
     *   // -> 'filter matches 3 of 71 loaded projects. 3,416 exist; this
     *   //     filters rows already fetched, not the whole corpus.'
     */
    function describeFilter(matched, loaded, total, noun) {
        var line = 'filter matches ' + renderCount(matched) + ' of ' +
                   renderCount(loaded) + ' loaded ' + noun + '.';
        if (typeof total === 'number' && total > loaded) {
            line += ' ' + renderCount(total) + ' exist;';
        }
        return line + ' This filters rows already fetched, not the whole corpus.';
    }

    /**
     * Description: the label for one nav row, by kind. Pure.
     * Inputs: kind (string) - a NODE_KINDS value. row (object).
     * Output: string, never empty. A row with no name at all renders its
     *   id rather than a blank, because a blank row cannot be clicked
     *   with intent.
     */
    function labelFor(kind, row) {
        var r = row || {};
        if (kind === NODE_KINDS.HOST) {
            return String(r.display_name || r.hostname || ('host ' + r.host_id));
        }
        if (kind === NODE_KINDS.CORPUS) {
            return String(r.corpus_key || r.root_path || ('corpus ' + r.corpus_id));
        }
        if (kind === NODE_KINDS.UNATTRIBUTED) {
            return 'transcripts with no project';
        }
        var slug = r.slug || r.observed_cwd || ('project ' + r.project_id);
        return window.ArchiveFormat
            ? window.ArchiveFormat.shortenSlug(String(slug))
            : String(slug);
    }

    /**
     * Description: the id a row is addressed by, per kind. Pure.
     * Inputs: kind (string), row (object).
     * Output: number|string|null.
     */
    function idFor(kind, row) {
        var r = row || {};
        if (kind === NODE_KINDS.HOST) return r.host_id;
        if (kind === NODE_KINDS.CORPUS) return r.corpus_id;
        if (kind === NODE_KINDS.PROJECT) return r.project_id;
        return r.corpus_id;
    }

    /**
     * Description: the transcript count a row advertises, per kind.
     * Inputs: kind (string), row (object).
     * Output: number|null.
     */
    function countFor(kind, row) {
        var r = row || {};
        var v = kind === NODE_KINDS.PROJECT ? r.transcript_count
              : kind === NODE_KINDS.CORPUS ? r.transcript_count
              : kind === NODE_KINDS.UNATTRIBUTED ? r.unattributed_transcript_count
              : r.transcript_count;
        return typeof v === 'number' ? v : null;
    }

    /**
     * Description: render one row as a <li> carrying a selectable button
     *   and, for expandable kinds, an empty child slot.
     * Inputs: doc (Document), kind (string), row (object),
     *         opts (object) - {expandable: boolean, onActivate: function}
     * Output: Element - the <li>.
     */
    function renderRow(doc, kind, row, opts) {
        var options = opts || {};
        var id = idFor(kind, row);
        var li = el(doc, 'li', ROOT_CLASS + '__node ' + ROOT_CLASS + '__node--' + kind, null);
        li.setAttribute('data-node-kind', kind);
        li.setAttribute('data-node-id', String(id === null || id === undefined ? '' : id));

        var btn = el(doc, 'button', ROOT_CLASS + '__row', null);
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-action', options.expandable ? 'expand' : 'select');
        if (options.expandable) btn.setAttribute('aria-expanded', 'false');
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__label', labelFor(kind, row)));
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__count', renderCount(countFor(kind, row))));
        if (kind === NODE_KINDS.UNATTRIBUTED) {
            // Named in words as well as by class, because this node's
            // whole purpose is that it is easy to not notice.
            btn.appendChild(el(doc, 'span', ROOT_CLASS + '__note',
                'belongs to no project, invisible from the project tree'));
        }
        if (typeof options.onActivate === 'function') {
            btn.addEventListener('click', function () { options.onActivate(kind, id, row); });
        }
        li.appendChild(btn);
        if (options.expandable) {
            li.appendChild(el(doc, 'ul', ROOT_CLASS + '__children', null));
        }
        return li;
    }

    /**
     * Description: replace a node's child slot with a rendered outcome
     *   block. Used for every non-renderable envelope at every level, so
     *   a failed expand shows the reason where the person clicked rather
     *   than looking like an empty branch.
     * Inputs: doc (Document), slot (Element), envelope (object|null),
     *         transportError (string|null).
     * Output: void.
     */
    function renderOutcomeInto(doc, slot, envelope, transportError) {
        slot.textContent = '';
        var payload = envelope;
        if (transportError) {
            // callEnvelope never rejects; it reports the failure here.
            // Handing archive-outcome.js a null envelope is exactly how
            // it produces `transport-error`, which is the correct token.
            payload = null;
        }
        var host = el(doc, 'li', ROOT_CLASS + '__outcome', null);
        var block = window.ArchiveOutcomeView.renderOutcomeBlock(payload, { document: doc });
        if (transportError) {
            block.appendChild(el(doc, 'p', ROOT_CLASS + '__transport-reason', transportError));
        }
        host.appendChild(block);
        slot.appendChild(host);
    }

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
        filterInput.setAttribute('placeholder', 'filter loaded rows');
        filterInput.setAttribute('aria-label', 'Filter the rows already loaded');
        var filterNote = el(doc, 'p', ROOT_CLASS + '__filter-note', null);
        var hostList = el(doc, 'ul', ROOT_CLASS + '__level ' + ROOT_CLASS + '__level--hosts', null);
        root.appendChild(filterInput);
        root.appendChild(filterNote);
        root.appendChild(hostList);

        /** Rows fetched per level, keyed 'hosts' | 'corpora:<id>' | 'projects:<id>'. */
        var loaded = {};
        /** Server-declared totals per level key, for the honest filter note. */
        var totals = {};
        var filterText = '';

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

        filterInput.addEventListener('input', function () { setFilter(filterInput.value || ''); });

        return {
            element: root,
            loadHosts: loadHosts,
            expand: expand,
            setFilter: setFilter,
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
