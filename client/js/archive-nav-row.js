/**
 * The nav rail's VOCABULARY and its PURE RENDERERS: the node kinds the
 * rail can hold, and the functions that turn one server row into one
 * rail row, one count into a label, and one refusal envelope into a
 * visible block.
 *
 * WHY THIS IS SEPARATE FROM archive-nav.js. Everything here is a PURE
 * FUNCTION of its arguments. The sibling file owns the rail's STATE -
 * which nodes are expanded, which rows have been loaded, which filter
 * text is live, and every fetch that produces them. Nothing here reads
 * or writes any of that, which is why each function can be tested by
 * calling it with a document and a row.
 *
 * `unattributed` IS A FIRST-CLASS KIND, not a flag on a corpus. It is a
 * selectable scope in its own right, and modelling it as a flag would
 * make "no project" unrepresentable in the tree that has to show it.
 *
 * NOT_KNOWN IS A RENDERED STRING, NOT A ZERO. renderCount() prints it
 * whenever the server sent no count, because a count of 0 and a count
 * nobody measured are different findings and a rail that shows "0" for
 * both is lying about one of them.
 *
 * A REFUSAL IS RENDERED, NEVER SWALLOWED. renderOutcomeInto() puts the
 * envelope's own reason on screen; a rail that silently shows an empty
 * branch on a refused request is indistinguishable from a branch that
 * is genuinely empty.
 *
 * Exports window.ArchiveNavRow.
 */

console.log('[ArchiveNavRow Module] Loading...');

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

    window.ArchiveNavRow = {
        el: el,
        renderCount: renderCount,
        filterRows: filterRows,
        describeFilter: describeFilter,
        labelFor: labelFor,
        idFor: idFor,
        countFor: countFor,
        renderRow: renderRow,
        renderOutcomeInto: renderOutcomeInto,
        ROOT_CLASS: ROOT_CLASS,
        NODE_KINDS: NODE_KINDS,
        NOT_KNOWN: NOT_KNOWN
    };
    console.log('[ArchiveNavRow Module] Exported as window.ArchiveNavRow');
})();
