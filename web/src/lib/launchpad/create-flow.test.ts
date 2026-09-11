/**
 * The create flow's ORDER, which is the only thing standing between a
 * user and a project folder they did not ask for.
 *
 * WHY THIS IS THE MOST IMPORTANT TEST FILE IN THE SLICE. Everything else
 * here paints; this writes. `sessions.working_dir` is permanent, the
 * launcher lists it and the archive derives a transcript directory from
 * it, so a create path that skips a step does not show a wrong pixel, it
 * records a wrong folder forever. Three of the assertions below are
 * regression tests for defects that actually shipped.
 *
 * THE HOST AND THE MODALS ARE RECORDERS. A test hands in scripted answers
 * and reads back what was called, with what, and in what order. That is
 * what makes "a cancelled folder step creates NOTHING" an assertion
 * rather than a hope: the recorder would have the call.
 */
import { describe, expect, test } from 'vitest';

import { GOOD_FOLDER, GOOD_NAME, enT, modals, recorder } from './create-harness';
import { buildCreatePayload, agentTypeFor, createConsoleFlow, createProjectFlow } from './create-flow';

describe('RULE: the folder step cannot be skipped', () => {
    test('a create asks for a folder BEFORE it creates anything', async () => {
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        expect(result.outcome).toBe('created');
        // The order is the rule: provider, name, folder, create.
        expect(m.asked.map(([kind]) => kind)).toEqual(['name', 'folder']);
        const createdAt = rec.calls.findIndex(([kind]) => kind === 'createSession');
        expect(createdAt).toBeGreaterThan(-1);
        // Nothing durable happened before the folder step answered.
        expect(rec.calls.slice(0, createdAt).map(([kind]) => kind)).not.toContain('createProject');
    });

    test('cancelling the folder step creates NOTHING AT ALL', async () => {
        // THE MUTATION THIS CATCHES: a flow that carries on without a
        // parent directory, which is how a project named `Punchlist Test`
        // was created at `.../ses_5a756046`.
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: null });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        expect(result.outcome).toBe('cancelled_folder');
        expect(result.payload).toBe(null);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('createSession');
        expect(rec.calls.map(([kind]) => kind)).not.toContain('createProject');
        expect(rec.errors).toEqual([]);
    });

    test('cancelling the provider gate never even asks for a name', async () => {
        const rec = recorder({ chooseProvider: async () => null });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        expect(result.outcome).toBe('cancelled_provider');
        expect(m.asked).toEqual([]);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('createSession');
    });

    test('cancelling the name step never asks for a folder', async () => {
        const rec = recorder();
        const m = modals({ name: [null], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        expect(result.outcome).toBe('cancelled_name');
        expect(m.asked.map(([kind]) => kind)).toEqual(['name']);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('createSession');
    });
});

describe('RULE: the field is project_parent_dir, never working_dir', () => {
    test('the create payload carries the chosen PARENT and no working_dir', async () => {
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        await createProjectFlow(rec.host, m.openers, enT(), null);

        const payload = rec.payloads[0]!;
        expect(payload.project_parent_dir).toBe('/Users/me/Development');
        expect('working_dir' in payload).toBe(false);
    });

    test('the PARENT is posted, never the composed path', () => {
        // A client-composed path would record the short spelling of a
        // symlinked parent. The server joins the name itself, after
        // `os.path.realpath`.
        const payload = buildCreatePayload('My App', '/Users/me/Development', null, null, {});
        expect(payload.project_parent_dir).toBe('/Users/me/Development');
        expect(Object.values(payload)).not.toContain('/Users/me/Development/My App');
    });

    test('a shell console posts working_dir, and that stays legal', async () => {
        // The unrestricted field is unrestricted on purpose: three
        // shipped flows post a folder of their own choosing through it.
        const rec = recorder();
        await createConsoleFlow(rec.host, enT(), null);
        expect(rec.payloads[0]!.working_dir).toBe('~');
        expect('project_parent_dir' in rec.payloads[0]!).toBe(false);
    });
});

describe('RULE: a refused name is re-asked, never rewritten', () => {
    test('an illegal name shows a sentence and re-opens with what was typed', async () => {
        const rec = recorder();
        const m = modals({
            name: [{ name: 'a/b', description: '' }, GOOD_NAME],
            folder: GOOD_FOLDER,
        });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        expect(result.outcome).toBe('created');
        // Asked twice, and the SECOND ask carried the refused text.
        const nameAsks = m.asked.filter(([kind]) => kind === 'name');
        expect(nameAsks).toHaveLength(2);
        expect((nameAsks[1]![1] as { defaultName: string }).defaultName).toBe('a/b');
        // The user was told why, in a sentence.
        expect(rec.errors).toEqual(["a project name cannot contain '/'"]);
        // And NOTHING was posted under a rewritten name.
        expect(rec.payloads[0]!.project_name).toBe('My App');
    });

    test('the refused name is never silently sanitised into the payload', async () => {
        // THE MUTATION THIS CATCHES: `validateName` returning ok with the
        // slash replaced. The flow would then post a project_name the
        // user never typed and could not find on disk.
        const rec = recorder();
        const m = modals({ name: [{ name: 'a/b', description: '' }], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);

        // Second ask returns null (the script is exhausted), so it cancels.
        expect(result.outcome).toBe('cancelled_name');
        expect(rec.payloads).toEqual([]);
        expect(rec.errors).toEqual(["a project name cannot contain '/'"]);
    });
});

describe('what the create posts, beyond the folder', () => {
    test('a claude project sends the name as the session label', async () => {
        // The server turns a non-empty label into `--name <label>`, so
        // the row title and the name claude calls itself are one string.
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(rec.payloads[0]!.label).toBe('My App');
        expect(rec.payloads[0]!.project_name).toBe('My App');
    });

    test('a shell console sends NO label, because --name is claude-only', async () => {
        const rec = recorder();
        await createConsoleFlow(rec.host, enT(), null);
        expect('label' in rec.payloads[0]!).toBe(false);
        expect(rec.payloads[0]!.agent_type).toBe('shell');
    });

    test('a terminal command id travels, and only the id', async () => {
        const rec = recorder();
        await createConsoleFlow(rec.host, enT(), 'cmd-7');
        expect(rec.payloads[0]!.terminal_command_id).toBe('cmd-7');
    });

    test('the xterm grid rides along so the pane is born the right size', async () => {
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(rec.payloads[0]!.cols).toBe(132);
        expect(rec.payloads[0]!.rows).toBe(40);
    });

    test('agent_type precedence: an explicit family beats the picker', () => {
        expect(agentTypeFor('openclaw', { wrapperId: 'claude-chrome' })).toBe('openclaw');
        expect(agentTypeFor(null, { wrapperId: 'claude-chrome' })).toBe('claude-chrome');
        expect(agentTypeFor(null, { agentType: 'codex' })).toBe('codex');
        // Omitted entirely for plain claude, so the SERVER's own fallback
        // chain still runs. A key present with a null value is not the
        // same thing as an absent key.
        expect(agentTypeFor(null, {})).toBe(null);
        expect('agent_type' in buildCreatePayload('a', '/p', null, {}, {})).toBe(false);
    });

    test('a model is posted only when the picker chose one', () => {
        expect(buildCreatePayload('a', '/p', null, { model: 'm/1' }, {}).model).toBe('m/1');
        expect('model' in buildCreatePayload('a', '/p', null, {}, {})).toBe(false);
    });
});

describe('what happens after the session lands', () => {
    test('the project row is written and the tree is refreshed', async () => {
        const rec = recorder();
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        await createProjectFlow(rec.host, m.openers, enT(), null);

        const kinds = rec.calls.map(([kind]) => kind);
        expect(kinds).toContain('createProject');
        expect(kinds).toContain('reloadProjects');
        expect(kinds).toContain('announceSessionCreated');
        // The row's path is the one the SERVER reported, not the one the
        // client composed.
        const row = rec.calls.find(([kind]) => kind === 'createProject')?.[1] as {
            path: string;
        };
        expect(row.path).toBe('/Users/me/Development/My App');
    });

    test('an existing project row is not a failed create', async () => {
        const rec = recorder({
            createProject: async () => {
                throw new Error('project already exists');
            },
        });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(result.outcome).toBe('created');
        expect(rec.errors).toEqual([]);
    });

    test('a failed repaint is not a failed create either', async () => {
        const rec = recorder({
            reloadProjects: async () => {
                throw new Error('listing unavailable');
            },
        });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(result.outcome).toBe('created');
        expect(rec.errors).toEqual([]);
    });

    test('"already running" detaches and retries rather than refusing', async () => {
        const rec = recorder({
            createSession: async () => {
                throw new Error('a session is already running');
            },
        });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), 'openclaw');
        expect(result.outcome).toBe('detached_and_retried');
        expect(rec.calls).toContainEqual(['detachAndCreateNew', 'openclaw']);
        expect(rec.errors).toEqual([]);
    });

    test('any other failure is reported as a sentence', async () => {
        const rec = recorder({
            createSession: async () => {
                throw new Error('disk is full');
            },
        });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        const result = await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(result.outcome).toBe('failed');
        expect(rec.errors).toEqual(['failed to create session: disk is full']);
    });

    test('an error with no message still says something', async () => {
        const rec = recorder({
            createSession: async () => {
                throw new Error('');
            },
        });
        const m = modals({ name: [GOOD_NAME], folder: GOOD_FOLDER });
        await createProjectFlow(rec.host, m.openers, enT(), null);
        expect(rec.errors[0]).toBe('failed to create session: the server could not be reached');
    });
});
