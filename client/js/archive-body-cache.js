/**
 * Lazy body fetching for the archive reader: the three size gates, an
 * LRU capped on two axes, and in-flight de-duplication.
 *
 * THE GATE IS EVALUATED FROM THE SPINE, BEFORE THE FETCH. This is not an
 * optimisation, it is the only thing that works. Measured 2026-08-31 on
 * the live server: the server's own MAX_BODY_BYTES is 67,108,864 and the
 * largest body in this corpus is 54,376,859 chars (transcript 19243 line
 * 62), so THE SERVER GATE NEVER FIRES and that body is served whole,
 * inline, with body_state "included". The client gate is the ONLY gate.
 * A client that fetched first and gated second would already have pulled
 * 54 MB into the tab by the time it decided not to render it. The
 * `body_chars` field is present on the spine with include_bodies=false
 * (verified live, same session), so the decision costs one integer
 * compare and no network at all.
 *
 * A 54 MB <pre> IS A DEAD TAB. Not slow - dead. The layout pass over a
 * single text node that size cannot be interrupted and the browser
 * offers no way back. That is why the hard gate offers no escape hatch.
 * The soft gate at 256 KiB does, because a quarter of a megabyte of JSON
 * is merely unpleasant.
 *
 * THE CACHE NEVER HOLDS AN UNMASKED SECRET-BEARING BODY. Masking happens
 * once, at insert, through archive-mask.js. When a body carries findings
 * the raw text is dropped on the floor and only the mask result is
 * stored, so no later caller can reach around the masker by reading the
 * cache. When a body carries no findings the mask is a documented no-op
 * and text === body.
 *
 * BOTH CAPS, ALWAYS. 300 bodies at 54 MB each is not a cache, it is an
 * out-of-memory; two million 16-byte bodies fit under 32 MiB while
 * making the Map itself the problem. Eviction runs until BOTH predicates
 * hold, least-recently-used first.
 *
 * THREE OUTCOMES PER ENTRY. An entry is never merely present or absent.
 * `state` distinguishes a body that rendered, a body that was refused by
 * a gate, a body whose mask was refused, and a body whose fetch could
 * not be evaluated. A missing entry means "not requested", which is a
 * fourth thing again and is never rendered as a spinner.
 *
 * Depends on archive-mask.js and archive-outcome.js. Exports
 * window.ArchiveBodyCache.
 */

console.log('[ArchiveBodyCache Module] Loading...');

(function () {
    'use strict';

    /**
     * Above this many UTF-16 code units a body is not auto-fetched and
     * not auto-rendered; the row shows the size and a "render anyway"
     * action. 256 KiB. @type {number}
     */
    var BODY_INLINE_MAX = 262144;

    /**
     * Above this many UTF-16 code units a body is never fetched and
     * never rendered: download only, with the reason stated. There is no
     * render option at any depth of the UI. 2 MiB. @type {number}
     */
    var BODY_RENDER_HARD_MAX = 2097152;

    /** Hard cap on cached bodies, by count. @type {number} */
    var BODY_CACHE_MAX_ENTRIES = 300;

    /** Hard cap by total characters. 32 MiB of text. @type {number} */
    var BODY_CACHE_MAX_CHARS = 33554432;

    /**
     * Deadline for one body fetch, milliseconds. A 54 MB body is a
     * legitimate slow transfer, so this is generous; what it is not is
     * absent. A request with no terminal condition is a state that can
     * never fail.
     * @type {number}
     */
    var BODY_DEADLINE_MS = 30000;

    /** Entry states. Exported so callers compare constants, not strings. */
    var STATE_OK = 'included';
    var STATE_GATED_SOFT = 'gated-soft';
    var STATE_GATED_HARD = 'gated-hard';
    var STATE_WITHHELD = 'withheld-server';
    var STATE_MASK_REFUSED = 'mask-refused';
    var STATE_CANNOT_DETERMINE = 'cannot-determine';
    var STATE_LOADING = 'loading';
    var STATE_NO_BODY = 'no-body';

    /**
     * Decide, from spine metadata alone, whether a body may be fetched
     * and rendered. NORMATIVE: every fetch path calls this first and
     * honours it. Nothing here reads a body.
     * @param {?object} row a spine row; reads `body_chars`, `body_state`
     *   and `body_id` only
     * @returns {{state: string, chars: ?number, reason: ?string}} state is
     *   included|gated-soft|gated-hard|withheld-server|no-body|
     *   cannot-determine. `included` means "small enough to fetch", NOT
     *   "already fetched".
     * @example gateFor({body_id: 1, body_chars: 54376859})
     *   // -> {state: 'gated-hard', chars: 54376859, reason: '...'}
     */
    function gateFor(row) {
        if (!row || typeof row !== 'object') {
            return { state: STATE_CANNOT_DETERMINE, chars: null,
                reason: 'no spine row for this line' };
        }
        // The server's own refusal wins outright: it is a finding the
        // server made about its own limits and the client must render
        // it as the server's, not restate it as its own.
        if (row.body_state === 'withheld_too_large') {
            return { state: STATE_WITHHELD,
                chars: Number.isFinite(row.body_chars) ? row.body_chars : null,
                reason: 'the server withheld this body as too large' };
        }
        if (row.body_id === null || row.body_id === undefined) {
            return { state: STATE_NO_BODY, chars: null,
                reason: 'this line has no body row' };
        }
        var chars = row.body_chars;
        // A size we cannot read is not a small size. Refusing to guess
        // here is the difference between a gate and a coin flip.
        if (!Number.isFinite(chars) || chars < 0) {
            return { state: STATE_CANNOT_DETERMINE, chars: null,
                reason: 'body_chars is ' + String(chars) +
                        ', so the size of this body is not known' };
        }
        if (chars > BODY_RENDER_HARD_MAX) {
            return { state: STATE_GATED_HARD, chars: chars,
                reason: 'this body is ' + chars + ' characters, past the ' +
                        BODY_RENDER_HARD_MAX + ' character hard limit. ' +
                        'Rendering it would hang the tab with no way back, ' +
                        'so there is no render option.' };
        }
        if (chars > BODY_INLINE_MAX) {
            return { state: STATE_GATED_SOFT, chars: chars,
                reason: 'this body is ' + chars + ' characters, past the ' +
                        BODY_INLINE_MAX + ' character inline limit.' };
        }
        return { state: STATE_OK, chars: chars, reason: null };
    }

    /**
     * Run archive-mask.js over a fetched body and fold its result into a
     * cache entry. The ONLY place this module turns body text into
     * something renderable. `text` is null on every refusal path.
     * @param {string} body @param {?Array} findings
     * @param {number} declaredCount
     * @returns {{state: string, text: ?string, masked: number,
     *   reason: ?string, findingCount: number}}
     */
    function _applyMask(body, findings, declaredCount) {
        var mask = window.ArchiveMask.maskBody(body, findings, declaredCount);
        if (mask.status === window.ArchiveMask.MASK_REFUSED) {
            return { state: STATE_MASK_REFUSED, text: null, masked: 0,
                reason: mask.reason, findingCount: mask.findingCount };
        }
        return { state: STATE_OK, text: mask.text, masked: mask.masked,
            reason: null, findingCount: Number.isInteger(declaredCount)
                ? declaredCount : 0 };
    }

    /**
     * Build a body cache bound to one API client.
     * @param {object} options `api` (required, must expose
     *   getArchiveBody(bodyId) returning a callEnvelope result);
     *   `maxEntries` / `maxChars` cap overrides for tests, defaulting to
     *   the NORMATIVE constants above; `deadlineMs`; `setTimeoutFn` /
     *   `clearTimeoutFn` injectable timers, so the deadline is testable
     *   without waiting 30 seconds.
     * @returns {object} the cache, see methods below
     * @example
     *   const cache = createCache({api});
     *   const gate = cache.gateFor(row);         // no network
     *   if (gate.state === 'included') await cache.request(row);
     */
    function createCache(options) {
        var opts = options || {};
        var api = opts.api;
        if (!api || typeof api.getArchiveBody !== 'function') {
            throw new Error('createCache needs an api with getArchiveBody');
        }
        var maxEntries = Number.isFinite(opts.maxEntries)
            ? opts.maxEntries : BODY_CACHE_MAX_ENTRIES;
        var maxChars = Number.isFinite(opts.maxChars)
            ? opts.maxChars : BODY_CACHE_MAX_CHARS;
        var deadlineMs = Number.isFinite(opts.deadlineMs)
            ? opts.deadlineMs : BODY_DEADLINE_MS;
        var setT = opts.setTimeoutFn || (typeof setTimeout === 'function'
            ? setTimeout : null);
        var clearT = opts.clearTimeoutFn || (typeof clearTimeout === 'function'
            ? clearTimeout : null);

        /** body_id -> entry. Map iteration order IS the LRU order. */
        var entries = new Map();
        /** body_id -> Promise, so two visible rows sharing a body fetch once. */
        var inflight = new Map();
        /** Running sum of entry.chars, kept in step with `entries`. */
        var totalChars = 0;
        /** Counters a test or a status row can read. */
        var stats = { fetches: 0, evictions: 0, hits: 0, gateRefusals: 0 };

        /**
         * Move an entry to the most-recently-used end.
         * @param {number|string} id @returns {?object} the entry
         */
        function touch(id) {
            if (!entries.has(id)) return null;
            var e = entries.get(id);
            entries.delete(id);
            entries.set(id, e);
            return e;
        }

        /**
         * Evict least-recently-used entries until BOTH caps hold. Either
         * cap alone is insufficient; see the file header.
         * @returns {number} how many entries were evicted
         */
        function evict() {
            var n = 0;
            while (entries.size > maxEntries || totalChars > maxChars) {
                var oldest = entries.keys().next();
                if (oldest.done) break;
                var e = entries.get(oldest.value);
                totalChars -= (e && Number.isFinite(e.chars) ? e.chars : 0);
                if (totalChars < 0) totalChars = 0;
                entries.delete(oldest.value);
                n++;
                stats.evictions++;
            }
            return n;
        }

        /**
         * Insert or replace one entry and re-run eviction.
         * @param {number|string} id
         * @param {object} entry must carry `state` and a numeric `chars`
         *   (0 when it holds no text)
         * @returns {object} the stored entry
         */
        function put(id, entry) {
            if (entries.has(id)) {
                var old = entries.get(id);
                totalChars -= (old && Number.isFinite(old.chars) ? old.chars : 0);
                entries.delete(id);
            }
            entry.chars = Number.isFinite(entry.chars) ? entry.chars : 0;
            entries.set(id, entry);
            totalChars += entry.chars;
            evict();
            return entry;
        }

        /**
         * Race one promise against the body deadline. A loading state
         * with no terminal condition is a state that can never fail,
         * which is the worst defect shape a verification surface has.
         * @param {Promise} p @param {number} ms
         * @returns {Promise} resolves with the value, or with a synthetic
         *   cannot_determine envelope. NEVER rejects.
         */
        function withDeadline(p, ms) {
            if (!setT) return p;
            return new Promise(function (resolve) {
                var done = false;
                var timer = setT(function () {
                    if (done) return;
                    done = true;
                    resolve({
                        result: null,
                        result_status: 'cannot_determine',
                        scope_status: 'resolved',
                        unevaluated: [{ subject: 'body',
                            reason: 'no response in ' + Math.round(ms / 1000) + 's' }],
                        meta: {}
                    });
                }, ms);
                /**
                 * Settle once, whichever way. The rejection arm matters:
                 * a promise that neither resolves nor rejects is a
                 * loading state that can never terminate, which is the
                 * defect the deadline exists to prevent, reintroduced one
                 * layer down. callEnvelope() is documented never to
                 * reject, so this should be unreachable in production;
                 * without it a future api that DOES reject wedges the row
                 * forever with no error anywhere. Found by mutation
                 * testing: the suite HUNG instead of going red.
                 * @param {*} v resolved value, or null on rejection
                 * @param {*} err the rejection reason, or null
                 * @returns {void}
                 */
                function settle(v, err) {
                    if (done) return;
                    done = true;
                    if (clearT) clearT(timer);
                    resolve(err ? {
                        result: null,
                        result_status: 'cannot_determine',
                        scope_status: 'resolved',
                        unevaluated: [{ subject: 'body',
                            reason: 'the body request threw: ' +
                                    String(err && err.message ? err.message : err) }],
                        meta: {}
                    } : v);
                }
                p.then(function (v) { settle(v, null); },
                       function (e) { settle(null, e || new Error('rejected')); });
            });
        }

        /**
         * Turn a body payload into a cache entry, applying the mask.
         * @param {number|string} id
         * @param {object} payload must carry body_json; may carry
         *   `secrets` and `secret_finding_count`
         * @returns {object} the stored entry
         */
        function ingest(id, payload) {
            var body = payload && payload.body_json;
            var declared = payload && Number.isInteger(payload.secret_finding_count)
                ? payload.secret_finding_count : 0;
            if (typeof body !== 'string') {
                return put(id, { state: STATE_CANNOT_DETERMINE, text: null,
                    chars: 0, reason: 'the response carried no body_json string',
                    findingCount: declared, masked: 0 });
            }
            var m = _applyMask(body, payload.secrets, declared);
            // On a refusal `text` is null by construction, so the raw
            // body is never stored and `chars` counts nothing. The raw
            // string goes out of scope here and is never reachable again.
            return put(id, {
                state: m.state,
                text: m.text,
                chars: m.text === null ? 0 : m.text.length,
                masked: m.masked,
                reason: m.reason,
                findingCount: m.findingCount,
                bodyHref: payload.body_href || null
            });
        }

        /**
         * Accept a body that arrived on a /lines page, without spending a
         * second request. Honours the gate first and DROPS anything it
         * cannot mask, so the caller falls back to a real /bodies/{id}
         * fetch that carries the offsets.
         *
         * THE GAP THIS EXISTS FOR: /lines?include_bodies=true was
         * documented (design doc K.1) as returning a secret-bearing body
         * with NO `secrets` array. Re-verified live 2026-08-31 against
         * transcript 4 line 32 (secret_finding_count 2) and the array IS
         * present, with utf16_state "computed", so the gap appears
         * closed. This path stays defensive anyway: a body that cannot be
         * masked is not stored, so a regression costs a refetch and never
         * a disclosure.
         * @param {object} row a /lines row carrying body_json
         * @returns {?object} the stored entry, or null if the row was not
         *   usable and the caller must fetch properly
         */
        function offer(row) {
            var gate = gateFor(row);
            if (gate.state !== STATE_OK) return null;
            if (!row || typeof row.body_json !== 'string') return null;
            var declared = Number.isInteger(row.secret_finding_count)
                ? row.secret_finding_count : 0;
            var m = _applyMask(row.body_json, row.secrets, declared);
            if (m.state === STATE_MASK_REFUSED) return null;
            return put(row.body_id, {
                state: m.state, text: m.text, chars: m.text.length,
                masked: m.masked, reason: null, findingCount: m.findingCount,
                bodyHref: row.body_href || null
            });
        }

        /**
         * Fetch and cache one body, honouring the gates. NORMATIVE: a
         * hard-gated or server-withheld body is NEVER fetched, at any
         * value of `force`. A soft-gated body is fetched only when the
         * reader explicitly asked, which is what `force` means.
         * @param {object} row a spine row
         * @param {boolean} force the reader pressed "render anyway"
         * @returns {Promise<object>} the cache entry. Never rejects.
         * @example await cache.request(row);        // auto path
         *          await cache.request(row, true);  // render anyway
         */
        function request(row, force) {
            var gate = gateFor(row);

            if (gate.state === STATE_GATED_HARD || gate.state === STATE_WITHHELD ||
                    gate.state === STATE_NO_BODY ||
                    gate.state === STATE_CANNOT_DETERMINE) {
                stats.gateRefusals++;
                return Promise.resolve({ state: gate.state, text: null, chars: 0,
                    masked: 0, reason: gate.reason, findingCount: 0,
                    bodyHref: (row && row.body_href) || null, gated: true });
            }
            if (gate.state === STATE_GATED_SOFT && !force) {
                stats.gateRefusals++;
                return Promise.resolve({ state: STATE_GATED_SOFT, text: null,
                    chars: 0, masked: 0, reason: gate.reason, findingCount: 0,
                    bodyHref: (row && row.body_href) || null, gated: true });
            }

            var id = row.body_id;
            var hit = touch(id);
            if (hit) { stats.hits++; return Promise.resolve(hit); }
            if (inflight.has(id)) return inflight.get(id);

            stats.fetches++;
            var p = withDeadline(
                Promise.resolve().then(function () { return api.getArchiveBody(id); }),
                deadlineMs
            ).then(function (res) {
                inflight.delete(id);
                // UNWRAP THE callEnvelope RESULT. api.getArchiveBody()
                // resolves to {envelope, httpStatus, headers,
                // transportError}, NOT to the envelope itself. Passing the
                // wrapper straight to classify() reads result_status as
                // undefined and turns EVERY body in the reader into a
                // could-not-evaluate - measured 2026-08-31 against the
                // live server, which was returning result_status 'ok' the
                // whole time. It survived because this file's unit-test
                // mock returned a bare envelope, so the test and the
                // product disagreed about the shape and only the product
                // was wrong.
                var env = res && Object.prototype.hasOwnProperty.call(res, 'envelope')
                    ? res.envelope : res;
                if (res && res.transportError) {
                    // A dead network is its own outcome and must not be
                    // laundered into whatever classify() makes of a null
                    // envelope.
                    return put(id, { state: STATE_CANNOT_DETERMINE, text: null,
                        chars: 0, masked: 0, findingCount: 0,
                        reason: 'the request did not complete: ' +
                            String(res.transportError),
                        outcomeToken: 'transport-error', envelope: null,
                        bodyHref: null });
                }
                var c = window.ArchiveOutcome.classify(env);
                if (c.token !== 'ok') {
                    return put(id, { state: STATE_CANNOT_DETERMINE, text: null,
                        chars: 0, masked: 0, findingCount: 0,
                        reason: _reasonFrom(c),
                        outcomeToken: c.token, envelope: env, bodyHref: null });
                }
                var payload = env.result;
                if (Array.isArray(payload)) payload = payload[0];
                return ingest(id, payload);
            });
            inflight.set(id, p);
            return p;
        }

        /**
         * Read a cached entry without fetching. Absence means "not
         * requested", which the reader renders as a sized placeholder
         * and never as a spinner.
         * @param {number|string} bodyId @returns {?object}
         */
        function get(bodyId) { return touch(bodyId); }

        /**
         * Is a fetch for this body currently in flight?
         * @param {number|string} bodyId @returns {boolean}
         */
        function isLoading(bodyId) { return inflight.has(bodyId); }

        return {
            gateFor: gateFor,
            request: request,
            offer: offer,
            get: get,
            isLoading: isLoading,
            /** Cached entry count. @returns {number} */
            size: function () { return entries.size; },
            /** Cached characters across all entries. @returns {number} */
            chars: function () { return totalChars; },
            /** Fetch/evict/hit counters. @returns {object} */
            stats: function () { return Object.assign({}, stats); },
            /** Drop everything, e.g. when the transcript changes. */
            clear: function () {
                entries.clear(); inflight.clear(); totalChars = 0;
            }
        };
    }

    /**
     * One-line reason from a classified failure envelope, naming what
     * could not be evaluated rather than leaving a blank.
     * @param {object} c an ArchiveOutcome.classify() result
     * @returns {string}
     */
    function _reasonFrom(c) {
        var first = c.reasons && c.reasons.length ? c.reasons[0] : null;
        if (first && first.reason) {
            return (first.subject ? first.subject + ': ' : '') + first.reason;
        }
        return 'the body request returned ' + c.token +
               ' and carried no reason';
    }

    window.ArchiveBodyCache = {
        createCache: createCache,
        gateFor: gateFor,
        BODY_INLINE_MAX: BODY_INLINE_MAX,
        BODY_RENDER_HARD_MAX: BODY_RENDER_HARD_MAX,
        BODY_CACHE_MAX_ENTRIES: BODY_CACHE_MAX_ENTRIES,
        BODY_CACHE_MAX_CHARS: BODY_CACHE_MAX_CHARS,
        BODY_DEADLINE_MS: BODY_DEADLINE_MS,
        STATE_OK: STATE_OK,
        STATE_GATED_SOFT: STATE_GATED_SOFT,
        STATE_GATED_HARD: STATE_GATED_HARD,
        STATE_WITHHELD: STATE_WITHHELD,
        STATE_MASK_REFUSED: STATE_MASK_REFUSED,
        STATE_CANNOT_DETERMINE: STATE_CANNOT_DETERMINE,
        STATE_LOADING: STATE_LOADING,
        STATE_NO_BODY: STATE_NO_BODY
    };
    console.log('[ArchiveBodyCache Module] Exported as window.ArchiveBodyCache');
})();
