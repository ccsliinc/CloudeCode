/**
 * THE FIVE MODALS, MOUNTED, CLICKED AND CLOSED.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE NEEDS A DOCUMENT. Everything else in this slice is about
 * an order or a string. This is about what a mounted overlay DOES: that
 * escape resolves null, that a disabled row refuses a click, that the
 * create button is unavailable until there is a folder to create in, and
 * that `openModal` leaves nothing behind. None of that is observable
 * without a real `mount()`.
 *
 * PORTED FROM the `_showChoiceModal` markup case in
 * tests/test_home_screen_mechanics.node.mjs, trimmed out of that file in
 * the same commit. That case asserted `overlay.innerHTML.includes(...)`
 * against a mini-DOM that does not parse innerHTML into a tree; these
 * query real elements, which is the assertion it was reaching for.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { openModal, openModalCount } from '../modal';
import ChoiceModal from './ChoiceModal.svelte';
import CloneModal from './CloneModal.svelte';
import ProjectFolderModal from './ProjectFolderModal.svelte';
import ProjectNameModal from './ProjectNameModal.svelte';
import type { ChoiceItem, ClonedProject, FolderChoice, ProjectDetails } from './modal-types';

/** Let Svelte's effects and any queued microtasks run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** The overlay currently in the document, or null. */
function overlay(): HTMLElement | null {
    return document.querySelector('.modal-overlay');
}

/** Press a key on the overlay, the way a user in the dialog would. */
function press(key: string, target: Element | null = overlay()): void {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('openModal puts one overlay up and takes it down again', () => {
    test('a resolved modal removes its overlay and its host', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'pick one',
            items: [{ key: 'a', label: 'the a' }] as ChoiceItem[],
        });
        await settle();
        expect(overlay()).not.toBe(null);
        expect(openModalCount()).toBe(1);

        (overlay()!.querySelector('[data-choice-index="0"]') as HTMLElement).click();
        expect(await promise).toBe('a');
        expect(overlay()).toBe(null);
        expect(document.body.children).toHaveLength(0);
        expect(openModalCount()).toBe(0);
    });

    test('escape resolves null, and a cancel is always null', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'pick one',
            items: [{ key: 'a', label: 'the a' }] as ChoiceItem[],
        });
        await settle();
        press('Escape', document.body);
        expect(await promise).toBe(null);
        expect(overlay()).toBe(null);
    });

    test('a click on the overlay itself cancels; a click inside does not', async () => {
        const promise = openModal<ProjectDetails, Record<string, unknown>>(
            ProjectNameModal as never,
            { title: 'name this project', confirmLabel: 'create session' },
        );
        await settle();
        // Inside the content: nothing happens.
        (overlay()!.querySelector('.modal-content') as HTMLElement).click();
        await settle();
        expect(overlay()).not.toBe(null);
        // On the overlay: cancelled.
        overlay()!.click();
        expect(await promise).toBe(null);
    });
});

describe('the one-of-N picker', () => {
    const ITEMS: ChoiceItem[] = [
        { key: 'empty', label: 'start empty', sub: 'a fresh working folder' },
        { key: 'clone', label: 'clone from github', sub: 'from an existing repository' },
    ];

    test('it renders one row per item, with its second line', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'new claude project',
            items: ITEMS,
        });
        await settle();
        const rows = overlay()!.querySelectorAll('.folder-picker-item');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.textContent).toContain('start empty');
        expect(rows[0]!.textContent).toContain('a fresh working folder');
        expect(rows[1]!.textContent).toContain('clone from github');
        // The first selectable row starts active.
        expect(rows[0]!.classList.contains('folder-picker-item-active')).toBe(true);
        press('Escape', document.body);
        await promise;
    });

    test('an empty list draws the caller sentence and NO rows', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'new session',
            items: [],
            emptyMessage: 'nothing here',
            emptyKind: 'unknown',
        });
        await settle();
        const empty = overlay()!.querySelector('.folder-picker-empty');
        expect(empty).not.toBe(null);
        expect(empty!.classList.contains('folder-picker-empty--unknown')).toBe(true);
        expect(empty!.textContent).toContain('nothing here');
        expect(overlay()!.querySelectorAll('.folder-picker-item')).toHaveLength(0);
        // And the only button says ok rather than cancel: there is
        // nothing to cancel out of.
        expect(overlay()!.querySelector('[data-choice-cancel]')!.textContent!.trim()).toBe('ok');
        press('Escape', document.body);
        await promise;
    });

    test('a disabled row is VISIBLE, carries its reason, and refuses a click', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'new session in which project',
            items: [
                { key: 'gone', label: 'gone', disabled: true, reason: 'folder MISSING' },
                { key: 'good', label: 'good', sub: '/good' },
            ] as ChoiceItem[],
        });
        await settle();
        const rows = overlay()!.querySelectorAll('.folder-picker-item');
        expect(rows[0]!.classList.contains('folder-picker-item-disabled')).toBe(true);
        expect(rows[0]!.getAttribute('aria-disabled')).toBe('true');
        expect(rows[0]!.textContent).toContain('folder MISSING');
        (rows[0] as HTMLElement).click();
        await settle();
        expect(overlay()).not.toBe(null);
        // The first SELECTABLE row is the active one, skipping the
        // refused one above it.
        expect(rows[1]!.classList.contains('folder-picker-item-active')).toBe(true);
        (rows[1] as HTMLElement).click();
        expect(await promise).toBe('good');
    });

    test('arrow keys walk only the selectable rows, and enter chooses', async () => {
        const promise = openModal<string, Record<string, unknown>>(ChoiceModal as never, {
            title: 'pick',
            items: [
                { key: 'a', label: 'a' },
                { key: 'b', label: 'b', disabled: true },
                { key: 'c', label: 'c' },
            ] as ChoiceItem[],
        });
        await settle();
        press('ArrowDown', document.body);
        await settle();
        press('Enter', document.body);
        expect(await promise).toBe('c');
    });
});

describe('the name step collects and refuses nothing', () => {
    test('a prefilled name comes back when confirmed', async () => {
        const promise = openModal<ProjectDetails, Record<string, unknown>>(
            ProjectNameModal as never,
            { title: 'name this project', confirmLabel: 'create session', defaultName: 'a/b' },
        );
        await settle();
        // THE REFUSED TEXT IS STILL THERE. That is what makes a refusal
        // an edit rather than a retype.
        const input = overlay()!.querySelector('#modal-project-name') as HTMLInputElement;
        expect(input.value).toBe('a/b');
        (overlay()!.querySelector('#modal-confirm') as HTMLElement).click();
        expect(await promise).toEqual({ name: 'a/b', description: '' });
    });

    test('an empty name does not resolve, it refocuses', async () => {
        let settled = false;
        const promise = openModal<ProjectDetails, Record<string, unknown>>(
            ProjectNameModal as never,
            { title: 'name this project', confirmLabel: 'create session' },
        );
        void promise.then(() => {
            settled = true;
        });
        await settle();
        (overlay()!.querySelector('#modal-confirm') as HTMLElement).click();
        await settle();
        expect(settled).toBe(false);
        expect(overlay()).not.toBe(null);
        press('Escape');
        expect(await promise).toBe(null);
    });

    test('the folder hint is shown only when there is a folder to report', async () => {
        const promise = openModal<ProjectDetails, Record<string, unknown>>(
            ProjectNameModal as never,
            {
                title: 'add project',
                confirmLabel: 'open project',
                pathHint: '/Users/me/code/api',
            },
        );
        await settle();
        expect(overlay()!.querySelector('.folder-picker-path')!.textContent).toContain(
            '/Users/me/code/api',
        );
        press('Escape');
        await promise;
    });
});

describe('the folder step asks, previews, and refuses', () => {
    test('it fills the parent from the server and previews the full path', async () => {
        const promise = openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            {
                name: 'My App',
                defaultParent: async () => '/Users/me/Development',
                openPicker: null,
            },
        );
        await settle();
        const parent = overlay()!.querySelector('#project-parent-input') as HTMLInputElement;
        expect(parent.value).toBe('/Users/me/Development');
        expect(overlay()!.querySelector('#project-path-preview')!.textContent!.trim()).toBe(
            '/Users/me/Development/My App',
        );
        const confirm = overlay()!.querySelector('#project-folder-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(false);
        confirm.click();
        expect(await promise).toEqual({
            parent: '/Users/me/Development',
            path: '/Users/me/Development/My App',
        });
    });

    test('with no default it stays EMPTY and refuses, rather than guessing', async () => {
        // CANNOT DETERMINE is not "there is no default". A guessed path
        // is one the user would accept without reading.
        const promise = openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            { name: 'My App', defaultParent: async () => null, openPicker: null },
        );
        await settle();
        const parent = overlay()!.querySelector('#project-parent-input') as HTMLInputElement;
        expect(parent.value).toBe('');
        expect(parent.placeholder).toBe('type or browse to a folder');
        const confirm = overlay()!.querySelector('#project-folder-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        expect(overlay()!.querySelector('#project-path-status')!.textContent).toContain(
            'choose a folder to create the project in',
        );
        press('Escape');
        expect(await promise).toBe(null);
    });

    test('an illegal name is refused here too, with the sentence on screen', async () => {
        const promise = openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            {
                name: 'a/b',
                defaultParent: async () => '/Users/me/Development',
                openPicker: null,
            },
        );
        await settle();
        const status = overlay()!.querySelector('#project-path-status')!;
        expect(status.textContent).toContain("a project name cannot contain '/'");
        expect(status.classList.contains('folder-picker-status--error')).toBe(true);
        expect(
            (overlay()!.querySelector('#project-folder-confirm') as HTMLButtonElement).disabled,
        ).toBe(true);
        press('Escape');
        await promise;
    });

    test('browse takes the picker answer, and a missing picker says so', async () => {
        const withPicker = openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            {
                name: 'My App',
                defaultParent: async () => null,
                openPicker: async () => '/picked/here',
            },
        );
        await settle();
        (overlay()!.querySelector('#project-folder-browse') as HTMLElement).click();
        await settle();
        expect(
            (overlay()!.querySelector('#project-parent-input') as HTMLInputElement).value,
        ).toBe('/picked/here');
        press('Escape');
        await withPicker;

        const noPicker = openModal<FolderChoice, Record<string, unknown>>(
            ProjectFolderModal as never,
            { name: 'My App', defaultParent: async () => null, openPicker: null },
        );
        await settle();
        (overlay()!.querySelector('#project-folder-browse') as HTMLElement).click();
        await settle();
        expect(overlay()!.querySelector('#project-path-status')!.textContent).toContain(
            'the folder picker is unavailable',
        );
        press('Escape');
        await noPicker;
    });
});

describe('the clone form collects a parent directory', () => {
    test('the parent field is there, prefilled, and travels with the request', async () => {
        let sent: Record<string, string> | null = null;
        const promise = openModal<ClonedProject, Record<string, unknown>>(CloneModal as never, {
            clone: async (payload: Record<string, string>) => {
                sent = payload;
                return { name: 'repo', path: '/p/repo' };
            },
        });
        await settle();
        const parent = overlay()!.querySelector('#modal-clone-parent') as HTMLInputElement;
        expect(parent).not.toBe(null);
        expect(parent.value).toBe('~/projects');

        const url = overlay()!.querySelector('#modal-clone-url') as HTMLInputElement;
        url.value = 'owner/repo';
        url.dispatchEvent(new Event('input', { bubbles: true }));
        parent.value = '/Users/me/code';
        parent.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        (overlay()!.querySelector('#modal-clone-confirm') as HTMLElement).click();

        expect(await promise).toEqual({ name: 'repo', path: '/p/repo' });
        expect(sent).toEqual({
            repoUrl: 'owner/repo',
            parentDir: '/Users/me/code',
            description: undefined,
        });
    });

    test('an empty url is refused before anything is sent', async () => {
        let called = false;
        const promise = openModal<ClonedProject, Record<string, unknown>>(CloneModal as never, {
            clone: async () => {
                called = true;
                return { name: 'repo', path: '/p/repo' };
            },
        });
        await settle();
        (overlay()!.querySelector('#modal-clone-confirm') as HTMLElement).click();
        await settle();
        expect(called).toBe(false);
        expect(overlay()!.querySelector('#modal-clone-status')!.textContent).toContain(
            'paste a github url first',
        );
        press('Escape');
        expect(await promise).toBe(null);
    });

    test('a failure stays open, keeps what was typed, and says why', async () => {
        const promise = openModal<ClonedProject, Record<string, unknown>>(CloneModal as never, {
            clone: async () => {
                throw new Error('HTTP 409: a folder already exists');
            },
        });
        await settle();
        const url = overlay()!.querySelector('#modal-clone-url') as HTMLInputElement;
        url.value = 'owner/repo';
        url.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        (overlay()!.querySelector('#modal-clone-confirm') as HTMLElement).click();
        await settle();

        expect(overlay()).not.toBe(null);
        expect((overlay()!.querySelector('#modal-clone-url') as HTMLInputElement).value).toBe(
            'owner/repo',
        );
        expect(overlay()!.querySelector('#modal-clone-status')!.textContent).toContain(
            'folder or project name already exists',
        );
        // And the form is usable again.
        expect(
            (overlay()!.querySelector('#modal-clone-confirm') as HTMLButtonElement).disabled,
        ).toBe(false);
        press('Escape');
        expect(await promise).toBe(null);
    });

    test('WHILE IT IS IN FLIGHT nothing dismisses it', async () => {
        let release: (value: ClonedProject) => void = () => {};
        const promise = openModal<ClonedProject, Record<string, unknown>>(CloneModal as never, {
            clone: () =>
                new Promise<ClonedProject>((resolve) => {
                    release = resolve;
                }),
        });
        await settle();
        const url = overlay()!.querySelector('#modal-clone-url') as HTMLInputElement;
        url.value = 'owner/repo';
        url.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        (overlay()!.querySelector('#modal-clone-confirm') as HTMLElement).click();
        await settle();

        // Dismissing the form does not cancel the clone the server is
        // already running, so it refuses to be dismissed.
        press('Escape');
        overlay()!.click();
        await settle();
        expect(overlay()).not.toBe(null);
        expect(
            (overlay()!.querySelector('#modal-clone-cancel') as HTMLButtonElement).disabled,
        ).toBe(true);

        release({ name: 'repo', path: '/p/repo' });
        expect(await promise).toEqual({ name: 'repo', path: '/p/repo' });
    });
});
