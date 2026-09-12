/**
 * What the running-sessions card DOES: close, remove, restart, rename.
 *
 * SEPARATED FROM THE MARKUP ON PURPOSE. The legacy versions of these four
 * lived inside a 220-line string builder and a 119-line delegated click
 * binder, so "does a failed restart still repaint the list" could only be
 * answered by reading both. Each one is a function over a host here, and
 * `./running-actions.test.ts` drives every branch with no document.
 *
 * NOTHING IN HERE RESOLVES A ROW BY READING THE DOM. Identity is captured
 * at PAINT time and passed in: the list repaints on a 5s tick, and an
 * action that re-read its row when clicked can act on whatever took its
 * place. That is the same frozen-snapshot rule the row menu already
 * holds itself to.
 *
 * NO COPY IS BUILT BY `+`. Every sentence is one catalog message with its
 * punctuation inside it, because word order and punctuation are exactly
 * what a translation changes.
 */
import {
    RUNNING_SESSION_KEYS,
    rowActionFailed,
} from '../../../../client/js/labels/running-session.js';
import { sessionDisplayLabel } from '../sessions/session-label';
import type { RunningSessionRow, Translate } from '../sessions/types';
import { ApiUnavailableError, type RunningHost } from './running-host';

/** The three action ids, named rather than spelled out at each use. */
export const ACTION_CLOSE = 'close';
export const ACTION_REMOVE = 'remove';
export const ACTION_RESTART = 'restart';

/**
 * The reason text out of a thrown error, or the catalog's fallback.
 *
 * Description: an error with no message is a real case - a rejected
 *   promise carrying a string, a network failure with an empty `message`
 *   - and printing `undefined` into a sentence is the failure mode this
 *   avoids.
 * Inputs: error - whatever was thrown. t - the translator.
 * Output: string.
 * Example: reasonFrom(new Error('HTTP 500'), t)  // 'HTTP 500'
 */
export function reasonFrom(error: unknown, t: Translate): string {
    // THE ONE THROWN VALUE THAT IS NOT THE SERVER'S WORDS. It carries a
    // token rather than a sentence precisely so the sentence can live in
    // the catalog; see ./running-host.ts::ApiUnavailableError.
    if (error instanceof ApiUnavailableError) {
        return t(RUNNING_SESSION_KEYS.apiUnavailable);
    }
    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return message;
    }
    if (typeof error === 'string' && error.trim()) return error;
    return t(RUNNING_SESSION_KEYS.serverUnreachable);
}

/**
 * Run the destructive row action: close a running session, or remove a
 * stopped one from the list.
 *
 * Description: BOTH END AT THE SAME SERVER CALL, and the copy is honest
 *   about that: a stopped row has no process left to terminate, so
 *   clearing its leftover tmux husk is exactly what "remove" means. Which
 *   one this row painted is passed IN rather than re-derived, so the
 *   confirm copy always matches the control the user actually clicked.
 *
 *   NAME IT THE WAY THE USER KNOWS IT. This used to derive the display
 *   straight off the tmux handle, so a session labelled "Media
 *   Compression" produced a DESTRUCTIVE confirmation reading
 *   "cloude_Media_Compression" - asking someone to confirm destroying
 *   something under a name they never chose. The row is resolved through
 *   the same label rule the card rendered with, so the dialog and the
 *   row cannot disagree.
 *
 *   RESTART BRANCHES OUT BEFORE THE SHARED CONFIRM, because it carries
 *   its OWN confirmation - the picker, which states the predicted outcome
 *   and the chosen wrapper, neither of which a generic dialog could say.
 *
 *   THE LIST IS RELOADED ON EVERY PATH THAT DID NOT NAVIGATE, including
 *   the failure path, so a row whose real state changed under us repaints
 *   either way.
 * Inputs: row - the row as it was painted. action - which control.
 *   host, t.
 * Output: Promise<void>. A cancelled confirm is a no-op.
 * Example: await runRowAction(row, 'close', host, t)
 */
export async function runRowAction(
    row: RunningSessionRow,
    action: string,
    host: RunningHost,
    t: Translate,
): Promise<void> {
    const tmuxName = row && row.name;
    if (!tmuxName) return;
    const display = sessionDisplayLabel(row);
    if (action === ACTION_RESTART) {
        await restartSession(row, host, t);
        return;
    }
    if (host.requiresConfirm(action)) {
        const confirmed = await host.confirmAction(action, display);
        if (!confirmed) return;
    }
    try {
        // Resolve the session id for this tmux name if the row did not
        // carry one: a live session bound to it must go through the full
        // teardown; external or detached is a direct kill-session.
        const sid = row.session_id || (await host.resolveSessionId(tmuxName));
        if (sid) {
            await host.destroySession(sid);
        } else {
            await host.destroyExternalSession(tmuxName);
        }
    } catch (error) {
        host.showError(rowActionFailed(
            host.actionLabel(action), reasonFrom(error, t), t,
        ));
    }
    await host.refresh();
}

/**
 * Restart the agent in a session, in place.
 *
 * Description: ASK FIRST. The picker fetches the read-only preview, shows
 *   which rung this session would land on, and lets the user move it onto
 *   a different launch wrapper; its own restart button is the
 *   confirmation. THAT IS NOT A COURTESY: a pane with an empty
 *   `#{pane_start_command}` lands on the shell rung and comes back as a
 *   LOGIN SHELL rather than an agent, silently, and this used to fire on
 *   one click with nothing on screen saying so.
 *
 *   FAIL CLOSED WITH NO PICKER. A restart with no prediction and no
 *   choice is the old defect wearing the new control's clothes.
 *
 *   THE SERVER'S `ok` IS THE VERDICT, NOT THE HTTP STATUS. A 200 carrying
 *   `ok:false` is the normal shape for "the pane could not be read" and
 *   for "it started and exited again", and its `detail` is shown verbatim
 *   because it is the only thing that knows which happened.
 *
 *   ON SUCCESS THE USER GOES BACK INTO THE SESSION rather than back to a
 *   list to hunt for the row he just revived.
 * Inputs: row, host, t.
 * Output: Promise<void>.
 * Example: await restartSession(row, host, t)
 */
export async function restartSession(
    row: RunningSessionRow,
    host: RunningHost,
    t: Translate,
): Promise<void> {
    const tmuxName = row.name;
    const display = sessionDisplayLabel(row);
    const choice = await host.openRestartPicker(
        tmuxName, display, row.status ?? null,
    );
    if (!choice) {
        const why = host.restartPickerError();
        if (why) {
            host.showError(t(RUNNING_SESSION_KEYS.respawnUnpredictable, {
                name: display, reason: why,
            }));
        } else if (!host.hasRestartPicker()) {
            host.showError(t(RUNNING_SESSION_KEYS.respawnNoPicker, {
                name: display,
            }));
        }
        return;
    }

    let result: RespawnLike = null;
    try {
        result = await host.respawnSession(
            tmuxName, choice.agentType ?? null, choice.confirmRestartLive === true,
        );
    } catch (error) {
        host.showError(t(RUNNING_SESSION_KEYS.respawnFailed, {
            name: display, reason: reasonFrom(error, t),
        }));
        await host.refresh();
        return;
    }
    if (!result || result.ok !== true) {
        host.showError(t(RUNNING_SESSION_KEYS.respawnFailed, {
            name: display,
            reason: (result && result.detail)
                || t(RUNNING_SESSION_KEYS.respawnNoReason),
        }));
        await host.refresh();
        return;
    }
    if (choice.agentType && result.agent_type_persisted === false) {
        host.showError(t(RUNNING_SESSION_KEYS.respawnChoiceUnsaved, {
            name: display, agent: choice.agentType,
        }));
    }
    const back = await host.reopenAfterRestart(result);
    if (back.status === 'reopened') return;
    if (back.detail) host.showError(back.detail);
    else if (back.status === 'not_reopened') {
        host.showError(t(RUNNING_SESSION_KEYS.respawnNoReopen));
    }
    await host.refresh();
}

/** What `respawnSession` can answer with, including not at all. */
type RespawnLike = { ok?: boolean; detail?: string | null;
    agent_type_persisted?: boolean } | null;

/** What a rename attempt answers with. Three outcomes, never two. */
export interface RenameOutcome {
    /** `saved`, `unchanged`, or `refused` with a reason to show inline. */
    state: 'saved' | 'unchanged' | 'refused';
    /** The sentence to put in the inline error label, for `refused`. */
    reason: string | null;
}

/**
 * Save a typed session label.
 *
 * Description: UNCHANGED IS A NO-OP, AND THE BASIS IS THE SEED. That
 *   guard used to compare against the tmux HANDLE, a value a
 *   label-editing user never types, so it could essentially never fire.
 *   The basis has to move with the seed - a seed of the label against a
 *   comparison on the handle would make every dismissal a write.
 *
 *   IT IS ALSO WHAT MAKES SEEDING A SESSION WITH NO LABEL SAFE. That
 *   session is seeded with the stripped handle, because an empty box for
 *   a row that visibly has a name is worse to use and no safer; unchanged
 *   writing nothing is what stops that handle being promoted into a
 *   stored label nobody typed.
 *
 *   THE LABEL RULE COMES FROM THE ONE MODULE THAT HOLDS IT, never a local
 *   regex - a second copy is how the client and the server drift apart
 *   without either one looking wrong.
 * Inputs: sessionId - what the editor was opened against. raw - what the
 *   user typed. seed - what the box opened on. host, t.
 * Output: Promise<RenameOutcome>.
 * Example: await saveRename('ses_1', 'Media', 'cloude_Media', host, t)
 */
export async function saveRename(
    sessionId: string,
    raw: string,
    seed: string,
    host: RunningHost,
    t: Translate,
): Promise<RenameOutcome> {
    const typed = (raw || '').trim();
    if (!typed || typed === seed) {
        return { state: 'unchanged', reason: null };
    }
    const verdict = host.validateLabel(typed);
    if (!verdict.ok) {
        return {
            state: 'refused',
            reason: verdict.reason
                || t(RUNNING_SESSION_KEYS.renameRuleUnavailable),
        };
    }
    try {
        await host.renameSession(sessionId, verdict.value ?? typed);
    } catch (error) {
        return { state: 'refused', reason: renameFailureText(error, t) };
    }
    // Immediate refresh so the row paints the new name without waiting on
    // the 5s poller. The WS broadcast triggers one too; duplicate calls
    // are idempotent and the list no longer repaints on an unchanged tick.
    await host.refresh();
    return { state: 'saved', reason: null };
}

/**
 * Turn a rename failure into the sentence shown under the input.
 *
 * Description: THE THREE NAMED CASES ARE NAMED, and everything else keeps
 *   the server's own words. A 409 means the name is taken, a 400 means
 *   the server refused the value, a 404 means the row is gone - each is
 *   something the user can act on, and each is a catalog message. A
 *   failure that matched none of them is shown verbatim rather than
 *   flattened into "rename failed", which would hide the only
 *   information the response carried.
 * Inputs: error, t. Output: string.
 * Example: renameFailureText(new Error('HTTP 409'), t)  // 'name already in use'
 */
export function renameFailureText(error: unknown, t: Translate): string {
    const message = reasonFrom(error, t);
    if (/409/.test(message) || /already in use/i.test(message)) {
        return t(RUNNING_SESSION_KEYS.renameFailedInUse);
    }
    if (/400/.test(message) || /Invalid session name/i.test(message)) {
        return t(RUNNING_SESSION_KEYS.renameFailedInvalid);
    }
    if (/404/.test(message)) {
        return t(RUNNING_SESSION_KEYS.renameFailedMissing);
    }
    return message || t(RUNNING_SESSION_KEYS.renameFailed);
}
