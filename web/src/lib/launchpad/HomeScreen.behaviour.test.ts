/**
 * @vitest-environment jsdom
 *
 * What the MOUNTED home screen shell does, which is the half a source
 * scan cannot see.
 *
 * jsdom BECAUSE THE CLAIMS ARE ABOUT A DOCUMENT. Four ids have to be
 * present AND re-parentable, the three section disclosures have to read
 * a persisted map and write it back, the "+" table has to dispatch, and
 * the shell has to paint ONCE. None of that is a string a function
 * returned.
 *
 * PORTED FROM SIX NODE FILES: `test_home_screen_mechanics`,
 * `test_home_screen_polish`, `test_home_bottom_bar`,
 * `test_home_header_consolidation`, `test_header_help_and_toggle` and
 * `test_newfab_placement`. Between them they held roughly 2,200 lines,
 * most of it regex over a 6,500-line template string in a file that no
 * longer exists. The assertions that were about BEHAVIOUR are here; the
 * ones that were about the shape of that source are gone with it, which
 * is the point of the migration rather than a loss.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';

import HomeScreen from './HomeScreen.svelte';
import {
    HOME_ANCHOR_IDS,
    STATUS_ANCHOR_ID,
    STATUS_LABEL_ID,
    homeBarIsReparentable,
    missingHomeAnchors,
} from './home-anchors';
import { COLLAPSED_KEY, SECTIONS, collapsedState, setSectionCollapsed } from './home-sections';
import { LAUNCHPAD_PANELS } from './panels';
import { isNewFabOpen } from './new-fab';
import { setLocale } from '../i18n/index.svelte';
import { PSEUDO_LOCALE, isPseudo } from '../../../../client/js/i18n/pseudo.js';

let handle: Record<string, unknown> | null = null;

/**
 * Put the shell on a document that looks like `client/index.html` does.
 *
 * Description: the screen div, the header help button and the FAB
 *   backdrop all live in that file rather than in the component, so a
 *   mount without them is not the shape the browser has.
 * Inputs: fabActions. Output: the container the shell was mounted into.
 * Example: const screen = mountShell({});
 */
function mountShell(fabActions: Record<string, () => unknown> = {}): HTMLElement {
    document.body.innerHTML = `
        <span id="statusText" data-status="connected"></span>
        <button id="launchpad-help-btn" aria-expanded="false"></button>
        <div class="new-fab__backdrop" id="new-fab-backdrop" hidden></div>
        <div id="launchpad-screen" class="screen"></div>
    `;
    const screen = document.getElementById('launchpad-screen') as HTMLElement;
    handle = mount(HomeScreen as never, {
        target: screen,
        props: { fabActions } as never,
    }) as Record<string, unknown>;
    return screen;
}

/**
 * Let the mount's effects run.
 *
 * Description: Svelte 5 runs `onMount` in an effect flush, not
 *   synchronously inside `mount()`, so every assertion about WIRING -
 *   the disclosures, the FAB, the help control - has to wait for one.
 *   A macrotask rather than `tick()`, because the four panels also
 *   start their own fetches in that same flush and a microtask would
 *   interleave with them.
 * Inputs: none. Output: Promise<void>.
 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Whether a mutation happened inside one of the four panel containers. */
function insideAPanel(node: Node | null): boolean {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return LAUNCHPAD_PANELS.some((panel) => {
        const container = document.getElementById(panel.id);
        return !!container && !!el && (container === el || container.contains(el));
    });
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    if (handle) unmount(handle, { outro: false });
    handle = null;
    document.body.innerHTML = '';
    setLocale('en');
});

describe('the four load-bearing ids', () => {
    test('all of them are present once the shell is up', () => {
        mountShell();
        expect(missingHomeAnchors(document)).toEqual([]);
    });

    test('MUTATION TARGET: removing one is caught, and named', () => {
        // The mutation for this slice is deleting an anchor from the
        // template. This asserts the CHECK can fail, so a green run
        // above is evidence rather than a tautology.
        mountShell();
        document.getElementById(STATUS_LABEL_ID)?.remove();
        expect(missingHomeAnchors(document)).toEqual([STATUS_LABEL_ID]);
        expect(missingHomeAnchors(null)).toEqual([...HOME_ANCHOR_IDS]);
    });

    test('#statusText can still be MOVED into the status anchor', () => {
        // `App._placeStatusLight` does exactly this, by id, and the one
        // node is moved rather than copied so the string keeps one
        // author. A conditional wrapper would drop it on the next paint.
        mountShell();
        const anchor = document.getElementById(STATUS_ANCHOR_ID) as HTMLElement;
        const dot = document.getElementById('statusText') as HTMLElement;
        anchor.insertBefore(dot, anchor.firstChild);
        expect(dot.parentElement?.id).toBe(STATUS_ANCHOR_ID);
        expect(anchor.querySelector(`#${STATUS_LABEL_ID}`)).not.toBe(null);
    });

    test('and the audio toggle can still be inserted as its SIBLING', () => {
        // `GlobalAudioToggle.place` inserts BEFORE the anchor into the
        // anchor's own parent, so `.home-bar` is load-bearing too.
        mountShell();
        expect(homeBarIsReparentable(document)).toBe(true);
        const anchor = document.getElementById(STATUS_ANCHOR_ID) as HTMLElement;
        const btn = document.createElement('button');
        anchor.parentNode?.insertBefore(btn, anchor);
        expect(btn.nextElementSibling?.id).toBe(STATUS_ANCHOR_ID);
        expect(btn.parentElement?.classList.contains('home-bar')).toBe(true);
    });

    test('the shell does NOT render #launchpad-screen itself', () => {
        // It is the MOUNT TARGET and lives in client/index.html, because
        // app.js toggles `.active` on it from outside this tree.
        const screen = mountShell();
        expect(screen.querySelector('#launchpad-screen')).toBe(null);
        screen.classList.add('active');
        expect(screen.classList.contains('active')).toBe(true);
    });
});

describe('the shell paints once', () => {
    test('mounting it causes no further mutation on its own', async () => {
        // THE REPAINT LESSON, as a measurement. Slices 4 and 5 both
        // found a reactive subscription turning every intermediate
        // assignment into a repaint. This shell reads no store and
        // derives nothing, so after the mount settles nothing moves.
        const screen = mountShell();
        await settle();
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((list) => records.push(...list));
        observer.observe(screen, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });
        await new Promise((r) => setTimeout(r, 30));
        observer.disconnect();
        // PANEL CHURN IS SUBTRACTED, and saying so is the honest form of
        // this claim: the four panels inside the shell own their own
        // subscriptions and repaint when their data moves, which is what
        // they are for. What is measured here is the SHELL - its own
        // markup, its headings and its bar - and that must not move at
        // all once it is up, because it reads nothing.
        const shellOnly = records.filter((record) => !insideAPanel(record.target));
        expect(shellOnly).toEqual([]);
    });
});

describe('the panels', () => {
    test('every panel container the ordered list names is in the markup', () => {
        // `panels.ts` mounts BY ID, so a renamed container is a panel
        // that silently never appears.
        mountShell();
        for (const panel of LAUNCHPAD_PANELS) {
            expect(document.getElementById(panel.id), panel.id).not.toBe(null);
        }
    });

    test('and the attribution prompt is FIRST, because it is a question', () => {
        mountShell();
        const container = document.querySelector('.launchpad-container') as HTMLElement;
        expect(container.firstElementChild?.id).toBe('attribution-prompt');
    });
});

describe('the section disclosures', () => {
    test('a collapsed section is restored from the LEGACY storage key', async () => {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ 'recent-sessions': true }));
        mountShell();
        await settle();
        const toggle = document.getElementById('recent-sessions-toggle') as HTMLElement;
        const list = document.getElementById('recent-sessions-list') as HTMLElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(list.style.display).toBe('none');
    });

    test('clicking one persists it, under that same key', async () => {
        mountShell();
        await settle();
        (document.getElementById('projects-section-toggle') as HTMLElement).click();
        expect(collapsedState()['recent-projects']).toBe(true);
        expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) as string)).toEqual({
            'recent-projects': true,
        });
    });

    test('all three headings are bound, RECENT included', async () => {
        // `#recent-sessions-toggle` rendered as a real button with
        // aria-expanded for months before anything listened to it, so
        // clicking it did literally nothing.
        mountShell();
        await settle();
        for (const section of SECTIONS) {
            const toggle = document.getElementById(section.toggleId) as HTMLElement;
            const content = document.getElementById(section.contentId) as HTMLElement;
            toggle.click();
            expect(content.style.display, section.id).toBe('none');
            toggle.click();
            expect(content.style.display, section.id).toBe('');
        }
    });

    test('a collapse uses style.display and NEVER the hidden attribute', async () => {
        // `.project-list` sets `display: flex` in the stylesheet, and an
        // author rule beats the UA's `[hidden] {display:none}` - so
        // `hidden` no-ops the collapse for exactly one of the three.
        mountShell();
        await settle();
        const list = document.getElementById('project-list') as HTMLElement;
        (document.getElementById('projects-section-toggle') as HTMLElement).click();
        expect(list.style.display).toBe('none');
        expect(list.hasAttribute('hidden')).toBe(false);
    });

    test('unreadable storage is an EMPTY map, not a crash', () => {
        localStorage.setItem(COLLAPSED_KEY, 'not json');
        expect(collapsedState()).toEqual({});
        expect(setSectionCollapsed('running-sessions', true)).toBe(true);
    });
});

describe('the "+" speed dial', () => {
    test('an item dispatches through the table it was given', async () => {
        const ran: string[] = [];
        mountShell({ 'new-console': () => ran.push('console') });
        await settle();
        (document.getElementById('new-fab-trigger') as HTMLElement).click();
        expect(isNewFabOpen()).toBe(true);
        (document.querySelector('[data-action="new-console"]') as HTMLElement).click();
        // DEFERRED ONE TICK on purpose, so the close animation gets a
        // frame before any modal opens over it - which is why this is
        // not true the instant the click returns.
        expect(ran).toEqual([]);
        await settle();
        expect(ran).toEqual(['console']);
        expect(isNewFabOpen()).toBe(false);
    });

    test('the five actions in the markup are exactly the five that route', async () => {
        // A sixth `data-action` with no handler closes the menu and
        // warns; the table and the markup agreeing is what stops that.
        mountShell();
        await settle();
        const actions = [...document.querySelectorAll('.new-fab__item')].map((el) =>
            el.getAttribute('data-action'),
        );
        expect(actions).toEqual([
            'new-claude-project',
            'new-session',
            'connect-openclaw',
            'connect-hermes',
            'new-console',
        ]);
        // NO 'open-folder'. Opening a folder on disk is the third choice
        // inside "new claude project", not a peer of it.
        expect(actions).not.toContain('open-folder');
    });

    test('escape closes it, and so does a click outside', async () => {
        mountShell();
        await settle();
        const open = () => (document.getElementById('new-fab-trigger') as HTMLElement).click();
        open();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(isNewFabOpen()).toBe(false);
        open();
        document.body.click();
        expect(isNewFabOpen()).toBe(false);
    });

    test('the create control is OUTSIDE every section, in its own row', async () => {
        // It used to be a child of the running-sessions title row, which
        // is display:none while the user has zero sessions - so on a
        // fresh install the only control that creates anything measured
        // 0x0 and a new user could not make a first session at all.
        mountShell();
        await settle();
        const fab = document.getElementById('new-fab') as HTMLElement;
        expect(fab.closest('#launchpad-actions')).not.toBe(null);
        expect(fab.closest('.launchpad-section')).toBe(null);
    });
});

describe('the header help control', () => {
    test('the button toggles the disclosure, which is a native details', async () => {
        mountShell();
        await settle();
        const btn = document.getElementById('launchpad-help-btn') as HTMLElement;
        const details = document.querySelector(
            '#launchpad-screen .adopt-disclosure',
        ) as HTMLDetailsElement;
        expect(details.tagName).toBe('DETAILS');
        btn.click();
        expect(details.open).toBe(true);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        btn.click();
        expect(details.open).toBe(false);
    });

    test('the in-pane summary is still there, because it makes it a disclosure', () => {
        mountShell();
        expect(document.querySelector('.adopt-disclosure > summary')).not.toBe(null);
    });

    test('and the help lives at the TOP of the pane, not in a section', () => {
        // The running-sessions section is display:none until a session
        // exists, so the one explanation of how to adopt one was hidden
        // from exactly the user who had not started one yet.
        mountShell();
        const details = document.querySelector('.adopt-disclosure') as HTMLElement;
        expect(details.closest('.launchpad-section')).toBe(null);
        expect(details.parentElement?.classList.contains('launchpad-container')).toBe(true);
    });
});

describe('there is no standalone title block and no archive row', () => {
    test('the launcher title lives in the header, not in this pane', () => {
        mountShell();
        expect(document.querySelector('.launchpad-header')).toBe(null);
        expect(document.querySelector('.launchpad-prompt')).toBe(null);
    });

    test('and the server-management section is gone with its one control', () => {
        mountShell();
        expect(document.getElementById('server-management-section')).toBe(null);
        expect(document.getElementById('server-controls-btn')).not.toBe(null);
    });
});

describe('every user-visible string comes from the catalog', () => {
    /**
     * Every text a human reads off the mounted shell.
     *
     * Description: text nodes with visible characters, plus the
     *   attributes that are read aloud or hovered. `<code>` and `<pre>`
     *   are EXCLUDED, and that is the one carve-out: a shell command is
     *   typed into a terminal and has to work byte for byte, so it is
     *   data beside the catalog rather than a message in it.
     * Inputs: root. Output: the strings.
     */
    function visibleStrings(root: HTMLElement): string[] {
        const out: string[] = [];
        const blocks = new Set<Element>();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const text = (node.textContent || '').trim();
            const parent = node.parentElement;
            node = walker.nextNode();
            if (!text || !parent) continue;
            // A command is data, not copy. A chevron is decoration and
            // says so with aria-hidden.
            if (parent.closest('code, pre')) continue;
            if (parent.closest('[aria-hidden="true"]')) continue;
            // GROUPED BY PARAGRAPH, and that is not a convenience. The
            // help prose puts ONE catalog message through the marker
            // splitter, which emits several text nodes - so a per-node
            // check would see the halves of a balanced span and call
            // each of them unbalanced. The message is the paragraph.
            const block = parent.closest('p');
            if (block) blocks.add(block);
            else out.push(text);
        }
        for (const block of blocks) out.push((block.textContent || '').trim());
        for (const el of root.querySelectorAll('[aria-label], [title]')) {
            const label = el.getAttribute('aria-label');
            const title = el.getAttribute('title');
            if (label) out.push(label);
            if (title) out.push(title);
        }
        return out;
    }

    test('so the whole shell renders bracketed in the pseudo locale', async () => {
        setLocale(PSEUDO_LOCALE);
        const screen = mountShell();
        await settle();
        const strings = visibleStrings(screen);
        // A shell with nothing in it would pass vacuously.
        expect(strings.length).toBeGreaterThan(25);
        for (const value of strings) {
            expect(isPseudo(value), value).toBe(true);
        }
    });

    test('NEGATIVE CONTROL: in en the same strings are NOT bracketed', async () => {
        // Without this the assertion above would pass against an
        // `isPseudo` that always answered true.
        setLocale('en');
        const screen = mountShell();
        await settle();
        const strings = visibleStrings(screen);
        expect(strings.some((value) => isPseudo(value))).toBe(false);
        expect(strings).toContain('running sessions');
    });

    test('and a command is deliberately NOT translated', async () => {
        setLocale(PSEUDO_LOCALE);
        const screen = mountShell();
        await settle();
        const commands = [...screen.querySelectorAll('pre code')].map((el) => el.textContent);
        expect(commands.some((c) => (c || '').includes('tmux -L cloude'))).toBe(true);
        for (const command of commands) expect(isPseudo(command || '')).toBe(false);
    });
});
