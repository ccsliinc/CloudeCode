/**
 * The two menus that start something, and the clone that one of them
 * routes into.
 *
 * PORTED FROM the six `startSessionInExistingProject` and
 * `_showChoiceModal` cases in tests/test_home_screen_mechanics.node.mjs,
 * trimmed out of that file in the same commit. Those cases drove the real
 * legacy singleton with a stubbed `_showChoiceModal`; these drive the
 * real flow with a stubbed opener, which is the same test one layer in.
 *
 * THE THREE OUTCOMES ARE THE POINT. "you have no projects" and "I could
 * not read the project list" are different answers, and reporting the
 * second as the first is a claim nothing measured. The rule shows up
 * three times in this app and this is one of them.
 */
import { describe, expect, test } from 'vitest';

import { GOOD_FOLDER, GOOD_NAME, enT, modals, recorder } from './create-harness';
import {
    cloneFromGithubFlow,
    existingProjectItems,
    newProjectItems,
    startNewClaudeProject,
    startSessionInExistingProject,
} from './entry-flows';

const PROJECTS = [
    { name: 'good', path: '/good' },
    { name: 'gone', path: '/gone' },
    { name: 'unknown', path: '/unknown' },
];

const PRESENCE: Record<string, Record<string, unknown>> = {
    '/good': { presence: 'present' },
    '/gone': { presence: 'missing' },
    '/unknown': { presence: 'unreachable', presence_detail: 'volume asleep' },
};

describe('new claude project offers three starting points', () => {
    test('the three are start empty, clone, and an existing folder', () => {
        const items = newProjectItems(enT());
        expect(items.map((i) => i.key)).toEqual(['empty', 'clone', 'folder']);
        expect(items[0]!.label).toBe('start empty');
        expect(items[1]!.label).toBe('clone from github');
        expect(items[2]!.label).toBe('open an existing folder');
        // Every row says something about what it does; a bare label is
        // what made this a three-entry-point decision before it was one
        // flow.
        expect(items.every((i) => typeof i.sub === 'string' && i.sub.length > 0)).toBe(true);
    });

    test('choosing "start empty" runs the create flow, folder step and all', async () => {
        const rec = recorder();
        const m = modals({ choice: 'empty', name: [GOOD_NAME], folder: GOOD_FOLDER });
        expect(await startNewClaudeProject(rec.host, m.openers, enT())).toBe('empty');
        expect(m.asked.map(([kind]) => kind)).toEqual(['choice', 'name', 'folder']);
        expect(rec.payloads[0]!.project_parent_dir).toBe('/Users/me/Development');
    });

    test('choosing "clone" runs the clone flow and never the create flow', async () => {
        const rec = recorder();
        const m = modals({
            choice: 'clone',
            clone: { name: 'repo', path: '/p/repo' },
        });
        expect(await startNewClaudeProject(rec.host, m.openers, enT())).toBe('clone');
        expect(m.asked.map(([kind]) => kind)).toEqual(['choice', 'clone']);
        expect(rec.payloads).toEqual([]);
    });

    test('cancelling the menu starts nothing', async () => {
        const rec = recorder();
        const m = modals({ choice: null });
        expect(await startNewClaudeProject(rec.host, m.openers, enT())).toBe(null);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('createSession');
    });
});

describe('new session adds to a project and NEVER creates one', () => {
    test('with zero projects it says so, and launches nothing', async () => {
        const rec = recorder({ projects: () => [], projectsListingOk: () => true });
        const m = modals({ choice: null });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe('none');

        const asked = m.asked[0]![1] as { items: unknown[]; emptyMessage: string };
        expect(asked.items).toHaveLength(0);
        expect(asked.emptyMessage).toMatch(/no claude projects yet/i);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('selectProject');
    });

    test('a FAILED fetch is never reported as "you have no projects"', async () => {
        const rec = recorder({ projects: () => [], projectsListingOk: () => false });
        const m = modals({ choice: null });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe(
            'cannot_determine',
        );

        const asked = m.asked[0]![1] as { emptyMessage: string; emptyKind: string };
        expect(asked.emptyMessage).toMatch(/CANNOT DETERMINE/);
        expect(asked.emptyKind).toBe('unknown');
        expect(asked.emptyMessage).not.toMatch(/no claude projects yet/i);
    });

    test('NEVER ASKED is not the same as FAILED, and still offers the list', async () => {
        // `null` is the third value: the list has not been read yet. It
        // is not a failure, so it does not get the refusal.
        const rec = recorder({ projects: () => PROJECTS, projectsListingOk: () => null });
        const m = modals({ choice: 'good' });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe('opened');
    });

    test('every project stays VISIBLE, including the broken ones', async () => {
        const rec = recorder({
            projects: () => PROJECTS,
            presenceFor: (p) => PRESENCE[String(p.path)] ?? null,
        });
        const m = modals({ choice: 'good' });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe('opened');

        const items = (m.asked[0]![1] as { items: Array<Record<string, unknown>> }).items;
        expect(items).toHaveLength(3);
        const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
        expect(byKey.good.disabled).toBe(false);
        expect(byKey.gone.disabled).toBe(true);
        expect(String(byKey.gone.reason)).toMatch(/MISSING/);
        expect(byKey.unknown.disabled).toBe(true);
        expect(String(byKey.unknown.reason)).toMatch(/volume asleep/);
        // And choosing a usable one opens it.
        const opened = rec.calls.find(([kind]) => kind === 'selectProject')?.[1] as {
            project: { name: string };
        };
        expect(opened.project.name).toBe('good');
    });

    test('an UNCHECKED presence is not a refusal', () => {
        // Not having looked is not evidence of absence.
        const items = existingProjectItems(
            [{ name: 'a', path: '/a' }],
            () => null,
            enT(),
        );
        expect(items[0]!.disabled).toBe(false);
        expect(items[0]!.reason).toBe(null);
    });

    test('cancelling the picker opens nothing', async () => {
        const rec = recorder({ projects: () => PROJECTS });
        const m = modals({ choice: null });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe('cancelled');
        expect(rec.calls.map(([kind]) => kind)).not.toContain('selectProject');
    });

    test('a chosen name that matches no project opens nothing', async () => {
        const rec = recorder({ projects: () => PROJECTS });
        const m = modals({ choice: 'ghost' });
        expect(await startSessionInExistingProject(rec.host, m.openers, enT())).toBe('cancelled');
        expect(rec.calls.map(([kind]) => kind)).not.toContain('selectProject');
    });
});

describe('clone gates on the provider before the form', () => {
    test('cancelling the provider never opens the form', async () => {
        const rec = recorder({ chooseProvider: async () => null });
        const m = modals({ clone: { name: 'repo', path: '/p/repo' } });
        expect(await cloneFromGithubFlow(rec.host, m.openers, enT())).toBe('cancelled_provider');
        expect(m.asked).toEqual([]);
        expect(rec.calls.map(([kind]) => kind)).not.toContain('cloneProject');
    });

    test('a successful clone refreshes the list and enters the session', async () => {
        const rec = recorder();
        const m = modals({ clone: { name: 'repo', path: '/p/repo', description: 'x' } });
        expect(await cloneFromGithubFlow(rec.host, m.openers, enT())).toBe('opened');

        const kinds = rec.calls.map(([kind]) => kind);
        expect(kinds).toContain('reloadProjects');
        const opened = rec.calls.find(([kind]) => kind === 'selectProject')?.[1] as {
            project: { name: string; path: string };
            choice: unknown;
        };
        expect(opened.project.path).toBe('/p/repo');
        // THE PROVIDER CHOICE IS PASSED THROUGH, so the user is not asked
        // a second time on the way into the session.
        expect(opened.choice).not.toBe(null);
    });

    test('cancelling the form leaves the project list alone', async () => {
        const rec = recorder();
        const m = modals({ clone: null });
        expect(await cloneFromGithubFlow(rec.host, m.openers, enT())).toBe('cancelled');
        expect(rec.calls.map(([kind]) => kind)).not.toContain('reloadProjects');
    });

    test('the form is handed the clone call, not the endpoint', async () => {
        // The MODAL owns the request because its six failures are things
        // the user can fix without losing what they typed.
        const rec = recorder();
        const m = modals({ clone: { name: 'repo', path: '/p/repo' } });
        await cloneFromGithubFlow(rec.host, m.openers, enT());
        const request = m.asked.find(([kind]) => kind === 'clone')?.[1] as {
            clone: (p: Record<string, string>) => Promise<unknown>;
        };
        expect(typeof request.clone).toBe('function');
        await request.clone({ repoUrl: 'owner/repo', parentDir: '~/projects' });
        expect(rec.calls).toContainEqual([
            'cloneProject',
            { repoUrl: 'owner/repo', parentDir: '~/projects' },
        ]);
    });
});
