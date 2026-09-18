/**
 * WHAT THE CONVERSATION VIEW DOES, asserted against the mounted
 * component and the real modules.
 *
 * @vitest-environment jsdom
 *
 * EVERY POSITIVE CLAIM HERE HAS A NEGATIVE BESIDE IT. A view that paints
 * something regardless of input passes every positive assertion ever
 * written, which is the failure mode this whole screen exists to avoid:
 * an empty chat pane asserting that a 30,805-line transcript contains no
 * messages is a verdict nobody measured.
 *
 * The masking property has its own two suites (`chat-mask.test.ts` and
 * `chat-mask-consumption.test.ts`) and is deliberately not restated here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatView from './ChatView.svelte';
import { ACTIONS, CLASS, MOD } from './chat-vocab';
import {
    block, fakeChatClient, outcome, syncRaf, turn, turnsPage, unroutedResponse,
} from './chat-harness';
import type { ArchiveClient } from './client';

let mounted: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    if (mounted) { unmount(mounted); mounted = null; }
    if (host) { host.remove(); host = null; }
});

/** What the mounted view exposes to a caller. */
interface ViewApi {
    open(): Promise<string>;
    requestMoreTurns(): Promise<unknown>;
    chatNow(): { items: readonly unknown[]; complete: boolean | null; token: string };
    laidOut(): readonly unknown[];
    geometry(): { count(): number };
    chain(): { depth(): number; levels(): { transcriptId: unknown }[] };
}

/** Mount the view against a double. */
function mountView(client: ArchiveClient, props: Record<string, unknown> = {}): ViewApi {
    host = document.createElement('div');
    document.body.appendChild(host);
    mounted = mount(ChatView, {
        target: host,
        props: { client, outcome, transcriptId: 4, raf: syncRaf, ...props } as never,
    }) as Record<string, unknown>;
    return mounted as unknown as ViewApi;
}

/** Every bubble currently in the DOM. */
function bubbles(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`article.${CLASS.turn}`)];
}

/** Run the view's chain to completion. */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
        flushSync();
        await Promise.resolve();
    }
    flushSync();
}

describe('ChatView: it makes a request, and says so when it cannot', () => {
    it('MAKES NO REQUEST UNTIL `open()` IS CALLED, which is the contract '
        + 'and the defect a harness caught by looking at the page', async () => {
        const { client, asked } = fakeChatClient({ page: turnsPage([turn()], false) });
        mountView(client);
        await settle();
        expect(asked.messages).toHaveLength(0);
    });

    it('paints one bubble per turn, with the speaker spelled out', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([
                turn({ line_no: 1, role: 'user' }),
                turn({ line_no: 2, role: 'assistant' }),
            ], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        expect(bubbles()).toHaveLength(2);
        const text = document.body.textContent || '';
        // ROLE AS TEXT, not only as a colour: three themes zero every
        // radius token and a greyscale screenshot is real.
        expect(text).toContain('You');
        expect(text).toContain('Claude');
        expect(bubbles()[0]?.getAttribute('data-role')).toBe('user');
    });

    it('AN UNROUTED ENDPOINT IS A NAMED THIRD OUTCOME, not an empty '
        + 'conversation', async () => {
        const { client } = fakeChatClient({ page: unroutedResponse() });
        const api = mountView(client);
        const token = await api.open();
        await settle();

        expect(token).toBe('cannot_determine');
        expect(bubbles()).toHaveLength(0);
        // AND IT SAYS SO IN WORDS. A blank pane would assert the
        // transcript is empty.
        const said = document.querySelector(`.${CLASS.status}`)?.textContent || '';
        expect(said.trim().length).toBeGreaterThan(20);
        expect(said).toContain('could not be built');
    });

    it('A 404 CARRYING A COMPLETE ENVELOPE IS A DIFFERENT FINDING from an '
        + 'unrouted path, and is classified rather than synthesised', async () => {
        const { client } = fakeChatClient({
            page: {
                envelope: { result: null, result_status: 'not_found', meta: {} },
                httpStatus: 404, headers: null, transportError: null,
            } as never,
        });
        const api = mountView(client);
        expect(await api.open()).toBe('not_found');
    });
});

describe('ChatView: the blocks of a turn', () => {
    it('AN EMPTY BLOCKS ARRAY AND A MISSING ONE ARE TWO SENTENCES', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([
                turn({ line_no: 1, blocks: [], blocks_state: 'no_message_content' }),
                turn({ line_no: 2, blocks: undefined, blocks_state: undefined }),
            ], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        const bodies = [...document.querySelectorAll(`.${CLASS.turnBody}`)];
        expect(bodies[0]?.getAttribute('data-blocks')).toBe('0');
        expect(bodies[0]?.textContent).toContain('this turn carries none');
        expect(bodies[1]?.getAttribute('data-blocks')).toBe('cannot-determine');
        expect(bodies[1]?.textContent).toContain('NOT KNOWN');
    });

    it('A `blocks_state` THIS VIEW CANNOT INTERPRET fails toward the third '
        + 'outcome, not toward "no content"', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([
                turn({ blocks: [], blocks_state: 'a_word_invented_later' }),
            ], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        const body = document.querySelector(`.${CLASS.turnBody}`);
        expect(body?.getAttribute('data-blocks')).toBe('cannot-determine');
    });

    it('PROSE IS OPEN AND THE ENVELOPE IS CLOSED: a tool result renders '
        + 'behind a disclosure, plain text does not', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({
                blocks: [
                    block({ seq: 0, type: 'text', text: 'the prose' }),
                    block({ seq: 1, type: 'tool_result', text: 'the payload',
                        tool_name: 'Bash', is_error: true }),
                ],
            })], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        const blocks = [...document.querySelectorAll(`.${CLASS.block}`)];
        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.querySelector('details')).toBeNull();
        expect(blocks[1]?.querySelector(`.${CLASS.disclosure}`)).not.toBeNull();
        // ERROR IS NAMED IN TEXT, not only coloured.
        expect(blocks[1]?.textContent).toContain('ERROR');
        expect(blocks[1]?.textContent).toContain('Bash');
    });

    it('BLOCKS ARE PAINTED IN `seq` ORDER even when the server sends them '
        + 'out of it', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({
                blocks: [
                    block({ seq: 2, text: 'third' }),
                    block({ seq: 0, text: 'first' }),
                    block({ seq: 1, text: 'second' }),
                ],
            })], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        const seqs = [...document.querySelectorAll(`.${CLASS.block}`)]
            .map((el) => el.getAttribute('data-block-seq'));
        expect(seqs).toEqual(['0', '1', '2']);
    });
});

describe('ChatView: the two on-demand panels', () => {
    it('THE ENVELOPE IS BEHIND THE "i" and every field is rendered, absent '
        + 'ones included', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({ info: { usage: { state: 'not_recorded' } } })], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        expect(document.querySelector(`.${CLASS.info}`)).toBeNull();
        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.INFO}"]`,
        )?.click();
        await settle();

        const panel = document.querySelector(`.${CLASS.info}`);
        expect(panel).not.toBeNull();
        // A GAP IS RENDERED AS A GAP, never as a missing row.
        const unknown = panel?.querySelectorAll('[data-known="false"]') || [];
        expect(unknown.length).toBeGreaterThan(0);
        expect(panel?.textContent).toContain('NOT KNOWN');
        // And the fact that WAS supplied is not marked as a gap.
        const usage = panel?.querySelector('[data-field="usage recorded"]');
        expect(usage?.getAttribute('data-known')).toBe('true');
    });

    it('A TURN THAT SPAWNED NOTHING CARRIES NO EXPANDER; one whose lookup '
        + 'FAILED carries one that says so', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([
                turn({ line_no: 1, subagents: [], subagents_state: 'none_spawned' }),
                turn({ line_no: 2, subagents: [], subagents_state: 'cannot_determine' }),
            ], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        const toggles = [...document.querySelectorAll(
            `[data-action="${ACTIONS.SUBAGENTS}"]`,
        )];
        expect(toggles).toHaveLength(1);
        expect(toggles[0]?.textContent).toContain('NOT KNOWN');
    });

    it('AN UNRESOLVED SUBAGENT IS LISTED, DISABLED AND COUNTED OUT LOUD, '
        + 'never dropped', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({
                subagents_state: 'partial',
                subagents: [
                    { order: 1, order_basis: 'start_ts', link_state: 'resolved',
                        start_ts: '2026-01-01T00:00:00Z', agent_ids: ['a1'],
                        transcripts: [{ transcript_id: 91, session_ref: 'agent-a1',
                            line_count: 12, start_ts: '2026-01-01T00:00:00Z' }] },
                    { order: 2, order_basis: 'start_ts',
                        link_state: 'tool_result_carries_no_agent_id',
                        agent_ids: [], transcripts: [],
                        spawned_by: { tool_name: 'Agent', line_no: 7 } },
                ],
            })], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.SUBAGENTS}"]`,
        )?.click();
        await settle();

        const opens = [...document.querySelectorAll<HTMLButtonElement>(
            `[data-action="${ACTIONS.OPEN_SUBAGENT}"]`,
        )];
        expect(opens).toHaveLength(2);
        expect(opens[0]?.getAttribute('data-openable')).toBe('true');
        expect(opens[1]?.getAttribute('data-openable')).toBe('false');
        expect(opens[1]?.disabled).toBe(true);
        expect(document.querySelector(`.${CLASS.subUnlinked}`)?.textContent)
            .toContain('1 of these 2 run(s)');
        // THE BASIS IS NAMED, so an ordinal is not mistaken for a clock
        // it was not measured with.
        expect(document.querySelector(`.${CLASS.subBasis}`)?.textContent)
            .toContain('START TIME');
    });
});

describe('ChatView: drilling into a subagent', () => {
    it('PUSHES A LEVEL, RE-FETCHES, and every level above stays one click '
        + 'away', async () => {
        const parent = turnsPage([turn({
            subagents_state: 'resolved',
            subagents: [{ order: 1, order_basis: 'start_ts', link_state: 'resolved',
                start_ts: '2026-01-01T00:00:00Z', agent_ids: ['a1'],
                transcripts: [{ transcript_id: 91, session_ref: 'agent-a1',
                    line_count: 12 }] }],
        })], false);
        const child = turnsPage([turn({ line_no: 5, role: 'user' })], false);
        const { client, asked } = fakeChatClient({ byId: { 4: parent, 91: child } });

        const api = mountView(client);
        await api.open();
        await settle();
        expect(api.chain().depth()).toBe(1);

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.SUBAGENTS}"]`,
        )?.click();
        await settle();
        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.OPEN_SUBAGENT}"]`,
        )?.click();
        await settle();

        expect(api.chain().depth()).toBe(2);
        // DRILLING RE-FETCHES; it does not render a cached snapshot.
        expect(asked.messages.map((m) => String(m.id))).toEqual(['4', '91']);
        // The root is now a control, and the current level is not.
        const ups = [...document.querySelectorAll(`[data-action="${ACTIONS.CHAIN_UP}"]`)];
        expect(ups).toHaveLength(1);
        expect(document.querySelectorAll(`.${CLASS.chainHere}`)).toHaveLength(1);

        (ups[0] as HTMLButtonElement).click();
        await settle();
        expect(api.chain().depth()).toBe(1);
        expect(asked.messages.map((m) => String(m.id))).toEqual(['4', '91', '4']);
    });

    it('A DISABLED CONTROL CANNOT DRILL even when clicked directly', async () => {
        const { client, asked } = fakeChatClient({
            page: turnsPage([turn({
                subagents_state: 'cannot_determine',
                subagents: [{ order: 1, link_state: 'no_tool_result_in_archive',
                    transcripts: [], agent_ids: [] }],
            })], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();
        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.SUBAGENTS}"]`,
        )?.click();
        await settle();

        const btn = document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.OPEN_SUBAGENT}"]`,
        );
        btn?.click();
        await settle();
        expect(api.chain().depth()).toBe(1);
        expect(asked.messages).toHaveLength(1);
    });
});

describe('ChatView: completeness and the pager', () => {
    it('`has_more` NULL IS NOT `false`: the sentinel says it was not told',
        async () => {
            const { client } = fakeChatClient({ page: turnsPage([turn()], null) });
            const api = mountView(client);
            await api.open();
            await settle();

            expect(api.chatNow().complete).toBeNull();
            const s = document.querySelector(`.${CLASS.sentinel}`);
            expect(s).not.toBeNull();
            expect(s?.getAttribute('data-complete')).toBe('null');
            expect(s?.textContent).toContain('NOT KNOWN');
        });

    it('A COMPLETE CONVERSATION PAINTS NO SENTINEL AT ALL', async () => {
        const { client } = fakeChatClient({ page: turnsPage([turn()], false) });
        const api = mountView(client);
        await api.open();
        await settle();
        expect(api.chatNow().complete).toBe(true);
        expect(document.querySelector(`.${CLASS.sentinel}`)).toBeNull();
    });

    it('NO BUTTON WITHOUT A HANDLER: `has_more` true with no cursor states '
        + 'the dead end rather than offering a control', async () => {
        const { client } = fakeChatClient({ page: turnsPage([turn()], true, null) });
        const api = mountView(client);
        await api.open();
        await settle();

        expect(document.querySelector(`[data-action="${ACTIONS.LOAD_MORE}"]`)).toBeNull();
        expect(document.querySelector(`.${CLASS.sentinelNoPager}`)?.textContent)
            .toContain('no cursor');
    });

    it('APPENDS a further page and keeps what was already loaded', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({ line_no: 1 })], true, 'c1'),
            morePages: [turnsPage([turn({ line_no: 2 })], false)],
        });
        const api = mountView(client);
        await api.open();
        await settle();
        expect(api.laidOut()).toHaveLength(1);

        document.querySelector<HTMLButtonElement>(
            `[data-action="${ACTIONS.LOAD_MORE}"]`,
        )?.click();
        await settle();

        expect(api.laidOut()).toHaveLength(2);
        expect(api.chatNow().complete).toBe(true);
    });

    it('A FAILED PAGE DOES NOT WIPE THE CONVERSATION and flips '
        + 'completeness back to NOT KNOWN', async () => {
        const { client } = fakeChatClient({
            page: turnsPage([turn({ line_no: 1 })], true, 'c1'),
            morePages: [unroutedResponse()],
        });
        const api = mountView(client);
        await api.open();
        await settle();
        await api.requestMoreTurns();
        await settle();

        expect(api.laidOut()).toHaveLength(1);
        expect(api.chatNow().complete).toBeNull();
    });
});

describe('ChatView: progress records', () => {
    it('FOLDS A RUN OF CONSECUTIVE PROGRESS TURNS into one chip, and a '
        + 'lone one is left as an ordinary row', async () => {
        const p = (n: number) => turn({
            line_no: n, record_type: 'progress', role: null, blocks: [],
            blocks_state: 'no_message_content',
        });
        const { client } = fakeChatClient({
            page: turnsPage([
                p(1), p(2), p(3),
                turn({ line_no: 4, role: 'user' }),
                p(5),
            ], false),
        });
        const api = mountView(client);
        await api.open();
        await settle();

        // Three folded into one, then the turn, then the lone progress row.
        expect(api.laidOut()).toHaveLength(3);
        const chip = document.querySelector(`.${CLASS.progressChip}`);
        expect(chip?.textContent).toContain('3 progress records');
        expect(chip?.textContent).toContain('lines 1 to 3');
        expect(document.querySelectorAll(`.${MOD.turnProgress}`)).toHaveLength(1);
    });

    it('THE CHIP TOGGLES, and the toggle is the action the vocabulary '
        + 'declares', async () => {
        const p = (n: number) => turn({
            line_no: n, record_type: 'progress', role: null, blocks: [],
            blocks_state: 'no_message_content',
        });
        const { client } = fakeChatClient({ page: turnsPage([p(1), p(2)], false) });
        const api = mountView(client);
        await api.open();
        await settle();

        const chip = document.querySelector<HTMLButtonElement>(`.${CLASS.progressChip}`);
        expect(chip?.getAttribute('data-action')).toBe(ACTIONS.EXPAND_PROGRESS);
        chip?.click();
        await settle();
        expect(document.querySelector(`.${CLASS.progressChip}`)
            ?.getAttribute('data-action')).toBe(ACTIONS.COLLAPSE_PROGRESS);
    });

    it('A RUN SPANNING A PAGE BOUNDARY folds into ONE chip, not two '
        + 'adjacent ones', async () => {
        const p = (n: number) => turn({
            line_no: n, record_type: 'progress', role: null, blocks: [],
            blocks_state: 'no_message_content',
        });
        const { client } = fakeChatClient({
            page: turnsPage([p(1), p(2)], true, 'c1'),
            morePages: [turnsPage([p(3), p(4)], false)],
        });
        const api = mountView(client);
        await api.open();
        await settle();
        await api.requestMoreTurns();
        await settle();

        expect(api.laidOut()).toHaveLength(1);
        expect(document.querySelector(`.${CLASS.progressChip}`)?.textContent)
            .toContain('4 progress records');
    });
});

describe('the window is bounded on a real mount', () => {
    it('paints far fewer bubbles than the conversation holds, counted at '
        + '500 and at 5,000, and the two counts agree', async () => {
        /** `n` turns, all small. */
        const many = (n: number) => Array.from({ length: n },
            (_, i) => turn({ line_no: i + 1, body_id: i + 1 }));

        const a = fakeChatClient({ page: turnsPage(many(500), false) });
        const apiA = mountView(a.client);
        await apiA.open();
        flushSync();
        const paintedA = bubbles().length;

        unmount(mounted as Record<string, unknown>);
        mounted = null;
        host?.remove();

        const b = fakeChatClient({ page: turnsPage(many(5000), false) });
        const apiB = mountView(b.client);
        await apiB.open();
        flushSync();
        const paintedB = bubbles().length;

        // THE BOUND: the same number at 500 and at 5,000.
        expect(paintedB).toBe(paintedA);
        // And it really is a bound, not "all of them".
        expect(paintedB).toBeLessThan(100);
        // The geometry knows about every one of them; only the DOM does not.
        expect(apiB.geometry().count()).toBe(5000);
        expect(apiB.laidOut()).toHaveLength(5000);
    });

    it('AND MASKS ONLY WHAT IT PAINTS: a 5,000-turn conversation produces '
        + 'a bounded number of rendered blocks, not 5,000', async () => {
        // This is the second half of the same claim and it is the half
        // that costs real work: `blockText` runs the masker over every
        // block of every turn it shapes, so shaping rows nobody can see
        // would be thousands of pointless mask passes on every paint.
        const many = Array.from({ length: 5000 },
            (_, i) => turn({ line_no: i + 1, body_id: i + 1 }));
        const { client } = fakeChatClient({ page: turnsPage(many, false) });
        const api = mountView(client);
        await api.open();
        await settle();

        const painted = document.querySelectorAll(`.${CLASS.block}`).length;
        expect(painted).toBeGreaterThan(0);
        expect(painted).toBeLessThan(100);
        expect(api.laidOut()).toHaveLength(5000);
    });
});
