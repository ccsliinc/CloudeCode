/**
 * Archive transcript list - a project's transcripts, or a corpus's
 * unattributed ones, paged by opaque keyset cursor.
 *
 * THE MEASURED PROBLEM THIS LIST HAS TO SURVIVE (live server, 2026-08-31).
 * 19,588 of 21,039 transcripts (93.1%) are `session_ref_scheme = 'agent'`
 * sidechain files; only 1,451 are `uuid`-scheme, and 19 of THOSE carry a
 * session_ref that is not a UUID at all (literal values like `audit` and
 * `journal`). Project 12 alone holds 3,416. Somebody looking for a
 * conversation they had is reading a list that is 93 percent noise.
 *
 * THE FILTER IS NOW SERVER-SIDE (`session_ref_scheme`, shipped
 * 2026-08-31). Choosing a scheme RELOADS the listing with the filter on
 * the request, so what comes back is the project narrowed, not the
 * fetched page narrowed, and paging continues inside the filtered set.
 * The honesty text had to change with it: leaving the old sentence
 * ("this filters what has been FETCHED, not the scope") would have made
 * the UI lie in the OTHER direction.
 *
 * WHAT IT STILL MUST NOT CLAIM. The filter matches on the
 * `session_ref_scheme` COLUMN and on nothing else, which does not prove
 * conversation-ness - see the 19 non-UUID `uuid`-scheme rows above. The
 * server ships that caveat in `meta.filters.session_ref_scheme_means`
 * and this file RENDERS the server's sentence rather than keeping a
 * second copy that can drift. Counts come from `meta.filters` and the
 * server labels them scoped, never corpus totals. An unknown scheme is a
 * 400 handled by `paintOutcome` like any other non-renderable envelope;
 * a known scheme matching nothing is a 200 with `matched_in_scope: 0`,
 * which is a different statement and renders differently.
 *
 * `session_ref` IS NOT AN IDENTITY. Measured: `journal` names 14
 * different transcripts, `audit` 5, `agent-a877057` 4. Every link, key
 * and callback here carries `transcript_id`; `session_ref` reaches the
 * DOM only as display text. This also drives the export filename
 * collision warning (archive-export.js).
 *
 * `has_more` IS A THREE-OUTCOME FIELD. The server returns `null` on
 * every failure path - measured, the budget_exhausted search answered
 * `"has_more": null`. `null` is not `false`. The load-more control is
 * rendered on `=== true` and nothing else; `null` renders "whether there
 * is more: NOT KNOWN". Treating null as false claims the end of a list
 * that was never read.
 *
 * UNATTRIBUTED AND cannot_determine ARE DIFFERENT AND ARE NEVER MERGED.
 * A transcript in the unattributed listing belongs to no PROJECT; one
 * with `host_attribution: "cannot_determine"` has no established HOST.
 * Either can be true without the other, and each gets its own badge.
 *
 * Does not read `result_status`. No innerHTML: session_ref and
 * source_path are file-derived strings.
 */

console.log('[ArchiveTranscriptList Module] Loading...');

(function () {
    'use strict';

    /** Root element class. @type {string} */
    var ROOT_CLASS = 'archive-tlist';

    /** Rows requested per page. The server's own default is 50. @type {number} */
    var PAGE_SIZE = 50;

    /**
     * The three scheme filters this list offers. `all` is the default
     * BECAUSE it is the only one that is not a partial view.
     * @type {Object<string,string>}
     */
    var SCHEME_FILTERS = {
        ALL: 'all',
        CONVERSATIONS: 'uuid',
        SIDECHAINS: 'agent'
    };

    /**
     * Attribution values that mean "not established". Kept as a list so
     * a new server value does not silently classify as established.
     * @type {string[]}
     */
    var UNESTABLISHED_ATTRIBUTION = ['cannot_determine', 'unknown'];

    /**
     * Description: build an element with a class and optional text.
     * Inputs: doc (Document), tag (string), cls (string|null), text (any).
     * Output: Element.
     */
    function el(doc, tag, cls, text) {
        var node = doc.createElement(tag);
        if (cls) node.setAttribute('class', cls);
        if (text !== null && text !== undefined) node.textContent = String(text);
        return node;
    }

    /**
     * Description: translate a UI filter choice into the wire value the
     *   server takes, or null for "do not send the parameter". Pure.
     *
     *   `null` and `'all'` are not interchangeable on the wire: sending
     *   `session_ref_scheme=all` would be an UNKNOWN scheme and answer
     *   400, so "no filter" has to be an omitted parameter.
     * Inputs: scheme (string) - a SCHEME_FILTERS value.
     * Output: string|null.
     * Example: wireScheme('all') // -> null
     */
    function wireScheme(scheme) {
        if (!scheme || scheme === SCHEME_FILTERS.ALL) return null;
        return scheme;
    }

    /**
     * Description: the sentence under the list, built from what the
     *   SERVER reported rather than from what this file counted. Pure.
     *
     *   It states three separate things and does not merge them: how
     *   many rows are on screen, how many the whole scope holds under
     *   this filter, and what the filter is actually matching on. The
     *   third comes from the server's own `session_ref_scheme_means`, so
     *   there is one wording and it cannot drift from the API's.
     * Inputs: loaded (number) - rows on screen, filters (object|null) -
     *         the server's `meta.filters` block, or null when the last
     *         response carried none.
     * Output: string - '' when no filter is applied and nothing is hidden.
     * Example: describeFilter(50, {applied: true, matched_in_scope: 77,
     *          scope_total_before_filter: 3416, session_ref_scheme: 'uuid'})
     */
    function describeFilter(loaded, filters) {
        if (!filters || filters.applied !== true) return '';
        var noun = filters.session_ref_scheme === SCHEME_FILTERS.CONVERSATIONS
            ? 'conversations (uuid scheme)' : 'agent sidechains';
        var line = 'Showing ' + fmtCount(loaded) + ' ' + noun + '.';
        if (typeof filters.matched_in_scope === 'number') {
            line += ' The server filtered the WHOLE scope, which holds ' +
                    fmtCount(filters.matched_in_scope) + ' rows with this scheme';
            if (typeof filters.scope_total_before_filter === 'number') {
                line += ' out of ' + fmtCount(filters.scope_total_before_filter);
            }
            line += '.';
        } else {
            line += ' The server did not report how many rows in this scope' +
                    ' carry this scheme, so that number is NOT KNOWN.';
        }
        if (typeof filters.session_ref_scheme_means === 'string') {
            line += ' Caveat from the server: ' + filters.session_ref_scheme_means;
        }
        return line;
    }

    /**
     * Description: format a count, deferring to archive-format.js when
     *   it is loaded so grouping is identical everywhere.
     * Inputs: n (number|null). Output: string.
     */
    function fmtCount(n) {
        return window.ArchiveFormat ? window.ArchiveFormat.formatCount(n) : String(n);
    }

    /**
     * Description: whether an attribution field states a real finding or
     *   states that nothing was established. Pure.
     * Inputs: value (string|null).
     * Output: boolean - true when the link was NOT established.
     * Example: isUnestablished('cannot_determine')  // -> true
     */
    function isUnestablished(value) {
        return UNESTABLISHED_ATTRIBUTION.indexOf(String(value)) !== -1;
    }

    /**
     * Description: render one transcript row. Keyed and linked on
     *   transcript_id only; session_ref appears as text and never as an
     *   identity.
     * Inputs: doc (Document), row (object),
     *         opts (object) - {onSelect: function(transcriptId, row),
     *                          unattributed: boolean}
     * Output: Element - the <li>.
     */
    function renderRow(doc, row, opts) {
        var options = opts || {};
        var r = row || {};
        var li = el(doc, 'li', ROOT_CLASS + '__row', null);
        li.setAttribute('data-transcript-id', String(r.transcript_id));
        li.setAttribute('data-scheme', String(r.session_ref_scheme || 'unknown'));

        var btn = el(doc, 'button', ROOT_CLASS + '__open', null);
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-action', 'open-transcript');
        // The id is the addressable thing and it goes on the control, so
        // no click path can end up keyed on the label.
        btn.setAttribute('data-transcript-id', String(r.transcript_id));

        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__ref',
            String(r.session_ref === null || r.session_ref === undefined
                ? 'no session_ref recorded' : r.session_ref)));
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__id', 'transcript ' + r.transcript_id));
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__lines',
            fmtCount(r.line_count) + ' lines'));
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__bytes',
            window.ArchiveFormat ? window.ArchiveFormat.formatBytes(r.raw_byte_length)
                                 : String(r.raw_byte_length)));
        btn.appendChild(el(doc, 'span', ROOT_CLASS + '__ingested',
            window.ArchiveFormat ? window.ArchiveFormat.formatTimestamp(r.ingested_at)
                                 : String(r.ingested_at)));

        // The two attribution conditions, side by side and never merged.
        if (options.unattributed) {
            btn.appendChild(el(doc, 'span',
                ROOT_CLASS + '__badge ' + ROOT_CLASS + '__badge--no-project',
                'NO PROJECT: this transcript is attributed to no project'));
        }
        if (isUnestablished(r.host_attribution)) {
            btn.appendChild(el(doc, 'span',
                ROOT_CLASS + '__badge ' + ROOT_CLASS + '__badge--host-unknown',
                'HOST NOT ESTABLISHED: host_attribution is ' + String(r.host_attribution) +
                '. This is a separate condition from having no project.'));
        }
        if (typeof options.onSelect === 'function') {
            btn.addEventListener('click', function () {
                options.onSelect(r.transcript_id, r);
            });
        }
        li.appendChild(btn);
        return li;
    }

    /**
     * Description: build the transcript list view.
     * Inputs: options (object) -
     *   document (Document), api (object) - exposing
     *     listArchiveTranscripts and listArchiveUnattributed.
     *   onSelect (function(transcriptId, row)).
     * Output: {element, load, loadMore, setSchemeFilter, rows}
     * Example:
     *   var list = ArchiveTranscriptList.create({api: window.API});
     *   await list.load({kind: 'project', id: 12, inScope: 3416});
     */
    function create(options) {
        var opts = options || {};
        var doc = opts.document || (typeof window !== 'undefined' ? window.document : null);
        if (!doc) throw new Error('ArchiveTranscriptList.create needs a document');
        var api = opts.api;
        var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};

        var root = el(doc, 'section', ROOT_CLASS, null);
        var header = el(doc, 'div', ROOT_CLASS + '__header', null);
        var splitNote = el(doc, 'p', ROOT_CLASS + '__split-note', null);
        var rowList = el(doc, 'ul', ROOT_CLASS + '__rows', null);
        var footer = el(doc, 'div', ROOT_CLASS + '__footer', null);
        root.appendChild(header);
        root.appendChild(splitNote);
        root.appendChild(rowList);
        root.appendChild(footer);

        var scope = { kind: null, id: null, inScope: null };
        var rows = [];
        var nextCursor = null;
        var hasMore = null;
        var scheme = SCHEME_FILTERS.ALL;
        // The server's meta.filters from the LAST renderable page. Null
        // until one arrives, so "no filter block" is distinguishable
        // from "a filter block saying applied:false".
        var filters = null;

        header.appendChild(buildSchemeControls());

        /**
         * Description: build the three scheme buttons.
         * Inputs: none. Output: Element.
         */
        function buildSchemeControls() {
            var box = el(doc, 'div', ROOT_CLASS + '__schemes', null);
            var defs = [
                { v: SCHEME_FILTERS.ALL, label: 'All rows' },
                { v: SCHEME_FILTERS.CONVERSATIONS, label: 'Conversations only' },
                { v: SCHEME_FILTERS.SIDECHAINS, label: 'Agent sidechains only' }
            ];
            for (var i = 0; i < defs.length; i++) {
                (function (def) {
                    var b = el(doc, 'button', ROOT_CLASS + '__scheme', def.label);
                    b.setAttribute('type', 'button');
                    b.setAttribute('data-scheme-filter', def.v);
                    b.addEventListener('click', function () { setSchemeFilter(def.v); });
                    box.appendChild(b);
                })(defs[i]);
            }
            return box;
        }

        /**
         * Description: repaint the row list and the honesty note.
         * Inputs: none. Output: void.
         */
        function paint() {
            rowList.textContent = '';
            // No client-side filtering happens here any more. Every row
            // in `rows` already satisfies the filter, because the SERVER
            // applied it across the whole scope. Filtering again here
            // would be a second, invisible rule that could disagree with
            // the counts the note quotes.
            for (var i = 0; i < rows.length; i++) {
                rowList.appendChild(renderRow(doc, rows[i], {
                    onSelect: onSelect,
                    unattributed: scope.kind === 'unattributed'
                }));
            }
            splitNote.textContent = describeFilter(rows.length, filters);
            paintFooter();
        }

        /**
         * Description: render the paging footer. `has_more === true` is
         *   the ONLY input that produces a load-more control; `null`
         *   produces a stated unknown and `false` produces a stated end.
         * Inputs: none. Output: void.
         */
        function paintFooter() {
            footer.textContent = '';
            if (hasMore === true) {
                var more = el(doc, 'button', ROOT_CLASS + '__more',
                    'Load ' + PAGE_SIZE + ' more');
                more.setAttribute('type', 'button');
                more.setAttribute('data-action', 'load-more');
                more.addEventListener('click', function () { loadMore(); });
                footer.appendChild(more);
                return;
            }
            if (hasMore === false) {
                footer.appendChild(el(doc, 'p', ROOT_CLASS + '__end',
                    'End of the list. All ' + fmtCount(rows.length) +
                    ' rows in this scope have been loaded.'));
                return;
            }
            footer.appendChild(el(doc, 'p',
                ROOT_CLASS + '__end ' + ROOT_CLASS + '__end--unknown',
                'Whether there is more beyond these ' + fmtCount(rows.length) +
                ' rows: NOT KNOWN. The server did not answer has_more, which is' +
                ' not the same as answering that there is nothing more.'));
        }

        /**
         * Description: render a non-renderable envelope in place of the
         *   rows, or beneath them for `partial`.
         * Inputs: envelope (object|null), transportError (string|null),
         *         keepRows (boolean). Output: void.
         */
        function paintOutcome(envelope, transportError, keepRows) {
            if (!keepRows) rowList.textContent = '';
            footer.textContent = '';
            var block = window.ArchiveOutcomeView.renderOutcomeBlock(
                transportError ? null : envelope, { document: doc });
            if (transportError) {
                block.appendChild(el(doc, 'p', ROOT_CLASS + '__transport-reason',
                    transportError));
            }
            footer.appendChild(block);
        }

        /**
         * Description: apply one page response, appending rows.
         * Inputs: r (object) - a callEnvelope result.
         * Output: string - the outcome token.
         */
        function applyPage(r) {
            var envelope = r.transportError ? null : r.envelope;
            var classified = window.ArchiveOutcome.classify(envelope);
            if (!window.ArchiveOutcome.isRenderable(classified.token)) {
                // The malformed-cursor case must NOT silently restart.
                // A client paging 3,416 rows that restarts on its own
                // renders duplicates forever, so the two recovery paths
                // are offered as explicit actions instead.
                paintOutcome(r.envelope, r.transportError, rows.length > 0);
                nextCursor = null;
                hasMore = null;
                return classified.token;
            }
            var page = (envelope && envelope.result) || [];
            rows = rows.concat(page);
            var meta = classified.meta || {};
            var paging = (meta.paging && typeof meta.paging === 'object') ? meta.paging : {};
            nextCursor = typeof paging.next_cursor === 'string' ? paging.next_cursor : null;
            hasMore = window.ArchiveOutcome.hasMore(envelope);
            filters = (meta.filters && typeof meta.filters === 'object')
                ? meta.filters : null;
            if (typeof meta.unattributed_transcript_count === 'number' &&
                    scope.kind === 'unattributed') {
                scope.inScope = meta.unattributed_transcript_count;
            }
            paint();
            if (classified.token === 'partial') {
                paintOutcome(envelope, null, true);
            }
            return classified.token;
        }

        /**
         * Description: issue one page request for the current scope.
         * Inputs: cursor (string|null). Output: Promise<object>.
         */
        function fetchPage(cursor) {
            if (scope.kind === 'unattributed') {
                // The unattributed route takes no scheme filter, so the
                // control is hidden for that scope rather than sent and
                // silently ignored - a control that does nothing is
                // worse than no control.
                return Promise.resolve(
                    api.listArchiveUnattributed(scope.id, { limit: PAGE_SIZE, cursor: cursor }));
            }
            return Promise.resolve(
                api.listArchiveTranscripts(scope.id, {
                    limit: PAGE_SIZE,
                    cursor: cursor,
                    sessionRefScheme: wireScheme(scheme)
                }));
        }

        /**
         * Description: start a NEW listing. Discards every prior row,
         *   because a scope change is a different question.
         * Inputs: next (object) - {kind: 'project'|'unattributed', id,
         *   inScope: number|null}.
         * Output: Promise<string> - the outcome token.
         */
        function load(next) {
            scope = {
                kind: (next && next.kind) || 'project',
                id: next && next.id,
                inScope: (next && typeof next.inScope === 'number') ? next.inScope : null
            };
            rows = [];
            nextCursor = null;
            hasMore = null;
            filters = null;
            rowList.textContent = '';
            footer.textContent = '';
            footer.appendChild(el(doc, 'p', ROOT_CLASS + '__loading', 'loading...'));
            return fetchPage(null).then(applyPage);
        }

        /**
         * Description: fetch the next page. Refuses when the previous
         *   response did not supply a cursor, rather than re-requesting
         *   page one, which would duplicate rows.
         * Inputs: none. Output: Promise<string>.
         */
        function loadMore() {
            if (!nextCursor) return Promise.resolve('no-cursor');
            return fetchPage(nextCursor).then(applyPage);
        }

        /**
         * Description: change the scheme filter and RE-QUERY the scope.
         *
         *   It reloads rather than repaints, because the filter is now
         *   the server's and the answer to "show me the conversations"
         *   is a different query, not a subset of the rows this list
         *   happens to hold. Repainting would silently return the old
         *   client-side behaviour while the honesty text claimed the
         *   whole scope had been filtered.
         *
         *   The cursor is discarded deliberately: a cursor minted under
         *   one filter positions inside that filter's result set, and
         *   replaying it under another would skip rows.
         * Inputs: value (string) - a SCHEME_FILTERS value.
         * Output: Promise<string> - the outcome token for the reload, or
         *   'no-scope' when nothing has been loaded yet.
         */
        function setSchemeFilter(value) {
            scheme = value || SCHEME_FILTERS.ALL;
            if (scope.id === null || scope.id === undefined) {
                return Promise.resolve('no-scope');
            }
            return load({ kind: scope.kind, id: scope.id, inScope: scope.inScope });
        }

        return {
            element: root,
            load: load,
            loadMore: loadMore,
            setSchemeFilter: setSchemeFilter,
            /** Description: loaded rows, for tests. Output: Array. */
            rows: function () { return rows.slice(); },
            /** Description: the paging cursor, for tests. Output: string|null. */
            cursor: function () { return nextCursor; },
            /** Description: has_more as received. Output: boolean|null. */
            hasMore: function () { return hasMore; }
        };
    }

    window.ArchiveTranscriptList = {
        create: create,
        wireScheme: wireScheme,
        describeFilter: describeFilter,
        isUnestablished: isUnestablished,
        renderRow: renderRow,
        SCHEME_FILTERS: SCHEME_FILTERS,
        UNESTABLISHED_ATTRIBUTION: UNESTABLISHED_ATTRIBUTION,
        PAGE_SIZE: PAGE_SIZE,
        ROOT_CLASS: ROOT_CLASS
    };
    console.log('[ArchiveTranscriptList Module] Exported as window.ArchiveTranscriptList');
})();
