/**
 * Same-origin script loader for the two heavy families most sessions never
 * open: the message archive (client/js/archive-*.js) and the config/project
 * file editor (client/js/config-editor-*.js plus the vendored CodeMirror
 * bundle). See issue #48.
 *
 * WHY NATIVE SCRIPT INJECTION, NOT dynamic import(). client/ ships classic
 * scripts that assign to `window` at parse time - not ES modules - and has
 * no build step. Converting 59 files to modules to use import() would be a
 * much larger, riskier change for the same outcome. This loader creates
 * ordinary <script src="..."> elements with the same same-origin /static/
 * URLs those files already use.
 *
 * WHY THIS SATISFIES THE CSP UNCHANGED. `script-src 'self'` allows a
 * same-origin <script src>; it does not allow inline script or eval. This
 * file never sets `.textContent` on a script element, never calls `eval`
 * or `Function(...)`, and never fetches a family's source as text to run
 * it - it only ever points a <script> tag's `src` at a URL already inside
 * this app's own /static/ tree. See tests/test_no_remote_assets.py and
 * docs/DECISIONS.md's security posture section for why that boundary is
 * absolute here.
 *
 * DOWNLOAD CONCURRENTLY, EXECUTE IN ORDER. A dynamically created <script>
 * defaults to `async = true`, which lets the browser execute it as soon as
 * it arrives, in WHATEVER ORDER the responses land - exactly wrong for a
 * family whose files read each other's globals at parse or call time (see
 * the load-order comments already in client/index.html for the archive and
 * config-editor blocks: "must load before", "reads window.X at create()
 * time"). Setting `script.async = false` on each element keeps the
 * fetch-in-parallel behavior while making the browser execute the scripts
 * in DOCUMENT ORDER regardless of which one's response arrives first. This
 * is a standard, spec-guaranteed technique (see
 * https://www.html5rocks.com/en/tutorials/speed/script-loading/,
 * "Async & Defer" - "dynamically inserted scripts... execute as soon as
 * they arrive, UNLESS you explicitly set async = false"). Case 6 in the
 * issue - execution order preserved when downloads complete out of order -
 * is what this buys, and tests/test_module_loader.node.mjs drives it by
 * making an earlier resource resolve after a later one.
 *
 * RETRY ONLY THE FAILED RESOURCE, IN PLACE. A resource that 404s or is
 * blocked gets its OWN element's `src` reassigned (with a cache-busting
 * query param, so a proxy that briefly cached an error response is not
 * retried into the same failure) rather than the whole family being
 * re-fetched from scratch. The element never moves in the DOM, so a retry
 * can never change execution order relative to its siblings - the browser
 * still executes the family in document order once every element has
 * either loaded or exhausted its retries.
 *
 * IDEMPOTENT PER FAMILY NAME. `loadFamily()` remembers three states per
 * name: never asked (fresh attempt), currently loading (returns the SAME
 * in-flight promise, so pressing the archive button twice never injects
 * the scripts twice or re-runs their top-level init code), and loaded
 * (returns an already-resolved promise, no DOM work at all). A family that
 * FAILED is not remembered as failed forever - the next call starts a
 * fresh attempt, because "loaded" is the only state that must be
 * permanent; refusing to ever retry a transient network failure would be
 * worse than the problem this file exists to solve.
 *
 * A FAMILY THAT CANNOT LOAD MUST FAIL LOUDLY. This module never silently
 * swallows a failure: `loadFamily()`'s returned promise REJECTS, naming
 * every URL that could not be loaded after its retries. The callers in
 * client/js/app.js are what turn that rejection into a screen the user can
 * actually see (the existing `#deep-link-error` banner via
 * window.Router.showError) rather than a blank screen with only a console
 * line - see the CDN-removal incident this same codebase already paid for
 * (docs, "why the CDN removal was a correctness fix"): a silently degraded
 * asset load is exactly the failure shape that cost real users a working
 * terminal.
 */

(function () {
    'use strict';

    /** @type {string} Nothing has been asked for yet. */
    var STATUS_UNLOADED = 'unloaded';
    /** @type {string} A loadFamily() call is in flight. */
    var STATUS_LOADING = 'loading';
    /** @type {string} Every resource in the family executed successfully. */
    var STATUS_LOADED = 'loaded';
    /** @type {string} The most recent attempt failed; the next call retries. */
    var STATUS_FAILED = 'failed';

    /** @type {number} Retries per resource before that resource gives up. */
    var DEFAULT_MAX_RETRIES = 2;
    /** @type {number} Base backoff between retries, multiplied by attempt #. */
    var DEFAULT_RETRY_DELAY_MS = 300;

    /**
     * Per-family bookkeeping, keyed by family name.
     * @type {Object<string, {status: string, promise: (Promise|null)}>}
     */
    var _families = {};

    /**
     * Load one <script src> element, retrying that element in place on
     * failure. Never rejects: it always resolves with a result object, so
     * a family's Promise.all() runs every resource's retries to completion
     * rather than short-circuiting on the first failure.
     *
     * Inputs:
     *   url (string) - same-origin path under /static/.
     *   maxRetries (number) - retry attempts after the first failure.
     *   retryDelayMs (number) - base backoff, multiplied by attempt number.
     * Output: Promise<{ok: boolean, url: string, attempts: number}>.
     * Example: _loadOneScript('/static/js/archive-screen.js', 2, 300)
     */
    function _loadOneScript(url, maxRetries, retryDelayMs) {
        return new Promise(function (resolve) {
            var attempts = 0;
            var script = document.createElement('script');
            script.src = url;
            // The whole point: keep parallel download, force document-order
            // execution. See the file header comment.
            script.async = false;

            function cleanup() {
                script.removeEventListener('load', onLoad);
                script.removeEventListener('error', onError);
            }

            function onLoad() {
                cleanup();
                resolve({ ok: true, url: url, attempts: attempts });
            }

            function onError() {
                attempts += 1;
                if (attempts <= maxRetries) {
                    setTimeout(function () {
                        // Re-trigger a fetch on the SAME element, so its
                        // position in document order (and therefore its
                        // place in the execution queue) never changes.
                        // The cache-busting param defeats a proxy or
                        // service that briefly caches an error response.
                        var sep = url.indexOf('?') === -1 ? '?' : '&';
                        script.src = url + sep + '_retry=' + attempts;
                    }, retryDelayMs * attempts);
                    return;
                }
                cleanup();
                resolve({ ok: false, url: url, attempts: attempts });
            }

            script.addEventListener('load', onLoad);
            script.addEventListener('error', onError);
            document.head.appendChild(script);
        });
    }

    /**
     * Load a named family of same-origin scripts, downloading concurrently
     * and executing in the given order. Idempotent: a second call while
     * loading returns the same in-flight promise, and a second call after
     * a success resolves immediately with no DOM work.
     *
     * Inputs:
     *   name (string) - stable identifier for this family, e.g. 'archive'.
     *   urls (string[]) - same-origin script URLs, in the order they must
     *     execute.
     *   opts (object|undefined) - {maxRetries, retryDelayMs}, per-resource.
     * Output: Promise<{ok: true, name: string, cached: boolean}> - rejects
     *   with an Error naming every URL that could not be loaded.
     * Example:
     *   window.ModuleLoader.loadFamily('archive', ['/static/js/a.js'])
     *       .then(function () { window.ArchiveScreen.show({}); })
     *       .catch(function (err) { window.Router.showError(err.message); });
     */
    function loadFamily(name, urls, opts) {
        var existing = _families[name];
        if (existing && existing.status === STATUS_LOADED) {
            return Promise.resolve({ ok: true, name: name, cached: true });
        }
        if (existing && existing.status === STATUS_LOADING && existing.promise) {
            return existing.promise;
        }

        var o = opts || {};
        var maxRetries = typeof o.maxRetries === 'number' ? o.maxRetries : DEFAULT_MAX_RETRIES;
        var retryDelayMs = typeof o.retryDelayMs === 'number' ? o.retryDelayMs : DEFAULT_RETRY_DELAY_MS;

        // Every element is created and appended NOW, in order, so the
        // browser's download-parallel/execute-in-order guarantee applies
        // to the whole family regardless of which network response lands
        // first.
        var perScript = urls.map(function (url) {
            return _loadOneScript(url, maxRetries, retryDelayMs);
        });

        var promise = Promise.all(perScript).then(function (results) {
            var failed = results.filter(function (r) { return !r.ok; });
            if (failed.length > 0) {
                _families[name] = { status: STATUS_FAILED, promise: null };
                var names = failed.map(function (r) { return r.url; });
                throw new Error(
                    'module family "' + name + '" failed to load: ' +
                    names.join(', ')
                );
            }
            _families[name] = { status: STATUS_LOADED, promise: promise };
            return { ok: true, name: name, cached: false };
        });

        _families[name] = { status: STATUS_LOADING, promise: promise };
        return promise;
    }

    /**
     * Description: the last-known status of a family.
     * Inputs: name (string).
     * Output: string - one of the STATUS_* constants; STATUS_UNLOADED if
     *   loadFamily() was never called for this name.
     * Example: window.ModuleLoader.status('archive') === 'loaded'
     */
    function status(name) {
        var f = _families[name];
        return f ? f.status : STATUS_UNLOADED;
    }

    window.ModuleLoader = {
        loadFamily: loadFamily,
        status: status,
        STATUS_UNLOADED: STATUS_UNLOADED,
        STATUS_LOADING: STATUS_LOADING,
        STATUS_LOADED: STATUS_LOADED,
        STATUS_FAILED: STATUS_FAILED
    };
})();
