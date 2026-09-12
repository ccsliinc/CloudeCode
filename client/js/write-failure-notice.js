/**
 * A write that failed has to be SEEN, not only heard.
 * ----------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR. The sidebar's group controls report every
 * refusal through `#session-sidebar-live`, which the stylesheet clips to
 * `width:1px; height:1px; clip:rect(0,0,0,0)`. That element is for
 * assistive technology, and it does its job: a screen reader user HEARS
 * "could not create the group: ...". A sighted user gets silence, and a
 * refused write is indistinguishable from a click that did nothing. The
 * owner reported "new group" as broken; it was not broken, it correctly
 * refused and he could not see the refusal. It is the usual failure
 * inverted - the accessible path works and the visual one is missing.
 *
 * SO THIS ADDS A SURFACE, IT DOES NOT MOVE ONE. The live region keeps
 * saying exactly what it said. Removing it to "replace" it with a card
 * would regress the screen-reader path down to the level of the visual
 * one, which is the opposite of the fix.
 *
 * IT IS THE APP'S OWN TOAST, NOT A SECOND NOTIFICATION SYSTEM. There is
 * one card component in this app (client/js/toast.js, painted by
 * client/css/toast.css), and this file builds no markup of its own: it
 * produces a record in the server's toast shape and hands it to
 * `ToastManager.add()`. Card, stacking, cap, overflow, the dismiss
 * control and the theme accent all come free and cannot drift from the
 * notifications beside them. `client/js/attachment-toast.js` is the
 * precedent for a client-raised card and this follows it exactly.
 *
 * THREE PROPERTIES OF THE RECORD ARE LOAD-BEARING.
 *
 *   1. `local: true`. No server issued this, so dismissing it must not
 *      POST an ack for an id the server never minted. `ToastManager`
 *      already reads that flag (toast-lifecycle.js).
 *
 *   2. NO `session_id`, DELIBERATELY. The group controls are not scoped
 *      to a conversation - "could not create the group" is about the
 *      sidebar, not about any one session. A session id would fold this
 *      into that session's status card, under a heading reading "wants
 *      your attention", and a keystroke in that session would then
 *      retire a message about something else entirely. With no session
 *      id `ToastSessionGroup.groupKey` refuses, which is exactly right:
 *      a card of its own.
 *
 *   3. THE KIND IS CAP-EXEMPT. `WRITE_FAILED_KIND` is registered at
 *      severity 3 in toast.js, so a failure can never be the thing
 *      pushed behind "+2 more". A notice that is hidden by a cap is
 *      invisible again, which is the defect coming back wearing a card.
 *
 * IT NEVER THROWS AND IT NEVER SWALLOWS. Every caller is already on an
 * error path; a reporter that threw would lose the original failure. A
 * missing ToastManager (early boot, a screen with no container) is
 * logged and reported as `false`, so a caller can tell "shown" from
 * "could not show" rather than assuming.
 *
 * Loaded as a plain script, no build step. Must load AFTER toast.js,
 * whose `ToastManager` it reads the kind name back off.
 */

console.log('[WriteFailureNotice Module] Loading...');

(function () {
    'use strict';

    /**
     * Fallback kind name, used only if toast.js has not published yet.
     *
     * The authoritative copy is `ToastManager.WRITE_FAILED_KIND`, beside
     * the severity and coalescing rules that govern it, and that is what
     * is read when it is there. This literal exists so a record raised
     * before the manager loads still carries a truthful kind rather than
     * `undefined`.
     *
     * @type {string}
     */
    var FALLBACK_KIND = 'WriteFailed';

    /** The card's heading. Lowercase and plain, like every other. */
    var TITLE = 'that did not save';

    /**
     * What the card's identity line says when no session owns the
     * failure.
     *
     * EVERY TOAST CARD RENDERS AN IDENTITY LINE, and with no
     * `session_label` on the record `SessionLabel.resolveToast` falls
     * through to its honest "unknown session" (client/js/session-label.js).
     * Honest for a session toast, and WRONG here: a group that would not
     * create is a failure of the session LIST, and "unknown session"
     * invites the reader to go looking for a conversation that has
     * nothing to do with it. So the surface names itself.
     *
     * @type {string}
     */
    var DEFAULT_SURFACE = 'session list';

    /**
     * The kind name to stamp on a record.
     *
     * @returns {string} the manager's registered name, or the fallback.
     * @example kindName() // 'WriteFailed'
     */
    function kindName() {
        var mgr = window.ToastManager;
        return (mgr && mgr.WRITE_FAILED_KIND) || FALLBACK_KIND;
    }

    /**
     * A record id that cannot collide with a server-issued one.
     *
     * Prefixed with the kind so a card in a debugger says where it came
     * from, and salted so two identical failures one second apart are
     * two cards rather than one silently deduped by `ToastManager.add`.
     *
     * @returns {string}
     * @example freshId() // 'writefail:1789219196037:k3z9qa'
     */
    function freshId() {
        return 'writefail:' + Date.now() + ':'
            + Math.random().toString(36).slice(2, 8);
    }

    /**
     * Show a card for a write that did not land.
     *
     * @param {string} text - the sentence already built by the caller,
     *   the SAME one it puts in the live region. One message, two
     *   surfaces; two wordings would be two bugs waiting to disagree.
     * @param {object} [opts] - `{title}` to override the heading,
     *   `{surface}` to name what the failure belongs to on the card's
     *   identity line. Defaults to `DEFAULT_SURFACE`.
     * @returns {boolean} true when a card was raised. False means the
     *   toast surface was unavailable, NOT that the write succeeded.
     * @example
     *   WriteFailureNotice.report('could not create the group: 409')
     */
    function report(text, opts) {
        var body = String(text == null ? '' : text).trim();
        if (!body) return false;
        var mgr = window.ToastManager;
        if (!mgr || typeof mgr.add !== 'function') {
            // Not swallowed: the caller's live-region announcement has
            // already happened, and this says the visible half did not.
            console.warn('[WriteFailureNotice] no toast surface for:', body);
            return false;
        }
        mgr.add({
            id: freshId(),
            // See the header: a session id would fold this into a
            // conversation's status card. It belongs to no conversation.
            session_id: null,
            kind: kindName(),
            title: (opts && opts.title) || TITLE,
            body: body,
            // See DEFAULT_SURFACE: without this the card claims an
            // "unknown session" that was never involved.
            session_label: (opts && opts.surface) || DEFAULT_SURFACE,
            // No server record behind it, so nothing may be acked.
            local: true,
        });
        return true;
    }

    window.WriteFailureNotice = {
        TITLE: TITLE,
        DEFAULT_SURFACE: DEFAULT_SURFACE,
        FALLBACK_KIND: FALLBACK_KIND,
        report: report,
    };

    console.log('[WriteFailureNotice Module] Loaded');
})();
