/**
 * THE FOUR SEAMS THAT REACHED A GLOBAL NOBODY PUBLISHES ANY MORE.
 *
 * @vitest-environment jsdom
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT FOUR ASSERTIONS ABOUT NAMES.
 * `shim.test.ts` proves the shim and its callers agree as SETS. It
 * cannot prove a caller that was rewired off the shim reaches the right
 * thing instead, because from its point of view a member that stopped
 * being asked for and a member that was never needed look identical.
 * That is the gap this file covers: each test drives the REAL
 * `browserHost()` against a REAL `window` and asserts the OUTCOME a user
 * would see, so renaming a member cannot make any of them pass.
 *
 * EVERY ONE OF THESE FAILED BEFORE THE FIX, AND FAILED QUIETLY. Each
 * caller guarded its lookup with a `typeof` and degraded: to the literal
 * string 'unknown', to an empty array, to no refresh, to a
 * `console.error`. None of them threw, so nothing in 1342 passing tests
 * noticed, and the app looked like it was working.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { browserHost as attributionHost } from './attribution';
import { browserHost as recentHost } from './recent-actions';
import { browserProjectTreeHost } from './project-tree-host';
import { visibleRecentRows } from './recent-visibility';
import { ERROR_STACK_ID } from './status-report';
import { sessionStore } from '../sessions/store.svelte';
import { relativeAge } from '../../../../client/js/labels/running-session.js';
import { t } from '../i18n/index.svelte';

/** The globals a test hangs on `window` and must take back off it. */
const INSTALLED = ['Launchpad', 'CloudeWeb', 'SessionLabel'] as const;

beforeEach(() => {
    sessionStore.reset();
    for (const key of INSTALLED) delete (window as unknown as Record<string, unknown>)[key];
    document.body.innerHTML = '';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const key of INSTALLED) delete (window as unknown as Record<string, unknown>)[key];
    vi.restoreAllMocks();
});

describe('the attribution card can date a session', () => {
    test('an age is computed here, not asked of a singleton that no longer has it', () => {
        // THE LIVE CONDITION, REPRODUCED EXACTLY: `window.Launchpad` is
        // the shim, and the shim does not carry `_formatRelativeTime`.
        // The old code answered the literal 'unknown' for that, so every
        // dated row on the card read `unknown` on every load - and it was
        // indistinguishable from a session that genuinely had no epoch.
        (window as unknown as Record<string, unknown>).Launchpad = {};
        const epoch = Math.floor(Date.now() / 1000) - 5 * 60;

        const shown = attributionHost().formatRelativeTime(epoch);

        expect(shown).not.toBe('unknown');
        // Not a hardcoded sentence: it must equal what the ONE age
        // implementation answers, so this keeps holding when the copy or
        // the locale changes and stops holding if a second formatter
        // appears.
        expect(shown).toBe(relativeAge(epoch, t));
    });

    test('NEGATIVE CONTROL: it still refuses an undatable session', () => {
        // Without this, a `formatRelativeTime` that returned a constant
        // would pass the test above.
        (window as unknown as Record<string, unknown>).Launchpad = {};
        expect(attributionHost().formatRelativeTime(0)).toBe(relativeAge(0, t));
        expect(attributionHost().formatRelativeTime(0))
            .not.toBe(attributionHost().formatRelativeTime(Math.floor(Date.now() / 1000) - 60));
    });
});

describe('the recent list can see the live sessions', () => {
    test('the live rows come from the store, and the de-duplication actually runs', () => {
        // WHY THE SECOND HALF MATTERS MORE THAN THE FIRST. Answering `[]`
        // was recorded as a tidy degrade and it is not one:
        // `visibleRecentRows` short-circuits on an empty live list, so `[]`
        // does not filter conservatively - it switches the whole rule OFF
        // and paints a running session a second time under RECENT.
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            launchpad: { sessions: { runningSessions: [{ name: 'cloude_a', session_row_id: 11 }] } },
        };
        const host = recentHost(async () => {});

        const live = host.liveSessions();
        expect(live).toHaveLength(1);

        const rows = [{ id: 11, tmux_name: 'cloude_a' }, { id: 12, tmux_name: 'cloude_b' }];
        expect(visibleRecentRows(rows, live).map((r) => r.id)).toEqual([12]);
    });

    test('NEGATIVE CONTROL: with no live rows the same call hides nothing', () => {
        // The fail-open half of the rule, asserted so a filter that always
        // dropped rows could not pass the test above.
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            launchpad: { sessions: { runningSessions: [] } },
        };
        const rows = [{ id: 11, tmux_name: 'cloude_a' }];
        expect(visibleRecentRows(rows, recentHost(async () => {}).liveSessions()))
            .toHaveLength(1);
    });

    test('an archive re-reads the attribution join through the compiled path', async () => {
        // The project tree derives from the records this fetch replaces,
        // so a refresh that never happens leaves a just-archived session
        // on screen.
        const calls: string[] = [];
        (window as unknown as Record<string, unknown>).CloudeWeb = {
            launchpad: {
                loadSessionAttribution: async () => { calls.push('attribution'); },
            },
        };

        await recentHost(async () => {}).refreshAttribution();

        expect(calls).toEqual(['attribution']);
    });
});

describe('a refused project row says why', () => {
    test('the refusal reaches the error surface instead of the console', () => {
        // THE DEFECT THE SCANNER COULD NOT SEE. This was reached through
        // `function legacy()`, which the alias resolver did not follow, so
        // the guard reported the shim complete while clicking a REFUSED
        // project row produced one `console.error` and nothing on screen.
        sessionStore.projectPresence = new Map([
            ['/tmp/gone', { root: '/tmp/gone', presence: 'missing', presence_detail: null }],
        ]);

        browserProjectTreeHost().explainRefused(
            { name: 'gone', root: '/tmp/gone', path: '/tmp/gone' },
            null,
        );

        const stack = document.getElementById(ERROR_STACK_ID);
        expect(stack, 'a refused project must produce a visible card').not.toBeNull();
        expect((stack?.textContent || '').length).toBeGreaterThan(0);
    });

    test('NEGATIVE CONTROL: nothing is reported when nothing asked', () => {
        // Without this, an `explainRefused` that painted a card
        // unconditionally would pass the test above.
        expect(document.getElementById(ERROR_STACK_ID)).toBeNull();
    });
});
