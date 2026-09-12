/**
 * What one running-session card decides about itself.
 *
 * PORTED FROM tests/test_launchpad_wrapper_pill.node.mjs (the pill's own
 * rules) and the pencil and row-id halves of
 * tests/test_launchpad_rename_edits_label.node.mjs. Those files drove a
 * legacy string builder and asserted against its markup; these drive the
 * decisions the markup expressed. A port that satisfies these is correct
 * whatever it renders, which is what lets the component's template change
 * without rewriting the spec.
 *
 * EVERY ASSERTION IS ABOUT A VERDICT, NOT A STRING. The one exception is
 * the catalog key each verdict names, because a verdict pointing at the
 * wrong message renders the wrong sentence and nothing else would catch
 * it.
 */
import { describe, expect, test } from 'vitest';

import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
import {
    awaitingStartup,
    offersFork,
    renamePencilView,
    sessionRowId,
    themeCueView,
    wrapperPillView,
} from './running-row';
import { row } from './running-harness';

describe('the rename pencil has three states and is never absent', () => {
    test('a row with a session id is renameable, against that id', () => {
        const view = renamePencilView(row('cloude_api', { session_id: 'ses_1' }));
        expect(view.state).toBe('renameable');
        expect(view.renameKey).toBe('ses_1');
        expect(view.reasonKey).toBe(RUNNING_SESSION_KEYS.renameAction);
    });

    test('A TMUX NAME IS ENOUGH: a row with no session id is still renameable', () => {
        // THE BUG THIS PINS. The pencil required `session_id`, which the
        // manager only holds for an OPEN session, so every row the app had
        // not adopted drew a dead pencil - including a user's own running
        // sessions, all of them at once after a restart.
        const view = renamePencilView(row('cloude_api', { session_id: null }));
        expect(view.state).toBe('renameable');
        expect(view.renameKey).toBe('cloude_api');
    });

    test('a row with NEITHER handle refuses, and names the precondition', () => {
        const view = renamePencilView(row('', {
            session_id: null, created_by_cloude: true,
        }));
        expect(view.state).toBe('unavailable');
        expect(view.renameKey).toBeNull();
        expect(view.reasonKey).toBe(RUNNING_SESSION_KEYS.renameUnopened);
    });

    test('an EXTERNAL row with no handle names adoption, not opening', () => {
        const view = renamePencilView(row('', {
            session_id: null, created_by_cloude: false,
        }));
        expect(view.state).toBe('unavailable');
        expect(view.reasonKey).toBe(RUNNING_SESSION_KEYS.renameUnadopted);
    });

    test('THE THIRD OUTCOME: null ownership is CANNOT DETERMINE, not external', () => {
        // `created_by_cloude` is genuinely nullable - server_status.py
        // fills it with `ownership_by_name.get(name)`, which yields None
        // for a name the ownership map never answered for. `!value` would
        // fold that into "external" and invent an answer.
        const view = renamePencilView(row('', {
            session_id: null, created_by_cloude: null,
        }));
        expect(view.state).toBe('unknown_owner');
        expect(view.reasonKey).toBe(RUNNING_SESSION_KEYS.renameUnknownOwner);
    });

    test('the two refusals share a class, and it is NOT the live one', () => {
        // The class is what keeps a control the UI has just called
        // unavailable out of the click path by construction rather than by
        // a second check inside the handler.
        const live = renamePencilView(row('cloude_api'));
        const refused = renamePencilView(row('', { created_by_cloude: null }));
        expect(live.className).toBe('running-session-rename');
        expect(refused.className).toBe('running-session-rename-unavailable');
        expect(refused.className).not.toBe(live.className);
    });

    test('NEGATIVE CONTROL: every state carries a reason key', () => {
        // Without this a state that returned an empty key would draw a
        // control with no explanation and pass every test above.
        for (const r of [
            row('cloude_api'),
            row('', { created_by_cloude: true }),
            row('', { created_by_cloude: false }),
            row('', { created_by_cloude: null }),
        ]) {
            expect(renamePencilView(r).reasonKey).toMatch(/^session\.rename\./);
        }
    });
});

describe('the durable row id', () => {
    test('renders the id it was given', () => {
        expect(sessionRowId(row('a', { session_row_id: 7 }))).toBe('7');
    });

    test('renders NOTHING for a row that has none', () => {
        // An EXTERNAL tmux session this app never created genuinely has no
        // row. Printing `#?` would invent an identity for a session we
        // have no record of.
        expect(sessionRowId(row('a', { session_row_id: null }))).toBeNull();
        expect(sessionRowId(row('a', { session_row_id: undefined }))).toBeNull();
    });

    test('ZERO IS A ROW ID, not an absence', () => {
        expect(sessionRowId(row('a', { session_row_id: 0 }))).toBe('0');
    });
});

describe('fork is offered on owned rows only', () => {
    test('owned yes, external no, unknown no', () => {
        // An external tmux session has no row of ours and so no recorded
        // conversation to copy; the server refuses it with a 409, and a
        // control that is going to be refused is worse than none.
        expect(offersFork(row('a', { created_by_cloude: true }))).toBe(true);
        expect(offersFork(row('a', { created_by_cloude: false }))).toBe(false);
        expect(offersFork(row('a', { created_by_cloude: null }))).toBe(false);
    });
});

describe('the launch-wrapper pill', () => {
    test('a label renders a pill carrying that exact text', () => {
        expect(wrapperPillView('claude (chrome)')).toEqual({ label: 'claude (chrome)' });
    });

    test('a null label renders NO pill at all, and no placeholder', () => {
        // THE OPPOSITE OF THE FAMILY PILL'S RULE, deliberately. A session
        // launched as a bare shell was launched through no wrapper at all,
        // so "unknown wrapper" would report a gap where there is none.
        expect(wrapperPillView(null)).toBeNull();
        expect(wrapperPillView(undefined)).toBeNull();
    });

    test('blank and whitespace-only labels render nothing', () => {
        expect(wrapperPillView('')).toBeNull();
        expect(wrapperPillView('   ')).toBeNull();
    });

    test('a non-string renders nothing rather than [object Object]', () => {
        expect(wrapperPillView({ toString: () => 'x' } as unknown as string)).toBeNull();
        expect(wrapperPillView(42 as unknown as string)).toBeNull();
    });

    test('the label is trimmed, so padding cannot change the pill', () => {
        expect(wrapperPillView('  claude  ')).toEqual({ label: 'claude' });
    });
});

describe('the per-session theme cue', () => {
    /** A lookup that answers for one id and refuses every other. */
    const lookup = (id: string) =>
        id === 'dracula' ? { accent: 'rgb(1, 2, 3)', label: 'Dracula' } : null;

    test('a themed row carries the id, one colour and the manifest name', () => {
        expect(themeCueView('dracula', lookup)).toEqual({
            themeId: 'dracula', accent: 'rgb(1, 2, 3)', name: 'Dracula',
        });
    });

    test('all three not-themed cases render nothing', () => {
        // No theme, a theme the registry does not know, and a registry
        // that has not loaded - the same blank row in every case.
        expect(themeCueView(null, lookup)).toBeNull();
        expect(themeCueView('nope', lookup)).toBeNull();
        expect(themeCueView('dracula', () => null)).toBeNull();
    });

    test('the id is reduced to what a stylesheet can select on', () => {
        const cue = themeCueView('dra cula!', () => ({
            accent: 'rgb(0, 0, 0)', label: 'x',
        }));
        expect(cue?.themeId).toBe('dracula');
    });

    test('an id with NOTHING safe in it yields an untinted row', () => {
        expect(themeCueView('!!!', () => ({ accent: 'rgb(0,0,0)', label: 'x' })))
            .toBeNull();
    });

    test('the swatch falls back to the id when the manifest has no name', () => {
        const cue = themeCueView('dracula', () => ({
            accent: 'rgb(1, 2, 3)', label: '',
        }));
        expect(cue?.name).toBe('dracula');
    });
});

describe('the startup gate paints only on a MEASURED block', () => {
    test('awaiting_startup_prompt is the only value that paints', () => {
        expect(awaitingStartup('awaiting_startup_prompt')).toBe(true);
    });

    test('ready and unknown both paint nothing', () => {
        expect(awaitingStartup('ready')).toBe(false);
        expect(awaitingStartup('unknown')).toBe(false);
    });

    test('an older payload with no field degrades to painting nothing', () => {
        expect(awaitingStartup(null)).toBe(false);
        expect(awaitingStartup(undefined)).toBe(false);
    });

    test('the predicate is STRICT, not truthy', () => {
        // `!!row.startup_gate` would be true for 'unknown' and 'ready'
        // alike, and 'unknown' means the probe did not answer.
        expect(awaitingStartup('anything-else')).toBe(false);
    });
});
