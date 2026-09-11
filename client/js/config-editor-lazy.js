/**
 * Fetch one directory's children when the user expands it.
 *
 * Split out of client/js/config-editor-panel.js, which is already over this
 * project's 500-line ceiling. Cohesive on its own terms: it answers one
 * question - "what goes inside this directory, and did I actually find out" -
 * and owns the one request that answers it. No DOM; the panel renders.
 *
 * WHY THIS EXISTS. The panel has rendered lazily since it shipped: a
 * directory's children are not built into the DOM until it is first expanded.
 * But the SERVER still walked and sent every level of every root on open,
 * whether or not anything was ever expanded, and that walk is thousands of
 * `stat` syscalls. Measured on this repository's own working directory: about
 * 1600 nodes, 6501 `stat` calls, 264 to 477 ms - and the walk ran on the
 * server's event loop, so for that whole time no terminal websocket anywhere
 * in the app could be read from or written to. Lazy RENDERING saved DOM
 * nodes; it never saved the scan. This module is the half that saves the scan.
 *
 * THE THREE OUTCOMES ARE THE POINT, not the fetch. Before, a directory's
 * contents were decided server-side before anything rendered, so "empty" and
 * "unreadable" were the only two answers and `list_error` told them apart.
 * Fetching on expand adds a third: the answer may never arrive, after the
 * user has already clicked. An expansion that quietly reveals nothing reads
 * as "this directory is empty", which is the exact conflation this project
 * keeps paying for. So `childrenFor` returns a VERDICT with a status the
 * caller must switch on, never a bare array that an error path could leave
 * empty.
 *
 * COMPATIBILITY IS DECIDED BY ONE STRICT COMPARISON. `needsFetch` tests
 * `children_loaded === false`, not falsiness. A server that predates the
 * field omits it, so it reads `undefined`, so nothing is ever fetched and the
 * panel renders the full tree it was already given - which is exactly the old
 * behaviour, reached without a version check.
 *
 * Must load AFTER api.js (window.API) and config-editor-roots.js
 * (window.ConfigEditorRoots), and BEFORE config-editor-panel.js.
 */

console.log('[ConfigEditorLazy Module] Loading...');

(function () {
'use strict';

/**
 * How many levels to ask for per request. One: the entries of the directory
 * being expanded, with their own children left unfetched. Asking for two
 * would prefetch a level the user has not asked for and may never open,
 * which is the cost this whole module exists to stop paying.
 * @type {number}
 */
const FETCH_DEPTH = 1;

/**
 * True when this node's children have to be fetched before they can render.
 *
 * @param {{is_dir?: boolean, children_loaded?: boolean}} node  A server
 *   TreeNode, or the panel's synthetic root node.
 * @returns {boolean} True only when the server positively said it did not
 *   look inside this directory. An absent `children_loaded` (old server, or
 *   the synthetic root the panel builds around a fetched list) is treated as
 *   loaded - see the module docstring.
 */
function needsFetch(node) {
    return !!(node && node.is_dir && node.children_loaded === false);
}

/**
 * Resolve one directory's children, fetching them only if needed.
 *
 * @param {string} rootId - "user" | "project" | "workdir".
 * @param {object} node - The server TreeNode being expanded.
 * @param {string|null} projectPath - Working directory, for the two project
 *   roots; null for "user".
 * @returns {Promise<{status: string, nodes?: object[], message?: string}>}
 *   `status` is one of:
 *   - `'have'` - the children were already in hand; `nodes` is them.
 *   - `'loaded'` - fetched successfully; `nodes` is them, possibly empty,
 *     and an empty list here is a MEASURED empty directory.
 *   - `'list_error'` - the server listed this node's parent but reported it
 *     could not enumerate this one; `message` is the rendered sentence.
 *   - `'failed'` - the request did not produce an answer; `message` is the
 *     rendered sentence. Never fold this into `'loaded'` with an empty list.
 */
async function childrenFor(rootId, node, projectPath) {
    // A server-reported list_error outranks everything: it is already a
    // measured "could not evaluate" for this exact directory, so there is
    // nothing to ask for and asking again would just fail differently.
    if (node && node.list_error) {
        return {
            status: 'list_error',
            message: window.ConfigEditorRoots.listErrorNotice(node.list_error),
        };
    }
    if (!needsFetch(node)) {
        return { status: 'have', nodes: (node && node.children) || [] };
    }
    try {
        const resp = await window.API.getConfigFileTree(rootId, projectPath, {
            path: node.rel_path,
            depth: FETCH_DEPTH,
        });
        return { status: 'loaded', nodes: (resp && resp.tree) || [] };
    } catch (err) {
        // Deliberately NOT swallowed into an empty list. A 503 means the
        // directory exists and could not be read, a 400 means it is no
        // longer there under that name, and a thrown network error means we
        // never got to ask - all three are "I could not find out", and all
        // three must look different on screen from "there is nothing here".
        const detail = (err && err.message) || String(err);
        console.warn(`ConfigEditorLazy: expand failed for ${rootId}:${node.rel_path}:`, err);
        return {
            status: 'failed',
            message: window.ConfigEditorRoots.expandFailedNotice(detail),
        };
    }
}

window.ConfigEditorLazy = { FETCH_DEPTH, needsFetch, childrenFor };
console.log('[ConfigEditorLazy Module] Exported as window.ConfigEditorLazy');

}());
