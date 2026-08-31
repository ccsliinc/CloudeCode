/**
 * Archive search - scoped search, its coverage statement, and its TWO
 * distinct resume affordances.
 *
 * THE PROPERTY THIS FILE EXISTS TO PROTECT.
 * `meta.scan.status` has FOUR values and a zero-hit result means a
 * completely different thing under two of them:
 *
 *   complete          I read the whole scope. There is nothing there.
 *   budget_exhausted  I stopped partway. I do not know what is in the
 *                     2,615 transcripts I never opened.
 *   limit_reached     I filled the page. There are more MATCHES.
 *   not_run           No scan happened at all. Every count is null.
 *
 * A zero-hit `budget_exhausted` rendered like a zero-hit `complete` tells
 * a person the archive contains no occurrence of their term when 76
 * percent of the scope was never read. That is the false green this
 * whole screen exists to prevent, and this is the file where it would be
 * manufactured.
 *
 * TWO CURSORS, TWO MEANINGS, NEVER CROSSED. Measured live 2026-08-31 and
 * they are exactly complementary, which is precisely what makes reading
 * the wrong one so easy to do and so hard to notice:
 *
 *   limit_reached     meta.paging.next_cursor SET, meta.scan.resume_cursor NULL
 *   budget_exhausted  meta.paging.next_cursor NULL, meta.scan.resume_cursor SET
 *
 * Read the wrong field and you get null, which looks like "cannot
 * resume" - a plausible, quiet, wrong answer. So `resumeAffordance()`
 * below reads ONE named field per scan status and there is no fallback
 * between them: a missing cursor is reported as a BLOCKED affordance
 * naming the field that was absent, never silently swapped for the other
 * one.
 *
 * `result_status: "ok"` DOES NOT MEAN THE SCOPE WAS READ. Measured:
 * q=restic&project_id=12&limit=3 answered `ok` with `limit_reached`,
 * `transcripts_scanned: 1`, `transcripts_not_scanned: 3415`. So the
 * coverage line renders on EVERY outcome including `ok`.
 *
 * NEVER A BYTE PROGRESS BAR. `scan.bytes_scanned` is a CHARGE: measured
 * at 551,648,566 against a budget_bytes of 536,870,912, 2.75 percent
 * OVER its own budget. A quantity that exceeds its own budget cannot be
 * a fraction of anything. Progress is transcripts_scanned over
 * transcripts_in_scope, both integers, both monotone.
 *
 * A WITHHELD SNIPPET IS A REAL HIT. Secret-bearing matches arrive with
 * `snippet: null` and a `snippet_state`; the server says so itself with
 * `withholding_never_suppresses_a_hit: true`. The row still renders with
 * its transcript, line and offset, reading as "preview withheld", never
 * as an error and never as a missing result.
 *
 * This file is the only interpreter of `meta.scan.status`, for the same
 * reason archive-outcome.js is the only interpreter of `result_status`:
 * two branch sets on one field drift, and one starts calling a
 * budget_exhausted a complete.
 *
 * No innerHTML. Snippet masking is archive-mask.js's concern, not this
 * file's.
 */

console.log('[ArchiveSearch Module] Loading...');

(function () {
    'use strict';

    /** Root element class. @type {string} */
    var ROOT_CLASS = 'archive-search';

    /**
     * Every `scan.status` this client recognises. Membership is checked,
     * not equality, so a value the server invents later reports as
     * unknown rather than as a completed scan.
     * @type {string[]}
     */
    var SCAN_STATUSES = ['complete', 'budget_exhausted', 'limit_reached', 'not_run'];

    /**
     * The resume kinds. These are what the two cursors MEAN, kept apart
     * by name so no call site can confuse "more matches on this page
     * boundary" with "more of the scope was never opened".
     * @type {Object<string,string>}
     */
    var RESUME_KINDS = {
        NONE: 'none',
        MORE_HITS: 'more-hits',
        MORE_SCOPE: 'more-scope',
        NOT_RUN: 'not-run',
        UNKNOWN: 'unknown'
    };

    /**
     * Snippet states that mean the preview was deliberately withheld.
     * The HIT is still real under every one of them.
     * @type {string[]}
     */
    var WITHHELD_STATES = ['withheld_secret_bearing', 'withheld_known_secret_value'];

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
     * Description: read `meta.scan.status`, checked for membership.
     * Inputs: envelope (object|null).
     * Output: string - a SCAN_STATUSES value, or 'unknown' when the
     *   server reported no scan block or a value this client does not
     *   recognise. Never defaults to 'complete'.
     * Example: scanStatus({meta:{scan:{status:'budget_exhausted'}}})
     *   // -> 'budget_exhausted'
     */
    function scanStatus(envelope) {
        var meta = envelope && envelope.meta;
        var scan = meta && meta.scan;
        var s = scan && scan.status;
        return SCAN_STATUSES.indexOf(s) === -1 ? 'unknown' : s;
    }

    /**
     * Description: decide how, and whether, this response can be
     *   continued - and from WHICH cursor.
     *
     *   THE ONE RULE: each scan status reads exactly ONE named cursor
     *   field and there is no fallback to the other. `limit_reached`
     *   reads `meta.paging.next_cursor` and nothing else.
     *   `budget_exhausted` reads `meta.scan.resume_cursor` and nothing
     *   else. Falling back would produce a control that resumes the
     *   wrong dimension: continuing the SCAN when the person asked for
     *   more MATCHES silently re-reads scope they have already seen, and
     *   continuing the PAGE when the scan is unfinished skips the
     *   2,615 transcripts nobody opened while looking like it did not.
     *
     *   A missing cursor is reported as blocked, with the field named.
     *   It is never swapped.
     *
     * Inputs: envelope (object|null) - a parsed search response.
     * Output: {kind: string, cursor: string|null, field: string|null,
     *          label: string, blocked: boolean, reason: string}
     *   kind is a RESUME_KINDS value. `field` names the ONLY meta field
     *   consulted, so a test can assert the wiring rather than the text.
     * Example:
     *   resumeAffordance({meta:{scan:{status:'limit_reached'},
     *                           paging:{next_cursor:'abc'}}})
     *   // -> {kind:'more-hits', cursor:'abc',
     *   //     field:'meta.paging.next_cursor', blocked:false, ...}
     */
    function resumeAffordance(envelope) {
        var status = scanStatus(envelope);
        var meta = (envelope && envelope.meta) || {};

        if (status === 'complete') {
            return {
                kind: RESUME_KINDS.NONE, cursor: null, field: null, blocked: false,
                label: 'Nothing to resume',
                reason: 'The scan reported complete: every transcript in scope was read.'
            };
        }
        if (status === 'not_run') {
            return {
                kind: RESUME_KINDS.NOT_RUN, cursor: null, field: null, blocked: true,
                label: 'Nothing to resume',
                reason: 'No scan ran, so there is no position to resume from. ' +
                        'Every count on this response is null, not zero: nothing was measured.'
            };
        }
        if (status === 'limit_reached') {
            var paging = (meta.paging && typeof meta.paging === 'object') ? meta.paging : {};
            var next = typeof paging.next_cursor === 'string' ? paging.next_cursor : null;
            return {
                kind: RESUME_KINDS.MORE_HITS,
                cursor: next,
                field: 'meta.paging.next_cursor',
                blocked: next === null,
                label: 'Load more matches',
                reason: next === null
                    ? 'The page limit was reached but meta.paging.next_cursor is absent, ' +
                      'so the next page cannot be requested.'
                    : 'The page limit was reached. There are more MATCHES beyond this page. ' +
                      'This does not say the whole scope was read.'
            };
        }
        if (status === 'budget_exhausted') {
            var scan = (meta.scan && typeof meta.scan === 'object') ? meta.scan : {};
            var resume = typeof scan.resume_cursor === 'string' ? scan.resume_cursor : null;
            return {
                kind: RESUME_KINDS.MORE_SCOPE,
                cursor: resume,
                field: 'meta.scan.resume_cursor',
                blocked: resume === null,
                label: 'Resume the scan',
                reason: resume === null
                    ? 'The scan budget was spent but meta.scan.resume_cursor is absent, ' +
                      'so the unread part of the scope cannot be reached from here.'
                    : 'The scan budget was spent before the scope was finished. ' +
                      'Resuming reads MORE OF THE SCOPE, not more matches from what was read.'
            };
        }
        return {
            kind: RESUME_KINDS.UNKNOWN, cursor: null, field: null, blocked: true,
            label: 'Nothing to resume',
            reason: 'The server reported no scan status this client recognises, ' +
                    'so whether anything remains unread is NOT KNOWN.'
        };
    }

    /**
     * Description: the coverage sentence, rendered on EVERY outcome
     *   including `ok`, because `ok` is compatible with having read one
     *   transcript out of 3,416. Pure.
     * Inputs: envelope (object|null).
     * Output: string, never empty.
     * Example: coverageSentence(limitReachedEnvelope)
     *   // -> 'Coverage: 1 of 3416 transcripts in scope were read...'
     */
    function coverageSentence(envelope) {
        var meta = (envelope && envelope.meta) || {};
        var scan = (meta.scan && typeof meta.scan === 'object') ? meta.scan : {};
        var scope = (meta.scope && typeof meta.scope === 'object') ? meta.scope : {};
        var scanned = typeof scan.transcripts_scanned === 'number'
            ? scan.transcripts_scanned : null;
        var inScope = typeof scope.transcripts_in_scope === 'number'
            ? scope.transcripts_in_scope : null;
        if (scanned === null || inScope === null) {
            return 'Coverage: NOT KNOWN. The server did not report how much of the scope ' +
                   'it read, so this result says nothing about what was not read.';
        }
        var line = 'Coverage: ' + scanned + ' of ' + inScope +
                   ' transcripts in scope were read.';
        if (scanned < inScope) {
            line += ' ' + (inScope - scanned) + ' were NOT read; nothing is known about them.';
        }
        return line;
    }

    /**
     * Description: scan progress as a fraction of TRANSCRIPTS. Never
     *   bytes - see the header note on bytes_scanned overshooting its own
     *   budget. Pure.
     * Inputs: envelope (object|null).
     * Output: {scanned: number|null, inScope: number|null,
     *          fraction: number|null} - fraction is null whenever either
     *   integer is missing, so a caller cannot render a bar over a guess.
     */
    function scanProgress(envelope) {
        var meta = (envelope && envelope.meta) || {};
        var scan = (meta.scan && typeof meta.scan === 'object') ? meta.scan : {};
        var scope = (meta.scope && typeof meta.scope === 'object') ? meta.scope : {};
        var scanned = typeof scan.transcripts_scanned === 'number'
            ? scan.transcripts_scanned : null;
        var inScope = typeof scope.transcripts_in_scope === 'number'
            ? scope.transcripts_in_scope : null;
        var fraction = (scanned !== null && inScope !== null && inScope > 0)
            ? scanned / inScope : null;
        return { scanned: scanned, inScope: inScope, fraction: fraction };
    }

    /**
     * Description: whether a hit's preview was withheld on purpose. Pure.
     * Inputs: hit (object).
     * Output: boolean.
     * Example: isWithheld({snippet_state: 'withheld_secret_bearing'}) // -> true
     */
    function isWithheld(hit) {
        return !!hit && WITHHELD_STATES.indexOf(String(hit.snippet_state)) !== -1;
    }

    /**
     * Description: render one search hit. A withheld-preview hit renders
     *   with the SAME structure and the SAME locating facts as any other
     *   hit - transcript, line, offset - because the hit is real. Only
     *   the preview cell differs, and it says in words that the preview
     *   was withheld and why. It is not an error row and it is not an
     *   absent row.
     * Inputs: doc (Document), hit (object),
     *         opts (object) - {onOpen: function(transcriptId, lineNo)}.
     * Output: Element - the <li>.
     */
    function renderHit(doc, hit, opts) {
        var options = opts || {};
        var h = hit || {};
        var withheld = isWithheld(h);
        var li = el(doc, 'li', ROOT_CLASS + '__hit', null);
        li.setAttribute('data-transcript-id', String(h.transcript_id));
        li.setAttribute('data-line-no', String(h.line_no));
        li.setAttribute('data-snippet-state', String(h.snippet_state || 'unknown'));
        if (withheld) li.setAttribute('data-preview', 'withheld');

        var loc = el(doc, 'button', ROOT_CLASS + '__hit-loc', null);
        loc.setAttribute('type', 'button');
        loc.setAttribute('data-action', 'open-hit');
        // Routing is on transcript_id ONLY. session_ref names 14
        // different transcripts in this corpus and is a label, not an id.
        loc.setAttribute('data-transcript-id', String(h.transcript_id));
        loc.appendChild(el(doc, 'span', ROOT_CLASS + '__hit-transcript',
            'transcript ' + h.transcript_id));
        loc.appendChild(el(doc, 'span', ROOT_CLASS + '__hit-ref',
            String(h.session_ref === null || h.session_ref === undefined
                ? 'no session_ref recorded' : h.session_ref)));
        loc.appendChild(el(doc, 'span', ROOT_CLASS + '__hit-line', 'line ' + h.line_no));
        loc.appendChild(el(doc, 'span', ROOT_CLASS + '__hit-offset',
            'offset ' + h.match_offset + ', length ' + h.match_length));
        if (typeof options.onOpen === 'function') {
            loc.addEventListener('click', function () {
                options.onOpen(h.transcript_id, h.line_no);
            });
        }
        li.appendChild(loc);

        if (withheld) {
            var box = el(doc, 'div', ROOT_CLASS + '__preview ' + ROOT_CLASS + '__preview--withheld', null);
            box.appendChild(el(doc, 'span', ROOT_CLASS + '__preview-label', 'PREVIEW WITHHELD'));
            box.appendChild(el(doc, 'span', ROOT_CLASS + '__preview-note',
                'This match IS real and IS at the position named above. The server ' +
                'declined to send preview text because this body carries ' +
                (typeof h.secret_finding_count === 'number'
                    ? h.secret_finding_count + ' secret finding(s)' : 'secret findings') +
                ' (' + String(h.snippet_state) + '). Open the line to read it with masking applied.'));
            li.appendChild(box);
        } else {
            li.appendChild(el(doc, 'div', ROOT_CLASS + '__preview',
                h.snippet === null || h.snippet === undefined
                    ? 'no preview text supplied' : String(h.snippet)));
        }
        return li;
    }

    /**
     * Description: build the search view.
     * Inputs: options (object) - {document, api, onOpenHit}.
     * Output: {element, run, resume, lastAffordance}
     * Example:
     *   var s = ArchiveSearch.create({api: window.API});
     *   await s.run({q: 'restic', projectId: 12});
     */
    function create(options) {
        var opts = options || {};
        var doc = opts.document || (typeof window !== 'undefined' ? window.document : null);
        if (!doc) throw new Error('ArchiveSearch.create needs a document');
        var api = opts.api;
        var onOpenHit = typeof opts.onOpenHit === 'function' ? opts.onOpenHit : function () {};

        var root = el(doc, 'section', ROOT_CLASS, null);
        var coverage = el(doc, 'p', ROOT_CLASS + '__coverage', null);
        var hitList = el(doc, 'ul', ROOT_CLASS + '__hits', null);
        var footer = el(doc, 'div', ROOT_CLASS + '__footer', null);
        root.appendChild(coverage);
        root.appendChild(hitList);
        root.appendChild(footer);

        var query = null;
        var hits = [];
        var affordance = null;

        /**
         * Description: render the resume control for the CURRENT
         *   affordance. The two kinds get different labels, different
         *   data-resume-kind values and different explanatory text, so
         *   they are distinguishable on structure and not only on prose.
         * Inputs: none. Output: void.
         */
        function paintResume() {
            if (!affordance) return;
            var box = el(doc, 'div', ROOT_CLASS + '__resume', null);
            box.setAttribute('data-resume-kind', affordance.kind);
            box.appendChild(el(doc, 'p', ROOT_CLASS + '__resume-reason', affordance.reason));
            if (affordance.kind === RESUME_KINDS.MORE_HITS ||
                    affordance.kind === RESUME_KINDS.MORE_SCOPE) {
                var btn = el(doc, 'button', ROOT_CLASS + '__resume-btn', affordance.label);
                btn.setAttribute('type', 'button');
                btn.setAttribute('data-action',
                    affordance.kind === RESUME_KINDS.MORE_HITS ? 'load-more-hits' : 'resume-scan');
                btn.setAttribute('data-cursor-field', affordance.field);
                if (affordance.blocked) {
                    // A control that silently fails is worse than a
                    // stated blocker, so it is emitted and disabled with
                    // the reason attached rather than dropped.
                    btn.setAttribute('disabled', '');
                    btn.setAttribute('data-blocked-reason', affordance.reason);
                } else {
                    btn.addEventListener('click', function () { resume(); });
                }
                box.appendChild(btn);
            }
            footer.appendChild(box);
        }

        /**
         * Description: apply one search response.
         * Inputs: r (object) - a callEnvelope result. append (boolean).
         * Output: string - the outcome token.
         */
        function apply(r, append) {
            var envelope = r.transportError ? null : r.envelope;
            var classified = window.ArchiveOutcome.classify(envelope);
            affordance = resumeAffordance(envelope);
            coverage.textContent = coverageSentence(envelope);
            footer.textContent = '';
            if (!append) hitList.textContent = '';

            var rows = (envelope && Array.isArray(envelope.result)) ? envelope.result : [];
            if (append) { hits = hits.concat(rows); } else { hits = rows.slice(); }
            for (var i = 0; i < rows.length; i++) {
                hitList.appendChild(renderHit(doc, rows[i], { onOpen: onOpenHit }));
            }

            // The outcome block carries the empty/partial/cannot-determine
            // distinction. It is rendered for every token that is not a
            // plain `ok`, and it sits ALONGSIDE any hits that did arrive
            // rather than replacing them.
            if (classified.token !== 'ok') {
                var block = window.ArchiveOutcomeView.renderOutcomeBlock(
                    r.transportError ? null : r.envelope, { document: doc });
                if (r.transportError) {
                    block.appendChild(el(doc, 'p', ROOT_CLASS + '__transport-reason',
                        r.transportError));
                }
                footer.appendChild(block);
            }
            paintResume();
            return classified.token;
        }

        /**
         * Description: run a NEW search. Discards prior hits: a new
         *   question does not inherit an old answer's coverage.
         * Inputs: q (object) - {q, transcriptId, projectId, corpusId,
         *   hostId, limit, caseSensitive}.
         * Output: Promise<string> - the outcome token.
         */
        function run(q) {
            query = q || {};
            hits = [];
            affordance = null;
            hitList.textContent = '';
            footer.textContent = '';
            coverage.textContent = 'Scanning. Coverage so far: NOT KNOWN.';
            return Promise.resolve(api.searchArchive(query)).then(function (r) {
                return apply(r, false);
            });
        }

        /**
         * Description: continue the previous response along the ONE
         *   dimension its scan status named. Reads `affordance.cursor`,
         *   which was resolved from exactly one meta field; this function
         *   never touches meta itself, so it cannot pick the wrong one.
         * Inputs: none.
         * Output: Promise<string> - the outcome token, or 'blocked'.
         */
        function resume() {
            if (!affordance || !affordance.cursor) return Promise.resolve('blocked');
            var next = {};
            for (var k in query) { if (Object.prototype.hasOwnProperty.call(query, k)) next[k] = query[k]; }
            next.cursor = affordance.cursor;
            return Promise.resolve(api.searchArchive(next)).then(function (r) {
                // Both kinds APPEND: more matches add rows, and more
                // scope adds whatever the newly-read transcripts hold.
                // Neither discards what was already found.
                return apply(r, true);
            });
        }

        return {
            element: root,
            run: run,
            resume: resume,
            /** Description: the current affordance, for tests. Output: object|null. */
            lastAffordance: function () { return affordance; },
            /** Description: accumulated hits, for tests. Output: Array. */
            hits: function () { return hits.slice(); }
        };
    }

    window.ArchiveSearch = {
        create: create,
        resumeAffordance: resumeAffordance,
        coverageSentence: coverageSentence,
        scanProgress: scanProgress,
        scanStatus: scanStatus,
        isWithheld: isWithheld,
        renderHit: renderHit,
        RESUME_KINDS: RESUME_KINDS,
        SCAN_STATUSES: SCAN_STATUSES,
        WITHHELD_STATES: WITHHELD_STATES,
        ROOT_CLASS: ROOT_CLASS
    };
    console.log('[ArchiveSearch Module] Exported as window.ArchiveSearch');
})();
