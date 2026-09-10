/**
 * What happens to a session's toast cards when the user enters it.
 *
 * WHY THIS IS ITS OWN FILE. `SessionSidebarController.setActiveSession` is
 * the single source of truth for which session is attached, so it is also
 * the only place that knows the moment a card about that session stops
 * being news. Putting the dismissal there directly pushed
 * session-sidebar.js to 509 lines, over the 500-line budget its own
 * housekeeping test enforces, which is the repo saying out loud that new
 * behaviour belongs in a new module rather than on the end of that class.
 *
 * IT IS THE VISUAL HALF OF A RULE THE SERVER ALREADY HAS.
 * `src/core/session_view_clears.py` clears an open `notice` when a socket
 * binds to a session, because a notification is a message to the user and
 * looking at the session answers it. This clears the CARD that message
 * raised. The two are deliberately separate mechanisms: the server rule
 * is about a durable flag on a row, this is about a transient element on
 * a screen, and either can be true without the other having happened yet.
 *
 * IT NEVER DECIDES WHAT A TOAST MEANS. It only asks ToastManager to
 * dismiss what it is already showing for one session; every rule about
 * what may be raised, acked, or re-rendered stays in client/js/toast.js.
 * A second place deciding that would drift from the first.
 *
 * IT IS A NO-OP WHENEVER IT CANNOT ACT, on purpose. ToastManager may not
 * be loaded yet (this file is served before it on some screens), an older
 * build may not carry `dismissForSessionEntry`, and entering "no session"
 * is not a session entry at all. None of those is an error worth a
 * console line on a path that runs on every tab switch.
 */

(function attachSessionEntryToasts(global) {
    'use strict';

    /**
     * Description: dismiss whatever toast cards are on screen for the
     *   session the user has just entered. The user is looking at it
     *   now, so a card about it is stale the instant this runs.
     * Inputs: sessionId (string|null) - the cloudecode session id, or
     *   null when nothing is attached. tmuxName (string|null) - the
     *   literal tmux name, which is how a card raised under an adopted
     *   id is still matched (see CLAUDE.md on the id split).
     * Output: boolean - true iff a dismissal was actually requested, so
     *   a caller or a test can tell "did nothing" from "could not".
     * Example: SessionEntryToasts.dismissFor('ses_1', 'cloude_work')
     */
    function dismissFor(sessionId, tmuxName) {
        const id = sessionId || null;
        const name = tmuxName || null;
        if (!id && !name) return false;
        const manager = global.ToastManager;
        if (!manager || typeof manager.dismissForSessionEntry !== 'function') {
            return false;
        }
        manager.dismissForSessionEntry(id, name);
        return true;
    }

    global.SessionEntryToasts = { dismissFor: dismissFor };
})(window);
