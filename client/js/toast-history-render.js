/**
 * ToastHistoryRender - the pure half of the notification history view.
 *
 * PURE, and split out for that reason: every rule about what a history
 * row SAYS is decided here, with no fetch, no timer and no panel state,
 * so it can be asserted directly in node against the shapes the server
 * really returns. The panel next door (toast-history-panel.js) owns the
 * mounting, the paging clicks and the network.
 *
 * WHAT A ROW MAY CLAIM, which is the whole reason this is not four lines
 * of template string:
 *
 *   THE OUTCOME IS TWO-VALUED, NOT THREE. The owner's ask for punchlist
 *   item 8 wanted three outcomes distinguished - answered by the user,
 *   auto-dismissed by typing into the session, and swept by "dismiss
 *   all" - because "I answered it" and "it got swept" are different
 *   facts. The server does not record which act acked a toast: the
 *   `Toast` model carries `acknowledged` as a bare boolean and no writer
 *   stamps a reason. So this says `dismissed` or `open` and NOTHING
 *   ELSE. Rendering a guessed reason would be a fabricated fact on a
 *   page whose whole job is to be trusted about what happened. The gap
 *   is written down in docs/notifications.md rather than papered over.
 *
 *   THE SESSION NAME GOES THROUGH THE ONE RESOLVER. `SessionLabel`
 *   owns "label, else the cloude_-stripped tmux name, else say so" for
 *   the whole app. A toast recorded before the server carried identity
 *   has neither field and renders as the unknown marker, spoken rather
 *   than dropped - the same rule the toast card itself follows.
 *
 *   THE TIME IS ABSOLUTE AND RELATIVE. "4 minutes ago" is what the eye
 *   wants when scanning and useless for "what happened at 14:47", which
 *   is the question a history page is opened to answer, so both are
 *   rendered.
 */
(function () {
    'use strict';

    /** Outcome vocabulary. Two words, and there is deliberately no third. */
    var OUTCOME_OPEN = 'open';
    var OUTCOME_DISMISSED = 'dismissed';

    /** What the unknown-session marker falls back to with no SessionLabel. */
    var UNKNOWN_SESSION = 'unknown session';

    /**
     * Description: the human-facing kind word for a toast. The wire
     *   vocabulary is Claude Code's hook event names, which mean nothing
     *   to a reader; these are the words the rest of this UI uses for the
     *   same four states.
     * Inputs: kind (string) - the server-side toast kind.
     * Output: string - lowercase display word. An unrecognised kind is
     *   returned VERBATIM rather than mapped to a default: a future kind
     *   rendered as "notice" would be a silent mislabel.
     * Example: kindLabel('PermissionRequest') -> 'permission'
     */
    function kindLabel(kind) {
        switch (kind) {
            case 'PermissionRequest': return 'permission';
            case 'Notification': return 'notice';
            case 'Stop': return 'done';
            case 'StartupPrompt': return 'startup';
            default: return String(kind || 'unknown');
        }
    }

    /**
     * Description: the outcome of one record, from the only fact recorded.
     * Inputs: toast (object) - server-shape toast.
     * Output: 'dismissed' | 'open'.
     * Example: outcomeOf({acknowledged: true}) -> 'dismissed'
     */
    function outcomeOf(toast) {
        return (toast && toast.acknowledged) ? OUTCOME_DISMISSED : OUTCOME_OPEN;
    }

    /**
     * Description: resolve which session a record is about, through the
     *   app's single label resolver.
     * Inputs: toast (object). Output: string - never empty.
     * Example: sessionText({session_label: 'Dev'}) -> 'Dev'
     */
    function sessionText(toast) {
        var resolved = null;
        if (window.SessionLabel && typeof window.SessionLabel.resolveToast === 'function') {
            resolved = window.SessionLabel.resolveToast(toast);
        }
        if (!resolved) {
            resolved = (toast && (toast.session_label || toast.session_name)) || null;
        }
        if (resolved) return resolved;
        return (window.SessionLabel && window.SessionLabel.UNKNOWN) || UNKNOWN_SESSION;
    }

    /**
     * Description: "3 minutes ago" for a timestamp, coarse on purpose -
     *   a history list is scanned, not stopwatched, and a ticking seconds
     *   figure on fifty rows reads as noise.
     * Inputs: iso (string) - ISO 8601 timestamp. now (number, optional) -
     *   injected epoch ms so the rule is testable without waiting.
     * Output: string. An unparseable timestamp yields '' rather than
     *   'NaN ago' or the epoch.
     * Example: relativeTime('2026-01-01T00:00:00', 1) -> ''
     */
    function relativeTime(iso, now) {
        var at = Date.parse(iso);
        if (isNaN(at)) return '';
        var seconds = Math.floor(((now === undefined ? Date.now() : now) - at) / 1000);
        if (seconds < 0) return 'just now';
        if (seconds < 60) return 'just now';
        var minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
        var days = Math.floor(hours / 24);
        return days + (days === 1 ? ' day ago' : ' days ago');
    }

    /**
     * Description: the clock time a record was raised, for the reader who
     *   is matching it against something else that happened.
     * Inputs: iso (string). Output: string - '' when unparseable.
     * Example: absoluteTime('nonsense') -> ''
     */
    function absoluteTime(iso) {
        var at = new Date(iso);
        if (isNaN(at.getTime())) return '';
        return at.toLocaleString();
    }

    /**
     * Description: flatten one server record into the fields a row draws.
     *   THE ONE FUNCTION A TEST NEEDS: everything the view claims about a
     *   record is decided here, and the DOM builder below only places it.
     * Inputs: toast (object). now (number, optional) - injected clock.
     * Output: {id, sessionId, session, kind, title, body, outcome,
     *   relative, absolute, jumpable}.
     *   `jumpable` is false when the record carries no session id, which
     *   is the one case a jump link cannot be honoured.
     * Example: row({id:'a', kind:'Stop', acknowledged:true}).outcome
     *          -> 'dismissed'
     */
    function row(toast, now) {
        var t = toast || {};
        return {
            id: t.id || '',
            sessionId: t.session_id || '',
            session: sessionText(t),
            kind: kindLabel(t.kind),
            rawKind: t.kind || '',
            title: t.title || '(untitled)',
            body: t.body || '',
            outcome: outcomeOf(t),
            relative: relativeTime(t.created_at, now),
            absolute: absoluteTime(t.created_at),
            jumpable: !!t.session_id,
        };
    }

    /**
     * Description: the sentence printed when the list is empty. IT NAMES
     *   THE RETENTION, and that is the point of having a function for it:
     *   these records live in the server process's memory and die with
     *   it, so an empty list after a restart means "the record was lost",
     *   not "nothing ever happened". Leaving the reader to assume the
     *   second would be a confidently wrong page.
     * Inputs: storage (string) - the response's `storage` field.
     * Output: string.
     * Example: emptyText('process_memory')
     */
    function emptyText(storage) {
        if (storage === 'process_memory') {
            return 'no notifications recorded yet. this history covers the '
                + 'current server run only - restarting the server clears it.';
        }
        return 'no notifications recorded yet.';
    }

    window.ToastHistoryRender = {
        row: row,
        kindLabel: kindLabel,
        outcomeOf: outcomeOf,
        sessionText: sessionText,
        relativeTime: relativeTime,
        absoluteTime: absoluteTime,
        emptyText: emptyText,
        OUTCOME_OPEN: OUTCOME_OPEN,
        OUTCOME_DISMISSED: OUTCOME_DISMISSED,
    };
}());
