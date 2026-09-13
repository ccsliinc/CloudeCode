/**
 * DeepDive - take the query the user typed into the terminal search panel
 * and widen it to every past conversation in the same project folder.
 *
 * The terminal can only search what xterm holds, which is this session's
 * scrollback. The archive holds every transcript this machine has ever
 * recorded, indexed and searchable, and it already accepts a project id
 * plus a `?q=` in its deep link. So this is not a new search: it is a
 * lookup from "the folder this session is running in" to "the archive
 * project that covers it", and then the archive's own route.
 *
 * THE LOOKUP IS THE SERVER'S JOB, NOT THIS FILE'S. A working directory
 * and an archived project's recorded cwd disagree for reasons a browser
 * cannot resolve: `~/Development` on this machine is a symlink into
 * iCloud, so the same folder has two spellings, and only
 * `os.path.realpath` plus a `$HOME` alias scan can tell that they are one
 * place (CLAUDE.md gotcha 6). `API.getArchiveProjectForCwd` is that
 * lookup; this file caches its answer and builds a link.
 *
 * A NULL ANSWER IS CACHED TOO, and that is deliberate. "This folder has
 * no archived conversations" is a real answer, and re-asking the server
 * for it on every keystroke would be a request per character for a fact
 * that does not change while the panel is open.
 *
 * THREE THINGS MAKE THE BUTTON UNAVAILABLE, and only one of them is a
 * failure. The archive being switched OFF on this server, the folder
 * having NO archived project, and the query being too short for the
 * archive's own two-character floor. Each returns null from `hrefFor`,
 * and the panel is what turns a null into the right sentence.
 *
 * Loaded as a plain script, no build step. Exposes `window.DeepDive`.
 */
(function (global) {
    'use strict';

    /**
     * The archive's own minimum query length
     * (src/api/archive_search_routes.py). Duplicated here rather than
     * discovered by sending a request that is going to be refused.
     */
    var MIN_QUERY_CHARS = 2;

    /**
     * cwd -> project id, or null for "asked, and there is none". A Map so
     * a folder literally named `__proto__` cannot reach Object.prototype.
     */
    var cache = new Map();

    /** Forget every cached lookup. Output: void. */
    function reset() {
        cache = new Map();
    }

    /**
     * Description: is the message archive switched on for this server?
     * Inputs: none.
     * Output: Promise<boolean> - true ONLY on a measured `enabled`.
     *   `unknown` reads as false here, which is the opposite of
     *   the archive open()'s tolerance and is right for this caller:
     *   open() is answering "the user pressed the archive button, should
     *   I refuse them", while this is answering "should I offer a button
     *   at all", and offering one that leads to a screen of 404s is worse
     *   than not offering it.
     */
    async function archiveEnabled() {
        var archive = global.CloudeWeb && global.CloudeWeb.archive;
        if (!archive || typeof archive.ensure !== 'function') return false;
        try {
            var state = await archive.ensure();
            return state === archive.STATE_ENABLED;
        } catch (err) {
            return false;
        }
    }

    /**
     * Description: read the project id out of the lookup route's answer.
     *
     *   FOUR THINGS COLLAPSE TO NULL AND ONLY ONE OF THEM IS A MISS: the
     *   route was unreachable, it answered a `cannot_determine` envelope
     *   (the datastore would not open), it answered `result: null` (no
     *   project holds this folder), or it named no usable id. They are
     *   one value here ON PURPOSE, because this caller does exactly the
     *   same thing with all four - it offers no button - and a second
     *   vocabulary for "the button is off" would be a distinction nothing
     *   in the panel could act on. The route logs which it was.
     *
     * Inputs: reply (object|null) - a `callEnvelope` result, whose
     *   `envelope.result` the route documents as null or an object
     *   carrying `project_id`.
     * Output: number|null - a positive integer project id, or null.
     */
    function projectIdFrom(reply) {
        if (!reply || reply.transportError || !reply.envelope) return null;
        var res = reply.envelope.result;
        if (!res || typeof res !== 'object') return null;
        var id = Number(res.project_id);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    /**
     * Description: the archive project covering this working directory.
     * Inputs: cwd (string) - the session's working directory.
     * Output: Promise<number|null> - the project id, or null when the
     *   folder has none, the lookup is unavailable, or it failed. One
     *   request per cwd for the life of the page.
     * Example: await DeepDive.resolveProject('/Users/a/Dev/thing') // 12
     */
    async function resolveProject(cwd) {
        if (!cwd) return null;
        if (cache.has(cwd)) return cache.get(cwd);
        var api = global.API;
        if (!api || typeof api.getArchiveProjectForCwd !== 'function') {
            // The route is not in this build. Not cached: a later build
            // in the same page is not a thing, but neither is spending a
            // cache entry to remember an absence of code.
            return null;
        }
        var id = null;
        try {
            id = projectIdFrom(await api.getArchiveProjectForCwd(cwd));
        } catch (err) {
            console.warn('DeepDive: the project lookup failed', err);
            id = null;
        }
        cache.set(cwd, id);
        return id;
    }

    /**
     * Description: the archive path for this session and this query.
     * Inputs:
     *   session (object) - anything carrying `working_dir`. The unwrapped
     *     Session or the SessionInfo wrapper both work, because the
     *     wrapper-versus-`.session` trap is this project's most repeated
     *     bug and a search panel is not the place to add a fourth reader.
     *   query (string) - what the user typed.
     * Output: Promise<string|null> - `/archive/p/<id>?q=<term>`, or null
     *   when the archive is off, the session has no folder, the query is
     *   under the floor, or no project covers the folder.
     * Example: await DeepDive.hrefFor(session, 'hazard')
     *   // '/archive/p/12?q=hazard'
     */
    async function hrefFor(session, query) {
        var q = String(query || '').trim();
        if (q.length < MIN_QUERY_CHARS) return null;
        var cwd = workingDirOf(session);
        if (!cwd) return null;
        if (!(await archiveEnabled())) return null;
        var id = await resolveProject(cwd);
        if (id === null) return null;
        var archive = global.CloudeWeb && global.CloudeWeb.archive;
        if (!archive || typeof archive.buildPath !== 'function') return null;
        return archive.buildPath({
            view: 'project',
            projectId: Number(id),
            query: { q: q }
        });
    }

    /**
     * Description: the working directory of a session, from either level
     *   of the /sessions/list shape.
     * Inputs: session (object|null).
     * Output: string - '' when there is none.
     */
    function workingDirOf(session) {
        if (!session) return '';
        if (session.working_dir) return String(session.working_dir);
        if (session.session && session.session.working_dir) {
            return String(session.session.working_dir);
        }
        return '';
    }

    /**
     * Description: go to the archive, scoped to this project and filtered
     *   by this query.
     *
     *   NAVIGATION IS THE ARCHIVE PLUGIN'S OWN `openRoute`, which writes
     *   the address bar and then shows the screen, and NEVER
     *   `location.href`. This is
     *   a single-page app: a real navigation tears down the terminal, the
     *   WebSocket and every session the user has open, to arrive at a
     *   screen the router could have shown in place. `syncUrl` runs FIRST
     *   so the address bar and the screen change together and Back works.
     *
     * Inputs: session (object), query (string).
     * Output: Promise<boolean> - false when there was nowhere to go, or
     *   when the archive screen is unavailable. Never throws.
     * Example: if (!await DeepDive.open(session, q)) showWhyNot();
     */
    async function open(session, query) {
        var href = await hrefFor(session, query);
        if (!href) return false;
        var route = {
            view: 'project',
            projectId: Number(await resolveProject(workingDirOf(session))),
            query: { q: String(query || '').trim() }
        };
        var archive = global.CloudeWeb && global.CloudeWeb.archive;
        if (!archive || typeof archive.openRoute !== 'function') {
            console.warn('DeepDive: the archive surface is unavailable; the '
                + 'archive could not be shown.');
            return false;
        }
        // ONE navigation into the archive, and it writes the address bar
        // and shows the screen in that order. This used to be two calls
        // against two globals here, which is two copies of a navigation
        // that could drift; the plugin owns both halves now.
        //
        // ITS ANSWER IS RETURNED UNCHANGED. A `|| something` here would
        // report a navigation that did not happen, which is exactly the
        // quiet false-success the three outcomes exist to prevent - and
        // it is what the first draft of this line did, caught by
        // tests/test_terminal_search_deep_dive.node.mjs.
        return archive.openRoute(route);
    }

    global.DeepDive = {
        hrefFor: hrefFor,
        open: open,
        resolveProject: resolveProject,
        reset: reset,
        MIN_QUERY_CHARS: MIN_QUERY_CHARS
    };
}(typeof window !== 'undefined' ? window : globalThis));
