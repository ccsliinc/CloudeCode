/**
 * The two lazy-loaded families' file lists, in the order they must execute.
 * See issue #48 and client/js/module-loader.js.
 *
 * WHY THIS IS ITS OWN FILE, SEPARATE FROM THE LOADER. module-loader.js is
 * the generic download-and-execute engine and knows nothing about archive
 * or config-editor specifically; this file is the ONE place that lists
 * which same-origin URLs belong to each family and in what order, so that
 * order can never drift between "what client/index.html used to load
 * eagerly" and "what app.js asks the loader for". Both call sites in
 * client/js/app.js read these arrays rather than each keeping their own
 * copy.
 *
 * ORDER IS DEPENDENCY ORDER, copied from the load-order comments that used
 * to sit beside these same <script> tags in client/index.html (see git
 * history around the "App Controller" / "Config/project file tree" blocks).
 * Do not reorder without re-reading why each file had to precede the next.
 *
 * WHAT IS DELIBERATELY NOT HERE. archive-deeplink.js and archive-entry.js
 * stay in client/index.html's eager script list: archive-deeplink.js is
 * route PARSING (client/js/router.js must be able to resolve a deep link
 * to /archive/t/<id> before anything is lazily loaded, or the app cannot
 * tell what to load), and archive-entry.js is the small always-visible
 * "is the archive on" probe both entry points call before the user has
 * clicked anything. modal-stack.js and markdown-lite.js also stay eager:
 * both are shared with modules that are NOT part of either lazy family
 * (server-status-panel.js and copy-output.js respectively), so moving them
 * here would load them twice or make an unrelated eager feature depend on
 * a lazy one.
 */

(function () {
    'use strict';

    /**
     * The message archive (explorer, nav, rows, filters, panes). Excludes
     * archive-deeplink.js and archive-entry.js - see file header.
     * @type {string[]}
     */
    var ARCHIVE = [
        '/static/js/api-archive.js',
        '/static/js/archive-outcome.js',
        '/static/js/archive-mask.js',
        '/static/js/archive-format.js',
        '/static/js/archive-fuzzy.js',
        '/static/js/archive-virtual-list.js',
        '/static/js/archive-state.js',
        '/static/js/archive-outcome-view.js',
        '/static/js/archive-body-gate.js',
        '/static/js/archive-body-cache.js',
        '/static/js/archive-line-render.js',
        '/static/js/archive-nav-fuzzy.js',
        '/static/js/archive-nav-row.js',
        '/static/js/archive-nav-card.js',
        '/static/js/archive-nav-info.js',
        '/static/js/archive-nav-tree.js',
        '/static/js/archive-nav-order.js',
        '/static/js/archive-nav-drill.js',
        '/static/js/archive-nav-merged.js',
        '/static/js/archive-nav.js',
        '/static/js/archive-tlist-row.js',
        '/static/js/archive-tlist-filter.js',
        '/static/js/archive-transcript-list.js',
        '/static/js/archive-keys.js',
        '/static/js/archive-keys-help.js',
        '/static/js/archive-reader-dom.js',
        '/static/js/archive-reader-paging.js',
        '/static/js/archive-reader-select.js',
        '/static/js/archive-reader-body.js',
        '/static/js/archive-row-cache.js',
        '/static/js/archive-reader.js',
        '/static/js/archive-search-render.js',
        '/static/js/archive-search.js',
        '/static/js/archive-export.js',
        '/static/js/archive-screen-reader.js',
        '/static/js/archive-chat-block.js',
        '/static/js/archive-chat-info.js',
        '/static/js/archive-chat-subagents.js',
        '/static/js/archive-chat-turn.js',
        '/static/js/archive-chat-estimate.js',
        '/static/js/archive-chat-stack.js',
        '/static/js/archive-chat-clicks.js',
        '/static/js/archive-chat-view.js',
        '/static/js/archive-chat-screen.js',
        '/static/js/archive-pane-resize.js',
        '/static/js/archive-crumb.js',
        '/static/js/archive-crumb-resolve.js',
        '/static/js/archive-screen-shell.js',
        '/static/js/archive-screen-tools.js',
        '/static/js/archive-screen-views.js',
        '/static/js/archive-screen.js'
    ];

    /**
     * The config/project file editor: the vendored CodeMirror bundle plus
     * every config-editor-*.js file and its drawer-pin companion. Excludes
     * modal-stack.js and markdown-lite.js - see file header.
     * @type {string[]}
     */
    var CONFIG_EDITOR = [
        '/static/vendor/codemirror/codemirror-bundle.js',
        '/static/js/config-editor-modal.js',
        '/static/js/config-editor-new-file.js',
        '/static/js/config-editor-roots.js',
        '/static/js/config-editor-tree-state.js',
        '/static/js/config-editor-lazy.js',
        '/static/js/config-editor-panel.js',
        '/static/js/config-drawer-pin.js'
    ];

    window.ModuleFamilies = {
        ARCHIVE: ARCHIVE,
        CONFIG_EDITOR: CONFIG_EDITOR
    };
})();
