/**
 * A KEYED DOM NODE CACHE for one archive reader instance.
 *
 * WHAT THIS EXISTS TO STOP. `archive-reader.js`'s paint() used to clear
 * its render window and call ArchiveLineRender.renderItem() for every
 * visible row on every single call, whether or not anything about that
 * row had changed. On the largest transcript in this corpus (30,805
 * lines, id 5767, measured 2026-08-31) that meant a full rebuild of
 * every visible row - new elements, new text nodes, new badges, new
 * buttons - on a plain scroll that never moved the window, on a
 * selection move that touched one row, and on a body finishing its
 * fetch for a row nowhere near the one that changed.
 *
 * THE CACHE IS A MAP FROM A STABLE ROW KEY TO {signature, node}. A
 * caller asks for a key with a signature; a matching signature returns
 * the SAME node object, unbuilt; a missing or DIFFERENT signature builds
 * a fresh node and replaces the entry. The signature is not consulted
 * "alongside" the lookup, it IS the lookup - get() cannot return a node
 * whose signature disagrees with the one just asked for, which is what
 * makes a policy change (see below) structurally unable to reuse a node
 * rather than relying on every caller remembering to check one.
 *
 * THIS FILE OWNS NO IDENTITY POLICY AND NO INVALIDATION POLICY. What a
 * row's key is, and what belongs in its signature, is the caller's
 * business - here specifically archive-reader.js, where a key is
 * 'line:<line_no>' or 'run:<from>' and the signature folds in the body
 * cache entry's state (which IS the disclosure/mask decision:
 * STATE_OK, STATE_GATED_SOFT, STATE_GATED_HARD, STATE_MASK_REFUSED,
 * STATE_WITHHELD, STATE_NO_BODY, STATE_LOADING, or "not-requested" for
 * a null entry). A cache with the policy baked in could not be reused
 * for the nav rail's smaller lists without carrying archive-reader's
 * assumptions along with it.
 *
 * RETAIN() IS WHAT KEEPS THIS BOUNDED. A 30,805-line transcript scrolled
 * top to bottom would otherwise accumulate one entry per line ever
 * visible, each holding a detached DOM subtree, forever. The caller
 * tells retain() which keys were used in the paint that just ran; every
 * other entry is dropped. Nothing here decides how big "in view" is -
 * that is the virtual list's overscan, upstream of this file.
 *
 * NO DOM CONSTRUCTION HAPPENS HERE. This file creates nothing and reads
 * nothing off a document; `build` is supplied by the caller and this
 * file only decides whether to call it.
 *
 * Depends on nothing. Exports window.ArchiveRowCache.
 */

console.log('[ArchiveRowCache Module] Loading...');

(function () {
    'use strict';

    /**
     * Description: build an empty, unbounded-until-retained node cache.
     * Inputs: none.
     * Output: object - {get, retain, clear, size}.
     * Example:
     *   var cache = ArchiveRowCache.createNodeCache();
     *   var node = cache.get('line:7', 'ok:0:0::120', function () {
     *       return document.createElement('article');
     *   });
     */
    function createNodeCache() {
        /** @type {Map<string, {signature: string, node: object}>} */
        var entries = new Map();

        /**
         * Description: the node for `key`, reused only when `signature`
         *   matches what is on record for it. A mismatch or a miss both
         *   build a fresh node through `build` and record it under the
         *   new signature, so a stale node can never be handed back
         *   under a signature that no longer describes it.
         * Inputs: key (string), signature (string), build (function(): object).
         * Output: object - the node.
         */
        function get(key, signature, build) {
            var hit = entries.get(key);
            if (hit && hit.signature === signature) {
                return hit.node;
            }
            var node = build();
            entries.set(key, { signature: signature, node: node });
            return node;
        }

        /**
         * Description: drop every entry whose key was not in the set
         *   just painted. Called once per paint so a scrolled-past row
         *   cannot accumulate in memory forever.
         * Inputs: activeKeys (Array<string>) - keys used in the paint
         *   that just ran.
         * Output: number - entries dropped.
         */
        function retain(activeKeys) {
            var keep = Object.create(null);
            var i;
            for (i = 0; i < activeKeys.length; i++) {
                keep[activeKeys[i]] = true;
            }
            var toDelete = [];
            entries.forEach(function (_entry, k) {
                if (!keep[k]) toDelete.push(k);
            });
            for (i = 0; i < toDelete.length; i++) {
                entries.delete(toDelete[i]);
            }
            return toDelete.length;
        }

        /**
         * Description: drop every entry. Called when the identity space
         *   a key is drawn from changes out from under the cache - a new
         *   transcript's line_no values are not the same rows as the
         *   old transcript's, even where the numbers coincide.
         * Inputs: none. Output: void.
         */
        function clear() { entries.clear(); }

        /** Description: entry count, for tests. Inputs: none. Output: number. */
        function size() { return entries.size; }

        return { get: get, retain: retain, clear: clear, size: size };
    }

    window.ArchiveRowCache = { createNodeCache: createNodeCache };
    console.log('[ArchiveRowCache Module] Exported as window.ArchiveRowCache');
})();
