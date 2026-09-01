/**
 * Archive screen - the message browser's COMPOSITION ROOT. Every other
 * `archive-*.js` file is self-contained and knows nothing of the others;
 * this is the only place that knows all of them, and its whole job is
 * wiring plus lifecycle - no rendering rules, no outcome interpretation.
 *
 * ONE RULE ABOVE ALL: THIS FILE NEVER BRANCHES ON `result_status`,
 * `scope_status` OR `scan.status`. `archive-outcome.js` is the single
 * interpreter (design doc B.3) and `archive-outcome-view.js` the single
 * renderer; a second place branching on those fields is how two branch
 * sets drift until one renders `partial` as `ok`. Where this file must
 * know whether a response is usable it asks `ArchiveOutcome.classify()`
 * and reads the returned TOKEN.
 *
 * THE SHELL IS BUILT AT SCRIPT LOAD, NOT INSIDE `show()`, because
 * `App.showArchive()` calls `_placeStatusLight('archive')` and
 * `GlobalAudioToggle.place('archive')` BEFORE `show()` and both re-parent
 * into `#archive-bar-status`, part of this shell. Building it lazily
 * would mean that on the FIRST navigation the target does not exist, both
 * calls silently no-op (they tolerate a missing target, correctly), and
 * the status light and audio button are absent with no error anywhere - a
 * silent half-wired screen. This script tag sits after `#archive-screen`.
 *
 * NARROW LAYOUT IS A RENDERING CHOICE OVER ONE STATE, NOT A SECOND STATE
 * MACHINE (design doc C.5): the route already names the current pane, so
 * `data-pane` is written from the same `view` the router produced and CSS
 * decides what shows. There is no separate mobile model to keep in sync.
 */

console.log('[ArchiveScreen Module] Loading...');

(function () {
    'use strict';

    /** Root element id, owned by index.html. @type {string} */
    var SCREEN_ID = 'archive-screen';

    /** Class prefix for everything this file builds. @type {string} */
    var ROOT_CLASS = 'archive-screen';

    /**
     * Spine rows per reader page - ONE size for BOTH the first window and
     * every subsequent page. The lines endpoint takes a `start_line`
     * parameter (shipped 2026-08-31, plumbed through api.listArchiveLines,
     * documented in src/core/archive_start_line.py), so a deep link past
     * this many rows pages forward to it. @type {number} */
    var SPINE_PAGE_ROWS = 500;

    /** Viewport width below which the three columns collapse to one pane.
     *  Mirrors the 900px breakpoint in archive-screen.css; the two must
     *  agree, which is why it is named in both. @type {number} */
    var NARROW_MAX_PX = 900;

    /** Live wiring, or null before the first show(). @type {?object} */
    var wired = null;

    /** The shell's elements, built once. @type {?object} */
    var shell = null;

    /** Action name -> handler, built on first keydown. @type {?object} */
    var handlers = null;

    /** The route currently rendered. @type {object} */
    var current = { view: 'root', projectId: null, transcriptId: null,
                    lineNo: null, query: {} };

    /** Create an element. Inputs: tag, cls|null, text|null. Output: Element. */
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== null && text !== undefined) n.textContent = text;
        return n;
    }

    /** Apply attributes to a node and return it, so a control and what
     *  makes it one read as one expression. Inputs: node, map. Output:
     *  node. Example: attrs(el('button', 'x', 'Go'), {type: 'button'}) */
    function attrs(node, map) {
        var names = Object.keys(map || {});
        for (var i = 0; i < names.length; i++) {
            node.setAttribute(names[i], map[names[i]]);
        }
        return node;
    }

    /** Build the screen shell exactly once, idempotent. Output:
     *  object|null - null when #archive-screen is absent, reported not
     *  swallowed: it means index.html and this module disagree. */
    function buildShell() {
        if (shell) return shell;
        var root = document.getElementById(SCREEN_ID);
        if (!root) {
            console.error('ArchiveScreen: #' + SCREEN_ID + ' is missing from ' +
                'index.html. The screen cannot mount.');
            return null;
        }
        root.textContent = '';

        var crumb = attrs(el('nav', ROOT_CLASS + '__crumb', null),
                          { 'aria-label': 'Archive location' });
        var back = attrs(el('button', ROOT_CLASS + '__back', 'Back'),
                         { type: 'button', 'data-action': 'back-pane' });

        var grid = el('div', ROOT_CLASS + '__grid', null);
        var navPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--nav', null);
        var listPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--list', null);
        var readPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--reader', null);
        grid.appendChild(navPane);
        grid.appendChild(listPane);
        grid.appendChild(readPane);

        // `#archive-bar-status` is the re-parent target for
        // App._placeStatusLight('archive') and GlobalAudioToggle.place();
        // the *-text span mirrors the home and terminal bars so
        // _syncStatusLabel() has a target.
        var bar = el('div', ROOT_CLASS + '__bar', null);
        var status = el('span', ROOT_CLASS + '__status', null);
        status.id = 'archive-bar-status';
        var statusText = el('span', ROOT_CLASS + '__status-text', null);
        statusText.id = 'archive-bar-status-text';
        status.appendChild(statusText);
        bar.appendChild(status);

        root.appendChild(back);
        root.appendChild(crumb);
        root.appendChild(grid);
        root.appendChild(bar);

        shell = { root: root, crumb: crumb, back: back, grid: grid,
                  navPane: navPane, listPane: listPane, readPane: readPane };
        return shell;
    }

    /**
     * Description: write the address bar for a route. A THIN DELEGATION
     *   on purpose - ArchiveDeeplink owns both building a path and
     *   writing it, so the crumb, the URL and the inbound parser cannot
     *   disagree about a location. Nothing is decided here. Inputs:
     *   route (object), opts|undefined {replace}. Output: void.
     */
    function syncUrl(route, opts) {
        if (!window.ArchiveDeeplink) return;
        window.ArchiveDeeplink.syncUrl(route, window, opts);
    }

    /** Render the breadcrumb. The SEGMENT WORDING stays here, the only
     *  file that knows what is open; the markup comes from
     *  ArchiveDeeplink, beside the path builder. Inputs: parts. Void. */
    function paintCrumb(parts) {
        if (!shell) return;
        shell.crumb.textContent = '';
        var nodes = window.ArchiveDeeplink.renderCrumb(document, parts, ROOT_CLASS);
        for (var i = 0; i < nodes.length; i++) shell.crumb.appendChild(nodes[i]);
    }

    /** Record which pane is current so the narrow layout shows exactly
     *  one. Written from the ROUTE, never a click, so back/forward and a
     *  fresh load agree. Inputs: view. Output: void. */
    function setPane(view) {
        if (!shell) return;
        var pane = view === 'transcript' || view === 'line' ? 'reader'
            : view === 'project' ? 'list' : 'nav';
        shell.root.setAttribute('data-pane', pane);
        shell.back.hidden = pane === 'nav';
    }

    /** Is the viewport one-pane. Measured live, not cached, because a
     *  rotate changes it. Inputs: none. Output: boolean. */
    function isNarrow() {
        return typeof window.innerWidth === 'number' && window.innerWidth < NARROW_MAX_PX;
    }

    /** Build every sub-view once and connect them. Each owns its own
     *  outcome rendering; this only routes selections between them.
     *  Inputs: none. Output: object, cached in `wired`. */
    function wire() {
        if (wired) return wired;
        var api = window.API;

        var nav = window.ArchiveNav.create({
            api: api,
            onSelect: function (kind, id, row) { onNavSelect(kind, id, row); }
        });
        shell.navPane.appendChild(nav.element);

        var list = window.ArchiveTranscriptList.create({
            api: api,
            onSelect: function (transcriptId) { openTranscript(transcriptId, null); }
        });
        shell.listPane.appendChild(list.element);

        var search = window.ArchiveSearch.create({
            api: api,
            onOpenHit: function (hit) {
                openTranscript(hit && hit.transcript_id,
                               hit ? hit.line_no : null);
            }
        });
        search.element.hidden = true;
        shell.listPane.appendChild(search.element);

        var reader = window.ArchiveReader.createReader({ document: document, api: api });
        reader.mount(shell.readPane);

        // The reader's toolbar is built here rather than in
        // archive-reader.js because search and export are cross-pane:
        // search writes into the list column and export opens a modal,
        // neither of which the reader knows about.
        var tools = el('div', ROOT_CLASS + '__tools', null);
        var searchInput = attrs(el('input', ROOT_CLASS + '__search-input', null), {
            type: 'search',
            placeholder: 'search this transcript',
            'aria-label': 'Search in the open transcript'
        });
        var searchBtn = attrs(el('button', ROOT_CLASS + '__search-btn', 'Search'),
                              { type: 'button', 'data-action': 'run-search' });
        var exportBtn = attrs(el('button', ROOT_CLASS + '__export-btn', 'Export'),
                              { type: 'button', 'data-action': 'open-export' });
        tools.appendChild(searchInput);
        tools.appendChild(searchBtn);
        tools.appendChild(exportBtn);
        shell.readPane.insertBefore(tools, shell.readPane.firstChild);

        searchBtn.addEventListener('click', function () { runSearch(searchInput.value); });
        searchInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') runSearch(searchInput.value);
        });
        exportBtn.addEventListener('click', function () { openExport(); });
        shell.back.addEventListener('click', function () { goBackPane(); });

        // The reader's pager, so its button and the `m` key take one
        // path. `current.transcriptId` is read at CALL time, never
        // captured: the reader outlives any one transcript, so a captured
        // id would page whatever was open at wire time forever.
        reader.setOnLoadMore(function () {
            return window.ArchiveScreenReader.loadMoreLines({
                reader: reader,
                pane: shell.readPane,
                api: api,
                transcriptId: current.transcriptId,
                spinePageRows: SPINE_PAGE_ROWS
            });
        });

        wired = { nav: nav, list: list, search: search, reader: reader,
                  searchInput: searchInput, exportBtn: exportBtn };
        document.addEventListener('keydown', onKeydown);
        return wired;
    }

    /** A leaf was chosen in the rail. A project and the unattributed
     *  bucket are two scopes for one list view, and only a project has a
     *  shareable route. Inputs: kind, id, row. Output: void. */
    function onNavSelect(kind, id, row) {
        var inScope = row && typeof row.transcript_count === 'number'
            ? row.transcript_count : null;
        if (kind === window.ArchiveNav.NODE_KINDS.UNATTRIBUTED) {
            // No route exists for this scope by design: it is a property
            // of a corpus, not an addressable collection, and inventing
            // /archive/u/<corpus> would be a URL nothing else parses.
            wired.list.load({ kind: 'unattributed', id: id, inScope: inScope });
            paintCrumb([String(row && row.corpus_key || id), 'unattributed']);
            setPane('project');
            return;
        }
        current = { view: 'project', projectId: id, transcriptId: null,
                    lineNo: null, query: {} };
        syncUrl(current);
        applyRoute(current);
    }

    /** Open a transcript in the reader and route to it. Inputs:
     *  transcriptId (number|null), lineNo (number|null). Output: void. */
    function openTranscript(transcriptId, lineNo) {
        if (typeof transcriptId !== 'number') return;
        current = { view: lineNo === null || lineNo === undefined ? 'transcript' : 'line',
                    projectId: current.projectId, transcriptId: transcriptId,
                    lineNo: lineNo === undefined ? null : lineNo, query: {} };
        syncUrl(current);
        applyRoute(current);
    }

    /** Run a search scoped to whatever is open - the transcript if one
     *  is, else the project. Inputs: q (string). Output: Promise|void. */
    function runSearch(q) {
        var text = typeof q === 'string' ? q.trim() : '';
        if (!text) return;
        wired.search.element.hidden = false;
        wired.list.element.hidden = true;
        var scope = { q: text };
        if (current.transcriptId !== null) scope.transcriptId = current.transcriptId;
        else if (current.projectId !== null) scope.projectId = current.projectId;
        return wired.search.run(scope);
    }

    /** Put the transcript list back in the middle column. Output: void. */
    function dismissSearch() {
        if (!wired) return;
        wired.search.element.hidden = true;
        wired.list.element.hidden = false;
    }

    /** Open the export modal for whatever is open. The refusal when
     *  nothing is open lives in ArchiveExport.openFor(), beside the rest
     *  of what an export needs. Inputs: none. Output: void. */
    function openExport() {
        window.ArchiveExport.openFor({
            document: document, api: window.API,
            transcriptId: current.transcriptId, sameNameCount: null
        });
    }

    /**
     * Description: the route one pane back - from a transcript or line
     *   with a KNOWN project to that project, otherwise to the root. One
     *   shape written once, so the destinations cannot acquire different
     *   field sets. Inputs: view, projectId. Output: object - a route.
     */
    function backRoute(view, projectId) {
        var toProject = (view === 'transcript' || view === 'line') && projectId !== null;
        return { view: toProject ? 'project' : 'root',
                 projectId: toProject ? projectId : null,
                 transcriptId: null, lineNo: null, query: {} };
    }

    /** Step back one pane on a narrow viewport. Output: void. */
    function goBackPane() {
        current = backRoute(current.view, current.projectId);
        syncUrl(current);
        applyRoute(current);
    }

    /**
     * Description: send LOAD_MORE to the pager the person is looking at.
     *   THREE cases in order: focus inside the reader pane -> the reader;
     *   focus elsewhere but a transcript open -> still the reader;
     *   otherwise -> the transcript list. The middle case is the measured
     *   bug: on /archive/t/5767 `document.activeElement` is NOT inside the
     *   reader, so a focus-only test pages the list while the person
     *   stares at a transcript. The old code had ONE case and always
     *   chose the list, which is why `m` did nothing in the reader.
     * Inputs: none. Output: Promise|void - what the chosen pager returns.
     */
    function loadMoreHere() {
        if (shell && shell.readPane && shell.readPane.contains(document.activeElement)) {
            return wired.reader.requestMoreLines();
        }
        if (current.transcriptId !== null) return wired.reader.requestMoreLines();
        return wired.list.loadMore();
    }

    /**
     * Description: THE ACTION TABLE, and it is a table for one reason. In
     *   an if-chain an action that resolves and is never performed is an
     *   ABSENT BRANCH: invisible, indistinguishable from a key nobody
     *   pressed. That is exactly the defect this replaced - six resolved
     *   actions were silently dropped. As a table the same mistake is a
     *   MISSING KEY, which the coverage test and onKeydown's warn both
     *   name out loud. Built lazily and cached because
     *   `ArchiveKeys.ACTIONS` lives on `window` and its script may not
     *   have run when this module loads.
     * Inputs: none. Output: Object<string,function> keyed by ACTIONS.
     */
    function handlerTable() {
        if (handlers) return handlers;
        var A = window.ArchiveKeys.ACTIONS;
        var t = {};
        t[A.NEXT_ROW] = function () { wired.reader.moveSelection(1); };
        t[A.PREV_ROW] = function () { wired.reader.moveSelection(-1); };
        t[A.OPEN_ROW] = function () { wired.reader.openSelected(); };
        t[A.BACK_PANE] = function () { goBackPane(); };
        t[A.FOCUS_FILTER] = function () { wired.nav.filterInput.focus(); };
        t[A.FOCUS_SEARCH] = function () { wired.searchInput.focus(); };
        t[A.CLEAR_FILTER] = function () { wired.nav.clearFilter(); };
        t[A.DISMISS_SEARCH] = function () { dismissSearch(); };
        t[A.LOAD_MORE] = function () { loadMoreHere(); };
        t[A.OPEN_EXPORT] = function () { openExport(); };
        t[A.TOGGLE_SCHEME] = function () { wired.list.cycleScheme(); };
        t[A.OPEN_HELP] = function () { window.ArchiveKeys.openHelp({ document: document }); };
        handlers = t;
        return handlers;
    }

    /**
     * Description: keyboard handling. Every decision is made by the pure
     *   `ArchiveKeys.resolve()`; this measures the context, looks the
     *   resolved action up in the table and performs it. An action with
     *   NO handler is warned about BY NAME rather than returning quietly
     *   - a silent return here is the entire bug class being fixed.
     * Inputs: ev (KeyboardEvent). Output: void.
     */
    function onKeydown(ev) {
        if (!shell || !shell.root.classList.contains('active')) return;
        var target = ev.target || {};
        var tag = String(target.tagName || '').toLowerCase();
        var action = window.ArchiveKeys.resolve(ev, {
            inTextField: tag === 'input' || tag === 'textarea' || target.isContentEditable === true,
            modalOpen: !!(window.ModalStack && typeof window.ModalStack.depth === 'function' &&
                          window.ModalStack.depth() > 0),
            // The REAL filter text. Hardcoding this to '' made rung 2 of
            // the Escape ladder - clear the filter - unreachable: the
            // ladder could never see anything there was to clear.
            filterText: wired && wired.nav && typeof wired.nav.filterText === 'function'
                ? wired.nav.filterText() : '',
            searchOpen: !!(wired && !wired.search.element.hidden),
            narrow: isNarrow(),
            canGoBack: current.view !== 'root'
        });
        if (!action) return;
        var handler = handlerTable()[action];
        if (!handler) {
            console.warn('ArchiveScreen: resolved action "' + action +
                '" has no handler and was dropped. Add it to handlerTable().');
            return;
        }
        handler();
        ev.preventDefault();
    }

    /** Render one route - the ONE place that turns a parsed route into
     *  loaded views, so a fresh page load, an in-app click and a Back
     *  button all take the identical path. Inputs: route. Output: void. */
    function applyRoute(route) {
        setPane(route.view);
        dismissSearch();
        if (!wired.nav.rowsLoaded || !wired.nav.rowsLoaded('hosts').length) {
            wired.nav.loadHosts();
        }
        if (route.projectId !== null && route.projectId !== undefined) {
            wired.list.load({ kind: 'project', id: route.projectId, inScope: null });
            paintCrumb(['project ' + route.projectId]);
        }
        if (route.transcriptId !== null && route.transcriptId !== undefined) {
            paintCrumb([route.projectId !== null && route.projectId !== undefined
                ? 'project ' + route.projectId : 'project NOT KNOWN',
                'transcript ' + route.transcriptId]);
            window.ArchiveScreenReader.load({
                reader: wired.reader,
                pane: shell.readPane,
                api: window.API,
                transcriptId: route.transcriptId,
                spinePageRows: SPINE_PAGE_ROWS
            }, route.lineNo);
        } else if (route.projectId === null || route.projectId === undefined) {
            paintCrumb([]);
        }
    }

    /** Show the screen for a parsed route, called by App.showArchive()
     *  once it has activated `#archive-screen`. Inputs: params|undefined
     *  from router.js, `{}` being /archive. Output: void.
     *  Example: show({view: 'transcript', transcriptId: 5767}) */
    function show(params) {
        if (!buildShell()) return;
        wire();
        var p = params || {};
        current = {
            view: p.view || 'root',
            projectId: typeof p.projectId === 'number' ? p.projectId : null,
            transcriptId: typeof p.transcriptId === 'number' ? p.transcriptId : null,
            lineNo: typeof p.lineNo === 'number' ? p.lineNo : null,
            query: p.query || {}
        };
        applyRoute(current);
        if (current.query && current.query.q) runSearch(current.query.q);
    }

    // Build the shell now, for the reason in the header: the re-parent
    // targets must exist before App.showArchive() reaches for them.
    buildShell();

    window.ArchiveScreen = {
        show: show,
        /** Description: the parsed route on screen. Output: object. */
        route: function () { return current; },
        /** Description: sub-views, for tests. Output: object|null. */
        views: function () { return wired; },
        /** Description: the action table, so a test can assert every
         *   ACTIONS value has a handler. Output: Object<string,function>. */
        handlerTable: handlerTable,
        SCREEN_ID: SCREEN_ID,
        ROOT_CLASS: ROOT_CLASS,
        NARROW_MAX_PX: NARROW_MAX_PX,
        SPINE_PAGE_ROWS: SPINE_PAGE_ROWS
    };
    console.log('[ArchiveScreen Module] Exported as window.ArchiveScreen');
})();
