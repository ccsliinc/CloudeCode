/**
 * THE SEAM ITSELF: the browser host, driven against the REAL legacy
 * modules.
 *
 * @vitest-environment jsdom
 *
 * THIS FILE EXISTS BECAUSE A MUTATION CAME BACK GREEN. Dropping restart
 * from a live row inside `browserRunningHost.actionsFor` failed NOTHING:
 * ./RunningSessions.behaviour.test.ts drives a RECORDING host, so it
 * proves what the card does with the answer it is given, and
 * ./running-copy.parity.test.ts drives the legacy module directly, so it
 * proves what the answer should be. Neither one crosses the seam between
 * them, and the seam is where a pass-through can quietly stop passing
 * things through.
 *
 * SO THE REAL MODULES ARE HUNG ON THE REAL `window`. `hostWindow()` reads
 * `window`, which under jsdom is a real one, and the legacy files are
 * classic scripts evaluated in a `vm` sandbox and then published onto it -
 * the same arrangement `client/index.html` produces, and not a stub of
 * one. A stub here would agree with whatever it was built to agree with,
 * which is exactly how the gap above opened.
 *
 * WHAT IS NOT TESTED HERE is what the legacy modules THEMSELVES answer;
 * that is ./running-copy.parity.test.ts's job. This is only about the
 * host carrying the answer across unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { glyphSvg } from '../../../../client/js/icons/glyphs.js';
import { browserRunningHost } from './running-host';

/**
 * Repo root, one level up from `web/`, which is vitest's working directory.
 *
 * NOT DERIVED FROM `import.meta.url`, and that is not a style choice. This
 * file opts into the jsdom environment, where `import.meta.url` is an
 * `http:` URL rather than a `file:` one, so `fileURLToPath` throws at
 * module scope and the whole suite collects zero tests - a failure that
 * reads like a broken import and is really an environment difference.
 */
const repoRoot = path.join(process.cwd(), '..');

/** The globals this file hangs on `window` and must take back off it. */
const INSTALLED = [
    'SessionRowActions', 'SessionStatusUI', 'SessionThemeTint',
    'SessionTransport', 'SessionLabel', 'UIFlags', 'API', 'CloudeWeb',
] as const;

/**
 * Evaluate legacy classic scripts and publish what they export on window.
 *
 * Description: THE REAL FILES. `session-row-actions.js` reads
 *   `window.SessionStatusUI` for its glyphs, so that one is loaded too,
 *   and the glyph geometry is injected the way `client/js/i18n/boot.js`
 *   publishes it in a browser.
 * Inputs: files - paths under client/js.
 * Output: void. The modules land on the real `window`.
 * Example: installLegacy(['session-status-ui.js', 'session-row-actions.js'])
 */
function installLegacy(files: string[]): void {
    const context: Record<string, unknown> = { console };
    context.window = context;
    context.globalThis = context;
    context.CloudeGlyphs = { glyphSvg };
    context.document = document;
    vm.createContext(context);
    for (const file of files) {
        vm.runInContext(
            fs.readFileSync(path.join(repoRoot, 'client', 'js', file), 'utf8'),
            context,
        );
    }
    for (const key of Object.keys(context)) {
        if ((INSTALLED as readonly string[]).includes(key)) {
            (window as unknown as Record<string, unknown>)[key] = context[key];
        }
    }
}

beforeEach(() => {
    for (const key of INSTALLED) {
        delete (window as unknown as Record<string, unknown>)[key];
    }
});

afterEach(() => {
    for (const key of INSTALLED) {
        delete (window as unknown as Record<string, unknown>)[key];
    }
});

describe('actionsFor carries the shared rule across unchanged', () => {
    beforeEach(() => {
        installLegacy(['session-status-ui.js', 'session-row-actions.js']);
    });

    /** The real module, as the host sees it. */
    function legacy(): {
        ACTION_CLOSE: string; ACTION_REMOVE: string; ACTION_RESTART: string;
        LIVE_STATUSES: string[];
        actionsFor(status: string | null): string[];
    } {
        return (window as unknown as { SessionRowActions: never }).SessionRowActions;
    }

    test('EVERY measured-live status is offered restart, through the host', () => {
        // MUTATION 4's target, and the case that came back green without
        // this file. A filter, a truncation or a reordering inside the
        // host is invisible to a test that stubs the host and invisible to
        // a test that skips it.
        const host = browserRunningHost();
        const mod = legacy();
        expect(mod.LIVE_STATUSES.length).toBeGreaterThan(3);
        for (const status of mod.LIVE_STATUSES) {
            const ids = host.actionsFor(status).map((a) => a.id);
            expect(ids, `status ${status}`).toContain(mod.ACTION_RESTART);
            expect(ids, `status ${status}`).toContain(mod.ACTION_CLOSE);
            expect(ids, `status ${status}`).not.toContain(mod.ACTION_REMOVE);
        }
    });

    test('the host answers EXACTLY what the module answers, id for id and in order', () => {
        // The strongest form of the same claim: not "restart is in there"
        // but "this is a pass-through". Any drop, add or reorder fails.
        const host = browserRunningHost();
        const mod = legacy();
        for (const status of [...mod.LIVE_STATUSES, 'dead', 'unknown', null, '']) {
            expect(
                host.actionsFor(status).map((a) => a.id),
                `status ${String(status)}`,
            ).toEqual(mod.actionsFor(status));
        }
    });

    test('a DEAD row is restart then remove, and `unknown` is close alone', () => {
        const host = browserRunningHost();
        expect(host.actionsFor('dead').map((a) => a.id)).toEqual(['restart', 'remove']);
        expect(host.actionsFor('unknown').map((a) => a.id)).toEqual(['close']);
    });

    test('each descriptor names a glyph that really exists', () => {
        // An empty or misspelled name renders nothing and logs, which is a
        // control the user sees as a blank box.
        const host = browserRunningHost();
        for (const status of ['idle', 'dead', 'unknown']) {
            for (const action of host.actionsFor(status)) {
                expect(glyphSvg(action.glyph), `${status}/${action.id}`)
                    .toContain('<svg');
            }
        }
    });

    test('only restart carries the extra class, and it carries it every time', () => {
        const host = browserRunningHost();
        for (const status of ['idle', 'working', 'dead']) {
            for (const action of host.actionsFor(status)) {
                const expected = action.id === 'restart'
                    ? 'session-row-action-restart' : '';
                expect(action.extraClass, `${status}/${action.id}`).toBe(expected);
            }
        }
    });

    test('THE MODULE MISSING IS A REFUSAL, not an invented control', () => {
        // Refusing paints a row with no controls, which is honest.
        // Inventing a `close` here would be a second status list beside
        // the one that could not be read.
        delete (window as unknown as Record<string, unknown>).SessionRowActions;
        expect(browserRunningHost().actionsFor('idle')).toEqual([]);
    });
});

describe('the other pass-throughs carry their answers unchanged too', () => {
    test('requiresConfirm and actionLabel come from the shared module', () => {
        installLegacy(['session-status-ui.js', 'session-row-actions.js']);
        const host = browserRunningHost();
        const mod = (window as unknown as {
            SessionRowActions: {
                ACTION_CLOSE: string; ACTION_REMOVE: string; ACTION_RESTART: string;
                labelFor(a: string): string; requiresConfirm(a: string): boolean;
            };
        }).SessionRowActions;
        for (const action of [mod.ACTION_CLOSE, mod.ACTION_REMOVE, mod.ACTION_RESTART]) {
            expect(host.actionLabel(action)).toBe(mod.labelFor(action));
            expect(host.requiresConfirm(action)).toBe(mod.requiresConfirm(action));
        }
        // RESTART DESTROYS NOTHING, so it is the one that does not confirm.
        expect(host.requiresConfirm(mod.ACTION_RESTART)).toBe(false);
        expect(host.requiresConfirm(mod.ACTION_CLOSE)).toBe(true);
    });

    test('a missing confirm module answers NO, never yes', async () => {
        // FAIL CLOSED. A destructive action must never proceed because
        // its confirmation failed to load. AWAITED, not left as a
        // floating `.resolves` - an unawaited assertion passes whatever
        // the promise settles to, which is the quietest way for a test
        // about refusing to stop testing anything.
        await expect(browserRunningHost().confirmAction('close', 'api'))
            .resolves.toBe(false);
    });

    test('a missing picker is reported as absent, not as a decline', () => {
        expect(browserRunningHost().hasRestartPicker()).toBe(false);
    });

    test('the theme lookup is the SHARED one, and answers null when it cannot tell', () => {
        installLegacy(['session-theme-tint.js']);
        const host = browserRunningHost();
        // No theme registry is loaded, so the module can determine
        // nothing - which is the honest answer and an unthemed row.
        expect(host.themeColors('dracula')).toBeNull();
    });

    test('the label limit comes from the module that mirrors the server', () => {
        installLegacy(['session-label.js']);
        const mod = (window as unknown as {
            SessionLabel: { LABEL_MAX_CHARS: number };
        }).SessionLabel;
        expect(browserRunningHost().labelMaxChars()).toBe(mod.LABEL_MAX_CHARS);
        // ...and it is NOT the old tmux-name limit of 64, which silently
        // truncated any longer label with no error anywhere.
        expect(mod.LABEL_MAX_CHARS).toBeGreaterThan(64);
    });

    test('and a missing label module refuses every value rather than accepting one', () => {
        expect(browserRunningHost().validateLabel('anything').ok).toBe(false);
    });
});

describe('the plugin bridge', () => {
    test('NO BUNDLE IS A REFUSAL, and an EMPTY LIST is not the same thing', () => {
        // The caller guards the FUNCTION, not the result: an empty list is
        // exactly what `ui.show_mark_unread_control: false` looks like and
        // must stay silent, while an absent function is a bundle that
        // failed to load and must not.
        expect(browserRunningHost().cardActions('cloude_api', false)).toEqual([]);
    });

    test('the flags block defaults the control ON when nothing can answer', () => {
        // `ui-flags.js`'s own rule, carried through: a probe that could
        // not run must never be the reason a control disappears.
        const seen: Array<{ flags: Record<string, boolean> }> = [];
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            sessionCardMenuItems: (_row: unknown, ctx: { flags: Record<string, boolean> }) => {
                seen.push({ flags: ctx.flags });
                return [];
            },
        };
        browserRunningHost().cardActions('cloude_api', false);
        expect(seen[0]?.flags.show_mark_unread_control).toBe(true);
    });

    test('and it passes a FALSE flag through when one is measured', () => {
        const seen: Array<Record<string, boolean>> = [];
        (window as unknown as Record<string, unknown>).UIFlags = {
            showMarkUnreadControl: () => false,
        };
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            sessionCardMenuItems: (_row: unknown, ctx: { flags: Record<string, boolean> }) => {
                seen.push(ctx.flags);
                return [];
            },
        };
        browserRunningHost().cardActions('cloude_api', false);
        expect(seen[0]?.show_mark_unread_control).toBe(false);
    });

    test('the row it describes carries the NAME and the painted unread state', () => {
        const seen: Array<{ name: string; unread: boolean }> = [];
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            sessionCardMenuItems: (r: { name: string; unread: boolean }) => {
                seen.push(r);
                return [];
            },
        };
        browserRunningHost().cardActions('cloude_api', true);
        expect(seen[0]).toEqual({ name: 'cloude_api', unread: true });
    });
});
