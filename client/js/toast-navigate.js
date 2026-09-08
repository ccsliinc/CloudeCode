/**
 * ToastNavigate - clicking a toast takes you to the session that raised
 * it.
 *
 * WHY THIS BECAME NECESSARY. While a toast could only appear for the
 * session already on screen, "go to the session" meant "stay where you
 * are" and a click target would have been pointless. Now that raising is
 * global (toast-global-poll.js, punchlist item 7), most cards on screen
 * are about somewhere else, and a notification you cannot act on is a
 * notification that makes you hunt through a sidebar of twenty rows.
 *
 * IT RESOLVES A REAL ROW, IT DOES NOT SYNTHESISE ONE. The toast carries
 * `session_id`, `session_label` and `session_name`, which is enough to
 * NAME the session and not enough to ENTER it. `App.returnToExistingTerminal`
 * reads `pinned_theme` and `tmux_session` off the SessionInfo WRAPPER and
 * `id` off the nested `.session` (CLAUDE.md's gotcha 1, the most repeated
 * bug in this project), and hands the wrapper to
 * `ThemeNavigation.applyForSession`. Handing it an object assembled from
 * the toast would carry no `pinned_theme`, so entering a pinned session
 * from a toast would paint the previous session's theme - gotcha 7,
 * already paid for once. So this fetches `GET /sessions/list` and passes
 * the row the server actually has.
 *
 * A SESSION THAT IS GONE IS SAID OUT LOUD. A toast outlives the session
 * it names: it can be minutes old, and the pane may have died since. The
 * refusal path reports "that session is no longer running" rather than
 * navigating nowhere and leaving the user clicking a dead card wondering
 * whether the click registered. Nothing is dismissed on a failed jump -
 * the record is still the user's to deal with.
 *
 * THE CLICK NEVER ACKS. Reading a notification is not answering it. The
 * dismiss button is the only thing that acks, and it stays per session.
 */
(function () {
    'use strict';

    /**
     * Description: find the live session row a toast belongs to.
     *   PURE given the list - split from the navigation so the matching
     *   rule is testable without a screen. Matches on the nested
     *   `.session.id` first (the shape `/sessions/list` actually returns)
     *   and falls back to a top-level `id` for the flatter shapes some
     *   older callers hold.
     * Inputs: sessions (Array of SessionInfo), sessionId (string).
     * Output: object|null - the matching SessionInfo, or null.
     * Example: findSession([{session:{id:'a'}}], 'a') -> {session:{id:'a'}}
     */
    function findSession(sessions, sessionId) {
        if (!Array.isArray(sessions) || !sessionId) return null;
        for (var i = 0; i < sessions.length; i++) {
            var info = sessions[i];
            if (!info) continue;
            var inner = info.session || info;
            if ((inner && inner.id === sessionId) || info.id === sessionId) {
                return info;
            }
        }
        return null;
    }

    /**
     * Description: navigate to the session a toast was raised by.
     *   Fetches the live list, resolves the row, and enters it through
     *   the SAME path the sidebar's row click uses, so the theme, the
     *   header identity, the URL sync and the sidebar's active marker all
     *   update exactly as they do from every other entry point.
     * Inputs: toast (object) - a server-shape toast carrying session_id.
     * Output: Promise<boolean> - true when the jump happened.
     * Example: await ToastNavigate.go({session_id: 'ses_a'}) -> true
     */
    function go(toast) {
        var sessionId = toast && toast.session_id;
        if (!sessionId || !window.API || !window.App) return Promise.resolve(false);
        return window.API.listSessions()
            .then(function (sessions) {
                var info = findSession(sessions, sessionId);
                if (!info) {
                    announceMissing(toast);
                    return false;
                }
                // Close the settings panel if the click came from the
                // history list inside it; entering a session behind a
                // modal leaves the user looking at the modal.
                if (window.SettingsPanel && typeof window.SettingsPanel.close === 'function') {
                    try {
                        window.SettingsPanel.close();
                    } catch (err) {
                        // A panel that was not open is not an error worth
                        // failing a navigation over.
                        console.debug('[ToastNavigate] settings close skipped', err);
                    }
                }
                window.App.returnToExistingTerminal(info);
                return true;
            })
            .catch(function (err) {
                console.warn('[ToastNavigate] jump failed', err && err.message);
                return false;
            });
    }

    /**
     * Description: tell the user the session behind this toast is gone,
     *   using whatever notice surface the app has. Falls back to the
     *   console rather than throwing - a failed announcement must not
     *   turn a dead-session click into a broken page.
     * Inputs: toast (object). Output: void.
     */
    function announceMissing(toast) {
        var name = null;
        if (window.SessionLabel && typeof window.SessionLabel.resolveToast === 'function') {
            name = window.SessionLabel.resolveToast(toast);
        }
        name = name || (toast && (toast.session_label || toast.session_name)) || 'that session';
        var message = name + ' is no longer running';
        // Router.showError is the app's ONE error banner - the same
        // surface a dead deep link uses (router.js rejectTarget). A
        // second notice surface invented here would be a second thing to
        // style, dismiss and keep in step.
        if (window.Router && typeof window.Router.showError === 'function') {
            window.Router.showError(message);
            return;
        }
        console.warn('[ToastNavigate]', message);
    }

    window.ToastNavigate = {
        go: go,
        findSession: findSession,
    };
}());
