/**
 * THE CONFIRMATION COPY for a session row's destructive controls,
 * extracted from client/js/session-row-actions.js for the project's
 * 500-line rule. A LIFT, not a redesign: the table and the two functions
 * below are unchanged, and session-row-actions.js still exports
 * `confirm` and `attachmentPreamble` under their own names, so no caller
 * moved.
 *
 * WHY THIS IS THE SEAM. Everything here is about WHAT THE USER IS TOLD
 * before something irreversible happens; everything left behind is about
 * WHICH CONTROL A ROW GETS. The accuracy argument in the table below is
 * the reason this file exists at all, and it reads better beside the copy
 * than beside the status ladder.
 *
 * Load order: BEFORE session-row-actions.js.
 */

console.log('[SessionRowActionsConfirm Module] Loading...');

(function () {
    var ACTION_CLOSE = 'close';
    var ACTION_REMOVE = 'remove';

    /**
     * Confirm-modal copy per action.
     *
     * Accuracy is the whole point of this table. A dialog that misstates
     * consequences is worse than no dialog, because it teaches the user
     * that dialogs in this app can be clicked through. That cuts both
     * ways: do not overstate ("everything is deleted"), and do not
     * understate ("nothing on disk is touched").
     *
     * WHAT EACH ACTION ACTUALLY DOES, on every path it can take. Both
     * actions reach the server through the same two calls; which one runs
     * is decided by whether a session id resolves for the row, NOT by
     * which glyph was clicked:
     *
     *   path A - a session id resolves (row carries data-session-id, or
     *     GET /sessions/list matches the tmux name) -> DELETE /sessions ->
     *     SessionManager.destroy_session(). Stops the idle watcher, stops
     *     the backend (kills tmux), **`shutil.rmtree`s
     *     `<working_dir>/.cloude_uploads`**, and may unlink
     *     session_metadata.json. THIS PATH TOUCHES DISK.
     *   path B - no session id resolves -> DELETE /sessions/external/{name}
     *     -> a bare `tmux kill-session` plus dropping the ownership
     *     record. Touches no user files.
     *
     * The sidebar's own-tab row additionally routes through
     * TerminalController.destroySession(), which is always path A.
     *
     * So REMOVE can and does delete files from the project folder: the
     * uploads bucket is real user content, not app scratch. Both dialogs
     * therefore name it. On path B there is no tracked session and so no
     * bucket for CloudeCode to remove, which makes the sentence vacuous
     * rather than false; stating it unconditionally keeps the copy short
     * and errs toward warning instead of toward surprise.
     *
     * The transcript JSONL is never touched on ANY path, which is why
     * both dialogs can promise that unconditionally.
     * @type {Object<string, {title: string, primaryLabel: string, details: string}>}
     */
    const CONFIRM_COPY = {
        [ACTION_CLOSE]: {
            title: 'close session',
            primaryLabel: 'close',
            details:
                'this cannot be undone. the running process is terminated, ' +
                'and files uploaded to this session are removed from the ' +
                "project's .cloude_uploads folder. the transcript is kept " +
                'and stays under ~/.claude/projects.',
        },
        [ACTION_REMOVE]: {
            title: 'remove session',
            primaryLabel: 'remove',
            details:
                'this cannot be undone. this session already exited, so no ' +
                'running process is stopped, but files uploaded to it are ' +
                "removed from the project's .cloude_uploads folder. the " +
                'leftover tmux shell is cleared and cloudecode forgets the ' +
                'entry. the transcript is kept and stays under ' +
                '~/.claude/projects.',
        },
    };

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
     *   it and states only what is verifiable against the server code.
     * Inputs:
     *   action (string) - ACTION_CLOSE or ACTION_REMOVE.
     *   displayName (string) - session name as shown in the row.
     * Output:
     *   Promise<boolean> - true only on an explicit confirm click.
     * Example:
     *   await confirm('close', 'api-work') -> true
     */
    function confirm(action, displayName, context) {
        const copy = CONFIRM_COPY[action] || CONFIRM_COPY[ACTION_CLOSE];
        const verb = action === ACTION_REMOVE ? 'remove' : 'close';
        return window.App.showConfirmModal(
            copy.title,
            `${verb} "${displayName}"?`,
            attachmentPreamble(context) + copy.details,
            copy.primaryLabel,
            'cancel'
        );
    }

    /**
     * Sentences naming what is CURRENTLY ATTACHED to the target session.
     *
     * Description: a confirmation that only describes the operation in
     *   the abstract lets the user destroy something they are looking at
     *   without being told. These two facts are the ones a list-based
     *   surface (the status panel) cannot convey from the row alone, so
     *   they lead the details rather than trail them. Both are omitted
     *   when absent rather than stated in the negative, so a plain row
     *   keeps the short copy it has always had - this cannot change the
     *   text of any existing call site that passes no context.
     * Inputs:
     *   context (object|null|undefined) - optional
     *     `{openInApp: boolean, attachedClients: number}`.
     * Output:
     *   string - zero, one or two sentences, each ending in a space.
     * Example:
     *   attachmentPreamble({openInApp: true, attachedClients: 1})
     *     -> 'this session is open in cloudecode right now, and that '
     *      + 'terminal will disconnect. 1 tmux client is attached to it '
     *      + 'right now and will be detached. '
     */
    function attachmentPreamble(context) {
        if (!context) return '';
        let out = '';
        if (context.openInApp) {
            out += 'this session is open in cloudecode right now, and that '
                + 'terminal will disconnect. ';
        }
        const attached = Number(context.attachedClients) || 0;
        if (attached > 0) {
            out += attached === 1
                ? '1 tmux client is attached to it right now and will be detached. '
                : `${attached} tmux clients are attached to it right now and `
                  + 'will be detached. ';
        }
        return out;
    }


    window.SessionRowActionsConfirm = {
        CONFIRM_COPY: CONFIRM_COPY,
        confirm: confirm,
        attachmentPreamble: attachmentPreamble,
    };
})();

console.log('[SessionRowActionsConfirm Module] Exported as window.SessionRowActionsConfirm');
