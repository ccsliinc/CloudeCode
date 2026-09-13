// THE ARCHIVE SEAM, AS A DOUBLE, FOR SUITES WHOSE SUBJECT IS SOMETHING
// ELSE.
//
// WHY THIS EXISTS. `client/js/archive-deeplink.js`, `archive-entry.js`,
// `archive-crumb.js` and `archive-crumb-resolve.js` are now
// `web/src/lib/plugins/history/`, behind the `app-screen` plugin
// surface, and they are compiled into `client/dist/app.js` rather than
// loaded as classic scripts. Several node suites used to `vm`-load one
// of those four purely as a COLLABORATOR - they are about the header
// button, the archive screen's key handling, or the search panel's deep
// dive, and they needed something on `window` for those subjects to talk
// to.
//
// Those suites did not lose their subject, so they did not move. They
// need a double for the seam instead, and this is it, written once so
// five files do not each grow their own slightly different one.
//
// IT IS A DOUBLE AND IT IS NOT THE THING. Nothing here re-implements
// route parsing, path building or the availability ladder - all of that
// is measured against the REAL implementation in
// `web/src/lib/plugins/history/*.test.ts`, which is where those
// assertions moved. A suite that wants to prove what a path parses to
// must not use this; it belongs in vitest beside the parser. What this
// is for is answering "the seam was there and it was called", which is
// all the subjects below actually need.

/**
 * Build a stub of `window.CloudeWeb.archive` and record what it was
 * asked to do.
 *
 * Description: every function records its call and returns a plausible,
 *   INERT answer. `ensure()` resolves whatever state the caller asked
 *   for, so a suite can drive the enabled / disabled / unknown branches
 *   of the code it is actually testing.
 * Inputs: opts (object|undefined)
 *   - state (string) - what `ensure()` resolves to. Default 'enabled'.
 *   - reason (string) - what `reason()` returns.
 *   - openResult (boolean) - what `open()` and `openRoute()` return.
 * Output: {archive, calls} - the stub, and the recording.
 * Example:
 *   const { archive, calls } = archiveSeamStub({ state: 'disabled' });
 *   context.window.CloudeWeb = { archive };
 */
export function archiveSeamStub(opts = {}) {
    const state = opts.state === undefined ? 'enabled' : opts.state;
    const reason = opts.reason === undefined ? '' : opts.reason;
    const openResult = opts.openResult === undefined ? true : opts.openResult;

    /** Everything the stub was asked to do, in order. */
    const calls = {
        opened: 0,
        openedRoutes: [],
        closed: 0,
        ensured: 0,
        syncedRoutes: [],
        builtRoutes: [],
        crumbs: [],
    };

    /** A tracker double: keyed exactly like the real one, nothing more. */
    function tracker() {
        let project = { id: null, node: null };
        let transcript = { id: null, row: null };
        return {
            learnProject(id, node) { if (id != null && node) project = { id, node }; },
            learnTranscript(id, row) { if (id != null && row) transcript = { id, row }; },
            facts(route) {
                const r = route || {};
                return {
                    project: project.id === r.projectId ? project.node : null,
                    transcript: transcript.id === r.transcriptId ? transcript.row : null,
                };
            },
            labelsFor() { return []; },
        };
    }

    const archive = {
        STATE_ENABLED: 'enabled',
        STATE_DISABLED: 'disabled',
        STATE_UNKNOWN: 'unknown',
        open() { calls.opened++; return openResult; },
        openRoute(route) { calls.openedRoutes.push(route); return openResult; },
        close() { calls.closed++; return true; },
        ensure() { calls.ensured++; return Promise.resolve(state); },
        state() { return state; },
        reason() { return reason; },
        onResolved(fn) { if (typeof fn === 'function') fn(state); },
        // A path builder that is deliberately CRUDE. It is enough for a
        // caller to prove it asked for a path and got a string; anything
        // asserting the SHAPE of an archive URL belongs in
        // web/src/lib/plugins/history/route.test.ts against the real one.
        buildPath(route) {
            calls.builtRoutes.push(route);
            const r = route || {};
            if (r.view === 'project' && r.projectId != null) {
                return '/archive/p/' + r.projectId;
            }
            if (r.view === 'line' && r.transcriptId != null && r.lineNo != null) {
                return '/archive/t/' + r.transcriptId + '/l/' + r.lineNo;
            }
            if (r.view === 'transcript' && r.transcriptId != null) {
                return '/archive/t/' + r.transcriptId;
            }
            return '/archive';
        },
        syncUrl(route) { calls.syncedRoutes.push(route); return null; },
        renderCrumb(doc, parts) {
            calls.crumbs.push(parts);
            const out = [];
            const items = ['ARCHIVE'].concat(parts || []);
            for (const text of items) {
                const el = doc.createElement('span');
                el.className = 'archive-screen__crumb-item';
                el.setAttribute('title', String(text));
                el.appendChild(doc.createTextNode(String(text)));
                out.push(el);
            }
            return out;
        },
        tracker,
        resolver() {
            return { resolve: () => Promise.resolve({ node: null,
                                                      status: 'cannot_determine' }) };
        },
    };

    return { archive, calls };
}

/**
 * Put the stub on a sandbox's `window`, merging into any CloudeWeb that
 * is already there.
 * Inputs: win (object) - the sandbox window. opts - as archiveSeamStub.
 * Output: {archive, calls}.
 * Example: installArchiveSeam(context.window, { state: 'disabled' });
 */
export function installArchiveSeam(win, opts) {
    const made = archiveSeamStub(opts);
    win.CloudeWeb = Object.assign({}, win.CloudeWeb, { archive: made.archive });
    return made;
}
