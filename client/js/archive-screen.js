/**
 * Archive screen - the message browser's COMPOSITION ROOT.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
 * Every other `archive-*.js` file is a self-contained piece with no
 * knowledge of the others: the nav does not know a reader exists, the
 * reader does not know a search exists. This file is the only place that
 * knows all of them, and its whole job is wiring plus lifecycle. It owns
 * no rendering rules, no outcome interpretation and no formatting.
 *
 * ONE RULE ABOVE ALL: THIS FILE NEVER BRANCHES ON `result_status`,
 * `scope_status` OR `scan.status`. `archive-outcome.js` is the single
 * interpreter (design doc B.3) and `archive-outcome-view.js` is the
 * single renderer of what an outcome looks like. The moment a second
 * place branches on those fields the two branch sets drift and one of
 * them starts rendering `partial` as `ok`. Where this file needs to know
 * whether a response is usable it asks `ArchiveOutcome.classify()` and
 * reads the returned TOKEN, which is a different thing from reading the
 * status itself.
 *
 * WHY THE SHELL IS BUILT AT SCRIPT LOAD RATHER THAN INSIDE `show()`.
 * `App.showArchive()` calls `_placeStatusLight('archive')` and
 * `GlobalAudioToggle.place('archive')` BEFORE it calls `show()`, matching
 * the order `showLaunchpad()` uses. Both of those re-parent a node into
 * `#archive-bar-status`, which is part of this shell. Building the shell
 * lazily inside `show()` would mean that on the FIRST navigation the
 * target does not exist yet, both calls silently no-op (they are written
 * to tolerate a missing target, correctly), and the status light and the
 * audio button are simply absent with no error anywhere. That is a silent
 * half-wired screen. This script tag sits after `#archive-screen` in the
 * document, so the element is parsed and the shell can be built now.
 *
 * NARROW LAYOUT IS A RENDERING CHOICE OVER ONE STATE, NOT A SECOND STATE
 * MACHINE (design doc C.5). The route already names which pane is
 * current, so `data-pane` is written on the root from the same `view`
 * the router produced and CSS decides what to show. There is no separate
 * mobile navigation model to keep in sync.
 */

console.log('[ArchiveScreen Module] Loading...');

(function () {
    'use strict';

    /** Root element id, owned by index.html. @type {string} */
    var SCREEN_ID = 'archive-screen';

    /** Class prefix for everything this file builds. @type {string} */
    var ROOT_CLASS = 'archive-screen';

    /**
     * Spine rows fetched per reader page. The archive lines endpoint has
     * NO line-offset parameter in this build (measured 2026-08-31: it
     * accepts limit, cursor, include_bodies, max_page_bytes, role,
     * record_type, model and nothing else), so this is also the ceiling
     * on which line numbers a deep link can land on without paging.
     * @type {number}
     */
    var SPINE_PAGE_ROWS = 500;

    /**
     * Viewport width below which the three columns collapse to one pane.
     * Mirrors the 900px breakpoint declared in archive-screen.css; the
     * two must agree, which is why it is named in both rather than
     * spelled as a bare number in either.
     * @type {number}
     */
    var NARROW_MAX_PX = 900;

    /** Live wiring, or null before the first show(). @type {?object} */
    var wired = null;

    /** The shell's elements, built once. @type {?object} */
    var shell = null;

    /** The route currently rendered. @type {object} */
    var current = { view: 'root', projectId: null, transcriptId: null,
                    lineNo: null, query: {} };

    /**
     * Description: create an element with an optional class and text.
     * Inputs: tag (string), cls (string|null), text (string|null).
     * Output: Element.
     */
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== null && text !== undefined) n.textContent = text;
        return n;
    }

    /**
     * Description: build the screen shell exactly once. Idempotent - a
     *   second call returns the shell the first one built.
     * Inputs: none.
     * Output: object|null - the shell, or null when #archive-screen is
     *   absent. Null is a real answer and is reported, not swallowed:
     *   a missing root means index.html and this module disagree.
     */
    function buildShell() {
        if (shell) return shell;
        var root = document.getElementById(SCREEN_ID);
        if (!root) {
            console.error('ArchiveScreen: #' + SCREEN_ID + ' is missing from ' +
                'index.html. The screen cannot mount.');
            return null;
        }
        root.textContent = '';

        var crumb = el('nav', ROOT_CLASS + '__crumb', null);
        crumb.setAttribute('aria-label', 'Archive location');

        var back = el('button', ROOT_CLASS + '__back', 'Back');
        back.setAttribute('type', 'button');
        back.setAttribute('data-action', 'back-pane');

        var grid = el('div', ROOT_CLASS + '__grid', null);
        var navPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--nav', null);
        var listPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--list', null);
        var readPane = el('div', ROOT_CLASS + '__pane ' + ROOT_CLASS + '__pane--reader', null);
        grid.appendChild(navPane);
        grid.appendChild(listPane);
        grid.appendChild(readPane);

        // The bottom bar. `#archive-bar-status` is the re-parent target
        // for App._placeStatusLight('archive') and for
        // GlobalAudioToggle.place('archive'); the *-text span mirrors
        // the home and terminal bars so _syncStatusLabel() has somewhere
        // to write.
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
     * Description: push or replace the address bar for a route, using
     *   ArchiveDeeplink as the single builder so inbound parsing and
     *   outbound building cannot drift.
     * Inputs: route (object) - {view, projectId, transcriptId, lineNo,
     *   query}. opts (object|undefined) - {replace: boolean}.
     * Output: void.
     */
    function syncUrl(route, opts) {
        if (!window.ArchiveDeeplink) return;
        var path = window.ArchiveDeeplink.build(route);
        if (!path || window.location.pathname + window.location.search === path) return;
        try {
            if (opts && opts.replace) window.history.replaceState({}, '', path);
            else window.history.pushState({}, '', path);
        } catch (e) {
            // History API blocked (sandboxed iframe). Same tolerance as
            // router.js: navigation still works, the URL just does not
            // follow. Logged rather than swallowed silently.
            console.warn('ArchiveScreen: history API refused', e);
        }
    }

    /**
     * Description: render the breadcrumb from whatever is known. Never
     *   renders a blank crumb - an unknown segment says so.
     * Inputs: parts (Array<string>).
     * Output: void.
     */
    function paintCrumb(parts) {
        if (!shell) return;
        shell.crumb.textContent = '';
        var items = ['ARCHIVE'].concat(parts || []);
        for (var i = 0; i < items.length; i++) {
            if (i > 0) shell.crumb.appendChild(el('span', ROOT_CLASS + '__crumb-sep', '>'));
            shell.crumb.appendChild(el('span', ROOT_CLASS + '__crumb-item', items[i]));
        }
    }

    /**
     * Description: record which pane is current so the narrow layout can
     *   show exactly one of them. Written from the ROUTE, never from a
     *   click handler, so back/forward and a fresh load agree.
     * Inputs: view (string) - 'root' | 'project' | 'transcript' | 'line'.
     * Output: void.
     */
    function setPane(view) {
        if (!shell) return;
        var pane = view === 'transcript' || view === 'line' ? 'reader'
            : view === 'project' ? 'list' : 'nav';
        shell.root.setAttribute('data-pane', pane);
        shell.back.hidden = pane === 'nav';
    }

    /**
     * Description: is the viewport in the one-pane range. Measured from
     *   the live window, not cached, because a rotate changes it.
     * Inputs: none.
     * Output: boolean.
     */
    function isNarrow() {
        return typeof window.innerWidth === 'number' && window.innerWidth < NARROW_MAX_PX;
    }

    /**
     * Description: build every sub-view once and connect them. Each
     *   sub-view owns its own outcome rendering; this only routes the
     *   selections between them.
     * Inputs: none.
     * Output: object - the wiring, cached in `wired`.
     */
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

        // The reader's own toolbar. Built here rather than inside
        // archive-reader.js because search and export are cross-pane
        // concerns: search writes into the list column and export opens a
        // modal, neither of which the reader knows about.
        var tools = el('div', ROOT_CLASS + '__tools', null);
        var searchInput = el('input', ROOT_CLASS + '__search-input', null);
        searchInput.setAttribute('type', 'search');
        searchInput.setAttribute('placeholder', 'search this transcript');
        searchInput.setAttribute('aria-label', 'Search in the open transcript');
        var searchBtn = el('button', ROOT_CLASS + '__search-btn', 'Search');
        searchBtn.setAttribute('type', 'button');
        searchBtn.setAttribute('data-action', 'run-search');
        var exportBtn = el('button', ROOT_CLASS + '__export-btn', 'Export');
        exportBtn.setAttribute('type', 'button');
        exportBtn.setAttribute('data-action', 'open-export');
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

        wired = { nav: nav, list: list, search: search, reader: reader,
                  searchInput: searchInput, exportBtn: exportBtn };
        document.addEventListener('keydown', onKeydown);
        return wired;
    }

    /**
     * Description: a leaf was chosen in the rail. A project and the
     *   unattributed bucket are two different scopes for the same list
     *   view, and only a project has a shareable route.
     * Inputs: kind (string), id (number), row (object).
     * Output: void.
     */
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

    /**
     * Description: open a transcript in the reader and route to it.
     * Inputs: transcriptId (number|null), lineNo (number|null).
     * Output: void.
     */
    function openTranscript(transcriptId, lineNo) {
        if (typeof transcriptId !== 'number') return;
        current = { view: lineNo === null || lineNo === undefined ? 'transcript' : 'line',
                    projectId: current.projectId, transcriptId: transcriptId,
                    lineNo: lineNo === undefined ? null : lineNo, query: {} };
        syncUrl(current);
        applyRoute(current);
    }


    /**
     * Description: run a search scoped to whatever is open - the
     *   transcript if one is, otherwise the project.
     * Inputs: q (string).
     * Output: Promise<string>|void - the outcome token.
     */
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

    /**
     * Description: put the transcript list back in the middle column.
     * Inputs: none. Output: void.
     */
    function dismissSearch() {
        if (!wired) return;
        wired.search.element.hidden = true;
        wired.list.element.hidden = false;
    }

    /**
     * Description: open the export modal for the open transcript.
     *   Refuses, visibly, when nothing is open - a button that does
     *   nothing is worse than one that says why.
     * Inputs: none. Output: void.
     */
    function openExport() {
        if (current.transcriptId === null) {
            console.warn('ArchiveScreen: export requested with no transcript open');
            return;
        }
        window.ArchiveExport.open({
            document: document,
            api: window.API,
            transcriptId: current.transcriptId,
            sameNameCount: null
        });
    }

    /**
     * Description: step back one pane on a narrow viewport.
     * Inputs: none. Output: void.
     */
    function goBackPane() {
        if (current.view === 'transcript' || current.view === 'line') {
            if (current.projectId !== null) {
                current = { view: 'project', projectId: current.projectId,
                            transcriptId: null, lineNo: null, query: {} };
            } else {
                current = { view: 'root', projectId: null, transcriptId: null,
                            lineNo: null, query: {} };
            }
        } else {
            current = { view: 'root', projectId: null, transcriptId: null,
                        lineNo: null, query: {} };
        }
        syncUrl(current);
        applyRoute(current);
    }

    /**
     * Description: keyboard handling. Every decision is made by the pure
     *   `ArchiveKeys.resolve()`; this only measures the context and
     *   performs the named action, so the map stays one testable table.
     * Inputs: ev (KeyboardEvent).
     * Output: void.
     */
    function onKeydown(ev) {
        if (!shell || !shell.root.classList.contains('active')) return;
        var target = ev.target || {};
        var tag = String(target.tagName || '').toLowerCase();
        var action = window.ArchiveKeys.resolve(ev, {
            inTextField: tag === 'input' || tag === 'textarea' || target.isContentEditable === true,
            modalOpen: !!(window.ModalStack && typeof window.ModalStack.depth === 'function' &&
                          window.ModalStack.depth() > 0),
            filterText: '',
            searchOpen: !!(wired && !wired.search.element.hidden),
            narrow: isNarrow(),
            canGoBack: current.view !== 'root'
        });
        if (!action) return;
        var A = window.ArchiveKeys.ACTIONS;
        if (action === A.DISMISS_SEARCH) { dismissSearch(); ev.preventDefault(); return; }
        if (action === A.BACK_PANE) { goBackPane(); ev.preventDefault(); return; }
        if (action === A.FOCUS_SEARCH) { wired.searchInput.focus(); ev.preventDefault(); return; }
        if (action === A.OPEN_EXPORT) { openExport(); ev.preventDefault(); return; }
        if (action === A.LOAD_MORE) { wired.list.loadMore(); ev.preventDefault(); }
    }

    /**
     * Description: render one route. The ONE place that turns a parsed
     *   route into loaded views, so a fresh page load, an in-app click
     *   and a Back button all take the identical path.
     * Inputs: route (object) - {view, projectId, transcriptId, lineNo}.
     * Output: void.
     */
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

    /**
     * Description: show the screen for a parsed route. Called by
     *   App.showArchive() after it has activated `#archive-screen`.
     * Inputs: params (object|undefined) - {view, projectId, transcriptId,
     *   lineNo, query} from router.js. `{}` means the bare /archive route.
     * Output: void.
     * Example: ArchiveScreen.show({view: 'transcript', transcriptId: 5767})
     */
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

    // Build the shell now, for the reason in the header comment: the
    // status-light and audio-button re-parent targets must exist before
    // App.showArchive() reaches for them.
    buildShell();

    window.ArchiveScreen = {
        show: show,
        /** Description: the parsed route on screen. Output: object. */
        route: function () { return current; },
        /** Description: sub-views, for tests. Output: object|null. */
        views: function () { return wired; },
        SCREEN_ID: SCREEN_ID,
        ROOT_CLASS: ROOT_CLASS,
        NARROW_MAX_PX: NARROW_MAX_PX,
        SPINE_PAGE_ROWS: SPINE_PAGE_ROWS
    };
    console.log('[ArchiveScreen Module] Exported as window.ArchiveScreen');
})();
