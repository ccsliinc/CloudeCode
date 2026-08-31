/**
 * The archive reader shell: composes archive-virtual-list.js,
 * archive-body-cache.js and archive-line-render.js into a scrollable
 * transcript view.
 *
 * WHAT THIS FILE OWNS, and nothing else does: the scroller element, the
 * rAF loop, and the decision about which bodies to request. It owns no
 * geometry maths (the virtual list), no size policy (the body cache), no
 * markup for a row (the line renderer), and no interpretation of
 * `result_status` (archive-outcome.js, via archive-outcome-view.js).
 *
 * THE ANTI-JUMP CONTRACT IS HONOURED HERE OR NOWHERE. The virtual list
 * computes the pixel delta owed by rows above the viewport; this file is
 * the only thing that can pay it, and it must pay it inside the same
 * animation frame, before paint. That is the single line of code the
 * whole two-tier design exists to make possible on a 30,805-line file.
 *
 * NO IntersectionObserver ANYWHERE. Per-row intersection observation at
 * full N is the outage this design was built to avoid; the rendered
 * window is a few dozen recycled elements measured directly instead.
 *
 * EVERY READER STATE IS ONE OF THE SIX OUTCOME TOKENS OR ONE OF THE TWO
 * NON-OUTCOME STATES. There is no hand-rolled empty state and no
 * hand-rolled error state here: `idle` renders a prompt, `loading`
 * renders a skeleton WITH A STATED DEADLINE, and everything else is
 * handed to archive-outcome-view.js as an envelope. A spinner with no
 * terminal condition is a state that can never fail, which is a false
 * green at the pixel level.
 *
 * THE SCROLLBAR IS HONEST: its height is the virtual list's running sum
 * of estimates and measurements. No page count is published anywhere in
 * this file, because over variable-height rows a page count is a number
 * nobody computed.
 *
 * Depends on archive-virtual-list.js, archive-body-cache.js,
 * archive-line-render.js, archive-outcome-view.js, archive-format.js.
 * Exports window.ArchiveReader.
 */

console.log('[ArchiveReader Module] Loading...');

(function () {
    'use strict';

    var ROOT_CLASS = 'archive-reader';

    /**
     * Fallback viewport height when the scroller reports clientHeight 0,
     * which happens while detached or display:none. A zero viewport would
     * render exactly one row and look broken rather than unmounted.
     * @type {number}
     */
    var FALLBACK_VIEWPORT_PX = 600;

    /**
     * Build a reader bound to one document and one API.
     * @param {object} options
     *   `document` (required); `api` (passed to the body cache);
     *   `cache` (an existing body cache, for tests);
     *   `requestAnimationFrame` (injectable scheduler, so the reconcile
     *   loop is testable without a browser - defaults to the global, or
     *   to an immediate call when there is none); `overscan`.
     * @returns {object} the reader, see methods below
     * @example
     *   const reader = createReader({document, api});
     *   reader.mount(document.body);
     *   reader.setSpine(rows, true);
     */
    function createReader(options) {
        var opts = options || {};
        var doc = opts.document;
        if (!doc) throw new Error('createReader needs a document');

        var VL = window.ArchiveVirtualList;
        var LR = window.ArchiveLineRender;
        var OV = window.ArchiveOutcomeView;

        var raf = opts.requestAnimationFrame ||
            (typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : function (fn) { fn(); return 0; });

        var cache = opts.cache || (opts.api
            ? window.ArchiveBodyCache.createCache({ api: opts.api })
            : null);

        var list = VL.createList({ overscan: opts.overscan });

        var items = [];        // spine rows plus collapsed progress runs
        var spine = [];        // raw spine, kept so an expand can re-group
        var spineComplete = false;  // false renders a named sentinel row
        var expanded = Object.create(null);  // item index -> run expanded
        var token = 'idle';    // an outcome token, or idle / loading
        var envelope = null;   // the envelope backing a failure token
        var header = null;     // header facts, from a separate request

        // DOM handles, all null until mount(). `window_` is the
        // translated render window; `spacer` carries the honest height.
        var root = null, scroller = null, spacer = null;
        var window_ = null, statusEl = null;
        var frameQueued = false, destroyed = false;

        /**
         * Create an element. Text nodes only, never innerHTML; see
         * archive-line-render.js's header for why.
         * @param {string} tag @param {?string} cls @param {?string} text
         * @returns {Element}
         */
        function el(tag, cls, text) {
            var e = doc.createElement(tag);
            if (cls) e.className = cls;
            if (text !== null && text !== undefined) {
                e.appendChild(doc.createTextNode(String(text)));
            }
            return e;
        }

        /**
         * Viewport height, with the detached-element case named rather
         * than silently producing a one-row window.
         * @returns {number} pixels
         */
        function viewportHeight() {
            var h = scroller && scroller.clientHeight;
            return Number.isFinite(h) && h > 0 ? h : FALLBACK_VIEWPORT_PX;
        }

        /**
         * Scroll position, tolerating a harness element with no scrollTop.
         * @returns {number} pixels
         */
        function scrollTop() {
            var t = scroller && scroller.scrollTop;
            return Number.isFinite(t) && t > 0 ? t : 0;
        }

        /**
         * Rebuild `items` from `spine` and reseed the virtual list's
         * height estimates. Called whenever the spine changes or a
         * progress run is expanded or collapsed.
         * @returns {void}
         */
        function regroup() {
            items = LR.groupRows(spine);
            list.setCount(items.length, function (i) {
                var it = items[i];
                if (it && it.kind === 'progress-run' && expanded[i]) {
                    // An expanded run is its children stacked. The real
                    // height is measured on the next frame and reconciled
                    // like any other correction.
                    var sum = 0;
                    for (var k = 0; k < it.rows.length; k++) {
                        sum += VL.estimateHeight(it.rows[k]);
                    }
                    return sum + VL.PROGRESS_ROW_PX;
                }
                return VL.estimateHeight(it);
            });
        }

        /**
         * Ask the cache for the bodies in the render window, honouring
         * the gates. NORMATIVE: cache.request() evaluates gateFor() from
         * the spine BEFORE any network happens, so a 54 MB body is never
         * fetched by the auto path.
         * @param {object} win a windowFor() result @returns {void}
         */
        function requestBodies(win) {
            if (!cache) return;
            for (var i = win.first; i <= win.last; i++) {
                var it = items[i];
                if (!it || it.kind === 'progress-run') continue;
                if (it.body_id === null || it.body_id === undefined) continue;
                if (cache.get(it.body_id) || cache.isLoading(it.body_id)) continue;
                var gate = cache.gateFor(it);
                // Only the freely renderable class is auto-fetched.
                // Everything else waits for the reader to ask, or can
                // never be asked for at all.
                if (gate.state !== window.ArchiveBodyCache.STATE_OK) continue;
                cache.request(it).then(schedule);
            }
        }

        /**
         * The cache entry a row should render with. Distinguishes all
         * four cases: cached, in flight, refused by a gate, and NOT
         * REQUESTED (null), which renders as a sized placeholder so a row
         * outside the fetch window never shows a spinner that cannot
         * resolve.
         * @param {?object} it a spine row @returns {?object} cache entry
         */
        function entryFor(it) {
            var C = window.ArchiveBodyCache;
            if (!cache || !it || it.kind === 'progress-run') return null;
            if (it.body_id === null || it.body_id === undefined) return null;
            var hit = cache.get(it.body_id);
            if (hit) return hit;
            if (cache.isLoading(it.body_id)) {
                return { state: C.STATE_LOADING, text: null, chars: 0, masked: 0 };
            }
            var gate = cache.gateFor(it);
            if (gate.state === C.STATE_OK) return null;
            return { state: gate.state, text: null, chars: 0, masked: 0,
                reason: gate.reason, findingCount: 0,
                bodyHref: it.body_href || null, gated: true };
        }

        /**
         * Render the rows in the window into the DOM.
         * @param {object} win a windowFor() result @returns {void}
         */
        function paint(win) {
            while (window_.firstChild) window_.removeChild(window_.firstChild);
            window_.style.transform = 'translateY(' + win.offsetTop + 'px)';
            spacer.style.height = win.totalHeight + 'px';

            for (var i = win.first; i <= win.last; i++) {
                var it = items[i];
                if (!it) continue;
                window_.appendChild(LR.renderItem(doc, it, entryFor(it), {
                    index: i, expanded: !!expanded[i], entryFor: entryFor
                }));
            }

            if (!spineComplete) {
                // A partial spine ends in a named sentinel, not in a
                // silent stop. A list that just ends looks complete.
                window_.appendChild(el('p', ROOT_CLASS + '__sentinel',
                    'More lines not loaded yet. ' + spine.length +
                    ' of this transcript loaded so far.'));
            }
        }

        /**
         * Read the rendered rows' real heights into the virtual list,
         * apply them, and pay the anti-jump debt. NORMATIVE: the
         * scrollTop compensation happens HERE, in the same frame as the
         * height write, before paint. Deferring it produces a visible
         * one-frame leap, which reads as a bug rather than as scrolling.
         * @param {object} win the window that was just painted
         * @returns {number} the delta applied, for assertions
         */
        function reconcile(win) {
            var kids = window_.childNodes;
            for (var k = 0; k < kids.length; k++) {
                var node = kids[k];
                if (!node.getAttribute) continue;
                var idx = parseInt(node.getAttribute('data-index'), 10);
                if (!Number.isInteger(idx)) continue;
                var h = _measuredHeight(node);
                if (h !== null) list.measure(idx, h);
            }
            var r = list.applyMeasurements(win.firstVisible);
            if (r.delta !== 0 && scroller) {
                scroller.scrollTop = scrollTop() + r.delta;
            }
            if (r.applied > 0) {
                spacer.style.height = r.totalHeight + 'px';
            }
            return r.delta;
        }

        /**
         * A rendered row's height, or null when it cannot be measured.
         * Null is NOT zero: a zero would be written into the offset
         * table as a real correction and collapse the row to invisible.
         * @param {Element} node @returns {?number} pixels
         */
        function _measuredHeight(node) {
            if (typeof node.getBoundingClientRect === 'function') {
                var r = node.getBoundingClientRect();
                if (r && Number.isFinite(r.height) && r.height > 0) return r.height;
            }
            if (Number.isFinite(node.offsetHeight) && node.offsetHeight > 0) {
                return node.offsetHeight;
            }
            return null;
        }

        /**
         * Render the current state. Only `ok` reaches the virtual list;
         * every other token is handed whole to archive-outcome-view.js.
         * @returns {void}
         */
        function render() {
            if (destroyed || !root) return;
            _renderHeader();

            if (token === 'ok') {
                statusEl.setAttribute('data-reader-state', 'ok');
                while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
                scroller.style.display = '';
                var win = list.windowFor(scrollTop(), viewportHeight());
                paint(win);
                requestBodies(win);
                reconcile(win);
                return;
            }

            scroller.style.display = 'none';
            statusEl.setAttribute('data-reader-state', token);
            while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);

            if (token === 'idle') {
                // NORMATIVE COPY. "You have not asked" and "your question
                // found nothing" are different findings and must not look
                // alike. `Live session: NOT CHECKED` is rendered verbatim:
                // this build does not correlate archived transcripts with
                // live terminal sessions, and it is not asserting that
                // there are none.
                statusEl.appendChild(el('p', ROOT_CLASS + '__idle-head',
                    'Pick a transcript.'));
                statusEl.appendChild(el('p', ROOT_CLASS + '__idle-live',
                    'Live session: NOT CHECKED'));
                statusEl.appendChild(el('p', ROOT_CLASS + '__idle-note',
                    'This build does not correlate archived transcripts with ' +
                    'live terminal sessions. It is not asserting that there ' +
                    'are none.'));
                return;
            }
            if (token === 'loading') {
                var p = el('p', ROOT_CLASS + '__loading', 'Loading the line index...');
                p.setAttribute('role', 'status');
                statusEl.appendChild(p);
                // The deadline is surfaced so the state is visibly
                // terminal rather than an open-ended spinner.
                statusEl.appendChild(el('p', ROOT_CLASS + '__deadline',
                    'If there is no answer within ' +
                    Math.round(window.ArchiveState.DEADLINES_MS.transcript / 1000) +
                    's this becomes NO ANSWER FROM THE SERVER.'));
                return;
            }
            statusEl.appendChild(OV.renderOutcomeBlock(envelope, { document: doc }));
        }

        /**
         * Render the transcript header. It stays visible through a
         * cannot-determine on the LINES, because the header's facts came
         * from a different request that succeeded, and hiding them would
         * discard a real measurement.
         * @returns {void}
         */
        function _renderHeader() {
            var box = root.querySelector('.' + ROOT_CLASS + '__header');
            if (!box) return;
            while (box.firstChild) box.removeChild(box.firstChild);
            if (!header) return;
            var fmt = window.ArchiveFormat;
            // FIELD NAMES ARE THE SERVER'S, not invented ones. Measured
            // 2026-08-31 against the live GET
            // /api/v1/archive/transcripts/5767: the header record carries
            // `transcript_id`, `source_path` and `raw_byte_length`. This
            // block previously read `header.byte_length`, `header.path`
            // and `header.id` - none of which the server sends - so a
            // fully successful header request rendered
            // "30,805 lines / size NOT KNOWN" over a byte count the app
            // already held. The unit test passed throughout because its
            // fixture used the same invented names.
            box.appendChild(el('h2', ROOT_CLASS + '__title',
                header.session_ref || header.source_path ||
                    ('transcript ' + header.transcript_id)));
            box.appendChild(el('p', ROOT_CLASS + '__facts',
                (Number.isFinite(header.line_count)
                    ? fmt.formatCount(header.line_count) + ' lines'
                    : 'line count ' + fmt.NOT_KNOWN) + '  /  ' +
                (Number.isFinite(header.raw_byte_length)
                    ? fmt.formatBytes(header.raw_byte_length)
                    : 'size ' + fmt.NOT_KNOWN)));
        }

        /**
         * Queue one render on the next animation frame. Coalescing keeps
         * a burst of resolved body fetches from repainting once each.
         * @returns {void}
         */
        function schedule() {
            if (destroyed || frameQueued) return;
            frameQueued = true;
            raf(function () {
                frameQueued = false;
                render();
            });
        }

        /**
         * Attach the reader to a host element.
         * @param {Element} host @returns {Element} the reader root
         */
        function mount(host) {
            root = el('section', ROOT_CLASS, null);
            root.setAttribute('data-reader', 'archive');
            root.appendChild(el('div', ROOT_CLASS + '__header', null));

            statusEl = el('div', ROOT_CLASS + '__status', null);
            root.appendChild(statusEl);

            scroller = el('div', ROOT_CLASS + '__scroller', null);
            scroller.setAttribute('tabindex', '0');
            spacer = el('div', ROOT_CLASS + '__spacer', null);
            window_ = el('div', ROOT_CLASS + '__window', null);
            spacer.appendChild(window_);
            scroller.appendChild(spacer);
            root.appendChild(scroller);

            scroller.addEventListener('scroll', schedule);
            host.appendChild(root);
            render();
            return root;
        }

        /**
         * Install the spine. NORMATIVE: `complete` is a three-outcome
         * input in disguise - an incomplete spine renders a named
         * sentinel rather than simply ending, because a list that just
         * stops looks finished.
         * @param {Array<object>} rows @param {boolean} complete
         * @returns {void}
         */
        function setSpine(rows, complete) {
            spine = Array.isArray(rows) ? rows : [];
            spineComplete = complete === true;
            expanded = Object.create(null);
            regroup();
            token = spine.length ? 'ok' : token;
            render();
        }

        /**
         * Set the reader's outcome state.
         * @param {string} newToken one of the six outcome tokens, or
         *   'idle' / 'loading'
         * @param {?object} env the envelope backing a failure
         * @returns {void}
         */
        function setToken(newToken, env) {
            token = String(newToken);
            envelope = env || null;
            render();
        }

        /**
         * Set the transcript header facts.
         * @param {?object} h @returns {void}
         */
        function setHeader(h) { header = h || null; render(); }

        /**
         * Expand or collapse one progress run by item index. Expansion is
         * an ordinary height correction, handled by the same reconcile
         * pass as everything else.
         * @param {number} index @param {boolean} on @returns {void}
         */
        function setProgressExpanded(index, on) {
            if (on) expanded[index] = true; else delete expanded[index];
            regroup();
            render();
        }

        /**
         * Fetch a soft-gated body because the reader asked. The hard gate
         * is unreachable from here by construction: cache.request()
         * refuses it regardless of `force`.
         * @param {number} index item index
         * @returns {Promise<?object>} the cache entry
         */
        function renderAnyway(index) {
            var it = items[index];
            if (!it || it.kind === 'progress-run' || !cache) {
                return Promise.resolve(null);
            }
            return cache.request(it, true).then(function (e) {
                schedule();
                return e;
            });
        }

        return {
            mount: mount,
            setSpine: setSpine,
            setToken: setToken,
            setHeader: setHeader,
            setProgressExpanded: setProgressExpanded,
            renderAnyway: renderAnyway,
            schedule: schedule,
            render: render,
            list: list,      // the geometry engine, for callers and tests
            cache: cache,    // the body cache, for callers and tests
            /** Grouped items currently laid out. @returns {Array} */
            items: function () { return items; },
            /** Current token. @returns {string} */
            token: function () { return token; },
            /** The reader root element. @returns {?Element} */
            root: function () { return root; },
            /** Detach and stop scheduling. @returns {void} */
            destroy: function () {
                destroyed = true;
                if (scroller) scroller.removeEventListener('scroll', schedule);
                if (root && root.parentNode) root.parentNode.removeChild(root);
                root = null;
            }
        };
    }

    window.ArchiveReader = {
        createReader: createReader,
        ROOT_CLASS: ROOT_CLASS,
        FALLBACK_VIEWPORT_PX: FALLBACK_VIEWPORT_PX
    };
    console.log('[ArchiveReader Module] Exported as window.ArchiveReader');
})();
