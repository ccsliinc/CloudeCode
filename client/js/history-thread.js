/**
 * History viewer - the thread view. One session, read as a conversation.
 * ----------------------------------------------------------------------
 * NOTHING HERE EVER RENDERS A WHOLE SESSION. The largest session in the
 * live archive is 29,322 records; the view holds a window and grows it
 * from both ends as the reader scrolls.
 *
 * HOW IT READS BACKWARD OVER A FORWARD-ONLY API. The messages endpoint
 * takes `after_seq`, an exclusive LOWER bound, and returns ascending. It
 * has no `before_seq`. So "load older" is expressed as a bounded forward
 * read of the range immediately below the top of the screen, discarding
 * anything already rendered - see `HistoryModel.backwardWindow`, which
 * also explains why the span and the limit must be the same number.
 *
 * WHY IT OPENS AT THE END, AND WHY THAT IS AN ESTIMATE IT THEN CONFIRMS.
 * A conversation reader wants the last thing that was said, so the view
 * opens near the tail. There is no "last page" call, so the entry point
 * is derived from `sessions.message_count` - which equals the session's
 * highest `seq_in_file` for 18,868 of 19,067 sessions (measured
 * 2026-08-18), and is therefore a good estimate and NOT a fact. The view
 * treats it as an estimate: it opens there and then pages forward until
 * the server reports `has_more: false`, bounded by `MAX_TAIL_FOLLOW` so
 * the 1% where the estimate is badly wrong cannot turn into a phone
 * downloading a whole session. If the bound binds, the reader gets an
 * explicit "load newer" control rather than a thread that quietly stops.
 *
 * SCROLL ANCHORING IS NOT OPTIONAL. Inserting older messages above the
 * viewport moves everything the reader is looking at down by the height
 * of what was inserted. Every prepend measures `scrollHeight` before and
 * after and adds the difference back to `scrollTop`, synchronously, in
 * the same frame as the insert.
 */

console.log('[HistoryThread Module] Loading...');

(function () {
    'use strict';

    var Model = window.HistoryModel;
    var Nodes = window.HistoryNodes;
    var Render = window.HistoryRender;
    var Api = window.HistoryAPI;

    /** Distance from an edge, in px, that triggers a page load. */
    var NEAR_TOP_PX = 400;
    var NEAR_BOTTOM_PX = 600;

    /** Max search hits requested for the in-session search sheet. */
    var SEARCH_LIMIT = 30;

    /** Messages loaded around a jump target, before and after it. */
    var JUMP_CONTEXT = 20;

    /** Live view state, or null when no thread is mounted. */
    var state = null;

    /**
     * Mount the thread view for one session.
     *
     * Inputs:
     *   host (HTMLElement) - the container to render into; emptied first.
     *   sessionId (number) - `sessions.id`.
     *   opts (object|undefined) - `{seq}` to open at a specific
     *     `seq_in_file` instead of at the end of the session.
     * Output: Promise<object|null> - the session summary once loaded, or
     *   null when the outline could not be read (the view then shows why).
     */
    async function mount(host, sessionId, opts) {
        var seq = opts && opts.seq ? Number(opts.seq) : null;
        host.textContent = '';
        state = {
            host: host,
            sessionId: sessionId,
            summary: null,
            compactionsById: {},
            includeMachinery: false,
            topSeq: null,
            bottomSeq: null,
            backCursor: null,
            atTop: false,
            atBottom: false,
            loading: false,
            listEl: null,
            statusEl: null,
            searchResultsEl: null
        };

        var outline = await Api.outline(sessionId);
        if (!Api.isOk(outline)) {
            host.appendChild(Render.unavailableBlock(outline, 'this session'));
            return null;
        }
        state.summary = outline.session;
        state.compactionsById = Nodes.indexCompactions(outline.compaction_events);

        buildChrome(host, outline);
        await openWindow(seq === null ? Model.estimateTailStart(state.summary.message_count) : jumpAnchor(seq),
            { scrollTo: seq, followToEnd: seq === null });
        return state.summary;
    }

    /**
     * Tear down the mounted thread, if any.
     * Inputs: none. Output: void.
     */
    function unmount() {
        if (state && state.listEl) state.listEl.removeEventListener('scroll', onScroll);
        state = null;
    }

    /**
     * Convert a jump target into the `after_seq` that puts it on screen
     * with context above it.
     *
     * Inputs: seq (number) - the `seq_in_file` to land on.
     * Output: number - an `after_seq`, never below 0.
     */
    function jumpAnchor(seq) {
        return Math.max(0, seq - JUMP_CONTEXT - 1);
    }

    /**
     * Build the header, controls and scroll container.
     *
     * Inputs: host (HTMLElement), outline (object) - the `ok` envelope.
     * Output: void.
     */
    function buildChrome(host, outline) {
        var summary = outline.session;
        var header = Render.el('div', 'history-thread__header');
        header.appendChild(Render.el('div', 'history-thread__title',
            summary.custom_title || summary.slug || ('session ' + summary.id)));
        header.appendChild(Render.metaRow([
            ['cwd', Render.clipPath(summary.cwd, 60)],
            ['branch', summary.git_branch],
            ['model', summary.model],
            ['cc', summary.cc_version],
            ['messages', summary.message_count == null ? '' : String(summary.message_count)],
            ['compactions', String((outline.compaction_events || []).length)]
        ]));
        host.appendChild(header);

        var caveat = Render.caveatBanner(outline);
        if (caveat) host.appendChild(caveat);

        host.appendChild(buildControls());

        state.listEl = Render.el('div', 'history-thread__list');
        state.listEl.addEventListener('scroll', onScroll, { passive: true });
        host.appendChild(state.listEl);

        state.statusEl = Render.el('div', 'history-thread__status');
        host.appendChild(state.statusEl);
    }

    /**
     * Build the search box and the machinery toggle.
     *
     * Inputs: none. Output: HTMLElement.
     */
    function buildControls() {
        var bar = Render.el('div', 'history-controls');

        var form = Render.el('form', 'history-search');
        var input = Render.el('input', 'history-search__input');
        input.type = 'search';
        input.placeholder = 'search this session';
        input.setAttribute('aria-label', 'search this session');
        var go = Render.el('button', 'history-search__go', 'find');
        go.type = 'submit';
        form.appendChild(input);
        form.appendChild(go);
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            runSearch(input.value);
        });
        bar.appendChild(form);

        var toggle = Render.el('label', 'history-toggle');
        var box = Render.el('input', 'history-toggle__box');
        box.type = 'checkbox';
        box.addEventListener('change', function () {
            state.includeMachinery = box.checked;
            reloadAtCurrentPosition();
        });
        toggle.appendChild(box);
        toggle.appendChild(Render.el('span', 'history-toggle__label', 'show machinery'));
        bar.appendChild(toggle);

        state.searchResultsEl = Render.el('div', 'history-search__results');
        bar.appendChild(state.searchResultsEl);
        return bar;
    }

    /**
     * Replace the whole window with a fresh one anchored at `afterSeq`.
     *
     * Inputs:
     *   afterSeq (number) - exclusive lower bound to open at.
     *   opts (object|undefined) - `{scrollTo, followToEnd}`. `scrollTo` is
     *     a `seq_in_file` to bring into view; `followToEnd` pages forward
     *     until the server says there is no more, bounded.
     * Output: Promise<void>.
     */
    async function openWindow(afterSeq, opts) {
        var options = opts || {};
        state.listEl.textContent = '';
        state.topSeq = null;
        state.bottomSeq = null;
        state.backCursor = afterSeq;
        state.atTop = afterSeq === 0;
        state.atBottom = false;

        setStatus('loading...');
        var body = await fetchWindow(afterSeq, Model.PAGE_SIZE);
        if (!Api.isOk(body)) {
            state.listEl.appendChild(Render.unavailableBlock(body, 'this session\'s thread'));
            setStatus('');
            return;
        }
        appendItems(body.items);
        state.atBottom = !body.has_more;

        if (options.followToEnd) await followToEnd();
        setStatus('');

        if (options.scrollTo) {
            scrollToSeq(options.scrollTo);
        } else {
            state.listEl.scrollTop = state.listEl.scrollHeight;
        }
        // The first paint may not have filled the viewport (a short
        // session, or a window that was mostly folded progress records).
        // Ask once whether more is needed rather than waiting for a
        // scroll event that a non-scrollable list will never emit.
        maybeLoadMore();
    }

    /**
     * Page forward from the current bottom until the session ends.
     *
     * Inputs: none.
     * Output: Promise<void>. Stops after `MAX_TAIL_FOLLOW` pages and
     *   leaves `atBottom` false, so the reader is told there is more
     *   rather than shown a thread that just stops.
     */
    async function followToEnd() {
        var follows = 0;
        while (!state.atBottom && follows < Model.MAX_TAIL_FOLLOW) {
            var body = await fetchWindow(state.bottomSeq, Model.PAGE_SIZE);
            if (!Api.isOk(body)) return;
            appendItems(body.items);
            state.atBottom = !body.has_more;
            follows += 1;
        }
    }

    /**
     * Issue one window request with the current machinery setting.
     *
     * Inputs: afterSeq (number), limit (number).
     * Output: Promise<object> - the envelope, never a rejection.
     */
    function fetchWindow(afterSeq, limit) {
        return Api.messages(state.sessionId, {
            afterSeq: afterSeq,
            limit: limit,
            includeMachinery: state.includeMachinery
        });
    }

    /**
     * Render rows onto the END of the list and advance `bottomSeq`.
     *
     * Inputs: items (Array) - message rows in ascending seq order.
     * Output: void.
     */
    function appendItems(items) {
        if (!items || !items.length) return;
        state.listEl.appendChild(buildFragment(items));
        state.bottomSeq = items[items.length - 1].seq_in_file;
        if (state.topSeq === null) state.topSeq = items[0].seq_in_file;
    }

    /**
     * Render rows onto the START of the list, preserving what the reader
     * is looking at.
     *
     * Inputs: items (Array) - message rows in ascending seq order.
     * Output: void.
     */
    function prependItems(items) {
        if (!items || !items.length) return;
        var list = state.listEl;
        var heightBefore = list.scrollHeight;
        var topBefore = list.scrollTop;
        list.insertBefore(buildFragment(items), list.firstChild);
        list.scrollTop = topBefore + (list.scrollHeight - heightBefore);
        state.topSeq = items[0].seq_in_file;
        if (state.bottomSeq === null) state.bottomSeq = items[items.length - 1].seq_in_file;
    }

    /**
     * Turn message rows into a document fragment of thread nodes.
     *
     * Inputs: items (Array). Output: DocumentFragment.
     */
    function buildFragment(items) {
        var fragment = document.createDocumentFragment();
        Nodes.buildNodes(items, state.compactionsById).forEach(function (node) {
            fragment.appendChild(Render.threadNode(node));
        });
        return fragment;
    }

    /**
     * Scroll handler: load older near the top, newer near the bottom.
     * Inputs: none (event ignored). Output: void.
     */
    function onScroll() {
        maybeLoadMore();
    }

    /**
     * Decide whether either end needs another page, and load it.
     * Inputs: none. Output: void.
     */
    function maybeLoadMore() {
        if (!state || state.loading) return;
        var list = state.listEl;
        if (!state.atTop && list.scrollTop < NEAR_TOP_PX) {
            loadOlder();
            return;
        }
        var fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
        if (!state.atBottom && fromBottom < NEAR_BOTTOM_PX) loadNewer();
    }

    /**
     * Fetch and prepend the page immediately above the current top.
     * Inputs: none. Output: Promise<void>.
     */
    async function loadOlder() {
        if (state.loading || state.atTop || state.backCursor === null) return;
        state.loading = true;
        setStatus('loading earlier messages...');
        var plan = Model.backwardWindow(state.backCursor);
        var body = await fetchWindow(plan.after_seq, plan.limit);
        if (!state || state.listEl === null) return;
        if (!Api.isOk(body)) {
            setStatus(Api.reasonText(body));
            state.loading = false;
            return;
        }
        prependItems(Model.belowCeiling(body.items, plan.ceiling));
        // The requested range is exhausted whether or not it held any
        // rows, so the cursor and `atTop` both follow the REQUEST that was
        // made, not the rows that came back. A span that yielded nothing
        // (all of it folded `progress` records) is an empty stretch of the
        // session, not the start of it.
        state.backCursor = plan.after_seq;
        state.atTop = plan.reachesStart;
        setStatus('');
        state.loading = false;
        maybeLoadMore();
    }

    /**
     * Fetch and append the page immediately below the current bottom.
     * Inputs: none. Output: Promise<void>.
     */
    async function loadNewer() {
        if (state.loading || state.atBottom || state.bottomSeq === null) return;
        state.loading = true;
        setStatus('loading later messages...');
        var body = await fetchWindow(state.bottomSeq, Model.PAGE_SIZE);
        if (!state || state.listEl === null) return;
        if (!Api.isOk(body)) {
            setStatus(Api.reasonText(body));
            state.loading = false;
            return;
        }
        appendItems(body.items);
        state.atBottom = !body.has_more;
        setStatus('');
        state.loading = false;
    }

    /**
     * Reload the window around whatever is currently on screen.
     *
     * Used by the machinery toggle: flipping it changes which records the
     * server returns, so the window is refetched rather than patched.
     *
     * Inputs: none. Output: Promise<void>.
     */
    function reloadAtCurrentPosition() {
        var anchor = state.topSeq === null ? 0 : Math.max(0, state.topSeq - 1);
        return openWindow(anchor, { scrollTo: null, followToEnd: false });
    }

    /**
     * Bring a `seq_in_file` into view, loading a window around it first
     * when it is outside the one on screen.
     *
     * Inputs: seq (number). Output: Promise<void>.
     */
    async function jumpTo(seq) {
        var target = Number(seq);
        if (state.topSeq !== null && target >= state.topSeq && target <= state.bottomSeq) {
            scrollToSeq(target);
            return;
        }
        await openWindow(jumpAnchor(target), { scrollTo: target, followToEnd: false });
    }

    /**
     * Scroll the row nearest a `seq_in_file` into view and mark it.
     *
     * Inputs: seq (number).
     * Output: void. No-op when the seq is not rendered - which happens
     *   legitimately, because a hit can land on a record the current
     *   machinery setting hides.
     */
    function scrollToSeq(seq) {
        var rows = state.listEl.querySelectorAll('[data-seq]');
        var best = null;
        for (var i = 0; i < rows.length; i += 1) {
            if (Number(rows[i].dataset.seq) >= Number(seq)) { best = rows[i]; break; }
        }
        if (!best) return;
        state.listEl.querySelectorAll('.history-target').forEach(function (node) {
            node.classList.remove('history-target');
        });
        best.classList.add('history-target');
        best.scrollIntoView({ block: 'center' });
    }

    /**
     * Run an in-session full-text search and list the hits.
     *
     * Inputs: query (string).
     * Output: Promise<void>. Distinguishes all three outcomes: hits, a
     *   completed search that matched nothing, and a search that could not
     *   run (a malformed FTS expression reports as malformed, never as
     *   zero results).
     */
    async function runSearch(query) {
        var results = state.searchResultsEl;
        results.textContent = '';
        var text = (query || '').trim();
        if (!text) return;
        results.appendChild(Render.el('div', 'history-search__note', 'searching...'));

        var body = await Api.search(state.sessionId, text, SEARCH_LIMIT);
        results.textContent = '';
        if (Api.isNoMatches(body)) {
            results.appendChild(Render.el('div', 'history-search__note',
                'searched this session, nothing matched'));
            return;
        }
        if (!Api.isOk(body)) {
            results.appendChild(Render.unavailableBlock(body, 'the search'));
            return;
        }
        results.appendChild(Render.el('div', 'history-search__note',
            body.count + ' hits, best first'));
        body.items.forEach(function (hit) {
            var row = Render.searchHit(hit);
            row.addEventListener('click', function () { jumpTo(hit.seq_in_file); });
            results.appendChild(row);
        });
    }

    /**
     * Write the one-line status strip under the thread.
     * Inputs: text (string) - "" clears it. Output: void.
     */
    function setStatus(text) {
        if (state && state.statusEl) state.statusEl.textContent = text || '';
    }

    window.HistoryThread = {
        mount: mount,
        unmount: unmount,
        jumpTo: jumpTo
    };
})();
