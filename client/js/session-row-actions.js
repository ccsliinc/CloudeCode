/**
 * Session Row Actions - the single source of truth for the destructive
 * control a session row offers, in EVERY place a session row is drawn
 * (the launcher's "running sessions" list in client/js/launchpad.js and
 * the in-terminal conversation sidebar in client/js/session-sidebar.js).
 *
 * The two actions, and the promise each one makes to the user:
 *
 *   X (close)      kills the tmux session. The Claude process stops. The
 *                  transcript JSONL on disk is NOT touched and stays
 *                  under ~/.claude/projects, so the conversation can be
 *                  resumed later by Claude Code itself.
 *   trash (remove) forgets the entry in CloudeCode. Nothing on disk is
 *                  touched at all. Only offered for a row whose process
 *                  has ALREADY exited, so there is nothing running left
 *                  to terminate; clearing the leftover tmux husk is what
 *                  makes the entry actually go away.
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
     * Hover tooltip + accessible name per action. Identical text goes to
     * both `title` (pointer) and `aria-label` (assistive tech) so the two
     * can never drift, and lowercase to match the app's UI voice.
     * @type {Object<string, string>}
     */
    const ACTION_LABELS = {
        [ACTION_CLOSE]: 'close session',
        [ACTION_REMOVE]: 'remove from the list',
    };

    /**
     * DOM contract shared by every call site. Constants, not literals at
     * the call sites, so the markup builder and the click handlers can
     * never disagree about the attribute name.
     * @type {string}
     */
    const ATTR_ACTION = 'data-session-action';
    const ATTR_NAME = 'data-session-name';
    const BASE_CLASS = 'session-row-action';

    /**
     * Confirm-modal copy per action. Accuracy is a feature here: an
     * overstated warning ("this cannot be undone", on an action that
     * deletes nothing) trains people to click through warnings without
     * reading them.
     * @type {Object<string, {title: string, primaryLabel: string, details: string}>}
     */
    const CONFIRM_COPY = {
        [ACTION_CLOSE]: {
            title: 'close session',
            primaryLabel: 'close',
            details:
                'the running process is terminated. the transcript is not ' +
                'deleted and stays under ~/.claude/projects.',
        },
        [ACTION_REMOVE]: {
            title: 'remove session',
            primaryLabel: 'remove',
            details:
                'this session already exited, so nothing is terminated. the ' +
                'leftover tmux shell is cleared and cloudecode forgets the ' +
                'entry. nothing on disk is touched.',
        },
    };

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
     * Inputs:
     *   status (string|null|undefined) - raw activity_status/status value
     *     from the API payload.
     * Output:
     *   string - ACTION_CLOSE or ACTION_REMOVE.
     * Example:
     *   actionFor('working') -> 'close'
     *   actionFor('dead')    -> 'remove'
     *   actionFor(undefined) -> 'close'   // unknown is never assumed dead
     */
    function actionFor(status) {
        const key = window.SessionStatusUI
            ? window.SessionStatusUI.normalizeStatus(status)
            : 'unknown';
        return STOPPED_STATUSES.indexOf(key) !== -1 ? ACTION_REMOVE : ACTION_CLOSE;
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
        return action === ACTION_REMOVE
            ? window.SessionStatusUI.trashIconSvg()
            : window.SessionStatusUI.closeIconSvg();
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
        const action = actionFor(status);
        const label = labelFor(action);
        const safeName = escapeAttr(tmuxName);
        const cls = surfaceClass ? `${BASE_CLASS} ${surfaceClass}` : BASE_CLASS;
        return (
            `<button type="button" class="${cls}" ` +
            `${ATTR_ACTION}="${action}" ${ATTR_NAME}="${safeName}" ` +
            `title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">` +
            `${iconFor(action)}</button>`
        );
    }

    /**
     * Ask the user to confirm an action, naming the session.
     *
     * Description: routes through `App.showConfirmModal()`, the app's ONE
     *   confirmation implementation - this module adds copy, never a
     *   second modal. The modal escapes its own arguments, so the display
     *   name is passed raw here.
     *
     *   No archive check is performed. This app has no notion of the
     *   user's conversation archive: nothing in the client, the API, or
     *   src/core knows whether a transcript has been archived, and there
     *   is no endpoint that could answer it. Asserting "not archived" in
     *   this modal would be an invented fact, so the copy stays silent on
     *   it and states only what is verifiable - that closing leaves the
     *   transcript on disk.
     * Inputs:
     *   action (string) - ACTION_CLOSE or ACTION_REMOVE.
     *   displayName (string) - session name as shown in the row.
     * Output:
     *   Promise<boolean> - true only on an explicit confirm click.
     * Example:
     *   await confirm('close', 'api-work') -> true
     */
    function confirm(action, displayName) {
        const copy = CONFIRM_COPY[action] || CONFIRM_COPY[ACTION_CLOSE];
        const verb = action === ACTION_REMOVE ? 'remove' : 'close';
        return window.App.showConfirmModal(
            copy.title,
            `${verb} "${displayName}"?`,
            copy.details,
            copy.primaryLabel,
            'cancel'
        );
    }

    window.SessionRowActions = {
        ACTION_CLOSE,
        ACTION_REMOVE,
        ATTR_ACTION,
        ATTR_NAME,
        BASE_CLASS,
        actionFor,
        labelFor,
        iconFor,
        html,
        confirm,
    };
    console.log('[SessionRowActions Module] Exported as window.SessionRowActions');
})();
