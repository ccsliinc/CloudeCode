/**
 * The way INTO the archive from the rest of the app.
 *
 * WHY THIS FILE EXISTS. Before it, there was no way in at all. Measured
 * on the running app at 9d190df:
 *
 *   grep -rn 'archive' client/js/launchpad.js client/js/header-menu.js
 *       -> no matches
 *   /archive/i.test(document.body.innerText) on the launchpad
 *       -> false
 *   the only control in the entire DOM matching /archive/
 *       -> the archive screen's own Back button
 *
 * So the message browser shipped complete and reachable only by typing
 * the URL. A screen with no entry point is a screen nobody uses, and
 * "the feature is broken" and "the feature is unreachable" look
 * identical from outside.
 *
 * ONE IMPLEMENTATION, TWO ENTRY POINTS. The launchpad row and the header
 * overflow item both call `open()` here rather than each doing their own
 * pushState-and-show. Two copies of a navigation is two copies that can
 * drift - one of them gains a guard, or a route parameter, or a
 * different history mode, and from then on the two doors lead to subtly
 * different places with nothing to say so.
 *
 * WHY pushState AND THEN showArchive, IN THAT ORDER. `App.showArchive()`
 * activates the screen but does not write the address bar - the router
 * owns the inbound half and archive-screen.js owns the outbound half for
 * routes WITHIN the archive. The bare `/archive` entry belongs to
 * neither, so it is written here, BEFORE the screen is shown, because
 * `Router.resetToLauncher()` explicitly refuses to clobber the URL once
 * the path already reads `/archive` (see its guard). Doing it the other
 * way round races that guard.
 *
 * A FAILED pushState IS NOT A FAILED NAVIGATION. The History API throws
 * in a sandboxed iframe; router.js already swallows exactly this and
 * carries on, and so does this. The screen still opens; only the address
 * bar is wrong, which is a strictly smaller problem than not opening.
 */

console.log('[ArchiveEntry Module] Loading...');

(function () {
    'use strict';

    /** The bare archive route. Matches Router.ARCHIVE_PREFIX. @type {string} */
    var PATH = '/archive';

    /** Label used by both entry points, so they cannot disagree. */
    var LABEL = 'message archive';

    /**
     * One-line description of what the archive is, shown under the label
     * on the launchpad row. It says READ-ONLY out loud because that is
     * the single most useful thing to know before clicking into a
     * browser over 21,039 transcripts.
     * @type {string}
     */
    var DESCRIPTION =
        'browse ingested transcripts by host, project and line. read-only.';

    /**
     * Description: navigate to the archive screen.
     * Inputs: none.
     * Output: boolean - true when the screen was shown, false when the
     *   app shell was not available to show it. Returning a third
     *   possibility rather than throwing keeps a dead entry point
     *   diagnosable from a test without a live App.
     * Example: window.ArchiveEntry.open();
     */
    function open() {
        try {
            if (window.location.pathname !== PATH) {
                window.history.pushState({}, '', PATH);
            }
        } catch (e) {
            // History API blocked (sandboxed iframe etc.). Same tolerance
            // as router.js's enterSession. The navigation below still
            // runs - a wrong address bar is not a reason to refuse.
        }
        if (window.App && typeof window.App.showArchive === 'function') {
            window.App.showArchive({});
            return true;
        }
        console.warn('[ArchiveEntry] App.showArchive is unavailable; ' +
                     'the archive could not be shown.');
        return false;
    }

    window.ArchiveEntry = {
        open: open,
        PATH: PATH,
        LABEL: LABEL,
        DESCRIPTION: DESCRIPTION
    };
    console.log('[ArchiveEntry Module] Exported as window.ArchiveEntry');
})();
