/**
 * Session Row Actions - the single source of truth for the destructive
 * control a session row offers, in EVERY place a session row is drawn
 * (the launcher's "running sessions" list in client/js/launchpad.js and
 * the in-terminal conversation sidebar in client/js/session-sidebar.js).
 *
 * The two actions, and the promise each one makes to the user:
 *
 *   X (close)      kills the tmux session. The Claude process stops, and
 *                  that part is irreversible. The transcript JSONL is NOT
 *                  touched and stays under ~/.claude/projects, so the
 *                  conversation can be resumed later by Claude Code
 *                  itself.
 *   trash (remove) forgets the entry in CloudeCode. Only offered for a
 *                  row whose process has ALREADY exited, so there is
 *                  nothing running left to terminate; clearing the
 *                  leftover tmux husk is what makes the entry go away.
 *
 * NEITHER action is disk-free. Both can route to DELETE /sessions, which
 * removes the session's `.cloude_uploads` bucket from the project folder.
 * See the CONFIRM_COPY docblock below for the full per-path breakdown -
 * that is the authoritative account, and the dialog copy is written from
 * it. Do not describe either action as leaving disk untouched.
 *
 * SEGREGATION IS THE POINT: a row offers exactly one of the two, never
 * both, chosen from its activity status. A running row gets the X; a
 * stopped row gets the trash. Offering both would ask the user to
 * understand a distinction the row's own state already answers.
 *
 * Why a module and not two copies of the markup: before this, the
 * launcher inlined its own X SVG with an aria-label and no title (no
 * hover tooltip at all) while the sidebar drew a trash can labelled
 * "Delete session" for the identical operation. Same click, two glyphs,
 * two names, one of them silent on hover. One builder ends that class of
 * drift for good.
 *
 * Load order: AFTER session-status-ui.js (uses its glyphs), BEFORE
 * launchpad.js and session-sidebar.js (both call into this).
 */

console.log('[SessionRowActions Module] Loading...');

(function () {
    /**
     * Action identifiers. Carried in the DOM on ``data-session-action``
     * so a delegated click handler learns which action it is running
     * without re-deriving it from status (the row was painted from a
     * status that may since have changed under a poll tick).
     * @type {string}
     */
    const ACTION_CLOSE = 'close';
    const ACTION_REMOVE = 'remove';
    /**
     * Restart the agent inside a session whose process has exited. The
     * ONLY non-destructive action in this module: it starts a process in
     * a pane that is already sitting empty, and destroys nothing. See
     * ``requiresConfirm``.
     * @type {string}
     */
    const ACTION_RESTART = 'restart';

    /**
     * Activity statuses that mean "this session is not running any more".
     * Sourced from the vocabulary in client/js/session-status-ui.js
     * (mirroring src/core/session_status.py). Only ``dead`` qualifies:
     * the pane's foreground process exited and tmux is holding the
     * corpse open under remain-on-exit.
     *
     * ``unknown`` is deliberately NOT here. Unknown means we could not
     * determine the state, and guessing "stopped" would offer a control
     * that silently discards a live session's entry.
     * @type {Array<string>}
     */
    const STOPPED_STATUSES = ['dead'];

    /**
     * Statuses that mean "we positively know this session is RUNNING".
     * A row in one of these may offer restart alongside close, because
     * restarting a live session is now a supported operation
     * (respawn-pane -k, same tmux name, same row).
     *
     * ``unknown`` IS DELIBERATELY ABSENT HERE TOO, and for the sharper
     * version of the same reason: offering restart on a row whose state
     * we could not read would put a control that KILLS A RUNNING PROCESS
     * in front of a user on the strength of a guess.
     *
     * ``stopped`` IS ABSENT, and it is not a near miss. It means the
     * tmux instance is GONE, not that a pane is holding an exited
     * process, so there is no pane to kill and nothing to respawn into.
     * That is the distinction session-status-ui.js spells out at length
     * where it explains why ``stopped`` is not a synonym for ``dead``.
     *
     * The list is an allow-list rather than "everything that is not
     * dead" so a status added to the vocabulary later cannot silently
     * inherit a destructive control. Every entry is a live-pane state in
     * client/js/session-status-ui.js, including the ``running``
     * back-compat alias a half-upgraded tab still sends.
     * @type {Array<string>}
     */
    const LIVE_STATUSES = [
        'working',
        'working_subagent',
        'question',
        'notice',
        'finished_unread',
        'idle',
        'running',
    ];

    /**
     * Hover tooltip + accessible name per action. Identical text goes to
     * both `title` (pointer) and `aria-label` (assistive tech) so the two
     * can never drift, and lowercase to match the app's UI voice.
     * @type {Object<string, string>}
     */
    const ACTION_LABELS = {
        [ACTION_CLOSE]: 'close session',
        [ACTION_REMOVE]: 'remove from the list',
        [ACTION_RESTART]: 'restart the agent',
    };

    /**
     * DOM contract shared by every call site. Exported, and every call
     * site reads them from here rather than writing the attribute name
     * out again, so the markup builder and the click handlers cannot
     * disagree about it.
     *
     * That includes the module-missing case: a call site must NOT fall
     * back to a hardcoded selector, because `html()` returns '' when this
     * module has not loaded, so no element carrying these attributes can
     * exist for the fallback to match. Such a fallback is dead code that
     * also re-introduces the literal this constant exists to remove.
     * @type {string}
     */
    const ATTR_ACTION = 'data-session-action';
    const ATTR_NAME = 'data-session-name';
    const BASE_CLASS = 'session-row-action';

    /**
     * Escape a value for interpolation into an HTML attribute.
     *
     * Description: session names come from tmux and from user input, so
     *   they are never trusted into markup. Uses the DOM's own escaping
     *   for text plus an explicit quote replacement, since textContent
     *   escaping alone does not cover the attribute-delimiter case.
     * Inputs:
     *   value (string|null|undefined) - raw value.
     * Output:
     *   string - safe to place inside a double-quoted HTML attribute.
     * Example:
     *   escapeAttr('a"b<c') -> 'a&quot;b&lt;c'
     */
    function escapeAttr(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML.replace(/"/g, '&quot;');
    }

    /**
     * Decide which action a row with this status is allowed to offer.
     *
     * Description: three cases, and the third is not the second.
     *
     *   A DEAD row is unchanged: restart first, because it is what the
     *   user came for, then remove.
     *
     *   A row we positively know is LIVE now offers restart too, after
     *   close. It is second rather than first on purpose - close is
     *   where the muscle memory already points on these rows, and moving
     *   it would relocate a destructive control under a cursor that had
     *   learned where it was.
     *
     *   OFFERING IT IS NOT PERMITTING IT. This control opens the restart
     *   picker; a live restart still needs the arm box AND the confirm
     *   modal inside it (client/js/session-restart-picker.js), and the
     *   server still refuses without `confirm_restart_live`. Three
     *   gates, and this is only the first.
     *
     *   An UNKNOWN row gets close alone, exactly as before. We could not
     *   read its state, and a control that kills a running process is
     *   not something to offer on a guess.
     * Inputs:
     *   status (string|null|undefined) - raw activity_status/status value
     *     from the API payload.
     * Output:
     *   Array<string> - one or two ACTION_* ids, in render order.
     * Example:
     *   actionsFor('working')  -> ['close', 'restart']
     *   actionsFor('dead')     -> ['restart', 'remove']
     *   actionsFor(undefined)  -> ['close']   // unknown is never guessed
     */
    function actionsFor(status) {
        const key = window.SessionStatusUI
            ? window.SessionStatusUI.normalizeStatus(status)
            : 'unknown';
        if (STOPPED_STATUSES.indexOf(key) !== -1) {
            // Restart first: it is what the user came for, and putting the
            // destructive control under the cursor's first stop would be a
            // poor trade on a row whose whole problem is that it looks
            // finished.
            return [ACTION_RESTART, ACTION_REMOVE];
        }
        if (LIVE_STATUSES.indexOf(key) !== -1) {
            return [ACTION_CLOSE, ACTION_RESTART];
        }
        return [ACTION_CLOSE];
    }

    /**
     * Whether a row with this status draws the three-dot ACTION MENU.
     *
     * Description: the menu carries every action except pin, so the
     *   question "does this row get a menu" is the same question as
     *   "would this row have painted a close X" - a running row gets the
     *   menu, and `close session` is an item inside it.
     *
     *   DERIVED FROM ``actionsFor``, never from a second status list, so
     *   the row and the menu cannot come to disagree about which one a
     *   status gets. That matters here more than usual: OUR ``actionsFor``
     *   keeps RESTART on a live row (decision 3 of the 1.2 merge, settled
     *   by the owner on 2026-09-09), and the menu's own restart item
     *   asks this same function whether to offer it.
     *
     *   A DEAD row answers false. It keeps its inline restart and remove
     *   and gets no menu, because the menu's items are what a RUNNING
     *   session needs. A dead row is also not meant to be on the live
     *   list at all - decision 4 sends it to Recent.
     * Inputs:
     *   status (string|null|undefined) - raw activity status.
     * Output:
     *   boolean - true when the row draws the menu instead of an X.
     * Example:
     *   offersMenu('working') -> true
     *   offersMenu('dead')    -> false
     *   offersMenu(undefined) -> true   // unknown still closes
     */
    function offersMenu(status) {
        return actionsFor(status).indexOf(ACTION_CLOSE) !== -1;
    }

    /**
     * Back-compat single-action accessor.
     *
     * Description: kept so no existing call site has to change in the
     *   same edit that adds restart. Returns the row's PRIMARY action,
     *   which for a dead row is now restart rather than remove - a dead
     *   row's primary intent is to get the agent back, not to discard it.
     *   New code should call ``actionsFor`` and render all of them.
     * Inputs:
     *   status (string|null|undefined) - raw activity_status value.
     * Output:
     *   string - one action id.
     * Example:
     *   actionFor('working') -> 'close'
     *   actionFor('dead')    -> 'restart'
     *   // a live row's SECOND action is restart; this accessor cannot
     *   // see it, which is why new code calls actionsFor instead.
     */
    function actionFor(status) {
        return actionsFor(status)[0];
    }

    /**
     * Whether an action must be confirmed before it runs.
     *
     * Description: the policy, stated once, in the module that owns the
     *   controls. Close and remove both destroy something the user cannot
     *   get back (a running process, an uploads bucket), so both confirm.
     *
     *   RESTART RETURNS FALSE, and that no longer means "no
     *   confirmation". It means "not THIS confirmation". Restart now
     *   opens the restart picker
     *   (client/js/session-restart-picker.js), whose own restart button
     *   is the explicit act, and which can state two things this generic
     *   dialog cannot: which rung the respawn ladder would land on - an
     *   empty `pane_start_command` silently returns a LOGIN SHELL - and
     *   which launch wrapper the session will come back on. Routing it
     *   through the shared modal as well would ask the user to agree
     *   twice to a decision the picker already spelled out in full, and
     *   the second dialog would say less than the first.
     * Inputs:
     *   action (string) - an ACTION_* id.
     * Output:
     *   boolean - true when a confirm modal must be shown first.
     * Example:
     *   requiresConfirm('restart') -> false
     *   requiresConfirm('remove')  -> true
     */
    function requiresConfirm(action) {
        return action !== ACTION_RESTART;
    }

    /**
     * Human-readable name of an action, for tooltip and accessible name.
     *
     * Inputs:
     *   action (string) - ACTION_CLOSE or ACTION_REMOVE.
     * Output:
     *   string - lowercase label.
     * Example:
     *   labelFor('remove') -> 'remove from the list'
     */
    function labelFor(action) {
        return ACTION_LABELS[action] || ACTION_LABELS[ACTION_CLOSE];
    }

    /**
     * Glyph for an action, from the shared icon family in
     * client/js/session-status-ui.js. Never inline SVG at a call site.
     *
     * Inputs:
     *   action (string) - ACTION_CLOSE or ACTION_REMOVE.
     * Output:
     *   string - a self-contained 16x16 `<svg>`, or '' if the icon module
     *     has not loaded (the button still renders with its label).
     * Example:
     *   iconFor('close') -> '<svg width="16" ...>...</svg>'
     */
    function iconFor(action) {
        if (!window.SessionStatusUI) return '';
        if (action === ACTION_REMOVE) return window.SessionStatusUI.trashIconSvg();
        if (action === ACTION_RESTART) {
            return window.SessionStatusUI.restartIconSvg();
        }
        return window.SessionStatusUI.closeIconSvg();
    }

    /**
     * Build the row's action control.
     *
     * Description: emits a real `<button>` (not a `role="button"` span)
     *   so Enter/Space and focus work without per-surface key handling.
     *   The caller supplies its own CSS class for surface-specific
     *   sizing; BASE_CLASS and the data attributes are the shared
     *   behavioral contract every call site's delegated handler matches
     *   on.
     * Inputs:
     *   status (string|null|undefined) - row activity status; picks the
     *     action.
     *   tmuxName (string) - literal tmux session name, carried back to
     *     the handler on ATTR_NAME.
     *   surfaceClass (string) - extra CSS class for the host surface
     *     (e.g. 'running-session-kill', 'session-sidebar-row-delete').
     * Output:
     *   string - HTML for one `<button>` element.
     * Example:
     *   html('dead', 'cloude_api', 'session-sidebar-row-delete')
     *     -> '<button type="button" class="session-row-action ..." ...>'
     */
    function html(status, tmuxName, surfaceClass) {
        const safeName = escapeAttr(tmuxName);
        const cls = surfaceClass ? `${BASE_CLASS} ${surfaceClass}` : BASE_CLASS;
        return actionsFor(status)
            .map(function (action) {
                const label = labelFor(action);
                const extra =
                    action === ACTION_RESTART ? ` ${BASE_CLASS}-restart` : '';
                return (
                    `<button type="button" class="${cls}${extra}" ` +
                    `${ATTR_ACTION}="${action}" ${ATTR_NAME}="${safeName}" ` +
                    `title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">` +
                    `${iconFor(action)}</button>`
                );
            })
            .join('');
    }

    /**
     * Ask the user to confirm an action, naming the session.
     *
     * Description: the copy and the modal call LIVE IN
     *   client/js/session-row-actions-confirm.js, lifted there for the
     *   500-line rule. This stays the entry point every call site already
     *   uses. With that module absent the answer is NO: a destructive
     *   action must never proceed because its confirmation failed to load.
     * Inputs:
     *   action (string) - ACTION_CLOSE or ACTION_REMOVE.
     *   displayName (string) - session name as shown in the row.
     *   context (object|null) - optional attachment facts.
     * Output:
     *   Promise<boolean> - true only on an explicit confirm click.
     */
    function confirm(action, displayName, context) {
        var mod = window.SessionRowActionsConfirm;
        if (!mod) return Promise.resolve(false);
        return mod.confirm(action, displayName, context);
    }

    /**
     * Sentences naming what is CURRENTLY ATTACHED to the target session.
     * See client/js/session-row-actions-confirm.js.
     * Inputs: context (object|null). Output: string.
     */
    function attachmentPreamble(context) {
        var mod = window.SessionRowActionsConfirm;
        return mod ? mod.attachmentPreamble(context) : '';
    }

    /**
     * Run the destructive action against the server.
     *
     * Description: THE one place the two destruction endpoints are chosen
     *   between, so a new surface cannot invent a third way to kill a
     *   tmux session. The branch is on whether a session id resolved, NOT
     *   on which glyph was clicked - see the CONFIRM_COPY docblock for
     *   what each path actually destroys.
     *
     *   The launcher (`launchpad.js`) and the sidebar
     *   (`session-sidebar.js`) still inline this same two-line branch.
     *   They should call this instead; that is deliberately not done in
     *   this change because both files are being edited on another branch
     *   right now, and a merge conflict in a destruction path is a worse
     *   outcome than a duplicated `if`.
     * Inputs:
     *   tmuxName (string) - literal tmux session name.
     *   sessionId (string|null) - id of the live backend bound to that
     *     name, when there is one.
     * Output:
     *   Promise<object> - the server's SuccessResponse.
     * Example:
     *   await perform('cloude_api', null)  // DELETE /sessions/external/...
     */
    function perform(tmuxName, sessionId) {
        if (sessionId) return window.API.destroySession(sessionId);
        return window.API.destroyExternalSession(tmuxName);
    }

    window.SessionRowActions = {
        ACTION_CLOSE,
        ACTION_REMOVE,
        ACTION_RESTART,
        LIVE_STATUSES,
        STOPPED_STATUSES,
        ATTR_ACTION,
        ATTR_NAME,
        BASE_CLASS,
        actionFor,
        actionsFor,
        offersMenu,
        requiresConfirm,
        labelFor,
        iconFor,
        html,
        confirm,
        attachmentPreamble,
        perform,
    };
    console.log('[SessionRowActions Module] Exported as window.SessionRowActions');
})();
