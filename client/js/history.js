/**
 * History viewer - the read-only conversation archive browser.
 * ----------------------------------------------------------------------
 * THREE LEVELS: projects, then that project's sessions, then one session
 * read as a message thread. Back walks up the same three steps, and each
 * level has a URL (`/history`, `/history/project/<id>`,
 * `/history/session/<id>`) so the phone's own back gesture and a pasted
 * link land in the same place. `router.js` parses those paths and calls
 * `applyRoute` here; this module never parses the address bar itself.
 *
 * READ-ONLY, AND THAT IS THE WHOLE FEATURE. Every request this module can
 * make is a GET. There is no annotate, no favourite, no rename, no
 * delete, no resume. If a control here ever needs a verb other than GET,
 * it belongs in a different module.
 *
 * WHY AN OVERLAY RATHER THAN A FOURTH `.screen`. `app.js` owns a three
 * state machine (auth, launchpad, terminal) and every one of its
 * transitions carries theme, header-identity, status-light and URL side
 * effects. Adding a fourth state would mean touching all of them. The
 * viewer is a full-screen overlay on top of whatever screen is showing,
 * registered with `ModalStack` so Escape and the body scroll lock behave
 * exactly like every other modal in this app.
 */

console.log('[History Module] Loading...');

(function () {
    'use strict';

    var Render = window.HistoryRender;
    var Api = window.HistoryAPI;

    /** Sessions requested per page in the session list. */
    var SESSION_PAGE_SIZE = 40;

    /** URL prefixes, single source of truth for build and parse. */
    var PATH_ROOT = '/history';
    var PATH_PROJECT = '/history/project/';
    var PATH_SESSION = '/history/session/';

    /** The open overlay, or null. Only ever one. */
    var overlayEl = null;

    /** The scrolling body of the current level. */
    var bodyEl = null;

    /** Header title element, repainted per level. */
    var titleEl = null;

    /** Back control, hidden at the top level. */
    var backEl = null;

    /** The current view, one of 'projects', 'sessions', 'thread'. */
    var level = null;

    /** The project id the session list is showing, or null. */
    var currentProjectId = null;

    /**
     * Open the viewer if it is not already open, and show the top level.
     * Inputs: none. Output: void.
     */
    function open() {
        if (!overlayEl) buildOverlay();
        pushPath(PATH_ROOT);
        showProjects();
    }

    /**
     * Close the viewer and return the address bar to the launcher.
     * Inputs: none. Output: void.
     */
    function close() {
        if (!overlayEl) return;
        window.HistoryThread.unmount();
        if (window.ModalStack) window.ModalStack.pop(overlayEl);
        overlayEl.remove();
        overlayEl = null;
        bodyEl = null;
        titleEl = null;
        backEl = null;
        level = null;
        currentProjectId = null;
        // Only reclaim the address bar if it is still OURS. Closing can be
        // driven by a popstate that has already navigated somewhere else
        // (a `/session/<name>` deep link, say), and rewriting the URL to
        // `/` there would silently cancel the navigation that closed us.
        var onViewerPath = (window.location.pathname || '').indexOf(PATH_ROOT) === 0;
        if (onViewerPath && window.Router
            && typeof window.Router.resetToLauncher === 'function') {
            window.Router.resetToLauncher();
        }
    }

    /**
     * Is the viewer currently mounted?
     * Inputs: none. Output: boolean.
     */
    function isOpen() {
        return overlayEl !== null;
    }

    /**
     * Build the overlay chrome once.
     * Inputs: none. Output: void.
     */
    function buildOverlay() {
        overlayEl = Render.el('div', 'modal-overlay history-overlay');

        var header = Render.el('div', 'history-header');
        backEl = Render.el('button', 'history-header__back', 'back');
        backEl.type = 'button';
        backEl.addEventListener('click', goBack);
        header.appendChild(backEl);

        titleEl = Render.el('h2', 'history-header__title', 'conversation archive');
        header.appendChild(titleEl);

        var closeBtn = Render.el('button', 'history-header__close', 'close');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'close the conversation archive');
        closeBtn.addEventListener('click', close);
        header.appendChild(closeBtn);

        overlayEl.appendChild(header);
        bodyEl = Render.el('div', 'history-body');
        overlayEl.appendChild(bodyEl);
        document.body.appendChild(overlayEl);

        if (window.ModalStack) window.ModalStack.push(overlayEl, { onEscape: goBack });
    }

    /**
     * Walk one level up, or close when already at the top.
     * Inputs: none. Output: void.
     */
    function goBack() {
        if (level === 'thread' || level === 'sessions') {
            if (level === 'thread' && currentProjectId !== null) {
                pushPath(PATH_PROJECT + currentProjectId);
                showSessions(currentProjectId);
                return;
            }
            pushPath(PATH_ROOT);
            showProjects();
            return;
        }
        close();
    }

    /**
     * Set the header title and whether Back is offered.
     * Inputs: text (string), canGoBack (boolean). Output: void.
     */
    function setChrome(text, canGoBack) {
        titleEl.textContent = text;
        backEl.textContent = canGoBack ? 'back' : 'home';
    }

    /**
     * Push a viewer path into the address bar.
     *
     * Inputs: path (string) - already-built, e.g. "/history/session/12".
     * Output: void. History API failures are swallowed, matching the
     *   tolerance router.js already applies for sandboxed contexts.
     */
    function pushPath(path) {
        if (window.location.pathname === path) return;
        try {
            window.history.pushState({}, '', path);
        } catch (err) {
            // History API blocked (sandboxed iframe etc.) - the viewer
            // still works, it just stops being linkable.
        }
    }

    /**
     * Render the project list.
     * Inputs: none. Output: Promise<void>.
     */
    async function showProjects() {
        level = 'projects';
        currentProjectId = null;
        window.HistoryThread.unmount();
        setChrome('conversation archive', false);
        bodyEl.classList.remove('history-body--thread');
        bodyEl.textContent = '';
        bodyEl.appendChild(Render.el('div', 'history-loading', 'loading projects...'));

        var body = await Api.projects();
        if (level !== 'projects') return;
        bodyEl.textContent = '';
        if (!Api.isOk(body)) {
            bodyEl.appendChild(Render.unavailableBlock(body, 'the project list'));
            return;
        }
        var caveat = Render.caveatBanner(body);
        if (caveat) bodyEl.appendChild(caveat);
        if (!body.items.length) {
            bodyEl.appendChild(Render.el('div', 'history-empty',
                'the archive was read and it holds no projects'));
            return;
        }
        var list = Render.el('div', 'history-list');
        body.items.forEach(function (project) {
            var row = Render.projectRow(project);
            row.addEventListener('click', function () {
                pushPath(PATH_PROJECT + project.id);
                showSessions(project.id);
            });
            list.appendChild(row);
        });
        bodyEl.appendChild(list);
    }

    /**
     * Render one project's session list, newest first.
     *
     * Inputs: projectId (number).
     * Output: Promise<void>.
     */
    async function showSessions(projectId) {
        level = 'sessions';
        currentProjectId = projectId;
        window.HistoryThread.unmount();
        setChrome('conversations', true);
        bodyEl.classList.remove('history-body--thread');
        bodyEl.textContent = '';
        bodyEl.appendChild(Render.el('div', 'history-loading', 'loading conversations...'));

        var body = await Api.sessions({ projectId: projectId, limit: SESSION_PAGE_SIZE, offset: 0 });
        if (level !== 'sessions' || currentProjectId !== projectId) return;
        bodyEl.textContent = '';
        if (!Api.isOk(body)) {
            bodyEl.appendChild(Render.unavailableBlock(body, 'the conversation list'));
            return;
        }
        var caveat = Render.caveatBanner(body);
        if (caveat) bodyEl.appendChild(caveat);
        if (!body.items.length) {
            bodyEl.appendChild(Render.el('div', 'history-empty',
                'this project was read and holds no main conversations'));
            return;
        }
        setChrome('conversations (' + body.total + ')', true);
        var list = Render.el('div', 'history-list');
        appendSessionRows(list, body.items);
        bodyEl.appendChild(list);
        if (body.has_more) bodyEl.appendChild(buildMoreButton(list, projectId, body.items.length));
    }

    /**
     * Append session rows, each wired to open its thread.
     * Inputs: list (HTMLElement), items (Array). Output: void.
     */
    function appendSessionRows(list, items) {
        items.forEach(function (session) {
            var row = Render.sessionRow(session);
            row.addEventListener('click', function () {
                pushPath(PATH_SESSION + session.id);
                showThread(session.id, null);
            });
            list.appendChild(row);
        });
    }

    /**
     * Build the "load more conversations" control for the session list.
     *
     * The session list pages on an explicit tap rather than on scroll: a
     * list of forty rows is navigation, not reading, and an infinite list
     * of conversations is harder to use than a paged one. The THREAD is
     * where scroll paging belongs, and that is where it lives.
     *
     * Inputs: list (HTMLElement), projectId (number), offset (number).
     * Output: HTMLElement.
     */
    function buildMoreButton(list, projectId, offset) {
        var button = Render.el('button', 'history-more', 'load more conversations');
        button.type = 'button';
        var nextOffset = offset;
        button.addEventListener('click', async function () {
            button.disabled = true;
            button.textContent = 'loading...';
            var body = await Api.sessions({
                projectId: projectId, limit: SESSION_PAGE_SIZE, offset: nextOffset
            });
            if (!Api.isOk(body)) {
                button.replaceWith(Render.unavailableBlock(body, 'more conversations'));
                return;
            }
            appendSessionRows(list, body.items);
            nextOffset += body.items.length;
            button.disabled = false;
            button.textContent = 'load more conversations';
            if (!body.has_more) button.remove();
        });
        return button;
    }

    /**
     * Render one session as a message thread.
     *
     * Inputs:
     *   sessionId (number).
     *   seq (number|null) - a `seq_in_file` to open at; null opens at the
     *     end of the session, the way a messaging app does.
     * Output: Promise<void>.
     */
    async function showThread(sessionId, seq) {
        level = 'thread';
        setChrome('conversation', true);
        // The thread owns its own scroller; the outer one must be off or
        // the two nest and the paging arithmetic reads the wrong element.
        bodyEl.classList.add('history-body--thread');
        bodyEl.textContent = '';
        var host = Render.el('div', 'history-thread');
        bodyEl.appendChild(host);

        var summary = await window.HistoryThread.mount(host, sessionId, { seq: seq });
        if (level !== 'thread') return;
        if (summary) {
            currentProjectId = summary.project_id;
            setChrome(summary.custom_title || summary.slug || ('session ' + summary.id), true);
        }
    }

    /**
     * Apply a parsed viewer route. Called by router.js on load, on
     * popstate, and never by this module itself.
     *
     * Inputs: route (object) - `{view, id, seq}` from
     *   `Router._parseHistoryPath`.
     * Output: void.
     */
    function applyRoute(route) {
        if (!overlayEl) buildOverlay();
        if (route.view === 'session') {
            showThread(route.id, route.seq);
            return;
        }
        if (route.view === 'project') {
            showSessions(route.id);
            return;
        }
        showProjects();
    }

    window.HistoryView = {
        open: open,
        close: close,
        isOpen: isOpen,
        applyRoute: applyRoute,
        PATH_ROOT: PATH_ROOT
    };
})();
