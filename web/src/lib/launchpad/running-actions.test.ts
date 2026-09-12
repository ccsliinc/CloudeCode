/**
 * What the running-sessions card DOES, driven without a document.
 *
 * PORTED FROM tests/test_session_row_restart.node.mjs (the restart flow's
 * refusals) and the action half of tests/test_session_row_actions.node.mjs,
 * plus the rename branches of
 * tests/test_launchpad_rename_edits_label.node.mjs. Those files reached
 * these behaviours through a delegated click binder and a 220-line string
 * builder; here each is a function over a recording host.
 *
 * EVERY REFUSAL IS ASSERTED, and that is most of the file. The happy paths
 * are short and the interesting cases are all the ways this must NOT act:
 * a declined confirm, a picker that did not load, a 200 carrying
 * `ok:false`, an unchanged rename, a refused label.
 */
import { describe, expect, test } from 'vitest';

import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
import {
    reasonFrom,
    renameFailureText,
    restartSession,
    runRowAction,
    saveRename,
} from './running-actions';
import { recordingHost, row, testTranslate as t } from './running-harness';

/** Which host methods were called, in order. */
function methods(host: { calls: Array<{ method: string }> }): string[] {
    return host.calls.map((c) => c.method);
}

describe('closing and removing', () => {
    test('a confirmed close on a BOUND session goes through the full teardown', async () => {
        // `DELETE /sessions/{id}` tears down the backend, the idle
        // watcher, the tunnels and the metadata and then kills tmux; the
        // external endpoint only kills tmux.
        const host = recordingHost();
        await runRowAction(row('cloude_api', { session_id: 'ses_1' }), 'close', host, t);
        expect(methods(host)).toEqual(['confirmAction', 'destroySession', 'refresh']);
    });

    test('a DETACHED session is killed directly, with no adoption', async () => {
        // Adoption refuses dead panes, which used to leave any session
        // whose foreground process had exited permanently un-killable.
        const host = recordingHost();
        await runRowAction(row('cloude_api', { session_id: null }), 'close', host, t);
        expect(methods(host)).toEqual([
            'confirmAction', 'resolveSessionId', 'destroyExternalSession', 'refresh',
        ]);
    });

    test('a live id resolved for a detached row still takes the full teardown', async () => {
        const host = recordingHost({ resolveSessionId: 'ses_9' });
        await runRowAction(row('cloude_api', { session_id: null }), 'close', host, t);
        expect(methods(host)).toContain('destroySession');
        expect(methods(host)).not.toContain('destroyExternalSession');
    });

    test('A DECLINED CONFIRM DESTROYS NOTHING AND REFRESHES NOTHING', async () => {
        const host = recordingHost({ confirm: false });
        await runRowAction(row('cloude_api'), 'close', host, t);
        expect(methods(host)).toEqual(['confirmAction']);
    });

    test('THE CONFIRM NAMES THE SESSION THE WAY THE USER KNOWS IT', async () => {
        // This used to derive the display straight off the tmux handle, so
        // a session labelled "Media Compression" produced a DESTRUCTIVE
        // confirmation reading "cloude_Media_Compression".
        const host = recordingHost();
        await runRowAction(
            row('cloude_Media_Compression', { label: 'Media Compression' }),
            'close', host, t,
        );
        const call = host.calls.find((c) => c.method === 'confirmAction');
        expect(call?.args).toEqual(['close', 'Media Compression']);
    });

    test('a session with NO label is named by its STRIPPED handle', async () => {
        // Resolver outcome 2: what this dialog said before labels existed.
        // Never the raw `cloude_` handle, which is a namespace prefix the
        // user never typed and does not recognise.
        const host = recordingHost();
        await runRowAction(row('cloude_fstest', { label: null }), 'close', host, t);
        const call = host.calls.find((c) => c.method === 'confirmAction');
        expect(call?.args).toEqual(['close', 'fstest']);
    });

    // THE THIRD CASE OF tests/test_row_action_confirm_names_label.node.mjs
    // CANNOT HAPPEN ANY MORE, and that is the port rather than a gap. It
    // covered "a handle with NO matching row still produces a named
    // confirm": the legacy handler was given only a tmux name and looked
    // the row up in `this.runningSessions`, so the lookup could miss - a
    // row the launcher had not polled yet, or one already gone - and the
    // fallback existed so a confirm that cannot name its target is still
    // better than no confirm. Every function in ./running-actions.ts takes
    // the ROW, captured at paint time by the control that rendered it, so
    // there is no lookup left to miss. A row with no name at all is
    // covered above: it does nothing, because there is nothing to act on.

    test('a failure is SHOWN and the list is still refreshed', async () => {
        const host = recordingHost();
        host.destroyExternalSession = async () => { throw new Error('HTTP 500'); };
        await runRowAction(row('cloude_api'), 'close', host, t);
        expect(host.errors).toHaveLength(1);
        expect(host.errors[0]).toContain('HTTP 500');
        expect(methods(host)).toContain('refresh');
    });

    test('a row with no name does nothing at all', async () => {
        const host = recordingHost();
        await runRowAction(row(''), 'close', host, t);
        expect(methods(host)).toEqual([]);
    });
});

describe('restarting', () => {
    test('RESTART ASKS THE PICKER FIRST, and never the generic confirm', async () => {
        // A pane with an empty `#{pane_start_command}` lands on the shell
        // rung and comes back as a LOGIN SHELL rather than an agent,
        // silently. The picker is what says so before anything runs.
        const host = recordingHost({ restartChoice: { agentType: 'claude-chrome' } });
        await runRowAction(row('cloude_api'), 'restart', host, t);
        expect(methods(host)).toContain('openRestartPicker');
        expect(methods(host)).not.toContain('confirmAction');
    });

    test('the picker is told the row MEASURED status, not a guess', async () => {
        const host = recordingHost({ restartChoice: {} });
        await restartSession(row('cloude_api', { status: 'dead' }), host, t);
        const call = host.calls.find((c) => c.method === 'openRestartPicker');
        expect(call?.args[2]).toBe('dead');
    });

    test('A DECLINED PICKER STARTS NOTHING AND SAYS NOTHING', async () => {
        const host = recordingHost({ restartChoice: null });
        await restartSession(row('cloude_api'), host, t);
        expect(methods(host)).toEqual(['openRestartPicker']);
        expect(host.errors).toHaveLength(0);
    });

    test('a picker that could not PREDICT says why, and starts nothing', async () => {
        const host = recordingHost({
            restartChoice: null, restartError: 'the pane could not be read',
        });
        await restartSession(row('cloude_api'), host, t);
        expect(methods(host)).not.toContain('respawnSession');
        expect(host.errors[0]).toContain(RUNNING_SESSION_KEYS.respawnUnpredictable);
        expect(host.errors[0]).toContain('the pane could not be read');
    });

    test('FAIL CLOSED: no picker module at all is its OWN sentence', async () => {
        // A restart with no prediction and no choice is the old defect
        // wearing the new control's clothes. And it must not be confused
        // with a user who simply pressed cancel.
        const host = recordingHost({ restartChoice: null, hasRestartPicker: false });
        await restartSession(row('cloude_api'), host, t);
        expect(methods(host)).not.toContain('respawnSession');
        expect(host.errors[0]).toContain(RUNNING_SESSION_KEYS.respawnNoPicker);
    });

    test('THE SERVER OK IS THE VERDICT: a 200 with ok:false is a refusal', async () => {
        const host = recordingHost({
            restartChoice: {},
            respawn: { ok: false, detail: 'it started and exited again' },
        });
        await restartSession(row('cloude_api'), host, t);
        expect(methods(host)).not.toContain('reopenAfterRestart');
        // The server's own sentence is shown verbatim: it is the only
        // thing that knows WHICH failure this was.
        expect(host.errors[0]).toContain('it started and exited again');
        expect(methods(host)).toContain('refresh');
    });

    test('an ok:false carrying no detail still says something', async () => {
        const host = recordingHost({ restartChoice: {}, respawn: { ok: false } });
        await restartSession(row('cloude_api'), host, t);
        expect(host.errors[0]).toContain(RUNNING_SESSION_KEYS.respawnNoReason);
    });

    test('a thrown respawn is reported and the list is refreshed', async () => {
        const host = recordingHost({
            restartChoice: {},
            respawn: () => { throw new Error('network down'); },
        });
        await restartSession(row('cloude_api'), host, t);
        expect(host.errors[0]).toContain('network down');
        expect(methods(host)).toContain('refresh');
    });

    test('A CHOICE THAT DID NOT PERSIST IS SAID OUT LOUD', async () => {
        // Otherwise the next restart quietly forgets it and nobody knows.
        const host = recordingHost({
            restartChoice: { agentType: 'claude-chrome' },
            respawn: { ok: true, agent_type_persisted: false },
            reopen: { status: 'reopened' },
        });
        await restartSession(row('cloude_api'), host, t);
        expect(host.errors[0]).toContain(RUNNING_SESSION_KEYS.respawnChoiceUnsaved);
        expect(host.errors[0]).toContain('claude-chrome');
    });

    test('ON SUCCESS THE USER GOES BACK INTO THE SESSION, and the list is not reloaded', async () => {
        const host = recordingHost({
            restartChoice: {}, respawn: { ok: true }, reopen: { status: 'reopened' },
        });
        await restartSession(row('cloude_api'), host, t);
        expect(methods(host)).toContain('reopenAfterRestart');
        expect(methods(host)).not.toContain('refresh');
    });

    test('a reopen that did NOT happen says why and reloads the list', async () => {
        const host = recordingHost({
            restartChoice: {}, respawn: { ok: true },
            reopen: { status: 'not_reopened', detail: 'the session id was not returned' },
        });
        await restartSession(row('cloude_api'), host, t);
        expect(host.errors[0]).toBe('the session id was not returned');
        expect(methods(host)).toContain('refresh');
    });

    test('the live-restart confirmation flag is passed through unchanged', async () => {
        // `kills_live_pane` is the ONLY thing that makes anything pass
        // `-k`, and it is set only when the caller confirmed. Dropping
        // this on the floor would make the picker's arm checkbox
        // decorative.
        const host = recordingHost({
            restartChoice: { agentType: null, confirmRestartLive: true },
            respawn: { ok: true }, reopen: { status: 'reopened' },
        });
        await restartSession(row('cloude_api'), host, t);
        const call = host.calls.find((c) => c.method === 'respawnSession');
        expect(call?.args).toEqual(['cloude_api', null, true]);
    });

    test('and an UNCONFIRMED live restart passes false, never undefined', async () => {
        const host = recordingHost({
            restartChoice: {}, respawn: { ok: true }, reopen: { status: 'reopened' },
        });
        await restartSession(row('cloude_api'), host, t);
        const call = host.calls.find((c) => c.method === 'respawnSession');
        expect(call?.args[2]).toBe(false);
    });
});

describe('renaming', () => {
    test('a changed label is validated and then stored', async () => {
        const host = recordingHost();
        const outcome = await saveRename('ses_1', 'Media v2', 'Media', host, t);
        expect(outcome.state).toBe('saved');
        expect(methods(host)).toEqual(['validateLabel', 'renameSession', 'refresh']);
    });

    test('UNCHANGED WRITES NOTHING, and the basis is the SEED', async () => {
        // The guard used to compare against the tmux HANDLE, a value a
        // label-editing user never types, so it could essentially never
        // fire. It is also what makes seeding a label-less session with
        // its handle safe.
        const host = recordingHost();
        const outcome = await saveRename('ses_1', 'api', 'api', host, t);
        expect(outcome.state).toBe('unchanged');
        expect(methods(host)).toEqual([]);
    });

    test('an EMPTY box is a cancel, not a write of an empty label', async () => {
        const host = recordingHost();
        expect((await saveRename('ses_1', '   ', 'api', host, t)).state)
            .toBe('unchanged');
        expect(methods(host)).toEqual([]);
    });

    test('THE LABEL RULE IS THE SHARED ONE, and a refusal keeps its reason', async () => {
        const host = recordingHost({
            validateLabel: () => ({ ok: false, reason: 'no control characters' }),
        });
        const outcome = await saveRename('ses_1', 'bad', 'api', host, t);
        expect(outcome).toEqual({ state: 'refused', reason: 'no control characters' });
        expect(methods(host)).not.toContain('renameSession');
    });

    test('a refusal with NO reason still says something', async () => {
        const host = recordingHost({ validateLabel: () => ({ ok: false }) });
        const outcome = await saveRename('ses_1', 'x', 'api', host, t);
        expect(outcome.reason).toBe(RUNNING_SESSION_KEYS.renameRuleUnavailable);
    });

    test('THE VALIDATED VALUE IS WHAT IS STORED, not the raw text', async () => {
        // The rule may normalise; storing the raw input would make the
        // client and the server disagree about what was saved.
        const host = recordingHost({
            validateLabel: (value) => ({ ok: true, value: value.trim() }),
        });
        await saveRename('ses_1', '  Media  ', 'api', host, t);
        const call = host.calls.find((c) => c.method === 'renameSession');
        expect(call?.args).toEqual(['ses_1', 'Media']);
    });

    test('a label with punctuation reaches the server instead of being refused', async () => {
        const host = recordingHost();
        await saveRename('ses_1', 'Refactor spike (round 2)', 'api', host, t);
        const call = host.calls.find((c) => c.method === 'renameSession');
        expect(call?.args[1]).toBe('Refactor spike (round 2)');
    });
});

describe('what a rename failure is called', () => {
    test('409 means the name is taken', () => {
        expect(renameFailureText(new Error('HTTP 409'), t))
            .toBe(RUNNING_SESSION_KEYS.renameFailedInUse);
        expect(renameFailureText(new Error('name already in use'), t))
            .toBe(RUNNING_SESSION_KEYS.renameFailedInUse);
    });

    test('400 means the server refused the value', () => {
        expect(renameFailureText(new Error('HTTP 400'), t))
            .toBe(RUNNING_SESSION_KEYS.renameFailedInvalid);
    });

    test('404 means the row is gone', () => {
        expect(renameFailureText(new Error('HTTP 404'), t))
            .toBe(RUNNING_SESSION_KEYS.renameFailedMissing);
    });

    test('ANYTHING ELSE KEEPS THE SERVER WORDS, never a flattened "rename failed"', () => {
        // Flattening would hide the only information the response carried.
        expect(renameFailureText(new Error('tmux is not running'), t))
            .toBe('tmux is not running');
    });
});

describe('the reason out of a thrown value', () => {
    test('an Error gives its message', () => {
        expect(reasonFrom(new Error('boom'), t)).toBe('boom');
    });

    test('a bare string gives itself', () => {
        expect(reasonFrom('boom', t)).toBe('boom');
    });

    test('an EMPTY message falls back rather than printing undefined', () => {
        expect(reasonFrom(new Error(''), t))
            .toBe(RUNNING_SESSION_KEYS.serverUnreachable);
        expect(reasonFrom(null, t)).toBe(RUNNING_SESSION_KEYS.serverUnreachable);
        expect(reasonFrom({}, t)).toBe(RUNNING_SESSION_KEYS.serverUnreachable);
    });
});
