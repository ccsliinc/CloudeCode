/**
 * The one public way to make the conversation sidebar re-read, off schedule.
 *
 * ITS OWN FILE because client/js/session-sidebar.js is held to a 500 line
 * budget by tests/test_sidebar_sessions.node.mjs, and because this is the
 * same split session-sidebar-pin.js and session-sidebar-clicks.js already
 * use: the controller owns the panel, and a behaviour that is really about
 * a DIFFERENT subsystem talking to it lives beside it rather than inside.
 *
 * WHO CALLS IT. The application event channel (client/js/app-events.js),
 * when a change notice says a session moved. It is the only caller, and it
 * must stay the only way in: reaching for `_fetchAndRender()` from outside
 * would put a second copy of the rule below into whatever reached.
 *
 * IT DOES EXACTLY WHAT A POLL TICK DOES, which is the whole point. One read
 * path, one render path, so an event can only make the SAME refresh happen
 * sooner and can never produce a row the poll would not have produced.
 *
 * AND IT REFUSES WHILE THE PANEL IS CLOSED. That is the rule the poll
 * already follows - `_startPoll` runs only while the sidebar is open, and
 * `show()` re-reads on the way in - and it is not merely a saving. The
 * launchpad and the sidebar each keep their own copy of a session row, so
 * populating the hidden one puts a SECOND element carrying the same
 * `data-session-id` into the page before the user has asked for it. That
 * ambiguity is the one scripts/perf/perf_browser.py already warns about,
 * and without this guard it broke tests/test_perf_harness_smoke.py: the
 * first match found was the invisible one, so a wait for a visible row
 * timed out against a page that was working perfectly.
 *
 * NEVER REJECTS. An event-driven refresh that failed leaves the poll to
 * try again a moment later, and a rejection here would surface inside a
 * WebSocket message handler.
 */

console.log('[SessionSidebarRefresh Module] Loading...');

(function () {
    var sidebar = globalThis.SessionSidebar;
    if (!sidebar) {
        // A load-order accident, not a licence to define a global the
        // controller does not back. The event channel checks for the
        // method before calling it, so its absence costs a refresh the
        // poll performs anyway.
        console.warn('[SessionSidebarRefresh] no SessionSidebar to extend');
        return;
    }

    /**
     * Re-read and re-render the sidebar now, off the poll's schedule.
     *
     * Inputs: none.
     * Output: undefined.
     * Example: window.SessionSidebar.refreshNow();
     */
    sidebar.refreshNow = function refreshNow() {
        if (!this.isOpen) return;
        this._fetchAndRender().catch(function (err) {
            console.warn('SessionSidebar: event-driven refresh failed:', err);
        });
    };

    console.log('[SessionSidebarRefresh Module] Loaded');
})();
