/**
 * THE TREE, MOUNTED, DRIVEN THROUGH THE STORE.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS ONE FILE NEEDS A DOCUMENT, when the config's default is a
 * Node environment and its comment asks for a reason. Every other test
 * in this tree is about a string a pure function returned. This one is
 * about what a mounted Svelte component DOES: which handler a click
 * reaches, whether an ended row is clickable at all, whether a fold
 * survives a data refresh. None of that is observable without a real
 * `mount()` and a real element, and asserting it against a rendered
 * string would be asserting the markup instead of the behaviour - which
 * is the failure mode the legacy node tests already had.
 *
 * Ported from `tests/test_project_session_tree.node.mjs`,
 * `tests/test_ended_sessions_visibility.node.mjs`,
 * `tests/test_project_presence_render.node.mjs`,
 * `tests/test_project_archive_render.node.mjs` and the gutter case from
 * `tests/test_project_gutter_alignment.node.mjs`.
 *
 * THE ASSERTIONS ARE BEHAVIOURAL WHEREVER A BEHAVIOUR EXISTS. Where the
 * only observable is a class or an attribute - the gutter, the presence
 * badge - it is asserted as the CONTRACT WITH THE STYLESHEET it is,
 * named in the test, rather than as an incidental string.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { instanceKey } from '../sessions/attribution';
import { treeCollapse } from './tree-collapse.svelte';
import type { SessionRecord } from '../sessions/types';
import {
    mountTree,
    settle,
    type MountedTree,
    type TreeFixture,
} from './tree-harness';

let tree: MountedTree | null = null;

function record(patch: Partial<SessionRecord>): SessionRecord {
    return {
        id: 1,
        tmux_name: 'cloude_a',
        tmux_created_epoch: 100,
        lifecycle: 'running',
        project_id: 1,
        project_attribution: 'project',
        archived_at: null,
        parent_session_id: null,
        ...patch,
    };
}

function byInstance(...records: SessionRecord[]): Map<string, SessionRecord> {
    const map = new Map<string, SessionRecord>();
    for (const rec of records) {
        map.set(instanceKey(rec.tmux_name || '', rec.tmux_created_epoch || 0), rec);
    }
    return map;
}

/** One project holding one live session, the ordinary healthy case. */
function oneProjectOneSession() {
    return {
        projects: [{ name: 'api', id: 1, path: '/p', root: '/p' }],
        runningSessions: [{ name: 'cloude_a', created_at_epoch: 100, status: 'idle' }],
        sessionAttributionByInstance: byInstance(record({})),
    };
}

beforeEach(() => {
    if (tree) {
        tree.destroy();
        tree = null;
    }
});

describe('a session renders inside its project node, not beside it', () => {
    test('the child row sits INSIDE the project node element', () => {
        tree = mountTree(oneProjectOneSession());
        const node = tree.container.querySelector(
            '.project-node[data-project-name="api"]',
        ) as HTMLElement;
        expect(node).toBeTruthy();
        expect(node.querySelectorAll('.project-session-row')).toHaveLength(1);
        // And nowhere else in the tree.
        expect(tree.container.querySelectorAll('.project-session-row')).toHaveLength(1);
    });

    test('the node exposes its child count and starts EXPANDED', () => {
        tree = mountTree(oneProjectOneSession());
        const toggle = tree.container.querySelector('.project-node__toggle') as HTMLElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.querySelector('.project-node__count')?.textContent).toBe('1');
    });

    test('a project with no children and no description has NO toggle', () => {
        tree = mountTree({ projects: [{ name: 'api', id: 1 }] });
        expect(tree.container.querySelector('.project-node__toggle')).toBeNull();
        expect(tree.container.querySelector('.project-node__sessions')).toBeNull();
    });

    test('THE GUTTER IS THERE EVEN WITH NO TOGGLE, which is the grid contract', () => {
        // `.project-node__row` is a grid whose first column is a fixed
        // `--project-gutter`. A foldless project has to stay two grid
        // children wide or its card slides left and the column stops
        // lining up with every other row.
        tree = mountTree({ projects: [{ name: 'api', id: 1 }] });
        const row = tree.container.querySelector('.project-node__row') as HTMLElement;
        expect(row.children).toHaveLength(2);
        expect(row.children[0]?.className).toBe('project-node__gutter');
        expect(row.children[1]?.classList.contains('project-item')).toBe(true);
    });

    test('and the toggle, when present, lives INSIDE that gutter', () => {
        tree = mountTree(oneProjectOneSession());
        const gutter = tree.container.querySelector('.project-node__gutter') as HTMLElement;
        expect(gutter.querySelector('.project-node__toggle')).toBeTruthy();
    });
});

describe('clicking a row reaches the right handler', () => {
    test('an INACTIVE live row asks to attach by tmux name', async () => {
        tree = mountTree(oneProjectOneSession());
        (tree.container.querySelector('.project-session-row') as HTMLElement).click();
        await settle();
        expect(tree.host.calls).toEqual([{ method: 'attachSession', arg: 'cloude_a' }]);
    });

    test('an ACTIVE row re-enters the terminal it left, by session id', async () => {
        const fixture: TreeFixture = oneProjectOneSession();
        fixture.runningSessions = [{
            name: 'cloude_a', created_at_epoch: 100, status: 'idle',
            is_active: true, session_id: 'ses_1',
        }];
        tree = mountTree(fixture);
        (tree.container.querySelector('.project-session-row') as HTMLElement).click();
        await settle();
        expect(tree.host.calls).toEqual([{ method: 'returnToActive', arg: 'ses_1' }]);
    });

    test('a healthy project row opens the project', async () => {
        tree = mountTree(oneProjectOneSession());
        (tree.container.querySelector('.project-item') as HTMLElement).click();
        await settle();
        expect(tree.host.calls.map((c) => c.method)).toEqual(['selectProject']);
    });

    test('a MISSING project row REFUSES OUT LOUD rather than doing nothing', async () => {
        // It used to be a bare `return`: no message, no log line, no
        // request, so the row presented as a button that does nothing.
        tree = mountTree({
            projects: [{ name: 'api', id: 1, path: '/p', root: '/p' }],
            presence: new Map([['/p', { root: '/p', presence: 'missing' }]]),
        });
        (tree.container.querySelector('.project-item') as HTMLElement).click();
        await settle();
        expect(tree.host.calls.map((c) => c.method)).toEqual(['explainRefused']);
    });

    test('an UNREACHABLE project refuses too, and shows the server reason', async () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1, path: '/p', root: '/p' }],
            presence: new Map([['/p', {
                root: '/p', presence: 'unreachable', presence_detail: 'EACCES',
            }]]),
        });
        expect(tree.container.querySelector('.project-presence-badge')?.textContent)
            .toContain('EACCES');
        (tree.container.querySelector('.project-item') as HTMLElement).click();
        await settle();
        expect(tree.host.calls.map((c) => c.method)).toEqual(['explainRefused']);
    });

    test('a refused row exposes NO usable edit control', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1, path: '/p', root: '/p' }],
            presence: new Map([['/p', { root: '/p', presence: 'missing' }]]),
        });
        const edit = tree.container.querySelector('.project-edit-btn') as HTMLButtonElement;
        expect(edit.disabled).toBe(true);
    });

    test('ARCHIVE IS NEVER DISABLED BY PRESENCE, and that is deliberate', async () => {
        // A project whose folder has gone missing is precisely one a user
        // wants to archive; refusing that would leave the row permanently
        // stuck on the screen it is trying to leave.
        tree = mountTree({
            projects: [{ name: 'api', id: 1, path: '/p', root: '/p' }],
            presence: new Map([['/p', { root: '/p', presence: 'missing' }]]),
        });
        const btn = tree.container.querySelector('.project-archive-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        btn.click();
        await settle();
        expect(tree.host.calls).toEqual([{ method: 'archiveProject', arg: 'api' }]);
    });

    test('an ARCHIVED project offers restore instead, and does not open on that click',
        async () => {
            tree = mountTree({
                projects: [{ name: 'api', id: 1, archived_at: 'yes' }],
            });
            const btn = tree.container.querySelector('.project-archive-btn') as HTMLElement;
            expect(btn.getAttribute('data-archived')).toBe('1');
            btn.click();
            await settle();
            // ONLY the unarchive. The row's own click handler must not
            // also fire: `stopPropagation` is what stops an archive from
            // navigating into the project it just retired.
            expect(tree.host.calls).toEqual([{ method: 'unarchiveProject', arg: 'api' }]);
        });

    test('the edit button does not open the project either', async () => {
        tree = mountTree(oneProjectOneSession());
        (tree.container.querySelector('.project-edit-btn') as HTMLElement).click();
        await settle();
        expect(tree.host.calls.map((c) => c.method)).toEqual(['editProject']);
    });
});

describe('an ENDED row is not a live one, and cannot be attached', () => {
    const ended = {
        projects: [{ name: 'api', id: 1 }],
        sessionRecords: [record({ lifecycle: 'stopped', session_uuid: 'u1' })],
    };

    test('it is marked ENDED and carries the stopped dot', () => {
        tree = mountTree(ended);
        const row = tree.container.querySelector('.project-session-row--ended') as HTMLElement;
        expect(row).toBeTruthy();
        expect(row.querySelector('.badge-ended')?.textContent?.trim()).toBe('ended');
        expect(row.querySelector('.status-dot--stopped')).toBeTruthy();
    });

    test('IT OFFERS NO ATTACH AFFORDANCE, and clicking it calls nothing', async () => {
        // The legacy row needed an explicit `if (row.dataset.ended)`
        // early return, because the listener was DELEGATED on the
        // container and matched the class, not the role. Here the handler
        // is on the element and this element has none, so there is
        // nothing to guard and nothing that can regress.
        tree = mountTree(ended);
        const row = tree.container.querySelector('.project-session-row--ended') as HTMLElement;
        expect(row.getAttribute('role')).toBeNull();
        expect(row.getAttribute('tabindex')).toBeNull();
        row.click();
        await settle();
        expect(tree.host.calls).toEqual([]);
    });

    test('a LIVE row DOES offer one', () => {
        tree = mountTree(oneProjectOneSession());
        const row = tree.container.querySelector('.project-session-row') as HTMLElement;
        expect(row.getAttribute('role')).toBe('button');
        expect(row.getAttribute('tabindex')).toBe('0');
    });

    test('and the keyboard half works, which the legacy row never had', async () => {
        tree = mountTree(oneProjectOneSession());
        const row = tree.container.querySelector('.project-session-row') as HTMLElement;
        row.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true,
        }));
        await settle();
        expect(tree.host.calls).toEqual([{ method: 'attachSession', arg: 'cloude_a' }]);
    });

    test('it offers restart and archive, keyed on the session UUID', async () => {
        tree = mountTree(ended);
        const restart = tree.container.querySelector('.ended-session-restart') as HTMLElement;
        const archive = tree.container.querySelector('.ended-session-delete') as HTMLElement;
        restart.click();
        await settle();
        archive.click();
        await settle();
        expect(tree.host.calls[0]?.method).toBe('restartEnded');
        expect((tree.host.calls[0]?.arg as { session_uuid: string }).session_uuid).toBe('u1');
        // Archive is keyed on the uuid, NEVER on the tmux name: tmux
        // reuses names and two rows can differ only by creation epoch.
        expect(tree.host.calls[1]).toEqual({ method: 'archiveRecord', arg: 'u1' });
    });

    test('ended rows sort BELOW live ones inside one project node', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{ name: 'cloude_live', created_at_epoch: 1, status: 'idle' }],
            sessionAttributionByInstance: byInstance(
                record({ tmux_name: 'cloude_live', tmux_created_epoch: 1 }),
            ),
            sessionRecords: [
                record({ tmux_name: 'cloude_live', tmux_created_epoch: 1 }),
                record({ id: 2, tmux_name: 'cloude_dead', lifecycle: 'stopped' }),
            ],
        });
        const names = Array.from(
            tree.container.querySelectorAll('.project-session-row__name'),
        ).map((el) => el.textContent);
        expect(names).toEqual(['live', 'dead']);
    });

    test('the project count INCLUDES ended rows, so the header cannot lie', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            sessionRecords: [
                record({ lifecycle: 'stopped' }),
                record({ id: 2, tmux_name: 'cloude_b', lifecycle: 'dead' }),
            ],
        });
        expect(tree.container.querySelector('.project-node__count')?.textContent).toBe('2');
    });

    test('an UNREADABLE records fetch adds no ended rows AND says so', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{ name: 'cloude_a', created_at_epoch: 100, status: 'idle' }],
            sessionRecords: [record({ lifecycle: 'stopped' })],
            sessionAttributionListingOk: false,
            sessionAttributionListingDetail: 'the server answered HTTP 500',
        });
        expect(tree.container.querySelectorAll('.project-session-row--ended')).toHaveLength(0);
        const attention = tree.container.querySelector('.project-node--attention');
        expect(attention).toBeTruthy();
        expect(attention?.textContent).toContain('the server answered HTTP 500');
    });
});

describe('the LED gets the same four signals on every surface', () => {
    test('an UNREAD idle row paints the green done dot', () => {
        // ONE FIELD, READ THE SAME WAY EVERYWHERE. `unread` rides the
        // WRAPPER of a `/sessions/list` row, and the tree row hands it to
        // the same component the flat running list hands it to. A surface
        // that dropped it would paint an unread session grey and nothing
        // would look broken.
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{
                name: 'cloude_a', created_at_epoch: 100,
                status: 'idle', unread: true,
            }],
            sessionAttributionByInstance: byInstance(record({})),
        });
        const dot = tree.container.querySelector(
            '.project-session-row .status-dot',
        ) as HTMLElement;
        expect(dot.getAttribute('data-inner')).toBe('done');
    });

    test('the SAME status READ paints the grey idle dot instead', () => {
        // The two differ ONLY in the flag, which is what makes this a
        // test of the flag rather than of the status vocabulary.
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{
                name: 'cloude_a', created_at_epoch: 100,
                status: 'idle', unread: false,
            }],
            sessionAttributionByInstance: byInstance(record({})),
        });
        const dot = tree.container.querySelector(
            '.project-session-row .status-dot',
        ) as HTMLElement;
        expect(dot.getAttribute('data-inner')).toBe('idle');
    });

    test('the startup gate reaches the dot too', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{
                name: 'cloude_a', created_at_epoch: 100,
                status: 'idle', startup_gate: 'awaiting_startup_prompt',
            }],
            sessionAttributionByInstance: byInstance(record({})),
        });
        const dot = tree.container.querySelector(
            '.project-session-row .status-dot',
        ) as HTMLElement;
        expect(dot.getAttribute('data-inner')).toBe('waiting-input');
    });

    test('and NO component builds the dot markup itself', () => {
        // The class comes off `StatusLed`, which is the only caller of
        // `ledStateFor`. See ./theme-discipline.test.ts for the source
        // scan that keeps it the only one.
        tree = mountTree(oneProjectOneSession());
        const dot = tree.container.querySelector(
            '.project-session-row .status-dot',
        ) as HTMLElement;
        expect(dot.classList.contains('status-led')).toBe(true);
        expect(dot.getAttribute('data-outer')).not.toBeNull();
    });
});

describe('user text reaches the DOM as text, never as markup', () => {
    test('a project description carrying a tag renders it verbatim', () => {
        // Svelte's own interpolation is what replaced the legacy
        // `_escapeHtml` calls. A description is user-supplied text and
        // there is no `{@html}` anywhere in this slice.
        tree = mountTree({
            projects: [{ name: 'api', id: 1, description: '<img src=x onerror=1>' }],
        });
        const desc = tree.container.querySelector('.project-description') as HTMLElement;
        expect(desc.textContent).toBe('<img src=x onerror=1>');
        expect(desc.querySelector('img')).toBeNull();
    });

    test('a project NAME carrying a tag renders it verbatim too', () => {
        tree = mountTree({ projects: [{ name: '<b>api</b>', id: 1 }] });
        const el = tree.container.querySelector('.project-name') as HTMLElement;
        expect(el.querySelector('b')).toBeNull();
        expect(el.textContent).toContain('<b>api</b>');
    });

    test('an ended row TITLE carrying a tag survives to the restart call as data', async () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            sessionRecords: [record({
                lifecycle: 'stopped', session_uuid: 'u1', title: '<b>x</b>',
            })],
        });
        (tree.container.querySelector('.ended-session-restart') as HTMLElement).click();
        await settle();
        expect((tree.host.calls[0]?.arg as { title: string }).title).toBe('<b>x</b>');
    });
});

describe('the NEEDS ATTENTION group is inert and never green', () => {
    test('an unattributed session is NAMED, not silently dropped', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{ name: 'cloude_x', created_at_epoch: 1, status: 'idle' }],
        });
        const row = tree.container.querySelector(
            '.project-session-row--attention',
        ) as HTMLElement;
        expect(row.textContent).toContain('x');
        expect(row.textContent).toContain('no stored attribution for this session');
    });

    test('it offers no action and no fold', async () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{ name: 'cloude_x', created_at_epoch: 1, status: 'idle' }],
        });
        const group = tree.container.querySelector('.project-node--attention') as HTMLElement;
        expect(group.querySelector('.project-node__toggle')).toBeNull();
        expect(group.querySelector('button')).toBeNull();
        (group.querySelector('.project-session-row--attention') as HTMLElement).click();
        await settle();
        expect(tree.host.calls).toEqual([]);
    });

    test('an unattributed session is NOWHERE ELSE in the tree', () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1 }],
            runningSessions: [{ name: 'cloude_x', created_at_epoch: 1, status: 'idle' }],
        });
        const all = tree.container.querySelectorAll('.project-session-row');
        expect(all).toHaveLength(1);
        expect(all[0]?.classList.contains('project-session-row--attention')).toBe(true);
    });
});

describe('the empty state, and what it draws alongside', () => {
    test('no projects renders the empty copy', () => {
        tree = mountTree({ projects: [] });
        expect(tree.container.querySelector('.launchpad-empty')?.textContent)
            .toContain('no projects yet');
    });

    test('THE AUTHORITY BANNER IS DRAWN IN THE EMPTY CASE TOO', () => {
        // An empty list is exactly when the user most needs to know
        // whether the datastore answered.
        tree = mountTree({ projects: [], authority: null });
        expect(tree.container.querySelector('.project-authority-banner')).toBeTruthy();
        expect(tree.container.querySelector('.launchpad-empty')).toBeTruthy();
    });

    test('a healthy authority draws NO banner in either case', () => {
        tree = mountTree({ projects: [] });
        expect(tree.container.querySelector('.project-authority-banner')).toBeNull();
    });

    test('no state can draw TWO banners at once', () => {
        for (const authority of [
            null,
            { mode: 'db', degraded: false },
            { mode: 'db_unreadable', degraded: true, message: 'm', writable: false },
        ]) {
            if (tree) tree.destroy();
            tree = mountTree({ projects: [{ name: 'a', id: 1 }], authority });
            expect(
                tree.container.querySelectorAll('.project-authority-banner').length,
            ).toBeLessThanOrEqual(1);
        }
    });
});

describe('the archived dimension, on the row and in the notice', () => {
    test('an archived row carries its own class AND its badge', () => {
        tree = mountTree({ projects: [{ name: 'a', id: 1, archived_at: 'yes' }] });
        expect(tree.container.querySelector('.project-node--archived')).toBeTruthy();
        expect(tree.container.querySelector('.project-item--archived')).toBeTruthy();
        expect(tree.container.querySelector('.project-archived-badge')?.textContent?.trim())
            .toBe('archived');
    });

    test('a list with nothing archived draws no badge at all', () => {
        tree = mountTree({ projects: [{ name: 'a', id: 1 }] });
        expect(tree.container.querySelector('.project-archived-badge')).toBeNull();
    });

    test('toggle OFF renders NO notice: nothing was asked', () => {
        tree = mountTree({ projects: [{ name: 'a', id: 1 }], archivedFetchOk: null });
        expect(tree.container.querySelector('.project-archived-notice')).toBeNull();
    });

    test('a measured zero and a failed fetch render DIFFERENT notices', () => {
        tree = mountTree({ projects: [{ name: 'a', id: 1 }], archivedFetchOk: true });
        const measured = tree.container.querySelector('.project-archived-notice')?.textContent;
        tree.destroy();
        tree = mountTree({ projects: [{ name: 'a', id: 1 }], archivedFetchOk: false });
        const failed = tree.container.querySelector('.project-archived-notice')?.textContent;
        expect(measured).toContain('0');
        expect(failed).toContain('CANNOT BE DETERMINED');
        expect(measured).not.toBe(failed);
    });

    test('the show-archived control is painted and RE-FETCHES when clicked', async () => {
        tree = mountTree({ projects: [{ name: 'a', id: 1 }] });
        // SETTLE FIRST. The control is written from an `$effect`, which
        // Svelte flushes in a microtask - so reading it in the same turn
        // as the mount reads an empty recorder and looks like a control
        // that was never painted.
        await settle();
        expect(tree.control.toggleStates[0] as unknown).toEqual({
            on: false, title: 'show archived projects',
        });
        tree.control.click();
        await settle();
        expect(tree.host.calls).toEqual([{ method: 'reloadProjects', arg: null }]);
        expect(tree.control.toggleStates.at(-1)).toEqual({
            on: true, title: 'hide archived projects',
        });
    });
});

describe('the fold, and the state that outlives a data refresh', () => {
    test('clicking a toggle folds the node', async () => {
        tree = mountTree(oneProjectOneSession());
        const toggle = tree.container.querySelector('.project-node__toggle') as HTMLElement;
        toggle.click();
        await settle();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        const sessions = tree.container.querySelector('.project-node__sessions') as HTMLElement;
        expect(sessions.style.display).toBe('none');
    });

    test('A FOLD SURVIVES A FULL DATA REFRESH, which is the whole contract', async () => {
        // The legacy comment said it "survives the next renderProjectList()
        // call - e.g. the 5s running-sessions poller repainting the tree
        // does not snap a collapsed project back open". There is no
        // repaint now, but the fold can still be LOST by anything that
        // rebuilds this state from the data. Twelve simulated ticks.
        tree = mountTree(oneProjectOneSession());
        const toggle = tree.container.querySelector('.project-node__toggle') as HTMLElement;
        toggle.click();
        await settle();
        // ASSERTED BEFORE THE LOOP AS WELL AS AFTER IT, AND THE MUTATION
        // RUN IS WHY. Mutating the `Set` in place instead of reassigning
        // it leaves `isCollapsed` answering correctly while nothing
        // repaints - so the fold appears LATE, on the next data change,
        // which is the legacy defect verbatim ("the sessions only
        // appeared to fold later, when the 5s poller happened to
        // re-render"). Without this line the loop below would apply the
        // stale fold on its first tick and the test would pass under
        // exactly the bug it exists to catch.
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        for (let i = 0; i < 12; i++) {
            const { applyFixture } = await import('./tree-harness');
            applyFixture(oneProjectOneSession());
            await settle();
        }
        const after = tree.container.querySelector('.project-node__toggle') as HTMLElement;
        expect(after.getAttribute('aria-expanded')).toBe('false');
        expect(treeCollapse.isCollapsed('project:api')).toBe(true);
    });

    test('a collapsed node also sheds its description', async () => {
        tree = mountTree({
            projects: [{ name: 'api', id: 1, description: 'the notes' }],
        });
        const toggle = tree.container.querySelector('.project-node__toggle') as HTMLElement;
        toggle.click();
        await settle();
        const desc = tree.container.querySelector('.project-description') as HTMLElement;
        expect(desc.style.display).toBe('none');
    });

    test('the no-project group folds on its own synthetic key', async () => {
        tree = mountTree({
            projects: [],
            runningSessions: [{ name: 'cloude_a', created_at_epoch: 100, status: 'idle' }],
            sessionAttributionByInstance: byInstance(
                record({ project_attribution: 'none', project_id: null }),
            ),
        });
        const toggle = tree.container.querySelector(
            '.project-node--virtual .project-node__toggle',
        ) as HTMLElement;
        expect(toggle.getAttribute('data-node-key')).toBe('__no_project__');
        toggle.click();
        await settle();
        expect(treeCollapse.isCollapsed('__no_project__')).toBe(true);
    });
});
