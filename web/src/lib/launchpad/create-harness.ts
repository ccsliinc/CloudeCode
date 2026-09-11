/**
 * One recorder for every flow test in slice 6.
 *
 * WHY A SHARED HARNESS. Four test files drive the same seam - the
 * `CreateHost` and the five modal openers - and a per-file copy is four
 * chances for one of them to record something slightly different, at
 * which point a difference between two tests is a difference between two
 * fixtures and nobody can tell. The tree harness in `tree-harness.ts`
 * exists for the same reason and this follows it.
 *
 * IT ANSWERS WHAT A TEST SCRIPTS AND RECORDS WHAT WAS ASKED. Nothing
 * here decides anything: every default is the boring success, and a test
 * that cares overrides exactly the member it cares about. That is what
 * makes an assertion about ORDER meaningful - the order is the flow's,
 * not the harness's.
 */
import { createI18n } from '../../../../client/js/i18n/runtime.js';
import type { CreateHost, CreatePayload, CreatedSession, ProviderChoice } from './create-host';
import type { ModalOpeners } from './modals';
import type { ChoiceOptions, ClonedProject, EditResult, FolderChoice } from './modal-types';

/** A real translator over the shipped en catalog. */
export function enT(): (key: string, params?: Record<string, unknown> | null) => string {
    const i18n = createI18n({ locale: 'en' }) as {
        t(key: string, params?: Record<string, unknown> | null): string;
    };
    return (key, params) => i18n.t(key, params);
}

/** Everything a run of the flow did, in the order it did it. */
export interface Recorder {
    host: CreateHost;
    calls: Array<[string, unknown]>;
    payloads: CreatePayload[];
    errors: string[];
}

/** Build a host that records and answers with what a test scripted. */
export function recorder(overrides: Partial<CreateHost> = {}): Recorder {
    const calls: Array<[string, unknown]> = [];
    const payloads: CreatePayload[] = [];
    const errors: string[] = [];
    const base: CreateHost = {
        chooseProvider: async () => {
            calls.push(['chooseProvider', null]);
            return {} as ProviderChoice;
        },
        createSession: async (payload) => {
            calls.push(['createSession', payload]);
            payloads.push(payload);
            return { working_dir: '/Users/me/Development/My App' } as CreatedSession;
        },
        createProject: async (row) => {
            calls.push(['createProject', row]);
            return row;
        },
        updateProject: async (name, fields) => {
            calls.push(['updateProject', { name, fields }]);
            return null;
        },
        archiveProject: async (name) => {
            calls.push(['archiveProject', name]);
            return null;
        },
        unarchiveProject: async (name) => {
            calls.push(['unarchiveProject', name]);
            return null;
        },
        cloneProject: async (payload) => {
            calls.push(['cloneProject', payload]);
            return { name: 'repo', path: '/p/repo' } as ClonedProject;
        },
        defaultParentDir: async () => '/Users/me/Development',
        folderPicker: () => null,
        reloadProjects: async () => {
            calls.push(['reloadProjects', null]);
            return null;
        },
        projects: () => [],
        projectsListingOk: () => true,
        presenceFor: () => null,
        selectProject: async (project, choice) => {
            calls.push(['selectProject', { project, choice }]);
            return null;
        },
        detachAndCreateNew: (agentType) => {
            calls.push(['detachAndCreateNew', agentType]);
            return null;
        },
        terminalDims: () => ({ cols: 132, rows: 40 }),
        updateStatus: (message) => calls.push(['updateStatus', message]),
        showError: (message) => {
            calls.push(['showError', message]);
            errors.push(message);
        },
        confirm: async () => {
            calls.push(['confirm', null]);
            return true;
        },
        announceSessionCreated: (session) => calls.push(['announceSessionCreated', session]),
    };
    return { host: { ...base, ...overrides }, calls, payloads, errors };
}

/** Scripted modal answers, plus a record of what each was asked. */
export function modals(script: {
    name?: Array<{ name: string; description: string } | null>;
    folder?: FolderChoice | null;
    choice?: string | null;
    edit?: EditResult | null;
    clone?: ClonedProject | null;
}): { openers: ModalOpeners; asked: Array<[string, unknown]> } {
    const asked: Array<[string, unknown]> = [];
    const names = [...(script.name ?? [])];
    return {
        asked,
        openers: {
            async name(request) {
                asked.push(['name', request]);
                return names.length ? (names.shift() ?? null) : null;
            },
            async folder(request) {
                asked.push(['folder', { name: request.name }]);
                return script.folder ?? null;
            },
            async choice(options: ChoiceOptions) {
                asked.push(['choice', options]);
                return script.choice ?? null;
            },
            async edit(request) {
                asked.push(['edit', request]);
                return script.edit ?? null;
            },
            async clone(request) {
                asked.push(['clone', request]);
                return script.clone ?? null;
            },
        },
    };
}


/** A name that passes every rule, for the cases that are not about names. */
export const GOOD_NAME = { name: 'My App', description: 'a thing' };

/** A folder choice that passes, for the cases that are not about folders. */
export const GOOD_FOLDER: FolderChoice = {
    parent: '/Users/me/Development',
    path: '/Users/me/Development/My App',
};
