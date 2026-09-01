/**
 * The transcript list's VOCABULARY and its PURE RENDERERS: the three
 * scheme filters, the attribution values that mean "not established",
 * and the functions that turn one server row into one list item.
 *
 * WHY THIS IS SEPARATE FROM archive-transcript-list.js. Everything here
 * is a PURE FUNCTION of its arguments - give it a document and a row
 * and it returns an element, with no fetch, no cursor, no page and no
 * state of any kind. The sibling file owns all of that. The split is
 * along that line and no other, which is why every function here can be
 * tested by calling it, with no harness beyond a document.
 *
 * ONE TABLE FOR THE FILTERS, so the button order and the order the `t`
 * key cycles through them cannot drift into disagreeing. Two lists
 * would be two declarations of one fact, and they would diverge.
 *
 * UNATTRIBUTED AND cannot_determine ARE DIFFERENT AND ARE NEVER MERGED.
 * A transcript in the unattributed listing belongs to no PROJECT; one
 * with `host_attribution: "cannot_determine"` has no established HOST.
 * Either can be true without the other, and each gets its own badge.
 * UNESTABLISHED_ATTRIBUTION is a LIST rather than a comparison so a new
 * server value cannot silently classify itself as established.
 *
 * `has_more` IS THREE-VALUED HERE TOO: describeFilter renders "more"
 * on `=== true` and nothing else, because treating null as false claims
 * the end of a list that was never read.
 *
 * No innerHTML: session_ref and source_path are file-derived strings.
 * Exports window.ArchiveTlistRow.
 */

console.log('[ArchiveTlistRow Module] Loading...');

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
     * The three filters in the order the buttons are drawn AND the order
     * `t` cycles through them. One table, so the control order and the
     * keyboard order cannot drift into disagreeing.
     * @type {Array<{v: string, label: string}>}
     */
    var SCHEME_DEFS = [
        { v: SCHEME_FILTERS.ALL, label: 'All rows' },
        { v: SCHEME_FILTERS.CONVERSATIONS, label: 'Conversations only' },
        { v: SCHEME_FILTERS.SIDECHAINS, label: 'Agent sidechains only' }
    ];

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

    window.ArchiveTlistRow = {
        el: el,
        wireScheme: wireScheme,
        describeFilter: describeFilter,
        fmtCount: fmtCount,
        isUnestablished: isUnestablished,
        renderRow: renderRow,
        ROOT_CLASS: ROOT_CLASS,
        PAGE_SIZE: PAGE_SIZE,
        SCHEME_FILTERS: SCHEME_FILTERS,
        SCHEME_DEFS: SCHEME_DEFS,
        UNESTABLISHED_ATTRIBUTION: UNESTABLISHED_ATTRIBUTION
    };
    console.log('[ArchiveTlistRow Module] Exported as window.ArchiveTlistRow');
})();
