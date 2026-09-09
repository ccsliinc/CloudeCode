/**
 * Stage C attribution prompt: the render ladder and the two answers.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Vitest runs in a Node environment here
 * (see web/vitest.config.ts) and neither `jsdom` nor
 * `@testing-library/svelte` is a dependency of this project, so nothing
 * below mounts the component. That is why the whole decision ladder was
 * carved into `viewFor()` and the two answers into `adoptAttributed()`
 * and `declineAttributed()`: everything that can be decided without a
 * DOM is decided here and asserted here. The markup itself is proven in
 * a real browser under the production CSP.
 *
 * THE NEGATIVE CONTROLS ARE LOAD BEARING. A card that always renders
 * something is worse than useless, and so is a decline that always
 * reports success. The 'unavailable' case and the refusal cases are
 * asserted alongside the happy ones, and the recorder host proves what
 * was POSTED rather than what the function returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    adoptAttributed,
    declineAttributed,
    describeRow,
    close,
    isClosed,
    loadPrompt,
    resetClosedForTests,
    UNAVAILABLE_FALLBACK_NOTICE,
    viewFor,
    type AttributionDeclineResponse,
    type AttributionHost,
    type SessionAttributionPrompt,
    type UnattributedSession,
} from './attribution';

/** What a recorder host wrote down while the code under test ran. */
interface Recorded {
    adopted: string[];
    declined: string[][];
    errors: string[];
    refreshes: number;
}

/**
 * A host that records every call instead of reaching a server.
 *
 * Inputs: overrides (object) - per-method replacements, all optional.
 * Output: [AttributionHost, Recorded] - the host and its log.
 * Example: const [host, log] = recorderHost(); await adoptAttributed(['a'], host);
 */
function recorderHost(overrides: Partial<AttributionHost> = {}): [AttributionHost, Recorded] {
    const log: Recorded = { adopted: [], declined: [], errors: [], refreshes: 0 };
    const host: AttributionHost = {
        fetchPrompt: async () => ({ state: 'none', sessions: [] }),
        adoptSession: async (name) => {
            log.adopted.push(name);
        },
        declineAttribution: async (names): Promise<AttributionDeclineResponse> => {
            log.declined.push([...names]);
            return { declined: [...names], not_eligible: [], unknown: [] };
        },
        showError: (message) => {
            log.errors.push(message);
        },
        refreshRunningSessions: () => {
            log.refreshes += 1;
        },
        formatRelativeTime: (epoch) => `epoch:${epoch}`,
        resolveLabel: (session) => session.label ?? null,
        ...overrides,
    };
    return [host, log];
}

/** Three unattributed sessions, mixed reasons, one with a label. */
function pendingBody(): SessionAttributionPrompt {
    const sessions: UnattributedSession[] = [
        {
            tmux_name: 'cloude_ses_deadbeef',
            epoch: 1755000000,
            hints: ['its name matches the auto-generated form Cloude Code uses'],
            reason: 'no_admissible_evidence',
        },
        {
            tmux_name: 'cloude_labelled',
            epoch: 1755000100,
            label: '<b>not html</b>',
            hints: [],
            reason: 'no_admissible_evidence',
        },
        {
            tmux_name: 'cloude_broken_check',
            epoch: null,
            hints: [],
            reason: 'could_not_evaluate',
        },
    ];
    return { state: 'pending', sessions, notice: '3 sessions we could not attribute.' };
}

beforeEach(() => {
    resetClosedForTests();
    vi.restoreAllMocks();
});

describe('viewFor: the render ladder', () => {
    it('renders nothing when the fetch failed', () => {
        const [host] = recorderHost();
        expect(viewFor(null, host, false)).toEqual({ kind: 'nothing' });
    });

    it("renders nothing for state 'none'", () => {
        const [host] = recorderHost();
        expect(viewFor({ state: 'none', sessions: [] }, host, false)).toEqual({
            kind: 'nothing',
        });
    });

    it("renders the notice for state 'unavailable', not an empty list", () => {
        const [host] = recorderHost();
        const view = viewFor(
            { state: 'unavailable', sessions: [], notice: 'the datastore could not be read.' },
            host,
            false,
        );
        expect(view).toEqual({
            kind: 'unavailable',
            notice: 'the datastore could not be read.',
        });
    });

    it("falls back to CANNOT BE DETERMINED when 'unavailable' carries no notice", () => {
        const [host] = recorderHost();
        const view = viewFor({ state: 'unavailable', sessions: [] }, host, false);
        expect(view).toEqual({ kind: 'unavailable', notice: UNAVAILABLE_FALLBACK_NOTICE });
    });

    it("renders nothing for 'pending' with an empty or absent session list", () => {
        const [host] = recorderHost();
        expect(viewFor({ state: 'pending', sessions: [] }, host, false).kind).toBe('nothing');
        expect(viewFor({ state: 'pending' }, host, false).kind).toBe('nothing');
    });

    it('renders one row per session, with the reason as a sentence', () => {
        const [host] = recorderHost();
        const view = viewFor(pendingBody(), host, false);
        if (view.kind !== 'pending') throw new Error('expected a pending card');
        expect(view.notice).toBe('3 sessions we could not attribute.');
        expect(view.rows.map((r) => r.tmuxName)).toEqual([
            'cloude_ses_deadbeef',
            'cloude_labelled',
            'cloude_broken_check',
        ]);
        expect(view.rows[0]?.why).toBe('we found no record either way');
        expect(view.rows[2]?.why).toBe('we could not complete the check for this one');
        expect(view.rows[2]?.reason).toBe('could_not_evaluate');
    });

    it('shows the label when there is one and the raw handle when there is not', () => {
        const [host] = recorderHost();
        const view = viewFor(pendingBody(), host, false);
        if (view.kind !== 'pending') throw new Error('expected a pending card');
        expect(view.rows[0]?.shown).toBe('cloude_ses_deadbeef');
        expect(view.rows[1]?.shown).toBe('<b>not html</b>');
        // The key the actions post under is never the label.
        expect(view.rows[1]?.tmuxName).toBe('cloude_labelled');
    });

    it('says the start time is unknown for a null or zero epoch', () => {
        const [host] = recorderHost();
        expect(describeRow({ tmux_name: 'a', epoch: null }, host).started).toBe(
            'start time unknown',
        );
        expect(describeRow({ tmux_name: 'a', epoch: 0 }, host).started).toBe(
            'start time unknown',
        );
        expect(describeRow({ tmux_name: 'a', epoch: 12 }, host).started).toBe('epoch:12');
    });

    it('defaults a missing hint list to empty rather than throwing', () => {
        const [host] = recorderHost();
        expect(describeRow({ tmux_name: 'a' }, host).hints).toEqual([]);
    });
});

describe('the close flag', () => {
    it('renders nothing once closed, for a prompt that would otherwise paint', () => {
        const [host] = recorderHost();
        expect(viewFor(pendingBody(), host, false).kind).toBe('pending');
        expect(viewFor(pendingBody(), host, true).kind).toBe('nothing');
    });

    it('does not persist: it is module state and nothing writes it anywhere', () => {
        expect(isClosed()).toBe(false);
        close();
        expect(isClosed()).toBe(true);
        // Nothing else records it. The card's own footnote promises that
        // closing without answering brings it back next time, so the only
        // correct lifetime is this page - which is this module's.
        resetClosedForTests();
        expect(isClosed()).toBe(false);
    });
});

describe('loadPrompt', () => {
    it('answers null on a failed fetch, which renders as nothing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const [host] = recorderHost({
            fetchPrompt: async () => {
                throw new Error('network down');
            },
        });
        expect(await loadPrompt(host)).toBeNull();
        expect(viewFor(await loadPrompt(host), host, false).kind).toBe('nothing');
    });

    it('hands the body straight back on success', async () => {
        const body = pendingBody();
        const [host] = recorderHost({ fetchPrompt: async () => body });
        expect(await loadPrompt(host)).toBe(body);
    });
});

describe('adoptAttributed', () => {
    it('posts each name to the adopt endpoint, one at a time, in order', async () => {
        const [host, log] = recorderHost();
        const failed = await adoptAttributed(['cloude_a', 'cloude_b'], host);
        expect(log.adopted).toEqual(['cloude_a', 'cloude_b']);
        expect(failed).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    it('posts nothing at all for an empty selection', async () => {
        const [host, log] = recorderHost();
        expect(await adoptAttributed([], host)).toEqual([]);
        expect(log.adopted).toEqual([]);
    });

    it('keeps going after a failure and names the ones that failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const [host, log] = recorderHost({
            adoptSession: async (name) => {
                log.adopted.push(name);
                if (name === 'cloude_b') throw new Error('409');
            },
        });
        const failed = await adoptAttributed(['cloude_a', 'cloude_b', 'cloude_c'], host);
        expect(log.adopted).toEqual(['cloude_a', 'cloude_b', 'cloude_c']);
        expect(failed).toEqual(['cloude_b']);
        expect(log.errors).toEqual(['could not adopt: cloude_b']);
    });

    it('refreshes nothing itself: the caller owns the order', async () => {
        const [host, log] = recorderHost();
        await adoptAttributed(['cloude_a'], host);
        expect(log.refreshes).toBe(0);
    });
});

describe('declineAttributed', () => {
    it('posts the whole batch in one call to the decline endpoint', async () => {
        const [host, log] = recorderHost();
        const stuck = await declineAttributed(['cloude_a', 'cloude_b'], host);
        expect(log.declined).toEqual([['cloude_a', 'cloude_b']]);
        expect(stuck).toEqual([]);
        expect(log.errors).toEqual([]);
    });

    it('posts nothing at all for an empty selection', async () => {
        const [host, log] = recorderHost();
        expect(await declineAttributed([], host)).toEqual([]);
        expect(log.declined).toEqual([]);
    });

    it('reports the names the server refused, from BOTH refusal lists', async () => {
        const [host, log] = recorderHost({
            declineAttribution: async () => ({
                declined: ['cloude_a'],
                not_eligible: ['cloude_b'],
                unknown: ['cloude_c'],
            }),
        });
        const stuck = await declineAttributed(['cloude_a', 'cloude_b', 'cloude_c'], host);
        expect(stuck).toEqual(['cloude_b', 'cloude_c']);
        expect(log.errors).toEqual(['not recorded for: cloude_b, cloude_c']);
    });

    it('says the answer was NOT recorded when the call throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const [host, log] = recorderHost({
            declineAttribution: async () => {
                throw new Error('500');
            },
        });
        const stuck = await declineAttributed(['cloude_a'], host);
        expect(stuck).toEqual(['cloude_a']);
        expect(log.errors).toEqual(['that answer was NOT recorded: 500']);
    });

    it('never refreshes the running sessions: declining moves nothing', async () => {
        const [host, log] = recorderHost();
        await declineAttributed(['cloude_a'], host);
        expect(log.refreshes).toBe(0);
    });
});
