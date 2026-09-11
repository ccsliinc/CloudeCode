/**
 * THE RUNNING-SESSIONS LIST, MOUNTED AND DRIVEN.
 *
 * @vitest-environment jsdom
 *
 * PORTED FROM SIX NODE FILES, and what they were really about is kept
 * rather than what they happened to assert. `test_running_sessions_unknown`
 * (the three-outcome listing), `test_session_label_rendering` and
 * `test_launchpad_rename_edits_label` (the label, the seed, the unchanged
 * guard), `test_session_ownership_badge`'s launchpad half,
 * `test_session_startup_gate`'s card half, `test_session_theme_tint`'s
 * "both surfaces splice both halves" half, `test_unread_led_one_field` and
 * `test_status_light_placement`'s dot half, plus
 * `test_session_row_actions` and `test_session_row_restart`'s launchpad
 * cases. Every one of those drove a string builder and read its markup
 * back; these mount the component.
 *
 * THE LIST IS DRIVEN THROUGH THE STORE, not through props, because the
 * subscription is the thing this slice replaced a repaint with. The
 * translator is the identity function, so an assertion names the CATALOG
 * KEY rather than a sentence - which is what stops this file having to be
 * rewritten every time the copy is edited, and what keeps it from being a
 * second place the copy is written down.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { RUNNING_SESSION_KEYS } from '../../../../client/js/labels/running-session.js';
import { settle } from './tree-harness';
import {
    applyRunningFixture,
    mountList,
    row,
    type MountedList,
} from './running-harness';

let list: MountedList | null = null;

afterEach(() => {
    if (list) {
        list.destroy();
        list = null;
    }
});

/** Every row element currently painted. */
function rows(mounted: MountedList): HTMLElement[] {
    return Array.from(
        mounted.container.querySelectorAll('.running-session-row'),
    ) as HTMLElement[];
}

/** The one row for a tmux name. */
function rowFor(mounted: MountedList, name: string): HTMLElement {
    const el = mounted.container.querySelector(
        `.running-session-row[data-name="${name}"]`,
    );
    if (!el) throw new Error(`no row painted for ${name}`);
    return el as HTMLElement;
}

describe('the three-outcome listing rule', () => {
    test('a listing that ran renders rows and NO attention block', () => {
        list = mountList({ rows: [row('cloude_api'), row('cloude_web')] });
        expect(rows(list)).toHaveLength(2);
        expect(list.container.querySelector('.running-sessions-attention'))
            .toBeNull();
    });

    test('a MEASURED zero hides the section and raises no alarm', async () => {
        list = mountList({ rows: [] });
        // THE CHROME IS WRITTEN BY AN EFFECT, which Svelte runs on a
        // microtask after the mount. Asserting before the settle would
        // read an empty recorder and look like a chrome that never wrote.
        await settle();
        expect(rows(list)).toHaveLength(0);
        expect(list.container.querySelector('.running-sessions-attention'))
            .toBeNull();
        expect(list.chrome.visibility.at(-1)).toBe(false);
    });

    test('an UNMEASURED zero SHOWS the section carrying the attention block', async () => {
        // THE FALSE GREEN THIS EXISTS TO REMOVE. Hiding the section here
        // would render "cannot determine" as "nothing to see" - a dead
        // tmux server painted as a healthy machine with zero sessions.
        list = mountList({
            rows: [],
            listing: {
                ok: false, reason: 'probe_error',
                detail: 'tmux did not answer', sources: ['attachable'],
            },
        });
        await settle();
        const block = list.container.querySelector('.running-sessions-attention');
        expect(block).not.toBeNull();
        expect(list.chrome.visibility.at(-1)).toBe(true);
    });

    test('the structured reason and detail both reach the rendered block', () => {
        list = mountList({
            rows: [],
            listing: {
                ok: false, reason: 'http_503',
                detail: 'the server answered HTTP 503', sources: ['live'],
            },
        });
        const block = list.container.querySelector(
            '.running-sessions-attention',
        ) as HTMLElement;
        expect(block.getAttribute('data-listing-reason')).toBe('http_503');
        expect(block.getAttribute('data-listing-ok')).toBe('0');
        const detail = block.querySelector(
            '.running-sessions-attention__detail',
        ) as HTMLElement;
        expect(detail.textContent).toContain('the server answered HTTP 503');
        expect(detail.textContent).toContain('live');
        expect(detail.textContent).toContain('http_503');
    });

    test('the attention block offers NO action control of any kind', () => {
        // An action against a session whose existence we cannot confirm
        // either does nothing or does something to the wrong thing.
        list = mountList({
            rows: [],
            listing: { ok: false, reason: 'x', detail: null, sources: [] },
        });
        const block = list.container.querySelector(
            '.running-sessions-attention',
        ) as HTMLElement;
        expect(block.querySelectorAll('button')).toHaveLength(0);
        expect(block.querySelectorAll('[role="button"]')).toHaveLength(0);
    });

    test('rows AND an attention block appear together when both apply', () => {
        // "any sessions listed below may be incomplete" is only true if
        // the rows are actually listed below it.
        list = mountList({
            rows: [row('cloude_api')],
            listing: { ok: false, reason: 'x', detail: null, sources: [] },
        });
        expect(rows(list)).toHaveLength(1);
        expect(list.container.querySelector('.running-sessions-attention'))
            .not.toBeNull();
    });
});

describe('the heading count never asserts a number it did not measure', () => {
    test('a listing that ran prints the count', async () => {
        list = mountList({ rows: [row('cloude_api'), row('cloude_web')] });
        await settle();
        expect(list.chrome.counts.at(-1)).toEqual({
            text: `${RUNNING_SESSION_KEYS.count} 2`, listingOk: true,
        });
    });

    test('a listing that did not run says so IN WORDS', async () => {
        list = mountList({
            rows: [row('cloude_api')],
            listing: { ok: false, reason: 'x', detail: null, sources: [] },
        });
        await settle();
        expect(list.chrome.counts.at(-1)).toEqual({
            text: RUNNING_SESSION_KEYS.countUnavailable, listingOk: false,
        });
    });
});

describe('the card names the session the way a human knows it', () => {
    test('a row with a label renders the LABEL, and data-name stays the handle', () => {
        list = mountList({
            rows: [row('cloude_Media_Compression', { label: 'Media Compression' })],
        });
        const el = rowFor(list, 'cloude_Media_Compression');
        expect(el.querySelector('.running-session-name')?.textContent)
            .toBe('Media Compression');
        expect(el.getAttribute('data-name')).toBe('cloude_Media_Compression');
    });

    test('a row with NO label still shows the derived tmux name', () => {
        list = mountList({ rows: [row('cloude_api', { label: null })] });
        expect(rowFor(list, 'cloude_api')
            .querySelector('.running-session-name')?.textContent).toBe('api');
    });

    test('an EMPTY label is treated as no label, not as a blank name', () => {
        list = mountList({ rows: [row('cloude_api', { label: '' })] });
        expect(rowFor(list, 'cloude_api')
            .querySelector('.running-session-name')?.textContent).toBe('api');
    });

    test('a label containing markup is TEXT, never markup', () => {
        // Svelte escapes text, so this is a property of the renderer
        // rather than of an escape helper - which is the point of having
        // deleted the escape helper.
        list = mountList({
            rows: [row('cloude_x', { label: '<img src=x onerror=1>' })],
        });
        const el = rowFor(list, 'cloude_x');
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.running-session-name')?.textContent)
            .toBe('<img src=x onerror=1>');
    });
});

describe('the ownership badge', () => {
    test('both flags render the badge their own way, off ONE field', () => {
        list = mountList({
            rows: [
                row('cloude_mine', { created_by_cloude: true }),
                row('cloude_theirs', { created_by_cloude: false }),
            ],
        });
        const mine = rowFor(list, 'cloude_mine');
        const theirs = rowFor(list, 'cloude_theirs');
        expect(mine.className).toContain('owned');
        expect(theirs.className).toContain('external');
        expect(mine.querySelector('.badge')?.className).toContain('badge-tmux');
        expect(theirs.querySelector('.badge')?.className)
            .toContain('badge-external');
        expect(mine.querySelector('.badge')?.textContent)
            .toBe(RUNNING_SESSION_KEYS.badgeTmux);
    });
});

describe('the status light', () => {
    test('the card paints a status dot, and it is the SHARED component', () => {
        // The class vocabulary is `StatusLed.ledStateFor`'s, and nothing
        // in this tree may inline dot markup. ./led-single-source.test.ts
        // is what holds that as a rule; this asserts it renders at all.
        list = mountList({ rows: [row('cloude_api', { status: 'working' })] });
        const dot = rowFor(list, 'cloude_api')
            .querySelector('.status-dot') as HTMLElement;
        expect(dot).not.toBeNull();
        expect(dot.className).toContain('status-dot--working');
    });

    test('UNREAD RIDES THE SAME FIELD the mark-unread control is pressed from', () => {
        list = mountList({ rows: [row('cloude_api', { unread: true })] });
        const el = rowFor(list, 'cloude_api');
        const dot = el.querySelector('.status-dot') as HTMLElement;
        const control = el.querySelector('[data-mark-unread]') as HTMLElement;
        expect(dot.getAttribute('data-outer')).toBe('unread');
        expect(control.getAttribute('data-unread-current')).toBe('true');
        expect(control.getAttribute('aria-pressed')).toBe('true');
    });

    test('the same status READ rings nothing, which is how unread is visible', () => {
        // The outer ring carries unread and it is a STILL green ring; the
        // ring's DEPARTURE is what makes a read session read as calmer.
        list = mountList({ rows: [row('cloude_api', { status: 'idle', unread: false })] });
        const dot = rowFor(list, 'cloude_api')
            .querySelector('.status-dot') as HTMLElement;
        expect(dot.getAttribute('data-outer')).not.toBe('unread');
    });

    test('a WORKING row rings active whatever the unread flag says', () => {
        // MOTION is the load-bearing distinction: a light that moves is a
        // session that is moving, and an unread flag must not be able to
        // stop it moving.
        for (const unread of [true, false]) {
            const mounted = mountList({
                rows: [row('cloude_api', { status: 'working', unread })],
            });
            const dot = mounted.container
                .querySelector('.status-dot') as HTMLElement;
            expect(dot.getAttribute('data-outer'), `unread ${unread}`).toBe('active');
            mounted.destroy();
        }
    });

    test('a DEAD pane is never painted as something to read', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'dead', unread: true })] });
        const dot = rowFor(list, 'cloude_api')
            .querySelector('.status-dot') as HTMLElement;
        expect(dot.getAttribute('data-inner')).not.toBe('done');
        expect(dot.getAttribute('data-outer')).not.toBe('active');
    });

    test('the dot carries a name, so the state is never colour-only', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'question' })] });
        const dot = rowFor(list, 'cloude_api')
            .querySelector('.status-dot') as HTMLElement;
        expect(dot.getAttribute('title')).toBeTruthy();
        expect(dot.getAttribute('aria-label')).toBeTruthy();
    });
});

describe('the startup gate badge', () => {
    test('a BLOCKED session renders the badge, with the sentence on it', () => {
        list = mountList({
            rows: [row('cloude_api', { startup_gate: 'awaiting_startup_prompt' })],
        });
        const badge = rowFor(list, 'cloude_api')
            .querySelector('.session-startup-gate') as HTMLElement;
        expect(badge).not.toBeNull();
        expect(badge.getAttribute('role')).toBe('img');
        expect(badge.getAttribute('title'))
            .toBe(RUNNING_SESSION_KEYS.startupGateReason);
        expect(badge.getAttribute('aria-label'))
            .toBe(RUNNING_SESSION_KEYS.startupGateReason);
        expect(badge.textContent).toBe(RUNNING_SESSION_KEYS.startupGateLabel);
    });

    test('ready and unknown both paint nothing', () => {
        list = mountList({
            rows: [
                row('cloude_ready', { startup_gate: 'ready' }),
                row('cloude_unknown', { startup_gate: 'unknown' }),
            ],
        });
        expect(list.container.querySelectorAll('.session-startup-gate'))
            .toHaveLength(0);
    });

    test('the field is read at the WRAPPER level, never inside .session', () => {
        // The single most repeated bug in this project. A row whose gate
        // sat one level down would paint nothing and look like a working
        // feature.
        const nested = row('cloude_api', { startup_gate: null });
        (nested as unknown as { session?: unknown }).session = {
            startup_gate: 'awaiting_startup_prompt',
        };
        list = mountList({ rows: [nested] });
        expect(list.container.querySelectorAll('.session-startup-gate'))
            .toHaveLength(0);
    });
});

describe('the per-session theme cue', () => {
    test('a themed row splices BOTH halves: the attribute and the swatch', () => {
        list = mountList(
            { rows: [row('cloude_api', { pinned_theme: 'dracula' })] },
            { themeColors: () => ({ accent: 'rgb(1, 2, 3)', label: 'Dracula' }) },
        );
        const el = rowFor(list, 'cloude_api');
        expect(el.getAttribute('data-session-theme')).toBe('dracula');
        expect(el.getAttribute('style')).toContain('--session-theme-accent');
        const swatch = el.querySelector('.session-theme-swatch') as HTMLElement;
        expect(swatch).not.toBeNull();
        expect(swatch.getAttribute('role')).toBe('img');
        // The manifest's own display name reaches the accessible name, so
        // it reads "session theme: Dracula" rather than repeating an id.
        expect(swatch.getAttribute('aria-label'))
            .toBe(`${RUNNING_SESSION_KEYS.themeSwatch} Dracula`);
    });

    test('an unthemed row carries neither half', () => {
        list = mountList({ rows: [row('cloude_api', { pinned_theme: null })] });
        const el = rowFor(list, 'cloude_api');
        expect(el.getAttribute('data-session-theme')).toBeNull();
        expect(el.querySelector('.session-theme-swatch')).toBeNull();
    });
});

describe('the agent pills', () => {
    test('a wrapper label renders a pill BESIDE the family pill, not instead', () => {
        list = mountList({
            rows: [row('cloude_api', {
                agent_wrapper_label: 'claude (chrome)',
                agent_family: 'claude',
                agent_family_source: 'wrapper',
            })],
        });
        const el = rowFor(list, 'cloude_api');
        expect(el.querySelector('.wrapper-pill')?.textContent)
            .toBe('claude (chrome)');
        expect(el.querySelector('.family-pill')).not.toBeNull();
    });

    test('a null wrapper label leaves the row and its family pill intact', () => {
        list = mountList({
            rows: [row('cloude_api', { agent_wrapper_label: null })],
        });
        const el = rowFor(list, 'cloude_api');
        expect(el.querySelector('.wrapper-pill')).toBeNull();
        expect(el.querySelector('.family-pill')).not.toBeNull();
    });

    test('a null family renders the literal unknown key, never a family name', () => {
        list = mountList({
            rows: [row('cloude_api', {
                agent_family: null, agent_family_source: null,
            })],
        });
        const pill = rowFor(list, 'cloude_api')
            .querySelector('.family-pill') as HTMLElement;
        expect(pill.className).toContain('family-pill--unknown');
        expect(pill.textContent).not.toContain('claude');
    });

    test('a GUESS and a FACT do not look the same', () => {
        list = mountList({
            rows: [
                row('cloude_fact', {
                    agent_family: 'codex', agent_family_source: 'wrapper',
                }),
                row('cloude_guess', {
                    agent_family: 'codex', agent_family_source: 'fingerprint',
                }),
            ],
        });
        expect(rowFor(list, 'cloude_fact').querySelector('.family-pill')?.className)
            .toContain('family-pill--fact');
        expect(rowFor(list, 'cloude_guess').querySelector('.family-pill')?.className)
            .toContain('family-pill--guess');
    });
});

describe('the destructive row controls', () => {
    test('A LIVE ROW OFFERS CLOSE AND RESTART, in that order', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'idle' })] });
        const ids = Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        ).map((el) => el.getAttribute('data-session-action'));
        expect(ids).toEqual(['close', 'restart']);
    });

    test('A DEAD ROW OFFERS RESTART AND REMOVE, and keeps remove', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'dead' })] });
        const ids = Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        ).map((el) => el.getAttribute('data-session-action'));
        expect(ids).toEqual(['restart', 'remove']);
    });

    test('UNKNOWN is never treated as dead: close alone, no remove', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'unknown' })] });
        const ids = Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        ).map((el) => el.getAttribute('data-session-action'));
        expect(ids).toEqual(['close']);
    });

    test('the X and the trash are never both on one row', () => {
        for (const status of ['idle', 'working', 'dead', 'unknown']) {
            const mounted = mountList({ rows: [row('cloude_api', { status })] });
            const ids = Array.from(
                mounted.container.querySelectorAll('[data-session-action]'),
            ).map((el) => el.getAttribute('data-session-action'));
            expect(
                ids.includes('close') && ids.includes('remove'),
                `status ${status} painted both`,
            ).toBe(false);
            mounted.destroy();
        }
    });

    test('every control is a real button with BOTH a title and an aria-label', () => {
        // The original bug: a control whose meaning was carried by its
        // glyph alone. And a `role="button"` span needs per-surface key
        // handling that a real button gets for free.
        list = mountList({ rows: [row('cloude_api', { status: 'dead' })] });
        for (const el of Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        )) {
            expect(el.tagName).toBe('BUTTON');
            expect(el.getAttribute('title')).toBeTruthy();
            expect(el.getAttribute('aria-label')).toBe(el.getAttribute('title'));
        }
    });

    test('restart and remove draw DIFFERENT glyphs', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'dead' })] });
        const paths = Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        ).map((el) => el.querySelector('svg')?.innerHTML);
        expect(paths[0]).toBeTruthy();
        expect(paths[1]).toBeTruthy();
        expect(paths[0]).not.toBe(paths[1]);
    });

    test('the tmux name rides on EVERY button, not just the first', () => {
        list = mountList({ rows: [row('cloude_api', { status: 'dead' })] });
        for (const el of Array.from(
            rowFor(list, 'cloude_api').querySelectorAll('[data-session-action]'),
        )) {
            expect(el.getAttribute('data-session-name')).toBe('cloude_api');
        }
    });

    test('clicking close asks for a confirmation before it destroys', async () => {
        list = mountList({ rows: [row('cloude_api', { status: 'idle' })] });
        const close = rowFor(list, 'cloude_api')
            .querySelector('[data-session-action="close"]') as HTMLElement;
        close.click();
        await settle();
        const methods = list.host.calls.map((c) => c.method);
        expect(methods).toContain('confirmAction');
        expect(methods.indexOf('confirmAction'))
            .toBeLessThan(methods.indexOf('destroyExternalSession'));
    });

    test('a declined confirmation destroys NOTHING', async () => {
        list = mountList(
            { rows: [row('cloude_api', { status: 'idle' })] },
            { confirm: false },
        );
        (rowFor(list, 'cloude_api')
            .querySelector('[data-session-action="close"]') as HTMLElement).click();
        await settle();
        const methods = list.host.calls.map((c) => c.method);
        expect(methods).not.toContain('destroySession');
        expect(methods).not.toContain('destroyExternalSession');
    });

    test('RESTART does not go through the shared confirm, it opens the picker', async () => {
        // It carries its OWN confirmation, which states the predicted
        // outcome and the chosen wrapper - neither of which a generic
        // dialog could say.
        list = mountList({ rows: [row('cloude_api', { status: 'idle' })] });
        (rowFor(list, 'cloude_api')
            .querySelector('[data-session-action="restart"]') as HTMLElement).click();
        await settle();
        const methods = list.host.calls.map((c) => c.method);
        expect(methods).toContain('openRestartPicker');
        expect(methods).not.toContain('confirmAction');
    });
});

describe('the mark-unread control comes from the plugin surface', () => {
    test('a contribution renders a control carrying its id and its label', () => {
        list = mountList({ rows: [row('cloude_api', { unread: false })] });
        const control = rowFor(list, 'cloude_api')
            .querySelector('[data-mark-unread]') as HTMLElement;
        expect(control.getAttribute('data-row-menu-item')).toBe('mark-unread');
        expect(control.getAttribute('title')).toBe('mark unread');
    });

    test('NO CONTRIBUTIONS MEANS NO CONTROL, which is what the flag off looks like', () => {
        // MUTATION 3's target. A hardcoded control would still paint here.
        list = mountList(
            { rows: [row('cloude_api')] },
            { cardActions: [] },
        );
        expect(rowFor(list, 'cloude_api').querySelector('[data-mark-unread]'))
            .toBeNull();
    });

    test('activating it runs the contribution BY ID, with the painted state', () => {
        list = mountList({ rows: [row('cloude_api', { unread: true })] });
        (rowFor(list, 'cloude_api')
            .querySelector('[data-mark-unread]') as HTMLElement).click();
        const call = list.host.calls.find((c) => c.method === 'runCardAction');
        expect(call?.args).toEqual(['mark-unread', 'cloude_api', true]);
    });

    test('a SECOND contribution paints a second control, with no code change', () => {
        // The surface is a list, not two hardcoded buttons - which is what
        // section 6 of the migration plan asks for.
        list = mountList(
            { rows: [row('cloude_api')] },
            {
                cardActions: [
                    { id: 'mark-unread', order: 200, label: 'a' },
                    { id: 'mute', order: 600, label: 'b' },
                ],
            },
        );
        expect(rowFor(list, 'cloude_api')
            .querySelectorAll('[data-row-menu-item]')).toHaveLength(2);
    });
});

describe('fork, and who gets offered it', () => {
    test('an owned row offers fork and an external one does not', () => {
        list = mountList({
            rows: [
                row('cloude_mine', { created_by_cloude: true }),
                row('cloude_theirs', { created_by_cloude: false }),
            ],
        });
        expect(rowFor(list, 'cloude_mine').querySelector('.running-session-fork'))
            .not.toBeNull();
        expect(rowFor(list, 'cloude_theirs').querySelector('.running-session-fork'))
            .toBeNull();
    });

    test('clicking fork asks for a fork and does NOT open the session', async () => {
        list = mountList({ rows: [row('cloude_api')] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-fork') as HTMLElement).click();
        await settle();
        const methods = list.host.calls.map((c) => c.method);
        expect(methods).toContain('forkSession');
        expect(methods).not.toContain('attachSession');
    });
});

describe('opening a session from the card', () => {
    test('an ACTIVE row re-enters the terminal it left', async () => {
        list = mountList({
            rows: [row('cloude_api', { is_active: true, session_id: 'ses_1' })],
        });
        rowFor(list, 'cloude_api').click();
        await settle();
        const call = list.host.calls.find((c) => c.method === 'returnToActive');
        expect(call?.args).toEqual(['ses_1']);
    });

    test('anything else is an open-or-adopt, by tmux name', async () => {
        list = mountList({ rows: [row('cloude_api', { is_active: false })] });
        rowFor(list, 'cloude_api').click();
        await settle();
        const call = list.host.calls.find((c) => c.method === 'attachSession');
        expect(call?.args).toEqual(['cloude_api']);
    });

    test('the row is keyboard operable, which the legacy row was not', async () => {
        list = mountList({ rows: [row('cloude_api')] });
        const el = rowFor(list, 'cloude_api');
        expect(el.getAttribute('role')).toBe('button');
        expect(el.getAttribute('tabindex')).toBe('0');
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        expect(list.host.calls.map((c) => c.method)).toContain('attachSession');
    });
});

describe('the inline rename editor', () => {
    test('the pencil opens an input SEEDED WITH WHAT THE ROW IS SHOWING', async () => {
        list = mountList({
            rows: [row('cloude_Media', { label: 'Media Compression' })],
        });
        (rowFor(list, 'cloude_Media')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_Media')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('Media Compression');
    });

    test('a row with no label seeds the STRIPPED HANDLE, not the raw name', async () => {
        list = mountList({ rows: [row('cloude_api', { label: null })] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        expect(input.value).toBe('api');
    });

    test('the box takes the LABEL length, not the tmux name length', async () => {
        list = mountList({ rows: [row('cloude_api')] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        expect(input.getAttribute('maxlength')).toBe('200');
    });

    test('DECISIVE: editing a labelled row stores the new LABEL', async () => {
        list = mountList({
            rows: [row('cloude_Media', { label: 'Media Compression', session_id: 'ses_9' })],
        });
        (rowFor(list, 'cloude_Media')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_Media')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.value = 'Media Compression v2';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        await settle();
        const call = list.host.calls.find((c) => c.method === 'renameSession');
        expect(call?.args).toEqual(['ses_9', 'Media Compression v2']);
    });

    test('DECISIVE: opening the editor and dismissing it UNCHANGED writes nothing', async () => {
        // This is what stops a session with NO label having its handle
        // promoted into a stored label nobody typed.
        list = mountList({ rows: [row('cloude_api', { label: null })] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        await settle();
        expect(list.host.calls.map((c) => c.method)).not.toContain('renameSession');
    });

    test('Escape writes nothing and puts the name back', async () => {
        list = mountList({ rows: [row('cloude_api', { label: 'Api' })] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.value = 'Something else';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle();
        expect(list.host.calls.map((c) => c.method)).not.toContain('renameSession');
        expect(rowFor(list, 'cloude_api')
            .querySelector('.running-session-name')?.textContent).toBe('Api');
    });

    test('a REFUSED label keeps the box open and says why, inline', async () => {
        list = mountList(
            { rows: [row('cloude_api', { session_id: 'ses_1' })] },
            { validateLabel: () => ({ ok: false, reason: 'no control characters' }) },
        );
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.value = 'badname';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        await settle();
        const el = rowFor(list, 'cloude_api');
        expect(el.querySelector('.running-session-rename-input')).not.toBeNull();
        expect(el.querySelector('.running-session-rename-error')?.textContent)
            .toBe('no control characters');
        expect(list.host.calls.map((c) => c.method)).not.toContain('renameSession');
    });

    test('THE LABEL RULE IS THE SHARED ONE, never a second regex here', async () => {
        list = mountList({ rows: [row('cloude_api', { session_id: 'ses_1' })] });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.value = 'Media Compression';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
        await settle();
        expect(list.host.calls.map((c) => c.method)).toContain('validateLabel');
    });

    test('A POLL TICK NO LONGER DELETES WHAT THE USER IS TYPING', async () => {
        // The whole reason client/js/session-list-busy-guard.js existed,
        // and the reason it could be deleted rather than consumed: the
        // legacy repaint destroyed the field, so the guard SKIPPED the
        // paint. Here a tick on another row lands and the editor stays.
        list = mountList({
            rows: [row('cloude_api'), row('cloude_web', { status: 'idle' })],
        });
        (rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename') as HTMLElement).click();
        await settle();
        const input = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        input.value = 'half typed';
        applyRunningFixture({
            rows: [row('cloude_api'), row('cloude_web', { status: 'working' })],
        });
        await settle();
        const after = rowFor(list, 'cloude_api')
            .querySelector('.running-session-rename-input') as HTMLInputElement;
        expect(after).toBe(input);
        expect(after.value).toBe('half typed');
        // ...AND the status change was shown, which the guard's skip
        // could not do.
        expect(rowFor(list, 'cloude_web')
            .querySelector('.status-dot')?.className)
            .toContain('status-dot--working');
    });

    test('the two refusal states draw a pencil that explains itself', () => {
        list = mountList({
            rows: [row('', { session_id: null, created_by_cloude: null })],
        });
        const disabled = list.container.querySelector(
            '.running-session-rename-unavailable',
        ) as HTMLElement;
        expect(disabled).not.toBeNull();
        expect(disabled.getAttribute('aria-disabled')).toBe('true');
        expect(disabled.getAttribute('title'))
            .toBe(RUNNING_SESSION_KEYS.renameUnknownOwner);
        expect(disabled.hasAttribute('data-rename-sid')).toBe(false);
    });
});

describe('the age label', () => {
    test('a row with an epoch prints an age, and one without prints none', () => {
        list = mountList({
            rows: [
                row('cloude_old', { created_at_epoch: 1_700_000_000 }),
                row('cloude_none', { created_at_epoch: null }),
            ],
        });
        expect(rowFor(list, 'cloude_old').querySelector('.running-session-age'))
            .not.toBeNull();
        expect(rowFor(list, 'cloude_none').querySelector('.running-session-age'))
            .toBeNull();
    });
});

describe('the durable row id badge', () => {
    test('a row with an id prints it, a row without prints nothing', () => {
        list = mountList({
            rows: [
                row('cloude_ours', { session_row_id: 7 }),
                row('cloude_theirs', { session_row_id: null }),
            ],
        });
        expect(rowFor(list, 'cloude_ours')
            .querySelector('.running-session-id')?.textContent).toBe('#7');
        expect(rowFor(list, 'cloude_theirs').querySelector('.running-session-id'))
            .toBeNull();
    });
});
