/**
 * Archive reader FETCH OWNER.
 *
 * WHY THIS IS NOT PART OF `archive-reader.js`. That file renders: it
 * takes a spine, an outcome token and a header, and paints them. It does
 * no fetching at all, deliberately, which is what makes it testable
 * under a bare DOM with no network. Something still has to ask the server
 * for a transcript's header and its first page of lines, and that
 * something is here rather than in `archive-screen.js` only because the
 * composition root was over the repo's 500-line file cap with it inline.
 * The seam is honest: this is the one place that turns a transcript id
 * into the three inputs the reader needs.
 *
 * IT DOES NOT INTERPRET `result_status`. `ArchiveOutcome.classify()` is
 * the only interpreter (design doc B.3); this reads the TOKEN that
 * function returns, which is a different thing.
 */

console.log('[ArchiveScreenReader Module] Loading...');

(function () {
    'use strict';

    /**
     * Marks the notes this module inserts into the reader pane, so a
     * later load can remove its own leftovers without touching anything
     * else in the pane.
     * @type {string}
     */
    var NOTE_ATTR = 'data-archive-screen-note';

    /**
     * Description: remove notes a previous load left behind. A stale
     *   could-not-evaluate about a different transcript's line is worse
     *   than no note at all.
     * Inputs: pane (Element).
     * Output: void.
     */
    function clearNotes(pane) {
        var stale = pane.querySelectorAll('[' + NOTE_ATTR + ']');
        for (var i = 0; i < stale.length; i++) {
            stale[i].parentNode.removeChild(stale[i]);
        }
    }

    /**
     * Description: find which laid-out item holds a line number.
     *
     *   TWO SHAPES, AND THE OLD CODE KNEW NEITHER. `reader.items()` is
     *   `archive-line-render.js::groupRows(spine)`, which returns the
     *   ORIGINAL ROW OBJECTS for ordinary lines and a
     *   `{kind:'progress-run', from, to, count, rows}` wrapper for a run
     *   of consecutive `record_type === 'progress'` lines. There is no
     *   `.row` property anywhere in that list. The previous
     *   implementation searched `items[i].row.line_no`, which is
     *   `undefined` for EVERY item, so it could never match anything -
     *   a lookup that always failed, hidden because until `start_line`
     *   shipped the deep link never reached a page where the answer
     *   would have been yes.
     *
     *   Both shapes are handled here, and the run case matters on real
     *   data: transcript 5767's line 7,111 sits inside the run
     *   7110..7123, so even a correct plain-row search would miss it.
     * Inputs: items (Array) - from reader.items(), lineNo (number).
     * Output: {item: number, inRun: boolean} | null when not present.
     * Example: indexOfLine(reader.items(), 7111) // -> {item: 9, inRun: true}
     */
    function indexOfLine(items, lineNo) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            if (it.kind !== 'progress-run' && it.line_no === lineNo) {
                return { item: i, inRun: false };
            }
            if (it.kind === 'progress-run' && Array.isArray(it.rows)) {
                for (var j = 0; j < it.rows.length; j++) {
                    if (it.rows[j] && it.rows[j].line_no === lineNo) {
                        return { item: i, inRun: true };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Description: put a deep-linked line on screen.
     *
     *   THE ENDPOINT NOW TAKES A LINE OFFSET, so the normal path is that
     *   the server was ASKED for the page beginning at this line and the
     *   line is the first row. `start_line` shipped 2026-08-31; before it
     *   the only page reachable was the first one and this function's
     *   fallback fired for every deep link past it.
     *
     *   THE FALLBACK IS STILL HERE AND IS STILL A cannot_determine,
     *   because "the server was asked for line N and line N is not in
     *   what came back" is a state nobody has measured and it must not
     *   render as "the reader is showing line N". The two reasons that
     *   can produce it are named rather than merged: the request may not
     *   have carried the offset at all (an older build, or a caller that
     *   passed rows from a different fetch), or it carried it and the
     *   rows disagree. Out-of-range and start_line-plus-cursor never
     *   reach here at all - the SERVER answers those, 404 and 400, with
     *   its own named envelope, which is strictly better than a
     *   client-side guess.
     * Inputs: ctx (object) - {reader, pane, transcriptId}.
     *         lineNo (number), rows (Array) - the spine page loaded,
     *         offsetRequested (boolean) - whether this page was fetched
     *         with start_line set to lineNo.
     * Output: boolean - true when the line was found and scrolled to.
     */
    function scrollToLine(ctx, lineNo, rows, offsetRequested) {
        var index = indexOfLine(ctx.reader.items(), lineNo);
        if (index !== null) {
            // A line inside a COLLAPSED progress run is in the spine and
            // is not on screen. Scrolling to the run without expanding it
            // would put the reader in the right place and show the person
            // a collapsed block instead of the line they asked for - a
            // landing that measures as a success and is not one.
            if (index.inRun) {
                ctx.reader.setProgressExpanded(index.item, true);
                var again = indexOfLine(ctx.reader.items(), lineNo);
                if (again !== null) index = again;
            }
            var root = ctx.reader.root();
            var scroller = root && root.querySelector('.archive-reader__scroller');
            if (scroller) scroller.scrollTop = ctx.reader.list.offsetOf(index.item);
            ctx.reader.schedule();
            ctx.pane.setAttribute('data-highlight-line', String(lineNo));
            return true;
        }
        ctx.pane.removeAttribute('data-highlight-line');
        // A CLIENT-SIDE could-not-evaluate, synthesised as a real
        // envelope and handed to archive-outcome-view.js rather than
        // hand-built here. That file is the only one that decides what a
        // cannot_determine looks like; a second hand-rolled block would
        // be exactly the drift that rule exists to stop.
        var note = window.ArchiveOutcomeView.renderOutcomeBlock({
            result: null,
            result_status: 'cannot_determine',
            scope_status: 'resolved',
            unevaluated: [{
                subject: 'transcript:' + ctx.transcriptId + ' line:' + lineNo,
                reason: 'line ' + lineNo + ' is not in the ' +
                    (rows ? rows.length : 0) + ' rows that were loaded. ' +
                    (offsetRequested === true
                        ? 'The page WAS requested with start_line=' + lineNo +
                          ', so the server and these rows disagree and neither ' +
                          'has been shown to be right here.'
                        : 'This page was NOT requested with a start_line, so ' +
                          'the line was never asked for.') +
                    ' The reader is NOT showing line ' + lineNo + ' and is NOT ' +
                    'asserting that the line does not exist.'
            }],
            meta: {}
        }, { document: ctx.pane.ownerDocument });
        note.setAttribute(NOTE_ATTR, 'line-not-reached');
        ctx.pane.insertBefore(note, ctx.pane.firstChild);
        return false;
    }

    /**
     * Description: fetch a transcript's header and first spine page and
     *   hand both to the reader.
     *
     *   THREE OUTCOMES, EXPLICITLY, TWICE. A transport failure and an
     *   envelope the server could not evaluate are different from an
     *   empty transcript, and each reaches the reader as its own token
     *   rather than as an empty spine. And `has_more` is itself
     *   true|false|null: only an explicit `false` proves the spine is
     *   complete, so `null` renders the reader's incomplete-spine
     *   sentinel rather than an "end of transcript" nobody measured.
     * Inputs: ctx (object) - {reader, pane, api, transcriptId,
     *   spinePageRows}. lineNo (number|null).
     * Output: Promise<string> - the outcome token for the spine request.
     * Example: load({reader, pane, api: window.API, transcriptId: 5767,
     *                spinePageRows: 500}, null)  // -> 'ok'
     */
    function load(ctx, lineNo) {
        var reader = ctx.reader;
        clearNotes(ctx.pane);
        reader.setToken('loading', null);

        // A deep link asks the SERVER for the window it wants. Before
        // start_line existed this fetched page one and then reported it
        // could not reach the line, which was honest and useless.
        var wantsLine = (lineNo !== null && lineNo !== undefined);
        var lineOpts = { limit: ctx.spinePageRows };
        if (wantsLine) lineOpts.startLine = lineNo;

        return Promise.all([
            ctx.api.getArchiveTranscript(ctx.transcriptId),
            ctx.api.listArchiveLines(ctx.transcriptId, lineOpts)
        ]).then(function (both) {
            var head = both[0];
            var page = both[1];

            if (head.transportError) {
                reader.setHeader(null);
            } else {
                var headTok = window.ArchiveOutcome.classify(head.envelope);
                reader.setHeader(window.ArchiveOutcome.isRenderable(headTok.token)
                    ? head.envelope.result : null);
            }

            if (page.transportError) {
                reader.setToken('transport-error', null);
                return 'transport-error';
            }
            var classified = window.ArchiveOutcome.classify(page.envelope);
            if (!window.ArchiveOutcome.isRenderable(classified.token)) {
                reader.setToken(classified.token, page.envelope);
                return classified.token;
            }
            var rows = page.envelope.result || [];
            // A spine fetched with start_line is a WINDOW. Even when the
            // server says has_more is false, every line before the
            // offset is missing, so this spine is not complete and must
            // not render the reader's end-of-transcript state. Claiming
            // otherwise would be a false "you have seen it all" produced
            // by the deep link itself.
            var complete = window.ArchiveOutcome.hasMore(page.envelope) === false
                && !wantsLine;
            reader.setSpine(rows, complete);
            reader.setToken(classified.token, page.envelope);
            if (wantsLine) {
                scrollToLine(ctx, lineNo, rows, true);
            }
            return classified.token;
        });
    }

    window.ArchiveScreenReader = {
        load: load,
        scrollToLine: scrollToLine,
        clearNotes: clearNotes,
        NOTE_ATTR: NOTE_ATTR
    };
    console.log('[ArchiveScreenReader Module] Exported as window.ArchiveScreenReader');
})();
